// ═══════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════
async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something did not save. Try once more.');
  return data;
}

let state = null;
const defaultPushPreferences = {
  enabled: true,
  morningReminder: true,
  eveningReminder: true,
  dailyReflection: true,
  streakReminder: true,
  silentRoomReminder: false
};
let deferredInstallPrompt = null;
let installPromptShown = false;

function normalizeState(data) {
  if (!data || typeof data !== 'object') return data;
  data.user = data.user || {};
  data.user.pushPreferences = Object.assign({}, defaultPushPreferences, data.user.pushPreferences || {});
  data.user.pushSubscribed = !!data.user.pushSubscribed;
  data.entries = Array.isArray(data.entries) ? data.entries : [];
  data.partnerEntries = Array.isArray(data.partnerEntries) ? data.partnerEntries : [];
  data.comments = Array.isArray(data.comments) ? data.comments : [];
  data.reactions = Array.isArray(data.reactions) ? data.reactions : [];
  data.nudges = Array.isArray(data.nudges) ? data.nudges : [];
  data.waitingInfo = data.waitingInfo || {};
  data.partnerStatus = data.partnerStatus || {
    hasPartner: !!data.match,
    status: data.match ? 'unknown' : 'waiting',
    friendlyTitle: data.match ? 'Your anonymous partner' : 'We are still looking for the right anonymous match.',
    friendlyMessage: data.match ? 'You can keep writing while the room settles.' : 'You can write tonight while we search.',
    unsealMessage: 'Notes open after midnight IST.',
    switchesRemaining: 0
  };
  if (data.match) {
    data.match.partner = data.match.partner || {};
    data.match.partner.archetype = data.match.partner.archetype || 'connector';
    data.match.partner.scores = data.match.partner.scores || { openness: 50, awareness: 50, guard: 50, reciprocity: 50 };
    data.match.promptChoices = Array.isArray(data.match.promptChoices) ? data.match.promptChoices : [];
  }
  return data;
}
async function loadState() {
  try { state = normalizeState(await api('GET', '/me')); return true; }
  catch { state = null; return false; }
}

let firebaseAuthClient = null;
let firebaseInitPromise = null;
let firebaseAuthStateBound = false;
let firebaseExchangeInFlight = false;
let firebaseExchangePromise = null;
let firebaseRedirectResultHandled = false;
const GOOGLE_REDIRECT_CONTEXT_KEY = 'mp-google-login-context';
const AUTH_DEBUG = new URLSearchParams(location.search).has('authDebug')
  || (() => { try { return localStorage.getItem('mp-auth-debug') === '1'; } catch { return false; } })();

function authDebug(message, details) {
  if (!AUTH_DEBUG) return;
  if (typeof details === 'undefined') console.log(message);
  else console.log(message, details);
}

function firebaseLoginMessage(error) {
  if (!error) return 'Google login failed. Please try again.';
  if (error.code === 'auth/unauthorized-domain') {
    return 'Google login needs mymentallyprepare.com added in Firebase Authorized Domains.';
  }
  if (error.code === 'auth/popup-closed-by-user') return 'Google login was cancelled.';
  if (error.code === 'auth/network-request-failed') return 'Google login could not reach Firebase. Please refresh and try again.';
  if (error.message) return error.message;
  return 'Google login failed. Please try again.';
}

async function initFirebaseAuth() {
  if (firebaseInitPromise) return firebaseInitPromise;
  firebaseInitPromise = (async function() {
    if (!window.firebase || !firebase.auth) return null;
    const res = await fetch('/api/firebase-config', { credentials: 'same-origin' }).catch(() => null);
    if (!res || !res.ok) return null;
    const payload = await res.json().catch(() => ({}));
    if (!payload.enabled || !payload.config) return null;
    if (!firebase.apps.length) firebase.initializeApp(payload.config);
    firebaseAuthClient = firebase.auth();
    firebaseAuthClient.useDeviceLanguage();
    await firebaseAuthClient.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    try {
      const redirectResult = await firebaseAuthClient.getRedirectResult();
      firebaseRedirectResultHandled = true;
      authDebug('Redirect result received', { hasUser: !!(redirectResult && redirectResult.user) });
      if (redirectResult && redirectResult.user) {
        await completeFirebaseLogin(redirectResult.user, false, getStoredGoogleRedirectContext());
      }
    } catch (e) {
      firebaseRedirectResultHandled = true;
      console.error('[GoogleAuth] Firebase redirect login failed:', {
        code: e && e.code,
        message: e && e.message,
        error: e
      });
      toast(firebaseLoginMessage(e));
    } finally {
      clearStoredGoogleRedirectContext();
    }

    bindFirebaseAuthState(firebaseAuthClient);
    return firebaseAuthClient;
  })();
  return firebaseInitPromise;
}

function bindFirebaseAuthState(auth) {
  if (!auth || firebaseAuthStateBound) return;
  firebaseAuthStateBound = true;
  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    authDebug('Firebase user found', { uid: user.uid, email: user.email });
    if (!firebaseRedirectResultHandled) return;
    if (state && state.user && state.user.id) return;
    await completeFirebaseLogin(user, true, getStoredGoogleRedirectContext());
  }, (error) => {
    console.warn('Firebase auth state failed:', error);
  });
}

function waitForFirebaseUser(auth) {
  return new Promise(resolve => {
    if (!auth) return resolve(null);
    let settled = false;
    let unsubscribe = function() {};
    const done = (user) => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      resolve(user || null);
    };
    unsubscribe = auth.onAuthStateChanged(done, () => done(null));
    setTimeout(() => done(auth.currentUser || null), 1600);
  });
}

function getSignupGoogleProfileHints() {
  const valueOf = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  const yearEl = document.querySelector('.year-btn.on');
  return {
    name: valueOf('inp-name'),
    college: valueOf('inp-college'),
    email: valueOf('inp-email'),
    year: yearEl ? yearEl.textContent.trim() : ''
  };
}

function getStoredGoogleRedirectContext() {
  try {
    return JSON.parse(sessionStorage.getItem(GOOGLE_REDIRECT_CONTEXT_KEY) || '{}');
  } catch {
    return {};
  }
}

function hasPendingGoogleRedirectContext() {
  const context = getStoredGoogleRedirectContext();
  const savedAt = Number(context && context.savedAt);
  return Number.isFinite(savedAt) && Date.now() - savedAt < 10 * 60 * 1000;
}

function clearStoredGoogleRedirectContext() {
  try { sessionStorage.removeItem(GOOGLE_REDIRECT_CONTEXT_KEY); } catch {}
}

function saveGoogleRedirectContext(context) {
  try {
    sessionStorage.setItem(GOOGLE_REDIRECT_CONTEXT_KEY, JSON.stringify({
      context: context || 'login',
      hints: getSignupGoogleProfileHints(),
      returnPath: location.pathname + location.search + location.hash,
      savedAt: Date.now()
    }));
  } catch {}
}

function shouldUseRedirectForGoogle() {
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = window.navigator && window.navigator.standalone;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  return standalone || iosStandalone || mobile;
}

function openAppAfterGoogleLogin() {
  authDebug('Redirecting to /app');
  if (location.pathname !== '/app') {
    history.replaceState(null, '', '/app');
  }
  if (document.body.classList.contains('app-active')) routeToScreen();
  else startApp();
}

async function completeFirebaseLogin(firebaseUser, quiet, redirectContext) {
  if (!firebaseUser) return false;
  if (firebaseExchangePromise) return firebaseExchangePromise;
  firebaseExchangeInFlight = true;
  firebaseExchangePromise = (async function() {
    try {
      authDebug('Firebase user detected', { uid: firebaseUser.uid, email: firebaseUser.email });
      await firebaseUser.reload().catch(() => {});
      const idToken = await firebaseUser.getIdToken(true);
      if (!idToken || idToken.split('.').length !== 3) {
        throw new Error('Google did not return a Firebase session token. Please try again.');
      }
      const storedHints = redirectContext && redirectContext.hints ? redirectContext.hints : {};
      const hints = Object.assign({}, storedHints, getSignupGoogleProfileHints());
      authDebug('ID token sent to backend');
      await api('POST', '/auth/firebase/google', {
        idToken,
        displayName: firebaseUser.displayName || '',
        email: firebaseUser.email || '',
        photoURL: firebaseUser.photoURL || '',
        name: hints.name || '',
        college: hints.college,
        year: hints.year
      });
      authDebug('Backend login success');
      const loggedIn = await loadState();
      if (!loggedIn || !state || !state.user || !state.user.id) {
        throw new Error('Backend session was created, but the app could not restore it.');
      }
      if (!quiet) toast('Signed in with Google.');
      openAppAfterGoogleLogin();
      return true;
    } catch (e) {
      console.error('[GoogleAuth] Firebase session exchange failed:', {
        code: e && e.code,
        message: e && e.message,
        error: e
      });
      if (!quiet) toast(firebaseLoginMessage(e));
      return false;
    } finally {
      firebaseExchangeInFlight = false;
      firebaseExchangePromise = null;
    }
  })();
  return firebaseExchangePromise;
}

async function restoreFirebaseSession() {
  const auth = await initFirebaseAuth();
  if (!auth) return false;
  if (state && state.user && state.user.id) return true;
  if (firebaseExchangePromise) return firebaseExchangePromise;
  if (auth.currentUser) return completeFirebaseLogin(auth.currentUser, true, getStoredGoogleRedirectContext());
  const user = await waitForFirebaseUser(auth);
  if (!user) return false;
  return completeFirebaseLogin(user, true, getStoredGoogleRedirectContext());
}

async function googleLogin(context) {
  const statusId = context === 'signup' ? 'signup-status' : 'login-status';
  const buttonId = context === 'signup' ? 'signupGoogleBtn' : 'loginGoogleBtn';
  try {
    setAuthStatus(statusId, 'Opening Google sign in...', 'loading');
    setButtonLoading(buttonId, true, 'Opening Google...');
    authDebug('Google login clicked', { context: context || 'login' });
    authDebug('Google auth started', { context: context || 'login' });
    const auth = await initFirebaseAuth();
    if (!auth) {
      setAuthStatus(statusId, 'Google login is not configured yet.', 'error');
      toast('Google login is not configured yet.');
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    provider.addScope('email');
    provider.addScope('profile');
    saveGoogleRedirectContext(context);
    if (shouldUseRedirectForGoogle()) {
      authDebug('Redirect started');
      await auth.signInWithRedirect(provider);
      return;
    }
    try {
      const result = await auth.signInWithPopup(provider);
      await completeFirebaseLogin(result.user, false, getStoredGoogleRedirectContext());
      clearStoredGoogleRedirectContext();
    } catch (e) {
      if (e && ['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/popup-closed-by-user'].includes(e.code)) {
        authDebug('Redirect started');
        setAuthStatus(statusId, 'Redirecting to Google...', 'loading');
        await auth.signInWithRedirect(provider);
        return;
      }
      throw e;
    }
  } catch (e) {
    console.error('[GoogleAuth] Google login error:', {
      code: e && e.code,
      message: e && e.message,
      error: e
    });
    setAuthStatus(statusId, firebaseLoginMessage(e), 'error');
    toast(firebaseLoginMessage(e));
  } finally {
    setButtonLoading(buttonId, false);
  }
}

function showAppError() {
  const active = document.querySelector('.screen.active') || document.getElementById('s-splash');
  if (active) {
    active.innerHTML = `
      <div class="app-error-state">
        <div class="app-error-title">Something did not open properly.</div>
        <p>Refresh once, or come back in a moment.</p>
        <button class="btn" type="button" onclick="location.reload()">Refresh</button>
      </div>`;
    active.classList.add('active');
  }
}

window.addEventListener('error', function() { showAppError(); });
window.addEventListener('unhandledrejection', function() { showAppError(); });

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
  'Let’s keep this simple. One small answer is enough.',
  'Just notice what feels heavy.',
  'You do not need to solve this right now.',
  'Short entries are fine. A few words count.',
  'Try starting with "I feel..." or "Today I noticed..."',
  'Write only what feels okay to share.',
  'If you\'re stuck, write about being stuck. That counts.',
  'You can write about one moment from today.',
  'There is no right way to do this. Just show up.'
];

const fallbackPromptChoices = [
  { text: 'What felt a little heavy today?', category: 'Notice' },
  { text: 'What is one thing you wish someone noticed?', category: 'One thing' },
  { text: 'What do you want to name without fixing?', category: 'Gentle' },
  { text: 'What is one tiny thing you survived today?', category: 'Tiny win' },
  { text: 'What do you want your anonymous partner to understand?', category: 'Simple' },
  { text: 'What are you not ready to say out loud yet?', category: 'Quiet' },
  { text: 'What softened today, even a little?', category: 'Light' },
  { text: 'What are you carrying that nobody can see?', category: 'Notice' },
  { text: 'What would feel easy to write tonight?', category: 'Easy' },
  { text: 'What do you need without explaining why?', category: 'Need' }
];

function normalizePromptText(text) {
  return String(text || '').replace(/^"|"$/g, '').trim();
}

function getPromptChoiceSet() {
  const fromState = state && state.match && Array.isArray(state.match.promptChoices) ? state.match.promptChoices : [];
  const base = fromState.length ? fromState : fallbackPromptChoices;
  const offset = promptChoiceOffset % base.length;
  return base.slice(offset).concat(base.slice(0, offset)).slice(0, 3);
}

