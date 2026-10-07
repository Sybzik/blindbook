// P350 the cage: top up (standard amount → privacy preflight → receipt with the address →
// SEEN → CREDITED), redeem a judge's code, withdraw to a fresh address.
// Top-ups and withdrawals run over their own one-off mixnet identity (services.ts).

import { useEffect, useState } from 'react';
import { AmountChips, KeyButton, LeaderRow, PreflightChecklist, TeletextHeader, TextInput, ThermalReceipt } from '../../ds';
import { Win } from '../win';
import { Qr } from '../Qr';
import { app, actions, setLocal, walletWords } from '../../app/services';
import { WordCheck, WordList } from '../WordCheck';
import { useStore } from '../../app/store';
import { COIN, TOPUP_ZAT, WITHDRAWAL_FEE_UNITS, WITHDRAW_UNITS, ZERO_CONF_ZAT, config } from '../../app/config';
import { coin, coinLabel, height, utc, zat } from '../../app/format';
import { Shredder } from '../Shredder';
import type { TopupRecord } from '../../core/wallet';

type Check = 'ok' | 'fail';

/** The privacy preflight, from real state: each line is checked, not just animated. */
function Preflight({ amount, onReady }: { amount: string; onReady: (ok: boolean) => void }) {
  const link = useStore(app, (s) => s.link);
  const backedUp = useStore(app, (s) => s.local.backedUp ?? false);
  const [n, setN] = useState(0);
  const [backup, setBackup] = useState(false);
  const mixOk = config.mixnet && link === 'linked';
  const testnet = config.network === 'testnet';
  const items = [
    { label: 'MIXNET LINKED', ok: '3 HOPS', fail: config.mixnet ? 'NOT LINKED YET' : 'DEV BUILD: NO MIXNET' },
    { label: 'PHRASE BACKED UP', ok: backedUp ? 'BACKED UP' : 'OPTIONAL ON TESTNET', fail: 'BACK UP FIRST' },
    { label: 'STANDARD AMOUNT', ok: `${amount} ${COIN}`, fail: 'NON-STANDARD' },
    { label: 'PAY FROM YOUR SHIELDED BALANCE', ok: 'SHIELDED ONLY', fail: 'TRANSPARENT' },
  ];
  const real: Check[] = [mixOk ? 'ok' : 'fail', backedUp || testnet ? 'ok' : 'fail', 'ok', 'ok'];
  useEffect(() => {
    setN(0);
    let i = 0;
    const t = setInterval(() => {
      i++;
      setN(i);
      if (i >= items.length) clearInterval(t);
    }, 420);
    return () => clearInterval(t);
  }, []);
  const done = n >= items.length;
  // A development build has no mixnet; it may continue (and says so). Production may not.
  const blocking = real.some((r, i) => r === 'fail' && !(i === 0 && config.dev));
  useEffect(() => {
    if (done) onReady(!blocking);
  }, [done, blocking]);
  const statuses = items.map((_, i) => (i < n ? real[i]! : i === n ? 'checking' : 'pending'));
  return (
    <div>
      <PreflightChecklist items={items} statuses={statuses} />
      {done && real[0] === 'fail' && config.dev && <p className="bb-conditions">Development build: requests go straight to the server. Production sends every request through the mixnet and stops here if it is down.</p>}
      {done && !backedUp && (
        <p className="bb-conditions">
          Your 12 words are not confirmed yet{testnet ? ' (fine for testnet play)' : ''}.{' '}
          <button type="button" className="bb-link" onClick={() => setBackup(true)}>back up now</button>
        </p>
      )}
      {backup && <Backup onDone={() => setBackup(false)} />}
    </div>
  );
}

/** Show the open vault's words again, then confirm them by stamping. */
function Backup({ onDone }: { onDone: () => void }) {
  const words = walletWords();
  const [step, setStep] = useState<'show' | 'check'>('show');
  if (!words) return <p className="bb-conditions">This vault was made before words were kept in it; make a new vault to get a backup.</p>;
  return (
    <div className="col" style={{ gap: 12, marginTop: 12, maxWidth: 520 }}>
      {step === 'show' ? (
        <>
          <p className="bb-text" style={{ margin: 0 }}>Write these down on paper, in order. Make sure nobody sees your screen.</p>
          <WordList words={words} />
          <KeyButton onClick={() => setStep('check')}>I WROTE THEM DOWN</KeyButton>
        </>
      ) : (
        <WordCheck
          words={words}
          onDone={() => {
            void setLocal({ backedUp: true });
            onDone();
          }}
        />
      )}
    </div>
  );
}

