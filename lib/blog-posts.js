// Published blog articles. Each entry is served from content/blog/<slug>.html
// at /blog/<slug> and listed in the sitemap. Newest first.
const BLOG_POSTS = [
  {
    slug: 'how-to-start-journaling',
    title: "How to Start Journaling (When You've Tried Before and Stopped)",
    description: 'Want to start journaling but always stop after a week? A simple one-line method, ten prompts for students, and what to do on nights you have nothing to say.',
    published: '2026-10-07',
    updated: '2026-10-07',
    image: '/images/blog/how-to-start-journaling.jpg',
    imageAlt: 'Illustration of an open notebook with a single line written and a pink pencil, under a small moon'
  },
  {
    slug: 'homesick-in-college',
    title: 'Homesick in College? Why It Happens and What Helps',
    description: 'Feeling homesick in college or hostel? Why homesickness hits harder than expected, how it differs from loneliness, and six small things that help.',
    published: '2026-10-07',
    updated: '2026-10-07',
    image: '/images/blog/homesick-in-college.jpg',
    imageAlt: 'Illustration of a small house with one lit window under a full moon, with a dotted path leading away'
  },
  {
    slug: 'lonely-even-around-people',
    title: "Why You Can Feel Lonely Even When You're Around People",
    description: "Feel lonely even with friends or in a crowd? Why being surrounded isn't the same as being seen, and small ways to feel more connected with the people you already know.",
    published: '2026-10-07',
    updated: '2026-10-07',
    image: '/images/blog/lonely-even-around-people.jpg',
    imageAlt: 'Illustration of a crowd of faint stars with two brighter stars joined by a thin line'
  },
  {
    slug: 'feeling-lonely-in-college',
    title: 'Feeling Lonely in College? 8 Small Ways to Find Connection',
    description: 'Feeling lonely in college or hostel? Explore eight small ways to build connections, gentle journaling prompts, and where to find support.',
    published: '2026-10-06',
    updated: '2026-10-07',
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