function renderPromptChooser() {
  const choices = getPromptChoiceSet();
  if (!selectedPrompt && choices.length) selectedPrompt = normalizePromptText(choices[0].text);
  return `
    <div class="prompt-chooser reveal-on-scroll">
      <div class="prompt-chooser-kicker">Tonight's note</div>
      <h3 class="prompt-chooser-title">Choose what feels easiest tonight.</h3>
      <p class="prompt-chooser-sub">You can follow a prompt, or ignore all of them and write what is real.</p>
      <div class="prompt-choice-list">
        ${choices.map(function(choice) {
          const text = normalizePromptText(choice.text);
          const active = selectedPrompt === text;
          return `<button class="prompt-choice ${active ? 'selected' : ''}" type="button" data-prompt-choice="${escapeHtml(text)}">
            <span class="prompt-choice-cat">${escapeHtml(choice.category || 'Prompt')}</span>
            <span class="prompt-choice-text">${escapeHtml(text)}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="prompt-choice-actions">
        <button class="prompt-small-btn" type="button" id="usePromptBtn">Use this prompt</button>
        <button class="prompt-small-btn ghost" type="button" id="shufflePromptBtn">Show me another</button>
        <button class="prompt-small-btn ghost" type="button" id="ownPromptBtn">I'll write my own</button>
      </div>
    </div>`;
}

function bindPromptChooser() {
  document.querySelectorAll('#s-journal [data-prompt-choice]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      selectedPrompt = btn.getAttribute('data-prompt-choice');
      document.querySelectorAll('#s-journal .prompt-choice').forEach(function(item) { item.classList.remove('selected'); });
      btn.classList.add('selected');
    });
  });
  const useBtn = document.getElementById('usePromptBtn');
  if (useBtn) useBtn.addEventListener('click', function() {
    const area = document.getElementById('journal-draft');
    if (area && selectedPrompt && !area.value.trim()) {
      area.value = selectedPrompt + '\n\n';
      updateWordCount(area);
      area.focus();
    }
  });
  const shuffleBtn = document.getElementById('shufflePromptBtn');
  if (shuffleBtn) shuffleBtn.addEventListener('click', function() {
    const base = state && state.match && Array.isArray(state.match.promptChoices) && state.match.promptChoices.length ? state.match.promptChoices : fallbackPromptChoices;
    promptChoiceOffset = (promptChoiceOffset + 3) % base.length;
    selectedPrompt = null;
    renderJournal();
  });
  const ownBtn = document.getElementById('ownPromptBtn');
  if (ownBtn) ownBtn.addEventListener('click', function() {
    selectedPrompt = null;
    document.querySelectorAll('#s-journal .prompt-choice').forEach(function(item) { item.classList.remove('selected'); });
    const area = document.getElementById('journal-draft');
    if (area) {
      area.placeholder = 'One small sentence is enough...';
      area.focus();
    }
    toast('No prompt needed. Keep it small.');
  });
}

// ═══════════════════════════════════════
// LOCAL STATE
// ═══════════════════════════════════════
let scanIndex = 0;
let scanAnswers = Array(questions.length).fill(null);
let localScores = {};
let localArchetype = '';
let currentMood = null;
let matchPollTimer = null;
let countdownTimer = null;
let selectedPrompt = null;
let promptChoiceOffset = 0;
let motionRaf = null;
let lastMotionY = -1;
let typingFocusTimer = null;
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const isLowMotionDevice = prefersReducedMotion || isCoarsePointer || window.innerWidth < 760 || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

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

function initStardust() {
  const host = document.getElementById('floatParticles');
  if (!host || prefersReducedMotion || host.dataset.ready) return;
  host.dataset.ready = '1';
  const count = isLowMotionDevice ? 14 : 34;
  const cols = ['rgba(248,242,255,.72)','rgba(235,180,194,.62)','rgba(232,208,160,.58)','rgba(176,159,204,.58)'];
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('i');
    dot.className = 'stardust';
    const size = Math.random() * 1.8 + .8;
    dot.style.cssText = [
      'left:' + (Math.random() * 100).toFixed(2) + '%',
      'top:' + (Math.random() * 100).toFixed(2) + '%',
      'width:' + size.toFixed(2) + 'px',
      'height:' + size.toFixed(2) + 'px',
      'background:' + cols[Math.floor(Math.random() * cols.length)],
      '--sdx:' + ((Math.random() * 80) - 40).toFixed(1) + 'px',
      'animation-duration:' + (18 + Math.random() * 22).toFixed(1) + 's',
      'animation-delay:-' + (Math.random() * 22).toFixed(1) + 's'
    ].join(';');
    host.appendChild(dot);
  }
}

function setMotionMode(mode) {
  document.body.dataset.mpMode = mode || 'idle';
  document.body.classList.toggle('app-active', document.getElementById('app-area') && document.getElementById('app-area').style.display !== 'none');
}

function modeForScreen(id) {
  if (id === 's-journal') return 'writing';
  if (id === 's-waiting') return 'waiting';
  if (id === 's-sealed' || id === 's-past' || id === 's-profile') return 'archive';
  if (id && id.indexOf('reveal') >= 0) return 'reveal';
  if (id && id.indexOf('silent') >= 0) return 'silent';
  return 'idle';
}

function initCosmicMotion() {
  initStardust();
  if (prefersReducedMotion || motionRaf) return;
  function tick() {
    const y = window.scrollY || window.pageYOffset || 0;
    if (Math.abs(y - lastMotionY) > .5) {
      document.documentElement.style.setProperty('--mp-scroll', y.toFixed(1) + 'px');
      lastMotionY = y;
    }
    motionRaf = requestAnimationFrame(tick);
  }
  motionRaf = requestAnimationFrame(tick);
}

function enhanceDepthCards(root) {
  root = root || document;
  root.querySelectorAll('.write-box,.sealed-card,.partner-card,.entry,.archive-entry-card,.partner-status-panel,.note-card,.daily-note-card,.tq-write-box,.tq-prompt-card,.tq-whisper-card,.silent-line-block,.wall,.profile-planet-card,.traits,.si,.days-card,.contact-card').forEach(function(el) {
    if (!el.classList.contains('mp-depth-card')) el.classList.add('mp-depth-card');
  });
}

function bindFocusMode(root) {
  root = root || document;
  root.querySelectorAll('#journal-draft,#tq-draft,.silent-textarea').forEach(function(area) {
    if (area.dataset.focusBound) return;
    area.dataset.focusBound = '1';
    area.addEventListener('focus', function() {
      document.body.classList.add('focus-writing');
      document.documentElement.style.setProperty('--mp-focus', '1');
      setMotionMode('writing');
    });
    area.addEventListener('blur', function() {
      clearTimeout(typingFocusTimer);
      typingFocusTimer = setTimeout(function() {
        document.body.classList.remove('focus-writing');
        document.documentElement.style.setProperty('--mp-focus', '0');
        const active = document.querySelector('.screen.active');
        setMotionMode(modeForScreen(active && active.id));
      }, 180);
    });
    area.addEventListener('input', function() {
      document.body.classList.add('focus-writing');
      document.documentElement.style.setProperty('--mp-focus', '1');
      const orb = document.getElementById('celestialAnchor');
      if (orb && !prefersReducedMotion) {
        orb.animate([
          { transform: 'translate3d(0,calc(var(--mp-scroll) * .04 - 4px),0) scale(1.04)' },
          { transform: 'translate3d(0,calc(var(--mp-scroll) * .04 - 6px),0) scale(1.08)' },
          { transform: 'translate3d(0,calc(var(--mp-scroll) * .04 - 4px),0) scale(1.04)' }
        ], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
  });
}

function afterRenderMotion(root) {
  enhanceDepthCards(root || document);
  bindFocusMode(root || document);
}

if (!isLowMotionDevice) {
  document.addEventListener('pointermove', function(e) {
    const card = e.target.closest && e.target.closest('.mp-depth-card');
    if (!card || card.matches('textarea, input') || card.querySelector(':focus')) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / Math.max(r.width, 1);
    const py = (e.clientY - r.top) / Math.max(r.height, 1);
    card.style.setProperty('--mp-card-ry', ((px - .5) * 4.5).toFixed(2) + 'deg');
    card.style.setProperty('--mp-card-rx', ((.5 - py) * 3.5).toFixed(2) + 'deg');
    card.style.setProperty('--mp-card-glow-x', (px * 100).toFixed(1) + '%');
    card.style.setProperty('--mp-card-glow-y', (py * 100).toFixed(1) + '%');
  }, { passive: true });
  document.addEventListener('pointerout', function(e) {
    const card = e.target.closest && e.target.closest('.mp-depth-card');
    if (!card) return;
    card.style.removeProperty('--mp-card-rx');
    card.style.removeProperty('--mp-card-ry');
  }, { passive: true });
}

// Stable fix: keep the app calm and 2D. The cinematic depth/stardust layer was
// the most recent visual-risk surface and is disabled until the core app is stable.
initCosmicMotion = function() {};
afterRenderMotion = function() {};
enhanceDepthCards = function() {};
bindFocusMode = function() {};
var bindDepthHover = function() {};
initCosmicMotion();

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function go(id) {
  const prev = document.querySelector('.screen.active');
  const el = document.getElementById(id);
  if (!el) {
    showAppError();
    return;
  }
  if (prev === el) return;
  if (prev) prev.classList.remove('active','entering');
  el.classList.add('active','entering');
  setMotionMode(modeForScreen(id));
  afterRenderMotion(el);
  window.scrollTo(0,0);
}

function openAuthScreen(id) {
  showAppShell();
  go(id);
  if (history && history.replaceState && ['s-signup', 's-login', 's-reset'].includes(id)) {
    history.replaceState(null, '', `/app?screen=${encodeURIComponent(id)}`);
  }
}

function startSignup() {
  openAuthScreen('s-signup');
}

function startLogin() {
  openAuthScreen('s-login');
}

function toast(msg, duration) {
  const t = document.getElementById('toast');
  if (!t) return;
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

function getPushPreferences() {
  return Object.assign({}, defaultPushPreferences, state && state.user ? state.user.pushPreferences || {} : {});
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

function getInstallDismissedUntil() {
  return Number(localStorage.getItem('mp-install-dismissed-until') || 0);
}

function dismissInstallPrompt(days) {
  const until = Date.now() + (days || 14) * 86400000;
  localStorage.setItem('mp-install-dismissed-until', String(until));
  const el = document.getElementById('pwa-install-card');
  if (el) el.remove();
}

function showInstallPromptIfUseful() {
  if (installPromptShown || isStandaloneApp() || Date.now() < getInstallDismissedUntil()) return;
  if (!document.body.classList.contains('app-active')) return;
  if (!deferredInstallPrompt && !isIosDevice()) return;
  installPromptShown = true;
  const existing = document.getElementById('pwa-install-card');
  if (existing) existing.remove();
  const iosSteps = isIosDevice()
    ? '<div class="pwa-install-steps"><span>1. Tap Share</span><span>2. Add to Home Screen</span></div>'
    : '';
  const cta = deferredInstallPrompt
    ? '<button class="pwa-install-primary" type="button" onclick="installAppPrompt()">Install</button>'
    : '<button class="pwa-install-primary" type="button" onclick="dismissInstallPrompt(7)">Got it</button>';
  const card = document.createElement('div');
  card.id = 'pwa-install-card';
  card.className = 'pwa-install-card';
  card.innerHTML = `
    <button class="pwa-install-close" type="button" aria-label="Dismiss install prompt" onclick="dismissInstallPrompt(14)">x</button>
    <div class="pwa-install-icon"><img src="/icon-192x192.png" alt=""/></div>
    <div class="pwa-install-copy">
      <strong>Install Mentally Prepare</strong>
      <span>Open your reset from your home screen.</span>
      ${iosSteps}
    </div>
    ${cta}`;
  document.body.appendChild(card);
}

async function installAppPrompt() {
  if (!deferredInstallPrompt) {
    dismissInstallPrompt(7);
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  dismissInstallPrompt(30);
}

function verificationPendingHtml() {
  if (!state || !state.user || state.user.emailVerified) return '';
  if (sessionStorage.getItem('verify-banner-dismissed')) return '';
  return `
    <div id="verify-banner" style="margin:0 0 16px;padding:14px 16px;border:1px solid rgba(224,197,143,.24);border-radius:16px;background:rgba(224,197,143,.07);text-align:left;position:relative;">
      <button onclick="dismissVerifyBanner()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:var(--ink-m);font-size:18px;cursor:pointer;padding:4px 8px;line-height:1;" aria-label="Dismiss">&times;</button>
      <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">Verify when you get a chance</div>
      <div style="font-family:'Lora',serif;font-style:italic;font-size:12.5px;color:var(--ink-m);line-height:1.7;">Check your inbox for a verification link. Everything works without it.</div>
      <button class="btn-ghost" style="margin-top:10px" onclick="resendVerification()">Resend verification email</button>
      <div id="verification-status" class="field-error" style="min-height:18px;margin-top:8px;"></div>
    </div>`;
}

function dismissVerifyBanner() {
  sessionStorage.setItem('verify-banner-dismissed', '1');
  var banners = document.querySelectorAll('#verify-banner, #verification-pending-inline');
  banners.forEach(function(el) { el.remove(); });
}

function injectVerificationPendingNotice(screenId) {
  const el = document.getElementById(screenId);
  if (!el || !state || !state.user || state.user.emailVerified || el.querySelector('#verification-pending-inline')) return;
  if (sessionStorage.getItem('verify-banner-dismissed')) return;
  el.insertAdjacentHTML('afterbegin', `<div id="verification-pending-inline" style="padding:16px 20px 0;">${verificationPendingHtml()}</div>`);
}

function consumeVerificationQueryNotice() {
  const params = new URLSearchParams(window.location.search);
  let message = '';
  if (params.get('verified') === '1') message = 'Verification successful. You can now continue.';
  if (params.get('verify_error') === 'expired') message = 'Verification link expired. Please request a new one.';
  if (params.get('verify_error') === 'invalid') message = 'Verification link is invalid. Please request a new one.';
  if (params.get('verify_error') === 'system') message = 'Verification failed. Please request a new one.';
  if (!message) return;
  params.delete('verified');
  params.delete('verify_error');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? '?' + query : ''}${window.location.hash}`);
  setTimeout(() => toast(message, 4200), 250);
}

function consumeAuthScreenDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen');
  const allowedScreens = ['s-signup', 's-login', 's-reset'];
  if (!allowedScreens.includes(screen)) return false;
  const code = (params.get('code') || '').trim();
  showAppShell();
  go(screen);
  if (screen === 's-reset') {
    const input = document.getElementById('reset-code');
    if (input && code) {
      const compactCode = code.replace(/\s+/g, '');
      input.value = compactCode.length === 6 ? compactCode.toUpperCase() : compactCode;
    }
  }
  params.delete('screen');
  params.delete('code');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? '?' + query : ''}${window.location.hash}`);
  if (screen === 's-reset' && code) setTimeout(() => toast('Reset code filled. Choose a new password.', 3200), 250);
  return true;
}

function shouldOpenAuthDeepLinkBeforeSessionRestore() {
  if (window.location.pathname.indexOf('/app') !== 0) return false;
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen');
  if (!['s-signup', 's-login', 's-reset'].includes(screen)) return false;
  return !hasPendingGoogleRedirectContext();
}

function typingDots() { return '<div class="typing-dots"><span></span><span></span><span></span></div>'; }

// ═══════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════
function startApp() {
  showAppShell();
  document.getElementById('navCta').textContent = '← Back to Home';
  document.getElementById('navCta').onclick = function() { showLanding(); };
  const navLoginBtn = document.getElementById('navLoginBtn');
  if (navLoginBtn) navLoginBtn.style.display = 'none';
  // Close mobile menu if open
  const navLinks = document.querySelector('.site-nav-links');
  if (navLinks) navLinks.classList.remove('open');
  // If already logged in, route to correct screen
  if (state) { routeToScreen(); }
  else { go('s-signup'); }
  window.scrollTo(0, 0);
  setTimeout(showInstallPromptIfUseful, 900);
}

function showAppShell() {
  const landing = document.getElementById('landing');
  const appArea = document.getElementById('app-area');
  const active = document.querySelector('.screen.active');
  if (landing) landing.style.display = 'none';
  if (appArea) appArea.style.display = 'block';
  document.body.classList.add('app-active');
  setMotionMode(modeForScreen(active && active.id));
}

function getLandingTargetFromHash(hash) {
  const value = String(hash || window.location.hash || '').replace(/^#/, '');
  if (!value) return '';
  if (value === 'how' || value === 'l-archetypes' || value === 'l-stories' || value === 'l-problem') return value;
  if (value === 'stories') return 'l-stories';
  return '';
}

function showLanding(targetId) {
  const landing = document.getElementById('landing');
  const appArea = document.getElementById('app-area');
  if (landing) landing.style.display = '';
  if (appArea) appArea.style.display = 'none';
  document.body.classList.remove('app-active','focus-writing');
  setMotionMode('idle');
  document.getElementById('navCta').textContent = 'Sign up';
  document.getElementById('navCta').onclick = startSignup;
  const navLoginBtn = document.getElementById('navLoginBtn');
  if (navLoginBtn) {
    navLoginBtn.style.display = '';
    navLoginBtn.onclick = startLogin;
  }
  window.scrollTo(0, 0);
  if (targetId) {
    setTimeout(function() {
      var el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 80);
  }
}

function navTo(id) {
  showLanding(getLandingTargetFromHash('#' + id) || id);
  if (history && history.replaceState) history.replaceState(null, '', '/app#' + id);
  const navLinks = document.querySelector('.site-nav-links');
  const menuBtn = document.getElementById('siteMenuBtn');
  if (navLinks) navLinks.classList.remove('open');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}

function handleLandingHash() {
  const target = getLandingTargetFromHash();
  if (!target) return false;
  showLanding(target);
  return true;
}

function bindStaticUi() {
  const siteNavLogo = document.getElementById('siteNavLogo');
  const navCta = document.getElementById('navCta');
  const navLoginBtn = document.getElementById('navLoginBtn');
  const siteMenuBtn = document.getElementById('siteMenuBtn');
  const heroStartBtn = document.getElementById('heroStartBtn');
  const heroSignupBtn = document.getElementById('heroSignupBtn');
  const heroLoginBtn = document.getElementById('heroLoginBtn');
  const heroHowLink = document.getElementById('heroHowLink');
  const heroScrollBtn = document.getElementById('heroScrollBtn');

  if (siteNavLogo) {
    siteNavLogo.addEventListener('click', function(e) {
      e.preventDefault();
      showLanding();
    });
  }

  if (navCta) navCta.onclick = startSignup;
  if (navLoginBtn) navLoginBtn.onclick = startLogin;
  if (siteMenuBtn) siteMenuBtn.addEventListener('click', toggleSiteMenu);
  if (heroStartBtn) heroStartBtn.addEventListener('click', startSignup);
  if (heroSignupBtn) heroSignupBtn.addEventListener('click', startSignup);
  if (heroLoginBtn) heroLoginBtn.addEventListener('click', startLogin);

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

  document.querySelectorAll('[data-auth-target]').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      openAuthScreen(link.getAttribute('data-auth-target'));
      const navLinks = document.querySelector('.site-nav-links');
      const menuBtn = document.getElementById('siteMenuBtn');
      if (navLinks) navLinks.classList.remove('open');
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    });
  });

  document.addEventListener('click', function(e) {
    const tab = e.target.closest && e.target.closest('[data-app-tab]');
    if (!tab) return;
    e.preventDefault();
    navigateAppTab(tab.getAttribute('data-app-tab'));
  });

  document.querySelectorAll('.site-footer-links a[href^="/app#"]').forEach(function(link) {
    link.addEventListener('click', function(e) {
      const target = getLandingTargetFromHash(link.hash);
      if (!target) return;
      e.preventDefault();
      history.pushState(null, '', link.getAttribute('href'));
      showLanding(target);
    });
  });

  window.addEventListener('hashchange', handleLandingHash);

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
  if (shouldOpenAuthDeepLinkBeforeSessionRestore()) {
    consumeAuthScreenDeepLink();
    consumeVerificationQueryNotice();
    return;
  }
  const firebaseRestored = await restoreFirebaseSession();
  const loggedIn = firebaseRestored || await loadState();
  if (window.location.pathname.indexOf('/app') === 0 && consumeAuthScreenDeepLink()) {
    consumeVerificationQueryNotice();
    return;
  }
  if (window.location.pathname.indexOf('/app') === 0 && handleLandingHash()) {
    consumeVerificationQueryNotice();
    return;
  }
  if (!loggedIn) {
    if (window.location.pathname.indexOf('/app') === 0) {
      startApp();
    }
    consumeVerificationQueryNotice();
    return;
  }

  // Auto-start app for logged-in users
  startApp();
  consumeVerificationQueryNotice();
})();

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════
function setButtonLoading(id, isLoading, label) {
  const btn = document.getElementById(id);
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = label || 'Working...';
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.idleLabel) btn.innerHTML = btn.dataset.idleLabel;
  }
}

function setAuthStatus(id, message, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('is-error', 'is-success', 'is-loading');
  if (kind) el.classList.add('is-' + kind);
}

function fieldError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('invalid', !!message);
  let msg = el.parentElement && el.parentElement.querySelector('.field-error');
  if (!msg && el.parentElement) {
    msg = document.createElement('div');
    msg.className = 'field-error';
    el.parentElement.appendChild(msg);
  }
  if (msg) msg.textContent = message || '';
}

function clearSignupErrors() {
  ['inp-name', 'inp-college', 'inp-email', 'inp-password'].forEach(id => fieldError(id, ''));
  document.querySelectorAll('.signup-step-error').forEach(el => el.remove());
}

function showStepError(containerSelector, message) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'field-error signup-step-error';
  el.textContent = message;
  container.appendChild(el);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function needsGoogleProfileBasics(user) {
  user = user || (state && state.user);
  if (!user) return false;
  const provider = String(user.authProvider || '').toLowerCase();
  if (provider.indexOf('google') === -1) return false;
  const college = String(user.college || '').trim().toLowerCase();
  const year = String(user.year || '').trim();
  return !college || college === 'not provided' || !year;
}

function hasCompletedScan(user) {
  return !!(user && archetypes[user.archetype]);
}

function getPostAuthDestination(currentState) {
  if (!currentState || !currentState.user) return { screen: 's-splash' };
  if (needsGoogleProfileBasics(currentState.user)) return { screen: 's-profile', action: 'google-profile-basics' };
  if (!hasCompletedScan(currentState.user)) return { screen: 's-scan-intro', action: 'scan' };
  if (!currentState.match) return { screen: 's-waiting', action: 'waiting' };
  if (Number(currentState.match.day) >= 21) return { screen: 's-reveal-wait', action: 'reveal' };
  const entries = Array.isArray(currentState.entries) ? currentState.entries : [];
  const todayDone = entries.some(function(entry) {
    return Number(entry.day) === Number(currentState.match.day);
  });
  return todayDone
    ? { screen: 's-sealed', action: 'sealed' }
    : { screen: 's-journal', action: 'journal' };
}

function pickProfileYear(el) {
  const row = el && el.closest('.year-row');
  if (!row) return;
  row.querySelectorAll('.year-btn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
}

function renderGoogleProfileBasics() {
  const existingCollege = state && state.user && String(state.user.college || '').trim().toLowerCase() !== 'not provided'
    ? state.user.college
    : '';
  const existingYear = state && state.user ? state.user.year || '' : '';
  document.getElementById('s-profile').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div></div>
    <div style="padding:30px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:8px;">One last detail</div>
      <div style="font-family:'Playfair Display',serif;font-size:30px;font-weight:400;line-height:1.05;margin-bottom:10px;">Complete your <em style="font-style:italic;color:var(--rose-l);">college basics.</em></div>
      <p style="font-family:'Lora',serif;font-style:italic;font-size:14px;color:var(--ink-m);line-height:1.8;margin-bottom:24px;">Google filled your name and email. We only need college and year so matching can avoid your own college.</p>
      <div class="input-block"><label class="input-label">Your college</label><input class="input-field" type="text" id="profile-college" list="college-list" placeholder="e.g. Miranda House, Delhi" value="${escapeHtml(existingCollege)}"/><div class="field-help">This stays private unless you choose to reveal it later.</div></div>
      <div class="input-block"><label class="input-label">Your year</label>
        <div class="year-row" id="profile-year-row">
          ${['1st','2nd','3rd','4th','5th+'].map(y => `<button class="year-btn ${existingYear === y ? 'on' : ''}" onclick="pickProfileYear(this)">${y}</button>`).join('')}
        </div>
      </div>
      <button class="btn btn-next" onclick="saveGoogleProfileBasics()" style="background:linear-gradient(135deg,var(--gold),var(--rose-d));">Continue</button>
    </div>`;
}

async function saveGoogleProfileBasics() {
  const collegeEl = document.getElementById('profile-college');
  const yearEl = document.querySelector('#profile-year-row .year-btn.on');
  const college = collegeEl ? collegeEl.value.trim() : '';
  const year = yearEl ? yearEl.textContent.trim() : '';
  fieldError('profile-college', '');
  document.querySelectorAll('#profile-year-row .signup-step-error').forEach(el => el.remove());
  if (college.length < 3) { fieldError('profile-college', 'Please enter your college name.'); return; }
  if (!year) { showStepError('#profile-year-row', 'Please choose your year.'); return; }

  try {
    await api('POST', '/profile/basics', { college, year });
    await loadState();
    toast('Profile saved.');
    routeToScreen();
  } catch (e) {
    toast(e.message);
  }
}

