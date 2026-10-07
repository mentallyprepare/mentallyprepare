const rateLimit = require('express-rate-limit');
const nodeCrypto = require('crypto');
const tokens = require('../lib/tokens');

// Native clients authenticate with bearer tokens. Attached to every successful
// auth response as `auth: { accessToken, refreshToken, expiresIn }`. The web
// client ignores the field and keeps using its cookie session.
function authTokens(userId) {
  const pair = tokens.issueTokenPair(userId);
  return pair ? { auth: pair } : {};
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEARS = new Set(['1st', '2nd', '3rd', '4th', '5th', '5th+']);
const GENDERS = new Set(['female', 'male', 'non-binary', 'prefer_not_to_say']);
const MATCH_GENDERS = new Set(['any', 'female', 'male', 'non-binary', 'prefer_not_to_say']);
const MATCH_YEARS = new Set(['any', '1st', '2nd', '3rd', '4th', '5th', '5th+', 'nearby', '+-1_year', '±1_year']);
const CONSENT_POLICY_VERSION = '2026-05-24-18-plus';
const GOOGLE_PROVIDER = 'google';
const RESET_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MANUAL_VERIFY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvM+5OnGHYVe0IVh8ymyv
9wh5luIsO/MGmK9NmTUZLxhejmcxv/6fltPnnprt16Y0RbSRpKMa2StUzOrulcT/
c8Wpp4QjYgLyKIGksSWFf71rXE70Bu9nTusZboQy5bXj3eFlcRPaPgss0N5Yaw04
yb9GRP6ARuzmhPeG4IzSNkJQQkcGwP2eecEsFByJ9VVg/8bBvMtGJAv5fvuOC3qO
raiHJlZehBrpEhx4AbsPVKz/cKcOSuiOa/1rghb3XN/Qjhs+HLZjI8LhwhJ83tNk
lvLFite2dmPCOECNPgxYyaKEOXL64JGsKvu/x0pE6Fv6xiR8qqsWM8bTr4tI9eey
fwIDAQAB
-----END PUBLIC KEY-----`;

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function sanitizeTimezone(tz) {
  const s = String(tz || '').trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z_]+\/[A-Za-z_0-9+/-]+$/.test(s)) return null;
  return s;
}

function deriveRegion(timezone) {
  const tz = sanitizeTimezone(timezone);
  if (!tz) return 'IN';
  if (tz.startsWith('America/')) return 'AMERICAS';
  if (tz.startsWith('Europe/')) return 'EUROPE';
  return 'IN';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMatchYear(value) {
  const raw = clean(value);
  if (raw === '±1_year' || raw === '+-1_year') return 'nearby';
  return raw || '';
}

function isValidCollegeName(value) {
  const raw = clean(value);
  if (raw.length >= 3) return true;
  return /^d\.?u\.?$/i.test(raw);
}

function validateRegistration(body) {
  const values = {
    name: clean(body.name),
    college: clean(body.college),
    email: clean(body.email).toLowerCase(),
    password: String(body.password || ''),
    year: clean(body.year),
    gender: clean(body.gender).toLowerCase(),
    matchGenderPref: clean(body.matchGenderPref).toLowerCase(),
    matchYearPref: normalizeMatchYear(body.matchYearPref),
    consentGiven: body.consentGiven === true,
    ageConfirmed: body.ageConfirmed === true
  };

  const errors = {};
  if (values.name.length < 2) errors.name = 'Name must be at least 2 characters.';
  if (!isValidCollegeName(values.college)) errors.college = 'Please enter your college name.';
  if (!values.year || !YEARS.has(values.year)) errors.year = 'Please choose your year.';
  if (!values.email) errors.email = 'Please enter your email.';
  else if (!EMAIL_RE.test(values.email)) errors.email = 'Please enter a valid email.';
  if (values.password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (!values.gender || !GENDERS.has(values.gender)) errors.gender = 'Please choose your gender.';
  if (!values.matchGenderPref || !MATCH_GENDERS.has(values.matchGenderPref)) errors.matchGenderPref = 'Please choose who you feel comfortable matching with.';
  if (!values.matchYearPref || !MATCH_YEARS.has(values.matchYearPref)) errors.matchYearPref = 'Please choose your partner year preference.';
  if (!values.ageConfirmed) errors.ageConfirmed = 'You must confirm you are 18 or older to use Mentally Prepare.';
  if (!values.consentGiven) errors.consentGiven = 'Please accept the consent before continuing.';

  return { values, errors };
}

function firstError(errors) {
  return Object.values(errors)[0] || 'Please check the highlighted fields.';
}

function safeGoogleProfile(value) {
  return clean(value).slice(0, 180);
}

function googlePlaceholderPassword({ uid, email, crypto }) {
  return `firebase:${uid}:${crypto.createHash('sha256').update(email || uid).digest('hex')}`;
}

function withEmailTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 15000))
  ]);
}

function logVerification(message, details) {
  if (details) console.log(message, details);
  else console.log(message);
}

function generateResetCode(crypto) {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += RESET_CODE_ALPHABET[crypto.randomInt(0, RESET_CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeResetCode(value) {
  const compact = String(value || '').trim().replace(/\s+/g, '');
  return compact.length === 6 ? compact.toUpperCase() : compact;
}

function hashResetToken(token) {
  return nodeCrypto.createHash('sha256').update(token).digest('hex');
}

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') {
      if (req.session) req.session.userId = userId;
      return resolve();
    }
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error('Session regenerate failed:', regenErr);
        return reject(regenErr);
      }
      req.session.userId = userId;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save after regenerate failed:', saveErr);
          return reject(saveErr);
        }
        resolve();
      });
    });
  });
}

function authDebugLog(message, details) {
  if (process.env.AUTH_DEBUG_LOGS !== 'true') return;
  if (details) console.log(message, details);
  else console.log(message);
}

function verifyManualSignature(email, expires, signature) {
  const expiresMs = Number(expires);
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) return false;
  const verifier = nodeCrypto.createVerify('RSA-SHA256');
  verifier.update(`${email}.${expiresMs}`);
  verifier.end();
  return verifier.verify(MANUAL_VERIFY_PUBLIC_KEY, Buffer.from(String(signature || ''), 'base64url'));
}

function sendVerificationEmail({ sendEmail, to, name, token, baseUrl }) {
  const verifyUrl = `${baseUrl.replace(/\/$/, '')}/api/verify-email?token=${encodeURIComponent(token)}`;
  const firstName = escapeHtml(clean(name).split(' ')[0] || 'there');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#241b2f;line-height:1.6">
      <h2>Verify your Mentally Prepare email</h2>
      <p>Hi ${firstName},</p>
      <p>Before your emotional scan and anonymous matching can start, please verify this email address.</p>
      <p><a href="${verifyUrl}" style="display:inline-block;background:#7b5ea7;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Verify email</a></p>
      <p style="font-size:12px;color:#666">This app is not therapy, counselling, or emergency support. If you feel unsafe, contact emergency services or a trusted person immediately.</p>
    </div>`;
  return sendEmail(to, 'verify your Mentally Prepare email', html);
}

