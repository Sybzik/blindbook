import { describe, expect, it } from 'vitest';
import { MemoryStore, Vault, newMnemonic, seedFromMnemonic } from './vault';
import { randomBytes } from '../core/bytes';

describe('vault', () => {
  it('passphrase: create, lock, unlock, save', async () => {
    const store = new MemoryStore();
    const v = new Vault(store);
    await v.create({ hello: 'world' }, 'correct horse');
    expect(JSON.stringify(store.r)).not.toContain('world');
    v.lock();
    await expect(v.unlockWithPassphrase('wrong')).rejects.toThrow(/wrong passphrase/);
    expect(await v.unlockWithPassphrase('correct horse')).toEqual({ hello: 'world' });
    await v.save({ hello: 'again' });
    const w = new Vault(store);
    expect(await w.unlockWithPassphrase('correct horse')).toEqual({ hello: 'again' });
  }, 20_000);

  it('PRF wrap opens the same vault', async () => {
    const store = new MemoryStore();
    const v = new Vault(store);
    await v.create({ n: 1 });
    const prf = randomBytes(32);
    await v.addPrf('cred', randomBytes(32), prf);
    v.lock();
    await expect(v.unlockWithPrf(randomBytes(32))).rejects.toThrow();
    expect(await v.unlockWithPrf(prf)).toEqual({ n: 1 });
  });

  it('12 words', () => {
    const words = newMnemonic();
    expect(words.split(' ')).toHaveLength(12);
    expect(seedFromMnemonic(words.toUpperCase())).toHaveLength(64);
    expect(() => seedFromMnemonic('nope nope')).toThrow();
  });
});