function renderEditProfile() {
  if (!state || !state.user) return;
  const isLocked = !!state.match;
  const existingYear = state.user.year || '';
  document.getElementById('s-settings').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><button class="btn-ghost" style="width:auto;padding:8px 16px;" onclick="renderSettings();go('s-settings')">← Back</button></div>
    <div style="padding:24px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:8px;">Profile</div>
      <div style="font-family:'Playfair Display',serif;font-size:28px;font-weight:400;line-height:1.05;margin-bottom:10px;">Your <em style="font-style:italic;color:var(--rose-l);">basics.</em></div>
      <p style="font-family:'Lora',serif;font-style:italic;font-size:13px;color:var(--ink-m);line-height:1.8;margin-bottom:20px;">${isLocked ? 'College and year are locked after matching starts so your anonymous room stays consistent.' : 'You can edit these before matching starts. College helps us avoid matching you with someone from the same place.'}</p>
      <div class="input-block"><label class="input-label">Your name</label><input class="input-field" type="text" id="edit-name" value="${escapeHtml(state.user.name || '')}" ${isLocked ? 'disabled' : ''}/></div>
      <div class="input-block"><label class="input-label">Your college</label><input class="input-field" type="text" id="edit-college" list="college-list" value="${escapeHtml(state.user.college || '')}" ${isLocked ? 'disabled' : ''}/></div>
      <div class="input-block"><label class="input-label">Your year</label>
        <div class="year-row" id="edit-year-row">
          ${['1st','2nd','3rd','4th','5th+'].map(y => `<button class="year-btn ${existingYear === y ? 'on' : ''}" onclick="pickProfileYear(this)" ${isLocked ? 'disabled' : ''}>${y}</button>`).join('')}
        </div>
      </div>
      ${isLocked
        ? `<button class="btn-ghost" type="button" onclick="renderSettings();go('s-settings')">Back to settings</button>`
        : `<button class="btn btn-next" onclick="saveProfileEdits()" style="background:linear-gradient(135deg,var(--gold),var(--rose-d));">Save profile</button>`}
    </div>
    <div class="spacer"></div>`;
  go('s-settings');
}

async function saveProfileEdits() {
  const nameEl = document.getElementById('edit-name');
  const collegeEl = document.getElementById('edit-college');
  const yearEl = document.querySelector('#edit-year-row .year-btn.on');
  const name = nameEl ? nameEl.value.trim() : '';
  const college = collegeEl ? collegeEl.value.trim() : '';
  const year = yearEl ? yearEl.textContent.trim() : '';
  fieldError('edit-name', '');
  fieldError('edit-college', '');
  document.querySelectorAll('#edit-year-row .signup-step-error').forEach(el => el.remove());
  if (name.length < 2) { fieldError('edit-name', 'Name must be at least 2 characters.'); return; }
  if (college.length < 3) { fieldError('edit-college', 'Please enter your college name.'); return; }
  if (!year) { showStepError('#edit-year-row', 'Please choose your year.'); return; }

  try {
    await api('POST', '/profile', { name, college, year });
    await loadState();
    toast('Profile saved.');
    renderSettings();
    go('s-settings');
  } catch (e) {
    toast(e.message);
  }
}

function continueFromSignupBasics() {
  const name = document.getElementById('inp-name').value.trim();
  const college = document.getElementById('inp-college').value.trim();
  const email = document.getElementById('inp-email').value.trim();
  const password = document.getElementById('inp-password').value;
  const yearEl = document.querySelector('.year-btn.on');
  clearSignupErrors();
  let ok = true;
  if (name.length < 2) { fieldError('inp-name', 'Name must be at least 2 characters.'); ok = false; }
  if (college.length < 3) { fieldError('inp-college', 'Please enter your college name.'); ok = false; }
  if (!yearEl) { showStepError('.year-row', 'Please choose your year.'); ok = false; }
  if (!email) { fieldError('inp-email', 'Please enter your email.'); ok = false; }
  else if (!validEmail(email)) { fieldError('inp-email', 'Please enter a valid email.'); ok = false; }
  if (!password || password.length < 8) { fieldError('inp-password', 'Password must be at least 8 characters.'); ok = false; }
  if (ok) go('s-ob4b');
}

function continueFromPreferences() {
  document.querySelectorAll('.signup-step-error').forEach(el => el.remove());
  let ok = true;
  if (!prefGender) { showStepError('#gender-grid', 'Please choose your gender.'); ok = false; }
  if (!prefMatchGender) { showStepError('#match-gender-grid', 'Please choose who you feel comfortable matching with.'); ok = false; }
  if (!prefMatchYear) { showStepError('#match-year-grid', 'Please choose your partner year preference.'); ok = false; }
  if (ok) go('s-ob5');
}

async function register() {
  const name = document.getElementById('inp-name').value.trim();
  const college = document.getElementById('inp-college').value.trim();
  const email = document.getElementById('inp-email').value.trim();
  const password = document.getElementById('inp-password').value;
  const yearEl = document.querySelector('.year-btn.on');
  const year = yearEl ? yearEl.textContent.trim() : '';

  clearSignupErrors();
  let ok = true;
  if (name.length < 2) { fieldError('inp-name', 'Name must be at least 2 characters.'); ok = false; }
  if (college.length < 3) { fieldError('inp-college', 'Please enter your college name.'); ok = false; }
  if (!year) { showStepError('.year-row', 'Please choose your year.'); ok = false; }
  if (!email) { fieldError('inp-email', 'Please enter your email.'); ok = false; }
  else if (!validEmail(email)) { fieldError('inp-email', 'Please enter a valid email.'); ok = false; }
  if (!password || password.length < 8) { fieldError('inp-password', 'Password must be at least 8 characters.'); ok = false; }
  if (!prefGender) { showStepError('#gender-grid', 'Please choose your gender.'); ok = false; }
  if (!prefMatchGender) { showStepError('#match-gender-grid', 'Please choose who you feel comfortable matching with.'); ok = false; }
  if (!prefMatchYear) { showStepError('#match-year-grid', 'Please choose your partner year preference.'); ok = false; }

  const ageChecked = document.getElementById('ageCheckbox').checked;
  const consentGiven = document.getElementById('consentCheckbox').checked;
  if (!ageChecked) { toast('You must confirm you are 18 or older.'); ok = false; }
  if (!consentGiven) { toast('Please accept the consent before continuing.'); ok = false; }
  if (!ok) return;

  try {
    setAuthStatus('register-status', 'Creating your private room...', 'loading');
    setButtonLoading('registerSubmitBtn', true, 'Creating account...');
    const result = await api('POST', '/register', { name, email, password, college, year, gender: prefGender, matchGenderPref: prefMatchGender, matchYearPref: prefMatchYear, consentGiven, ageConfirmed: ageChecked });
    await loadState();
    // Make sure app area is visible
    showAppShell();
    toast(result.message || 'Account created. You can continue now.', 3600);
    setAuthStatus('register-status', 'Account created. Starting your scan...', 'success');
    injectVerificationPendingNotice('s-scan-intro');
    go('s-scan-intro');
  } catch (e) {
    await loadState().catch(() => {});
    if (state && state.user && !state.user.emailVerified) {
      showAppShell();
      toast('Account created. Verify your email when you get a chance.', 3600);
      setAuthStatus('register-status', 'Account created. Verify your email when you can.', 'success');
      go('s-scan-intro');
      return;
    }
    setAuthStatus('register-status', e.message || 'Signup failed. Please try again.', 'error');
    toast(e.message);
  } finally {
    setButtonLoading('registerSubmitBtn', false);
  }
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) {
    setAuthStatus('login-status', 'Enter email and password.', 'error');
    toast('Enter email and password');
    return;
  }

  try {
    setAuthStatus('login-status', 'Opening your room...', 'loading');
    setButtonLoading('loginSubmitBtn', true, 'Logging in...');
    await api('POST', '/login', { email, password });
    await loadState();
    // Make sure app area is visible
    showAppShell();
    toast('Welcome back! ✦');
    routeToScreen();
  } catch (e) {
    setAuthStatus('login-status', e.message || 'Login failed. Please try again.', 'error');
    toast(e.message);
  } finally {
    setButtonLoading('loginSubmitBtn', false);
  }
}

async function logout() {
  if (firebaseAuthClient) await firebaseAuthClient.signOut().catch(() => {});
  await api('POST', '/logout');
  state = null;
  sessionStorage.removeItem('mp-draft');
  showLanding();
  toast('Logged out ✓');
}

function routeToScreen() {
  const destination = getPostAuthDestination(state);
  if (destination.action === 'google-profile-basics') { renderGoogleProfileBasics(); go(destination.screen); return; }
  if (destination.action === 'scan') { injectVerificationPendingNotice('s-scan-intro'); go(destination.screen); return; }
  if (destination.action === 'waiting') { renderWaiting(); go(destination.screen); return; }
  if (destination.action === 'reveal') {
    if (!handleRevealFlow()) { renderSealed(); go('s-sealed'); }
    return;
  }
  if (destination.action === 'sealed') { renderSealed(); go(destination.screen); return; }
  if (destination.action === 'journal') { renderJournal(); go(destination.screen); return; }
  go(destination.screen);
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
  const prefs = getPushPreferences();
  prefs.enabled = !el.classList.contains('off');
  savePushPreferences(prefs, true);
}

// ═══════════════════════════════════════
// PREFERENCES
// ═══════════════════════════════════════
let prefGender = '';
let prefMatchGender = '';
let prefMatchYear = '';

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
function showSafety() {
  const overlay = document.getElementById('safety-overlay');
  const card = overlay && overlay.querySelector('.safety-card');
  if (card && !document.getElementById('safetyHelpActions')) {
    const actions = document.createElement('div');
    actions.id = 'safetyHelpActions';
    actions.innerHTML = `
      <button class="btn" onclick="window.location.href='tel:14416'" style="margin-bottom:8px;">Get help now</button>
      <button class="btn-ghost" onclick="closeSafety();routeToScreen();" style="margin-bottom:8px;">Pause journaling</button>`;
    const helplines = card.querySelector('.safety-helplines');
    if (helplines) helplines.insertAdjacentElement('afterend', actions);
  }
  if (overlay) overlay.classList.add('show');
}
function closeSafety() { document.getElementById('safety-overlay').classList.remove('show'); }

function renderEmailVerification() {
  const email = state && state.user ? state.user.email : 'your email';
  const el = document.getElementById('s-scan-intro');
  if (!el) return;
  el.innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div></div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;">
      <div style="font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);opacity:.8;margin-bottom:14px;">You're in</div>
      <h1 style="font-family:'Playfair Display',serif;font-size:32px;font-weight:400;line-height:1;margin-bottom:16px;">Welcome to<br/><em style="font-style:italic;color:var(--rose-l);">Mentally Prepare</em></h1>
      <p style="font-family:'Lora',serif;font-style:italic;font-size:14px;color:var(--ink-m);line-height:1.8;margin-bottom:24px;max-width:360px;">We sent a verification link to ${escapeHtml(email)}. Verify when you get a chance — everything works without it.</p>
      <button class="btn" onclick="routeToScreen()">Continue to your scan</button>
      <div style="margin-top:16px;">
        <button class="btn-ghost" onclick="resendVerification()">Resend verification email</button>
        <div id="verification-status" class="field-error" style="min-height:18px;margin-top:8px;text-align:center;"></div>
      </div>
    </div>`;
}

async function resendVerification() {
  try {
    const status = document.getElementById('verification-status');
    if (status) status.textContent = 'Sending...';
    const result = await api('POST', '/resend-verification', {});
    if (status) status.textContent = '';
    toast(result.message || 'Verification email sent.');
  } catch (e) {
    const status = document.getElementById('verification-status');
    if (status) status.textContent = e.message;
    toast(e.message);
  }
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  closeSafety();
  closeEntryDetail();
});

