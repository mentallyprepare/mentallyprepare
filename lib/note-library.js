// ─────────────────────────────────────────────────────────────
// Mentally Prepare — Daily Note Fallback Library
// 3 notes × 4 archetypes × 3 day-ranges = 36 notes
// Voice: intimate, honest, slightly poetic, never preachy (Anushka Kumar)
// ─────────────────────────────────────────────────────────────

const NOTE_LIBRARY = {
  protector: {
    early: [ // Days 1–7
      {
        observation: "There is a version of you that no one has been close enough to see. Not because it doesn't exist — but because you've never found someone worth the risk.",
        permission: "Today you are allowed to keep some things protected while still letting this experiment be something real.",
        question: "Who were you before you learned that closeness was a risk?"
      },
      {
        observation: "The thing about people who carry others is that the carrying becomes invisible — even to themselves.",
        permission: "Today you are allowed to put something down, even if only in these words.",
        question: "What have you been holding that nobody asked you to pick up?"
      },
      {
        observation: "You are probably already thinking about what you'll share and what you won't. That instinct is not cowardice. It is the architecture of someone who's been hurt.",
        permission: "Today you are allowed to write something small and true — you don't have to start with the big thing.",
        question: "What's the smallest honest thing you could say tonight?"
      }
    ],
    middle: [ // Days 8–14
      {
        observation: "There is a particular kind of exhaustion that comes from being the person everyone else leans on. It is invisible from the outside, and that is the loneliest part.",
        permission: "Today you are allowed to need something back. Not everything. Just one small thing, from one person.",
        question: "Who were you before you learned to be so self-sufficient?"
      },
      {
        observation: "You have been writing for eight days now. That is further than most people get. Somewhere in those words, the real version of you has started appearing.",
        permission: "Today you are allowed to notice that without immediately pulling back.",
        question: "What have you written here that surprised even you?"
      },
      {
        observation: "People like you build walls not because they don't want connection, but because connection has cost them something before.",
        permission: "Today you are allowed to consider that this stranger has their own walls too — and that two people with walls can still find each other.",
        question: "What would it take for you to trust someone completely?"
      }
    ],
    late: [ // Days 15–21
      {
        observation: "You have been honest here in ways you probably are not honest anywhere else. That is not a small thing. That is the whole thing.",
        permission: "Today you are allowed to feel proud of that — quietly, privately, in the way that protectors feel things.",
        question: "What has changed in you since Day 1?"
      },
      {
        observation: "The wall is still there. But somewhere in these 15 days, a window appeared.",
        permission: "Today you are allowed to stand at that window for a while instead of turning away from it.",
        question: "What are you afraid would happen if you let someone fully in?"
      },
      {
        observation: "You are almost at the end. The person on the other side of these words has seen more of you than most people ever do.",
        permission: "Today you are allowed to sit with the strangeness of that — and not decide immediately how to feel about it.",
        question: "What do you hope they understood about you?"
      }
    ]
  },

  connector: {
    early: [
      {
        observation: "You probably already want to know more about the person reading your words. That impulse — the reaching — is the truest thing about you.",
        permission: "Today you are allowed to reach without needing to know if they'll reach back.",
        question: "What do you most want someone to understand about you before they even know your name?"
      },
      {
        observation: "You give a lot. You check in first. You remember things. And sometimes you wonder if any of it lands the way you mean it to.",
        permission: "Today you are allowed to write as if it will land — just this once.",
        question: "What would it feel like to receive the kind of care you give?"
      },
      {
        observation: "Connection is not your problem. Depth is. Getting close is easy. Staying close when it gets real — that's where it gets complicated for you.",
        permission: "Today you are allowed to stay in one place and let this be real.",
        question: "When did closeness start to feel scary instead of just good?"
      }
    ],
    middle: [
      {
        observation: "You've been checking in, reaching, opening up. And somewhere underneath all that warmth, there is a quieter question: am I too much?",
        permission: "Today you are allowed to be exactly as much as you are — without editing it down for easier consumption.",
        question: "What would you say if you knew for certain you wouldn't be 'too much'?"
      },
      {
        observation: "You are a person who makes people feel seen. What is rarer than you think is that you need that too — not just to give it.",
        permission: "Today you are allowed to ask, out loud, in this space, to be seen.",
        question: "Has anyone ever truly made you feel heard? What did they do?"
      },
      {
        observation: "There is a version of you that exists only when you're alone — quieter, slower, less certain. That version is also you. Maybe the truest version.",
        permission: "Today you are allowed to write from that version instead of the one who's always reaching.",
        question: "What do you actually feel when all the connections go quiet?"
      }
    ],
    late: [
      {
        observation: "You came into this ready to connect, and you have. What surprised you is how much the writing asked of you — not the reaching, but the honesty in it.",
        permission: "Today you are allowed to stay with what you've discovered, without immediately sharing it with someone else.",
        question: "What have you learned about yourself that you didn't expect?"
      },
      {
        observation: "You have given a lot of yourself to this stranger over 15 days. That is not a weakness. That is your superpower showing up in the only way it knows how.",
        permission: "Today you are allowed to receive something back — whatever they wrote today, let it actually reach you.",
        question: "What has it meant to be truly anonymous here?"
      },
      {
        observation: "Almost at the end. You know more about yourself than you did 21 days ago. Some of that knowledge was given to you by someone who doesn't know your name yet.",
        permission: "Today you are allowed to feel grateful for that — and unfamiliar with that feeling.",
        question: "What do you want to say to this stranger before Day 21?"
      }
    ]
  },

  performer: {
    early: [
      {
        observation: "You are good at being known without being known. The version of you that arrives in rooms is polished, warm, easy. The version that stays after everyone leaves is something else entirely.",
        permission: "Today you are allowed to write as the version that stays after everyone leaves.",
        question: "What do you actually feel when the performance is over?"
      },
      {
        observation: "It is exhausting, keeping track of which version of yourself you are in which room. Anonymity is the first rest you might actually have allowed yourself.",
        permission: "Today you are allowed to not perform, here, in this exact space.",
        question: "Who were you before you learned that being likeable kept you safe?"
      },
      {
        observation: "You've gotten very good at fine. Fine is a complete sentence that says nothing and everything.",
        permission: "Today you are allowed to give a different answer — even if only in writing, even if only to a stranger.",
        question: "If someone asked you how you really were right now, what would the honest answer be?"
      }
    ],
    middle: [
      {
        observation: "Something in your writing is shifting. The mask comes off a little easier here, where nobody knows your face.",
        permission: "Today you are allowed to be unpolished on purpose — to write a sentence that isn't quite right, that says something you're not sure about.",
        question: "What is the thing you perform most often that you're most tired of?"
      },
      {
        observation: "You know how to make people comfortable. What you don't always know how to do is make yourself comfortable — with them, with yourself, with quiet.",
        permission: "Today you are allowed to sit in the discomfort instead of managing it for someone else.",
        question: "What would happen if you stopped being easy for people to be around?"
      },
      {
        observation: "The Performer always knows what the audience needs. What does the Performer need?",
        permission: "Today you are allowed to write an answer to that question as if no one is watching.",
        question: "What has performing cost you that you've never fully admitted?"
      }
    ],
    late: [
      {
        observation: "Fifteen days of writing without an audience. Something in you has shifted. You've caught yourself being honest in ways you didn't plan.",
        permission: "Today you are allowed to name that shift — not to perform it for effect, just to notice it for yourself.",
        question: "What part of the real you has shown up here that rarely shows up anywhere else?"
      },
      {
        observation: "You started as The Performer. You may be ending as something different. The understudy has had the lead role for weeks now.",
        permission: "Today you are allowed to not know what to call yourself yet — to be in between.",
        question: "What does it feel like to be seen without performing?"
      },
      {
        observation: "You wrote something in one of these entries that you would never say out loud in your life. You know which one.",
        permission: "Today you are allowed to return to it — without judgment, without fixing it.",
        question: "What does that entry tell you about who you actually are?"
      }
    ]
  },

  disconnector: {
    early: [
      {
        observation: "You are here. That is not a small thing. The part of you that disconnects — that drifts away before things get real — didn't win today.",
        permission: "Today you are allowed to stay for the full duration of this, even if some part of you is already thinking about the exit.",
        question: "What usually triggers the drift — and what are you afraid of finding on the other side of it?"
      },
      {
        observation: "You are comfortable with solitude in ways most people aren't. But there is a difference between chosen solitude and isolation that crept up on you.",
        permission: "Today you are allowed to wonder which one this is.",
        question: "When did you last feel genuinely close to someone — and what happened after?"
      },
      {
        observation: "The thing about Disconnectors is that they feel everything. They just have a system for not showing it.",
        permission: "Today you are allowed to write without the system — just once.",
        question: "What would you feel right now if you let yourself feel it?"
      }
    ],
    middle: [
      {
        observation: "Eight days. You are further in than you usually let yourself go. That is worth noticing without immediately explaining away.",
        permission: "Today you are allowed to stay, even though there is a part of you that's already wondering if this is too much.",
        question: "What keeps bringing you back to this, even when you could just stop?"
      },
      {
        observation: "You drift away from people before they can leave you. You know this about yourself. What you might not know is how clearly it shows up in the things you write.",
        permission: "Today you are allowed to write about someone you pulled away from — not to explain it, just to feel it.",
        question: "What is the thing you most want from someone that you consistently refuse to ask for?"
      },
      {
        observation: "There is a kind of sadness that lives in the Disconnector that rarely gets named. It is not dramatic. It is quiet. It sounds like 'I'm fine, just tired.'",
        permission: "Today you are allowed to name it properly.",
        question: "What are you really feeling when you say you're just tired?"
      }
    ],
    late: [
      {
        observation: "You haven't disconnected. That is unusual. Something about this kept you here — the anonymity, or the writing, or the person on the other end of it.",
        permission: "Today you are allowed to acknowledge that staying has meant something.",
        question: "What made this different from the other times you've tried to connect?"
      },
      {
        observation: "The orbit is tightening. You started at a safe distance — and without quite deciding to, you have moved closer.",
        permission: "Today you are allowed to stay at that distance without pulling back to the original position.",
        question: "What would it mean to let something finish instead of leaving before the end?"
      },
      {
        observation: "You are almost at Day 21. The person who started this journey would have predicted you'd be gone by now.",
        permission: "Today you are allowed to feel whatever it is to have proven yourself wrong.",
        question: "What has staying taught you that leaving never could have?"
      }
    ]
  }
};

/**
 * Get the day-range key for a given day number
 */
function getDayRange(day) {
  if (day <= 7) return 'early';
  if (day <= 14) return 'middle';
  return 'late';
}

/**
 * Get a note from the fallback library.
 * Uses day + archetype + a simple signal hash to pick between the 3 options.
 * @param {string} archetype - protector|connector|performer|disconnector
 * @param {number} day - 1-21
 * @param {number} [signal] - any number used to deterministically vary the note (e.g. user_id % 3)
 */
function getNote(archetype, day, signal = 0) {
  const range = getDayRange(day);
  const notes = NOTE_LIBRARY[archetype]?.[range];
  if (!notes || !notes.length) {
    // Absolute fallback
    return {
      observation: "You showed up tonight. That matters more than you think.",
      permission: "Today you are allowed to write without pressure — even one honest sentence is enough.",
      question: "What is the truest thing you could say right now?"
    };
  }
  return notes[Math.abs(signal) % notes.length];
}

module.exports = { getNote, NOTE_LIBRARY, getDayRange };
