'use strict';

// Bearer-token auth for the native (mobile) client.
//
// Web stays on express-session cookies. React Native cannot ride browser
// cookies cleanly, so the mobile app authenticates with a signed bearer token
// sent as `Authorization: Bearer <token>`.
//
// Design notes:
// - Compact, JWT-shaped but dependency-free (Node crypto only): "v1.<payload>.<sig>".
// - HMAC-SHA256 signed. Payload is base64url JSON: { sub, typ, iat, exp }.
// - Stateless *signature*, but NOT blindly trusted: requireAuth still re-loads
//   the user every request and rejects deleted/suspended accounts. That gives us
//   revocation-on-delete and suspension enforcement for free (Section 31), and
//   means a stolen token stops working the moment the account is deleted.
// - Two token types: short-lived `access`, longer-lived `refresh`.

const crypto = require('crypto');

const VERSION = 'v1';
const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 30;   // 30 days
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

let cachedSecret = null;

// Resolve the signing secret. Prefer an explicit auth secret, fall back to the
// session secret so a single well-managed secret can cover both. In production
// one of these MUST be set; in dev we generate an ephemeral one and warn.
function resolveSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (fromEnv && String(fromEnv).length >= 16) {
    cachedSecret = String(fromEnv);
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    // Do not silently mint an ephemeral secret in prod — that would invalidate
    // every token on restart. Surface loudly; deployment must set the env var.
    console.error('[tokens] AUTH_TOKEN_SECRET/SESSION_SECRET missing in production. Bearer tokens are disabled.');
    return null;
  }
  cachedSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[tokens] No AUTH_TOKEN_SECRET/SESSION_SECRET set — using an ephemeral dev secret (tokens reset on restart).');
  return cachedSecret;
}

// Allow the host app to inject the already-resolved secret (e.g. the same value
// express-session uses) so web and mobile share one rotation surface.
function configure(secret) {
  if (secret && String(secret).length >= 16) cachedSecret = String(secret);
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function ttlForType(type) {
  return type === 'refresh' ? REFRESH_TTL_SECONDS : ACCESS_TTL_SECONDS;
}

// signToken({ sub, type }) -> "v1.<payload>.<sig>" or null if no secret.
function signToken({ sub, type = 'access', ttlSeconds } = {}) {
  const secret = resolveSecret();
  if (!secret) return null;
  if (!Number.isInteger(sub) && !(typeof sub === 'string' && sub)) {
    throw new TypeError('signToken requires a numeric or string `sub`');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (Number.isInteger(ttlSeconds) ? ttlSeconds : ttlForType(type));
  const payload = { sub, typ: type, iat: now, exp };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${VERSION}.${payloadB64}`;
  const sig = b64urlEncode(sign(signingInput, secret));
  return `${signingInput}.${sig}`;
}

// verifyToken(token, { type }) -> { valid, payload?, reason? }
function verifyToken(token, { type } = {}) {
  const secret = resolveSecret();
  if (!secret) return { valid: false, reason: 'no_secret' };
  if (typeof token !== 'string' || !token) return { valid: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [ver, payloadB64, sigB64] = parts;
  if (ver !== VERSION) return { valid: false, reason: 'version' };

  const signingInput = `${ver}.${payloadB64}`;
  const expectedSig = sign(signingInput, secret);
  let providedSig;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  // Length-guard before timingSafeEqual (it throws on mismatched lengths).
  if (providedSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad_payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, reason: 'expired' };
  }
  if (type && payload.typ !== type) {
    return { valid: false, reason: 'wrong_type' };
  }
  return { valid: true, payload };
}

// Convenience: issue the pair returned to a freshly authenticated client.
function issueTokenPair(userId) {
  const access = signToken({ sub: userId, type: 'access' });
  const refresh = signToken({ sub: userId, type: 'refresh' });
  if (!access || !refresh) return null;
  return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL_SECONDS };
}

// Pull a bearer token out of the Authorization header, if present.
function bearerFromRequest(req) {
  const raw = req && req.headers && req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = {
  configure,
  signToken,
  verifyToken,
  issueTokenPair,
  bearerFromRequest,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
};