function TopUp() {
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const head = useStore(app, (s) => s.head);
  const options = TOPUP_ZAT.map((z) => zat(z, z < 1_000_000 ? 3 : 2));
  const [amt, setAmt] = useState(options[1] ?? options[0]!);
  const [step, setStep] = useState<'amount' | 'preflight' | 'ready' | 'receipt'>('amount');
  const [rec, setRec] = useState<TopupRecord | null>(null);
  const amountZat = TOPUP_ZAT[options.indexOf(amt)] ?? TOPUP_ZAT[0]!;
  useEffect(() => {
    if (!rec || rec.status === 'credited' || rec.status === 'confirmed') return;
    const t = setInterval(async () => {
      try {
        setRec({ ...(await actions.topupPoll(rec.id)) });
      } catch {
        /* retried */
      }
    }, 2_000);
    return () => clearInterval(t);
  }, [rec]);
  const start = async () => {
    try {
      setRec(await actions.topupStart(amountZat));
      setStep('receipt');
    } catch {
      /* shown */
    }
  };
  const uri = rec ? `zcash:${rec.address}?amount=${zat(rec.amount_zat, 8).replace(/0+$/, '').replace(/\.$/, '')}` : '';
  const status = rec?.status === 'credited' || rec?.status === 'confirmed' ? 'credited' : rec?.status === 'seen' ? 'seen' : 'awaiting';
  const S = (n: number, label: string, on: boolean) => <p className={'tk-step' + (on ? '' : ' is-todo')}><b>{n}</b>{label}</p>;
  return (
    <div className="tk-cage">
      <div className="tk-steps">
        {S(1, 'PICK A STANDARD AMOUNT', true)}
        <div data-hint="Standard sizes keep you in the crowd.">
          <AmountChips value={amt} options={options} unit={COIN} onChange={(v: string) => { setAmt(v); setStep('amount'); setRec(null); }} />
        </div>
        {step === 'amount' && <div><KeyButton onClick={() => setStep('preflight')}>CONTINUE</KeyButton></div>}
        {S(2, 'PRIVACY PREFLIGHT', step !== 'amount')}
        {step !== 'amount' && <Preflight amount={amt} onReady={(ok) => setStep((s) => (s === 'preflight' && ok ? 'ready' : s === 'ready' && !ok ? 'preflight' : s))} />}
        {step === 'ready' && (
          <div data-hint="Gets a one-time address for this top-up, over a separate mixnet identity.">
            <KeyButton size="lg" icon="cage" loading={busy === 'OPENING THE CAGE'} disabled={!!busy} onClick={start}>GET MY ADDRESS</KeyButton>
          </div>
        )}
        {S(3, 'PAY · SEEN · CREDITED', step === 'receipt')}
        {step === 'receipt' && rec && (
          <div style={{ maxWidth: 460 }}>
            <LeaderRow label="STATUS" value={status === 'awaiting' ? 'AWAITING PAYMENT' : status === 'seen' ? 'SEEN in the mempool · crediting…' : 'CREDITED ✓'} tone={status === 'credited' ? 'hi' : 'default'} />
            <LeaderRow label="CONFIRMATIONS" value={rec.amount_zat <= ZERO_CONF_ZAT ? 'none needed' : '1 confirmation'} />
            <LeaderRow label="ADDRESS VALID UNTIL" value={'blk ' + height(rec.expires_height)} />
            {rec.privacy === 'EXPOSED' && <p className="bb-conditions" style={{ color: 'var(--alarm)' }}>EXPOSED: this payment came from transparent funds, so the sender's address and amount are public on-chain. Pay from your shielded balance next time.</p>}
            {rec.privacy === 'AMOUNT_VISIBLE' && <p className="bb-conditions" style={{ color: 'var(--b)' }}>AMOUNT VISIBLE: the amount crossed shielded pools and shows on-chain; who paid stays hidden.</p>}
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <a className="bb-key bb-key--primary bb-key--sm" href={uri} data-hint="Opens your Zcash wallet (Zodl on a phone) with the address and amount filled in.">PAY IN WALLET</a>
              <KeyButton variant="secondary" size="sm" onClick={() => navigator.clipboard?.writeText(rec.address)}>COPY ADDRESS</KeyButton>
              {config.dev && status === 'awaiting' && (
                <KeyButton variant="secondary" size="sm" onClick={() => fetch(`/dev/pay/${rec.id}`, { method: 'POST' })}>SIMULATE PAYMENT (DEV)</KeyButton>
              )}
              {status === 'credited' && <KeyButton variant="secondary" size="sm" onClick={() => { setStep('amount'); setRec(null); }}>TOP UP AGAIN</KeyButton>}
            </div>
          </div>
        )}
        {error && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{error}</p>}
      </div>
      <div className="col" style={{ gap: 12 }}>
        {step === 'receipt' && rec ? (
          <>
            <ThermalReceipt
              key={rec.id}
              kind="CAGE · TOP-UP"
              amount={zat(rec.amount_zat)}
              unit={COIN}
              address={rec.address.slice(0, 10) + '…' + rec.address.slice(-6)}
              status={status}
              printing
              qr={<Qr value={uri} size={184} paper title={`Payment request for ${zat(rec.amount_zat)} ${COIN}`} />}
              lines={[
                { label: 'ORDER Nº', value: rec.id.slice(0, 8).toUpperCase() },
                { label: 'BLOCK', value: height(head?.height ?? 0) },
                { label: 'VALID UNTIL', value: 'blk ' + height(rec.expires_height) },
              ]}
              footer="pay from your shielded balance"
            />
          </>
        ) : (
          <p className="bb-text bb-dim" style={{ margin: 0 }}>
            The receipt prints here. On a computer, scan the QR with your wallet; on a phone, PAY IN WALLET opens it with everything filled in.
          </p>
        )}
      </div>
    </div>
  );
}

function Code() {
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const [code, setCode] = useState('');
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="tk-cage">
      <div className="tk-steps" style={{ gap: 16 }}>
        <TextInput label="JUDGE CODE" placeholder="BB-XXXX-XXXX-…" value={code} onChange={(v: string) => { setCode(v); setDone(null); }} message="A single-use code from the organisers. It never identifies you." />
        <div>
          <KeyButton disabled={code.trim().length < 6 || !!busy} loading={busy === 'REDEEMING CODE'} onClick={() => actions.voucher(code.trim()).then(setDone).catch(() => undefined)}>REDEEM</KeyButton>
        </div>
        {done !== null && <p className="bb-conditions">Added {coinLabel(done)} to your balance.</p>}
        {error && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{error}</p>}
      </div>
      <div />
    </div>
  );
}