function injectUrgentHelpButton() {
  if (document.getElementById('urgentHelpBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'urgentHelpBtn';
  btn.className = 'urgent-help-btn';
  btn.type = 'button';
  btn.textContent = 'I need urgent help';
  btn.addEventListener('click', showSafety);
  document.body.appendChild(btn);
}

document.addEventListener('DOMContentLoaded', injectUrgentHelpButton);

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
  const answeredCount = scanAnswers.filter(v => v !== null).length;
  const pct = Math.round((answeredCount / questions.length) * 100);
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
      <div class="progress-row"><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><div class="progress-label">${answeredCount} of ${questions.length} answered</div></div>
      <div class="q-category">${escapeHtml(q.category)}</div>
    </div>
    <div style="padding:0 24px;">
      <div class="q-card">
        <div class="q-num">Question ${scanIndex+1}</div>
        <div class="q-text">${escapeHtml(q.text)}</div>
      </div>
      ${inputHTML}
      <div class="nav-row">
        <button class="btn-skip" onclick="prevScanQ()" ${scanIndex === 0 ? 'disabled' : ''}>Back</button>
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
  const nextBtn = document.querySelector('#s-scan .btn-next');
  if (nextBtn) nextBtn.disabled = val === null;
}

function pickScanSlider(val) {
  scanAnswers[scanIndex] = parseInt(val);
  const labels = ['','Strongly disagree','Disagree','Slightly disagree','Neutral','Slightly agree','Agree','Strongly agree'];
  const lbl = document.getElementById('slider-label');
  if (lbl) { lbl.textContent = labels[val]; lbl.style.color = 'var(--rose-l)'; }
  const nextBtn = document.querySelector('#s-scan .btn-next');
  if (nextBtn) nextBtn.disabled = false;
}
function nextScanQ() {
  if (scanAnswers[scanIndex] === null) { toast('Please answer this question before continuing.'); return; }
  if (scanIndex < questions.length - 1) { scanIndex++; renderScan(); go('s-scan'); }
}
function prevScanQ() { if (scanIndex > 0) { scanIndex--; renderScan(); go('s-scan'); } }

function calculateScoresLocal() {
  const totals = { openness:0, awareness:0, guard:0, reciprocity:0 };
  const counts = { openness:0, awareness:0, guard:0, reciprocity:0 };
  questions.forEach((q, idx) => {
    let val = scanAnswers[idx];
    if (val === null) throw new Error('Please answer every scan question before continuing.');
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
  if (scanAnswers.some(v => v === null)) { toast('Please answer every scan question before continuing.'); return; }
  calculateScoresLocal();
  try {
    const { matched } = await api('POST', '/scan', { scores: localScores, archetype: localArchetype, answers: scanAnswers });
    await loadState();
    renderResult(matched);
    go('s-result');
  } catch (e) { toast(e.message); }
}

function renderCosmicOrb(archKey) {
  return `<div class="cosmic-orb ${archKey}" style="animation:float 5s ease-in-out infinite">
    <div class="cosmic-orb-glow"></div>
    <div class="cosmic-orb-body"></div>
    <div class="cosmic-orb-ring"><div class="orbit-dot"></div></div>
  </div>`;
}

function renderConstellationCorners() {
  const star = `<svg viewBox="0 0 50 50"><circle cx="12" cy="8" r="1.5" fill="rgba(248,242,255,.6)"/><circle cx="38" cy="14" r="1" fill="rgba(248,242,255,.4)"/><circle cx="25" cy="35" r="1.2" fill="rgba(248,242,255,.5)"/><circle cx="8" cy="42" r="1" fill="rgba(248,242,255,.3)"/><line x1="12" y1="8" x2="38" y2="14" stroke="rgba(248,242,255,.15)" stroke-width=".5"/><line x1="38" y1="14" x2="25" y2="35" stroke="rgba(248,242,255,.15)" stroke-width=".5"/><line x1="25" y1="35" x2="8" y2="42" stroke="rgba(248,242,255,.15)" stroke-width=".5"/></svg>`;
  return `<div class="constellation-corner tl">${star}</div><div class="constellation-corner br">${star}</div>`;
}

function renderConnectionScore(score) {
  const offset = 283 - (283 * score / 100);
  const desc = score >= 80 ? 'Deep sync — you\'re in rhythm' : score >= 50 ? 'Growing connection' : score >= 25 ? 'Getting started' : 'Keep writing together';
  return `<div class="connection-score reveal-on-scroll">
    <svg width="0" height="0"><defs><linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="var(--cyan)"/><stop offset="100%" stop-color="var(--purple-l)"/></linearGradient></defs></svg>
    <div class="score-ring-wrap">
      <svg viewBox="0 0 100 100"><circle class="score-ring-bg" cx="50" cy="50" r="45"/><circle class="score-ring-fill" cx="50" cy="50" r="45" style="stroke-dashoffset:${offset}"/></svg>
      <div class="score-ring-value">${score}</div>
    </div>
    <div class="score-info"><div class="score-label">Writing rhythm</div><div class="score-desc">${desc}</div></div>
  </div>`;
}

function renderResult(matched) {
  const archKey = state.user.archetype;
  const arch = archetypes[archKey];
  const s = state.user.scores;

  const actionBtn = matched
    ? `<button class="btn" onclick="goToJournal()" style="margin-bottom:10px;">Write Day 1</button>`
    : `<button class="btn" onclick="renderWaiting();go('s-waiting')" style="margin-bottom:10px;">Write while you wait</button>`;

  document.getElementById('s-result').innerHTML = `
    <div class="result-tag">Your Connection Profile</div>
    <div class="result-cosmic-card ${archKey}">
      ${renderConstellationCorners()}
      ${renderCosmicOrb(archKey)}
      <div class="result-type" style="margin-top:8px;">${arch.name}</div>
      <p class="result-line" style="margin-bottom:0;">${arch.quote}</p>
    </div>
    <div style="padding:0 24px;margin-bottom:14px;"><div style="font-family:'Lora',serif;font-style:italic;font-size:13.5px;color:var(--ink-m);line-height:1.85;text-align:center;">${arch.description}</div></div>
    <div class="result-card">
      <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:14px;">ECP-11 · Emotional Connection Profile</div>
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
    ${verificationPendingHtml()}
    ${actionBtn}
    <button class="share-btn" onclick="shareArchetype()" style="margin-bottom:10px;">📋 Share my archetype</button>`;
  setTimeout(() => {
    document.querySelectorAll('#s-result .trait-fill').forEach(bar => { bar.style.width = bar.dataset.w; });
  }, 400);
}

// ═══════════════════════════════════════
// TONIGHT'S QUESTION (Waiting Room)
// ═══════════════════════════════════════
let tqData = null;
let tqMood = null;

async function loadTonightsQuestion() {
  try {
    tqData = await api('GET', '/tonights-question');
    return tqData;
  } catch { tqData = null; return null; }
}

function renderWaiting() {
  // Load Tonight's Question data, then render
  loadTonightsQuestion().then(function(data) {
    if (!data || data.matched) {
      // User got matched while loading
      if (state && state.match) { renderJournal(); go('s-journal'); return; }
    }
    renderTonightsQuestion(data);
  });
}

function renderTonightsQuestion(data) {
  if (!state || !state.user || !hasCompletedScan(state.user)) {
    injectVerificationPendingNotice('s-scan-intro');
    go('s-scan-intro');
    return;
  }
  const arch = archetypes[state.user.archetype];
  const d = data || {};
  const prompt = d.prompt || prompts[0];
  const hasWritten = !!d.myEntry;
  const nightsWritten = d.nightsWritten || 0;
  const writerCount = d.writerCount || 0;
  const whispers = d.whispers || [];
  const draft = hasWritten ? d.myEntry.text : (sessionStorage.getItem('mp-tq-draft') || '');

  if (hasWritten) {
    renderTQSealed(d);
    return;
  }

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today = new Date();

  // Night pips (show up to 10)
  const pipCount = Math.min(nightsWritten + 1, 10);
  let pipsHTML = '';
  for (let i = 0; i < pipCount; i++) {
    if (i < nightsWritten) pipsHTML += '<div class="tq-pip done"></div>';
    else pipsHTML += '<div class="tq-pip now"></div>';
  }

  document.getElementById('s-waiting').innerHTML = `
    <div class="tq-body">
      ${verificationPendingHtml()}
      <div class="nav"><div class="nav-logo"><div class="site-nav-orb" style="width:20px;height:20px;"></div>mentally prepare</div><div class="day-pill">Night ${nightsWritten + 1}</div></div>
      <div class="tq-hero">
        <div class="tq-moon-wrap">
          <div class="tq-moon-ring"></div>
          <div class="tq-moon-ring tq-moon-ring2"></div>
          <div class="tq-moon"></div>
        </div>
        <div class="tq-eyebrow">Tonight's question</div>
        <div class="tq-greeting">${getGreeting(state.user.name)}</div>
        <div class="tq-sub">One small answer is enough. Your match is on the way.</div>
      </div>

      ${writerCount > 0 ? `<div class="tq-counter"><div class="tq-counter-dot"></div><div class="tq-counter-text"><span class="tq-counter-num">${writerCount}</span> ${writerCount === 1 ? 'person' : 'people'} wrote tonight</div></div>` : ''}

      <div class="tq-streak">
        <div class="tq-streak-top"><div class="tq-streak-lbl">Your nights</div><div class="tq-streak-ct">✦ ${nightsWritten} written</div></div>
        <div class="tq-pips">${pipsHTML}</div>
      </div>

      <div class="tq-prompt-block">
        <div class="tq-prompt-card">
          <div class="tq-prompt-ey">Tonight's question</div>
          <div class="tq-prompt-text">${escapeHtml(prompt)}</div>
        </div>
      </div>

      <div class="tq-mood-block">
        <div class="mood-lbl">How are you tonight?</div>
        <div class="moods">
          ${['🌑|Heavy','🌒|Quiet','🌓|Okay','🌔|Lighter','🌕|Good'].map(function(m) {
            var parts = m.split('|');
            return '<button class="mood ' + (tqMood === parts[0] ? 'on' : '') + '" type="button" data-tq-mood="' + parts[0] + '" aria-pressed="' + (tqMood === parts[0] ? 'true' : 'false') + '"><div class="mood-em">' + parts[0] + '</div><div class="mood-w">' + parts[1] + '</div></button>';
          }).join('')}
        </div>
      </div>

      <div class="writing-tip"><div class="writing-tip-ico">💡</div><div class="writing-tip-text">${getWritingTip(nightsWritten + 1)}</div></div>

      <div class="tq-write-block">
        <div class="tq-write-box">
          <div class="tq-write-date">${dayNames[today.getDay()]}, ${today.getDate()} ${monthNames[today.getMonth()]} · Night ${nightsWritten + 1}</div>
          <textarea id="tq-draft" placeholder="Write one small thing tonight...">${escapeHtml(draft)}</textarea>
          <div class="tq-write-ft"><div class="ww" id="tq-ww">${wordCount(draft)} words</div></div>
        </div>
      </div>

      <div class="tq-cta-block">
        <button class="tq-seal-btn" id="tqSealBtn" type="button">Seal tonight's note</button>
        <button class="btn-ghost" id="tqSaveDraftBtn" type="button" style="margin-top:8px;">Save draft</button>
      </div>

      <div class="tq-waiting-info">
        <div class="tq-waiting-ico">🔍</div>
        <div class="tq-waiting-text">Finding someone gentle to write with. While you wait, this note stays private.</div>
      </div>

      ${whispers.length > 0 ? renderWhispers(whispers) : ''}

      <div style="height:20px;"></div>
      ${renderTQTabs('tonight')}
    </div>`;

  // Event listeners
  document.querySelectorAll('#s-waiting [data-tq-mood]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      tqMood = btn.getAttribute('data-tq-mood');
      btn.closest('.moods').querySelectorAll('.mood').forEach(function(x) {
        x.classList.remove('on'); x.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
    });
  });

  var tqDraft = document.getElementById('tq-draft');
  if (tqDraft) {
    tqDraft.addEventListener('input', function() {
      sessionStorage.setItem('mp-tq-draft', tqDraft.value);
      var n = tqDraft.value.trim().split(/\s+/).filter(Boolean).length;
      document.getElementById('tq-ww').textContent = n + ' word' + (n !== 1 ? 's' : '');
    });
  }

  var sealBtn = document.getElementById('tqSealBtn');
  if (sealBtn) sealBtn.addEventListener('click', sealTonightsEntry);

  var saveDraftBtn = document.getElementById('tqSaveDraftBtn');
  if (saveDraftBtn) saveDraftBtn.addEventListener('click', function() {
    var area = document.getElementById('tq-draft');
    if (area) sessionStorage.setItem('mp-tq-draft', area.value);
    toast('Draft saved ✓');
  });

  afterRenderMotion(document.getElementById('s-waiting'));

  // Poll for match
  clearInterval(matchPollTimer);
  matchPollTimer = setInterval(async function() {
    var ok = await loadState();
    if (ok && state.match) {
      clearInterval(matchPollTimer);
      spawnParticles();
      toast('Match found! 🌙');
      setTimeout(function() { renderJournal(); go('s-journal'); }, 600);
    }
  }, 15000);
}

function renderWhispers(whispers) {
  if (!whispers || !whispers.length) return '';
  var showCount = Math.min(whispers.length, 5);
  var cards = whispers.slice(0, showCount).map(function(w) {
    var timeAgo = getTimeAgo(w.created_at);
    return `<div class="tq-whisper-card" onclick="this.classList.toggle('expanded')">
      <div class="tq-whisper-mood">${w.mood || '🌓'}</div>
      <div class="tq-whisper-text">${escapeHtml(w.text)}</div>
      <div class="tq-whisper-time">${timeAgo}</div>
    </div>`;
  }).join('');

  return `<div class="tq-whispers">
    <div class="tq-whispers-header">
      <div class="tq-whispers-lbl">Anonymous fragments</div>
    </div>
    <div class="tq-whisper-list">${cards}</div>
  </div>`;
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  var diff = Date.now() - new Date(dateStr + 'Z').getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

async function sealTonightsEntry() {
  var area = document.getElementById('tq-draft');
  var text = area ? area.value.trim() : '';
  if (!text) { toast('A few words are enough before sealing.'); return; }
  if (!tqMood) { toast('Pick a mood before sealing — even a rough one.'); return; }

  try {
    var piiConfirmed = false;
    if (detectClientPii(text)) {
      piiConfirmed = confirm('This may reveal who you are. Please remove personal details to keep this space anonymous. Continue only if you understand the risk.');
      if (!piiConfirmed) return;
    }
    var result = await api('POST', '/tonights-question', { text: text, mood: tqMood, piiConfirmed: piiConfirmed });
    tqMood = null;
    sessionStorage.removeItem('mp-tq-draft');

    if (result.safety && result.safety.crisis) showSafety();
    if (result.safety && result.safety.pii) {
      toast('Tip: Avoid sharing personal contact info — anonymity keeps you safe 🔒');
    }

    // Reload and show sealed state
    await loadTonightsQuestion();
    renderTQSealed(tqData);
    maybeShowNotificationNudge('after_reflection');
    toast('Entry sealed ✦');
  } catch (e) { toast(e.message); }
}

function renderTQSealed(data) {
  if (!state || !state.user) return;
  var d = data || {};
  var myEntry = d.myEntry || {};
  var whispers = d.whispers || [];
  var nightsWritten = d.nightsWritten || 0;
  var writerCount = d.writerCount || 0;
  var arch = archetypes[state.user.archetype];

  document.getElementById('s-waiting').innerHTML = `
    <div class="tq-body">
      <div class="nav"><div class="nav-logo"><div class="site-nav-orb" style="width:20px;height:20px;"></div>mentally prepare</div><div class="day-pill">Night ${nightsWritten}</div></div>
      <div class="tq-sealed-hero">
        <div class="tq-moon-wrap">
          <div class="tq-moon-ring"></div>
          <div class="tq-moon-ring tq-moon-ring2"></div>
          <div class="tq-moon"></div>
        </div>
        <div class="tq-sealed-badge">Entry sealed ✦</div>
        <h2 class="tq-sealed-h">You showed up today.<br/><em>That matters.</em></h2>
        <div class="tq-sealed-p">Nothing has to be solved right now. Come back tomorrow for the next small step.</div>
      </div>

      ${writerCount > 0 ? `<div class="tq-counter"><div class="tq-counter-dot"></div><div class="tq-counter-text"><span class="tq-counter-num">${writerCount}</span> ${writerCount === 1 ? 'person' : 'people'} wrote tonight</div></div>` : ''}

      <div class="tq-sealed-entry-card">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-s);">Your entry · ${myEntry.mood || '🌓'}</div><div style="font-size:9px;color:var(--rose-l);">✦ sealed</div></div>
        <div style="font-family:'Lora',serif;font-style:italic;font-size:13.5px;color:var(--ink-m);line-height:1.8;">${escapeHtml(myEntry.text || '')}</div>
      </div>

      <div class="tq-waiting-info">
        <div class="tq-waiting-ico">🔍</div>
        <div class="tq-waiting-text">Still looking for your <strong>${arch ? arch.matchName : 'partner'}</strong>. You'll be notified when your match arrives.</div>
      </div>

      ${whispers.length > 0 ? renderWhispers(whispers) : `<div class="tq-whispers"><div class="tq-whispers-header"><div class="tq-whispers-lbl">Anonymous fragments</div></div><div class="tq-whisper-empty">No one has left a line here yet.<br/>Yours can be the first quiet mark.</div></div>`}

      <div style="height:20px;"></div>
      ${renderTQTabs('tonight')}
    </div>`;
  afterRenderMotion(document.getElementById('s-waiting'));

  // Continue polling for match
  clearInterval(matchPollTimer);
  matchPollTimer = setInterval(async function() {
    var ok = await loadState();
    if (ok && state.match) {
      clearInterval(matchPollTimer);
      spawnParticles();
      toast('Match found! 🌙');
      setTimeout(function() { renderJournal(); go('s-journal'); }, 600);
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
  const matchArch = state.match.partner ? archetypes[state.match.partner.archetype] : null;
  const prompt = state.match.currentPrompt;
  const draft = sessionStorage.getItem('mp-draft') || '';
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today = new Date();

  // Reveal countdown + partner archetype, surfaced at top of Today
  const nightsLeft = 21 - day;
  const revealHeaderHTML = `
    <div class="reveal-strip">
      ${matchArch ? `<div class="reveal-partner">Your partner: <span>${matchArch.emoji} ${escapeHtml(matchArch.name)}</span></div>` : ''}
      <div class="reveal-count">${nightsLeft > 0 ? `${nightsLeft} night${nightsLeft === 1 ? '' : 's'} until the reveal.` : 'Tonight is the reveal.'}</div>
    </div>`;

  // Special day banner
  let specialDayHTML = '';
  if (state.specialDay) {
    const sd = state.specialDay;
    specialDayHTML = `<div class="special-day-banner ${sd.type} reveal-on-scroll">
      <div class="special-day-badge">${sd.badge} ${sd.title}</div>
      <div class="special-day-title">${sd.type === 'unsent_letter' ? 'Write a small note to your stranger.' : sd.type === 'weekly_ritual' ? (day === 7 ? 'One small truth is enough.' : 'Notice where you started.') : 'The final night.'}</div>
      <div class="special-day-sub">${sd.type === 'unsent_letter' ? 'This note can stay simple.' : sd.type === 'final_night' ? 'Take this one step at a time.' : 'A simple milestone prompt.'}</div>
    </div>`;
  }

  // Nudge banners
  let nudgesHTML = '';
  if (state.nudges && state.nudges.length > 0) {
    nudgesHTML = state.nudges.map(n => `<div class="nudge-banner" data-nudge-id="${n.id}">
      <div class="nudge-ico">💜</div>
      <div class="nudge-text">${escapeHtml(n.message)}</div>
      <button class="nudge-dismiss" type="button" data-dismiss="${n.id}">×</button>
    </div>`).join('');
  }

  // Connection score
  const connScoreHTML = state.connectionScore > 0 ? renderConnectionScore(state.connectionScore) : '';

  // Check if partner hasn't written for 3+ days
  let partnerInactiveCard = '';
  if (state.partnerEntries && state.partnerEntries.length > 0) {
    const lastPartnerDay = Math.max(...state.partnerEntries.map(e => e.day));
    if (day - lastPartnerDay >= 3) {
      partnerInactiveCard = `
        <div class="info-card" style="background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:18px auto 0 auto;max-width:520px;color:var(--ink-s);font-family:'Lora',serif;font-size:15px;text-align:center;">
          <div style="font-size:16px;font-family:'Playfair Display',serif;color:var(--ink-m);margin-bottom:6px;">Your partner hasn't written in a few days.</div>
          <div>This happens sometimes. Keep your note simple today.</div>
        </div>
      `;
    }
  }
  document.getElementById('s-journal').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div style="padding:16px 24px 0;"><div class="greeting">${getGreeting(state.user.name)}</div></div>
    ${revealHeaderHTML}
    ${specialDayHTML}
    ${nudgesHTML}
    ${partnerInactiveCard}
    ${connScoreHTML}
    <div id="partner-status-module"></div>
    <div class="streak reveal-on-scroll" id="streak-constellation">
      <div class="streak-top"><div class="streak-lbl">Your constellation</div><div class="streak-ct">🔥 ${state.streak} days</div></div>
      <div id="constellation-container">${renderConstellation(state.match, state.entries, state.partnerEntries, day)}</div>
    </div>
    <div id="daily-note-container"></div>
    ${renderPromptChooser()}
    <div class="moon-block reveal-on-scroll"><div class="moon-base moon-sm"></div><div class="cd" id="cd">—</div><div class="cd-sub">until midnight IST</div></div>
    <div class="prompt-block reveal-on-scroll">
      <div class="eyebrow">${state.specialDay ? '✦ ' + state.specialDay.title : 'Tonight\'s small step'}</div>
      <div class="prompt-text">${escapeHtml(prompt)}</div>
      ${state.specialDay && state.specialDay.type === 'unsent_letter' ? '<div class="dare">💌 This letter seals until Day 21</div>' : day % 7 === 0 ? '<div class="dare">⚡ Weekly dare</div>' : ''}
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
        <textarea id="journal-draft" placeholder="${state.specialDay && state.specialDay.type === 'unsent_letter' ? 'Dear stranger, one thing I can say is...' : 'Write one small thing tonight...'}">${escapeHtml(draft)}</textarea>
        <div class="write-ft"><div class="ww" id="ww">${wordCount(draft)} words</div><div id="word-milestone"></div></div>
      </div>
    </div>

    ${state.streak >= 3 ? `<div class="streak-nudge reveal-on-scroll"><div class="streak-nudge-inner"><span style="font-size:16px;">🔥</span><div class="streak-nudge-text">${getStreakNudge(state.streak)}</div></div></div>` : ''}
    <div class="cta-block">
      <button class="btn" id="sealEntryBtn" type="button">Seal tonight's note</button>
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
  const sealEntryBtn = document.getElementById('sealEntryBtn');
  if (sealEntryBtn) sealEntryBtn.addEventListener('click', sealEntry);
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  if (saveDraftBtn) saveDraftBtn.addEventListener('click', saveDraft);
  bindPromptChooser();
  renderPartnerStatusModule('partner-status-module');
  // Nudge dismiss handlers
  document.querySelectorAll('[data-dismiss]').forEach(btn => {
    btn.addEventListener('click', async function() {
      const id = parseInt(btn.dataset.dismiss);
      try { await api('POST', '/nudge/dismiss', { nudgeId: id }); btn.closest('.nudge-banner').remove(); } catch(e) {}
    });
  });
  startCountdown();
  initScrollReveal('#s-journal');
  // Load and render the daily note card asynchronously
  loadDailyNote().then(function(noteData) {
    var noteContainer = document.getElementById('daily-note-container');
    if (noteContainer && noteData) renderDailyNoteCard(noteContainer, noteData);
  });
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
      { at: 10, ico: '✨', text: '10 words — that counts' },
      { at: 25, ico: '📝', text: '25 words — you kept it simple' },
      { at: 50, ico: '💎', text: '50 words — enough for tonight' },
      { at: 100, ico: '🔥', text: '100 words — stop whenever you feel done' }
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

function clientPiiFlags(text) {
  const value = String(text || '');
  const flags = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) flags.push('email');
  if (/(?:\+91[- ]?)?(?:[6-9][0-9]{9})/.test(value)) flags.push('phone_or_whatsapp');
  if (/\b(?:instagram|telegram|whatsapp|snapchat|linkedin|t\.me|wa\.me|https?:\/\/|www\.|@[a-z0-9_.]{3,})/i.test(value)) flags.push('social_or_link');
  if (/\b(?:hostel|room|flat|block|sector|department|batch)\b/i.test(value)) flags.push('location_or_batch');
  return flags;
}

function detectClientPii(text) {
  if (typeof clientPiiFlags === 'function') return clientPiiFlags(text).length > 0;
  const value = String(text || '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /(?:\+91[- ]?)?(?:[6-9][0-9]{9})/.test(value)
    || /\b(?:instagram|telegram|whatsapp|snapchat|linkedin|t\.me|wa\.me|https?:\/\/|www\.|@[a-z0-9_.]{3,})/i.test(value)
    || /\b(?:hostel|room|flat|block|sector|department|batch)\b/i.test(value);
}

function saveDraft() {
  const area = document.getElementById('journal-draft');
  if (area) sessionStorage.setItem('mp-draft', area.value);
  toast('Draft saved ✓');
}

async function sealEntry() {
  const area = document.getElementById('journal-draft');
  const text = area ? area.value.trim() : '';
  if (!text) { toast('A few words are enough before sealing.'); return; }
  if (!currentMood) { toast('Pick a mood before sealing — even a rough one.'); return; }
  let piiConfirmed = false;
  if (detectClientPii(text)) {
    piiConfirmed = confirm('This may reveal who you are. Please remove personal details to keep this space anonymous. Continue only if you understand the risk.');
    if (!piiConfirmed) return;
  }

  try {
    const result = await api('POST', '/entry', { text, mood: currentMood, selectedPrompt: selectedPrompt || null, piiConfirmed });
    sessionStorage.removeItem('mp-draft');
    currentMood = null;
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
    maybeShowNotificationNudge('after_reflection');
  } catch (e) {
    if (e.message && e.message.includes('reveal who you are')) {
      toast('Please remove personal details before saving.');
    } else {
      toast(e.message);
    }
  }
}

function startCountdown() {
  clearInterval(countdownTimer);
  function tick() {
    const now = new Date();
    const nextFromState = state && state.partnerStatus && state.partnerStatus.nextUnsealAt
      ? new Date(state.partnerStatus.nextUnsealAt)
      : null;
    const target = nextFromState && !isNaN(nextFromState.getTime())
      ? nextFromState
      : new Date((Math.floor((now.getTime() + 19800000) / 86400000) + 1) * 86400000 - 19800000);
    const d = Math.max(0, target - now);
    const h = String(Math.floor(d/3600000)).padStart(2,'0');
    const m = String(Math.floor((d%3600000)/60000)).padStart(2,'0');
    const s = String(Math.floor((d%60000)/1000)).padStart(2,'0');
    const el = document.getElementById('cd');
    if (el) el.textContent = `${h} : ${m} : ${s}`;
  }
  tick(); countdownTimer = setInterval(tick, 1000);
}

function formatUnsealAt(value) {
  if (!value) return 'midnight IST';
  const date = new Date(value);
  if (isNaN(date.getTime())) return 'midnight IST';
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' }) + ' IST';
}

function renderSealed() {
  if (!state || !state.match) return;
  const day = state.match.day;
  const matchArch = archetypes[state.match.partner.archetype];
  const lastEntry = state.entries.length ? state.entries[0] : null;
  const ps = state.partnerStatus || {};
  const sealedCopy = ps.hasPartner
    ? (ps.unsealMessage || 'Nothing has to be solved right now.')
    : 'You showed up today. That matters.';
  const partnerLine = ps.hasPartner
    ? (ps.partnerHasWrittenToday ? "They wrote tonight." : "They haven't written yet. You can write first, they'll get it at midnight.")
    : 'Waiting for match';
  const nextLine = ps.nextUnsealAt ? ("Their next note unseals at " + formatUnsealAt(ps.nextUnsealAt)) : "Come back tomorrow for the next small step";

  document.getElementById('s-sealed').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div class="sealed-hero">
      <div class="moon-base sealed-moon"></div>
      <div class="sealed-ey">Entry sealed ✦</div>
      <h2 class="sealed-h">You showed up today.<br/><em>That matters.</em></h2>
      <p class="sealed-p">${escapeHtml(sealedCopy)} Nothing has to be solved right now. Come back tomorrow for the next small step.</p>
    </div>
    ${lastEntry ? `<div class="sealed-card">
      <div class="sealed-card-top"><div class="sealed-card-lbl">Your entry · Day ${lastEntry.day} · ${lastEntry.mood}</div><div class="sealed-card-badge">🔒 sealed</div></div>
      <div class="sealed-txt">${escapeHtml(lastEntry.text)}</div>
      <div class="unseals">Partner notes open after midnight IST</div>
    </div>` : ''}
    <div class="partner-card">
      <div class="p-moon">${matchArch.emoji}</div>
      <div><div class="p-ey">Your anonymous partner</div><div class="p-name">${matchArch.name}</div><div class="p-status" id="partner-status-text">${escapeHtml(partnerLine)} · ${escapeHtml(nextLine)}</div></div>
    </div>
    <div id="partner-status-module"></div>
    <div id="switch-banner-area"></div>
    <div style="height:40px;"></div>
    ${renderTabs('partner')}`;

  renderPartnerStatusModule('partner-status-module', true);

  // Check partner activity and build unsealing slot for previous day's partner entry
  checkPartnerStatus().then(ps => {
    const statusEl = document.getElementById('partner-status-text');
    const bannerEl = document.getElementById('switch-banner-area');
    if (!ps || !ps.hasPartner) return;

    if (ps.status === 'active') {
      if (statusEl) statusEl.innerHTML = 'Writing now… ' + typingDots();
    } else if (ps.status === 'recent') {
      if (statusEl) statusEl.textContent = 'Last active recently';
    } else if (ps.status === 'quiet') {
      if (statusEl) statusEl.textContent = 'Taking a break';
      if (bannerEl) bannerEl.innerHTML = `<div class="switch-banner"><div class="switch-banner-ico">💤</div><div class="switch-banner-text">Your partner hasn't written in ${ps.daysSinceActive} days. They might be taking a break.</div></div>`;
    } else if (ps.status === 'dormant') {
      if (statusEl) statusEl.textContent = `Quiet for ${ps.daysSinceActive} days`;
      if (bannerEl) bannerEl.innerHTML = `<div class="switch-banner"><div class="switch-banner-ico">⚡</div><div class="switch-banner-text">Your partner has been quiet for a while. You can keep waiting, or quietly look for someone new.</div><button class="switch-banner-btn" onclick="openSwitchPartnerModal()">Find a new match</button></div>`;
    }
  });

  // If there's a partner entry from yesterday, show the unsealing ceremony
  if (state && state.partnerEntries && state.partnerEntries.length) {
    const currentDay = state.match ? state.match.day : 1;
    const prevDayEntry = state.partnerEntries.find(function(e) { return e.day === currentDay - 1; });
    if (prevDayEntry) {
      buildUnsealingSlot(prevDayEntry, currentDay - 1, state.match.partner.archetype);
    }
  }
}

function formatEntryDate(dateStr) {
  if (!dateStr) return 'Written quietly';
  const parsed = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  if (isNaN(parsed.getTime())) return 'Written quietly';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderEntryTimeline(writtenDays, currentDay) {
  const dots = Array.from({ length: 21 }, function(_, idx) {
    const d = idx + 1;
    const classes = ['archive-day-dot'];
    if (writtenDays.has(d)) classes.push('written');
    if (d === currentDay) classes.push('current');
    if (d > currentDay) classes.push('future');
    return `<span class="${classes.join(' ')}" title="Day ${d}"><span>${d}</span></span>`;
  }).join('');

  return `
    <div class="archive-timeline">
      <div class="archive-timeline-top"><span>21-day constellation</span><span>${writtenDays.size}/21 written</span></div>
      <div class="archive-day-line">${dots}</div>
    </div>`;
}

function renderArchiveEntryCard(entry, idx, meta) {
  const prompt = entry.prompt ? escapeHtml(entry.prompt.replace(/^"|"$/g, '')) : 'Free-written note';
  const mood = entry.mood || '·';
  const date = formatEntryDate(entry.created_at);
  const words = (entry.text || '').trim().split(/\s+/).filter(Boolean).length;
  return `
    <button class="archive-entry-card reveal-on-scroll" type="button" onclick="showEntryDetail(${idx})">
      <span class="archive-entry-glow"></span>
      <div class="archive-entry-top">
        <div>
          <div class="archive-entry-kicker">Sealed note</div>
          <div class="archive-entry-day">Day ${entry.day}</div>
        </div>
        <div class="archive-entry-meta">
          <span>${escapeHtml(mood)}</span>
          <span>${escapeHtml(date)}</span>
        </div>
      </div>
      <div class="archive-entry-prompt">${prompt}</div>
      <div class="archive-entry-text">${escapeHtml(entry.text)}</div>
      <div class="archive-entry-foot">
        <span>${words} word${words === 1 ? '' : 's'}</span>
        ${meta.bothWrote ? '<span>Both wrote</span>' : '<span>Private archive</span>'}
        <strong>Read quietly</strong>
      </div>
      ${meta.latest ? '<div class="archive-entry-tag">Most recent entry</div>' : ''}
    </button>`;
}

function renderPast() {
  if (!state || !state.match) return;
  const day = state.match.day;
  const partnerMap = {};
  (state.partnerEntries || []).forEach(e => { partnerMap[e.day] = true; });
  const entries = state.entries || [];
  const writtenDays = new Set(entries.map(e => e.day));
  const writtenCount = entries.length;
  const latestDay = entries.length ? entries[0].day : null;

  document.getElementById('s-past').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day ${day} of 21</div></div>
    <div class="archive-shell">
      <div class="archive-orbit archive-orbit-one"></div>
      <div class="archive-orbit archive-orbit-two"></div>
      <div class="archive-star archive-star-a">✦</div>
      <div class="archive-star archive-star-b">✧</div>
      <div class="archive-header">
        <div class="archive-status">
          <span>Your private archive</span>
          <span>${writtenCount} note${writtenCount === 1 ? '' : 's'} sealed so far</span>
          <span>Day ${day} of 21</span>
        </div>
        <div class="archive-eyebrow">Your entries</div>
        <h1 class="archive-title"><span>${writtenCount || 'No'} night${writtenCount === 1 ? '' : 's'}.</span><em>${writtenCount || 'No'} honest thing${writtenCount === 1 ? '' : 's'}.</em></h1>
        <p class="archive-sub">Every note you seal becomes part of your 21-day constellation.</p>
      </div>
      ${renderEntryTimeline(writtenDays, day)}
      ${entries.length ? `
        <div class="archive-list">
          ${entries.map((e,i) => renderArchiveEntryCard(e, i, { latest: e.day === latestDay, bothWrote: !!partnerMap[e.day] })).join('')}
        </div>
        <div class="archive-export-wrap">
          <button class="archive-export" onclick="exportEntries()">
            <span class="archive-export-icon">▣</span>
            <span><strong>Export my archive</strong><small>Download your entries as text.</small></span>
          </button>
        </div>
      ` : `
        <div class="archive-empty">
          <div class="archive-empty-moon"></div>
          <h2>Nothing sealed yet.</h2>
          <p>Tonight can be your first honest line.</p>
          <button class="archive-empty-btn" onclick="goToJournal()">Write tonight's note</button>
        </div>
      `}
    </div>
    <div style="height:18px;"></div>
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
  const archKey = state.user.archetype;
  if (!arch) return;
  const s = state.user.scores || { openness: 50, awareness: 50, guard: 50, reciprocity: 50 };
  const day = state.match ? state.match.day : 0;
  const matchArch = state.match ? archetypes[state.match.partner.archetype] : null;

  document.getElementById('s-profile').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div style="width:36px;height:36px;border-radius:50%;background:rgba(248,242,255,.04);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;" onclick="renderSettings();go('s-settings')">⚙️</div></div>
    <div class="hero-profile" style="padding-bottom:0;">
      <div class="profile-planet-card ${archKey}">
        ${renderConstellationCorners()}
        ${renderCosmicOrb(archKey)}
        <div class="p-user-name">${escapeHtml(state.user.name)}</div>
        <div class="p-college-text" style="margin-bottom:12px;">${escapeHtml(state.user.college)} · ${escapeHtml(state.user.year)} year</div>
        <div style="font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--rose);opacity:.7;margin-bottom:6px;">Your archetype</div>
        <div style="font-family:'Playfair Display',serif;font-size:20px;font-style:italic;color:var(--ink);margin-bottom:6px;">${arch.name}</div>
        <div style="font-family:'Lora',serif;font-style:italic;font-size:12.5px;color:var(--ink-m);line-height:1.7;">${arch.quote}</div>
        <button class="share-btn" onclick="shareArchetype()" style="margin-top:12px;">📋 Share result</button>
      </div>
    </div>
    <div class="traits">
      <div class="sec-ey">ECP-11 Profile</div>
      ${['Openness','Awareness','Guard','Reciprocity'].map((name,i) => {
        const val = [s.openness, s.awareness, s.guard, s.reciprocity][i];
        return `<div class="trait" style="margin-bottom:13px;"><div class="trait-top"><span class="trait-name">${name}</span><span class="trait-pct" style="font-size:12px;color:var(--rose-l);font-family:'Playfair Display',serif;">${val}%</span></div><div class="trait-track"><div class="trait-fill-p" style="width:${val}%"></div></div></div>`;
      }).join('')}
    </div>
    ${state.connectionScore > 0 ? renderConnectionScore(state.connectionScore) : ''}
    <div class="prof-arch-detail reveal-on-scroll" style="padding:16px 24px 0;">
      <div style="background:linear-gradient(135deg,rgba(123,94,167,.06),rgba(212,133,154,.04));border:1px solid rgba(123,94,167,.12);border-radius:16px;padding:16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(123,94,167,.25),transparent);"></div>
        <div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--purple-l);margin-bottom:8px;display:flex;align-items:center;gap:6px;">🔭 About your archetype</div>
        <div style="font-family:'Lora',serif;font-style:italic;font-size:12px;color:var(--ink-m);line-height:1.75;margin-bottom:12px;">${arch.description}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:rgba(126,200,160,.05);border:1px solid rgba(126,200,160,.1);border-radius:12px;padding:10px 12px;">
            <div style="font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);margin-bottom:6px;">🌿 Strengths</div>
            ${arch.strengths.map(s => `<div style="font-size:10.5px;color:var(--ink-m);line-height:1.55;padding:2px 0;display:flex;align-items:flex-start;gap:5px;"><span style="color:var(--green);font-size:6px;margin-top:4px;flex-shrink:0;">●</span>${escapeHtml(s)}</div>`).join('')}
          </div>
          <div style="background:rgba(212,133,154,.05);border:1px solid rgba(212,133,154,.1);border-radius:12px;padding:10px 12px;">
            <div style="font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:var(--rose);margin-bottom:6px;">🌱 Growth</div>
            ${arch.growth.map(g => `<div style="font-size:10.5px;color:var(--ink-m);line-height:1.55;padding:2px 0;display:flex;align-items:flex-start;gap:5px;"><span style="color:var(--rose);font-size:6px;margin-top:4px;flex-shrink:0;">●</span>${escapeHtml(g)}</div>`).join('')}
          </div>
        </div>
      </div>
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
    ${!state.match ? `<div class="reveal-on-scroll" style="padding:14px 24px 0;">
      <div style="background:linear-gradient(135deg,rgba(201,169,110,.05),rgba(212,133,154,.04));border:1px solid rgba(201,169,110,.12);border-radius:16px;padding:18px 16px;text-align:center;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(201,169,110,.25),transparent);"></div>
        <div style="font-size:22px;margin-bottom:8px;">🌙</div>
        <div style="font-family:'Playfair Display',serif;font-size:15px;font-style:italic;color:var(--ink);margin-bottom:5px;">Begin the 21-day experiment</div>
        <div style="font-family:'Lora',serif;font-style:italic;font-size:11.5px;color:var(--ink-m);line-height:1.65;max-width:260px;margin:0 auto 12px;">Write while we look for someone who can meet your words carefully.</div>
        <button onclick="goToJournal()" style="background:linear-gradient(135deg,var(--rose-d),var(--purple));color:var(--ink);padding:10px 24px;border-radius:50px;font-size:12px;font-weight:500;letter-spacing:.5px;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .3s;">Write tonight's note →</button>
      </div>
    </div>` : ''}
    <div class="reveal-on-scroll" style="padding:14px 24px 0;">
      <button onclick="showSilentRoom()" style="width:100%;background:rgba(123,94,167,.05);border:1px solid rgba(123,94,167,.12);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:all .3s;text-align:left;color:inherit;font:inherit;" onmouseover="this.style.borderColor='rgba(123,94,167,.3)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='rgba(123,94,167,.12)';this.style.transform='none'">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,rgba(123,94,167,.15),rgba(123,94,167,.06));border:1px solid rgba(123,94,167,.18);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">✦</div>
        <div style="flex:1;">
          <div style="font-family:'Playfair Display',serif;font-size:13.5px;font-style:italic;color:var(--ink);margin-bottom:2px;">The Silent Room</div>
          <div style="font-size:10px;color:var(--ink-s);line-height:1.4;">One line. No replies. Just witnessed.</div>
        </div>
        <div style="font-size:14px;color:var(--purple-l);">›</div>
      </button>
    </div>
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

function renderNotificationSettingsHtml() {
  const prefs = getPushPreferences();
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const enabled = prefs.enabled && permission === 'granted';
  const status = permission === 'unsupported' ? 'Unsupported' : (enabled ? 'On' : 'Off');
  const disabled = prefs.enabled ? '' : ' disabled';
  const prefRow = (key, label) => `
    <label class="push-pref-row">
      <span>${label}</span>
      <input type="checkbox" ${prefs[key] ? 'checked' : ''}${disabled} onchange="toggleNotificationPreference('${key}', this.checked)"/>
    </label>`;
  return `
    <div class="push-settings-card">
      <div class="push-settings-top">
        <div>
          <div class="push-settings-kicker">Notifications</div>
          <div class="push-settings-title">Gentle daily reminders</div>
        </div>
        <span class="push-settings-status">${status}</span>
      </div>
      <div class="push-settings-copy">Private lock screen copy only. You can change this anytime.</div>
      <div class="push-pref-list">
        ${prefRow('morningReminder', 'Morning reminder')}
        ${prefRow('eveningReminder', 'Evening reminder')}
        ${prefRow('dailyReflection', 'Daily reflection reminder')}
        ${prefRow('streakReminder', 'Nightly nudge')}
        ${prefRow('silentRoomReminder', 'Silent Room reminder')}
        <label class="push-pref-row push-pref-off">
          <span>Turn off notifications</span>
          <input type="checkbox" ${prefs.enabled ? '' : 'checked'} onchange="toggleNotificationsOff(this.checked)"/>
        </label>
      </div>
      <div class="push-settings-actions">
        <button class="btn-ghost" type="button" onclick="toggleNotifications()">Enable on this device</button>
        ${state && state.user && state.user.pushSubscribed ? '<button class="btn-ghost danger-soft" type="button" onclick="unsubscribeFromPush()">Unsubscribe</button>' : ''}
      </div>
    </div>`;
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
    ${renderNotificationSettingsHtml()}
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Partner</div>
    </div>
    <div class="settings-list">
      ${state && state.match ? `<button class="si" id="si-switch" type="button" onclick="switchPartner()"><div class="si-ico">&#128260;</div><div class="si-lbl">Switch partner (if inactive 5+ days)</div><div class="si-arrow">&#8250;</div></button>` : ''}
      ${state && state.match ? `<button class="si" type="button" onclick="requestRematch()"><div class="si-ico">&#8635;</div><div class="si-lbl">Request rematch</div><div class="si-arrow">&#8250;</div></button>` : ''}
      ${state && state.match ? `<button class="si" type="button" onclick="blockPartner()"><div class="si-ico">&#9940;</div><div class="si-lbl">Block partner / I feel unsafe</div><div class="si-arrow">&#8250;</div></button>` : ''}
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
      <button class="si" type="button" onclick="renderEditProfile()"><div class="si-ico">&#128100;</div><div class="si-lbl">Edit profile</div><div class="si-arrow">&#8250;</div></button>
      <button class="si" type="button" onclick="logout()"><div class="si-ico">&#128682;</div><div class="si-lbl">Log out</div><div class="si-arrow">&#8250;</div></button>
      <button class="si" type="button" style="border-color:rgba(212,133,154,.15);" onclick="deleteAccount()"><div class="si-ico">&#128465;&#65039;</div><div class="si-lbl" style="color:rgba(212,133,154,.7);">Delete my account</div><div class="si-arrow">&#8250;</div></button>
    </div>
    </div>
    ${window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? `
    <div style="padding:20px 24px 0;">
      <div style="font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-s);margin-bottom:12px;">Developer Tools</div>
    </div>
    <div class="settings-list">
      ${state && state.match ? `<button class="si" type="button" onclick="devAdvance()"><div class="si-ico">&#9193;</div><div class="si-lbl">Jump to Day 21</div><div class="si-arrow">&#8250;</div></button>` : ''}
      ${state && state.match ? `<button class="si" type="button" onclick="devPartnerReveal()"><div class="si-ico">&#129309;</div><div class="si-lbl">Partner says "yes" to reveal</div><div class="si-arrow">&#8250;</div></button>` : ''}
    </div>` : ''}
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
  if (state && state.partnerStatus) return state.partnerStatus;
  try {
    return await api('GET', '/partner-status');
  } catch { return null; }
}

function partnerStatusHtml(ps, compact) {
  if (!ps) {
    return `<div class="partner-status-panel"><div class="partner-status-title">Checking your anonymous room...</div><p class="partner-status-copy">Opening your room gently.</p></div>`;
  }
  const title = ps.friendlyTitle || (ps.hasPartner ? 'Your anonymous partner is here.' : 'We are still looking for the right anonymous match.');
  const copy = ps.friendlyMessage || ps.unsealMessage || 'You can keep writing while the room settles.';
  const visibleCount = ps.partnerEntriesVisible || 0;
  const totalCount = ps.partnerTotalEntries || ps.partnerEntryCount || 0;
  const meta = ps.hasPartner ? (totalCount === 0 ? 'Your first notes open after midnight' : `${visibleCount} of ${totalCount} note${totalCount === 1 ? '' : 's'} unsealed`) : 'waiting room';
  const activity = ps.activityLabel ? `<span>${escapeHtml(ps.activityLabel)}</span>` : '';
  const wroteToday = ps.hasPartner ? `<span>${ps.partnerHasWrittenToday ? 'They wrote tonight.' : "They haven't written yet. You can write first, they'll get it at midnight."}</span>` : '';
  const nextOpen = ps.nextUnsealAt ? `<span>Their next note unseals at ${escapeHtml(formatUnsealAt(ps.nextUnsealAt))}</span>` : '<span>Unseals after midnight IST</span>';
  const reminderAction = ps.canRemindPartner ? '<button class="prompt-small-btn ghost" type="button" data-send-reminder>Send gentle reminder</button>' : '';
  const rescueActions = Array.isArray(ps.rescueActions) && ps.rescueActions.length ? `
    <div class="partner-rescue-actions" aria-label="Partner rescue options">
      <button class="prompt-small-btn ghost" type="button" data-continue-solo>Continue solo</button>
      ${ps.canSwitch ? '<button class="prompt-small-btn" type="button" data-open-switch>Find new partner</button>' : '<button class="prompt-small-btn ghost" type="button" disabled>Find new partner</button>'}
      <button class="prompt-small-btn ghost" type="button" data-keep-waiting>Wait for partner</button>
    </div>` : '';
  const switchActions = ps.canSwitch && !rescueActions ? `
    <div class="partner-status-actions">
      <button class="prompt-small-btn ghost" type="button" data-keep-waiting>Keep waiting</button>
      <button class="prompt-small-btn" type="button" data-open-switch>Find a new match</button>
    </div>` : '';
  return `<div class="partner-status-panel ${compact ? 'compact' : ''}">
    <div class="partner-status-kicker">Your anonymous partner</div>
    <div class="partner-status-title">${escapeHtml(title)}</div>
    <p class="partner-status-copy">${escapeHtml(copy)}</p>
    <div class="partner-status-meta">
      <span>${escapeHtml(meta)}</span>
      ${activity}
      ${wroteToday}
      ${nextOpen}
      <span title="You can quietly switch to a new anonymous partner without them knowing.">${ps.switchesRemaining || 0} quiet rematch${ps.switchesRemaining === 1 ? "" : "es"} left</span>
    </div>
    ${ps.canRemindPartner ? '<p class="partner-status-copy">Your reflection partner may appreciate a reminder.</p>' : ''}
    ${reminderAction}
    ${rescueActions}
    ${switchActions}
  </div>`;
}

async function renderPartnerStatusModule(id, compact) {
  const mount = document.getElementById(id);
  if (!mount) return;
  mount.innerHTML = partnerStatusHtml(null, compact);
  const ps = await checkPartnerStatus();
  if (!document.getElementById(id)) return;
  mount.innerHTML = partnerStatusHtml(ps, compact);
  const switchBtn = mount.querySelector('[data-open-switch]');
  if (switchBtn) switchBtn.addEventListener('click', openSwitchPartnerModal);
  const waitBtn = mount.querySelector('[data-keep-waiting]');
  if (waitBtn) waitBtn.addEventListener('click', function() { toast('You are not stuck. We will keep the room open.'); });
  const reminderBtn = mount.querySelector('[data-send-reminder]');
  if (reminderBtn) reminderBtn.addEventListener('click', sendPartnerReminder);
  const soloBtn = mount.querySelector('[data-continue-solo]');
  if (soloBtn) soloBtn.addEventListener('click', continueSolo);
}

function openSwitchPartnerModal() {
  const existing = document.getElementById('switchPartnerModal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'mp-modal-overlay';
  overlay.id = 'switchPartnerModal';
  overlay.innerHTML = `
    <div class="mp-modal-card">
      <div class="mp-modal-kicker">Quiet rematch</div>
      <h3 class="mp-modal-title">Find someone new?</h3>
      <p class="mp-modal-copy">Your partner has been quiet for a while. You can keep waiting, or we can quietly look for a new anonymous match for you. Your previous exchange will stay private.</p>
      <div class="mp-modal-actions">
        <button class="prompt-small-btn ghost" type="button" id="switchSoloBtn">Continue solo</button>
        <button class="prompt-small-btn ghost" type="button" id="switchCancelBtn">Keep waiting</button>
        <button class="prompt-small-btn" type="button" id="switchConfirmBtn">Find new match</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.getElementById('switchCancelBtn').addEventListener('click', function() { overlay.remove(); });
  document.getElementById('switchConfirmBtn').addEventListener('click', switchPartner);
  document.getElementById('switchSoloBtn').addEventListener('click', continueSolo);
}

async function sendPartnerReminder() {
  try {
    const result = await api('POST', '/partner-reminder', {});
    toast(result.message || 'Gentle reminder sent.');
    await loadState();
    renderPartnerStatusModule('partner-status-module');
  } catch (e) { toast(e.message || 'Reminder did not send.'); }
}

async function continueSolo() {
  try {
    const result = await api('POST', '/continue-solo', {});
    const modal = document.getElementById('switchPartnerModal');
    if (modal) modal.remove();
    toast(result.message || 'You can keep writing privately.');
  } catch (e) { toast(e.message || 'Could not save that choice.'); }
}

async function switchPartner() {
  const modal = document.getElementById('switchPartnerModal');
  const confirmBtn = document.getElementById('switchConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Looking...';
  }
  toast('Looking for someone on a similar emotional frequency...', 3200);
  try {
    const result = await api('POST', '/switch-partner');
    await loadState();
    if (modal) modal.remove();
    if (result.matched) {
      toast(result.message || 'You have a new anonymous match. Start gently tonight.', 3200);
      renderJournal(); go('s-journal');
    } else {
      toast(result.message || 'We are still looking for the right anonymous match. You can write tonight while we search.', 3600);
      renderWaiting(); go('s-waiting');
    }
  } catch (e) {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Find new match';
    }
    toast(e.message || 'Something did not save. Try once more.');
  }
}

// ═══════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════
async function requestRematch() {
  const reason = prompt('Why do you want a rematch? You can keep this short.');
  if (reason === null) return;
  try {
    const result = await api('POST', '/rematch-request', { reason: reason || 'requested_by_user' });
    toast(result.message || 'Rematch request saved.');
  } catch (e) { toast(e.message); }
}

async function blockPartner() {
  const reason = prompt('Tell us what felt unsafe. Your identity will stay anonymous.');
  if (reason === null) return;
  if (!confirm('Block this partner and close the match?')) return;
  try {
    const result = await api('POST', '/block-partner', { reason: reason || 'blocked_by_user' });
    await loadState();
    toast(result.message || 'Partner blocked.');
    routeToScreen();
  } catch (e) { toast(e.message); }
}

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
  if (!state || !state.reveal || !state.reveal.available) return false;
  const r = state.reveal;

  if (!r.myChoice) {
    renderRevealConsent(); go('s-reveal-wait');
  } else if (r.myChoice === 'stay_anonymous' || r.anonymous) {
    renderRevealAnonymous(); go('s-reveal-wait');
  } else if (r.myChoice && r.revealed) {
    renderRevealed(); go('s-revealed');
  } else if (r.myChoice && !r.partnerChose) {
    renderRevealWaiting(); go('s-reveal-wait');
  } else if (r.myChoice && r.partnerChose && !r.revealed) {
    renderRevealAnonymous(); go('s-reveal-wait');
  }
  return true;
}

function renderRevealConsent() {
  const arch = archetypes[state.user.archetype];
  const matchArch = archetypes[state.match.partner.archetype];
  document.getElementById('s-reveal-wait').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="wait-body">
      <div class="wait-moon-wrap"><div class="ring"></div><div class="ring ring2"></div><div class="moon-base wait-moon"></div></div>
      <div class="wait-eyebrow">Day 21 · The Reveal</div>
      <h2 class="wait-h">Tonight,<br/>you choose<br/><em>what opens.</em></h2>
      <p class="wait-p">You've written to each other for 21 nights. Choose what, if anything, you want to reveal. Email is never shared automatically.</p>
      <div class="streak-complete">${Array.from({length:21}, () => '<div class="s-pip"></div>').join('')}</div>
      <div class="partner-wait">
        <div class="pw-moon">${matchArch.emoji}</div>
        <div><div class="pw-ey">Your partner</div><div class="pw-name">${matchArch.name}</div><div class="pw-status">Waiting for your decision</div></div>
        <div class="pw-dot"></div>
      </div>
      <button class="btn-yes" onclick="submitReveal('first_name')" style="margin-top:20px;">Reveal first name only</button>
      <button class="btn-yes" onclick="submitReveal('name_college')">Reveal name and college</button>
      <button class="btn-yes" onclick="submitReveal('contact_details')">Reveal contact details</button>
      <button class="btn-no" onclick="submitReveal('stay_anonymous')">Stay anonymous</button>
      <div class="anon-note">One "stay anonymous" keeps both identities private.<br/>No one is told who chose privacy.</div>
    </div>`;
}

function renderRevealWaiting() {
  const matchArch = archetypes[state.match.partner.archetype];
  document.getElementById('s-reveal-wait').innerHTML = `
    <div class="nav"><div class="nav-logo"><div class="site-nav-orb"></div>mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="wait-body">
      <div class="wait-moon-wrap"><div class="ring"></div><div class="ring ring2"></div><div class="moon-base wait-moon"></div></div>
      <div class="wait-eyebrow">Choice locked</div>
      <h2 class="wait-h">Waiting for<br/><em>your partner.</em></h2>
      <p class="wait-p">Your reveal choice is locked. Now waiting for your partner to make their choice.</p>
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
  if (!confirm('Lock this reveal choice? You cannot change it after submitting.')) return;
  try {
    await api('POST', '/reveal', { choice });
    await loadState();
    if (choice !== 'stay_anonymous' && state.reveal.revealed) {
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


function renderRevealed() {
  if (!state.reveal || !state.reveal.partner) return;
  const partner = state.reveal.partner;
  const matchArch = archetypes[state.match.partner.archetype];
  const totalEntries = state.entries.length;
  const displayName = partner.fullName || partner.name || 'Your partner';
  const detailLine = partner.college
    ? `${escapeHtml(partner.year || '')} year · ${escapeHtml(partner.college)}`
    : 'First name revealed';
  const canShowContact = !!partner.email;

  document.getElementById('s-revealed').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="revealed-body">
      <div class="rev-moon-wrap"><div class="rev-ring"></div><div class="rev-ring rev-ring2"></div><div class="moon-base rev-moon"></div></div>
      <div class="rev-eyebrow">The stranger had a name all along</div>
      <div class="rev-label">You've been writing to</div>
      <div class="rev-name">${escapeHtml(displayName)}</div>
      <div class="rev-college">${detailLine}</div>
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
        ${canShowContact ? `<button class="btn-yes" onclick="renderRevealYes();go('s-reveal-yes')">Show shared contact details</button>` : ''}
        <button class="btn-no" onclick="renderProfile();go('s-profile')">Maybe later</button>
      </div>
    </div>`;
  const dp = document.getElementById('rev-pips');
  if(dp) for(let i=0;i<totalEntries;i++){ const p=document.createElement('div'); p.className='d-pip'; p.style.animationDelay=`${i*.12}s`; dp.appendChild(p); }
}

function renderRevealYes() {
  const partner = state.reveal.partner;
  if (!partner.email) { toast('Contact details were not shared.'); renderProfile(); go('s-profile'); return; }
  const displayName = partner.fullName || partner.name || 'Your partner';
  document.getElementById('s-reveal-yes').innerHTML = `
    <div class="nav"><div class="nav-logo">mentally prepare</div><div class="day-pill">Day 21 ✦</div></div>
    <div class="yes-body">
      <div class="yes-moon-wrap"><div class="moon-base" style="width:90px;height:90px;box-shadow:0 0 60px rgba(201,169,110,.65),0 0 130px rgba(201,169,110,.3);animation:float 5s ease-in-out infinite;"></div></div>
      <div class="wait-eyebrow">Both said yes ✦</div>
      <h2 class="yes-h">Time to<br/><em>say hello.</em></h2>
      <p class="yes-p">You've been writing to each other for 21 nights. Now you know who wrote those words. Go say hello.</p>
      <div class="contact-card">
        <div class="contact-ey">${escapeHtml(displayName)}'s contact</div>
        <div class="contact-name">${escapeHtml(displayName)}</div>
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
      <p style="font-family:'Lora',serif;font-style:italic;font-size:13px;color:var(--ink-m);line-height:1.85;max-width:300px;margin:0 auto;">Currently free during early access. No payment is needed to start.</p>
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
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">🌙</div><div class="about-card-title">Midnight ritual</div></div><div class="about-card-p">Partner notes open after midnight IST. The ritual creates intimacy without same-night pressure.</div></div>
      <div class="about-card"><div class="about-card-h"><div class="about-card-ico">✦</div><div class="about-card-title">Consent-based reveal</div></div><div class="about-card-p">Both must say yes to reveal. One no keeps it anonymous forever. Zero rejection risk.</div></div>
    </div>
    <div class="builder-card"><div class="builder-avatar">✦</div><div><div class="builder-name">Built by Anushka Kumar</div><div class="builder-sub">HP Dreams Unlocked Top 40 · HPAIR Harvard Delegate · IIT Kharagpur</div></div></div>
    <div style="padding:20px 24px;"><button class="btn" onclick="renderSettings();go('s-settings')">← Back to settings</button></div>
    <div class="spacer"></div>`;
}

// ═══════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════
function renderTQTabs(active) {
  var tabs = [
    { id:'today', ico:'T', lbl:'Today' },
    { id:'wall', ico:'W', lbl:'Wall' },
    { id:'silent', ico:'S', lbl:'Silent Room' },
    { id:'profile', ico:'P', lbl:'Profile' }
  ];
  return '<div class="tabs app-bottom-tabs">' + tabs.map(function(t) {
    var isOn = t.id === active || (active === 'tonight' && t.id === 'today') || (active === 'entries' && t.id === 'journey');
    return '<button class="tab' + (isOn ? ' on' : '') + '" type="button" data-app-tab="' + t.id + '" aria-pressed="' + (isOn ? 'true' : 'false') + '"><div class="tab-ico">' + t.ico + '</div><div class="tab-lbl">' + t.lbl + '</div></button>';
  }).join('') + '</div>';
}

function renderTabs(active) {
  const normalized = active === 'tonight' || active === 'partner' ? 'today' : (active === 'entries' ? 'journey' : active);
  if (!state || !state.match) return renderTQTabs(normalized);
  const tabs = [
    { id:'today', ico:'T', lbl:'Today' },
    { id:'silent', ico:'S', lbl:'Silent Room' },
    { id:'journey', ico:'J', lbl:'Journey' },
    { id:'profile', ico:'P', lbl:'Profile' }
  ];
  return `<div class="tabs app-bottom-tabs">${tabs.map(t =>
    `<button class="tab${t.id===normalized?' on':''}" type="button" data-app-tab="${t.id}" aria-pressed="${t.id===normalized?'true':'false'}"><div class="tab-ico">${t.ico}</div><div class="tab-lbl">${t.lbl}</div></button>`
  ).join('')}</div>`;
}

function navigateAppTab(tab) {
  if (tab === 'today') {
    if (state && state.match) goToJournal();
    else { renderWaiting(); go('s-waiting'); }
    return;
  }
  if (tab === 'silent') {
    showSilentFeed();
    return;
  }
  if (tab === 'journey') {
    if (!state || !state.match) { renderWaiting(); go('s-waiting'); return; }
    renderPast();
    go('s-past');
    return;
  }
  if (tab === 'wall') {
    renderWall();
    return;
  }
  if (tab === 'profile') {
    renderProfile();
    go('s-profile');
  }
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

function spawnParticles() {
  var overlay = document.createElement('div');
  overlay.className = 'celebrate-overlay';
  var colors = ['var(--rose)','var(--gold)','var(--purple-l)','var(--cyan)','#fff'];
  for (var i = 0; i < 30; i++) {
    var p = document.createElement('div');
    p.className = 'confetti';
    p.style.left = (30 + Math.random() * 40) + '%';
    p.style.top = (20 + Math.random() * 30) + '%';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 0.6) + 's';
    p.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
    overlay.appendChild(p);
  }
  document.body.appendChild(overlay);
  setTimeout(function() { overlay.remove(); }, 3000);
}

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

  // Get reactions for this day
  const reactions = (state.reactions || []).filter(r => r.day === entry.day);
  const myReaction = reactions.find(r => r.from === 'me');
  const partnerReaction = reactions.find(r => r.from === 'partner');

  // Reaction picker — one word per entry, one reaction per Day
  const reactionWords = ['seen', 'same', 'honest', 'brave', 'quiet', 'real'];
  const reactionPickerHTML = partnerEntry ? `
    <div class="reaction-picker">
      ${reactionWords.map(word => `<button class="reaction-word ${myReaction && myReaction.emoji === word ? 'active' : ''}" type="button" data-react-emoji="${word}" data-react-day="${entry.day}">${word}</button>`).join('')}
    </div>
    ${partnerReaction ? `<div class="received-reaction"><span class="received-reaction-word">${partnerReaction.emoji}</span><span class="received-reaction-label">from your partner</span></div>` : ''}
  ` : '';


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
             ${reactionPickerHTML}
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
          : `<div class="edc-partner-text" style="filter:blur(4px);user-select:none;">Nothing has opened yet.</div><div class="edc-partner-note">${escapeHtml((state.partnerStatus && state.partnerStatus.unsealMessage) || 'Your partner’s note will appear here after midnight IST if they wrote today.')}</div>`
        }
      </div>
    </div>`;
  const closeBtn = document.getElementById('entryDetailCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeEntryDetail);
  const commentSendBtn = document.getElementById('entryCommentSendBtn');
  if (commentSendBtn) commentSendBtn.addEventListener('click', function() { submitComment(entry.day); });
  const reportBtn = document.getElementById('entryReportBtn');
  if (reportBtn) reportBtn.addEventListener('click', function() { reportEntry(entry.day); });
  // Reaction button handlers
  document.querySelectorAll('[data-react-emoji]').forEach(btn => {
    btn.addEventListener('click', async function() {
      const emoji = btn.dataset.reactEmoji;
      const day = parseInt(btn.dataset.reactDay);
      try {
        await api('POST', '/react', { day, emoji });
        // Float emoji animation
        const floater = document.createElement('div');
        floater.className = 'emoji-float';
        floater.textContent = emoji;
        const rect = btn.getBoundingClientRect();
        floater.style.left = rect.left + rect.width/2 - 12 + 'px';
        floater.style.top = rect.top + 'px';
        document.body.appendChild(floater);
        setTimeout(() => floater.remove(), 800);
        // Update local state
        const existingIdx = (state.reactions || []).findIndex(r => r.day === day && r.from === 'me');
        if (existingIdx >= 0) state.reactions[existingIdx].emoji = emoji;
        else { if (!state.reactions) state.reactions = []; state.reactions.push({ day, emoji, from: 'me' }); }
        // Re-render to show active state
        showEntryDetail(idx);
      } catch(e) { toast(e.message); }
    });
  });
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
  { ico:'🌠', name:'First Words', check:() => state && state.entries && state.entries.length >= 1 },
  { ico:'☄️', name:'3-Day Fire', check:() => state && state.streak >= 3 },
  { ico:'🔭', name:'Scanned', check:() => state && state.user && !!state.user.archetype },
  { ico:'🪐', name:'One Week', check:() => state && state.streak >= 7 },
  { ico:'🌓', name:'Halfway', check:() => state && state.match && state.match.day >= 11 },
  { ico:'💎', name:'Two Weeks', check:() => state && state.streak >= 14 },
  { ico:'🌌', name:'Full Spectrum', check:() => { if (!state || !state.entries) return false; return new Set(state.entries.map(e=>e.mood)).size >= 5; } },
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
  if (!glow) return;
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
  if (!c) return;
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
  if (!links) return;
  const nextState = !links.classList.contains('open');
  links.classList.toggle('open', nextState);
  const btn = document.getElementById('siteMenuBtn');
  if (btn) btn.setAttribute('aria-expanded', String(nextState));
}

// Service Worker: force-update old versions
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallPromptIfUseful();
});

window.addEventListener('appinstalled', function() {
  deferredInstallPrompt = null;
  dismissInstallPrompt(365);
  toast('Mentally Prepare installed.');
});

if ('serviceWorker' in navigator) {
  // Clear ALL old caches first
  caches.keys().then(names => {
    names.forEach(n => { if (n !== 'pwa-push-1') caches.delete(n); });
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
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/public-key');
    if (!res.ok) {
      toast('We could not turn on notifications. Please try again.');
      return false;
    }
    const { publicKey } = await res.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    const save = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ subscription: sub, preferences: getPushPreferences() })
    });
    if (!save.ok) {
      const errBody = await save.text().catch(() => '');
      throw new Error('save_failed: HTTP ' + save.status + ' ' + errBody);
    }
    if (state && state.user) state.user.pushSubscribed = true;
    return true;
  } catch (e) {
    console.error('[Push] subscribeToPush failed:', { name: e && e.name, message: e && e.message, error: e });
    toast('We could not turn on notifications. Please try again.');
    return false;
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

// ═══════════════════════════════════════
// PRIVACY — Data Download & Account Delete
// ═══════════════════════════════════════
async function savePushPreferences(prefs, silent) {
  const clean = Object.assign({}, defaultPushPreferences, prefs || {});
  if (clean.enabled === false) {
    clean.morningReminder = false;
    clean.eveningReminder = false;
    clean.dailyReflection = false;
    clean.streakReminder = false;
    clean.silentRoomReminder = false;
  }
  try {
    const result = await api('POST', '/push/preferences', { preferences: clean });
    if (state && state.user) state.user.pushPreferences = result.preferences || clean;
    if (!silent) toast('Notification settings saved.');
    return true;
  } catch (e) {
    if (!silent) toast('Could not save notification settings.');
    return false;
  }
}

function notificationPrefToggleHtml(key, label, checked) {
  return `<label class="notification-pref"><input type="checkbox" data-modal-push-pref="${key}" ${checked ? 'checked' : ''}/><span>${label}</span></label>`;
}

function renderNotificationPermissionModal(source) {
  const old = document.getElementById('notification-permission-modal');
  if (old) old.remove();
  const prefs = getPushPreferences();
  const modal = document.createElement('div');
  modal.id = 'notification-permission-modal';
  modal.className = 'mp-modal notification-modal show';
  // Soft single-button variant for the first-entry nudge.
  if (source === 'after_reflection') {
    modal.innerHTML = `
      <div class="mp-modal-card notification-card" role="dialog" aria-modal="true" aria-labelledby="notif-title">
        <button class="mp-modal-close" type="button" aria-label="Close" onclick="closeNotificationModal()">x</button>
        <div class="notification-icon">MP</div>
        <h2 id="notif-title">want to know when your match writes back?</h2>
        <p>One quiet reminder when they show up. Nothing else.</p>
        <button class="btn" type="button" onclick="enableNotificationsFromModal()">Enable notifications</button>
        <button class="btn-ghost" type="button" onclick="closeNotificationModal()">Maybe later</button>
        <div class="notification-note" id="notification-modal-status"></div>
      </div>`;
  } else {
    modal.innerHTML = `
      <div class="mp-modal-card notification-card" role="dialog" aria-modal="true" aria-labelledby="notif-title">
        <button class="mp-modal-close" type="button" aria-label="Close" onclick="closeNotificationModal()">x</button>
        <div class="notification-icon">MP</div>
        <div class="notification-kicker">Gentle reminders</div>
        <h2 id="notif-title">Let Mentally Prepare remind you softly.</h2>
        <p>We only send private, simple prompts. No diagnosis, pressure, or sensitive lock screen copy.</p>
        <div class="notification-preview">Your reset is ready.</div>
        <div class="notification-pref-list">
          ${notificationPrefToggleHtml('morningReminder', 'Morning reminder', prefs.morningReminder)}
          ${notificationPrefToggleHtml('eveningReminder', 'Evening reminder', prefs.eveningReminder)}
          ${notificationPrefToggleHtml('dailyReflection', 'Daily reflection reminder', prefs.dailyReflection)}
          ${notificationPrefToggleHtml('streakReminder', 'Nightly nudge', prefs.streakReminder)}
          ${notificationPrefToggleHtml('silentRoomReminder', 'Silent Room reminder', prefs.silentRoomReminder)}
        </div>
        <button class="btn" type="button" onclick="enableNotificationsFromModal()">Allow gentle reminders</button>
        <button class="btn-ghost" type="button" onclick="closeNotificationModal()">Maybe later</button>
        <div class="notification-note" id="notification-modal-status"></div>
      </div>`;
  }
  document.body.appendChild(modal);
  localStorage.setItem('mp-notification-nudged', source || 'manual');
}

function closeNotificationModal() {
  const modal = document.getElementById('notification-permission-modal');
  if (modal) modal.remove();
}

function readModalPushPreferences() {
  const prefs = getPushPreferences();
  document.querySelectorAll('[data-modal-push-pref]').forEach(input => {
    prefs[input.getAttribute('data-modal-push-pref')] = input.checked;
  });
  prefs.enabled = true;
  return prefs;
}

async function enableNotificationsFromModal() {
  const status = document.getElementById('notification-modal-status');
  if (!('Notification' in window)) {
    if (status) status.textContent = 'Notifications are not supported in this browser.';
    return;
  }
  const prefs = readModalPushPreferences();
  await savePushPreferences(prefs, true);
  if (Notification.permission === 'denied') {
    if (status) status.textContent = 'Notifications are blocked in browser settings. You can still use the app.';
    return;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') {
    const ok = await subscribeToPush();
    if (ok) {
      toast('Notifications enabled.');
      closeNotificationModal();
      renderSettingsIfOpen();
    } else if (status) {
      status.textContent = 'We could not turn on notifications. Please try again.';
    }
  } else {
    localStorage.setItem('mp-notifications-declined', '1');
    if (status) status.textContent = 'Notifications are off. You can continue without them.';
  }
}

function maybeShowNotificationNudge(source) {
  if (!state || !state.user || localStorage.getItem('mp-notification-nudged')) return;
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  // Only fire after the very first entry — gate by state.entries length.
  if (source === 'after_reflection') {
    const entryCount = (state.entries && state.entries.length) || 0;
    if (entryCount > 1) return;
  }
  setTimeout(function() { renderNotificationPermissionModal(source || 'after_reflection'); }, 900);
}

function renderSettingsIfOpen() {
  const settings = document.getElementById('s-settings');
  if (settings && settings.classList.contains('active')) renderSettings();
}

async function toggleNotificationPreference(key, checked) {
  const prefs = getPushPreferences();
  prefs[key] = !!checked;
  prefs.enabled = true;
  await savePushPreferences(prefs);
  renderSettingsIfOpen();
}

async function toggleNotificationsOff(checked) {
  const prefs = getPushPreferences();
  prefs.enabled = !checked;
  await savePushPreferences(prefs);
  if (checked) await unsubscribeFromPush(true);
  renderSettingsIfOpen();
}

async function unsubscribeFromPush(silent) {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) await sub.unsubscribe().catch(() => {});
    }
    await api('POST', '/push/unsubscribe');
    if (state && state.user) {
      state.user.pushSubscribed = false;
      state.user.pushPreferences = Object.assign({}, defaultPushPreferences, { enabled: false });
    }
    if (!silent) toast('Notifications turned off.');
  } catch (e) {
    if (!silent) toast('Could not turn off notifications.');
  }
}

function toggleNotifications() {
  if (!('Notification' in window)) { toast('Notifications not supported in this browser'); return; }
  if (Notification.permission === 'granted') {
    subscribeToPush().then(ok => {
      toast(ok ? 'Notifications are enabled.' : 'We could not turn on notifications. Please try again.');
      renderSettingsIfOpen();
    });
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications are blocked in browser settings.');
    return;
  }
  renderNotificationPermissionModal('settings');
}

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
  if (!email) {
    setAuthStatus('forgot-status', 'Enter your email.', 'error');
    toast('Enter your email');
    return;
  }
  try {
    setAuthStatus('forgot-status', 'Sending reset code...', 'loading');
    setButtonLoading('forgotSubmitBtn', true, 'Sending...');
    const result = await api('POST', '/forgot-password', { email });
    toast('Reset code generated');
    setAuthStatus('forgot-status', result.message || 'If that email exists, a reset code has been sent.', 'success');
    go('s-reset');
  } catch (e) {
    setAuthStatus('forgot-status', e.message || 'Could not send reset code.', 'error');
    toast(e.message);
  } finally {
    setButtonLoading('forgotSubmitBtn', false);
  }
}
async function resetPassword() {
  let code = document.getElementById('reset-code').value.trim().replace(/\s+/g, '');
  if (code.length === 6) {
    code = code.toUpperCase();
  }
  const newPassword = document.getElementById('reset-password').value;
  if (!code || !newPassword) {
    setAuthStatus('reset-status', 'Enter code and new password.', 'error');
    toast('Enter code and new password');
    return;
  }
  if (!/^(?:[A-Z0-9]{6}|[A-F0-9]{64})$/i.test(code)) {
    setAuthStatus('reset-status', 'Enter the reset code from your email.', 'error');
    toast('Enter the 6-character reset code from your email');
    return;
  }
  if (newPassword.length < 8) {
    setAuthStatus('reset-status', 'Password must be at least 8 characters.', 'error');
    toast('Password must be at least 8 characters');
    return;
  }
  try {
    setAuthStatus('reset-status', 'Setting your new password...', 'loading');
    setButtonLoading('resetSubmitBtn', true, 'Saving...');
    await api('POST', '/reset-password', { code, newPassword });
    toast('Password reset. Sign in now.');
    setAuthStatus('reset-status', 'Password reset. You can log in now.', 'success');
    go('s-login');
  } catch (e) {
    setAuthStatus('reset-status', e.message || 'Password reset failed.', 'error');
    toast(e.message);
  } finally {
    setButtonLoading('resetSubmitBtn', false);
  }
}
// ═══════════════════════════════════════
// DAILY NOTE CARD — Feature 01
// ═══════════════════════════════════════

