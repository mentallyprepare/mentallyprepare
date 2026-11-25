// Published blog articles. Each entry is served from content/blog/<slug>.html
// at /blog/<slug> and listed in the sitemap. Newest first.
const ORIGINAL_POSTS = [
  {
    slug: 'how-to-make-friends-in-college',
    title: 'How to Make Friends in College When You Feel Shy',
    description: 'Learn how to make friends in college when you feel shy, using small conversations, familiar places and simple invitations that help connection grow naturally.',
    published: '2026-10-30',
    updated: '2026-10-30',
    image: '/images/blog/lonely-in-college-lakeside-bench.webp',
    imageAlt: 'A student sits on a bench beside a lake, looking toward the city'
  },
  {
    slug: 'how-to-start-journaling',
    title: 'How to Start Journaling for Beginners in 5 Minutes',
    description: 'Start journaling tonight with a five-minute exercise, a sample first entry, and 10 prompts for college students. Try your first prompt before you go to bed.',
    published: '2026-10-07',
    updated: '2026-11-18',
    image: '/images/blog/how-to-start-journaling.webp',
    imageAlt: 'Illustration of an open notebook with a single line written and a pink pencil, under a small moon'
  },
  {
    slug: 'homesick-in-college',
    title: 'Homesick in College? Why It Happens and What Helps',
    description: 'Feeling homesick in college or hostel? Why homesickness hits harder than expected, how it differs from loneliness, and six small things that help.',
    published: '2026-10-07',
    updated: '2026-10-07',
    image: '/images/blog/homesick-in-college.webp',
    imageAlt: 'Illustration of a small house with one lit window under a full moon, with a dotted path leading away'
  },
  {
    slug: 'lonely-even-around-people',
    title: "Why You Can Feel Lonely Even When You're Around People",
    description: "Feel lonely even with friends or in a crowd? Why being surrounded isn't the same as being seen, and small ways to feel more connected with the people you already know.",
    published: '2026-10-07',
    updated: '2026-10-07',
    image: '/images/blog/lonely-even-around-people.webp',
    imageAlt: 'Illustration of a crowd of faint stars with two brighter stars joined by a thin line'
  },
  {
    slug: 'feeling-lonely-in-college',
    title: 'Feeling Lonely in College? 8 Small Ways to Find Connection',
    description: 'Feeling lonely in college or your hostel? Try eight small, practical ways to make friends and feel more connected, plus prompts and places to find support.',
    published: '2026-10-06',
    updated: '2026-10-30',
    image: '/images/blog/lonely-in-college-hostel-room.webp',
    imageAlt: 'A shared hostel room with bunk beds and two empty red chairs by the window'
  }
];