function Withdraw() {
  const balance = useStore(app, (s) => s.balance);
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const [addr, setAddr] = useState('');
  const options = WITHDRAW_UNITS.map((u) => coin(u, 2));
  const [amt, setAmt] = useState(options[0]!);
  const [sent, setSent] = useState<string | null>(null);
  const [shred, setShred] = useState<string | null>(null);
  const history = useStore(app, (s) => s.history);
  const payouts = useStore(app, (s) => s.live?.payouts);
  const paidSeen = useStore(app, (s) => s.local.paid);
  const units = WITHDRAW_UNITS[options.indexOf(amt)] ?? WITHDRAW_UNITS[0]!;
  // Our own withdrawals, from the vault, and whether a payout in the public live feed paid them.
  const mine = history
    .filter((h) => h.kind === 'withdraw' && typeof h.stored.commitment === 'string')
    .slice(-5)
    .reverse()
    .map((h) => {
      const c = h.stored.commitment as string;
      const paid = paidSeen?.[c] ?? payouts?.find((p) => p.commitments.includes(c))?.txid;
      return { c, at: h.at_ms, amount: Number(h.stored.amount ?? 0), paid };
    });
  // Remember a payout once seen, in the vault: the live feed only keeps 30 minutes.
  useEffect(() => {
    const fresh = mine.filter((w) => w.paid && !paidSeen?.[w.c]);
    if (fresh.length) void setLocal({ paid: { ...paidSeen, ...Object.fromEntries(fresh.map((w) => [w.c, w.paid!])) } });
  }, [payouts]);
  const withdraw = () =>
    actions
      .withdraw(units, addr)
      .then((c) => {
        setSent(c);
        // The address is sealed and sent; drop it from this page as well, visibly.
        setShred(addr);
        setAddr('');
      })
      .catch(() => undefined);
  const prefix = config.network === 'mainnet' ? 'u1' : 'utest1';
  const st = !addr ? undefined : addr.startsWith('t') || addr.startsWith('tm') ? 'invalid' : (addr.startsWith(prefix) || addr.startsWith('z' + prefix)) && addr.length > 60 ? 'valid' : addr.length > 4 ? 'invalid' : undefined;
  const msg =
    st === 'invalid'
      ? addr.startsWith('t')
        ? `That's a transparent address. Paste a fresh ${prefix}… address from your wallet.`
        : `Paste a fresh unified address (${prefix}…) with a shielded receiver.`
      : st === 'valid'
        ? '✓ Looks right. The signer checks it again before anything is spent.'
        : 'Use a fresh address. Only the signer can read it; we keep a commitment, never the address.';
  const enough = balance >= units + WITHDRAWAL_FEE_UNITS;
  return (
    <div className="tk-cage">
      <div className="tk-steps" style={{ gap: 16 }}>
        <TextInput label="WITHDRAW TO" placeholder={`${prefix}… fresh address`} value={addr} onChange={(v: string) => { setAddr(v.trim()); setSent(null); }} state={st} message={msg}
          action={<button type="button" className="bb-skey" onClick={async () => setAddr((await navigator.clipboard.readText()).trim())}>PASTE</button>} />
        <AmountChips value={amt} options={options} unit={COIN} onChange={setAmt} />
        <div style={{ maxWidth: 460 }}>
          <LeaderRow label="PRIVACY DELAY" value="random, 0–60 s before sending" />
          <LeaderRow label="FEE" value={coinLabel(WITHDRAWAL_FEE_UNITS)} />
          <LeaderRow label="ARRIVES" value="in the next payout, about one block" />
        </div>
        <div>
          <KeyButton disabled={st !== 'valid' || !enough || !!busy} loading={busy === 'WITHDRAWING'} onClick={withdraw}>
            {busy === 'WITHDRAWING' ? 'WAITING · PRIVACY DELAY' : 'WITHDRAW'}
          </KeyButton>
          {!enough && <p className="bb-conditions">Not enough balance for {amt} {COIN} plus the fee.</p>}
          {sent && <p className="bb-conditions">Queued for the next payout. The address was sealed to the signer, who forgets it once paid; the server keeps only the commitment {sent.slice(0, 12)}….</p>}
          {error && <p className="bb-conditions" style={{ color: 'var(--alarm)' }} role="status">{error}</p>}
        </div>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {shred && <Shredder key={shred} text={shred} />}
        {mine.length > 0 && (
          <div>
            <p className="bb-label bb-hi" style={{ margin: 0 }}>YOUR WITHDRAWALS</p>
            {mine.map((w) => (
              <LeaderRow key={w.c} label={`${coin(w.amount, 2)} ${COIN} · ${utc(w.at)}`} value={w.paid ? `PAID ✓ ${w.paid.slice(0, 8)}…` : 'QUEUED · next payout'} tone={w.paid ? 'hi' : 'default'} />
            ))}
            <p className="bb-conditions">Status comes from the payouts every visitor sees; nothing about you is asked for.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function CagePage({ onClose }: { onClose: () => void }) {
  const balance = useStore(app, (s) => s.balance);
  const vault = useStore(app, (s) => s.vault);
  const [tab, setTab] = useState<'top' | 'code' | 'out'>('top');
  return (
    <Win title="P350 · CAGE" onClose={onClose}>
      <TeletextHeader page="P350" title="THE CAGE" meta={coinLabel(balance)} />
      {vault !== 'unlocked' ? (
        <p className="bb-text">Open your vault first. Money in and out goes through here.</p>
      ) : (
        <>
          <div className="tk-tabs" role="tablist">
            {(
              [
                ['top', 'TOP UP'],
                ['code', 'JUDGE CODE'],
                ['out', 'WITHDRAW'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={'bb-tab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'top' ? <TopUp /> : tab === 'code' ? <Code /> : <Withdraw />}
        </>
      )}
    </Win>
  );
}