// Web Audio API piano tone (200ms, gentle C note)
function playPianoTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.9);
  } catch {}
}

// Word-by-word fade-in
function animateWordsIn(el, text, msPerWord) {
  msPerWord = msPerWord || 55;
  el.innerHTML = '';
  var words = text.split(' ');
  words.forEach(function(w, i) {
    var span = document.createElement('span');
    span.className = 'note-word';
    span.textContent = w + ' ';
    span.style.animationDelay = (i * msPerWord) + 'ms';
    el.appendChild(span);
  });
}

var noteState = null;

async function loadDailyNote() {
  try {
    var data = await api('GET', '/daily-note');
    noteState = data;
    return data;
  } catch { return null; }
}

function renderDailyNoteCard(container, noteData) {
  if (!noteData || !noteData.note) { container.innerHTML = ''; return; }
  var note = noteData.note;
  var isOpened = !!note.opened_at;
  var moonPhases = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];
  var hour = new Date().getHours();
  var moonIdx = Math.floor(hour / 3);

  container.innerHTML = `
    <div class="note-card ${isOpened ? 'open' : 'sealed'}" id="daily-note-card" role="button" tabindex="0" aria-label="Daily note card — tap to open">
      <div class="note-card-header">
        <span class="note-label">A note for today ✦</span>
        <span class="note-moon-row">${moonPhases.map(function(m,i){ return '<span class="'+(i===moonIdx?'moon-active':'')+'">' + m + '</span>'; }).join('')}</span>
      </div>
      <div id="note-card-body">${isOpened ? renderNoteOpen(note) : renderNoteSealed()}</div>
    </div>`;

  afterRenderMotion(container);

  if (!isOpened) {
    var card = document.getElementById('daily-note-card');
    card.addEventListener('click', function() { unsealNote(note); });
    card.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') unsealNote(note); });
  }
}

