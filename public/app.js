// ═══════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════
async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

let state = null;
async function loadState() {
  try { state = await api('GET', '/me'); return true; }
  catch { state = null; return false; }
}

// ═══════════════════════════════════════
// DATA
// ═══════════════════════════════════════
const questions = [
  { text:'I find it easy to share what I\'m really feeling with others.',
    category:'Emotional Disclosure', axis:'openness', reverse:false },
  { text:'Being emotionally vulnerable with someone feels safe to me.',
    category:'Vulnerability Comfort', axis:'openness', reverse:false },
  { text:'When I\'m struggling, I reach out to the people around me.',
    category:'Support Seeking', axis:'openness', reverse:false },
  { text:'I can usually identify exactly what I\'m feeling.',
    category:'Emotional Awareness', axis:'awareness', reverse:false },
  { text:'I often wish I had someone I could be completely honest with.',
    category:'Connection Need', axis:'awareness', reverse:true },
  { text:'I sometimes feel alone even when I\'m surrounded by people.',
    category:'Loneliness Recognition', axis:'awareness', reverse:true },
  { text:'I worry people will judge me if they see the real me.',
    category:'Fear of Judgment', axis:'guard', reverse:false },
  { text:'I keep my feelings to myself even when they\'re overwhelming.',
    category:'Emotional Suppression', axis:'guard', reverse:false },
  { text:'I show a version of myself to others that isn\'t quite real.',
    category:'Performative Behaviour', axis:'guard', reverse:false },
  { text:'I believe most people would try to understand me if I opened up.',
    category:'Trust in Others', axis:'reciprocity', reverse:false },
  { text:'I feel comfortable when someone shares their emotional struggles with me.',
    category:'Empathic Comfort', axis:'reciprocity', reverse:false }
];

const archetypes = {
  protector: { emoji:'🌑', name:'The Retreating Protector', quote:'"You want in. You just keep locking the door."', match:'connector', matchName:'The Anxious Connector', matchEmoji:'🌒',
    description:'You feel things deeply but pull back before anyone gets close enough to see it. Your default is distance — not because you don\'t care, but because closeness feels like a risk you can\'t afford.',
    strengths:['Deep emotional awareness','Strong personal boundaries','Thoughtful and intentional','Protective of those you trust'],
    growth:['Letting people stay close without pushing them away','Recognising that vulnerability isn\'t weakness','Trusting connection before needing proof of safety'] },
  connector: { emoji:'🌒', name:'The Anxious Connector', quote:'"You give everything. It still doesn\'t feel like enough."', match:'protector', matchName:'The Retreating Protector', matchEmoji:'🌑',
    description:'You reach toward people instinctively. You\'re the one who texts first, checks in, remembers things nobody else does. But underneath the warmth, there\'s a quiet panic — what if I\'m too much?',
    strengths:['Naturally empathetic and caring','Emotionally expressive','Deeply loyal in relationships','Creates warmth in every room'],
    growth:['Receiving care without guilt','Letting silence be comfortable, not threatening','Trusting that people stay because they want to'] },
  performer: { emoji:'🌓', name:'The Invisible Performer', quote:'"Everyone knows you. Nobody knows you."', match:'disconnector', matchName:'The Drifting Disconnector', matchEmoji:'🌔',
    description:'You\'re great in social settings. People like you. But when the room empties, you feel something hollow. You\'ve perfected the version people want — and lost track of the real one.',
    strengths:['Socially adaptable and skilled','High emotional intelligence','Can connect with anyone quickly','Deeply perceptive of others\' needs'],
    growth:['Showing the unpolished version of yourself','Letting relationships go deeper than surface','Admitting when you\'re not okay instead of performing fine'] },
  disconnector: { emoji:'🌔', name:'The Drifting Disconnector', quote:'"It always starts well. Then you pull back."', match:'performer', matchName:'The Invisible Performer', matchEmoji:'🌓',
    description:'Connections start strong — there\'s excitement, warmth, real potential. Then something shifts. You lose interest, or it gets too close, and you drift. Not dramatically. Just quietly.',
    strengths:['Independent and self-sufficient','Comfortable with solitude','Non-clingy and emotionally steady','Open to new experiences'],
    growth:['Staying present when connection gets uncomfortable','Noticing the drift before it becomes distance','Choosing to stay — even when leaving is easier'] }
};

const prompts = [
  '"What\'s one thing you wish someone would just ask you about?"',
  '"What did you hide today because it felt too small to explain?"',
  '"When do you become distant, even when you want closeness?"',
  '"What are you tired of carrying alone?"',
  '"Where do you make yourself smaller to stay accepted?"',
  '"What truth would you write if nobody judged it?"',
  '"What moment made you feel seen, even a little?"',
  '"What does emotional effort look like to you?"',
  '"What kind of connection are you ready for now?"',
  '"What\'s the last thing that genuinely moved you?"',
  '"If you could say one honest thing to someone you\'ve lost touch with, what would it be?"',
  '"What are you pretending isn\'t affecting you?"',
  '"When was the last time you let someone see the real version of you?"',
  '"What part of yourself do you think people misread?"',
  '"What would it look like if you stopped performing?"',
  '"What scares you about being known?"',
  '"If your loneliness had a shape, what would it look like?"',
  '"What\'s one boundary you need but can\'t set?"',
  '"What is the thing you most want someone to understand about you?"',
  '"Write a letter to the person you\'ll meet on Day 21."',
  '"Would you like to know who has been writing to you?"'
];

const writingTips = [
  'Write for yourself first. Honesty matters more than polish.',
  'If nothing comes to mind, describe the last thing that made you feel something.',
  'You don\'t have to answer the prompt directly. Let it take you somewhere unexpected.',
  'Short entries are fine. One honest sentence beats three vague paragraphs.',
  'Try starting with "I feel..." or "Today I noticed..."',
  'Don\'t censor yourself. The seal means this stays private until midnight.',
  'If you\'re stuck, write about being stuck. That counts.',
  'Think about what you\'d want your partner to know about your day.',
  'There\'s no wrong way to do this. Just show up and be honest.'
];

// ═══════════════════════════════════════
// LOCAL STATE
// ═══════════════════════════════════════
let scanIndex = 0;
let scanAnswers = Array(questions.length).fill(null);
let localScores = {};
let localArchetype = '';
let currentMood = '🌓';
let matchPollTimer = null;
let countdownTimer = null;

// ═══════════════════════════════════════
// STARS
// ═══════════════════════════════════════
(function(){
  const c = document.getElementById('stars');
  const cols = ['#F8F2FF','#EBB4C2','#E8D0A0','#B09FCC'];
  for(let i=0;i<50;i++){
    const s = document.createElement('div'); s.className='star';
    const sz = Math.random()*1.6+.25;
    s.style.cssText = `width:${sz}px;height:${sz}px;left:${Math.random()*100}%;top:${Math.random()*100}%;background:${cols[~~(Math.random()*4)]};--d:${3+Math.random()*5}s;--dl:-${Math.random()*5}s;--a1:${.04+Math.random()*.08};--a2:${.2+Math.random()*.4};`;
    c.appendChild(s);
  }
})();

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function go(id) {
  const prev = document.querySelector('.screen.active');
  const el = document.getElementById(id);
  if (prev === el) return;
  if (prev) prev.classList.remove('active','entering');
  el.classList.add('active','entering');
  window.scrollTo(0,0);
}

function toast(msg, duration) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), duration || 2200);
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

function typingDots() { return '<div class="typing-dots"><span></span><span></span><span></span></div>'; }

// ═══════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════
function startApp() {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('app-area').style.display = 'block';
  document.getElementById('navCta').textContent = '← Back to Home';
  document.getElementById('navCta').onclick = function() { showLanding(); };
  // Close mobile menu if open
  document.querySelector('.site-nav-links').classList.remove('open');
  // If already logged in, route to correct screen
  if (state) { routeToScreen(); }
  else { go('s-splash'); }
  window.scrollTo(0, 0);
}

function showLanding() {
  document.getElementById('landing').style.display = '';
  document.getElementById('app-area').style.display = 'none';
  document.getElementById('navCta').textContent = 'Start Your Journey';
  document.getElementById('navCta').onclick = function() { startApp(); };
  window.scrollTo(0, 0);
}

function navTo(id) {
  showLanding();
  setTimeout(function() {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, 100);
  document.querySelector('.site-nav-links').classList.remove('open');
  document.getElementById('siteMenuBtn').setAttribute('aria-expanded', 'false');
}

function bindStaticUi() {
  const siteNavLogo = document.getElementById('siteNavLogo');
  const navCta = document.getElementById('navCta');
  const siteMenuBtn = document.getElementById('siteMenuBtn');
  const heroStartBtn = document.getElementById('heroStartBtn');
  const heroHowLink = document.getElementById('heroHowLink');
  const heroScrollBtn = document.getElementById('heroScrollBtn');

  if (siteNavLogo) {
    siteNavLogo.addEventListener('click', function(e) {
      e.preventDefault();
      showLanding();
    });
  }

  if (navCta) navCta.onclick = startApp;
  if (siteMenuBtn) siteMenuBtn.addEventListener('click', toggleSiteMenu);
  if (heroStartBtn) heroStartBtn.addEventListener('click', startApp);

  if (heroHowLink) {
    heroHowLink.addEventListener('click', function(e) {
      e.preventDefault();
      navTo('how');
    });
  }

  if (heroScrollBtn) {
    heroScrollBtn.addEventListener('click', function() {
      const section = document.getElementById('l-problem');
      if (section) section.scrollIntoView({ behavior: 'smooth' });
    });
  }

  document.querySelectorAll('[data-nav-target]').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      navTo(link.getAttribute('data-nav-target'));
    });
  });

  document.querySelectorAll('.perm-toggle').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      togglePerm(toggle);
    });
  });

  const entryDetail = document.getElementById('entry-detail');
  if (entryDetail) {
    entryDetail.addEventListener('click', function(e) {
      if (e.target === entryDetail) closeEntryDetail();
    });
  }

  const safetyOverlay = document.getElementById('safety-overlay');
  if (safetyOverlay) {
    safetyOverlay.addEventListener('click', function(e) {
      if (e.target === safetyOverlay) closeSafety();
    });
  }
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
(async function init() {
  bindStaticUi();
  const loggedIn = await loadState();
  if (!loggedIn) return; // stay on landing

  // Auto-start app for logged-in users
  startApp();

  if (!state.user.archetype) {
    go('s-scan-intro');
  } else if (!state.match) {
    renderWaiting(); go('s-waiting');
  } else if (state.match.day >= 21) {
    handleRevealFlow();
  } else {
    const todayDone = state.entries.find(e => e.day === state.match.day);
    if (todayDone) { renderSealed(); go('s-sealed'); }
    else { renderJournal(); go('s-journal'); }
  }
})();

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════
async function register() {
  const name = document.getElementById('inp-name').value.trim();
  const college = document.getElementById('inp-college').value.trim();
  const email = document.getElementById('inp-email').value.trim();
  const password = document.getElementById('inp-password').value;
  const yearEl = document.querySelector('.year-btn.on');
  const year = yearEl ? yearEl.textContent.trim() : '3rd';

  if (!name) { toast('Please enter your name'); return; }
  if (!college) { toast('Please enter your college'); return; }
  if (!email) { toast('Please enter your email'); return; }
  if (!password || password.length < 8) { toast('Password must be at least 8 characters'); return; }

  const ageChecked = document.getElementById('ageCheckbox').checked;
  const consentGiven = document.getElementById('consentCheckbox').checked;
  if (!ageChecked) { toast('You must confirm you are 18+ or have guardian consent'); return; }
  if (!consentGiven) { toast('Please accept the Privacy Policy to continue'); return; }

  try {
    await api('POST', '/register', { name, email, password, college, year, gender: prefGender, matchGenderPref: prefMatchGender, matchYearPref: prefMatchYear, consentGiven });
    await loadState();
    // Make sure app area is visible
    document.getElementById('landing').style.display = 'none';
    document.getElementById('app-area').style.display = 'block';
    toast('Account created! ✦');
    go('s-scan-intro');
  } catch (e) { toast(e.message); }
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { toast('Enter email and password'); return; }

  try {
    await api('POST', '/login', { email, password });
    await loadState();
    // Make sure app area is visible
    document.getElementById('landing').style.display = 'none';
    document.getElementById('app-area').style.display = 'block';
    toast('Welcome back! ✦');
    routeToScreen();
  } catch (e) { toast(e.message); }
}

