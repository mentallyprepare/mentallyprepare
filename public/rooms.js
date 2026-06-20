/* Rooms — frontend logic. Anonymous topic walls with peer comments.
   Talks to the endpoints in routes/rooms.js. Cookies carry the session. */

// ── config ──
const NEEDS = [
  { key: 'listen',    ico: '👂', short: 'just listen',  badge: 'wants to be heard' },
  { key: 'think',     ico: '💭', short: 'help me think', badge: 'thinking it through' },
  { key: 'share',     ico: '🤝', short: 'share with me', badge: 'wants company in it' },
  { key: 'encourage', ico: '🌤️', short: 'encourage me',  badge: 'could use warmth' },
  { key: 'quiet',     ico: '🕯️', short: 'sit quietly',   badge: 'wants it witnessed' },
];
const NEED_MAP = Object.fromEntries(NEEDS.map(n => [n.key, n]));

// The need-aware nudge shown in the reply composer (pure frontend).
const NUDGE = {
  listen:    'They asked to be heard, not advised. A quiet "me too" lands deeper than a fix.',
  think:     "They're trying to think this through. Help them find their own answer, don't hand them yours.",
  share:     'They wanted company in this. Share what it stirred in you — not a solution.',
  encourage: 'They could use some warmth right now. Tell them what you can see in them.',
  quiet:     'They just wanted this witnessed. Sometimes simply being here is enough.',
};

const REACTIONS = [
  { key: 'relate',    label: 'I relate',     ico: '🤍' },
  { key: 'listening', label: "I'm listening", ico: '👂' },
  { key: 'notalone',  label: "Not alone",    ico: '🫂' },
  { key: 'support',   label: 'Sending care', ico: '✨' },
];

// ── api helper ──
const api = (url, opts = {}) =>
  fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts })
    .then(async (r) => {
      if (r.status === 401) { window.location.href = '/app'; throw new Error('Please sign in'); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    });

// ── tiny helpers ──
const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function timeLeft(expiresAt) {
  const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
  if (ms <= 0) return 'fading';
  const days = Math.floor(ms / 86400000);
  if (days >= 30) return '';                 // long-lived seed openers — no countdown
  if (days >= 2) return `fades in ${days}d`;
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h >= 1 ? `fades in ${h}h` : `fades in ${m}m`;
}

// ── navigation ──
let view = 'lobby';          // lobby | wall | thread | crisis
let currentRoom = null;      // slug
let history = ['lobby'];

function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
  $('s-' + screen).classList.add('on');
  $('backBtn').style.display = screen === 'lobby' ? 'none' : 'inline-block';
  view = screen;
  window.scrollTo(0, 0);
}
function goBack() {
  if (view === 'thread') return openWall(currentRoom);
  if (view === 'wall' || view === 'crisis') return openLobby();
  openLobby();
}

