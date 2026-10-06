// Published blog articles. Each entry is served from content/blog/<slug>.html
// at /blog/<slug> and listed in the sitemap. Newest first.
const BLOG_POSTS = [
  {
    slug: 'feeling-lonely-in-college',
    title: 'Feeling Lonely in College? 8 Small Ways to Find Connection',
    description: 'Feeling lonely in college or hostel? Explore eight small ways to build connections, gentle journaling prompts, and where to find support.',
    published: '2026-10-06',
    updated: '2026-10-06',
    image: '/images/blog/lonely-in-college-hostel-room.jpg',
    imageAlt: 'A shared hostel room with bunk beds and two empty red chairs by the window'
  }
];

const BLOG_SLUGS = new Set(BLOG_POSTS.map((post) => post.slug));

function isBlogPath(pathname) {
  const match = /^\/blog(?:\/([a-z0-9-]+))?\/?$/.exec(pathname || '');
  return Boolean(match) && (!match[1] || BLOG_SLUGS.has(match[1]));
}

module.exports = {
  BLOG_POSTS,
  BLOG_SLUGS,
  isBlogPath
};
