//! HTTP endpoints (PROTOCOL section 4). Every POST carries proof-of-work and is answered with
//! `Connection: close`, so no two writes share a connection. Nothing here sees or logs a client
//! address: there is no `ConnectInfo`, no access log, no request tracing.

// Handlers return a ready `Response` as their error; its size is irrelevant here.
#![allow(clippy::result_large_err)]

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use blindbook_ledger::H32;
use blindbook_ledger::canonical::sha256;
use blindbook_ledger::ledger::{FillRecord, OutputList, Reject, Side, TradeRequest};
use blindbook_ledger::ops::{Applied, CreditClaim, Op};
use blindbook_ledger::wire::{BlindSignature, BlindedMessage, Input, Proof};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::link::{Hello, Remote};
use crate::pow;
use crate::sequencer::{ApiError, Cmd, Shared};

#[derive(Clone, Copy, Debug)]
pub struct PowBits {
    /// Trades, swaps, redemptions.
    pub light: u32,
    /// Top-ups, vouchers, withdrawals.
    pub heavy: u32,
}

#[derive(Clone)]
pub struct AppState {
    pub tx: mpsc::Sender<Cmd>,
    pub shared: Arc<Shared>,
    pub pow: PowBits,
    pub voucher_units: u64,
    pub remote: Arc<Remote>,
    pub signer_token: Option<String>,
    /// Master public key `M`, hex.
    pub m_hex: String,
    pub live: Arc<std::sync::RwLock<Vec<u8>>>,
    pub topup: Option<crate::topup::Desk>,
}

/// A JSON answer with `Connection: close`.
fn answer(status: StatusCode, body: Value) -> Response {
    let mut r = (status, Json(body)).into_response();
    r.headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    r
}

fn bad(what: &str) -> Response {
    answer(StatusCode::BAD_REQUEST, json!({ "error": what }))
}

fn from_api_error(e: ApiError) -> Response {
    match e {
        ApiError::Rejected(r) => answer(StatusCode::UNPROCESSABLE_ENTITY, json!({ "error": r })),
        ApiError::Halted | ApiError::Signer(_) => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "unavailable", "detail": e.to_string() }),
        ),
        ApiError::Internal(_) => answer(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "internal" }),
        ),
    }
}

/// Check the work, then parse the rest of the body.
fn parse<T: for<'de> Deserialize<'de>>(body: Value, bits: u32) -> Result<T, Response> {
    let rest = pow::check(body, bits).ok_or_else(|| bad("proof-of-work"))?;
    serde_json::from_value(rest).map_err(|_| bad("malformed request"))
}

/// Attach `Y = hash_to_curve(secret)` to each slip; the client can't choose it.
fn with_y(proofs: Vec<Proof>) -> Result<Vec<Input>, Response> {
    proofs
        .into_iter()
        .map(|p| {
            let y = blindbook_mint::y_hex(&p.secret).map_err(|_| bad("malformed slip"))?;
            Ok(Input { proof: p, y })
        })
        .collect()
}

#[derive(Serialize)]
struct SigOut {
    list: OutputList,
    index: usize,
    #[serde(flatten)]
    sig: BlindSignature,
}

fn sig_outs(
    applied_jobs: Vec<&blindbook_ledger::ledger::SignJob>,
    sigs: Vec<BlindSignature>,
) -> Vec<SigOut> {
    applied_jobs
        .into_iter()
        .zip(sigs)
        .map(|(j, sig)| SigOut {
            list: j.list,
            index: j.index,
            sig,
        })
        .collect()
}

async fn submit(state: &AppState, op: Op) -> Result<crate::sequencer::OpDone, Response> {
    let (rtx, rrx) = oneshot::channel();
    state
        .tx
        .send(Cmd::Op(op, rtx))
        .await
        .map_err(|_| from_api_error(ApiError::Halted))?;
    rrx.await
        .map_err(|_| from_api_error(ApiError::Halted))?
        .map_err(from_api_error)
}

fn op_answer(done: crate::sequencer::OpDone, stored: Value) -> Response {
    let jobs = done.applied.jobs();
    match &done.applied {
        Applied::Refused(r) => answer(StatusCode::UNPROCESSABLE_ENTITY, json!({ "error": r })),
        Applied::Redeemed { paid, .. } => answer(
            StatusCode::OK,
            json!({ "paid": paid, "signatures": sig_outs(jobs, done.signatures), "stored_record": stored }),
        ),
        _ => answer(
            StatusCode::OK,
            json!({ "signatures": sig_outs(jobs, done.signatures), "stored_record": stored }),
        ),
    }
}

#[derive(Deserialize)]
struct TradeBody {
    market: H32,
    side: Side,
    outcome: u8,
    limit_bp: u32,
    amount: u64,
    inputs: Vec<Proof>,
    outputs: Vec<BlindedMessage>,
    change_outputs: Vec<BlindedMessage>,
    tag: H32,
}