// ── lobby ──
async function openLobby() {
  show('lobby');
  try {
    const { rooms } = await api('/api/rooms');
    const el = $('lobbyList');
    if (!rooms.length) { el.innerHTML = '<div class="empty">No rooms are open right now.</div>'; return; }
    el.innerHTML = rooms.map((r) => `
      <button class="room-card" onclick="openWall('${esc(r.slug)}')">
        <div class="rc-name">${esc(r.name)}</div>
        <div class="rc-sub">${esc(r.subtitle || '')}</div>
        ${r.frozen ? '<span class="rc-frozen">paused for a moment</span>' : ''}
        <span class="rc-arrow">→</span>
      </button>`).join('');
  } catch (e) { $('lobbyList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ── wall ──
let selectedNeed = null;

function renderNeedGrid() {
  selectedNeed = null;
  $('needGrid').innerHTML = NEEDS.map((n) => `
    <button type="button" class="need-opt" data-need="${n.key}" onclick="pickNeed('${n.key}')">
      <span class="no-ico">${n.ico}</span><span class="no-lbl">${esc(n.short)}</span>
    </button>`).join('');
}
function pickNeed(key) {
  selectedNeed = key;
  document.querySelectorAll('.need-opt').forEach((b) =>
    b.classList.toggle('on', b.dataset.need === key));
}

async function openWall(slug) {
  currentRoom = slug;
  show('wall');
  renderNeedGrid();
  $('cardBody').value = ''; $('cardCount').textContent = '0 / 400'; $('cardErr').style.display = 'none';
  $('wallList').innerHTML = '<div class="spinner">· · ·</div>';
  try {
    const { room, cards } = await api(`/api/rooms/${slug}/cards`);
    $('wallEyebrow').textContent = room.frozen ? 'Room · paused' : 'Room';
    $('wallName').textContent = room.name;
    $('wallSub').textContent = room.subtitle || '';
    $('composer').style.display = room.frozen ? 'none' : 'block';
    renderCards(cards);
  } catch (e) { $('wallList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function renderCards(cards) {
  const el = $('wallList');
  if (!cards.length) {
    el.innerHTML = '<div class="empty">This wall is quiet right now.<br>You could be the first to leave something.</div>';
    return;
  }
  el.innerHTML = cards.map((c) => {
    const need = NEED_MAP[c.support_need] || { ico: '·', badge: c.support_need };
    const reacts = REACTIONS.map((r) => `
      <button class="react-btn" data-card="${c.id}" data-kind="${r.key}" onclick="toggleReact(${c.id},'${r.key}',this)">
        <span>${r.ico}</span><span>${esc(r.label)}</span><span class="n">${c.reactions[r.key] || 0}</span>
      </button>`).join('');
    return `
      <div class="wall-card">
        <span class="need-badge"><span class="dot"></span>${need.ico} ${esc(need.badge)}</span>
        <div class="body">${esc(c.body)}</div>
        <div class="react-row">${reacts}</div>
        <div class="card-foot">
          <button class="comment-link" onclick="openThread(${c.id})">
            ${c.comment_count ? `${c.comment_count} ${c.comment_count === 1 ? 'reply' : 'replies'} →` : 'Be the first to reply →'}
          </button>
          <span class="fade-time">${esc(timeLeft(c.expires_at))}</span>
        </div>
      </div>`;
  }).join('');
}

async function submitCard() {
  const body = $('cardBody').value.trim();
  const errEl = $('cardErr'), btn = $('postCardBtn');
  errEl.style.display = 'none';
  if (!selectedNeed) { errEl.textContent = 'Pick what you need from the room first.'; errEl.style.display = 'block'; return; }
  if (!body) { errEl.textContent = 'Write something before you post.'; errEl.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = 'Leaving it…';
  try {
    const res = await api(`/api/rooms/${currentRoom}/cards`, {
      method: 'POST', body: JSON.stringify({ support_need: selectedNeed, body }),
    });
    if (res.crisis) { showCrisis(res.message, true); return; }
    $('cardBody').value = ''; $('cardCount').textContent = '0 / 400';
    toast('It’s on the wall. You’re not the only one.');
    openWall(currentRoom);
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Leave it on the wall';
  }
}

// ── reactions ──
async function toggleReact(cardId, kind, btn) {
  if (btn.disabled) return; btn.disabled = true;
  try {
    const res = await api(`/api/cards/${cardId}/react`, { method: 'POST', body: JSON.stringify({ kind }) });
    document.querySelectorAll(`.react-btn[data-card="${cardId}"]`).forEach((b) => {
      const k = b.dataset.kind;
      b.querySelector('.n').textContent = res.reactions[k] || 0;
      b.classList.toggle('on', res.mine.includes(k));
    });
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

// ── thread ──
async function openThread(cardId) {
  show('thread');
  $('threadList').innerHTML = '<div class="spinner">· · ·</div>';
  $('threadOrigin').innerHTML = ''; $('threadNudge').textContent = '';
  $('commentBody').value = ''; $('commentCount').textContent = '0 / 280'; $('commentErr').style.display = 'none';
  $('postCommentBtn').dataset.card = cardId;
  try {
    const { card, comments } = await api(`/api/cards/${cardId}/comments`);
    const need = NEED_MAP[card.support_need] || { ico: '·', badge: card.support_need };
    $('threadOrigin').innerHTML = `
      <div class="thread-origin">
        <span class="need-badge"><span class="dot"></span>${need.ico} ${esc(need.badge)}</span>
        <div class="body" style="font-family:'Lora',serif;font-style:italic;font-size:15px;color:var(--ink);line-height:1.8;white-space:pre-wrap;word-break:break-word">${esc(card.body)}</div>
      </div>`;
    $('threadNudge').textContent = NUDGE[card.support_need] || 'Be gentle. They came here on purpose.';
    renderComments(comments);
  } catch (e) { $('threadList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function renderComments(comments) {
  const el = $('threadList');
  if (!comments.length) { el.innerHTML = '<div class="empty">No replies yet. Yours could be the first.</div>'; return; }
  el.innerHTML = comments.map((c) => `
    <div class="comment" data-id="${c.id}">
      <div class="ctext">${esc(c.body)}</div>
      <div class="cfoot">
        <span class="ctime">a quiet reply</span>
        <button class="flag-btn" title="Report this reply" onclick="reportComment(${c.id},this)">⚑ report</button>
      </div>
    </div>`).join('');
}

async function submitComment() {
  const btn = $('postCommentBtn'), cardId = btn.dataset.card;
  const body = $('commentBody').value.trim();
  const errEl = $('commentErr'); errEl.style.display = 'none';
  if (!body) { errEl.textContent = 'Write something before you reply.'; errEl.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await api(`/api/cards/${cardId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    if (res.crisis) { showCrisis(res.message, true); return; }
    $('commentBody').value = ''; $('commentCount').textContent = '0 / 280';
    toast('Sent. Thank you for showing up for them.');
    openThread(cardId);
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Reply gently';
  }
}

async function reportComment(commentId, btn) {
  if (btn.classList.contains('done')) return;
  btn.disabled = true;
  try {
    const res = await api(`/api/comments/${commentId}/report`, { method: 'POST' });
    btn.classList.add('done'); btn.textContent = '⚑ reported';
    toast(res.hidden ? 'Thank you — it’s been hidden.' : 'Thank you. A moderator will look.');
  } catch (e) { btn.disabled = false; toast(e.message); }
}

// ── crisis signpost (mirrors the journaling/wall flow verbatim) ──
function showCrisis(message, held) {
  const headingText = held
    ? "What you wrote sounds like it comes from a really heavy place. We didn't post it publicly — not as a penalty, but because we want to make sure you're okay first."
    : '';
  const crisisMsg = message || "If things feel like too much right now, you don't have to sit with it alone. These people are here, any time:";
  $('s-crisis').innerHTML = `
    <div class="crisis-wrap">
      <div class="eyebrow">Support</div>
      <h1 class="crisis-title">You're not alone</h1>
      ${headingText ? `<p class="crisis-held">${esc(headingText)}</p>` : ''}
      <p class="crisis-msg">${esc(crisisMsg)}</p>
      <div class="helplines">
        <div class="helpline primary">
          <strong>Tele MANAS</strong>
          <span class="num">14416</span>
          <span class="alt">or 1800-89-14416</span>
          <span class="hrs">24×7 · 20 languages</span>
        </div>
        <div class="helpline">
          <strong>Vandrevala Foundation</strong>
          <span class="num">1860-266-2345</span>
          <span class="hrs">24×7</span>
        </div>
        <div class="helpline">
          <strong>AASRA</strong>
          <span class="num">+91 98204 66726</span>
          <span class="hrs">24×7</span>
        </div>
        <div class="helpline">
          <strong>iCall (TISS)</strong>
          <span class="num">022-2552 1111</span>
          <span class="hrs">Mon–Sat, 8am–10pm</span>
        </div>
      </div>
      <button class="btn-ghost" style="margin-top:18px" onclick="openWall(currentRoom)">Back to the room</button>
    </div>`;
  show('crisis');
}

// ── char counters ──
function wireCount(taId, countId, max) {
  const ta = $(taId), cc = $(countId);
  ta.addEventListener('input', () => {
    const n = ta.value.length;
    cc.textContent = `${n} / ${max}`;
    cc.classList.toggle('over', n > max);
  });
}

// ── stars ──
function makeStars() {
  const c = $('stars'); let html = '';
  for (let i = 0; i < 70; i++) {
    const s = (Math.random() * 1.6 + 0.4).toFixed(1);
    html += `<span class="star" style="left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;width:${s}px;height:${s}px;--d:${(Math.random() * 4 + 2).toFixed(1)}s;--dl:${(Math.random() * 4).toFixed(1)}s;--a1:${(Math.random() * 0.1).toFixed(2)};--a2:${(Math.random() * 0.4 + 0.2).toFixed(2)}"></span>`;
  }
  c.innerHTML = html;
}

// ── boot ──
makeStars();
wireCount('cardBody', 'cardCount', 400);
wireCount('commentBody', 'commentCount', 280);
openLobby();