async function logout() {
  await api('POST', '/logout');
  state = null;
  sessionStorage.removeItem('mp-draft');
  showLanding();
  toast('Logged out ✓');
}

function routeToScreen() {
  if (!state) { go('s-splash'); return; }
  if (!state.user.archetype) { go('s-scan-intro'); return; }
  if (!state.match) { renderWaiting(); go('s-waiting'); return; }
  if (state.match.day >= 21) { handleRevealFlow(); return; }
  const todayDone = state.entries.find(e => e.day === state.match.day);
  if (todayDone) { renderSealed(); go('s-sealed'); }
  else { renderJournal(); go('s-journal'); }
}

// ═══════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════
function pickYear(el) {
  el.closest('.year-row').querySelectorAll('.year-btn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
}
function togglePerm(el) {
  el.classList.toggle('off');
  el.setAttribute('aria-pressed', String(!el.classList.contains('off')));
  if (!el.classList.contains('off') && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(function(result) {
      if (result === 'granted' && 'serviceWorker' in navigator) subscribeToPush();
    });
  }
}

// ═══════════════════════════════════════
// PREFERENCES
// ═══════════════════════════════════════
let prefGender = 'prefer_not_to_say';
let prefMatchGender = 'any';
let prefMatchYear = 'any';

function pickPref(el, gridId, type) {
  document.getElementById(gridId).querySelectorAll('.pref-btn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  const val = el.textContent.trim().toLowerCase().replace(/ /g, '_');
  if (type === 'gender') prefGender = val;
  else if (type === 'matchGender') {
    if (val === 'anyone') prefMatchGender = 'any';
    else if (val === 'same_gender') prefMatchGender = prefGender;
    else prefMatchGender = val;
  }
  else if (type === 'matchYear') {
    if (val === 'any_year') prefMatchYear = 'any';
    else if (val === 'same_year') {
      const yearEl = document.querySelector('.year-btn.on');
      prefMatchYear = yearEl ? yearEl.textContent.trim() : (state && state.user ? state.user.year : 'any');
    }
    else if (val.includes('±') || val.includes('1')) prefMatchYear = '±1_year';
    else prefMatchYear = val;
  }
}

// ═══════════════════════════════════════
// SAFETY
// ═══════════════════════════════════════
function showSafety() { document.getElementById('safety-overlay').classList.add('show'); }
function closeSafety() { document.getElementById('safety-overlay').classList.remove('show'); }

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  closeSafety();
  closeEntryDetail();
});

// ═══════════════════════════════════════
// SCAN
// ═══════════════════════════════════════
function startScan() {
  scanIndex = 0;
  scanAnswers = Array(questions.length).fill(null);
  renderScan(); go('s-scan');
}

function renderScan() {
  const q = questions[scanIndex];
  const pct = Math.round((scanIndex / questions.length) * 100);
  const val = scanAnswers[scanIndex];
  const sliderVal = val !== null ? val : 4;
  const labels = ['','Strongly disagree','Disagree','Slightly disagree','Neutral','Slightly agree','Agree','Strongly agree'];

  const inputHTML = `<div class="slider-wrap" style="margin-bottom:24px;">
    <input type="range" class="scan-slider" min="1" max="7" value="${sliderVal}" oninput="pickScanSlider(this.value)" style="-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:4px;background:linear-gradient(90deg,var(--purple),var(--rose));outline:none;cursor:pointer"/>
    <div class="scale-labels" style="display:flex;justify-content:space-between;font-size:9px;color:var(--ink-s);margin-top:8px;padding:0 2px"><span>Not at all like me</span><span>Very much like me</span></div>
    <div style="text-align:center;margin-top:12px;font-family:'Playfair Display',serif;font-size:14px;color:${val !== null ? 'var(--rose-l)' : 'var(--ink-s)'};transition:color .2s" id="slider-label">${val !== null ? labels[val] : 'Slide to respond'}</div>
  </div>`;

  const isLast = scanIndex === questions.length - 1;
  document.getElementById('s-scan').innerHTML = `
    <div class="quiz-header" style="padding:20px 24px 0;">
      <button class="back-btn" onclick="${scanIndex===0?'go(\'s-scan-intro\')':'prevScanQ()'}"><span style="font-size:16px;">←</span> Back</button>
      <div class="progress-row"><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><div class="progress-label">${scanIndex+1} of ${questions.length}</div></div>
      <div class="q-category">${escapeHtml(q.category)}</div>
    </div>
    <div style="padding:0 24px;">
      <div class="q-card">
        <div class="q-num">Question ${scanIndex+1}</div>
        <div class="q-text">${escapeHtml(q.text)}</div>
      </div>
      ${inputHTML}
      <div class="nav-row">
        <button class="btn-skip" onclick="nextScanQ()">Skip</button>
        <button class="btn btn-next" onclick="${isLast?'submitScan()':'nextScanQ()'}" ${isLast?'style="background:linear-gradient(135deg,var(--gold),var(--rose-d));"':''}>${isLast?'✦ See my profile':'Continue →'}</button>
      </div>
    </div>`;

  // style the slider thumb
  const slider = document.querySelector('.scan-slider');
  if (slider) {
    const style = document.createElement('style');
    style.textContent = '.scan-slider::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:var(--ink);cursor:pointer;box-shadow:0 0 12px rgba(212,133,154,.4)}.scan-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:var(--ink);cursor:pointer;border:none}';
    if (!document.getElementById('slider-thumb-style')) { style.id = 'slider-thumb-style'; document.head.appendChild(style); }
  }
}

function pickScanSlider(val) {
  scanAnswers[scanIndex] = parseInt(val);
  const labels = ['','Strongly disagree','Disagree','Slightly disagree','Neutral','Slightly agree','Agree','Strongly agree'];
  const lbl = document.getElementById('slider-label');
  if (lbl) { lbl.textContent = labels[val]; lbl.style.color = 'var(--rose-l)'; }
}
function nextScanQ() { if (scanIndex < questions.length - 1) { scanIndex++; renderScan(); go('s-scan'); } }
function prevScanQ() { if (scanIndex > 0) { scanIndex--; renderScan(); go('s-scan'); } }

function calculateScoresLocal() {
  const totals = { openness:0, awareness:0, guard:0, reciprocity:0 };
  const counts = { openness:0, awareness:0, guard:0, reciprocity:0 };
  questions.forEach((q, idx) => {
    let val = scanAnswers[idx];
    if (val === null) val = 4; // neutral default for skipped
    // reverse-scored items: high agreement = low score on that dimension
    const score = q.reverse ? (8 - val) : val;
    totals[q.axis] += score;
    counts[q.axis] += 7; // max per item is 7
  });
  const o = counts.openness ? Math.round((totals.openness / counts.openness) * 100) : 50;
  const a = counts.awareness ? Math.round((totals.awareness / counts.awareness) * 100) : 50;
  const g = counts.guard ? Math.round((totals.guard / counts.guard) * 100) : 50;
  const r = counts.reciprocity ? Math.round((totals.reciprocity / counts.reciprocity) * 100) : 50;
  localScores = { openness:o, awareness:a, guard:g, reciprocity:r };

  // Map to archetype based on dominant pattern
  // High guard + low openness → protector (pulls back to protect)
  // High openness + low guard → connector (reaches toward people)
  // High guard + high awareness → performer (knows feelings but hides them)
  // Low openness + low awareness → disconnector (drifts away)
  if (g >= 60 && o < 50) localArchetype = 'protector';
  else if (o >= 55 && g < 50) localArchetype = 'connector';
  else if (g >= 50 && a >= 55) localArchetype = 'performer';
  else localArchetype = 'disconnector';
}

async function submitScan() {
  calculateScoresLocal();
  try {
    const { matched } = await api('POST', '/scan', { scores: localScores, archetype: localArchetype });
    await loadState();
    renderResult(matched);
    go('s-result');
  } catch (e) { toast(e.message); }
}

