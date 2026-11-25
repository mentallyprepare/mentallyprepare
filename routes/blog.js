'use strict';
const { BLOG_POSTS } = require('../lib/blog-posts');
const { renderIndex, renderPost, renderFeed, escape } = require('../lib/blog-renderer');

module.exports = function registerBlogRoutes(app, { rootDir, baseUrl }) {
  const posts = new Map(BLOG_POSTS.map(p=>[p.slug,p]));
  const search = req => ({query:typeof req.query.q==='string'?req.query.q.trim().slice(0,120):'',topic:typeof req.query.topic==='string'?req.query.topic.slice(0,40):''});
  app.get('/blog', (req,res)=>{ const options=search(req); if(options.query||options.topic)res.set('X-Robots-Tag','noindex, follow'); res.type('html').send(renderIndex(options)); });
  app.get('/blog/search', (req,res)=>{res.set('X-Robots-Tag','noindex, follow');res.type('html').send(renderIndex({...search(req),noindex:true}));});
  app.get('/blog/feed.xml', (req,res)=>res.type('application/rss+xml').send(renderFeed()));
  app.get('/blog/sitemap.xml', (req,res)=>res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escape(baseUrl)}/blog</loc></url><url><loc>${escape(baseUrl)}/blog/author/anushka</loc></url>${BLOG_POSTS.map(p=>`<url><loc>${escape(baseUrl)}/blog/${p.slug}</loc><lastmod>${p.updated}</lastmod></url>`).join('')}</urlset>`));
  app.get('/blog/author/anushka', (req,res)=>{const options=search(req);if(options.query||options.topic)res.set('X-Robots-Tag','noindex, follow');res.type('html').send(renderIndex({...options,author:true}));});
  app.get('/blog/page/:page', (req,res,next)=>/^[1-9]\d*$/.test(req.params.page)&&Number(req.params.page)<=2?res.redirect(301,'/blog#stories'):next());
  app.get('/blog/author/anushka/page/:page',(req,res,next)=>/^[1-9]\d*$/.test(req.params.page)&&Number(req.params.page)<=2?res.redirect(301,'/blog/author/anushka#stories'):next());
  app.get('/blog/:slug',(req,res,next)=>{const post=posts.get(req.params.slug);if(!post)return next();res.type('html').send(renderPost(post,rootDir));});
};
