// Console commands. Everything here also has a button; the console just reaches it by typing.
// Trades go through the same actions (and the same checks) as the bet panel.

import { CONSOLE_RESPONSES } from '../ds';
import { app, actions } from '../app/services';
import { BET_UNITS, COIN, config } from '../app/config';
import { coin, coinLabel, height, zat } from '../app/format';
import { runAudit } from './pages/Verify';
import { quoteBuy } from '../app/pricing';
import { ui, type Theme } from './uistate';
import { setSound } from './sound';
import type { Out } from './Console';

export interface DeskApi {
  open(id: string): void;
  openMarket(page: string): boolean;
  teletext(page: string): boolean;
  lock(): void;
  intro(): void;
  closeConsole(): void;
  insider(): void;
  degauss(): void;
}

const HELP = [
  'markets · open 201 · buy 201 yes 0.01 --max 0.65 · sell 201 yes all · slips · balance',
  'verify · status · verbose on|off · trace · ping polymarket · ironwood · turnstile',
  'duels · duel 201 yes 0.01 --at 0.45 · take <duel id> · play snake|redact · calc 0.45',
  'radio on|off · record · pass · cage · lock · intro',
  'theme green|amber|paper · clean on|off · sound on|off · degauss · whoami · history · clear · exit',
];

const PAGES: Record<string, string> = {
  '100': 'markets',
  '150': 'duels',
  '300': 'slips',
  '350': 'cage',
  '400': 'verify',
  '500': 'how',
  '600': 'record',
  '601': 'pass',
  '701': 'snake',
  '702': 'calc',
  '703': 'tracker',
  '704': 'deaddrop',
  '705': 'radio',
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function marketByPage(arg: string | undefined) {
  if (!arg) return undefined;
  const page = 'P' + arg.replace(/^p/i, '');
  return app.get().markets.find((m) => m.page === page);
}

function outcomeIndex(m: { outcomes: [string, string] }, word: string | undefined): 0 | 1 | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === 'a' || w === m.outcomes[0].toLowerCase() || (w === 'yes' && m.outcomes[0].toLowerCase() === 'yes')) return 0;
  if (w === 'b' || w === m.outcomes[1].toLowerCase() || (w === 'no' && m.outcomes[1].toLowerCase() === 'no')) return 1;
  return null;
}

function priceOf(id: string, o: 0 | 1): number {
  const lm = app.get().live?.markets.find((x) => x.id === id);
  const a = lm?.price_a_ppm ? lm.price_a_ppm / 10_000 : 50;
  return o === 0 ? a : 100 - a;
}

function flag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = parseFloat(args[i + 1] ?? '');
  return Number.isFinite(v) ? v : undefined;
}