function renderResult(matched) {
  const archKey = state.user.archetype;
  const arch = archetypes[archKey];
  const s = state.user.scores;

  const actionBtn = matched
    ? `<button class="btn" onclick="goToJournal()" style="margin-bottom:10px;">✍️ Start writing — Day 1</button>`
    : `<button class="btn" onclick="renderWaiting();go('s-waiting')" style="margin-bottom:10px;">🔍 Find my match</button>`;

  document.getElementById('s-result').innerHTML = `
    <div class="result-tag">Your Connection Profile</div>
    <div class="result-glow"><div class="result-glow-inner">${arch.emoji}</div></div>
    <div class="result-type">${arch.name}</div>
    <p class="result-line">${arch.quote}</p>
    <div style="padding:0 24px;margin-bottom:14px;"><div style="font-family:'Lora',serif;font-style:italic;font-size:13.5px;color:var(--ink-m);line-height:1.85;text-align:center;">${arch.description}</div></div>
    <div class="result-card">
      <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:14px;">ECP-11 Profile</div>
      <div class="trait-row">
        <div class="trait"><div class="trait-top"><span class="trait-name">Openness</span><span class="trait-pct">${s.openness}%</span></div><div class="trait-bar"><div class="trait-fill" style="width:0%" data-w="${s.openness}%"></div></div></div>
        <div class="trait"><div class="trait-top"><span class="trait-name">Awareness</span><span class="trait-pct">${s.awareness}%</span></div><div class="trait-bar"><div class="trait-fill" style="width:0%" data-w="${s.awareness}%"></div></div></div>
        <div class="trait"><div class="trait-top"><span class="trait-name">Guard</span><span class="trait-pct">${s.guard}%</span></div><div class="trait-bar"><div class="trait-fill" style="width:0%" data-w="${s.guard}%"></div></div></div>
        <div class="trait"><div class="trait-top"><span class="trait-name">Reciprocity</span><span class="trait-pct">${s.reciprocity}%</span></div><div class="trait-bar"><div class="trait-fill" style="width:0%" data-w="${s.reciprocity}%"></div></div></div>
      </div>
    </div>
    <div class="match-box">
      <div class="match-icon">${arch.matchEmoji}</div>
      <div><div class="match-title">You'll be matched with</div><div class="match-name">${arch.matchName}</div></div>
    </div>
    ${actionBtn}
    <button class="share-btn" onclick="shareArchetype()" style="margin-bottom:10px;">📋 Share my archetype</button>`;
  setTimeout(() => {
    document.querySelectorAll('#s-result .trait-fill').forEach(bar => { bar.style.width = bar.dataset.w; });
  }, 400);
}

// ═══════════════════════════════════════
// WAITING FOR MATCH
// ═══════════════════════════════════════
function renderWaiting() {
  const arch = archetypes[state.user.archetype];
  const waitingInfo = state.waitingInfo || {};
  const day1Prompt = waitingInfo.day1Prompt || (prompts && prompts[0]) || 'Write about your day.';
  const draft = sessionStorage.getItem('mp-wait-draft') || '';
  document.getElementById('s-waiting').innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;">
      <div style="position:relative;margin-bottom:28px;">
        <div style="position:absolute;inset:-20px;border-radius:50%;border:1px solid rgba(201,169,110,.25);animation:ringExpand 3s ease-out infinite;"></div>
        <div style="position:absolute;inset:-20px;border-radius:50%;border:1px solid rgba(201,169,110,.25);animation:ringExpand 3s ease-out infinite;animation-delay:1.5s;"></div>
        <div class="moon-base" style="width:88px;height:88px;box-shadow:0 0 50px rgba(201,169,110,.55),0 0 100px rgba(201,169,110,.2);animation:float 5s ease-in-out infinite;"></div>
      </div>
      <div style="font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);opacity:.75;margin-bottom:12px;">Waiting for your match</div>
      <h2 style="font-family:'Playfair Display',serif;font-size:28px;font-weight:400;line-height:1.2;margin-bottom:14px;"><em style="font-style:italic;background:linear-gradient(135deg,var(--rose-l),var(--gold-l));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">Your archetype: ${arch.emoji} ${arch.name}</em></h2>
      <div style="font-size:15px;color:var(--ink-m);margin-bottom:18px;">Your match is on their way — usually within 24 hours.</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;width:100%;max-width:520px;margin:0 auto 18px auto;text-align:left;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;">
        <div style="font-size:13px;color:var(--ink);margin-bottom:8px;width:100%;max-width:100%;text-align:left;"><b>Day 1 Prompt:</b></div>
        <div style="font-size:15px;font-style:italic;color:var(--ink-m);margin-bottom:12px;width:100%;max-width:100%;text-align:left;">${escapeHtml(day1Prompt)}</div>
        <textarea id="wait-draft" placeholder="Start writing while you wait…" style="width:100%;min-width:0;max-width:100%;min-height:90px;border-radius:8px;border:1px solid var(--line);padding:10px;font-size:14px;box-sizing:border-box;margin-bottom:8px;">${escapeHtml(draft)}</textarea>
        <button class="btn" id="saveWaitEntryBtn" style="margin-top:10px;width:100%;max-width:100%;">Save Day 1 Entry</button>
        <div id="wait-entry-status" style="font-size:12px;color:var(--ink-s);margin-top:8px;width:100%;max-width:100%;text-align:center;"></div>
      </div>
      <div style="font-size:12px;color:var(--ink-s);margin-bottom:10px;">You'll be emailed as soon as your match arrives.</div>
    </div>`;

  document.getElementById('wait-draft').addEventListener('input', function(e) {
    sessionStorage.setItem('mp-wait-draft', e.target.value);
  });
  document.getElementById('saveWaitEntryBtn').addEventListener('click', async function() {
    const text = document.getElementById('wait-draft').value.trim();
    if (!text) { document.getElementById('wait-entry-status').textContent = 'Please write something first.'; return; }
    try {
      await api('POST', '/waiting-entry', { text });
      document.getElementById('wait-entry-status').textContent = 'Saved! Your Day 1 entry is ready for your match.';
      sessionStorage.removeItem('mp-wait-draft');
    } catch (e) {
      document.getElementById('wait-entry-status').textContent = 'Error saving entry.';
    }
  });

  clearInterval(matchPollTimer);
  matchPollTimer = setInterval(async () => {
    const ok = await loadState();
    if (ok && state.match) {
      clearInterval(matchPollTimer);
      toast('Match found! 🌙');
      renderJournal(); go('s-journal');
    }
  }, 15000);
}

async function devSetup() {
  try {
    await api('POST', '/dev/setup');
    await loadState();
    clearInterval(matchPollTimer);
    toast('Test partner created! 🌙');
    renderJournal(); go('s-journal');
  } catch (e) { toast(e.message); }
}

// ═══════════════════════════════════════
// JOURNAL
// ═══════════════════════════════════════
function goToJournal() {
  loadState().then((ok) => {
    if (!ok || !state) { go('s-splash'); return; }
    if (!state.match) { renderWaiting(); go('s-waiting'); return; }
    const todayDone = state.entries.find(e => e.day === state.match.day);
    if (todayDone) { renderSealed(); go('s-sealed'); }
    else { renderJournal(); go('s-journal'); }
  });
}

function renderJournal() {
  if (!state || !state.match) return;
  const day = state.match.day;
  const arch = archetypes[state.user.archetype];
  const matchArch = archetypes[state.match.partner.archetype];
  const prompt = state.match.currentPrompt;
  const draft = sessionStorage.getItem('mp-draft') || '';
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today = new Date();

  // Check if partner hasn't written for 3+ days
  let partnerInactiveCard = '';
  if (state.partnerEntries && state.partnerEntries.length > 0) {
    const lastPartnerDay = Math.max(...state.partnerEntries.map(e => e.day));
    if (day - lastPartnerDay >= 3) {
      partnerInactiveCard = `
        <div class="info-card" style="background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:18px auto 0 auto;max-width:520px;color:var(--ink-s);font-family:'Lora',serif;font-size:15px;text-align:center;">
          <div style="font-size:16px;font-family:'Playfair Display',serif;color:var(--ink-m);margin-bottom:6px;">Your partner hasn't written in a few days.</div>
          <div>This happens sometimes. Keep writing — your entries are saved and they'll see everything when they return.</div>
        </div>
      `;
    }
  }
  document.getElementById('s-journal').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div style="padding:16px 24px 0;"><div class="greeting">${getGreeting(state.user.name)}</div></div>
    ${partnerInactiveCard}
    <div class="streak reveal-on-scroll">
      <div class="streak-top"><div class="streak-lbl">Streak</div><div class="streak-ct">🔥 ${state.streak} days</div></div>
      <div class="pips">${Array.from({length:21},(_,i) => {
        if (i < day - 1) return '<div class="pip done"></div>';
        if (i === day - 1) return '<div class="pip now"></div>';
        return '<div class="pip"></div>';
      }).join('')}</div>
    </div>
    <div class="moon-block reveal-on-scroll"><div class="moon-base moon-sm"></div><div class="cd" id="cd">—</div><div class="cd-sub">until entries unseal</div></div>
    <div class="prompt-block reveal-on-scroll">
      <div class="eyebrow">Tonight's prompt</div>
      <div class="prompt-text">${escapeHtml(prompt)}</div>
      ${day % 7 === 0 ? '<div class="dare">⚡ Weekly dare</div>' : ''}
    </div>
    ${state.adaptivePrompt ? `<div class="adaptive-block reveal-on-scroll">
      <div class="adaptive-card">
        <div class="adaptive-ey">Based on what you've been writing</div>
        <div class="adaptive-theme">${escapeHtml(state.adaptivePrompt.label)}</div>
        <div class="adaptive-text">${escapeHtml(state.adaptivePrompt.prompt)}</div>
      </div>
    </div>` : ''}
    <div class="mood-block reveal-on-scroll">
      <div class="mood-lbl">How are you tonight?</div>
      <div class="moods">
        ${['🌑|Heavy','🌒|Quiet','🌓|Okay','🌔|Lighter','🌕|Good'].map(m => {
          const [e,w] = m.split('|');
          return `<button class="mood ${currentMood===e?'on':''}" type="button" data-mood="${e}" aria-pressed="${currentMood===e?'true':'false'}"><div class="mood-em">${e}</div><div class="mood-w">${w}</div></button>`;
        }).join('')}
      </div>
    </div>
    <div class="writing-tip"><div class="writing-tip-ico">💡</div><div class="writing-tip-text">${getWritingTip(day)}</div></div>
    <div class="write-block reveal-on-scroll">
      <div class="write-box">
        <div class="write-date">${dayNames[today.getDay()]}, ${today.getDate()} ${monthNames[today.getMonth()]} · Day ${day}</div>
        <textarea id="journal-draft" placeholder="Start writing…">${escapeHtml(draft)}</textarea>
        <div class="write-ft"><div class="ww" id="ww">${wordCount(draft)} words</div><div id="word-milestone"></div></div>
        <button class="btn-ghost" id="journalReportBtn" type="button" style="margin-top:8px;font-size:12px;float:right;">Report inappropriate content</button>
      </div>
    </div>
    // Report inappropriate content in journal entry
    ${state.streak >= 3 ? `<div class="streak-nudge reveal-on-scroll"><div class="streak-nudge-inner"><span style="font-size:16px;">🔥</span><div class="streak-nudge-text">${getStreakNudge(state.streak)}</div></div></div>` : ''}
    <div class="cta-block">
      <button class="btn" id="sealEntryBtn" type="button">🌙 Seal tonight's entry</button>
      <button class="btn-ghost" id="saveDraftBtn" type="button" style="margin-top:8px;">Save draft</button>
    </div>
    ${renderTabs('tonight')}`;
  document.querySelectorAll('#s-journal [data-mood]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setMood(btn.getAttribute('data-mood'), btn);
    });
  });
  const journalDraft = document.getElementById('journal-draft');
  if (journalDraft) journalDraft.addEventListener('input', function() { updateWordCount(journalDraft); });
  const journalReportBtn = document.getElementById('journalReportBtn');
  if (journalReportBtn) journalReportBtn.addEventListener('click', function() { reportEntry(); });
  const sealEntryBtn = document.getElementById('sealEntryBtn');
  if (sealEntryBtn) sealEntryBtn.addEventListener('click', sealEntry);
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  if (saveDraftBtn) saveDraftBtn.addEventListener('click', saveDraft);
  startCountdown();
  initScrollReveal('#s-journal');
}