function renderNoteSealed() {
  return `<div class="note-sealed-inner">
    <div class="note-seal-ring"></div>
    <div class="note-seal-ico">✦</div>
    <div class="note-sealed-arrived">arrived at 8:00 am · tap to open</div>
  </div>`;
}

function renderNoteOpen(note) {
  var feedbackHtml = note.landed
    ? `<div class="note-feedback-done">${note.landed === 'yes' ? '✦ This landed' : 'Noted'}</div>`
    : `<div class="note-feedback-row">
        <button class="note-fb-btn" onclick="submitNoteFeedback('yes')">✦ This landed</button>
        <button class="note-fb-btn ghost" onclick="submitNoteFeedback('no')">Not today</button>
      </div>`;
  return `<div class="note-open-inner">
    <p class="note-observation" id="note-obs">${escapeHtml(note.observation)}</p>
    <p class="note-permission" id="note-perm"><em>${escapeHtml(note.permission)}</em></p>
    <div class="note-question-block" id="note-q">
      <span class="note-q-label">A question for tonight</span>
      <span class="note-question-text">${escapeHtml(note.question)}</span>
    </div>
    ${feedbackHtml}
  </div>`;
}

async function unsealNote(note) {
  var card = document.getElementById('daily-note-card');
  if (!card || card.classList.contains('open')) return;
  card.classList.remove('sealed');
  card.classList.add('opening');
  playPianoTone();
  api('POST', '/daily-note/open').catch(function(){});
  var body = document.getElementById('note-card-body');
  body.innerHTML = renderNoteOpen(note);
  setTimeout(function() {
    var obs = document.getElementById('note-obs');
    var perm = document.getElementById('note-perm');
    if (obs) animateWordsIn(obs, note.observation, 55);
    if (perm) setTimeout(function(){ animateWordsIn(perm, note.permission, 55); }, 600);
    card.classList.remove('opening');
    card.classList.add('open');
  }, 100);
}

