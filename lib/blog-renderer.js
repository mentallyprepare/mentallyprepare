'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BLOG_POSTS } = require('./blog-posts');
const TOPICS = ['Journaling', 'Connection', 'College life', 'Digital life'];
const SITE = 'https://mymentallyprepare.com';
const DESCRIPTION = 'Practical guides to journaling, friendship and college life. Find writing prompts, ways to meet people and advice for settling in. Read something useful today.';
const ASSET_VERSION = '20261125-stock-editorial';

function escape(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function jsonLd(value) { return JSON.stringify(value, null, 2).replace(/</g, '\\u003c'); }
function date(value) { return new Date(value + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function minutes(post) {
  const words = [post.lead || post.description, ...(post.sections || []).flatMap(section => [section.title, ...section.paragraphs]), ...(post.prompts || [])].join(' ').split(/\s+/).length;
  return post.sections ? Math.max(3, Math.ceil(words / 200)) : 6;
}
function headingId(text) { return text.toLowerCase().replace(/&#?[^;]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function postImage(post, { priority = false, decorative = false } = {}) {
  return `<img src="${escape(post.image)}" alt="${decorative ? '' : escape(post.imageAlt)}" width="${post.imageWidth}" height="${post.imageHeight}" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"/>`;
}
function nav() {
  return `<a class="skip-link" href="#main">Skip to content</a>
  <header class="journal-nav">
    <a class="brand" href="/" aria-label="Mentally Prepare home"><img src="/favicon.svg" width="32" height="32" alt=""/><span>mentally prepare</span></a>
    <nav aria-label="Main navigation"><a href="/">Home</a><a href="/blog" aria-current="page">Blog</a><a href="/about">About</a><a class="button button-small" href="/app" data-mp-cta="journal-nav">Try Mentally Prepare</a></nav>
  </header>`;
}
function footer() {
  return `<footer class="journal-footer"><div><a class="footer-wordmark" href="/">mentally prepare</a><p>A private writing exchange for adults 18+.</p></div>
  <nav aria-label="Footer"><a href="/blog">Blog</a><a href="/blog/author/anushka">About Anushka</a><a href="/safety">Safety</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/blog/feed.xml">RSS</a></nav>
  <div class="footer-bottom"><p>Journaling and peer connection. Not a substitute for professional care.</p><a href="https://www.pexels.com/license/" rel="noopener noreferrer">Stock photography from Pexels</a></div></footer>`;
}
function shell({ title, description = DESCRIPTION, canonical = '/blog', body, schema, noindex = false, image = '/images/blog/stock/writing-at-desk.webp', article = false }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>${escape(title)}</title><meta name="description" content="${escape(description)}"/><meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}"/>
  <link rel="canonical" href="${SITE}${canonical}"/><meta name="theme-color" content="#faf8f5"/>
  <meta property="og:type" content="${article ? 'article' : 'website'}"/><meta property="og:site_name" content="Mentally Prepare"/><meta property="og:title" content="${escape(title)}"/><meta property="og:description" content="${escape(description)}"/><meta property="og:url" content="${SITE}${canonical}"/><meta property="og:image" content="${SITE}${image}"/><meta name="twitter:card" content="summary_large_image"/>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
  <link rel="preload" href="/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin/>
  <link rel="alternate" type="application/rss+xml" title="The Mentally Prepare Blog" href="/blog/feed.xml"/>
  <link rel="stylesheet" href="/journal.css?v=${ASSET_VERSION}"/><script defer src="/public-analytics.js?v=20261125-native-journal"></script>
  <script type="application/ld+json">${jsonLd(schema)}</script></head><body>${nav()}${body}${footer()}<script defer src="/prompt-list.js?v=20261127-prompt-list"></script></body></html>`;
}
function card(post) {
  return `<article class="story-card"><a class="story-image" href="/blog/${post.slug}" tabindex="-1" aria-hidden="true">${postImage(post, { decorative: true })}</a>
  <div class="story-meta"><span>${escape(post.category)}</span><span>${minutes(post)} min read</span></div>
  <h3><a href="/blog/${post.slug}">${escape(post.title)}</a></h3><p>${escape(post.summary || post.description)}</p>
  <a class="text-link" href="/blog/${post.slug}" aria-label="Read ${escape(post.title)}">Read article <span aria-hidden="true">&rarr;</span></a></article>`;
}
function invitation() {
  return `<section class="writing-invitation" aria-labelledby="invitation-heading"><div><p class="eyebrow">Try it for yourself</p><h2 id="invitation-heading">Want to write to someone?</h2>
  <p>Mentally Prepare is a 21-night writing exchange with one anonymous partner, when a match is available. Start with the three-minute scan and see your result before signing up.</p><p class="micro">Free during early access. For adults 18+.</p></div>
  <a class="button" href="/app" data-mp-cta="journal-writing-invitation">Try the 3-minute scan <span aria-hidden="true">&rarr;</span></a></section>`;
}
function featuredStories() {
  const featured = BLOG_POSTS.find(post => post.slug === 'how-to-start-journaling');
  const picks = ['how-to-make-friends-in-college', 'homesick-in-college'].map(slug => BLOG_POSTS.find(post => post.slug === slug));
  return `<section class="featured-stories" aria-labelledby="featured-heading"><article class="featured-story">
  <a class="featured-visual" href="/blog/${featured.slug}" tabindex="-1" aria-hidden="true">${postImage(featured, { priority: true, decorative: true })}</a>
  <div class="featured-copy"><p class="eyebrow">Start here &middot; Journaling</p><h2 id="featured-heading"><a href="/blog/${featured.slug}">How to start journaling when you don’t know what to write</a></h2>
  <p>If the first page is still blank, start here. A five-minute exercise, a sample entry and ten prompts you can borrow.</p><a class="text-link" href="/blog/${featured.slug}">Read the guide <span aria-hidden="true">&rarr;</span></a></div></article>
  <aside class="editor-picks" aria-label="More places to start"><p class="eyebrow">Also worth a read</p>${picks.map(post => `<article class="editor-pick"><a class="pick-image" href="/blog/${post.slug}" tabindex="-1" aria-hidden="true">${postImage(post, { decorative: true })}</a><div class="story-meta"><span>${escape(post.category)}</span><span>${minutes(post)} min read</span></div><h3><a href="/blog/${post.slug}">${escape(post.title)}</a></h3><p>${post.slug === 'homesick-in-college' ? 'Settling in can take longer than you expected. A few things that can help.' : 'Small conversations and simple invitations, without forcing yourself to be the loudest person in the room.'}</p></article>`).join('')}</aside></section>`;
}
function renderIndex({ query = '', topic = '', author = false, noindex = false } = {}) {
  const selected = TOPICS.includes(topic) ? topic : '';
  const needle = query.toLowerCase();
  const posts = BLOG_POSTS.filter(post => (!author || post.author === 'anushka') && (!selected || post.category === selected) && (!needle || (post.title + ' ' + post.description + ' ' + post.category).toLowerCase().includes(needle)));
  const canonical = author ? '/blog/author/anushka' : '/blog';
  const filtered = Boolean(query || selected);
  const intro = author
    ? `<section class="journal-hero author-hero"><p class="eyebrow">About the author</p><h1>Anushka</h1><p class="hero-description">Founder of Mentally Prepare.</p><p class="author-bio">I write about journaling, friendships and student life. These articles offer ideas to try, with links to sources where they’re useful. You can read more about why I started Mentally Prepare on our About page.</p><a class="text-link" href="/about">About Mentally Prepare <span aria-hidden="true">&rarr;</span></a></section>`
    : `<section class="journal-hero"><p class="eyebrow">The Mentally Prepare blog</p><h1>Journaling, friendship<br/> and life at college.</h1><p class="hero-description">Practical articles on making friends, missing home and getting started with journaling. For students figuring it out as they go.</p></section>`;
  const filters = `<div class="story-tools"><nav class="topic-links" aria-label="Browse by topic"><a href="${canonical}#stories" ${!selected ? 'aria-current="page"' : ''}>All articles</a>${TOPICS.map(item => `<a href="${canonical}?topic=${encodeURIComponent(item)}#stories" ${selected === item ? 'aria-current="page"' : ''}>${escape(item)}</a>`).join('')}</nav>
  <form class="journal-search" action="${canonical}#stories" role="search"><label class="sr-only" for="journal-search">Search articles</label><input id="journal-search" name="q" type="search" value="${escape(query)}" placeholder="Search articles" maxlength="120"/>${selected ? `<input type="hidden" name="topic" value="${escape(selected)}"/>` : ''}<button aria-label="Search articles" type="submit">Search</button></form></div>`;
  const body = `<main id="main" class="journal-layout">${intro}${!author && !filtered ? featuredStories() : ''}
  <section class="story-section" id="stories" aria-labelledby="stories-heading"><div class="section-heading"><h2 id="stories-heading">${query ? 'Search results' : selected ? escape(selected) : author ? 'Articles by Anushka' : 'All articles'}</h2><p>${posts.length} articles</p></div>${filters}
  ${posts.length ? `<div class="story-grid">${posts.map(card).join('')}</div>` : `<div class="empty-search"><h3>No articles found.</h3><p>Try a shorter search, or browse a topic above.</p><a class="text-link" href="${canonical}#stories">See all articles</a></div>`}</section>${invitation()}</main>`;
  const schema = author ? { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: 'Anushka', url: SITE + canonical, jobTitle: 'Founder of Mentally Prepare' } }
    : { '@context': 'https://schema.org', '@type': 'Blog', name: 'The Mentally Prepare Blog', url: SITE + '/blog', description: DESCRIPTION, blogPost: BLOG_POSTS.map(post => ({ '@type': 'BlogPosting', headline: post.title, url: SITE + '/blog/' + post.slug })) };
  return shell({ title: author ? 'Anushka | The Mentally Prepare Blog' : 'Journaling, Friendship & College Life | Mentally Prepare', canonical, body, schema, noindex: noindex || filtered });
}
function originalBody(post, rootDir) {
  const html = fs.readFileSync(path.join(rootDir, 'content', 'blog', post.slug + '.html'), 'utf8');
  const match = /<article>([\s\S]*?)<\/article>/.exec(html);
  if (!match) throw Error('Missing article body: ' + post.slug);
  return match[1].replace(/<header>[\s\S]*?<\/header>/, '').replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/g, '').replace(/<section class="cta"[\s\S]*?<\/section>/, '');
}
// The blog's only capture point. A reader who is not ready to be matched with
// a stranger still gets something to do, and the list survives them.
function promptForm(post) {
  return `<section class="prompt-list-signup" id="prompt-list"><h2>One prompt a week</h2>
  <p>One question, every Sunday night, to write about on your own. No account, no matching, nothing to keep up with.</p>
  <form class="prompt-list-form" data-source="${escape(post.slug)}" novalidate>
    <label class="sr-only" for="prompt-list-email">Your email</label>
    <input id="prompt-list-email" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@college.edu"/>
    <button type="submit">Send me the prompts</button>
  </form>
  <p class="micro" data-mp-prompt-list-status role="status" aria-live="polite"></p>
  <p class="micro">We keep your email for this and nothing else. One email a week. Unsubscribe in one click. For adults 18+.</p></section>`;
}
function renderPost(post, rootDir) {
  const sections = post.sections || [];
  const toc = sections.map(section => ({ id: headingId(section.title), title: section.title }));
  let content = sections.length
    ? sections.map(section => `<section><h2 id="${headingId(section.title)}">${escape(section.title)}</h2>${section.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</section>`).join('')
      + `<section class="prompt-card"><h2 id="prompts">Writing prompts</h2><ol>${post.prompts.map(prompt => `<li>${escape(prompt)}</li>`).join('')}</ol><p class="micro">Pick one that feels useful. You can skip any question.</p></section>`
      + `<section class="article-faq"><h2 id="questions">Common questions</h2>${post.faqs.map(([question, answer]) => `<details><summary>${escape(question)}</summary><p>${escape(answer)}</p></details>`).join('')}</section>`
      + ((post.sources || []).length ? `<section class="article-sources"><h2 id="sources">Sources and further reading</h2><ul>${post.sources.map(source => `<li><a href="${escape(source.url)}" rel="noopener noreferrer">${escape(source.label)}</a></li>`).join('')}</ul></section>` : '')
    : originalBody(post, rootDir);
  if (!sections.length) content = content.replace(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>/g, (tag, title) => {
    const text = title.replace(/<[^>]*>/g, ''); const id = headingId(text); toc.push({ id, title: text }); return `<h2 id="${id}">${title}</h2>`;
  });
  const related = BLOG_POSTS.filter(item => item.slug !== post.slug).sort((a, b) => (b.category === post.category) - (a.category === post.category)).slice(0, 3);
  const author = post.author === 'anushka' ? '<a href="/blog/author/anushka">Anushka</a>' : '<a href="/about">Mentally Prepare</a>';
  const credit = `<figcaption>Stock photo: <a href="${escape(post.photoSource)}" rel="noopener noreferrer">${escape(post.photoCredit)} / Pexels</a></figcaption>`;
  const body = `<main id="main" class="journal-layout article-layout"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><a href="/blog">Blog</a><span>/</span><span aria-current="page">${escape(post.category)}</span></nav>
  <article><header class="article-header"><p class="eyebrow">${escape(post.category)} &middot; ${minutes(post)} min read</p><h1>${escape(post.title)}</h1><p class="article-lead">${escape(post.lead || post.description)}</p>
  <div class="byline">By ${author}<span>Published <time datetime="${post.published}">${date(post.published)}</time></span>${post.updated !== post.published ? `<span>Updated <time datetime="${post.updated}">${date(post.updated)}</time></span>` : ''}</div></header>
  <figure class="article-cover">${postImage(post, { priority: true })}${credit}</figure>
  <div class="article-reading-layout"><aside class="article-aside"><details class="article-toc" open><summary>In this article</summary><nav aria-label="Article contents">${toc.slice(0, 10).map(section => `<a href="#${section.id}">${escape(section.title)}</a>`).join('')}${sections.length ? '<a href="#prompts">Writing prompts</a><a href="#questions">Common questions</a>' : ''}</nav></details></aside>
  <div class="article-body">${content}${promptForm(post)}<div class="editorial-note"><p>For information about this writing exchange and its limits, visit our <a href="/safety">safety page</a>.</p></div></div></div></article>
  <section class="related-stories" aria-labelledby="related-heading"><h2 id="related-heading">More to read</h2><div class="story-grid">${related.map(card).join('')}</div></section>${invitation()}</main>`;
  const schema = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.description, image: [SITE + post.image], datePublished: post.published, dateModified: post.updated, mainEntityOfPage: SITE + '/blog/' + post.slug, inLanguage: 'en', author: post.author === 'anushka' ? { '@type': 'Person', name: 'Anushka', url: SITE + '/blog/author/anushka' } : { '@type': 'Organization', name: 'Mentally Prepare', url: SITE + '/about' }, publisher: { '@type': 'Organization', name: 'Mentally Prepare', url: SITE, logo: { '@type': 'ImageObject', url: SITE + '/icon-512x512.png' } } };
  const breadcrumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Mentally Prepare', item: SITE }, { '@type': 'ListItem', position: 2, name: 'Blog', item: SITE + '/blog' }, { '@type': 'ListItem', position: 3, name: post.title, item: SITE + '/blog/' + post.slug }] };
  return shell({ title: post.title, description: post.description, canonical: '/blog/' + post.slug, body, schema: [schema, breadcrumbs], image: post.image, article: true });
}
function renderFeed() {
  const entries = BLOG_POSTS.map(post => `<item><title>${escape(post.title)}</title><link>${SITE}/blog/${post.slug}</link><guid isPermaLink="true">${SITE}/blog/${post.slug}</guid><pubDate>${new Date(post.published + 'T12:00:00Z').toUTCString()}</pubDate><description>${escape(post.description)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>The Mentally Prepare Blog</title><link>${SITE}/blog</link><description>${escape(DESCRIPTION)}</description><language>en</language>${entries}</channel></rss>`;
}
module.exports = { renderIndex, renderPost, renderFeed, escape, DESCRIPTION };
