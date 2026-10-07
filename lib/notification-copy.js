'use strict';

const COPY = {
  morning: [
    { title: 'a small pause.', body: 'Your morning reset is ready.', route: '/' },
  ],
  daily_reflection: [
    { title: 'A moment to pause', body: 'Tonight’s prompt is ready whenever you are.', route: '/app' },
    { title: 'If today felt full', body: 'You can leave a single thought in your private space.', route: '/app' },
    { title: 'A quieter end to the day', body: 'Open your writing space when you have a minute.', route: '/app' },
  ],
  evening: [
    { title: 'Your space is open', body: 'Return when you have a quiet minute.', route: '/app' },
  ],
  partner_waiting: [
    { title: 'A note is ready', body: 'Open the app when you feel like reading.', route: '/app' },
    { title: 'Something new in your space', body: 'It will be there when you are ready.', route: '/app' },
  ],
  partner_still_writing: [
    { title: 'Your space is still here', body: 'You can return without catching up.', route: '/app' },
  ],
  daily_prompt_unlocked: [
    { title: 'A new prompt is ready', body: 'Open it when you have a quiet minute.', route: '/app' },
    { title: 'Your next prompt is here', body: 'There is no rush to begin.', route: '/app' },
  ],
  silent_room: [
    { title: 'a quiet minute.', body: 'A small pause is here when you want it.', route: '/' },
  ],
  inactive_24: [
    { title: 'Your space kept its place', body: 'Return when you are ready.', route: '/app' },
  ],
  inactive_48: [
    { title: 'Still here', body: 'Your writing space is available whenever you want it.', route: '/app' },
  ],
};

function stableIndex(seed, length) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function selectNotificationCopy(type, seed) {
  const rows = COPY[type] || COPY.evening;
  return rows[stableIndex(`${type}:${seed}`, rows.length)];
}

module.exports = {
  COPY,
  selectNotificationCopy,
};