pub async fn trade(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let b: TradeBody = match parse(body, state.pow.light) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let inputs = match with_y(b.inputs) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let req = TradeRequest {
        market: b.market,
        side: b.side,
        outcome: b.outcome,
        limit_bp: b.limit_bp,
        amount: b.amount,
        inputs,
        outputs: b.outputs,
        change_outputs: b.change_outputs,
        tag: b.tag,
    };
    let stored = |batch_id: u64, fill: &FillRecord| {
        json!({
            "batch_id": batch_id, "tag": req.tag, "market": req.market, "side": req.side,
            "outcome": req.outcome, "amount": req.amount, "limit_bp": req.limit_bp,
            "status": fill.status, "avg_price_bp": fill.avg_price_bp,
        })
    };
    let (rtx, rrx) = oneshot::channel();
    if state.tx.send(Cmd::Trade(req.clone(), rtx)).await.is_err() {
        return from_api_error(ApiError::Halted);
    }
    let done = match rrx.await {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => return from_api_error(e),
        Err(_) => return from_api_error(ApiError::Halted),
    };
    match done.outcome.result {
        Ok(fill) => {
            let jobs: Vec<_> = done.outcome.effects.jobs.iter().collect();
            answer(
                StatusCode::OK,
                json!({
                    "batch_id": done.batch_id,
                    "fill": fill,
                    "signatures": sig_outs(jobs, done.signatures),
                    "stored_record": stored(done.batch_id, &fill),
                }),
            )
        }
        Err(r) => answer(StatusCode::UNPROCESSABLE_ENTITY, json!({ "error": r })),
    }
}

#[derive(Deserialize)]
struct SwapBody {
    inputs: Vec<Proof>,
    outputs: Vec<BlindedMessage>,
}

pub async fn swap(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let b: SwapBody = match parse(body, state.pow.light) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let inputs = match with_y(b.inputs) {
        Ok(i) => i,
        Err(r) => return r,
    };
    match submit(
        &state,
        Op::Swap {
            inputs,
            outputs: b.outputs,
        },
    )
    .await
    {
        Ok(done) => op_answer(done, json!({ "kind": "swap" })),
        Err(r) => r,
    }
}