async function submitNoteFeedback(landed) {
  try {
    await api('POST', '/daily-note/feedback', { landed });
    var fbRow = document.querySelector('.note-feedback-row');
    if (fbRow) fbRow.outerHTML = `<div class="note-feedback-done">${landed === 'yes' ? '✦ This landed' : 'Noted'}</div>`;
  } catch (e) { toast(e.message); }
}

async function renderNoteArchive() {
  try {
    var res = await api('GET', '/daily-notes/archive');
    var el = document.getElementById('note-archive');
    if (!el) return;
    var notes = res.notes || [];
    if (!notes.length) { el.innerHTML = '<p style="opacity:.5;font-size:13px;padding:16px;">No notes yet.</p>'; return; }
    el.innerHTML = notes.map(function(n, i) {
      return `<div class="note-archive-item" style="z-index:${notes.length - i};">
        <div class="note-archive-day">Day ${n.day}</div>
        <p class="note-archive-obs">${escapeHtml(n.observation)}</p>
        <p class="note-archive-q"><em>${escapeHtml(n.question)}</em></p>
        ${n.landed ? `<div class="note-archive-badge">${n.landed === 'yes' ? '✦ Landed' : 'Passed'}</div>` : ''}
      </div>`;
    }).join('');
  } catch {}
}


// ═══════════════════════════════════════
// CONSTELLATION — Feature 04
// ═══════════════════════════════════════
var CONSTELLATION_SHAPES = {
  'protector-connector': [[20,80],[40,60],[55,40],[70,20],[85,50],[65,70],[45,85],[30,65]],
  'connector-protector': [[20,80],[40,60],[55,40],[70,20],[85,50],[65,70],[45,85],[30,65]],
  'performer-disconnector': [[15,50],[35,25],[55,15],[75,30],[90,55],[70,75],[50,85],[25,70]],
  'disconnector-performer': [[15,50],[35,25],[55,15],[75,30],[90,55],[70,75],[50,85],[25,70]],
  'protector-protector': [[50,10],[75,35],[90,65],[65,85],[35,85],[10,65],[25,35],[50,55]],
  'connector-connector': [[50,15],[80,40],[85,70],[60,88],[30,80],[15,55],[30,25],[55,50]],
  'performer-performer': [[30,10],[60,10],[80,35],[75,65],[55,85],[25,80],[10,55],[20,30]],
  'disconnector-disconnector': [[50,5],[85,30],[75,65],[50,85],[25,65],[15,30],[35,20],[65,20]],
};
var CONSTELLATION_NAMES = {
  'protector-connector': 'The Anchor',
  'connector-protector': 'The Anchor',
  'performer-disconnector': 'The Stage',
  'disconnector-performer': 'The Stage',
  'protector-protector': 'The Twin Shields',
  'connector-connector': 'The Open Sky',
  'performer-performer': 'The Mirror',
  'disconnector-disconnector': 'The Island Pair',
};

function renderConstellation(matchData, entries, partnerEntries, day) {
  var myArch = state && state.user ? state.user.archetype : null;
  var partnerArch = matchData && matchData.partner ? matchData.partner.archetype : null;
  if (!myArch || !partnerArch) return '<div class="constellation-empty">✦</div>';

  var key = myArch + '-' + partnerArch;
  var points = [
    [9,74],[15,56],[26,42],[18,25],[34,18],[46,30],[58,16],
    [74,24],[83,42],[69,54],[88,68],[72,80],[58,70],[48,86],
    [35,75],[24,88],[14,82],[28,62],[42,54],[54,44],[64,62]
  ];
  var name = CONSTELLATION_NAMES[key] || 'The Unknown';

  var writtenMap = {};
  var partnerMap = {};
  (entries || []).forEach(function(e) { writtenMap[e.day] = true; });
  (partnerEntries || []).forEach(function(e) { partnerMap[e.day] = true; });
  var writtenCount = Math.min((entries || []).length, 21);
  var completeUntil = Math.max(writtenCount, Math.min(day, 21) - 1);
  var showName = day >= 7;

  var orbit = '<path class="const-orbit" d="M9 74 C20 18 52 2 83 42 S73 96 24 88 S28 44 64 62" />';
  var lines = points.slice(1).map(function(p, i) {
    var prev = points[i];
    var cls = i + 2 <= completeUntil ? 'const-line complete' : 'const-line';
    return '<line x1="' + prev[0] + '" y1="' + prev[1] + '" x2="' + p[0] + '" y2="' + p[1] + '" class="' + cls + '" />';
  }).join('');

  var stars = points.map(function(p, i) {
    var d = i + 1;
    var classes = ['const-star'];
    if (writtenMap[d]) classes.push('complete'); else classes.push('future');
    if (partnerMap[d] && writtenMap[d]) classes.push('sync');
    if (d === day) classes.push('current');
    var label = 'Day ' + d + (writtenMap[d] ? ' written' : ' future');
    return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (d === day ? 3.2 : writtenMap[d] ? 2.75 : 1.8) + '" class="' + classes.join(' ') + '"><title>' + label + '</title></circle>';
  }).join('');
  var starsToShow = writtenCount;

  return `<div class="constellation-wrap">
    <svg class="constellation-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="Constellation map">
      ${orbit}${lines}${stars}
    </svg>
    ${showName ? `<div class="constellation-name">${name}</div>` : ''}
    <div class="constellation-days">${starsToShow} of 21 nights ✦</div>
  </div>`;
}


// ═══════════════════════════════════════
// MIDNIGHT UNSEALING CEREMONY — Feature 02
// ═══════════════════════════════════════

function buildUnsealingSlot(partnerEntry, day, partnerArchetype) {
  var el = document.getElementById('s-sealed');
  if (!el) return;
  var archInfo = archetypes[partnerArchetype] || {};
  var slot = document.getElementById('unseal-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'unseal-slot';
    slot.style.cssText = 'padding:0 24px 16px;';
    var nav = el.querySelector('.nav');
    if (nav) nav.insertAdjacentElement('afterend', slot);
    else el.prepend(slot);
  }
  slot.innerHTML = `
    <div class="unseal-ceremony" id="unseal-ceremony">
      <div class="envelope-outer" id="envelope-outer">
        <div class="envelope-flap"></div>
        <div class="envelope-label">Day ${day} · ${archInfo.name || 'Your partner'}</div>
      </div>
      <button class="btn-unseal" id="btn-unseal-ceremony" onclick="revealPartnerEntry()">🌙 Open partner note</button>
    </div>
    <div class="partner-reveal-text" id="partner-reveal-text" style="display:none;"></div>`;
  slot._partnerEntry = partnerEntry;
}

function revealPartnerEntry() {
  var slot = document.getElementById('unseal-slot');
  if (!slot) return;
  var partnerEntry = slot._partnerEntry;
  if (!partnerEntry) return;

  var envelope = document.getElementById('envelope-outer');
  var btn = document.getElementById('btn-unseal-ceremony');
  var revealEl = document.getElementById('partner-reveal-text');

  if (envelope) envelope.classList.add('opening');
  if (btn) btn.style.display = 'none';
  playPianoTone();

  setTimeout(function() {
    if (envelope) envelope.style.display = 'none';
    if (!revealEl) return;
    revealEl.style.display = 'block';
    var archInfo = archetypes[partnerEntry.archetype || ''] || {};
    var lines = (partnerEntry.text || '').split(/\n/).filter(Boolean);
    if (!lines.length) lines = [partnerEntry.text || ''];
    revealEl.innerHTML = `
      <div class="partner-reveal-header">
        <span class="partner-reveal-mood">${partnerEntry.mood || '🌓'}</span>
        <span class="partner-reveal-arch">${archInfo.name || 'Your partner'} · Day ${partnerEntry.day}</span>
      </div>
      <div class="partner-reveal-lines" id="pr-lines"></div>`;
    var linesEl = document.getElementById('pr-lines');
    lines.forEach(function(line, i) {
      var p = document.createElement('p');
      p.className = 'partner-reveal-line';
      p.style.animationDelay = (i * 0.35) + 's';
      p.textContent = line;
      linesEl.appendChild(p);
    });
  }, 800);
}


