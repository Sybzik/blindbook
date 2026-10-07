// Passkey unlock (WebAuthn PRF): Face ID / Touch ID on phones. The PRF output is computed by the
// authenticator on the device and never leaves it; there is no server and no challenge from
// anyone. The passkey is only a local key-unwrapping device here, not a login.

import { base64url, fromBase64url, own, randomBytes } from '../core/bytes';

export function prfSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

/** Create a passkey and evaluate its PRF once. Returns null if the device has no PRF. */
export async function createPasskey(): Promise<{ credential: string; salt: Uint8Array; prf: Uint8Array } | null> {
  const salt = randomBytes(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Blindbook', id: location.hostname },
      // The same anonymous user on every device: nothing identifies anyone.
      user: { id: own(randomBytes(16)), name: 'nobody', displayName: 'nobody' },
      challenge: own(randomBytes(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 60_000,
      extensions: { prf: { eval: { first: own(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const ext = cred.getClientExtensionResults() as PrfResults;
  let first = ext.prf?.results?.first;
  const credential = base64url(new Uint8Array(cred.rawId));
  // Some platforms only enable PRF at creation and evaluate it on the first get().
  if (!first && ext.prf?.enabled) first = (await evaluate(credential, salt)) ?? undefined;
  if (!first) return null;
  return { credential, salt, prf: new Uint8Array(first) };
}

async function evaluate(credential: string, salt: Uint8Array): Promise<ArrayBuffer | null> {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: own(randomBytes(32)),
      allowCredentials: [{ type: 'public-key', id: own(fromBase64url(credential)) }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: own(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const ext = a?.getClientExtensionResults() as PrfResults | undefined;
  return ext?.prf?.results?.first ?? null;
}

/** Evaluate the PRF of an existing passkey (unlock). */
export async function unlockPasskey(credential: string, salt: string): Promise<Uint8Array | null> {
  const r = await evaluate(credential, fromBase64url(salt));
  return r ? new Uint8Array(r) : null;
}