const photos = new Map(require('../content/blog/photo-credits.json').map(photo => [photo.key, photo]));
const photoForSlug = {
  'how-to-start-journaling': 'writing-at-desk',
  'how-to-make-friends-in-college': 'campus-conversation',
  'homesick-in-college': 'campus-study-space',
  'lonely-even-around-people': 'campus-study-space',
  'feeling-lonely-in-college': 'walking-between-classes',
  'journaling-prompts-for-anxiety-how-to-ground-your-mind': 'open-notebook',
  'feeling-alone-and-lonely-quotes-finding-connection-in': 'campus-study-space',
  'journaling-prompts-for-healing-a-student-guide-to-recovery': 'writing-at-desk',
  'how-can-you-protect-your-privacy-online-a-student-guide': 'phone-and-notebook',
  'how-a-digital-detox-for-mental-health-restores-focus': 'phone-and-notebook',
  'deep-late-night-conversation-topics-for-real-connection': 'friends-on-campus',
  'how-to-choose-a-journal-for-self-reflection-in-2026': 'open-notebook',
  'best-journaling-prompts-for-student-growth-in-2026': 'writing-by-window',
  'how-to-start-a-digital-detox-challenge-for-students': 'phone-and-notebook',
  'peer-to-peer-support-how-shared-vulnerability-aids-recovery': 'campus-conversation',
  'best-pen-pal-websites-for-deep-connection-in-2026': 'handwritten-letter',
  'deep-conversation-questions-for-real-connection-in-2026': 'friends-on-campus',
  'journaling-prompts-for-self-discovery-a-student-guide': 'writing-by-window',
  'how-to-journaling-daily-a-student-guide-to-honest-reflection': 'writing-at-desk'
};
const imported = require('../content/blog/imported-posts.json');
const summaries = {
  'how-to-start-journaling': 'Not sure what belongs on the first page? Try a five-minute exercise, a sample entry and ten prompts to get started.',
  'how-to-make-friends-in-college': 'You do not have to become more outgoing overnight. Start with a familiar place, a short conversation and a simple invitation.',
  'homesick-in-college': 'You can be glad you moved away and still miss home. Here are a few ways to make the new place feel more familiar.',
  'lonely-even-around-people': 'Having people around is different from feeling close to them. A look at what might be missing and how to ask for it.',
  'feeling-lonely-in-college': 'Eight small ways to find company and build connections, even when everyone else seems to have their group already.',
  'journaling-prompts-for-anxiety-how-to-ground-your-mind': 'A few questions for when your thoughts keep circling the same worry. You can stop or skip a prompt whenever you need to.',
  'feeling-alone-and-lonely-quotes-finding-connection-in': 'Sometimes a sentence helps you name what is going on. These original lines are a starting point for your own writing.',
  'journaling-prompts-for-healing-a-student-guide-to-recovery': 'You do not have to write the whole story. Try questions about what you need today, what helps and what you would rather keep private.',
  'how-can-you-protect-your-privacy-online-a-student-guide': 'Check who can access your accounts, what your posts reveal and what to keep out of a note to a stranger.',
  'how-a-digital-detox-for-mental-health-restores-focus': 'Less time scrolling does not have to mean disappearing from the people you care about. Start with one small change.',
  'deep-late-night-conversation-topics-for-real-connection': 'Questions you can ask when the conversation moves past classes and weekend plans. There is always room to pass.',
  'how-to-choose-a-journal-for-self-reflection-in-2026': 'Notebook, notes app or guided journal? Try a few entries before buying anything and see which format fits your day.',
  'best-journaling-prompts-for-student-growth-in-2026': 'Questions about busy weeks, friendships, studying and changing plans. Pick one that fits the day you are actually having.',
  'how-to-start-a-digital-detox-challenge-for-students': 'A seven-day experiment with notifications, scrolling and phone-free time. Keep the changes that help and adjust the rest.',
  'peer-to-peer-support-how-shared-vulnerability-aids-recovery': 'What to say when a friend opens up, how to listen and when the situation needs more support than you can offer.',
  'best-pen-pal-websites-for-deep-connection-in-2026': 'Compare different writing exchanges and check privacy, time commitments and safety before joining one.',
  'deep-conversation-questions-for-real-connection-in-2026': 'A list of questions for getting to know someone beyond small talk, without making it feel like an interview.',
  'journaling-prompts-for-self-discovery-a-student-guide': 'What do you enjoy? What are you doing to keep up with everyone else? A few questions to think through on paper.',
  'how-to-journaling-daily-a-student-guide-to-honest-reflection': 'Start small, find a time that works and let missed days stay missed. Your journal does not need a backlog.'
};
const BLOG_POSTS = [...ORIGINAL_POSTS.map(post => ({ ...post,
  category: post.slug === 'how-to-start-journaling' ? 'Journaling' : 'College life',
  author: 'team'
})), ...imported].map(post => {
  const photo = photos.get(photoForSlug[post.slug]);
  if (!photo) throw new Error('Missing stock photograph for ' + post.slug);
  return { ...post, summary: summaries[post.slug], image: photo.image, imageAlt: photo.alt,
    imageWidth: photo.width, imageHeight: photo.height,
    photoCredit: photo.photographer, photoSource: photo.source };
}).sort((a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug));
const BLOG_SLUGS = new Set(BLOG_POSTS.map((post) => post.slug));

function isBlogPath(pathname) {
  if (/^\/blog\/author\/anushka\/?$/.test(pathname || '')) return true;
  const match = /^\/blog(?:\/([a-z0-9-]+))?\/?$/.exec(pathname || '');
  return Boolean(match) && (!match[1] || BLOG_SLUGS.has(match[1]));
}

module.exports = {
  BLOG_POSTS,
  BLOG_SLUGS,
  isBlogPath
};
