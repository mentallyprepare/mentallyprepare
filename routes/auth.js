const rateLimit = require('express-rate-limit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEARS = new Set(['1st', '2nd', '3rd', '4th', '5th', '5th+']);
const GENDERS = new Set(['female', 'male', 'non-binary', 'prefer_not_to_say']);
const MATCH_GENDERS = new Set(['any', 'female', 'male', 'non-binary', 'prefer_not_to_say']);
const MATCH_YEARS = new Set(['any', '1st', '2nd', '3rd', '4th', '5th', '5th+', 'nearby', '+-1_year', '±1_year']);
const CONSENT_POLICY_VERSION = '2026-05-24-18-plus';

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
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
  if (values.college.length < 3) errors.college = 'Please enter your college name.';
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
    trackEvent
  } = deps;
  const { sendEmail } = require('../lib/email');
  const BASE_URL = process.env.APP_BASE_URL || 'https://mymentallyprepare.com';

  const resetTokens = new Map();
  const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many signup attempts. Please try again later.' }, validate: { xForwardedForHeader: false } });
  const passwordResetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many password reset attempts. Please try again later.' }, validate: { xForwardedForHeader: false } });

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
        now
      );

      req.session.userId = Number(result.lastInsertRowid);
      trackEvent(req.session.userId, 'signup_completed');
      sendVerificationEmail({ sendEmail, to: values.email, name: values.name, token, baseUrl: BASE_URL })
        .catch((err) => {
          trackEvent(req.session.userId, 'email_send_failed', { type: 'verification' });
          console.error('Verification email failed:', err.message);
        });
      res.json({ ok: true, emailVerificationRequired: true, message: 'Account created. Please verify your email before starting the scan.' });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.get('/api/verify-email', async (req, res) => {
    try {
      const token = clean(req.query.token);
      if (!token || token.length < 32) return res.status(400).send('Invalid verification link.');
      const user = stmts.getUserByVerificationToken.get(token);
      if (!user) return res.status(400).send('This verification link is invalid or already used.');
      stmts.verifyUserEmail.run(new Date().toISOString(), user.id);
      if (req.session) req.session.userId = user.id;
      trackEvent(user.id, 'email_verified');
      res.redirect('/app?verified=1');
    } catch (e) {
      console.error('Verify email error:', e);
      res.status(500).send('Email verification failed.');
    }
  });

  app.post('/api/resend-verification', authLimiter, async (req, res) => {
    try {
      if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
      const user = stmts.getUserById.get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.email_verified) return res.json({ ok: true, verified: true });
      const lastSent = user.email_verification_sent_at ? new Date(user.email_verification_sent_at).getTime() : 0;
      if (Date.now() - lastSent < 60 * 1000) return res.status(429).json({ error: 'Please wait a minute before requesting another verification email.' });
      const token = crypto.randomBytes(32).toString('hex');
      const now = new Date().toISOString();
      stmts.updateVerificationToken.run(token, now, user.id);
      await sendVerificationEmail({ sendEmail, to: user.email, name: user.name, token, baseUrl: BASE_URL });
      res.json({ ok: true, message: 'Verification email sent.' });
    } catch (e) {
      console.error('Resend verification error:', e);
      res.status(500).json({ error: 'Could not send verification email right now.' });
    }
  });

  app.post('/api/login', authLimiter, async (req, res) => {
    try {
      const email = clean(req.body.email).toLowerCase();
      const password = String(req.body.password || '');
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const user = stmts.getUserByEmail.get(email);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      req.session.userId = user.id;
      const signupDate = new Date(user.created_at || Date.now());
      const reference = isNaN(signupDate.getTime()) ? Date.now() : signupDate.getTime();
      const dayNumber = Math.min(Math.max(Math.floor((Date.now() - reference) / (1000 * 60 * 60 * 24)) + 1, 1), 21);
      res.json({ ok: true, emailVerificationRequired: !user.email_verified });

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

  app.post('/api/forgot-password', passwordResetLimiter, (req, res) => {
    try {
      const email = clean(req.body.email).toLowerCase();
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const user = stmts.getUserByEmail.get(email);
      if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

      const token = crypto.randomBytes(32).toString('hex');
      resetTokens.set(token, { userId: user.id, expires: Date.now() + 15 * 60 * 1000 });
      const resetLink = `${BASE_URL.replace(/\/$/, '')}/app?screen=s-reset&code=${token}`;
      const emailHtml = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#333;">
          <h2>Password Reset</h2>
          <p>Someone requested a password reset for your Mentally Prepare account.</p>
          <p>If this was you, click the link below to reset your password. This link expires in 15 minutes.</p>
          <p><a href="${resetLink}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;">Reset Password</a></p>
          <p style="font-size:12px;color:#999;margin-top:40px;">If you didn't request this, you can safely ignore this email.</p>
        </div>`;

      sendEmail(user.email, 'reset your password', emailHtml).catch(e => console.error('Failed to send reset email:', e.message));
      res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
    } catch (e) {
      console.error('Forgot password error:', e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  app.post('/api/reset-password', passwordResetLimiter, async (req, res) => {
    try {
      const token = clean(req.body.code);
      const newPassword = String(req.body.newPassword || '');
      if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      const entry = resetTokens.get(token);
      if (!entry || entry.expires < Date.now()) {
        if (token) resetTokens.delete(token);
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      const user = stmts.getUserById.get(entry.userId);
      if (!user) return res.status(400).json({ error: 'User not found' });

      const hash = await bcrypt.hash(newPassword, 12);
      stmts.updateUserPassword.run(hash, user.id);
      resetTokens.delete(token);
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