// ═══════════════════════════════════════
// SILENT ROOM
// ═══════════════════════════════════════
var silentCursor = null;
var silentExhausted = false;
var silentLoading = false;
var silentPostsToday = 0;

function showSilentRoom() { showSilentFeed(); }

async function showSilentFeed() {
  silentCursor = null;
  silentExhausted = false;
  silentLoading = false;

  document.getElementById('s-silent-feed').innerHTML = `
    <div class="silent-header">
      <div class="silent-logo">Silent Room</div>
      <button class="silent-write-link" id="silentWriteBtn" onclick="showSilentWrite()">Write a line ✦</button>
    </div>
    <div class="silent-presence-row" id="silentPresenceRow">
      <span class="silent-presence-dot"></span>
      <span class="silent-presence-text" id="silentPresenceText">loading…</span>
    </div>
    <div class="silent-instruction">One line. No replies. No reactions. Just witnessed.</div>
    <div class="silent-feed-list" id="silentFeedList">
      <div class="silent-spinner">· · ·</div>
    </div>
    <div id="silentLoadMoreWrap" style="display:none;text-align:center;padding:28px 0 12px">
      <button class="silent-load-more-btn" onclick="loadMoreSilentFeed()">Load more</button>
    </div>
    <div class="silent-mine-link-row">
      <button class="silent-ghost-link" onclick="showSilentMine()">Your lines →</button>
    </div>
    ${renderTabs('silent')}
  `;
  go('s-silent-feed');

  // Load presence count
  api('GET', '/silent/presence').then(function(d) {
    var el = document.getElementById('silentPresenceText');
    if (el) {
      var n = d.count || 0;
      el.textContent = n === 0
        ? 'Quiet here so far. Add the first line of the day.'
        : n + (n === 1 ? ' person has' : ' people have') + ' written here today';
    }
  }).catch(function() {
    var el = document.getElementById('silentPresenceText');
    if (el) el.textContent = 'Add a line to the room.';
  });

  // Load rate limit state from mine endpoint
  try {
    var mineData = await api('GET', '/silent/mine');
    var today = new Date().toISOString().slice(0, 10);
    silentPostsToday = (mineData.lines || []).filter(function(l) {
      return (l.created_at || '').slice(0, 10) === today;
    }).length;
    var btn = document.getElementById('silentWriteBtn');
    if (btn && silentPostsToday >= 3) {
      btn.textContent = 'Come back tomorrow';
      btn.disabled = true;
      btn.style.opacity = '0.35';
      btn.style.cursor = 'default';
    }
  } catch (e) {}

  loadSilentFeed(true);
}

async function loadSilentFeed(reset) {
  if (silentLoading || silentExhausted) return;
  silentLoading = true;
  try {
    var url = '/silent/feed?limit=20';
    if (!reset && silentCursor) url += '&cursor=' + encodeURIComponent(silentCursor);
    var data = await api('GET', url);
    var list = document.getElementById('silentFeedList');
    if (!list) return;

    if (reset) list.innerHTML = '';

    var lines = data.lines || [];
    if (lines.length === 0 && reset) {
      silentExhausted = true;
      list.innerHTML = '<div class="silent-empty">No one has left a line here yet.<br><em>You can be the first quiet voice.</em></div>';
      return;
    }

    lines.forEach(function(line, i) {
      var block = document.createElement('div');
      block.className = 'silent-line-block';
      block.style.animationDelay = (i * 0.07) + 's';
      var seenCount = line.seen_count || 0;
      var resonanceCount = line.resonance_count || 0;
      var resonated = line.resonated || false;
      block.innerHTML =
        '<p class="silent-line-text">' + escapeHtml(line.content) + '</p>' +
        '<div class="silent-line-meta">' +
          '<span class="silent-seen-count">👁 seen by ' + seenCount + '</span>' +
          '<button class="silent-resonate-btn' + (resonated ? ' resonated' : '') + '" ' +
            'data-id="' + escapeHtml(line.id) + '" ' +
            'data-resonated="' + resonated + '" ' +
            'onclick="toggleResonance(this)">' +
            'I felt this too · <span class="silent-res-count">' + resonanceCount + '</span>' +
          '</button>' +
        '</div>';
      list.appendChild(block);
    });

    silentCursor = data.next_cursor || null;
    silentExhausted = !data.next_cursor;

    var loadWrap = document.getElementById('silentLoadMoreWrap');
    if (loadWrap) loadWrap.style.display = silentExhausted ? 'none' : 'block';

    if (lines.length > 0 && silentExhausted) {
      var end = document.createElement('div');
      end.className = 'silent-end-msg';
      end.textContent = 'You have read everything in the room tonight. Come back when more arrive.';
      list.appendChild(end);
    }
  } catch (e) {
    var list = document.getElementById('silentFeedList');
    if (list) list.innerHTML = '<div class="silent-empty">We could not open this yet.<br><em>Refresh gently.</em></div>';
  } finally {
    silentLoading = false;
  }
}

function loadMoreSilentFeed() {
  loadSilentFeed(false);
}

async function toggleResonance(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  var id = btn.dataset.id;
  var wasResonated = btn.dataset.resonated === 'true';
  var countEl = btn.querySelector('.silent-res-count');
  var count = parseInt(countEl.textContent) || 0;

  // Optimistic UI
  if (wasResonated) {
    btn.classList.remove('resonated');
    btn.dataset.resonated = 'false';
    countEl.textContent = Math.max(0, count - 1);
  } else {
    btn.classList.add('resonated');
    btn.dataset.resonated = 'true';
    countEl.textContent = count + 1;
  }

  try {
    var result = await api('POST', '/silent/' + id + '/resonate', {});
    if (result && typeof result.resonated === 'boolean') {
      btn.classList.toggle('resonated', result.resonated);
      btn.dataset.resonated = result.resonated ? 'true' : 'false';
    }
    if (result && typeof result.resonance_count === 'number') {
      countEl.textContent = result.resonance_count;
    }
  } catch (e) {
    // Revert on error
    if (wasResonated) {
      btn.classList.add('resonated');
      btn.dataset.resonated = 'true';
      countEl.textContent = count;
    } else {
      btn.classList.remove('resonated');
      btn.dataset.resonated = 'false';
      countEl.textContent = count;
    }
  } finally {
    btn.disabled = false;
  }
}

function showSilentWrite() {
  document.getElementById('s-silent-write').innerHTML = `
    <div class="silent-write-wrap">
      <div class="silent-header">
        <button class="silent-back-btn" onclick="showSilentFeed()">←</button>
        <div class="silent-logo">Silent Room</div>
        <div style="width:40px"></div>
      </div>
      <div class="silent-write-instruction">One line. No replies. No reactions. Just witnessed.</div>
      <div class="silent-compose-area">
        <textarea
          class="silent-textarea"
          id="silentTextarea"
          maxlength="200"
          placeholder="What are you carrying tonight?"
          oninput="updateSilentCounter()"
          autofocus
        ></textarea>
        <div class="silent-counter-row">
          <span class="silent-counter" id="silentCounter">0 / 200</span>
        </div>
      </div>
      <div class="silent-release-wrap">
        <button class="silent-release-btn" id="silentReleaseBtn" onclick="submitSilentLine()">Release</button>
        <div class="silent-vanish-note">Disappears in 7 days.</div>
      </div>
      <div class="silent-crisis-link">
        <a href="#" onclick="showSafety();return false;">Need help? Crisis resources →</a>
      </div>
    </div>
  `;
  go('s-silent-write');
}

function updateSilentCounter() {
  var ta = document.getElementById('silentTextarea');
  var ct = document.getElementById('silentCounter');
  if (!ta || !ct) return;
  var len = ta.value.length;
  ct.textContent = len + ' / 200';
  ct.style.color = len > 180 ? 'var(--rose)' : 'var(--ink-s)';
}

async function submitSilentLine() {
  var ta = document.getElementById('silentTextarea');
  var btn = document.getElementById('silentReleaseBtn');
  if (!ta || !btn) return;

  var content = ta.value.trim();
  if (!content) { toast('Write something first.'); return; }

  btn.disabled = true;
  btn.textContent = '...';

  try {
    var result = await api('POST', '/silent', { content: content });

    if (result.status === 'crisis_intercepted') {
      // Show safety overlay with extra message
      document.getElementById('s-silent-write').innerHTML += `
        <div class="silent-crisis-overlay" id="silentCrisisOverlay">
          <div class="silent-crisis-card">
            <div class="silent-crisis-ico">💚</div>
            <p class="silent-crisis-msg">${escapeHtml(result.message)}</p>
            <button class="btn" onclick="document.getElementById('silentCrisisOverlay').remove();showSilentFeed()">I'm okay, return to room</button>
          </div>
        </div>
      `;
      return;
    }

    silentPostsToday++;

    // Post-submission transition screen
    var presenceCount = result.presence_count || 0;
    var randomLine = result.random_line || null;
    var wrap = document.getElementById('s-silent-write');
    if (wrap) {
      wrap.innerHTML = `
        <div class="silent-transition-wrap" id="silentTransitionScreen">
          <div class="silent-transition-count">${presenceCount}</div>
          <div class="silent-transition-label">people are in this room tonight</div>
          <div class="silent-transition-msg">
            Your words are here now.<br>Someone will read them.
          </div>
          ${randomLine ? `
          <div class="silent-transition-divider"></div>
          <div class="silent-transition-witness">
            <div class="silent-transition-witness-lbl">Someone else wrote tonight</div>
            <div class="silent-transition-witness-line">"${escapeHtml(randomLine)}"</div>
          </div>` : ''}
        </div>
      `;
    }

    // Auto-transition to feed after 3.5s
    setTimeout(function() {
      showSilentFeed();
    }, 3500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Release';
    toast(e.message || 'Something did not load. Try once more.');
  }
}

// ═══════════════════════════════════════
// ANONYMOUS WALL
// ═══════════════════════════════════════

var wallData = null;
var wallComposerOpen = false;

function wallRelativeTime(dateStr) {
  var diff = Date.now() - new Date(dateStr + 'Z').getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function wallCountdown() {
  var now = new Date();
  var istOffset = 5.5 * 60 * 60 * 1000;
  var istNow = new Date(now.getTime() + istOffset);
  var istMidnight = new Date(istNow);
  istMidnight.setHours(24, 0, 0, 0);
  var msLeft = istMidnight.getTime() - istNow.getTime();
  var hrsLeft = Math.floor(msLeft / 3600000);
  var minsLeft = Math.floor((msLeft % 3600000) / 60000);
  return hrsLeft + 'h ' + minsLeft + 'm until the next question';
}

async function renderWall() {
  var el = document.getElementById('s-wall');
  if (!el) return;

  el.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,.4);">Loading the wall...</div>';
  go('s-wall');

  try {
    wallData = await api('GET', '/wall/feed');
  } catch (e) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,.4);">Could not load the wall right now.</div>' + renderTabs('wall');
    return;
  }

  var q = wallData.question;
  var posts = wallData.posts || [];
  var hasPosted = posts.some(function(p) { return p.is_mine; });

  var composerHTML = '';
  if (!hasPosted) {
    if (!wallComposerOpen) {
      composerHTML = '<button class="wall-open-composer" onclick="wallOpenComposer()">Share what you\'re carrying tonight...</button>';
    } else {
      composerHTML = '<form class="wall-composer" onsubmit="wallSubmitPost(event);return false;">' +
        '<textarea id="wallDraft" placeholder="Say it here. No one sees your name." maxlength="500" oninput="wallUpdateCount()"></textarea>' +
        '<div class="wall-composer-footer">' +
          '<span id="wallCharCount">0/500</span>' +
          '<div style="display:flex;gap:8px;">' +
            '<button type="button" class="btn-ghost" style="min-height:36px;padding:8px 14px;" onclick="wallCloseComposer()">Cancel</button>' +
            '<button type="submit" class="btn-primary" id="wallSubmitBtn" style="min-height:36px;padding:8px 14px;" disabled>Post anonymously</button>' +
          '</div>' +
        '</div>' +
        '<div id="wallError" style="display:none;" class="wall-error"></div>' +
      '</form>';
    }
  }

  var feedHTML = '';
  if (posts.length === 0) {
    feedHTML = '<div class="wall-empty">The wall is quiet tonight.<br><em>Be the first to share.</em></div>';
  } else {
    feedHTML = posts.map(function(post) {
      var timeStr = wallRelativeTime(post.created_at);
      var reactBtn = '';
      if (!post.is_mine) {
        var cls = post.reacted ? 'wall-react-btn reacted' : 'wall-react-btn';
        var dis = post.reacted ? ' disabled' : '';
        var label = post.me_too_count > 0
          ? "You're one of " + post.me_too_count + " who've been here"
          : "I've felt this too";
        reactBtn = '<button class="' + cls + '" onclick="wallReact(' + post.id + ', this)"' + dis + '>' + label + '</button>';
      } else if (post.me_too_count > 0) {
        var word = post.me_too_count === 1 ? 'person has' : 'people have';
        reactBtn = '<span class="wall-solidarity">' + post.me_too_count + ' ' + word + ' been here too</span>';
      }
      return '<div class="wall-card">' +
        '<p class="wall-card-text">' + escapeHtml(post.content) + '</p>' +
        '<div class="wall-card-footer">' +
          '<time>' + timeStr + '</time>' +
          reactBtn +
        '</div>' +
      '</div>';
    }).join('');
  }

  el.innerHTML =
    '<div class="wall-header">' +
      '<div class="wall-eyebrow">Tonight\'s Question</div>' +
      '<div class="wall-question">' + escapeHtml(q ? q.prompt : 'No question tonight') + '</div>' +
      '<div class="wall-countdown">' + wallCountdown() + '</div>' +
      '<button class="wall-support-link" onclick="wallShowCrisis()">Need to talk to someone now?</button>' +
    '</div>' +
    composerHTML +
    '<div class="wall-feed">' + feedHTML + '</div>' +
    renderTabs('wall');
}

function wallOpenComposer() {
  wallComposerOpen = true;
  renderWall();
}

function wallCloseComposer() {
  wallComposerOpen = false;
  renderWall();
}

function wallUpdateCount() {
  var draft = document.getElementById('wallDraft');
  var count = document.getElementById('wallCharCount');
  var btn = document.getElementById('wallSubmitBtn');
  if (!draft) return;
  var len = draft.value.trim().length;
  if (count) count.textContent = draft.value.length + '/500';
  if (btn) btn.disabled = len === 0;
}

async function wallSubmitPost(event) {
  if (event) event.preventDefault();
  var draft = document.getElementById('wallDraft');
  var errEl = document.getElementById('wallError');
  var btn = document.getElementById('wallSubmitBtn');
  if (!draft || !draft.value.trim()) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Posting...'; }
  if (errEl) errEl.style.display = 'none';

  try {
    var data = await api('POST', '/wall/post', { content: draft.value.trim(), match_opt_in: false });
    if (data.crisis) {
      wallShowCrisis(data.message, true);
      return;
    }
    wallComposerOpen = false;
    renderWall();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Post anonymously'; }
  }
}

async function wallReact(postId, btn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    var data = await api('POST', '/wall/react', { post_id: postId });
    btn.classList.add('reacted');
    btn.textContent = "You're one of " + data.me_too_count + " who've been here";
  } catch (e) {
    btn.disabled = false;
  }
}

function wallShowCrisis(message, held) {
  var el = document.getElementById('s-wall-crisis');
  if (!el) return;

  var headingText = held
    ? "What you wrote sounds like it comes from a really heavy place. We didn't post it publicly — not as a penalty, but because we want to make sure you're okay first."
    : '';
  var crisisMsg = message || "If things feel like too much right now, you don't have to sit with it alone. These people are here, any time:";

  el.innerHTML =
    '<div class="wall-crisis-wrap">' +
      '<div class="wall-eyebrow">Support</div>' +
      '<div class="wall-crisis-title">You\'re not alone</div>' +
      (headingText ? '<p class="wall-crisis-held">' + headingText + '</p>' : '') +
      '<p class="wall-crisis-msg">' + escapeHtml(crisisMsg) + '</p>' +
      '<div class="wall-crisis-helplines">' +
        '<div class="wall-crisis-helpline primary">' +
          '<strong>Tele MANAS</strong>' +
          '<span class="wall-crisis-number">14416</span>' +
          '<span class="wall-crisis-alt">or 1800-89-14416</span>' +
          '<span class="wall-crisis-hours">24×7 · 20 languages</span>' +
        '</div>' +
        '<div class="wall-crisis-helpline">' +
          '<strong>Vandrevala Foundation</strong>' +
          '<span class="wall-crisis-number">1860-266-2345</span>' +
          '<span class="wall-crisis-hours">24×7</span>' +
        '</div>' +
        '<div class="wall-crisis-helpline">' +
          '<strong>AASRA</strong>' +
          '<span class="wall-crisis-number">+91 98204 66726</span>' +
          '<span class="wall-crisis-hours">24×7</span>' +
        '</div>' +
        '<div class="wall-crisis-helpline">' +
          '<strong>iCall (TISS)</strong>' +
          '<span class="wall-crisis-number">022-2552 1111</span>' +
          '<span class="wall-crisis-hours">Mon–Sat, 8am–10pm</span>' +
        '</div>' +
      '</div>' +
      '<button class="btn-ghost" style="margin-top:16px;" onclick="renderWall()">Back to the wall</button>' +
    '</div>';
  go('s-wall-crisis');
}

function showSilentMine() {
  document.getElementById('s-silent-mine').innerHTML = `
    <div class="silent-header">
      <button class="silent-back-btn" onclick="showSilentFeed()">←</button>
      <div class="silent-logo">Your lines</div>
      <div style="width:40px"></div>
    </div>
    <div class="silent-mine-sub">Your last 7 days. They will disappear naturally.</div>
    <div class="silent-mine-list" id="silentMineList">
      <div class="silent-spinner">· · ·</div>
    </div>
  `;
  go('s-silent-mine');

  api('GET', '/silent/mine').then(function(data) {
    var list = document.getElementById('silentMineList');
    if (!list) return;
    var lines = data.lines || [];
    if (!lines.length) {
      list.innerHTML = `
        <div class="silent-empty">Nothing here yet.<br>
        <button class="silent-ghost-link" style="margin-top:14px" onclick="showSilentWrite()">Write your first quiet line →</button></div>
      `;
      return;
    }
    list.innerHTML = lines.map(function(l) {
      var isPending = l.status === 'pending';
      return `
        <div class="silent-mine-item" data-id="${escapeHtml(l.id)}">
          <p class="silent-mine-text">${escapeHtml(l.content)}</p>
          ${isPending ? '<div class="silent-pending-note">Being read by a moderator.</div>' : ''}
          <button class="silent-delete-btn" onclick="deleteSilentLine('${escapeHtml(l.id)}', this)">Delete</button>
        </div>
      `;
    }).join('');
  }).catch(function() {
    var list = document.getElementById('silentMineList');
    if (list) list.innerHTML = '<div class="silent-empty">Couldn\'t load your lines.</div>';
  });
}

async function deleteSilentLine(id, btn) {
  if (!confirm('Delete this line?')) return;
  btn.disabled = true;
  try {
    var res = await fetch('/api/silent/' + encodeURIComponent(id), {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error('Delete failed');
    var item = btn.closest('.silent-mine-item');
    if (item) {
      item.style.opacity = '0';
      item.style.transition = 'opacity 0.3s';
      setTimeout(function() { item.remove(); }, 300);
    }
    toast('Deleted.');
  } catch (e) {
    btn.disabled = false;
    toast('Couldn\'t delete. Try again.');
  }
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

