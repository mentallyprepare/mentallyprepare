function registerAuthRoutes(app, deps) {
  const {
    authLimiter,
    bcrypt,
    crypto,
    stmts
  } = deps;

  const resetTokens = new Map();

  app.post('/api/register', authLimiter, async (req, res) => {
    try {
      const { name, email, password, college, year, gender, matchGenderPref, matchYearPref, consentGiven } = req.body;
      if (!name || !name.trim() || !email || !email.trim() || !password || !college || !college.trim()) {
        return res.status(400).json({ error: 'All fields are required' });
      }
      if (!consentGiven) {
        return res.status(400).json({ error: 'You must accept the Privacy Policy to register' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
      }
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      const emailClean = email.toLowerCase().trim();
      const existing = stmts.getUserByEmail.get(emailClean);
      if (existing) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });

      const hash = await bcrypt.hash(password, 12);
      const now = new Date().toISOString();
      const result = stmts.insertUser.run(
        name.trim(), emailClean, hash, college.trim(), year || '3rd',
        gender || 'prefer_not_to_say', matchGenderPref || 'any', matchYearPref || 'any',
        1, now, now
      );

      req.session.userId = Number(result.lastInsertRowid);
      res.json({ ok: true });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.post('/api/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      req.session.userId = user.id;
      res.json({ ok: true });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.post('/api/forgot-password', authLimiter, (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
      if (!user) return res.json({ ok: true, message: 'If that email exists, a reset code has been generated.' });

      const token = crypto.randomBytes(32).toString('hex');
      resetTokens.set(token, { userId: user.id, expires: Date.now() + 15 * 60 * 1000 });
      console.log(`  ✉ Password reset token for ${user.email}: ${token}`);
      res.json({ ok: true, message: 'If that email exists, a reset link has been generated.' });
    } catch (e) {
      console.error('Forgot password error:', e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });

  app.post('/api/reset-password', authLimiter, async (req, res) => {
    try {
      const { code, newPassword } = req.body;
      const token = code;
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