export async function runCommand(raw: string, out: Out, desk: DeskApi): Promise<void> {
  const cmd = raw.trim().replace(/\s+/g, ' ');
  const args = cmd.split(' ');
  const head = args[0]!.toLowerCase();
  const s = app.get();

  if (cmd === 'help') return out(HELP);
  const canned = (CONSOLE_RESPONSES as Record<string, string[] | undefined>)[cmd];
  if (canned && !['help', 'status', 'exit'].includes(cmd)) return out(canned);

  switch (head) {
    case 'markets': {
      if (!s.markets.length) return out('no markets listed yet');
      out(
        s.markets.map((m) => {
          const a = Math.round(priceOf(m.id, 0));
          return `${m.page}  ${m.outcomes[0].toUpperCase()} ${a}¢ · ${m.outcomes[1].toUpperCase()} ${100 - a}¢  ${m.question}`;
        }),
      );
      desk.open('markets');
      return;
    }
    case 'open': {
      const p = (args[1] ?? '').replace(/^p/i, '');
      if (PAGES[p]) {
        desk.open(PAGES[p]!);
        return out(`opening P${p}`);
      }
      if (desk.openMarket('P' + p)) return out(`opening P${p}`);
      if (desk.teletext(p)) return;
      return out('page not found. neither are you.', 'err');
    }
    case 'buy':
    case 'sell': {
      const m = marketByPage(args[1]);
      if (!m) return out(`usage: ${head} 201 yes 0.01 --max 0.65 (see "markets")`, 'err');
      const o = outcomeIndex(m, args[2]);
      if (o === null) return out(`outcome is ${m.outcomes[0].toLowerCase()} or ${m.outcomes[1].toLowerCase()}`, 'err');
      if (s.vault !== 'unlocked') return out('open your vault first', 'err');
      const label = m.outcomes[o].toUpperCase();
      const price = priceOf(m.id, o);
      if (head === 'buy') {
        const amount = parseFloat(args[3] ?? '');
        const units = Math.round(amount * 100_000);
        if (!BET_UNITS.includes(units)) return out(`standard sizes only: ${BET_UNITS.map((u) => coin(u, 2)).join(' · ')} ${COIN} (odd sizes can be linked)`, 'err');
        const max = flag(args, '--max');
        const limit = max !== undefined ? Math.round(max < 1 ? max * 100 : max) : quoteBuy(m, s.live?.markets.find((x) => x.id === m.id), o, units).limit;
        out(`buying ${label} for ${coin(units, 2)} ${COIN} at up to ${limit}¢ · batch closes in ≤ 2 s`, 'sys');
        const r = await actions.buy(m.id, o, units, limit * 100);
        const f = r.fill;
        return out(
          f.out > 0
            ? `${f.status.toUpperCase()} · ${coin(f.out)} shares of ${label} @ ${Math.round(f.avg_price_bp / 100)}¢ · batch ${r.batch_id}${f.refund ? ` · refunded ${coin(f.refund)}` : ''}`
            : `nothing filled (${f.status}); the full amount is back`,
        );
      }
      const pos = s.positions.find((p) => p.market === m.id && p.outcome === o);
      if (!pos) return out(`you hold no ${label} shares`, 'err');
      const shares = args[3] === 'all' || !args[3] ? pos.units : Math.round(parseFloat(args[3]) * 100_000);
      const min = flag(args, '--min');
      const lm = s.live?.markets.find((x) => x.id === m.id);
      const floor = min !== undefined ? Math.round(min < 1 ? min * 100 : min) : Math.max(1, Math.floor((lm?.reference.bid_ppm[o] ?? 10_000) / 10_000) - 3);
      out(`selling ${coin(shares)} ${label} at no less than ${floor}¢`, 'sys');
      const r = await actions.sell(m.id, o, shares, floor * 100);
      return out(`${r.fill.status.toUpperCase()} · ${coinLabel(r.fill.out)} back in your balance · batch ${r.batch_id}`);
    }
    case 'slips': {
      desk.open('slips');
      if (s.vault !== 'unlocked') return out('opening P300 · the vault is locked');
      return out([`balance ${coinLabel(s.balance)}`, ...s.positions.map((p) => {
        const m = s.markets.find((x) => x.id === p.market);
        return `${m?.page ?? '?'} ${m?.outcomes[p.outcome].toUpperCase() ?? p.outcome} · ${coin(p.units)} shares`;
      })]);
    }
    case 'balance':
      return out(s.vault === 'unlocked' ? `${coinLabel(s.balance)} free · ${s.positions.length} open positions` : 'the vault is locked');
    case 'verify': {
      out('downloading the public log (the same files every visitor gets)…', 'sys');
      const { result: r } = await runAudit((p) => (p === 'checking' ? out('checking chain, DLEQ proofs, supply…', 'sys') : undefined));
      return out([
        `hash chain   ${r.chainOk ? `✓ ${r.deltas} deltas up to root ${r.root.slice(0, 8)}…` : '✗ BROKEN'}`,
        `signatures   ${r.sigsOk === r.sigs ? '✓' : '✗'} ${r.sigsOk}/${r.sigs} DLEQ proofs valid for keys derived from M`,
        r.replay ? `replay       ${r.replay.failures.length ? '✗ ' + r.replay.failures[0] : `✓ ${r.replay.batches} batches through the engine (wasm), same fills and pools`}` : 'replay       not run',
        `keysets      ${r.keysetsOk ? '✓ every listed market uses keys derived from M' : '✗ a market uses keys not derived from M'}`,
        `supply       ${r.supplyOk ? '✓ nothing spent beyond what was issued' : '✗ more spent than issued'}`,
        r.reserve
          ? `solvency     ${r.solventOk ? '✓' : '✗'} reserve ${zat(r.reserve.reserveZat + r.reserve.unsweptZat)} vs liabilities ${zat(r.reserve.owedZat)} ${COIN} at blk ${height(r.reserve.height)}`
          : `solvency     no reserve report yet · liabilities ${zat(r.liabilitiesZat)} ${COIN}`,
        `anchors      ${r.anchors.length} on-chain · ${(r.ms / 1000).toFixed(1)} s in this browser`,
        r.chainOk && r.sigsOk === r.sigs && r.keysetsOk && r.supplyOk && r.replay?.failures.length === 0 && (r.solventOk || !r.reserve) ? 'LEDGER MATCH ✓' : 'MISMATCH ✗',
      ]);
    }
    case 'status': {
      const batch = s.live?.recent.at(-1)?.batch_id;
      return out([
        config.mixnet ? `mixnet ● ${s.link}` : config.onion ? 'network ● Tor (.onion mirror): requests go through Tor to the onion service' : `mixnet ○ off in this development build (requests go straight to the server)`,
        `blk ${s.head ? height(s.head.height) : '—'} · log seq ${s.head?.seq ?? '—'}${batch ? ` · last batch ${batch}` : ''}${s.head?.halted ? ' · HALTED' : ''}`,
        `vault ${s.vault} · network ${config.network}`,
      ]);
    }
    case 'verbose': {
      const on = args[1] !== 'off';
      ui.set({ verbose: on });
      return out(on ? 'verbose on · the crypto pipeline prints here as it runs (blinding, proof-of-work, DLEQ, seals)' : 'verbose off');
    }
    case 'trace': {
      if (!config.mixnet) out(config.onion ? 'note: this .onion mirror sends requests through Tor; the mixnet build takes this path' : 'note: this development build has no mixnet; this is the path production requests take', 'sys');
      const hops = ['you · a Sphinx packet, layered encryption', 'entry gateway · sees that an IP uses Nym, nothing else', 'mix node 1 · delays, reorders, strips one layer', 'mix node 2 · same, plus cover traffic', 'mix node 3 · same', 'exit (IP packet router) · sees a request, not who sent it', 'blindbook api · answers; never had your IP'];
      for (const [i, h] of hops.entries()) {
        await wait(320);
        out(`${'  '.repeat(i)}└▶ ${h} ✓`);
      }
      await wait(320);
      out('▓▒░ ░ ·  ·    the path dissolves into noise.', 'sys');
      return;
    }
    case 'ping': {
      const l = s.live;
      if (!l) return out('no live data yet', 'err');
      const age = Math.max(0, Date.now() - l.at_ms);
      const bad = l.markets.filter((m) => m.reference.unhealthy_ms > 0).length;
      return out([
        'this browser never contacts Polymarket. the server mirrors its order books over a websocket.',
        `reference snapshot age ${(age / 1000).toFixed(1)} s · ${l.markets.length - bad}/${l.markets.length} feeds healthy`,
        'results: read from Polymarket\'s ConditionalTokens contract on Polygon, at a finalized block',
      ]);
    }
    case 'ironwood': {
      const b = s.live?.block;
      return out([
        '        ▲',
        '       ▲▲▲        IRONWOOD',
        '      ▲▲▲▲▲       the shielded pool Blindbook uses',
        '     ▲▲▲▲▲▲▲      for every top-up and every payout',
        '        █',
        b ? `last block ${height(b.height)} · ${b.shielded_actions} shielded actions` : 'waiting for a block',
      ]);
    }
    case 'turnstile':
      return out([
        '1. Value entering or leaving a shielded pool crosses a public turnstile.',
        '2. So a pool can never pay out more than went in: inflation would show.',
        '3. Inside the pool, amounts, senders and receivers stay encrypted.',
        '4. Blindbook takes top-ups and pays withdrawals inside the shielded pool only.',
        '5. Our reserve viewing key is public: anyone can audit that it covers every slip.',
      ]);
    case 'play': {
      const g = args[1] === 'redact' || args[1] === 'tracker' ? 'tracker' : args[1] === 'snake' ? 'snake' : null;
      if (!g) return out('play snake · play redact', 'err');
      desk.open(g);
      return out(`opening ${g === 'snake' ? 'P701' : 'P703'}`);
    }
    case 'calc': {
      const v = parseFloat(args[1] ?? '');
      desk.open('calc');
      if (!Number.isFinite(v)) return out('opening P702');
      const p = Math.min(0.99, Math.max(0.01, v > 1 ? v / 100 : v));
      return out([
        `price ${Math.round(p * 100)}¢ → chance ${Math.round(p * 100)}% · decimal ${(1 / p).toFixed(2)} · american ${p >= 0.5 ? '-' + Math.round((p / (1 - p)) * 100) : '+' + Math.round(((1 - p) / p) * 100)}`,
        `0.01 ${COIN} pays ${((0.01 / p) * 0.99).toFixed(4)} ${COIN} if it wins (fee 1%)`,
      ]);
    }
    case 'radio': {
      const on = args[1] !== 'off';
      if (on) {
        ui.set({ sound: true, radio: true });
        setSound(true);
        desk.open('radio');
        return out('BLOCK RADIO on · every new block plays a chord');
      }
      ui.set({ radio: false });
      return out('radio off');
    }
    case 'theme': {
      const t = args[1] as Theme;
      if (!['green', 'amber', 'paper'].includes(t)) return out('theme green · amber · paper', 'err');
      ui.set({ theme: t });
      return out(`theme ${t}`);
    }
    case 'clean':
      ui.set({ clean: args[1] !== 'off' });
      return out(`clean signal ${args[1] !== 'off' ? 'on: no glow, scanlines or motion' : 'off'}`);
    case 'sound': {
      const on = args[1] !== 'off';
      ui.set({ sound: on });
      setSound(on);
      return out(`sound ${on ? 'on' : 'off'}`);
    }
    case 'duels':
      desk.open('duels');
      return out((s.live?.duels ?? []).map((d) => {
        const m = s.markets.find((x) => x.id === d.market);
        return `${d.duel.slice(0, 8)}  ${m?.page ?? '?'} ${m ? m.outcomes[d.outcome].toUpperCase() : d.outcome} at ${Math.round(d.price_bp / 100)}¢ · ${coin(d.shares)} shares · take for ${coin(d.shares - d.stake)}`;
      }).concat(s.live?.duels.length ? [] : ['no open challenges']));
    case 'duel': {
      const m = marketByPage(args[1]);
      if (!m) return out('usage: duel 201 yes 0.01 --at 0.45', 'err');
      const o = outcomeIndex(m, args[2]);
      if (o === null) return out(`outcome is ${m.outcomes[0].toLowerCase()} or ${m.outcomes[1].toLowerCase()}`, 'err');
      if (s.vault !== 'unlocked') return out('open your vault first', 'err');
      const units = Math.round(parseFloat(args[3] ?? '') * 100_000);
      if (!BET_UNITS.includes(units)) return out(`standard stakes only: ${BET_UNITS.map((u) => coin(u, 2)).join(' · ')} ${COIN}`, 'err');
      const at = flag(args, '--at');
      const cents = Math.min(99, Math.max(1, at !== undefined ? Math.round(at < 1 ? at * 100 : at) : Math.round(priceOf(m.id, o))));
      const shares = Math.floor((units * 100) / cents);
      const d = await actions.duelOpen(m.id, o, shares, cents * 100);
      return out([`duel open: ${m.outcomes[o].toUpperCase()} at ${cents}¢ · ${coin(shares)} shares · stake ${coin(d.stake)} in escrow`, `${location.origin}/#d=${d.duel}`]);
    }
    case 'take': {
      const id = (args[1] ?? '').toLowerCase();
      const d = id.length >= 6 ? s.live?.duels.find((x) => x.duel.startsWith(id)) : undefined;
      if (!d) return out('usage: take <duel id, at least 6 characters> (see "duels")', 'err');
      if (s.vault !== 'unlocked') return out('open your vault first', 'err');
      const n = await actions.duelTake(d);
      return out(`taken: ${coin(n)} shares of the other side are in your slips`);
    }
    case 'record':
      desk.open('record');
      return out('opening P600 · what we know about you');
    case 'pass':
      desk.open('pass');
      return out('opening NOBODY PASS');
    case 'cage':
    case 'topup':
    case 'withdraw':
      desk.open('cage');
      return out('opening P350');
    case 'lock':
      desk.closeConsole();
      desk.lock();
      return;
    case 'intro':
    case 'replay':
      out('rolling the intro…');
      await wait(400);
      desk.intro();
      return;
    case 'degauss':
      desk.degauss();
      return out('*thunk*');
    case 'insider':
      desk.insider();
      return out("we can't tell who you are. that includes insiders.");
    case 'exit':
      out("you can't leave a place you never entered.");
      await wait(900);
      desk.closeConsole();
      return;
  }
  out(`${head}: unknown command. type help`, 'err');
}
