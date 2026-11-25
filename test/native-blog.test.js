'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const zlib=require('node:zlib');
const {BLOG_POSTS,BLOG_SLUGS,isBlogPath}=require('../lib/blog-posts');
const {registerStaticRoutes}=require('../routes/static');
const rootDir=path.resolve(__dirname,'..');

async function run(){
  assert.equal(BLOG_POSTS.length,19);
  assert.equal(BLOG_SLUGS.size,19,'no slug collisions');
  const legacy=JSON.parse(fs.readFileSync(path.join(rootDir,'content/blog/imported-posts.json'),'utf8'));
  const archived=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(rootDir,'content/blog/archive/rankbench-2026-11-24.json.gz'))));
  assert.equal(legacy.length,14,'all external article URLs have a native version');
  assert.deepEqual(legacy.map(p=>'/blog/'+p.slug).sort(),archived.map(p=>new URL(p.url).pathname).sort(),'every archived URL is preserved');
  for(const post of legacy){assert.ok(BLOG_SLUGS.has(post.slug));assert.equal(post.updated,'2026-11-24');assert.match(post.published,/^2026-\d{2}-\d{2}$/);}
  const app=express();
  registerStaticRoutes(app,{rootDir,baseUrl:'https://mymentallyprepare.com'});
  app.use(express.static(path.join(rootDir,'public')));
  app.use((req,res)=>res.status(404).send('Not found'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const index=await fetch(base+'/blog').then(r=>r.text());
    assert.equal((index.match(/<h1[ >]/g)||[]).length,1);
    assert.ok(index.includes('/journal.css?v='));
    assert.ok(!index.includes('assets.rankbench')&&!index.includes('rankbench.io'));
    const sitemap=await fetch(base+'/sitemap.xml').then(r=>r.text());
    const blogSitemap=await fetch(base+'/blog/sitemap.xml').then(r=>r.text());
    const feed=await fetch(base+'/blog/feed.xml');
    assert.match(feed.headers.get('content-type'),/application\/rss\+xml/);
    const xml=await feed.text();assert.equal((xml.match(/<item>/g)||[]).length,19);
    for(const post of BLOG_POSTS){
      const response=await fetch(base+'/blog/'+post.slug);assert.equal(response.status,200,post.slug);
      const html=await response.text();
      assert.equal((html.match(/<h1[ >]/g)||[]).length,1,'one article heading: '+post.slug);
      assert.ok(html.includes('href="https://mymentallyprepare.com/blog/'+post.slug+'"'));
      assert.ok(index.includes('href="/blog/'+post.slug+'"'));
      assert.ok(sitemap.includes('/blog/'+post.slug+'</loc>'));
      assert.ok(blogSitemap.includes('/blog/'+post.slug+'</loc>'));
      assert.ok(!html.includes('assets.rankbench.io'),'no expiring image dependency');
      const schema=JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.equal(schema[0]['@type'],'BlogPosting');assert.equal(schema[1]['@type'],'BreadcrumbList');
      assert.equal(schema[0].datePublished,post.published);assert.equal(schema[0].dateModified,post.updated);
      assert.ok(fs.existsSync(path.join(rootDir,'public',post.image)));
      assert.ok(post.image.startsWith('/images/blog/stock/'),'article uses locally hosted stock photography');
      assert.ok(post.photoSource.startsWith('https://www.pexels.com/photo/'),'photograph has an identifiable source');
      assert.ok(html.includes('Stock photo:'),'stock models are not presented as users or the author');
      assert.ok(isBlogPath('/blog/'+post.slug));
      for(const match of html.matchAll(/href="#([^"]+)"/g))assert.ok(html.includes('id="'+match[1]+'"'),'TOC target exists: '+match[1]);
    }
    const query=await fetch(base+'/blog?q='+encodeURIComponent('<script>alert(1)</script>'));
    assert.match(query.headers.get('x-robots-tag'),/noindex/);
    const searched=await query.text();assert.ok(!searched.includes('<script>alert(1)</script>'));assert.ok(searched.includes('&lt;script&gt;'));
    assert.equal((await fetch(base+'/blog?topic=Journaling')).status,200);
    assert.equal((await fetch(base+'/blog/author/anushka')).status,200);
    for(const url of ['/blog/search','/blog/search?q=writing']){
      const response=await fetch(base+url); assert.equal(response.status,200,url);
      assert.match(response.headers.get('x-robots-tag'),/noindex/);
      assert.match(await response.text(),/name="robots" content="noindex, follow"/);
    }
    for(const url of ['/blog/page/2','/blog/author/anushka/page/2'])assert.equal((await fetch(base+url,{redirect:'manual'})).status,301,url);
    for(const url of ['/blog/no-such-article','/blog/page/999','/blog/author/no-such-author'])assert.equal((await fetch(base+url)).status,404,url);
    console.log('Native blog: all 19 URLs, feed, sitemaps, author, legacy pages, schema, local assets, contents links and search escaping passed.');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
