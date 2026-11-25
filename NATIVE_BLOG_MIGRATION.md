# Native journal migration

The public custom-domain `/blog` currently comes from Rankbench, while the Railway application serves five older native articles. This change serves a single journal from the application: the five existing guides and fourteen revised imported articles. All nineteen article paths and `/blog/author/anushka` remain available.

## Content and design

- The hub, articles, author profile, topic filters, search, related reading, RSS and blog sitemap share a dark rose/purple design with the site's own Instrument Serif and Manrope fonts.
- Imported article text is in `content/blog/imported-posts.json`. Publication dates are retained; the editorial revision date is 24 November 2026. Original native article bodies remain in their existing HTML files.
- The imported copy removes promises about rewiring anxiety, resetting the brain, guaranteed recovery and fixed habit timelines. It keeps practical questions, student examples and appropriate source links. Original illustrative quotations are explicitly identified as original writing.
- Images and fonts are served by the application. Rendering never calls Rankbench. Search input is escaped; search/filter views are excluded from indexing. Analytics keeps its existing consent requirements, and search terms are not added to analytics URLs.
- The main sitemap and `/blog/sitemap.xml` include all articles and the author page. Old page-two listings redirect to the complete journal listing. Unknown articles and authors continue to return 404.

## Source archive and maintenance

`content/blog/archive/rankbench-2026-11-24.json.gz` is a lossless compressed copy of the public export captured on 24 November. It contains the original titles, descriptions, author names, publication timestamps, URLs and HTML. It is an editorial source archive, not published article copy. Original remote image references remain in that archive; the new pages use existing local assets instead.

To inspect the archive with Node:

```js
const fs = require('node:fs');
const zlib = require('node:zlib');
const originalPosts = JSON.parse(zlib.gunzipSync(
  fs.readFileSync('content/blog/archive/rankbench-2026-11-24.json.gz')
));
```

The one-time editorial build script is `scripts/prepare-native-blog.py`. It regenerates imported copy from the archived publication metadata and the reviewed text in that script. Edit the script as well as the JSON if it will be regenerated. New native posts need no publishing service: add an entry to the imported JSON with a unique slug, dates, category, text and source links. Use one of its existing categories (`Journaling`, `Connection`, `Digital life`) to select a local illustration. For legacy HTML articles, register metadata in `lib/blog-posts.js`.

## Release and routing

1. Deploy the reviewed application commit through the existing Railway deployment process. No database migration or account change is needed.
2. Verify the Railway hostname serves the new `/blog`, an imported article, an original guide, the author page, both sitemaps and the RSS feed. Check `/app`, signup and homepage remain reachable.
3. Identify the custom-domain rule that currently forwards `/blog` to Rankbench. The custom domain and Railway hostname currently return different blog pages. Remove or retarget only that blog-specific forwarding rule after the origin checks pass; preserve unrelated Cloudflare routes, DNS and security settings.
4. Purge cached blog HTML and the two sitemap responses after cutover. Confirm the public custom domain now returns the native journal and all fourteen imported URLs. The new stylesheet and blog analytics script have fresh versioned URLs.
5. Keep the Rankbench project and original route configuration available until public checks pass. Confirm no requests go to Rankbench and that consent, topic links, search and the app invitation work on mobile.

Do not describe the migration as live based only on repository, local, or Railway-origin success. The custom-domain forwarding change is a separate release step. Roll back by restoring the recorded blog-specific forwarding rule or redeploying the previous application commit; keep the source archive.

## Validation

```sh
npm run check:syntax
node test/native-blog.test.js
node test/public-analytics.test.js
npm test
npm run smoke:api
```

The native blog integration check compares the archive's fourteen exact article paths against the new registry, then checks all nineteen routes, metadata, structured data, local images, feed, sitemaps, contents links, escaping, search indexing and legacy pagination. Browser review should include the hub, imported and original articles, and author page at desktop and narrow phone widths. Development review uses `?mp_test=1` to exclude test visits from analytics.
