const path = require('path');
const fs = require('fs');
const { BLOG_POSTS, BLOG_SLUGS } = require('../lib/blog-posts');

const appMeta = {
  's-signup': ['Create an Account | Mentally Prepare', 'Create your Mentally Prepare account and begin a private 21-day journey of anonymous journaling, honest reflection, and meaningful connection.', 'Create an account to begin your 21-night journey'],
  's-login': ['Sign In | Mentally Prepare', 'Log in to Mentally Prepare to enter your private room, continue your 21-day journaling journey, and reconnect with your anonymous partner.', 'Sign in to continue your 21-night journaling journey'],
  default: ['21 Nights of Anonymous Journaling | Mentally Prepare', 'Feel seen without performing. Begin a private 21-day emotional reset through guided reflection and anonymous journaling with a matched partner.', 'Start your 21 nights of anonymous journaling.']
};

function sendAppPage(req, res, rootDir) {
  const [title, description, heading] = appMeta[req.query.screen] || appMeta.default;
  const html = fs.readFileSync(path.join(rootDir, 'public', 'app.html'), 'utf8')
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\/>/, `<meta name="description" content="${description}"/>`)
    .replace(/<h1 class="hero-h1">[^<]*<\/h1>/, `<h1 class="hero-h1">${heading}</h1>`);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(html);
}

function registerStaticRoutes(app, { baseUrl, rootDir, requireAdmin }) {

  app.get('/about', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'about.html'));
  });

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

  app.get('/blog', (req, res) => {
    res.sendFile(path.join(rootDir, 'content', 'blog', 'index.html'));
  });

  app.get('/blog/:slug', (req, res, next) => {
    if (!BLOG_SLUGS.has(req.params.slug)) return next();
    res.sendFile(path.join(rootDir, 'content', 'blog', `${req.params.slug}.html`));
  });

  app.get('/waitlist', (req, res) => {
    res.redirect(301, '/');
  });

  app.get('/app', (req, res) => {
    sendAppPage(req, res, rootDir);
  });

  app.get('/app/*', (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(rootDir, 'public', 'app.html'));
  });

  ['/signup', '/login', '/forgot', '/onboarding', '/scan', '/room'].forEach((route) => {
    app.get(route, (req, res) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(rootDir, 'public', 'app.html'));
    });
  });

  app.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    const blogUrls = BLOG_POSTS
      .map((post) => `  <url><loc>${baseUrl}/blog/${post.slug}</loc><lastmod>${post.updated}</lastmod><priority>0.7</priority></url>`)
      .join('\n');
    const blogLastmod = BLOG_POSTS.length ? `<lastmod>${BLOG_POSTS[0].updated}</lastmod>` : '';
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><priority>1.0</priority></url>
  <url><loc>${baseUrl}/about</loc><priority>0.8</priority></url>
  <url><loc>${baseUrl}/blog</loc>${blogLastmod}<priority>0.8</priority></url>
${blogUrls}
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
      // Private app routes remain crawlable so search engines can read their noindex response.
      'Disallow: /admin',
      'Disallow: /admin/',
      'Disallow: /api/',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
      `Sitemap: ${baseUrl}/blog/sitemap.xml`
    ].join('\n'));
  });
}

module.exports = {
  registerStaticRoutes
};
