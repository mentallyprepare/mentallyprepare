const path = require('path');

function registerStaticRoutes(app, { baseUrl, rootDir }) {

  app.get('/privacy', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'privacy.html'));
  });

  app.get('/terms', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'terms.html'));
  });

  app.get('/safety', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'safety.html'));
  });

  // Rooms (anonymous topic walls) — only reachable when the feature is on.
  if (process.env.ROOMS_ENABLED === 'true') {
    app.get('/rooms', (req, res) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(rootDir, 'public', 'rooms.html'));
    });
    app.get('/admin-rooms', (req, res) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(rootDir, 'public', 'admin-rooms.html'));
    });
  }

  app.get('/waitlist', (req, res) => {
    res.redirect(301, '/');
  });

  app.get('/app', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'app.html'));
  });

  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'app.html'));
  });

  ['/signup', '/login', '/forgot', '/onboarding', '/scan', '/room'].forEach((route) => {
    app.get(route, (req, res) => {
      res.sendFile(path.join(rootDir, 'public', 'app.html'));
    });
  });

  app.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><priority>1.0</priority></url>
  <url><loc>${baseUrl}/safety</loc><priority>0.7</priority></url>
  <url><loc>${baseUrl}/privacy</loc><priority>0.5</priority></url>
  <url><loc>${baseUrl}/terms</loc><priority>0.5</priority></url>
</urlset>`);
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send([
      'User-agent: *',
      'Allow: /',
      'Disallow: /app',
      'Disallow: /app/',
      'Disallow: /admin',
      'Disallow: /admin/',
      'Disallow: /api/',
      'Disallow: /signup',
      'Disallow: /login',
      'Disallow: /forgot',
      'Disallow: /onboarding',
      'Disallow: /scan',
      'Disallow: /room',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`
    ].join('\n'));
  });
}

module.exports = {
  registerStaticRoutes
};