function setMood(m, el) {
  currentMood = m;
  el.closest('.moods').querySelectorAll('.mood').forEach(function(x) {
    x.classList.remove('on');
    x.setAttribute('aria-pressed', 'false');
  });
  el.classList.add('on');
  el.setAttribute('aria-pressed', 'true');
}

function updateWordCount(el) {
  const n = el.value.trim().split(/\s+/).filter(Boolean).length;
  document.getElementById('ww').textContent = n + ' word' + (n!==1?'s':'');
  // Word milestones
  const milestoneEl = document.getElementById('word-milestone');
  if (milestoneEl) {
    const milestones = [
      { at: 50, ico: '✨', text: '50 words — you\'re finding your voice' },
      { at: 100, ico: '📝', text: '100 words — real honesty takes space' },
      { at: 200, ico: '💎', text: '200 words — this is deep writing' },
      { at: 300, ico: '🔥', text: '300+ words — your partner will feel this' }
    ];
    const hit = milestones.filter(m => n >= m.at).pop();
    if (hit && !milestoneEl.dataset.shown || (hit && milestoneEl.dataset.shown !== String(hit.at))) {
      milestoneEl.innerHTML = `<div class="word-milestone"><div class="word-milestone-ico">${hit.ico}</div><div class="word-milestone-text">${hit.text}</div></div>`;
      milestoneEl.dataset.shown = String(hit.at);
    } else if (!hit) {
      milestoneEl.innerHTML = '';
      milestoneEl.dataset.shown = '';
    }
  }
}

function wordCount(str) { return str && str.trim() ? str.trim().split(/\s+/).length : 0; }

function saveDraft() {
  const area = document.getElementById('journal-draft');
  if (area) sessionStorage.setItem('mp-draft', area.value);
  toast('Draft saved ✓');
}

async function sealEntry() {
  const area = document.getElementById('journal-draft');
  const text = area ? area.value.trim() : '';
  if (!text) { toast('Write something before sealing ✍️'); return; }

  try {
    const result = await api('POST', '/entry', { text, mood: currentMood });
    sessionStorage.removeItem('mp-draft');
    currentMood = '🌓';
    await loadState();

    // Safety check
    if (result.safety && result.safety.crisis) {
      showSafety();
    }
    if (result.safety && result.safety.pii) {
      toast('Tip: Avoid sharing personal contact info — anonymity keeps you safe 🔒');
    }

    celebrateStreak();
    renderSealed(); go('s-sealed');
  } catch (e) { toast(e.message); }
}

function startCountdown() {
  clearInterval(countdownTimer);
  function tick() {
    const now = new Date(), mid = new Date(now);
    mid.setHours(24,0,0,0);
    const d = mid - now;
    const h = String(Math.floor(d/3600000)).padStart(2,'0');
    const m = String(Math.floor((d%3600000)/60000)).padStart(2,'0');
    const s = String(Math.floor((d%60000)/1000)).padStart(2,'0');
    const el = document.getElementById('cd');
    if (el) el.textContent = `${h} : ${m} : ${s}`;
  }
  tick(); countdownTimer = setInterval(tick, 1000);
}

function renderSealed() {
  if (!state || !state.match) return;
  const day = state.match.day;
  const matchArch = archetypes[state.match.partner.archetype];
  const lastEntry = state.entries.length ? state.entries[0] : null;

  document.getElementById('s-sealed').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div class="sealed-hero">
      <div class="moon-base sealed-moon"></div>
      <div class="sealed-ey">Entry sealed ✦</div>
      <h2 class="sealed-h">Written.<br/><em>Waiting for midnight.</em></h2>
      <p class="sealed-p">Your entry is locked. You'll both unseal at midnight — together.</p>
    </div>
    ${lastEntry ? `<div class="sealed-card">
      <div class="sealed-card-top"><div class="sealed-card-lbl">Your entry · Day ${lastEntry.day} · ${lastEntry.mood}</div><div class="sealed-card-badge">🔒 sealed</div></div>
      <div class="sealed-txt">${escapeHtml(lastEntry.text)}</div>
      <div class="unseals">Unseals at midnight</div>
    </div>` : ''}
    <div class="partner-card">
      <div class="p-moon">${matchArch.emoji}</div>
      <div><div class="p-ey">Your partner</div><div class="p-name">${matchArch.name}</div><div class="p-status" id="partner-status-text">Checking… ${typingDots()}</div></div>
    </div>
    <div id="switch-banner-area"></div>
    <div style="height:40px;"></div>
    ${renderTabs('partner')}`;

  // Check partner activity
  checkPartnerStatus().then(ps => {
    const statusEl = document.getElementById('partner-status-text');
    const bannerEl = document.getElementById('switch-banner-area');
    if (!ps || !ps.hasPartner) return;

    if (ps.status === 'active') {
      if (statusEl) statusEl.innerHTML = 'Writing now… ' + typingDots();
    } else if (ps.status === 'recent') {
      if (statusEl) statusEl.textContent = 'Last active recently';
    } else if (ps.status === 'inactive') {
      if (statusEl) statusEl.textContent = 'Taking a break';
      if (bannerEl) bannerEl.innerHTML = `<div class="switch-banner"><div class="switch-banner-ico">💤</div><div class="switch-banner-text">Your partner hasn't written in ${ps.daysSinceActive} days. They might be taking a break.</div></div>`;
    } else if (ps.status === 'dormant') {
      if (statusEl) statusEl.textContent = `Inactive for ${ps.daysSinceActive} days`;
      if (bannerEl) bannerEl.innerHTML = `<div class="switch-banner"><div class="switch-banner-ico">⚡</div><div class="switch-banner-text">Your partner hasn't been active in ${ps.daysSinceActive} days. You can switch to a new partner.</div><button class="switch-banner-btn" onclick="switchPartner()">Switch</button></div>`;
    }
  });
}