pub async fn redeem(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let b: SwapBody = match parse(body, state.pow.light) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let inputs = match with_y(b.inputs) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let shares: u64 = inputs.iter().map(|i| i.proof.amount).sum();
    match submit(
        &state,
        Op::Redeem {
            inputs,
            outputs: b.outputs,
        },
    )
    .await
    {
        Ok(done) => op_answer(done, json!({ "kind": "redeem", "shares": shares })),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
struct WithdrawBody {
    inputs: Vec<Proof>,
    amount: u64,
    change_outputs: Vec<BlindedMessage>,
    address_sealed: String,
    address_commitment: H32,
}

pub async fn withdraw(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let b: WithdrawBody = match parse(body, state.pow.heavy) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if b.address_sealed.len() > 1_024 {
        return bad("sealed address too long");
    }
    let inputs = match with_y(b.inputs) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let stored =
        json!({ "kind": "withdraw", "amount": b.amount, "commitment": b.address_commitment });
    let op = Op::Withdraw {
        inputs,
        amount: b.amount,
        change: b.change_outputs,
        commitment: b.address_commitment,
        sealed: b.address_sealed,
    };
    match submit(&state, op).await {
        Ok(done) => op_answer(done, stored),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
struct VoucherBody {
    code: String,
    outputs: Vec<BlindedMessage>,
}

pub async fn voucher(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let b: VoucherBody = match parse(body, state.pow.heavy) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let code = b.code.trim().to_ascii_uppercase();
    if code.is_empty() || code.len() > 64 {
        return bad("malformed code");
    }
    let op = Op::Credit {
        amount: state.voucher_units,
        outputs: b.outputs,
        claim: CreditClaim::Voucher {
            code_hash: H32(sha256(code.as_bytes())),
        },
    };
    match submit(&state, op).await {
        Ok(done) => op_answer(
            done,
            json!({ "kind": "voucher", "amount": state.voucher_units }),
        ),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
struct TopupBody {
    amount_zat: u64,
    credit_outputs: Vec<BlindedMessage>,
    claim_hash: H32,
}

pub async fn topup_create(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let Some(desk) = state.topup.clone() else {
        return answer(StatusCode::NOT_FOUND, json!({ "error": "top-ups are off" }));
    };
    let b: TopupBody = match parse(body, state.pow.heavy) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !desk.denominations.contains(&b.amount_zat) {
        return bad("not a top-up denomination");
    }
    if !crate::topup::blank_credit_ok(&b.credit_outputs, &state.shared.credit_id) {
        return bad("credit_outputs must be 31 blank CREDIT outputs");
    }
    let head_height = state
        .shared
        .head
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .height;
    let mut book = desk.book.lock().unwrap_or_else(|e| e.into_inner());
    let height = head_height.max(book.scanned_height);
    let created = book.create(
        &desk.keys,
        b.amount_zat,
        b.credit_outputs,
        b.claim_hash,
        height,
    );
    drop(book);
    match created {
        Ok(t) => answer(
            StatusCode::OK,
            json!({
                "topup_id": t.id, "address": t.address, "expires_height": t.expires_height,
                "stored_record": { "kind": "topup", "amount_zat": t.amount_zat, "expires_height": t.expires_height },
            }),
        ),
        Err(_) => from_api_error(ApiError::Internal("topup".into())),
    }
}

pub async fn topup_status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(desk) = state.topup.clone() else {
        return answer(StatusCode::NOT_FOUND, json!({ "error": "top-ups are off" }));
    };
    let book = desk.book.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = book.get(&id) else {
        return answer(StatusCode::NOT_FOUND, json!({ "error": "unknown top-up" }));
    };
    let privacy = t.payments.first().map(|p| p.privacy);
    let paid: u64 = t.payments.iter().map(|p| p.value_zat).sum();
    answer(
        StatusCode::OK,
        json!({
            "status": t.status, "privacy": privacy, "paid_zat": paid,
            "payments": t.payments.len(), "expires_height": t.expires_height,
            "signatures": t.signatures,
        }),
    )
}

#[derive(Deserialize)]
struct ClaimBody {
    topup_id: String,
    topup_secret: String,
    credit_outputs: Vec<BlindedMessage>,
}

pub async fn topup_claim(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let Some(desk) = state.topup.clone() else {
        return answer(StatusCode::NOT_FOUND, json!({ "error": "top-ups are off" }));
    };
    let b: ClaimBody = match parse(body, state.pow.heavy) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !crate::topup::blank_credit_ok(&b.credit_outputs, &state.shared.credit_id) {
        return bad("credit_outputs must be 31 blank CREDIT outputs");
    }
    let job = match desk.book.lock().unwrap_or_else(|e| e.into_inner()).claim(
        &b.topup_id,
        &b.topup_secret,
        b.credit_outputs,
    ) {
        Ok(j) => j,
        Err(why) => return answer(StatusCode::UNPROCESSABLE_ENTITY, json!({ "error": why })),
    };
    let op = Op::Credit {
        amount: job.units,
        outputs: job.outputs.clone(),
        claim: CreditClaim::Topup {
            diversifier_index: job.index,
            txid: job.txid.clone(),
        },
    };
    match submit(&state, op).await {
        Ok(done) => {
            if let Applied::Effects(e) = &done.applied {
                let sigs = e
                    .jobs
                    .iter()
                    .zip(done.signatures.iter().cloned())
                    .map(|(j, sig)| crate::topup::SigOut {
                        list: j.list,
                        index: j.index,
                        sig,
                    })
                    .collect();
                desk.book
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .credited(&job, sigs);
            }
            op_answer(done, json!({ "kind": "topup_claim", "units": job.units }))
        }
        Err(r) => r,
    }
}

pub async fn head(State(state): State<AppState>) -> Response {
    let h = *state.shared.head.read().unwrap_or_else(|e| e.into_inner());
    answer(
        StatusCode::OK,
        json!({
            "height": h.height, "seq": h.seq, "root": h.root,
            "pow_bits": { "light": state.pow.light, "heavy": state.pow.heavy },
            "halted": state.shared.halted.load(Ordering::SeqCst),
        }),
    )
}

/// The catalog: every listed market with its labels, rules, keysets, parameters and status. The
/// same file for every visitor.
pub async fn markets(State(state): State<AppState>) -> Response {
    let markets: Vec<_> = state
        .shared
        .markets
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    answer(
        StatusCode::OK,
        json!({ "credit_keyset": state.shared.credit_id, "markets": markets }),
    )
}

pub async fn live(State(state): State<AppState>) -> Response {
    let bytes = state.live.read().unwrap_or_else(|e| e.into_inner()).clone();
    let mut r = (StatusCode::OK, bytes).into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    r
}

/// The signer dials in here (PROTOCOL section 9).
pub async fn signer(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(token) = state.signer_token.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.strip_prefix("Bearer ")
                .is_some_and(|t| t.as_bytes() == token.as_bytes())
        });
    if !ok {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let remote = state.remote.clone();
    let shared = state.shared.clone();
    let m = state.m_hex.clone();
    ws.on_upgrade(move |socket| async move {
        remote
            .attach(socket, |hello: &Hello| {
                let ours = shared.applied_ops.load(Ordering::SeqCst);
                let doubt = shared.in_doubt.load(Ordering::SeqCst);
                if hello.m != m {
                    Err(format!("signer has M {}, we pin {m}", hello.m))
                } else if hello.applied != ours && !(doubt && hello.applied == ours + 1) {
                    Err(format!(
                        "signer applied {} operations, we applied {ours}",
                        hello.applied
                    ))
                } else {
                    Ok(())
                }
            })
            .await
    })
}

/// Refusals the client can show (re-exported for tests).
pub fn reject_name(r: &Reject) -> String {
    serde_json::to_value(r)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
