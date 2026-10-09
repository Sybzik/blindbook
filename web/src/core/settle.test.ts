// Settling requests that got no answer, from the public log alone (no server): a request whose
// slips were spent while not one of the outputs it asked for was signed is reported
// (THREAT_MODEL I12); a withdrawal without change and a duel offer are not.
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Api } from './api';
import { yOf } from './blind';
import { utf8 } from './bytes';
import { Wallet, newWalletData, type InFlight } from './wallet';

const M = '0204559d9106c538b0f21bd82b50c47117bfda93530ed212fb818b886321cdea3c';

/** A wallet holding one slip, a request in doubt that spends it, and a log whose next delta
 *  spends it and issues nothing. */
function setup(flight: Pick<InFlight, 'outs'> & Partial<InFlight>) {
  const data = newWalletData(sha256(utf8('settle')));
  const api = {
    seq: 4,
    head: async () => ({ height: 10, seq: 4, root: '00', pow_bits: { light: 8, heavy: 8 }, halted: false }),
    text: async () => JSON.stringify({ seq: 4, issued: [], spent: [{ Y: yOf('a-spent-slip') }] }),
  } as unknown as Api;
  const w = new Wallet(data, M, api, async () => undefined);
  const slip = { id: w.credit.id, amount: 1024, secret: 'a-spent-slip', C: '02'.padEnd(66, '1') };
  data.slips = [slip];
  data.inflight = [{ id: 'f1', at_ms: 0, seq: 3, inputs: [slip], entry: { at_ms: 0, kind: 'buy', stored: {} }, doubt: true, ...flight }];
  return w;
}

describe('requests settled from the public log', () => {
  it('reports slips spent while none of the requested outputs was signed', async () => {
    const w = setup({ outs: [{ counter: 0, n: 31 }] });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
    expect(w.data.history.at(-1)?.stored.outputs_never_signed).toBe(true);
    expect(w.inDoubt()).toBe(0);
    expect(w.data.slips).toHaveLength(0);
  });

  it('a withdrawal without change asks for no outputs: nothing to report', async () => {
    const w = setup({ outs: [], entry: { at_ms: 0, kind: 'withdraw', stored: {} } });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
  });

  it("a duel offer's shares are signed at the take: nothing to report", async () => {
    const w = setup({ outs: [{ counter: 0, n: 4 }], duel: { id: 'd1', action: 'open' } });
    expect(await w.settleDoubts()).toBe(1);
    expect(w.takeRedirected()).toBe(0);
  });
});