function renderPast() {
  if (!state || !state.match) return;
  const day = state.match.day;
  const partnerMap = {};
  (state.partnerEntries || []).forEach(e => { partnerMap[e.day] = true; });

  document.getElementById('s-past').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div class="past-header">
      <div class="eyebrow" style="margin-bottom:8px;">Your entries</div>
      <div style="font-family:'Playfair Display',serif;font-size:26px;font-weight:400;line-height:1;">${state.entries.length} nights.<br/><em style="font-style:italic;color:var(--rose-l);">${state.entries.length} honest things.</em></div>
    </div>
    <div class="past-list">
      ${state.entries.map((e,i) => `<button class="entry reveal-on-scroll" type="button" onclick="showEntryDetail(${i})">
        <div class="entry-top"><div class="entry-day">Day ${e.day} · ${e.mood}</div>${partnerMap[e.day] ? '<div class="entry-both">✓ both wrote</div>' : ''}</div>
        <div class="entry-txt">${escapeHtml(e.text)}</div>
        ${i===0 ? '<div class="entry-hl">✦ Most recent entry</div>' : ''}
      </button>`).join('')}
    </div>
    ${state.entries.length ? `<div style="padding:16px 24px 0;"><button class="export-btn" onclick="exportEntries()"><span>📄</span> Export all entries as text</button></div>` : ''}
    <div style="height:32px;"></div>
    ${renderTabs('entries')}`;
  initScrollReveal('#s-past');
}

// ═══════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════
function renderProfile() {
  if (!state || !state.user) return;
  if (!state.user.archetype) { go('s-scan-intro'); return; }
  const arch = archetypes[state.user.archetype];
  if (!arch) return;
  const s = state.user.scores || { openness: 50, awareness: 50, guard: 50, reciprocity: 50 };
  const day = state.match ? state.match.day : 0;
  const matchArch = state.match ? archetypes[state.match.partner.archetype] : null;

  document.getElementById('s-profile').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div style="width:36px;height:36px;border-radius:50%;background:rgba(248,242,255,.04);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;" onclick="renderSettings();go('s-settings')">⚙️</div></div>
    <div class="hero-profile">
      <div class="avatar-wrap"><div class="av-ring"></div><div class="av-ring av-ring2"></div><div class="avatar">${arch.emoji}</div></div>
      <div class="p-user-name">${escapeHtml(state.user.name)}</div>
      <div class="p-college-text">${escapeHtml(state.user.college)} · ${escapeHtml(state.user.year)} year</div>
      <div class="arch-hero">
        <div class="arch-top"><div class="arch-moon">${arch.emoji}</div><div><div class="arch-ey">Your archetype</div><div class="arch-name">${arch.name}</div></div></div>
        <div class="arch-quote">${arch.quote}</div>
        <button class="share-btn" onclick="shareArchetype()" style="margin-top:12px;">📋 Share result</button>
      </button>
    </div>
    <div class="traits">
      <div class="sec-ey">ECP-11 Profile</div>
      ${['Openness','Awareness','Guard','Reciprocity'].map((name,i) => {
        const val = [s.openness, s.awareness, s.guard, s.reciprocity][i];
        return `<div class="trait" style="margin-bottom:13px;"><div class="trait-top"><span class="trait-name">${name}</span><span class="trait-pct" style="font-size:12px;color:var(--rose-l);font-family:'Playfair Display',serif;">${val}%</span></div><div class="trait-track"><div class="trait-fill-p" style="width:${val}%"></div></div></div>`;
      }).join('')}
    </div>
    <div class="stats-row" id="profile-stats">
      <div class="stat reveal-on-scroll"><div class="stat-n" data-target="${state.entries.length}">0</div><div class="stat-l">Entries written</div></div>
      <div class="stat reveal-on-scroll"><div class="stat-n" data-target="${state.streak}" data-prefix="🔥">🔥0</div><div class="stat-l">Day streak</div></div>
      <div class="stat reveal-on-scroll"><div class="stat-n" data-target="${Math.max(0,21-day)}">0</div><div class="stat-l">Days left</div></div>
    </div>
    ${state.insights ? `<div class="mood-chart-section reveal-on-scroll">
      <div class="mood-chart-card">
        <div class="mood-chart-top">
          <div class="mood-chart-lbl">Mood journey</div>
          <div class="mood-chart-trend">${state.insights.trend === 'rising' ? '↗ Rising' : state.insights.trend === 'dipping' ? '↘ Dipping' : '→ Steady'}</div>
        </div>
        <div class="mood-chart">
          ${state.insights.moodTrend.map(m => `<div class="mood-bar" data-v="${m.value}" title="Day ${m.day}: ${m.mood}"><div class="mood-bar-day">${m.day}</div></div>`).join('')}
        </div>
        <div class="mood-chart-legend"><span>🌑 Heavy</span><span>🌕 Good</span></div>
      </div>
    </div>
    <div class="insights-section reveal-on-scroll">
      <div class="insights-grid">
        <div class="insight-card"><div class="insight-ico">${state.insights.dominantMood}</div><div class="insight-val">${escapeHtml(state.insights.dominantLabel)}</div><div class="insight-lbl">Most felt mood</div></div>
        <div class="insight-card"><div class="insight-ico">📝</div><div class="insight-val">${state.insights.totalWords.toLocaleString()}</div><div class="insight-lbl">Words written</div></div>
        <div class="insight-card"><div class="insight-ico">✍️</div><div class="insight-val">${state.insights.avgWords}</div><div class="insight-lbl">Avg words/entry</div></div>
        <div class="insight-card"><div class="insight-ico">🎭</div><div class="insight-val">${state.insights.uniqueMoods}</div><div class="insight-lbl">Unique moods felt</div></div>
      </div>
    </div>` : ''}
    ${matchArch ? `<div class="partner-sec">
      <div class="sec-ey">Your match</div>
      <button class="partner-card-p" type="button" onclick="renderPartner();go('s-partner')">
        <div class="p-moon">${matchArch.emoji}</div>
        <div style="flex:1;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--rose);opacity:.6;margin-bottom:4px;">${matchArch.name}</div>
          <div style="font-family:'Playfair Display',serif;font-size:16px;font-style:italic;color:var(--ink);margin-bottom:3px;">Anonymous</div>
          <div style="font-size:11px;color:var(--ink-s);">Different college · Writes every night</div>
        </div>
        <div style="font-size:16px;color:var(--ink-s);">›</div>
      </button>
    </div>` : ''}
    ${state.match ? `<div class="dp-section"><div class="dp-card">
      <div class="dp-top"><div class="dp-lbl">21-day journey</div><div class="dp-days">Day ${day} of 21</div></div>
      <div class="dp-pips" id="dp-pips"></div>
      <div class="dp-sub"><span>${Math.max(0,21-day)} nights</span> until the reveal.</div>
    </div></div>` : ''}
    <div style="padding:20px 24px 0;"><div class="sec-ey" style="display:flex;align-items:center;justify-content:space-between;"><span>Badges</span><span style="font-family:'Playfair Display',serif;font-size:12px;color:var(--gold-l);text-transform:none;letter-spacing:0;">${countEarnedBadges()}/${badges.length}</span></div></div>
    <div class="badges-grid">${renderBadges()}</div>
    <div class="spacer"></div>
    ${renderTabs('profile')}`;

  const dpEl = document.getElementById('dp-pips');
  if (dpEl) { for(let i=0;i<21;i++){ const p=document.createElement('div'); p.className='dp-pip'+(i<day?' done':i===day?' now':''); dpEl.appendChild(p); } }
  initScrollReveal('#s-profile');
  setTimeout(() => animateCounters('profile-stats'), 300);
}

function renderPartner() {
  if (!state || !state.match) return;
  const matchArch = archetypes[state.match.partner.archetype];
  const ps = state.match.partner.scores || { openness:50, awareness:50, guard:50, reciprocity:50 };

  document.getElementById('s-partner').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><button class="btn-ghost" style="width:auto;padding:8px 16px;" onclick="renderProfile();go('s-profile')">← Back</button></div>
    <div style="padding:28px 24px 0;display:flex;flex-direction:column;align-items:center;text-align:center;">
      <div style="position:relative;margin-bottom:20px;">
        <div style="position:absolute;inset:-16px;border-radius:50%;border:1px solid rgba(212,133,154,.18);animation:ringExpand 3.5s ease-out infinite;"></div>
        <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,rgba(212,133,154,.2),rgba(123,94,167,.2));border:1px solid rgba(212,133,154,.2);display:flex;align-items:center;justify-content:center;font-size:36px;animation:float 4.5s ease-in-out infinite;">${matchArch.emoji}</div>
      </div>
      <div style="font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:8px;">Your partner</div>
      <div style="font-family:'Playfair Display',serif;font-size:26px;font-style:italic;color:var(--ink);margin-bottom:6px;">${matchArch.name}</div>
      <div style="font-family:'Lora',serif;font-style:italic;font-size:13px;color:var(--ink-m);line-height:1.75;max-width:260px;margin:0 auto 24px;">${matchArch.quote}</div>
      <div class="card" style="width:100%;margin-bottom:12px;text-align:left;">
        <div class="sec-ey" style="margin-bottom:14px;">Their ECP-11</div>
        ${['Openness','Awareness','Guard','Reciprocity'].map((name,i) => {
          const val = [ps.openness, ps.awareness, ps.guard, ps.reciprocity][i];
          return `<div class="trait" style="margin-bottom:13px;"><div class="trait-top"><span class="trait-name">${name}</span><span class="trait-pct" style="font-size:12px;color:var(--rose-l);font-family:'Playfair Display',serif;">${val}%</span></div><div class="trait-track"><div class="trait-fill-p" style="width:${val}%"></div></div></div>`;
        }).join('')}
      </div>
      <div style="background:linear-gradient(135deg,rgba(212,133,154,.07),rgba(123,94,167,.06));border:1px solid rgba(212,133,154,.15);border-radius:20px;padding:18px;width:100%;position:relative;overflow:hidden;margin-bottom:12px;text-align:left;">
        <div class="sec-ey" style="color:var(--rose);margin-bottom:10px;">Why you were matched</div>
        <div style="font-family:'Lora',serif;font-style:italic;font-size:13.5px;color:var(--ink-m);line-height:1.8;">You connect differently. That tension is where growth happens — two people learning from each other's opposite patterns.</div>
      </div>
    </div>
    <div class="spacer"></div>
    ${renderTabs('profile')}`;
}

function renderSettings() {
  const notifsEnabled = 'Notification' in window && Notification.permission === 'granted';
  const notifLabel = notifsEnabled ? 'On' : 'Off';
  const notifStyle = notifsEnabled ? '' : ' style="background:rgba(248,242,255,.06);border-color:var(--line);color:var(--ink-s);"';
  document.getElementById('s-settings').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><button class="btn-ghost" style="width:auto;padding:8px 16px;" onclick="renderProfile();go('s-profile')">← Back</button></div>
    <div style="padding:24px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:8px;">Settings</div>
      <div style="font-family:'Playfair Display',serif;font-size:26px;font-weight:400;line-height:1;margin-bottom:4px;">Your <em style="font-style:italic;color:var(--rose-l);">preferences.</em></div>
    </div>
    <div class="settings-list">
      <button class="si" type="button" onclick="toggleNotifications()"><div class="si-ico">&#127769;</div><div class="si-lbl">Notifications</div><div class="si-badge"${notifStyle}>${notifLabel}</div></button>
      <button class="si" type="button" onclick="exportEntries()"><div class="si-ico">&#128196;</div><div class="si-lbl">Export entries</div><div class="si-arrow">&#8250;</div></button>
      <button class="si" type="button" onclick="renderAbout();go('s-about')"><div class="si-ico">&#128161;</div><div class="si-lbl">About Mentally Prepare</div><div class="si-arrow">&#8250;</div></button>
    </div>
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Partner</div>
    </div>
    <div class="settings-list">
      ${state && state.match ? `<button class="si" id="si-switch" type="button" onclick="switchPartner()"><div class="si-ico">&#128260;</div><div class="si-lbl">Switch partner (if inactive 5+ days)</div><div class="si-arrow">&#8250;</div></button>` : ''}
    </div>
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Privacy</div>
    </div>
    <div class="settings-list">
      <button class="si" type="button" onclick="downloadMyData()"><div class="si-ico">&#128229;</div><div class="si-lbl">Download my data</div><div class="si-arrow">&#8250;</div></button>
      <button class="si" type="button" onclick="window.open('/privacy','_blank')"><div class="si-ico">&#128220;</div><div class="si-lbl">Privacy Policy</div><div class="si-arrow">&#8250;</div></button>
    </div>
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Account</div>
    </div>
    <div class="settings-list">
      <button class="si" type="button" onclick="logout()"><div class="si-ico">&#128682;</div><div class="si-lbl">Log out</div><div class="si-arrow">&#8250;</div></button>
      <button class="si" type="button" style="border-color:rgba(212,133,154,.15);" onclick="deleteAccount()"><div class="si-ico">&#128465;&#65039;</div><div class="si-lbl" style="color:rgba(212,133,154,.7);">Delete my account</div><div class="si-arrow">&#8250;</div></button>
    </div>
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Developer Tools</div>
    </div>
    <div class="settings-list">
      ${state && state.match ? `<button class="si" type="button" onclick="devAdvance()"><div class="si-ico">&#9193;</div><div class="si-lbl">Jump to Day 21</div><div class="si-arrow">&#8250;</div></button>` : ''}
      ${state && state.match ? `<button class="si" type="button" onclick="devPartnerReveal()"><div class="si-ico">&#129309;</div><div class="si-lbl">Partner says "yes" to reveal</div><div class="si-arrow">&#8250;</div></button>` : ''}
    </div>
    <div class="spacer"></div>`;
}

async function devAdvance() {
  try { await api('POST', '/dev/advance'); await loadState(); toast('Jumped to Day 21 ✦'); renderSettings(); } catch(e) { toast(e.message); }
}
async function devPartnerReveal() {
  try { await api('POST', '/dev/partner-reveal'); await loadState(); toast('Partner said yes ✦'); renderSettings(); } catch(e) { toast(e.message); }
}

// ═══════════════════════════════════════
// PARTNER SWITCHING
// ═══════════════════════════════════════
async function checkPartnerStatus() {
  try {
    return await api('GET', '/partner-status');
  } catch { return null; }
}

async function switchPartner() {
  if (!confirm('Switch to a new partner? Your previous entries will be kept but won\'t be revealed to the new partner.')) return;
  try {
    const result = await api('POST', '/switch-partner');
    await loadState();
    if (result.matched) {
      toast('New partner found! Your journey continues 🌙');
      renderJournal(); go('s-journal');
    } else {
      toast('Looking for a new partner...');
      renderWaiting(); go('s-waiting');
    }
  } catch (e) { toast(e.message); }
}

// ═══════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════
async function reportEntry(day) {
  const reason = prompt('What made you uncomfortable? (This helps us keep everyone safe)');
  if (!reason || !reason.trim()) return;
  try {
    await api('POST', '/report', { day, reason });
    toast('Report submitted. Thank you for keeping this space safe 💚');
  } catch (e) { toast(e.message); }
}

// ═══════════════════════════════════════
// REVEAL FLOW
// ═══════════════════════════════════════
function handleRevealFlow() {
  if (!state || !state.reveal || !state.reveal.available) return;
  const r = state.reveal;

  if (!r.myChoice) {
    renderRevealConsent(); go('s-reveal-wait');
  } else if (r.myChoice === 'no' || r.anonymous) {
    renderRevealAnonymous(); go('s-reveal-wait');
  } else if (r.myChoice === 'yes' && r.revealed) {
    renderRevealed(); go('s-revealed');
  } else if (r.myChoice === 'yes' && !r.partnerChose) {
    renderRevealWaiting(); go('s-reveal-wait');
  } else if (r.myChoice === 'yes' && r.partnerChose && !r.revealed) {
    renderRevealAnonymous(); go('s-reveal-wait');
  }
}

function renderRevealConsent() {
  const arch = archetypes[state.user.archetype];
  const matchArch = archetypes[state.match.partner.archetype];
  document.getElementById('s-reveal-wait').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="wait-body">
      <div class="wait-moon-wrap"><div class="ring"></div><div class="ring ring2"></div><div class="moon-base wait-moon"></div></div>
      <div class="wait-eyebrow">Day 21 · The Reveal</div>
      <h2 class="wait-h">Tonight,<br/>the stranger<br/><em>gets a name.</em></h2>
      <p class="wait-p">You've written to each other for 21 nights. Do you want to know who you've been writing to?</p>
      <div class="streak-complete">${Array.from({length:21}, () => '<div class="s-pip"></div>').join('')}</div>
      <div class="partner-wait">
        <div class="pw-moon">${matchArch.emoji}</div>
        <div><div class="pw-ey">Your partner</div><div class="pw-name">${matchArch.name}</div><div class="pw-status">Waiting for your decision</div></div>
        <div class="pw-dot"></div>
      </div>
      <button class="btn-yes" onclick="submitReveal('yes')" style="margin-top:20px;">✦ Yes — reveal who they are</button>
      <button class="btn-no" onclick="submitReveal('no')">Keep it anonymous forever</button>
      <div class="anon-note">One "no" keeps both identities private forever.<br/>No awkwardness. No rejection risk.</div>
    </div>`;
}

