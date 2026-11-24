const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function block(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return app.slice(from, to);
}
const scanCode = block('function startScan() {', 'function renderScan() {') +
  block('function trackScanCompleted() {', 'function renderArchetypeReveal(matched) {');

async function run() {
  const events = [];
  const requests = [];
  const messages = [];
  const age = { checked: false, focus() {} };
  const context = vm.createContext({
    state: null, questions: [{}, {}], scanAnswers: [], scanIndex: 0,
    mpTestStartedFired: false, mpTestCompletedFired: false,
    localScores: {}, localArchetype: 'unused',
    document: { getElementById: () => age },
    mpTrack: name => events.push(name),
    api: async (...args) => { requests.push(args); return { matched: false }; },
    toast: message => messages.push(message),
    clearPendingScan() {}, renderScan() {}, go() {},
    calculateScoresLocal() {}, savePendingScan: () => true,
    renderScanPartial() {}, loadState: async () => {},
    renderArchetypeReveal() {}
  });
  vm.runInContext(scanCode, context);
  context.startScan();
  assert.equal(events.length, 0, 'age gate failures do not count as scan starts');
  age.checked = true;
  context.startScan();
  assert.deepEqual(events, ['TestStarted']);
  assert.equal(context.scanAnswers.length, 2);
  await context.submitScan();
  assert.deepEqual(events, ['TestStarted'], 'unanswered scans cannot complete');
  context.scanAnswers = [4, 5];
  context.savePendingScan = () => false;
  await context.submitScan();
  assert.deepEqual(events, ['TestStarted'], 'failed guest storage does not count completion');
  context.savePendingScan = () => true;
  await context.submitScan();
  await context.submitScan();
  assert.deepEqual(events, ['TestStarted', 'TestCompleted'], 'repeat submissions count one completion per attempt');

  context.state = { user: { id: 1 } };
  context.startScan();
  assert.equal(requests.at(-1)[1], '/scan/start', 'signed-in scan starts still reach the app API');
  context.scanAnswers = [4, 5];
  context.api = async () => { throw Error('save failed'); };
  await context.submitScan();
  assert.equal(events.filter(e => e === 'TestCompleted').length, 1, 'failed server saves do not count completion');
  context.api = async () => ({ matched: false });
  await context.submitScan();
  await context.submitScan();
  assert.equal(events.filter(e => e === 'TestCompleted').length, 2, 'successful retake gets exactly one completion');

  const hooks = [];
  const goCode = block('function go(id) {', 'function openAuthScreen(id) {');
  const screen = { classList: { add() {}, remove() {}, contains: () => false }, querySelector: () => ({ appendChild() {} }) };
  const goContext = vm.createContext({
    window: { mpGaTrack: name => hooks.push(name), scrollTo() {} },
    document: { querySelector: () => null, getElementById: id => id.startsWith('s-') ? screen : null, createElement: () => ({}) },
    state: null, matchPollTimer: null, clearInterval() {},
    syncAetherBackground() {}, renderSharedReflectionInvite() {},
    setSiteNavCurrent() {}, setMotionMode() {}, modeForScreen() {}, afterRenderMotion() {}
  });
  vm.runInContext(goCode, goContext);
  goContext.go('s-signup');
  goContext.go('s-ob4');
  goContext.go('s-login');
  assert.deepEqual(hooks, ['signup_started', 'signup_started'], 'signup screens use one event name; login is excluded');

  // Execute each real writing path: validation and failed saves cannot become conversions.
  for (const [name, end, endpoint] of [
    ['saveReturnWrite', '// ═', '/waiting-entry'],
    ['sealTonightsEntry', 'function renderTQSealed(', '/tonights-question'],
    ['sealEntry', 'function startCountdown(', '/entry']
  ]) {
    const emitted = [];
    const calls = [];
    const area = { value: 'A test note', disabled: false };
    const scope = vm.createContext({
      window: { mpGaTrack: (...args) => emitted.push(args) },
      document: { getElementById: () => area },
      state: { waitingInfo: {} }, tqMood: 'moon', currentMood: 'moon', selectedPrompt: null, tqData: {},
      api: async (...args) => { calls.push(args); throw Error('Save failed'); },
      detectClientPii: () => false, confirm: () => true,
      sessionStorage: { removeItem() {} }, toast() {}, showSafety() {},
      loadState: async () => {}, loadTonightsQuestion: async () => {}, renderTQSealed() {},
      maybeShowNotificationNudge() {}, celebrateStreak() {}, renderSealed() {}, go() {}
    });
    vm.runInContext(block('async function ' + name + '() {', end), scope);
    await scope[name]();
    assert.equal(calls[0][1], endpoint);
    assert.equal(emitted.length, 0, name + ': failed saves do not count');
    scope.api = async () => ({ ok: true });
    await scope[name]();
    assert.equal(emitted.length, 1, name + ': a saved note counts');
    assert.deepEqual(Array.from(emitted[0]), ['note_written'], 'no text, mood, identity or prompt enters analytics');
    area.value = '';
    await scope[name]();
    assert.equal(emitted.length, 1, name + ': empty notes do not count');
  }

  const unsealScope = vm.createContext({ Date });
  vm.runInContext(block('function formatUnsealAt(', 'function renderSealed()'), unsealScope);
  assert.equal(unsealScope.formatUnsealAt('invalid'), 'midnight');
  const unlock = '2026-11-24T05:00:00Z';
  assert.equal(unsealScope.formatUnsealAt(unlock), new Date(unlock).toLocaleString(undefined, {
    hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric', timeZoneName: 'short'
  }), 'unlock display uses the visitor clock without changing the server unlock instant');
  console.log('App scan start, save failure, retake and signup-screen checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
