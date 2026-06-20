// rooms-seed-cards.js
// Starter cards for the three v1 rooms, in the Mentally Prepare voice.
// Openers only. Do NOT seed fake comments or reaction counts.
// support_need is one of: listen | think | share | encourage | quiet
//
// Wired into scripts/seed-rooms.js: each entry becomes a row in room_cards
// with the matching room's id, the founder/system author_id, the
// support_need, the body, is_held = 0, is_seed = 1, created_at staggered,
// and a far-out expires_at so the openers don't all fade on day one.

module.exports = {
  night: [
    { support_need: 'listen',
      body: "it's past 1 and my head won't go quiet. nothing happened today, i just can't put it down." },
    { support_need: 'quiet',
      body: "i don't need anyone to fix anything. i just didn't want to be the only one awake right now." },
    { support_need: 'share',
      body: "i did one small thing today that i'd been scared of for weeks. no one knows. it felt bigger than it sounds." },
    { support_need: 'think',
      body: "i keep replaying a conversation from this evening, editing what i should have said. how do you stop the loop?" },
    { support_need: 'encourage',
      body: "tomorrow has a thing i've been dreading. tonight it feels too big. tell me mornings are different." },
    { support_need: 'listen',
      body: "everyone in my house is asleep and i feel like the only person carrying something heavy tonight." },
    { support_need: 'quiet',
      body: "just here. not okay, not in danger. somewhere in between. sitting with it." },
  ],

  studies: [
    { support_need: 'share',
      body: "everyone in class seems to understand and i've been nodding along pretending i do too." },
    { support_need: 'encourage',
      body: "exam in two days. opened the book, closed it, sat there. starting again right now. say something." },
    { support_need: 'listen',
      body: "my parents ask how prep is going and i say fine. it is not fine and i don't know how to say that." },
    { support_need: 'think',
      body: "i'm doing the course everyone said was safe and i feel nothing for it. is it too late to mind?" },
    { support_need: 'listen',
      body: "first time living in a hostel. surrounded by people, never felt more behind or more alone." },
    { support_need: 'encourage',
      body: "failed something i studied hard for. trying to believe it isn't the whole story about me." },
  ],

  lonely: [
    { support_need: 'listen',
      body: "moved cities for college. i talk to people all day and still feel completely unseen." },
    { support_need: 'think',
      body: "i'm always the one who texts first. i'm tired of it but scared of what happens if i stop." },
    { support_need: 'share',
      body: "i'm good at looking fine. i'd just like one place where i don't have to perform it." },
    { support_need: 'quiet',
      body: "no big reason. just wanted to put 'i feel alone tonight' somewhere a stranger might read it." },
    { support_need: 'encourage',
      body: "trying to believe that feeling this disconnected isn't permanent. some days that's hard." },
    { support_need: 'listen',
      body: "everyone seems to already have their people. i missed the part where you find yours." },
  ],
};