function registerAuthRoutes(app, deps) {
  const {
    authLimiter,
    bcrypt,
    crypto,
    stmts,
    sendLoginWelcome,
    normalizeCollegeName,
    trackEvent,
    verifyFirebaseIdToken,
    getFirebaseWebConfig
  } = deps;
  const { sendEmail } = require('../lib/email');
  const BASE_URL = process.env.APP_BASE_URL || 'https://mymentallyprepare.com';

  const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many signup attempts. Please try again later.' }, validate: { xForwardedForHeader: false } });
  const passwordResetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many password reset attempts. Please try again later.' }, validate: { xForwardedForHeader: false } });

  app.get('/api/firebase-config', (req, res) => {
    const payload = getFirebaseWebConfig ? getFirebaseWebConfig(req) : { enabled: false, config: {} };
    if (!payload.enabled) return res.json({ enabled: false });
    res.json({ enabled: true, config: payload.config });
  });

  async function requireFirebaseIdToken(req, res, next) {
    try {
      if (!verifyFirebaseIdToken) return res.status(503).json({ error: 'Google login is not configured yet.' });
      const idToken = clean(req.body && req.body.idToken);
      if (!idToken) return res.status(400).json({ error: 'Google sign in failed. Please try again.' });
      if (idToken.split('.').length !== 3) {
        console.warn('Firebase token verification failed: non-JWT token received', {
          length: idToken.length,
          preview: idToken.slice(0, 18)
        });
        return res.status(400).json({ error: 'Google login did not return a valid Firebase token. Please try again.' });
      }
      const decoded = await verifyFirebaseIdToken(idToken);
      authDebugLog('Firebase user found', {
        uid: decoded.uid,
        email: decoded.email
      });
      req.firebaseUser = decoded;
      next();
    } catch (e) {
      console.warn('Firebase token verification failed:', e.message || e);
      res.status(401).json({ error: 'Google login failed. Please try again.' });
    }
  }

  app.post('/api/auth/firebase/google', authLimiter, requireFirebaseIdToken, async (req, res) => {
    try {
      const decoded = req.firebaseUser;
      const firebaseUid = clean(decoded.uid);
      const email = clean(decoded.email).toLowerCase();
      if (!firebaseUid || !email || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Google account did not provide a valid email.' });
      }
      if (decoded.email_verified === false) {
        return res.status(403).json({ error: 'Google account email is not verified.' });
      }

      const displayName = safeGoogleProfile(decoded.name || req.body.displayName || email.split('@')[0]);
      const photoUrl = safeGoogleProfile(decoded.picture || req.body.photoURL || '');
      const now = new Date().toISOString();
      let user = stmts.getUserByFirebaseUid.get(firebaseUid) || stmts.getUserByEmail.get(email);
      let created = false;

      if (user) {
        stmts.updateFirebaseUserLogin.run(firebaseUid, photoUrl || null, now, now, now, user.id);
        authDebugLog('Backend user created/updated', {
          action: 'updated',
          userId: user.id,
          email,
          provider: GOOGLE_PROVIDER
        });
      } else {
        const college = safeGoogleProfile(req.body.college) || 'Not provided';
        const year = YEARS.has(clean(req.body.year)) ? clean(req.body.year) : '3rd';
        const passwordHash = await bcrypt.hash(googlePlaceholderPassword({ uid: firebaseUid, email, crypto }), 12);
        const timezone = sanitizeTimezone((req.body && req.body.timezone) || req.headers['x-timezone']);
        const region = deriveRegion(timezone);
        const result = stmts.insertFirebaseUser.run(
          displayName || 'Google user',
          email,
          passwordHash,
          college,
          normalizeCollegeName(college),
          year,
          'prefer_not_to_say',
          'any',
          'any',
          1,
          now,
          1,
          CONSENT_POLICY_VERSION,
          1,
          now,
          now,
          firebaseUid,
          photoUrl || null,
          GOOGLE_PROVIDER,
          now,
          region,
          timezone
        );
        user = stmts.getUserById.get(Number(result.lastInsertRowid));
        created = true;
        trackEvent(user.id, 'signup_completed', { provider: GOOGLE_PROVIDER });
        trackEvent(user.id, 'signup', { provider: GOOGLE_PROVIDER });
        authDebugLog('Backend user created/updated', {
          action: 'created',
          userId: user.id,
          email,
          provider: GOOGLE_PROVIDER
        });
      }

      await establishSession(req, user.id);
      trackEvent(user.id, 'login', { provider: GOOGLE_PROVIDER, created });
      authDebugLog('Backend login success', {
        userId: user.id,
        email,
        provider: GOOGLE_PROVIDER
      });
      res.json({ ok: true, created, userId: user.id, ...authTokens(user.id) });
    } catch (e) {
      console.error('Firebase Google login error:', e);
      res.status(401).json({ error: 'Google login failed. Please try again.' });
    }
  });

  app.post('/api/register', signupLimiter, async (req, res) => {
    try {
      trackEvent(null, 'signup_started');
      const { values, errors } = validateRegistration(req.body || {});
      if (Object.keys(errors).length) {
        trackEvent(null, 'signup_error', { fields: Object.keys(errors) });
        return res.status(400).json({ error: firstError(errors), errors });
      }

      const existing = stmts.getUserByEmail.get(values.email);
      if (existing) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.', errors: { email: 'An account with this email already exists. Try logging in.' } });

      const hash = await bcrypt.hash(values.password, 12);
      const now = new Date().toISOString();
      const token = crypto.randomBytes(32).toString('hex');
      const timezone = sanitizeTimezone((req.body && req.body.timezone) || req.headers['x-timezone']);
      const region = deriveRegion(timezone);
      logVerification('Verification token created', { email: values.email });
      const result = stmts.insertUser.run(
        values.name,
        values.email,
        hash,
        values.college,
        normalizeCollegeName(values.college),
        values.year,
        values.gender,
        values.matchGenderPref,
        values.matchYearPref,
        1,
        now,
        1,
        CONSENT_POLICY_VERSION,
        0,
        token,
        now,
        now,
        region,
        timezone
      );

      const newUserId = Number(result.lastInsertRowid);
      await establishSession(req, newUserId);
      trackEvent(newUserId, 'signup_completed');
      trackEvent(newUserId, 'signup');
      try {
        logVerification('Email service ready', { provider: 'configured email service' });
        await withEmailTimeout(
          sendVerificationEmail({ sendEmail, to: values.email, name: values.name, token, baseUrl: BASE_URL }),
          'Verification email'
        );
        logVerification('Verification email sent', { email: values.email });
      } catch (err) {
        trackEvent(newUserId, 'email_send_failed', { type: 'verification' });
        console.error('Verification failed with reason', { reason: 'email_send_failed', email: values.email, error: err.message });
        return res.json({
          ok: true,
          emailVerificationRequired: true,
          emailDeliveryFailed: true,
          message: 'We could not send the email. Please try again. You can continue while verification is pending.',
          ...authTokens(newUserId)
        });
      }
      res.json({ ok: true, emailVerificationRequired: true, message: 'Account created. Please verify your email when it arrives. You can continue now.', ...authTokens(newUserId) });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.get('/api/verify-email', async (req, res) => {
    try {
      const token = clean(req.query.token);
      if (!token || token.length < 32) {
        logVerification('Verification failed with reason', { reason: 'invalid_token_format' });
        return res.redirect('/app?verify_error=invalid');
      }
      const user = stmts.getUserByVerificationToken.get(token);
      if (!user) {
        logVerification('Verification failed with reason', { reason: 'token_not_found' });
        return res.redirect('/app?verify_error=invalid');
      }
      if (user.email_verified) {
        logVerification('Verification already completed', { email: user.email });
        return res.redirect('/app?screen=s-login&verified=1');
      }
      const sentAt = user.email_verification_sent_at ? new Date(user.email_verification_sent_at).getTime() : 0;
      if (!sentAt || Date.now() - sentAt > 24 * 60 * 60 * 1000) {
        logVerification('Verification failed with reason', { reason: 'expired_token', email: user.email });
        return res.redirect('/app?verify_error=expired');
      }
      stmts.verifyUserEmail.run(new Date().toISOString(), user.id);
      if (req.session) { try { await establishSession(req, user.id); } catch(e) {} }
      trackEvent(user.id, 'email_verified');
      logVerification('Verification successful', { email: user.email });
      res.redirect('/app?verified=1');
    } catch (e) {
      console.error('Verification failed with reason', { reason: 'system_error', error: e.message });
      res.redirect('/app?verify_error=system');
    }
  });

  app.get('/api/manual-verify-email', async (req, res) => {
    try {
      const email = clean(req.query.email).toLowerCase();
      const expires = clean(req.query.expires);
      const signature = clean(req.query.sig);
      if (!email || !EMAIL_RE.test(email) || !signature || !verifyManualSignature(email, expires, signature)) {
        return res.status(400).send('This manual verification link is invalid or expired.');
      }

      const user = stmts.getUserByEmail.get(email);
      if (!user) return res.status(404).send('User not found.');
      if (!user.email_verified) {
        stmts.verifyUserEmail.run(new Date().toISOString(), user.id);
        trackEvent(user.id, 'email_verified', { method: 'manual_signed_link' });
        logVerification('Verification successful', { email: user.email, method: 'manual_signed_link' });
      }
      if (req.session) await establishSession(req, user.id);
      res.redirect('/app?verified=1');
    } catch (e) {
      console.error('Manual verify email error:', e);
      res.status(500).send('Email verification failed.');
    }
  });

  app.post('/api/resend-verification', authLimiter, async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
      const user = stmts.getUserById.get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.email_verified) return res.json({ ok: true, verified: true });
      logVerification('Resend verification triggered', { email: user.email });
      const lastSent = user.email_verification_sent_at ? new Date(user.email_verification_sent_at).getTime() : 0;
      if (Date.now() - lastSent < 60 * 1000) return res.status(429).json({ error: 'Please wait a minute before requesting another verification email.' });
      const token = crypto.randomBytes(32).toString('hex');
      logVerification('Verification token created', { email: user.email });
      const now = new Date().toISOString();
      stmts.updateVerificationToken.run(token, now, user.id);
      logVerification('Email service ready', { provider: 'configured email service' });
      await withEmailTimeout(
        sendVerificationEmail({ sendEmail, to: user.email, name: user.name, token, baseUrl: BASE_URL }),
        'Verification email'
      );
      logVerification('Verification email sent', { email: user.email });
      res.json({ ok: true, message: 'Verification email sent.' });
    } catch (e) {
      console.error('Verification failed with reason', { reason: 'resend_email_failed', error: e.message });
      res.status(500).json({ error: 'We could not send the email. Please try again.' });
    }
  });

  app.post('/api/login', authLimiter, async (req, res) => {
    try {
      const email = clean(req.body.email).toLowerCase();
      const password = String(req.body.password || '');
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const user = stmts.getUserByEmail.get(email);
      if (!user || user.account_status === 'deleted' || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      await establishSession(req, user.id);
      const signupDate = new Date(user.created_at || Date.now());
      const reference = isNaN(signupDate.getTime()) ? Date.now() : signupDate.getTime();
      const dayNumber = Math.min(Math.max(Math.floor((Date.now() - reference) / (1000 * 60 * 60 * 24)) + 1, 1), 21);
      res.json({ ok: true, emailVerificationRequired: !user.email_verified, ...authTokens(user.id) });

      const lastSent = user.login_email_sent_at ? new Date(user.login_email_sent_at).getTime() : 0;
      if (user.email_verified && Date.now() - lastSent > 24 * 60 * 60 * 1000 && sendLoginWelcome) {
        sendLoginWelcome(user.email, user.name, dayNumber)
          .then(() => stmts.updateLoginEmailTime.run(new Date().toISOString(), user.id))
          .catch(err => console.error('Login email failed:', err.message));
      }
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // Native clients swap a refresh token for a fresh pair. Access tokens are
  // deliberately short-lived relative to refresh, so a leaked access token
  // ages out on its own.
  app.post('/api/auth/token/refresh', authLimiter, (req, res) => {
    const provided = (req.body && req.body.refreshToken) || tokens.bearerFromRequest(req);
    const result = tokens.verifyToken(provided, { type: 'refresh' });
    if (!result.valid) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    // Same rule as requireAuth: re-check the account every time, so deletion
    // and suspension revoke immediately rather than at token expiry.
    const user = stmts.getUserById.get(result.payload.sub);
    if (!user || user.account_status === 'deleted') {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const pair = tokens.issueTokenPair(user.id);
    if (!pair) return res.status(503).json({ error: 'Token signing unavailable' });
    res.json({ ok: true, auth: pair });
  });

  app.post('/api/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
      const email = clean(req.body.email).toLowerCase();
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const user = stmts.getUserByEmail.get(email);
      if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

      stmts.deleteExpiredPasswordResetTokens.run(Date.now());
      let plainToken = generateResetCode(crypto);
      let hashed = hashResetToken(plainToken);
      for (let attempt = 0; stmts.getPasswordResetToken.get(hashed) && attempt < 8; attempt += 1) {
        plainToken = generateResetCode(crypto);
        hashed = hashResetToken(plainToken);
      }
      stmts.insertPasswordResetToken.run(hashed, user.id, Date.now() + 15 * 60 * 1000, Date.now());
      const resetLink = `${BASE_URL.replace(/\/$/, '')}/app?screen=s-reset&code=${plainToken}`;
      const emailHtml = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#333;">
          <h2>Password Reset</h2>
          <p>Someone requested a password reset for your Mentally Prepare account.</p>
          <p>If this was you, use this reset code: <strong style="font-size:20px;letter-spacing:4px;">${plainToken}</strong></p>
          <p>You can also click the link below to reset your password. This link expires in 15 minutes.</p>
          <p><a href="${resetLink}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Reset Password</a></p>
          <p style="font-size:12px;color:#999;margin-top:40px;">If you didn't request this, you can safely ignore this email.</p>
        </div>`;

      try {
        await sendEmail(user.email, 'reset your password', emailHtml);
      } catch (e) {
        console.error('Failed to send reset email:', e.message);
      }
      res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
    } catch (e) {
      console.error('Forgot password error:', e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  app.post('/api/reset-password', passwordResetLimiter, async (req, res) => {
    try {
      const token = normalizeResetCode(req.body.code);
      const newPassword = String(req.body.newPassword || '');
      if (!token || !newPassword) return res.status(400).json({ error: 'Reset code and new password are required.' });
      if (!/^(?:[A-Z0-9]{6}|[A-F0-9]{64})$/i.test(token)) return res.status(400).json({ error: 'Invalid reset code. Check the code or request a new one.' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const isLegacy64Hex = /^[A-F0-9]{64}$/i.test(token);
      const lookupKey = isLegacy64Hex ? token : hashResetToken(token);
      const entry = stmts.getPasswordResetToken.get(lookupKey);
      if (!entry) {
        return res.status(400).json({ error: 'Invalid reset code. Check the code or request a new one.' });
      }
      if (entry.used_at) return res.status(400).json({ error: 'Reset code has already been used. Please request a new one.' });
      if (entry.expires_at <= Date.now()) return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });

      const user = stmts.getUserById.get(entry.user_id);
      if (!user) return res.status(400).json({ error: 'User not found' });

      const hash = await bcrypt.hash(newPassword, 12);
      stmts.updateUserPassword.run(hash, user.id);
      stmts.markPasswordResetTokenUsed.run(Date.now(), lookupKey);
      res.json({ ok: true });
    } catch (e) {
      console.error('Reset password error:', e);
      res.status(500).json({ error: 'Password reset failed' });
    }
  });
}

module.exports = {
  registerAuthRoutes
};
