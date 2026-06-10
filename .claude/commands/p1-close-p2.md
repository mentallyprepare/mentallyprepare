---
description: Close out the remaining P1 items (stats copy, Today countdown, proactive ghost nudge) then start P2 (archetype share moment, naming, Silent Room presence, Day 7/14 beats)
---

You are working on Mentally Prepare. Read CLAUDE.md first and obey it: propose before implementing, minimal diffs, one item per commit, no new dependencies, no em-dashes anywhere, 3am-friend voice for every user-facing string. Verify against current code before every change; several earlier audit references went stale after PRs #27-30, so re-grep everything.

For each item: state intent, show the diff, wait for my "go", apply, then give me a one-sentence retest.

## Finish P1

### A. Item 14 — replace the uncited stats (decision made: qualitative)
In public/app.html, replace the "8 in 10" and "1 in 3" problem-stat blocks with these exact strings (keep the existing problem-stat-n / problem-stat-label structure):

- Stat 1 n: "Most of us" / label: "carry something we never say out loud, even with people around us"
- Stat 2 n: "So many of us" / label: "want to talk, but don't know where it's safe to be real"

Leave the "3 min" stat as is; it is a product fact, not a claim. Check index.html for any other uncited statistic while you are in there; report if found, do not change without my go.

### B. Item 11 — Today screen reveal countdown + partner archetype
The original patch predates recent merges; re-implement it rather than applying. Two hunks:

1. public/app.css, after the .day-pill rule:
.reveal-strip{padding:10px 24px 0;display:flex;flex-direction:column;gap:3px}
.reveal-partner{font-size:11px;letter-spacing:.04em;color:var(--ink-s)}
.reveal-partner span{color:var(--ink-m)}
.reveal-count{font-family:'Playfair Display',serif;font-style:italic;font-size:13px;color:var(--gold-l)}

2. public/app.js, in renderJournal(), between the greeting block and the special-day banner:
const nightsLeft = 21 - day;
const revealHeaderHTML = `
  <div class="reveal-strip">
    ${matchArch ? `<div class="reveal-partner">Your partner: <span>${matchArch.emoji} ${escapeHtml(matchArch.name)}</span></div>` : ''}
    <div class="reveal-count">${nightsLeft > 0 ? `${nightsLeft} night${nightsLeft === 1 ? '' : 's'} until the reveal.` : 'Tonight is the reveal.'}</div>
  </div>`;
Then add ${revealHeaderHTML} to the s-journal innerHTML right after the greeting div.

Before writing code: verify matchArch, escapeHtml, and day exist in renderJournal scope in the CURRENT file; if matchArch does not exist, find how the partner archetype is actually accessed (state.match?.partner?.archetype against the archetypes map) and adapt. Guard nightsLeft so it never renders negative past Day 21.

### C. Item 9b — proactive nudge to the quiet partner
Today only the waiting user sees an in-app card when their partner goes quiet. Build the missing half: when a user has not sealed an entry for 2 consecutive days and their partner HAS been writing, send the quiet user one push (if subscribed) and one email (via lib/email.js) saying, in voice:

Subject: "Your partner is still writing."
Body line: "Tonight's prompt is open. One honest line is enough."

Constraints: fire at most once per quiet spell (track last_nudge in the DB, propose the minimal schema addition), never on Day 21+, never to unmatched users, respect notification preferences. Show me the schema change, the scheduler hook (server.js already has scheduling), and the email template before writing anything. This is the audit's #1 retention killer; it is worth doing carefully.

## P2 block (one commit each, in this order)

### D. Archetype naming consistency
Canonical names are the long set: The Retreating Protector, The Anxious Connector, The Invisible Performer, The Drifting Disconnector. Grep app.html, index.html, app.js, and any email templates for the short set (The Protector, The Connector, The Performer, The Disconnector) and unify. Also ensure "ECP-11" is expanded as "Emotional Connection Profile" at its first occurrence on each page.

### E. Silent Room presence copy + IST day boundary
Apply this logic (re-implement if the old patch conflicts):
- routes/silent.js getPresenceCount: the day boundary must be IST, not server UTC. Replace datetime('now','start of day') with datetime('now','+5 hours','+30 minutes','start of day','-5 hours','-30 minutes').
- public/app.js showSilentFeed presence text: 0 → "Quiet here so far. Add the first line of the day."; n → "N person has / people have written here today"; fetch failure → "Add a line to the room."

### F. Archetype reveal as a full-screen moment
After the ECP-11 completes, the result currently renders as a scroll-to card. Make it a full-screen beat: archetype emoji + canonical name + its one-line quote, on the cosmic background, with two actions: "Continue" and "Share my archetype". Share uses the Web Share API with a text fallback (copy to clipboard): "I got The Invisible Performer on the ECP-11. mymentallyprepare.com". No image generation yet; that is a later pass. Propose the screen markup and flow before coding.

### G. Day 7 and Day 14 beats
In renderJournal, when day === 7: above the prompt, a quiet card: "Week one, sealed." plus the user's own Day 1 first line (truncate ~80 chars) with "You wrote this six nights ago." When day === 14: "One week left. What do you want to know before the reveal?" Reuse the existing nudge/special-day card pattern; no new components. Verify how Day 1 entry text is fetched client-side before proposing.

### H. Safety link near the hero
index.html: add one line under the hero reassurance text: a link to /safety reading "How reports, blocking, and the 18+ rule work". Match existing link styling. One line, no redesign.

### I. Smoke tests for the two hearts
Extend test/smoke.js with assertions for: (1) matching never pairs two users from the same normalized college, (2) an entry sealed today is not visible to the partner until after the IST midnight boundary, (3) presence count uses the IST boundary (regression for item E). Follow the existing test file's patterns exactly.

## Rules
- Re-grep before every edit; trust nothing from June 5 line numbers.
- All copy through the voice gate: no em-dashes, no filler, no wellness-speak.
- If an item turns out to be already done in current code (it has happened twice), say so, mark it clean, and move on.
- Stop after item C and wait for my explicit go before starting the P2 block.