function renderRevealWaiting() {
  const matchArch = archetypes[state.match.partner.archetype];
  document.getElementById('s-reveal-wait').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="wait-body">
      <div class="wait-moon-wrap"><div class="ring"></div><div class="ring ring2"></div><div class="moon-base wait-moon"></div></div>
      <div class="wait-eyebrow">You said yes ✦</div>
      <h2 class="wait-h">Waiting for<br/><em>your partner.</em></h2>
      <p class="wait-p">You chose to reveal. Now waiting for your partner to make their choice.</p>
      <div class="partner-wait">
        <div class="pw-moon">${matchArch.emoji}</div>
        <div><div class="pw-ey">Your partner</div><div class="pw-name">${matchArch.name}</div><div class="pw-status">Deciding… ${typingDots()}</div></div>
        <div class="pw-dot"></div>
      </div>
      <button class="btn-ghost" onclick="checkReveal()" style="margin-top:20px;">Check again</button>
    </div>`;
}

function renderRevealAnonymous() {
  document.getElementById('s-reveal-wait').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="wait-body">
      <div class="wait-moon-wrap"><div class="ring"></div><div class="ring ring2"></div><div class="moon-base wait-moon"></div></div>
      <div class="wait-eyebrow">Anonymous forever ✦</div>
      <h2 class="wait-h">The connection<br/><em>stays unnamed.</em></h2>
      <p class="wait-p">One of you chose to keep it anonymous. And that's perfectly okay. The words you exchanged were real — the names don't change that.</p>
      <button class="btn" onclick="renderProfile();go('s-profile')" style="margin-top:20px;">Go to profile</button>
    </div>`;
}

async function submitReveal(choice) {
  try {
    await api('POST', '/reveal', { choice });
    await loadState();
    if (choice === 'yes' && state.reveal.revealed) {
      spawnParticles();
      setTimeout(() => { renderRevealed(); go('s-revealed'); }, 400);
    } else {
      handleRevealFlow();
    }
  } catch (e) { toast(e.message); }
}

async function checkReveal() {
  await loadState();
  if (state.reveal.revealed) {
    spawnParticles();
    setTimeout(() => { renderRevealed(); go('s-revealed'); }, 400);
  } else {
    handleRevealFlow();
    toast('Still waiting for partner');
  }
}

function spawnParticles() {
  const pc = document.getElementById('particles');
  const colours = ['#EBB4C2','#E8D0A0','#B09FCC','#F8F2FF','#D4859A'];
  for(let i=0;i<30;i++){
    const p = document.createElement('div'); p.className='particle';
    const sz = Math.random()*6+3;
    p.style.cssText = `width:${sz}px;height:${sz}px;background:${colours[~~(Math.random()*colours.length)]};left:${30+Math.random()*40}%;top:${25+Math.random()*15}%;animation-delay:${Math.random()*.3}s;animation-duration:${.8+Math.random()*.6}s;`;
    pc.appendChild(p);
    setTimeout(() => p.remove(), 1500);
  }
}

function renderRevealed() {
  if (!state.reveal || !state.reveal.partner) return;
  const partner = state.reveal.partner;
  const matchArch = archetypes[state.match.partner.archetype];
  const totalEntries = state.entries.length;

  document.getElementById('s-revealed').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="revealed-body">
      <div class="rev-moon-wrap"><div class="rev-ring"></div><div class="rev-ring rev-ring2"></div><div class="moon-base rev-moon"></div></div>
      <div class="rev-eyebrow">The stranger had a name all along</div>
      <div class="rev-label">You've been writing to</div>
      <div class="rev-name">${escapeHtml(partner.name)}</div>
      <div class="rev-college">${escapeHtml(partner.year)} year · ${escapeHtml(partner.college)}</div>
      <div class="arch-badge">
        <div style="font-size:26px;animation:floatSlow 4s ease-in-out infinite;">${matchArch.emoji}</div>
        <div><div class="arch-ey">Their archetype</div><div style="font-family:'Playfair Display',serif;font-size:15px;font-style:italic;color:var(--ink);">${matchArch.name}</div></div>
      </div>
      <div class="days-card">
        <div class="days-ey"><span>${totalEntries} nights written together</span><span style="color:var(--rose-l);">${Math.round(totalEntries/21*100)}%</span></div>
        <div class="days-pips" id="rev-pips"></div>
        <div class="days-stat">A journey of <span>${totalEntries} honest entries.</span></div>
      </div>
      <div class="meet-section">
        <div class="meet-question">Now that you know —<br/><em>do you want to meet?</em></div>
        <button class="btn-yes" onclick="renderRevealYes();go('s-reveal-yes')">✦ Yes, I want to meet ${escapeHtml(partner.name)}</button>
        <button class="btn-no" onclick="renderProfile();go('s-profile')">Maybe later</button>
      </div>
    </div>`;
  const dp = document.getElementById('rev-pips');
  if(dp) for(let i=0;i<totalEntries;i++){ const p=document.createElement('div'); p.className='d-pip'; p.style.animationDelay=`${i*.12}s`; dp.appendChild(p); }
}

function renderRevealYes() {
  const partner = state.reveal.partner;
  document.getElementById('s-reveal-yes').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="yes-body">
      <div class="yes-moon-wrap"><div class="moon-base" style="width:90px;height:90px;box-shadow:0 0 60px rgba(201,169,110,.65),0 0 130px rgba(201,169,110,.3);animation:float 5s ease-in-out infinite;"></div></div>
      <div class="wait-eyebrow">Both said yes ✦</div>
      <h2 class="yes-h">Time to<br/><em>say hello.</em></h2>
      <p class="yes-p">You've been writing to each other for 21 nights. Now you know who wrote those words. Go say hello.</p>
      <div class="contact-card">
        <div class="contact-ey">${escapeHtml(partner.name)}'s contact</div>
        <div class="contact-name">${escapeHtml(partner.name)}</div>
        <div class="contact-detail">${escapeHtml(partner.college)} · ${escapeHtml(partner.year)} year<br/>${escapeHtml(partner.email)}</div>
      </div>
      <button class="btn" onclick="renderProfile();go('s-profile')" style="margin-bottom:12px;">🌙 Back to profile</button>
    </div>`;
}

