'use strict';

const COPY = {
  morning: [
    { title: 'a small pause.', body: 'Your morning reset is ready.', route: '/' },
  ],
  daily_reflection: [
    { title: 'your 9 PM plot twist.', body: 'One question just landed.', route: '/rooms' },
    { title: 'one thought. no TED Talk.', body: 'Tonight is ready.', route: '/rooms' },
    { title: 'today had lore.', body: 'Leave one piece of it here.', route: '/rooms' },
  ],
  evening: [
    { title: 'tonight is open.', body: 'Return when you have a quiet minute.', route: '/rooms' },
  ],
  partner_waiting: [
    { title: 'someone showed up.', body: 'Your shared sky changed tonight.', route: '/rooms' },
    { title: 'plot moved. no spoilers.', body: 'There is a new presence in your Room.', route: '/rooms' },
  ],
  partner_still_writing: [
    { title: 'bas, one line.', body: 'Tonight does not need a full essay.', route: '/rooms' },
  ],
  daily_prompt_unlocked: [
    { title: 'midnight moved the story.', body: 'Something new is ready in your Room.', route: '/rooms' },
    { title: 'new lore unlocked.', body: 'Open it when you have a quiet minute.', route: '/rooms' },
  ],
  silent_room: [
    { title: 'a quiet minute.', body: 'A small pause is here when you want it.', route: '/' },
  ],
  inactive_24: [
    { title: 'your Room kept its place.', body: 'Return when you are ready.', route: '/rooms' },
  ],
  inactive_48: [
    { title: 'still here.', body: 'Your Room is available without pressure.', route: '/rooms' },
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

