// The vault (ARCHITECTURE "Vault"): the wallet data encrypted at rest on this device.
//
// A random 256-bit vault key encrypts the wallet (AES-256-GCM). The vault key is wrapped:
//   - by HKDF(PRF output, "bb-vault-v1") from a passkey (WebAuthn `prf` extension, evaluated on
//     the device: Face ID on phones), and/or
//   - by Argon2id(passphrase) (m = 64 MiB, t = 3, p = 1): the unlock on computers.
// The 12 words (BIP 39) regenerate every secret. Nothing here ever leaves the device.

import { argon2id } from 'hash-wasm';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base64url, fromBase64url, own, randomBytes, utf8 } from '../core/bytes';

export const ARGON = { memorySize: 64 * 1024, iterations: 3, parallelism: 1 };

export interface Wrap {
  kind: 'pass' | 'prf';
  /** For 'prf': the passkey's credential id (base64url). */
  credential?: string;
  salt: string;
  iv: string;
  wrapped: string;
}

export interface VaultRecord {
  v: 1;
  iv: string;
  ct: string;
  wraps: Wrap[];
}

/** Where the encrypted record lives (IndexedDB in the browser, memory in tests). */
export interface VaultStore {
  load(): Promise<VaultRecord | undefined>;
  store(r: VaultRecord): Promise<void>;
  clear(): Promise<void>;
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]) {
  return crypto.subtle.importKey('raw', own(raw), 'AES-GCM', false, usage);
}

async function seal(key: Uint8Array, plain: Uint8Array) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: own(iv) }, await aesKey(key, ['encrypt']), own(plain)));
  return { iv: base64url(iv), ct: base64url(ct) };
}

async function open(key: Uint8Array, iv: string, ct: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: own(fromBase64url(iv)) }, await aesKey(key, ['decrypt']), own(fromBase64url(ct))),
  );
}

export async function passKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({ password: utf8(passphrase.normalize('NFKC')), salt, hashLength: 32, outputType: 'binary', ...ARGON });
}

export function prfKek(prf: Uint8Array): Uint8Array {
  return hkdf(sha256, prf, undefined, utf8('bb-vault-v1'), 32);
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function seedFromMnemonic(words: string): Uint8Array {
  const w = words.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(w, wordlist)) throw new Error('those 12 words are not a valid phrase');
  return mnemonicToSeedSync(w);
}

export class Vault {
  private key?: Uint8Array;
  private record?: VaultRecord;

  constructor(private store: VaultStore) {}

  async exists(): Promise<boolean> {
    return (await this.store.load()) !== undefined;
  }

  unlocked(): boolean {
    return this.key !== undefined;
  }

  lock() {
    this.key?.fill(0);
    this.key = undefined;
  }

  async wraps(): Promise<Wrap[]> {
    return (await this.store.load())?.wraps ?? [];
  }

  /** A new vault holding `data`, wrapped by the given passphrase (or none yet). */
  async create(data: unknown, passphrase?: string): Promise<void> {
    this.key = randomBytes(32);
    const body = await seal(this.key, utf8(JSON.stringify(data)));
    this.record = { v: 1, ...body, wraps: [] };
    if (passphrase) await this.addPassphrase(passphrase);
    else await this.store.store(this.record);
  }

  async addPassphrase(passphrase: string): Promise<void> {
    if (!this.key || !this.record) throw new Error('vault is locked');
    const salt = randomBytes(16);
    const w = await seal(await passKek(passphrase, salt), this.key);
    this.record.wraps = this.record.wraps.filter((x) => x.kind !== 'pass').concat({ kind: 'pass', salt: base64url(salt), iv: w.iv, wrapped: w.ct });
    await this.store.store(this.record);
  }

  /** Wrap the vault key with a passkey's PRF output (from passkey.ts). */
  async addPrf(credential: string, salt: Uint8Array, prf: Uint8Array): Promise<void> {
    if (!this.key || !this.record) throw new Error('vault is locked');
    const w = await seal(prfKek(prf), this.key);
    this.record.wraps = this.record.wraps.filter((x) => x.kind !== 'prf').concat({ kind: 'prf', credential, salt: base64url(salt), iv: w.iv, wrapped: w.ct });
    await this.store.store(this.record);
  }

  private async unwrap(wrap: Wrap, kek: Uint8Array): Promise<unknown> {
    const r = (await this.store.load())!;
    let key: Uint8Array;
    try {
      key = await open(kek, wrap.iv, wrap.wrapped);
    } catch {
      throw new Error('Wrong passphrase: the vault stays closed. Try again, or restore from your 12 words.');
    }
    const data = JSON.parse(new TextDecoder().decode(await open(key, r.iv, r.ct)));
    this.key = key;
    this.record = r;
    return data;
  }

  async unlockWithPassphrase(passphrase: string): Promise<unknown> {
    const w = (await this.wraps()).find((x) => x.kind === 'pass');
    if (!w) throw new Error('no passphrase set');
    return this.unwrap(w, await passKek(passphrase, fromBase64url(w.salt)));
  }

  async unlockWithPrf(prf: Uint8Array): Promise<unknown> {
    const w = (await this.wraps()).find((x) => x.kind === 'prf');
    if (!w) throw new Error('no passkey set');
    return this.unwrap(w, prfKek(prf));
  }

  /** Re-encrypt and store the wallet data (called after every change). */
  async save(data: unknown): Promise<void> {
    if (!this.key || !this.record) throw new Error('vault is locked');
    const body = await seal(this.key, utf8(JSON.stringify(data)));
    this.record = { ...this.record, ...body };
    await this.store.store(this.record);
  }

  async destroy(): Promise<void> {
    this.lock();
    this.record = undefined;
    await this.store.clear();
  }
}

/** IndexedDB store: database "blindbook", object store "vault", one record. */
export class IdbStore implements VaultStore {
  private db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('blindbook', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('vault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const r = f(db.transaction('vault', mode).objectStore('vault'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async load() {
    return (await this.tx('readonly', (s) => s.get('v1'))) as VaultRecord | undefined;
  }
  async store(r: VaultRecord) {
    await this.tx('readwrite', (s) => s.put(r, 'v1'));
  }
  async clear() {
    await this.tx('readwrite', (s) => s.delete('v1'));
  }
}

export class MemoryStore implements VaultStore {
  r?: VaultRecord;
  async load() {
    return this.r && structuredClone(this.r);
  }
  async store(r: VaultRecord) {
    this.r = structuredClone(r);
  }
  async clear() {
    this.r = undefined;
  }
}