// ═══════════════════════════════════════
// ABOUT
// ═══════════════════════════════════════
function renderAbout() {
  document.getElementById('s-about').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><button class="btn-ghost" style="width:auto;padding:8px 16px;" onclick="renderSettings();go('s-settings')">← Back</button></div>
    <div class="about-hero">
      <div class="moon-base" style="width:72px;height:72px;margin:0 auto 20px;box-shadow:0 0 40px rgba(201,169,110,.5),0 0 80px rgba(201,169,110,.15);animation:float 5s ease-in-out infinite;"></div>
      <div class="eyebrow">About the project</div>
      <h2 style="font-family:'Playfair Display',serif;font-size:28px;font-weight:400;line-height:1.15;margin-bottom:12px;">An anonymous peer reset<br/>for <em style="font-style:italic;background:linear-gradient(135deg,var(--rose-l),var(--gold-l));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">lonely college students.</em></h2>
      <p style="font-family:'Lora',serif;font-style:italic;font-size:13px;color:var(--ink-m);line-height:1.85;max-width:300px;margin:0 auto;">Free. Always. No payment. No subscription. No freemium wall. Just connection.</p>
    </div>
    <div class="about-stat-row">
      <div class="about-stat"><div class="about-stat-n">52%</div><div class="about-stat-l">of college students report loneliness</div></div>
      <div class="about-stat"><div class="about-stat-n">4.3×</div><div class="about-stat-l">higher distress risk when isolated</div></div>
      <div class="about-stat"><div class="about-stat-n">67%</div><div class="about-stat-l">want help but don't know how</div></div>
    </div>
    <div class="about-section">
      <div class="sec-ey">Why it works</div>
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">🌒</div><div class="about-card-title">Opposite types, on purpose</div></div><div class="about-card-p">You're matched with someone who connects differently. That tension is the growth.</div></div>
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">🔒</div><div class="about-card-title">Anonymous until Day 21</div></div><div class="about-card-p">No profile pictures. No names. Just words — raw, honest, and unfiltered.</div></div>
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">🌙</div><div class="about-card-title">Midnight ritual</div></div><div class="about-card-p">Entries seal at midnight and unseal together. The ritual creates intimacy.</div></div>
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">✦</div><div class="about-card-title">Consent-based reveal</div></div><div class="about-card-p">Both must say yes to reveal. One no keeps it anonymous forever. Zero rejection risk.</div></div>
    </div>
    <div class="builder-card"><div class="builder-avatar">✦</div><div><div class="builder-name">Built by Anushka Kumar</div><div class="builder-sub">HP Dreams Unlocked Top 40 · HPAIR Harvard Delegate · IIT Kharagpur</div></div></div>
    <div style="padding:20px 24px;"><button class="btn" onclick="renderSettings();go('s-settings')">← Back to settings</button></div>
    <div class="spacer"></div>`;
}

// ═══════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════
function renderTabs(active) {
  const tabs = [
    { id:'tonight', ico:'✍️', lbl:'Tonight', fn:'goToJournal()' },
    { id:'entries', ico:'🌙', lbl:'Entries', fn:'renderPast();go(\'s-past\')' },
    { id:'profile', ico:'🌑', lbl:'Profile', fn:'renderProfile();go(\'s-profile\')' },
    { id:'partner', ico:'🔒', lbl:'Partner', fn:'renderSealed();go(\'s-sealed\')' },
  ];
  return `<div class="tabs">${tabs.map(t =>
    `<button class="tab${t.id===active?' on':''}" type="button" onclick="${t.fn}" aria-pressed="${t.id===active?'true':'false'}"><div class="tab-ico">${t.ico}</div><div class="tab-lbl">${t.lbl}</div></button>`
  ).join('')}</div>`;
}

function getGreeting(name) {
  const h = new Date().getHours();
  const nm = name || 'there';
  if (h < 5) return `Late night, <em>${escapeHtml(nm)}.</em>`;
  if (h < 12) return `Good morning, <em>${escapeHtml(nm)}.</em>`;
  if (h < 17) return `Good afternoon, <em>${escapeHtml(nm)}.</em>`;
  if (h < 21) return `Good evening, <em>${escapeHtml(nm)}.</em>`;
  return `Late night, <em>${escapeHtml(nm)}.</em>`;
}

function getWritingTip(day) { return writingTips[((day || 1) + new Date().getDate()) % writingTips.length]; }

function getStreakNudge(streak) {
  const nudges = {
    3: "3 days straight — you're building something real.",
    5: "5 days of showing up. Your partner notices.",
    7: "One full week. That takes commitment.",
    10: "10 days in — most people never get this far.",
    14: "Two weeks of honesty. You're not the same person who started.",
    17: "Almost there. The finish line is glowing.",
    21: "21 days. You did it. Every single night."
  };
  const keys = Object.keys(nudges).map(Number).filter(k => k <= streak).sort((a,b) => b - a);
  return keys.length ? nudges[keys[0]] : `${streak}-day streak — keep going.`;
}

function shareArchetype() {
  if (!state) return;
  const arch = archetypes[state.user.archetype];
  const s = state.user.scores;
  const text = `${arch.name}\n${arch.quote}\n\nOpenness: ${s.openness}%\nAwareness: ${s.awareness}%\nGuard: ${s.guard}%\nReciprocity: ${s.reciprocity}%\n\n— Mentally Prepare (ECP-11)`;
  if (navigator.share) { navigator.share({ title: 'My Connection Profile', text }).catch(() => {}); }
  else if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard ✓')); }
  else { toast('Sharing not supported'); }
}

function exportEntries() {
  if (!state || !state.entries.length) { toast('No entries to export'); return; }
  let text = 'Mentally Prepare — Journal Entries\n═══════════════════════════════════\n\n';
  state.entries.forEach(e => { text += `Day ${e.day} · Mood: ${e.mood}\n${e.text}\n\n---\n\n`; });
  text += `Archetype: ${archetypes[state.user.archetype].name}\nTotal entries: ${state.entries.length}\nStreak: ${state.streak} days\n`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'mentally-prepare-entries.txt'; a.click();
  URL.revokeObjectURL(url);
  toast('Entries exported ✓');
}

function showEntryDetail(idx) {
  const entry = state.entries[idx];
  if (!entry) return;
  const partnerEntry = (state.partnerEntries || []).find(e => e.day === entry.day);
  const comments = (state.comments || []).filter(c => c.day === entry.day);
  const myComment = comments.find(c => c.from === 'me');
  const partnerComment = comments.find(c => c.from === 'partner');

  document.getElementById('entry-detail').innerHTML = `
    <div class="entry-detail-card">
      <button class="edc-close" id="entryDetailCloseBtn" type="button" aria-label="Close entry detail">×</button>
      <div class="edc-day">Day ${entry.day} of 21</div>
      <div class="edc-mood">${entry.mood}</div>
      <div class="edc-prompt">${escapeHtml(entry.prompt)}</div>
      <div class="edc-text">${escapeHtml(entry.text)}</div>
      ${partnerComment ? `
        <div class="edc-comments">
          <div class="edc-comments-lbl">Partner's thought on your entry</div>
          <div class="edc-comment from-partner">
            <div class="edc-comment-from">Your partner</div>
            ${escapeHtml(partnerComment.text)}
          </div>
        </div>` : ''}
      <div class="edc-partner">
        <div class="edc-partner-lbl">Partner's entry · Day ${entry.day}</div>
        ${partnerEntry
          ? `<div class="edc-partner-text">${escapeHtml(partnerEntry.text)}</div>
             <div class="edc-comments">
               <div class="edc-comments-lbl">Your reflection</div>
               ${myComment
                 ? `<div class="edc-comment from-me">
                      <div class="edc-comment-from">You</div>
                      ${escapeHtml(myComment.text)}
                    </div>`
                 : `<div class="edc-comment-input">
                      <textarea id="comment-text" placeholder="Leave a quiet thought..." maxlength="500"></textarea>
                      <button class="edc-comment-send" id="entryCommentSendBtn" type="button" title="Send">⤴</button>
                    </div>`
               }
             </div>
             <button class="report-btn" id="entryReportBtn" type="button">⚑ Report this entry</button>`
          : `<div class="edc-partner-text" style="filter:blur(4px);user-select:none;">This entry hasn't been revealed yet.</div><div class="edc-partner-note">Partner entries appear the next day</div>`
        }
      </div>
    </div>`;
  const closeBtn = document.getElementById('entryDetailCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeEntryDetail);
  const commentSendBtn = document.getElementById('entryCommentSendBtn');
  if (commentSendBtn) commentSendBtn.addEventListener('click', function() { submitComment(entry.day); });
  const reportBtn = document.getElementById('entryReportBtn');
  if (reportBtn) reportBtn.addEventListener('click', function() { reportEntry(entry.day); });
  document.getElementById('entry-detail').classList.add('show');
}

function closeEntryDetail() { document.getElementById('entry-detail').classList.remove('show'); }

async function submitComment(day) {
  const textarea = document.getElementById('comment-text');
  const text = textarea ? textarea.value.trim() : '';
  if (!text) { toast('Write something first'); return; }
  try {
    await api('POST', '/comment', { day, text });
    await loadState();
    // Re-open the same entry detail to show the saved comment
    const idx = state.entries.findIndex(e => e.day === day);
    if (idx >= 0) showEntryDetail(idx);
    toast('Thought shared \u2727');
  } catch (e) { toast(e.message); }
}

// ═══════════════════════════════════════
// BADGES
// ═══════════════════════════════════════
const badges = [
  { ico:'✍️', name:'First Words', check:() => state && state.entries && state.entries.length >= 1 },
  { ico:'🔥', name:'3-Day Fire', check:() => state && state.streak >= 3 },
  { ico:'🔍', name:'Scanned', check:() => state && state.user && !!state.user.archetype },
  { ico:'⚡', name:'One Week', check:() => state && state.streak >= 7 },
  { ico:'🌓', name:'Halfway', check:() => state && state.match && state.match.day >= 11 },
  { ico:'💎', name:'Two Weeks', check:() => state && state.streak >= 14 },
  { ico:'🎭', name:'Full Spectrum', check:() => { if (!state || !state.entries) return false; return new Set(state.entries.map(e=>e.mood)).size >= 5; } },
  { ico:'🌕', name:'Revealed', check:() => state && state.match && state.match.day >= 21 }
];
function renderBadges() { return badges.map(b => `<div class="badge-item ${b.check()?'earned':'locked'}"><div class="badge-ico">${b.ico}</div><div class="badge-name">${b.name}</div></div>`).join(''); }
function countEarnedBadges() { return badges.filter(b => b.check()).length; }

// ═══════════════════════════════════════
// ANIMATIONS
// ═══════════════════════════════════════
function celebrateStreak() {
  const milestones = [3, 7, 14, 21];
  if (!state || !milestones.includes(state.streak)) return;
  const cc = document.getElementById('celebrate');
  const colours = ['#EBB4C2','#E8D0A0','#B09FCC','#F8F2FF','#D4859A','#7B5EA7','#C9A96E'];
  for (let i = 0; i < 40; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = (5 + Math.random() * 90) + '%'; c.style.top = '-10px';
    c.style.background = colours[~~(Math.random() * colours.length)];
    c.style.animationDelay = (Math.random() * 0.8) + 's';
    c.style.animationDuration = (1.5 + Math.random()) + 's';
    c.style.width = (4 + Math.random() * 6) + 'px'; c.style.height = (6 + Math.random() * 8) + 'px';
    c.style.borderRadius = Math.random() > 0.5 ? '50%' : '1px';
    cc.appendChild(c); setTimeout(() => c.remove(), 3000);
  }
  const msgs = { 3:'🔥 3-day streak!', 7:'✨ 7-day streak!', 14:'🌙 14 days!', 21:'🎉 21 days!' };
  toast(msgs[state.streak] || '🔥 Streak!', 3000);
}

function animateCounters(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.querySelectorAll('.stat-n[data-target]').forEach(n => {
    const target = parseInt(n.dataset.target, 10);
    const prefix = n.dataset.prefix || '';
    let current = 0;
    const step = Math.max(1, Math.floor(target / 20));
    let start = null;
    function tick(ts) {
      if (!start) start = ts;
      const elapsed = ts - start;
      current = Math.min(target, Math.floor(target * elapsed / 500));
      n.textContent = prefix + current;
      if (current < target) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('revealed'); revealObserver.unobserve(e.target); }});
}, { threshold: 0.15 });
function initScrollReveal(sel) { document.querySelectorAll(sel + ' .reveal-on-scroll').forEach(el => revealObserver.observe(el)); }

// Landing page scroll reveal (.reveal → .visible)
(function(){
  const landingObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        landingObserver.unobserve(e.target);
        // Animate stat counters when they appear
        e.target.querySelectorAll('.problem-stat-n[data-target]').forEach(function(n) {
          const target = parseInt(n.dataset.target, 10);
          const suffix = n.dataset.suffix || '';
          let start = null;
          function tick(ts) {
            if (!start) start = ts;
            const progress = Math.min((ts - start) / 1200, 1);
            n.textContent = Math.floor(target * progress) + suffix;
            if (progress < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('#landing .reveal').forEach(function(el) { landingObserver.observe(el); });
})();

// Phone mockup typewriter effect
(function(){
  var text = "I pull away when I feel someone getting close. Not because I don't want them — but because I'm terrified they'll see the version of me I can't even face...";
  var el = document.getElementById('typewriterText');
  if (!el) return;
  var i = 0;
  function type() {
    if (i <= text.length) {
      el.textContent = text.substring(0, i) + (i < text.length ? '|' : '');
      i++;
      setTimeout(type, 35 + Math.random() * 25);
    }
  }
  // Start when the section scrolls into view
  var jpObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) { type(); jpObserver.unobserve(e.target); }
    });
  }, { threshold: 0.3 });
  var jpSection = document.getElementById('l-journal');
  if (jpSection) jpObserver.observe(jpSection);
  else setTimeout(type, 2000);
})();

// Shooting stars (paused when tab hidden)
(function(){
  var shootTimer;
  function shootStar() {
    if (document.hidden) return;
    const star = document.createElement('div'); star.className = 'shooting-star';
    star.style.left = (20 + Math.random() * 60) + '%'; star.style.top = (5 + Math.random() * 25) + '%';
    star.style.animation = `shoot ${0.6 + Math.random() * 0.6}s linear forwards`;
    document.body.appendChild(star); setTimeout(() => star.remove(), 1500);
  }
  function scheduleShoot() { shootTimer = setTimeout(function(){ shootStar(); scheduleShoot(); }, 6000 + Math.random() * 8000); }
  scheduleShoot();
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) { clearTimeout(shootTimer); }
    else { scheduleShoot(); }
  });
})();

// Swipe gestures
(function(){
  const obMap = ['s-splash','s-ob1','s-ob2','s-ob3','s-ob4','s-ob5'];
  let startX = 0, startY = 0, swiping = false;
  document.addEventListener('touchstart', function(e) {
    const screen = document.querySelector('.screen.active');
    if (!screen || !obMap.includes(screen.id)) return;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; swiping = true;
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!swiping) return; swiping = false;
    const screen = document.querySelector('.screen.active');
    if (!screen) return;
    const idx = obMap.indexOf(screen.id); if (idx < 0) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0 && idx < obMap.length - 1) go(obMap[idx + 1]);
    else if (dx > 0 && idx > 0) go(obMap[idx - 1]);
  }, { passive: true });
})();

// Haptic feedback
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.btn, .btn-yes');
  if (btn && navigator.vibrate) navigator.vibrate(12);
});

// Website navbar scroll
(function(){
  var nav = document.getElementById('siteNav');
  var ticking = false;
  window.addEventListener('scroll', function(){
    if(!ticking){
      requestAnimationFrame(function(){
        nav.classList.toggle('scrolled', window.scrollY > 60);
        ticking = false;
      });
      ticking = true;
    }
  });
})();

// Cursor glow (throttled with RAF)
(function(){
  var glow = document.getElementById('cursorGlow');
  if(window.matchMedia('(pointer:fine)').matches){
    var mx=0,my=0,raf=false;
    document.addEventListener('mousemove', function(e){
      mx=e.clientX; my=e.clientY;
      if(!raf){ raf=true; requestAnimationFrame(function(){ glow.style.left=mx+'px'; glow.style.top=my+'px'; glow.style.opacity='1'; raf=false; }); }
    });
    document.addEventListener('mouseleave', function(){ glow.style.opacity = '0'; });
  } else {
    glow.style.display = 'none';
  }
})();

// Floating particles (reduced count)
(function(){
  var c = document.getElementById('floatParticles');
  var colors = ['var(--rose)','var(--purple-l)','var(--gold)'];
  for(var i = 0; i < 8; i++){
    var p = document.createElement('div');
    p.className = 'float-particle';
    p.style.cssText = 'left:'+Math.random()*100+'%;animation-delay:'+Math.random()*8+'s;animation-duration:'+(Math.random()*6+8)+'s;width:'+(Math.random()*2+1)+'px;height:'+(Math.random()*2+1)+'px;background:'+colors[Math.floor(Math.random()*3)];
    c.appendChild(p);
  }
})();

// Mobile menu toggle
function toggleSiteMenu() {
  const links = document.querySelector('.site-nav-links');
  const nextState = !links.classList.contains('open');
  links.classList.toggle('open', nextState);
  document.getElementById('siteMenuBtn').setAttribute('aria-expanded', String(nextState));
}

// Service Worker: force-update old versions
if ('serviceWorker' in navigator) {
  // Clear ALL old caches first
  caches.keys().then(names => {
    names.forEach(n => { if (n !== 'mp-v4') caches.delete(n); });
  });
  navigator.serviceWorker.getRegistrations().then(regs => {
    // Unregister any old SWs, then register fresh
    Promise.all(regs.map(r => r.unregister())).then(() => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        console.log('SW registered fresh, scope:', reg.scope);
        // Force the new SW to activate immediately
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'activated') console.log('New SW activated');
          });
        });
      }).catch(err => console.warn('SW registration failed:', err));
    });
  });
}

// Pause animations when tab is hidden
document.addEventListener('visibilitychange', function() {
  document.body.classList.toggle('tab-hidden', document.hidden);
});

// ═══════════════════════════════════════
// PUSH SUBSCRIPTION HELPER
// ═══════════════════════════════════════
async function subscribeToPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/public-key');
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub })
    });
  } catch (e) {
    console.warn('Push subscribe failed:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
// NOTIFICATIONS
// ═══════════════════════════════════════
function toggleNotifications() {
  if (!('Notification' in window)) { toast('Notifications not supported in this browser'); return; }
  if (Notification.permission === 'granted') {
    if ('serviceWorker' in navigator) subscribeToPush();
    toast('Notifications are already enabled ✓');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications blocked — enable them in browser settings');
    return;
  }
  Notification.requestPermission().then(function(result) {
    if (result === 'granted') {
      if ('serviceWorker' in navigator) subscribeToPush();
      toast('Notifications enabled! ✦');
    } else {
      toast('Notifications were declined');
    }
    renderSettings();
  });
}

// ═══════════════════════════════════════
// PRIVACY — Data Download & Account Delete
// ═══════════════════════════════════════
async function downloadMyData() {
  try {
    const res = await fetch('/api/my-data');
    if (!res.ok) { toast('Failed to export data'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-mentally-prepare-data.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Data downloaded ✓');
  } catch (e) { toast('Download failed'); }
}

async function deleteAccount() {
  const password = prompt('Enter your password to confirm permanent deletion:');
  if (!password) return;
  if (!confirm('This will permanently delete your account, all journal entries, and all your data. This cannot be undone. Continue?')) return;
  try {
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.ok) {
      state = null;
      sessionStorage.removeItem('mp-draft');
      showLanding();
      toast('Account deleted. Sorry to see you go.');
    } else {
      toast(data.error || 'Deletion failed');
    }
  } catch (e) { toast('Deletion failed'); }
}

// ═══════════════════════════════════════
// PASSWORD RESET
// ═══════════════════════════════════════
async function forgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) { toast('Enter your email'); return; }
  try {
    const result = await api('POST', '/forgot-password', { email });
    toast('Reset code generated ✓');

    go('s-reset');
  } catch (e) { toast(e.message); }
}

async function resetPassword() {
  const code = document.getElementById('reset-code').value.trim();
  const newPassword = document.getElementById('reset-password').value;
  if (!code || !newPassword) { toast('Enter code and new password'); return; }
  if (newPassword.length < 8) { toast('Password must be at least 8 characters'); return; }
  try {
    await api('POST', '/reset-password', { code, newPassword });
    toast('Password reset! Sign in now ✦');
    go('s-login');
  } catch (e) { toast(e.message); }
}
// ═══════════════════════════════════════
// FLOATING WORDS CYCLER (Landing Problem Section)
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  const words = document.querySelectorAll('.problem-float-word');
  if (!words.length) return;

  // Set positions directly on each word
  const positions = [
    {top:'10%',  left:'-20px',  right:'auto', bottom:'auto'},
    {top:'50%',  right:'-40px', left:'auto',  bottom:'auto'},
    {bottom:'15%',left:'0',     right:'auto', top:'auto'},
  ];
  words.forEach(function(w, i) {
    var p = positions[i] || positions[0];
    w.style.position = 'absolute';
    w.style.top      = p.top    || 'auto';
    w.style.bottom   = p.bottom || 'auto';
    w.style.left     = p.left   || 'auto';
    w.style.right    = p.right  || 'auto';
  });

  var idx = 0;
  function showNext() {
    words.forEach(function(w) { w.classList.remove('visible'); });
    words[idx].classList.add('visible');
    idx = (idx + 1) % words.length;
  }
  showNext();
  setInterval(showNext, 2000);
});

