/**
 * Minimal WebAuthn (passkey) verification for the staff check-in page.
 * ────────────────────────────────────────────────────────────────────
 *
 * This is what turns "someone tapped a button" into "the person enrolled on
 * THIS phone just passed its fingerprint / Face ID check". The private key
 * is created inside the phone's secure hardware and never leaves it; all we
 * ever hold is the public key, and every punch must carry a signature over a
 * challenge we issued seconds earlier.
 *
 * Written against the Workers runtime's WebCrypto only — no npm dependency,
 * matching the rest of the control plane. Supported algorithms cover every
 * platform authenticator in use: ES256 (Android, iPhone, Windows Hello),
 * RS256 (older Windows Hello) and EdDSA.
 *
 * Attestation is requested as 'none'. Synced passkeys (iCloud Keychain,
 * Google Password Manager) do not provide a verifiable attestation anyway,
 * and the thing we rely on is continuity — the same credential every day —
 * not the make of the phone.
 */

// ── encoding helpers ────────────────────────────────────────────────
export function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── CBOR (just the subset WebAuthn uses) ────────────────────────────
function cborDecode(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const initial = bytes[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let pos = offset + 1;

  const readLength = () => {
    if (info < 24) return info;
    if (info === 24) { const v = bytes[pos]; pos += 1; return v; }
    if (info === 25) { const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      const hi = view.getUint32(pos); const lo = view.getUint32(pos + 4); pos += 8;
      return hi * 2 ** 32 + lo;
    }
    throw new Error('cbor: indefinite lengths are not supported');
  };

  switch (major) {
    case 0: return [readLength(), pos];
    case 1: return [-1 - readLength(), pos];
    case 2: { const n = readLength(); return [bytes.slice(pos, pos + n), pos + n]; }
    case 3: {
      const n = readLength();
      return [new TextDecoder().decode(bytes.slice(pos, pos + n)), pos + n];
    }
    case 4: {
      const n = readLength(); const arr = [];
      for (let i = 0; i < n; i++) { const [v, p] = cborDecode(bytes, pos); arr.push(v); pos = p; }
      return [arr, pos];
    }
    case 5: {
      const n = readLength(); const map = new Map();
      for (let i = 0; i < n; i++) {
        const [k, p1] = cborDecode(bytes, pos);
        const [v, p2] = cborDecode(bytes, p1);
        map.set(k, v); pos = p2;
      }
      return [map, pos];
    }
    case 7:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22) return [null, pos];
      throw new Error('cbor: unsupported simple value');
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

// ── authenticator data ──────────────────────────────────────────────
const FLAG_UP = 0x01;   // user present (touched / looked at the phone)
const FLAG_UV = 0x04;   // user verified (biometric or device PIN)
const FLAG_AT = 0x40;   // attested credential data included

function parseAuthData(authData) {
  if (authData.length < 37) throw new Error('authData too short');
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const out = {
    rpIdHash: authData.slice(0, 32),
    flags: authData[32],
    signCount: view.getUint32(33),
  };
  if (out.flags & FLAG_AT) {
    let pos = 37 + 16;                            // skip AAGUID
    const idLen = view.getUint16(pos); pos += 2;
    out.credentialId = authData.slice(pos, pos + idLen); pos += idLen;
    const [coseKey] = cborDecode(authData, pos);
    out.coseKey = coseKey;
  }
  return out;
}

/** COSE_Key → { alg, jwk } that WebCrypto can import. */
function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    return {
      alg,
      jwk: { kty: 'EC', crv: 'P-256', x: bytesToB64url(cose.get(-2)), y: bytesToB64url(cose.get(-3)) },
    };
  }
  if (kty === 3 && alg === -257) {
    return {
      alg,
      jwk: { kty: 'RSA', n: bytesToB64url(cose.get(-1)), e: bytesToB64url(cose.get(-2)), alg: 'RS256' },
    };
  }
  if (kty === 1 && alg === -8) {
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytesToB64url(cose.get(-2)) } };
  }
  throw new Error(`unsupported passkey algorithm (kty ${kty}, alg ${alg})`);
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants raw r‖s. */
function derToRaw(der) {
  let pos = 2;
  if (der[1] & 0x80) pos += der[1] & 0x7f;       // long-form sequence length
  const readInt = () => {
    if (der[pos] !== 0x02) throw new Error('bad DER signature');
    const len = der[pos + 1];
    let int = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    const padded = new Uint8Array(32);
    padded.set(int, 32 - int.length);
    return padded;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0); raw.set(s, 32);
  return raw;
}

async function verifySignature(alg, jwk, signature, data) {
  if (alg === -7) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data);
  }
  if (alg === -257) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  if (alg === -8) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, signature, data);
  }
  return false;
}

/** Shared checks on clientDataJSON: right ceremony, our challenge, our page. */
function checkClientData(clientDataBytes, { type, challenge, origins }) {
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(clientDataBytes)); } catch { throw new Error('bad clientDataJSON'); }
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (cd.challenge !== challenge) throw new Error('challenge mismatch');
  if (!origins.includes(cd.origin)) throw new Error(`origin not allowed: ${cd.origin}`);
}

/**
 * Verify a navigator.credentials.create() result.
 * Returns { credentialId (b64url), alg, jwk, signCount }.
 */
export async function verifyRegistration(credential, { challenge, rpId, origins, requireUV }) {
  const clientData = b64urlToBytes(credential?.response?.clientDataJSON || '');
  checkClientData(clientData, { type: 'webauthn.create', challenge, origins });

  const [att] = cborDecode(b64urlToBytes(credential.response.attestationObject || ''));
  const auth = parseAuthData(att.get('authData'));

  if (!equalBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error('passkey was made for a different site');
  }
  if (!(auth.flags & FLAG_UP)) throw new Error('user was not present');
  if (requireUV && !(auth.flags & FLAG_UV)) throw new Error('phone did not verify the user');
  if (!auth.coseKey || !auth.credentialId) throw new Error('no credential in response');

  const { alg, jwk } = coseToJwk(auth.coseKey);
  return { credentialId: bytesToB64url(auth.credentialId), alg, jwk, signCount: auth.signCount };
}

/**
 * Verify a navigator.credentials.get() result against a stored passkey.
 * Returns { signCount, userVerified }.
 */
export async function verifyAssertion(assertion, stored, { challenge, rpId, origins, requireUV }) {
  const clientData = b64urlToBytes(assertion?.response?.clientDataJSON || '');
  checkClientData(clientData, { type: 'webauthn.get', challenge, origins });

  const authData = b64urlToBytes(assertion.response.authenticatorData || '');
  const auth = parseAuthData(authData);

  if (!equalBytes(auth.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error('passkey was made for a different site');
  }
  if (!(auth.flags & FLAG_UP)) throw new Error('user was not present');
  if (requireUV && !(auth.flags & FLAG_UV)) throw new Error('phone did not verify the user');

  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(await sha256(clientData), authData.length);

  const ok = await verifySignature(
    stored.alg, JSON.parse(stored.public_key),
    b64urlToBytes(assertion.response.signature || ''), signed,
  );
  if (!ok) throw new Error('signature did not verify');

  // A counter that goes backwards means two copies of the same key exist.
  // Synced passkeys (Apple, Google) always report 0, which is exempt.
  if (stored.sign_count > 0 && auth.signCount <= stored.sign_count) {
    throw new Error('passkey counter went backwards (possible cloned key)');
  }
  return { signCount: auth.signCount, userVerified: !!(auth.flags & FLAG_UV) };
}
