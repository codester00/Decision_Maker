import { createStore, isDemo } from './store.js';
import {
  METHODS, METHOD_ORDER, BALLOT_METHODS, RuleError, settingsOf, minOptions, pointsEach,
  normalizeGame, startPlay, currentPlayer, eliminate, spin, applyBallot, resolveBallots, breakTie,
  resetToOptions, resetToLobby, ballotRound, openMatches,
} from './methods.js';
import {
  CATEGORIES, RADII, unitLabel, formatDistance, searchPlaces, geocode, locateMe, moviesEnabled, nowPlaying,
} from './places.js';

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast-root');

/* =====================================================================
   DOM helpers
   h() builds elements safely (user text is never parsed as HTML).
   render() patches the new tree into the old one so that inputs keep
   focus and typed text while other phones' changes stream in.
   ===================================================================== */

const EVENTS = ['click', 'submit', 'input', 'change', 'keydown'];

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el['on' + k.slice(2).toLowerCase()] = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = true;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const keyOf = (n) => (n.nodeType === 1 ? n.id || n.dataset.key || null : null);
const sameKind = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

function patch(oldEl, newEl) {
  if (oldEl.nodeType === 3) {
    if (oldEl.data !== newEl.data) oldEl.data = newEl.data;
    return;
  }
  for (const { name } of [...oldEl.attributes]) if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  for (const { name, value } of [...newEl.attributes]) if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  for (const ev of EVENTS) oldEl['on' + ev] = newEl['on' + ev];
  if ('disabled' in newEl) oldEl.disabled = newEl.disabled;
  if (newEl.tagName === 'INPUT') {
    if (newEl.type === 'checkbox') oldEl.checked = newEl.checked;
    return; // keep whatever the user has typed
  }
  if (newEl.tagName === 'TEXTAREA') return;
  patchChildren(oldEl, [...newEl.childNodes]);
}

function patchChildren(parent, newKids) {
  const oldKids = [...parent.childNodes];
  const keyed = new Map();
  for (const k of oldKids) { const key = keyOf(k); if (key) keyed.set(key, k); }
  const used = new Set();
  let oi = 0;
  const result = newKids.map((nk) => {
    let match = null;
    const key = keyOf(nk);
    if (key) match = keyed.get(key) || null;
    else {
      while (oi < oldKids.length && (keyOf(oldKids[oi]) || used.has(oldKids[oi]))) oi++;
      if (oi < oldKids.length) match = oldKids[oi++];
    }
    if (match && !used.has(match) && sameKind(match, nk)) {
      used.add(match);
      patch(match, nk);
      return match;
    }
    return nk;
  });
  for (const k of oldKids) if (!used.has(k)) k.remove();
  result.forEach((node, i) => {
    if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null);
  });
}

/* =====================================================================
   Small utilities
   ===================================================================== */

class UserError extends Error {}
class CodeTaken extends Error {}
class GameInProgress extends Error {
  constructor(code) { super('A game is already in progress.'); this.code = code; }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I confusion
function randomCode(n) {
  const a = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(a, (x) => ALPHABET[x % ALPHABET.length]).join('');
}
const uid = () => randomCode(12);
const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function listJoin(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function nameError(name, existing) {
  if (!name) return 'Enter a name.';
  if (name.length > 30) return 'Keep names under 30 characters.';
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) return `${name} is already in the list.`;
  return null;
}

// Demo mode keeps its own settings so it never mixes with the real family.
const PREF = isDemo ? 'fdm:pref:demo:' : 'fdm:pref:';
const prefs = {
  get(k, d = null) {
    try { const v = localStorage.getItem(PREF + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(PREF + k);
      else localStorage.setItem(PREF + k, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

// Identifies this phone. In demo mode it is per tab, so tabs act as separate phones.
function getClientId(mode) {
  const storage = mode === 'local' ? sessionStorage : localStorage;
  try {
    let id = storage.getItem('fdm:client');
    if (!id) { id = uid(); storage.setItem('fdm:client', id); }
    return id;
  } catch {
    return uid();
  }
}

async function run(fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    if (!(e instanceof UserError)) console.error(e);
    toast(e instanceof UserError ? e.message : 'Something went wrong. Check your internet connection and try again.');
    return false;
  }
}

/* =====================================================================
   Dialogs and toasts
   ===================================================================== */

function openModal(build) {
  return new Promise((resolve) => {
    let overlay;
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    function close(val) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    overlay = h('div', { class: 'overlay', onClick: (e) => { if (e.target === overlay) close(undefined); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, build(close)));
    document.addEventListener('keydown', onKey);
    $modal.append(overlay);
    const first = overlay.querySelector('input') || overlay.querySelector('.btn.primary');
    if (first) first.focus();
  });
}

function confirmDialog({ title, message, ok = 'OK', danger = false }) {
  return openModal((close) => [
    h('h2', {}, title),
    message && h('p', {}, message),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn text', onClick: () => close(false) }, 'Cancel'),
      h('button', { class: danger ? 'btn danger' : 'btn primary', onClick: () => close(true) }, ok)),
  ]).then((v) => !!v);
}

function choiceDialog({ title, message, choices }) {
  return openModal((close) => [
    h('h2', {}, title),
    message && h('p', {}, message),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn text', onClick: () => close(null) }, 'Cancel'),
      choices.map((c) => h('button', { class: c.primary ? 'btn primary' : 'btn', onClick: () => close(c.value) }, c.label))),
  ]);
}

function promptDialog({ title, message, value = '', placeholder = 'Name', ok = 'Save', validate = () => null }) {
  return openModal((close) => {
    const input = h('input', { class: 'input', value, placeholder, maxlength: 30, autocomplete: 'off' });
    const err = h('div', { class: 'error-text' });
    const submit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      const msg = validate(v);
      if (msg) { err.textContent = msg; input.focus(); return; }
      close(v);
    };
    return h('form', { onSubmit: submit },
      h('h2', {}, title),
      message && h('p', { class: 'muted' }, message),
      input, err,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn text', onClick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, ok)));
  }).then((v) => v ?? null);
}

let toastTimer;
function toast(message, { action, onAction, ms = 5000 } = {}) {
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', role: 'status' },
    h('span', {}, message),
    action && h('button', { class: 'btn text', onClick: () => { el.remove(); onAction(); } }, action));
  const bar = document.getElementById('bottombar');
  $toast.style.bottom = (bar ? bar.offsetHeight + 12 : 16) + 'px';
  $toast.replaceChildren(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}

async function shareLink(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Paste it into a message.');
  } catch {
    openModal((close) => [h('h2', {}, 'Share this link'), h('p', { class: 'link-box' }, url),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', onClick: () => close() }, 'Done'))]);
  }
}

const appUrl = () => location.origin + location.pathname;
const inviteUrl = (code) => `${appUrl()}#/join/${code}`;
const gameUrl = (code) => `${appUrl()}#/game/${code}`;

/* =====================================================================
   State, routing and subscriptions
   ===================================================================== */

const S = {
  store: null,
  storeError: null,
  clientId: null,
  familyCode: prefs.get('familyCode'),
  family: undefined, // undefined = loading, null = not found
  game: undefined,
  route: parseRoute(),
  mode: 'normal', // normal | delete | edit
  draftNames: [],
  myOptionIds: new Set(), // options this phone added; kept only on this phone (sessionStorage)
  elimSnap: null, // Elimination: the option list as of this phone's last turn
  elimPending: null, // Elimination: option this phone just knocked out (hidden right away)
  playFor: null, // Elimination: host chose to play a stuck player's turn
  showAddPlayer: null, // game code where the "add another player" form is open
  finder: null, // Find nearby panel state (options phase)
  ballotFor: null, // which of this phone's players is filling in a ballot
  draft: null, // the ballot being filled in (local until submitted)
  reveal: null, // ranked-choice round reveal progress
  spinWatch: null, spinAnim: null, spinDone: null, // random-pick animation
  inApp: false,
};

function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'stats') return { name: 'stats' };
  if (p[0] === 'game' && p[1]) return { name: 'game', code: normCode(p[1]) };
  if (p[0] === 'join' && p[1]) return { name: 'joinFamily', code: normCode(p[1]) };
  return { name: 'home' };
}

function navigate(hash) {
  S.inApp = true;
  location.hash = hash;
}

function goBack() {
  if (S.inApp) history.back();
  else location.replace('#/');
}

window.addEventListener('hashchange', () => {
  S.route = parseRoute();
  S.mode = 'normal';
  $modal.replaceChildren();
  if (S.route.name === 'joinFamily' && S.route.code === S.familyCode) location.replace('#/');
  syncSubscriptions();
  render();
});

let famSub = { code: null, off: null };
let gameSub = { code: null, off: null };

function onSubError(err) {
  toast(err && err.code === 'permission-denied'
    ? 'The server refused access. Check the Firebase setup (see README).'
    : 'Lost connection to the server.');
}

function syncSubscriptions() {
  if (!S.store) return;

  if (famSub.code !== S.familyCode) {
    if (famSub.off) famSub.off();
    famSub = { code: S.familyCode, off: null };
    S.family = undefined;
    if (S.familyCode) {
      famSub.off = S.store.watch('families', S.familyCode, (d) => { S.family = d; render(); }, onSubError);
    }
  }

  const gc = S.route.name === 'game' ? S.route.code : null;
  if (gameSub.code !== gc) {
    if (gameSub.off) gameSub.off();
    gameSub = { code: gc, off: null };
    S.game = undefined;
    S.myOptionIds = new Set(loadMyOptions(gc));
    S.elimSnap = null;
    if (gc) {
      gameSub.off = S.store.watch('games', gc, (d) => {
        const prev = S.game;
        S.game = normalizeGame(d);
        if (d === null && S.family && S.family.activeGame === gc) {
          run(() => updateFamily((f) => { if (f.activeGame === gc) f.activeGame = null; }));
        }
        const needKey = (x) => x && `${x.phase}:${x.method}:${x.turn}:${x.bracket ? x.bracket.round : ''}`;
        if (needsMe(S.game) && !(needsMe(prev) && needKey(prev) === needKey(S.game))) {
          if (navigator.vibrate) navigator.vibrate(200);
        }
        render();
      }, onSubError);
    }
  }
}

function loadMyOptions(code) {
  try { return code ? JSON.parse(sessionStorage.getItem('fdm:myopts:' + code) || '[]') : []; } catch { return []; }
}

function rememberMyOption(id) {
  S.myOptionIds.add(id);
  try { sessionStorage.setItem('fdm:myopts:' + S.route.code, JSON.stringify([...S.myOptionIds])); } catch { /* ignore */ }
}

function setFamily(code) {
  prefs.set('familyCode', code);
  S.familyCode = code;
  S.mode = 'normal';
  syncSubscriptions();
  if (location.hash === '' || location.hash === '#/') render();
  else location.replace('#/');
}

/* =====================================================================
   Family actions (all run as atomic transactions)
   ===================================================================== */

function updateFamily(fn) {
  return S.store.update('families', S.familyCode, (cur) => {
    if (!cur) throw new UserError('This family no longer exists.');
    const f = structuredClone(cur);
    fn(f);
    return f;
  });
}

const newMember = (name) => ({ id: uid(), name, decisions: 0, positions: {} });

async function createFamily(names) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    try {
      await S.store.update('families', code, (cur) => {
        if (cur) throw new CodeTaken();
        return { members: names.map(newMember), activeGame: null, createdAt: Date.now() };
      });
      S.draftNames = [];
      setFamily(code);
      return;
    } catch (e) {
      if (!(e instanceof CodeTaken)) throw e;
    }
  }
  throw new UserError('Could not create a family code. Please try again.');
}

async function joinFamily(code) {
  const f = await S.store.get('families', code);
  if (!f) throw new UserError(`No family found with code ${code}.`);
  setFamily(code);
  toast('Joined the family.');
}

function leaveFamily() {
  prefs.set('familyCode', null);
  S.familyCode = null;
  syncSubscriptions();
  render();
}

function addMember(name) {
  return updateFamily((f) => {
    const err = nameError(name, f.members.map((m) => m.name));
    if (err) throw new UserError(err);
    f.members.push(newMember(name));
  });
}

function renameMember(id, name) {
  return updateFamily((f) => {
    const m = f.members.find((x) => x.id === id);
    if (!m) throw new UserError('That person was removed on another phone.');
    const err = nameError(name, f.members.filter((x) => x.id !== id).map((x) => x.name));
    if (err) throw new UserError(err);
    m.name = name;
  });
}

function removeMember(id) {
  return updateFamily((f) => { f.members = f.members.filter((m) => m.id !== id); });
}

async function decide(id) {
  let info = null;
  await updateFamily((f) => {
    const i = f.members.findIndex((m) => m.id === id);
    if (i < 0) throw new UserError('That person was removed on another phone.');
    const [m] = f.members.splice(i, 1);
    m.decisions = (m.decisions || 0) + 1;
    m.positions = m.positions || {};
    m.positions[i + 1] = (m.positions[i + 1] || 0) + 1;
    f.members.push(m);
    info = { id, from: i, name: m.name };
  });
  toast(`${info.name} made the decision.`, { action: 'Undo', onAction: () => run(() => undoDecide(info)) });
}

function resetStats() {
  return updateFamily((f) => {
    for (const m of f.members) { m.decisions = 0; m.positions = {}; }
  });
}

function undoDecide({ id, from }) {
  return updateFamily((f) => {
    const i = f.members.findIndex((m) => m.id === id);
    if (i < 0) throw new UserError('Too late to undo.');
    const [m] = f.members.splice(i, 1);
    m.decisions = Math.max(0, (m.decisions || 0) - 1);
    const k = String(from + 1);
    if (m.positions && m.positions[k]) {
      m.positions[k]--;
      if (!m.positions[k]) delete m.positions[k];
    }
    f.members.splice(Math.min(from, f.members.length), 0, m);
  });
}

/* =====================================================================
   Group decision ("game") actions
   A game lives in its own document. It never touches the priority list
   or statistics, stores no record of who suggested, eliminated or voted
   for what, and is deleted when the host ends it. The rules for each
   method live in methods.js.
   ===================================================================== */

function updateGame(fn) {
  return S.store.update('games', S.route.code, (cur) => {
    if (!cur) throw new UserError('This game has ended.');
    const g = normalizeGame(structuredClone(cur));
    try {
      return fn(g) === null ? null : g;
    } catch (e) {
      if (e instanceof RuleError) throw new UserError(e.message);
      throw e;
    }
  });
}

const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const playerById = (g, id) => g.players.find((p) => p.id === id);
const isMine = (g, pid) => playerById(g, pid)?.device === S.clientId;
const myVoters = (g) => g.players.filter((p) => p.device === S.clientId && !(g.voted || []).includes(p.id));

// Does this phone need to do something right now? (Used to buzz the phone.)
function needsMe(g) {
  if (!g) return false;
  if (g.phase === 'play' && g.method === 'elimination') return currentPlayer(g)?.device === S.clientId;
  if (g.phase === 'play' && BALLOT_METHODS.has(g.method)) return myVoters(g).length > 0;
  if (g.phase === 'tiebreak') return isMine(g, g.tie.decider);
  return false;
}

async function createGameDoc() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    try {
      await S.store.update('games', code, (cur) => {
        if (cur) throw new CodeTaken();
        return {
          host: S.clientId,
          family: S.familyCode || null,
          phase: 'lobby',
          method: 'elimination',
          settings: {},
          players: [],
          options: [],
          familyNames: S.family ? S.family.members.map((m) => m.name) : [],
          crown: S.family && S.family.members[0] ? S.family.members[0].name : null,
          createdAt: Date.now(),
        };
      });
      return code;
    } catch (e) {
      if (!(e instanceof CodeTaken)) throw e;
    }
  }
  throw new UserError('Could not create a game code. Please try again.');
}

// Only one game per family can run at a time. `expected` is the family's
// active game as this phone last saw it (null if none, or the code of a game
// the user chose to replace). The claim on the family document is atomic, so
// if two phones start a game at the same moment only one wins; the other is
// told a game is already in progress.
async function createGame(expected) {
  const code = await createGameDoc();
  try {
    await updateFamily((f) => {
      const cur = f.activeGame || null;
      if (cur !== expected) throw new GameInProgress(cur);
      f.activeGame = code;
    });
  } catch (e) {
    await S.store.update('games', code, () => null).catch(() => {});
    throw e;
  }
  // End the replaced game so nobody is left playing in it.
  if (expected) await S.store.update('games', expected, () => null).catch(() => {});
  navigate('#/game/' + code);
}

function takeOverHost() {
  return updateGame((g) => { g.host = S.clientId; });
}

function requireHost(g) {
  if (g.host !== S.clientId) throw new UserError('Only the host can do that.');
}

// Players can join at any point. Mid-Elimination they go to the end of the
// turn order; mid-vote they vote in the current round.
function addPlayer(name) {
  return updateGame((g) => {
    const err = nameError(name, g.players.map((p) => p.name));
    if (err) throw new UserError(err);
    const id = uid();
    g.players.push({ id, name, device: S.clientId });
    if (g.phase === 'play' && g.method === 'elimination') g.order.push(id);
  });
}

function removePlayer(id) {
  return updateGame((g) => {
    if (g.phase !== 'lobby' && g.phase !== 'options') throw new UserError('Players can only be removed before the decision starts.');
    g.players = g.players.filter((p) => p.id !== id);
  });
}

function toOptions() {
  return updateGame((g) => {
    requireHost(g);
    if (g.players.length < 2) throw new UserError('Need at least 2 players.');
    g.phase = 'options';
  });
}

function backToLobby() {
  return updateGame((g) => { requireHost(g); g.phase = 'lobby'; });
}

function addOption(id, text) {
  return updateGame((g) => {
    if (g.phase !== 'options') throw new UserError('Option entry is closed.');
    if (!text) throw new UserError('Type an option first.');
    if (text.length > 60) throw new UserError('Keep options under 60 characters.');
    if (g.options.some((o) => o.text.toLowerCase() === text.toLowerCase())) throw new UserError(`"${text}" is already an option.`);
    g.options.push({ id, text });
  });
}

function removeOption(id) {
  return updateGame((g) => {
    if (g.phase !== 'options') throw new UserError('Option entry is closed.');
    g.options = g.options.filter((o) => o.id !== id);
  });
}

function setMethod(method) {
  return updateGame((g) => {
    requireHost(g);
    if (g.phase !== 'options') throw new UserError('The decision has already started.');
    g.method = method;
  });
}

function setSetting(key, value) {
  return updateGame((g) => {
    requireHost(g);
    if (g.phase !== 'options') throw new UserError('The decision has already started.');
    g.settings = { ...g.settings, [key]: value };
  });
}

function startDeciding() {
  return updateGame((g) => {
    requireHost(g);
    if (g.phase !== 'options') throw new UserError('The decision has already started.');
    startPlay(g, rand);
  });
}

function eliminateAction(optionId, expectedTurn) {
  return updateGame((g) => {
    if (g.phase !== 'play' || g.method !== 'elimination' || g.turn !== expectedTurn) {
      throw new UserError('Someone else just played. Try again.');
    }
    const cur = currentPlayer(g);
    if (cur.device !== S.clientId && g.host !== S.clientId) throw new UserError(`It's ${cur.name}'s turn.`);
    eliminate(g, optionId, rand);
  });
}

function spinAction() {
  return updateGame((g) => {
    requireHost(g);
    if (g.phase !== 'play' || g.method !== 'random') throw new UserError('Already spun.');
    spin(g, rand);
  });
}

function submitBallot(playerId, ballot, round) {
  return updateGame((g) => {
    if (g.phase !== 'play' || ballotRound(g) !== round) throw new UserError('The vote moved on before yours arrived. Please vote again.');
    const p = playerById(g, playerId);
    if (!p || p.device !== S.clientId) throw new UserError('That player votes from another phone.');
    if (g.voted.includes(playerId)) throw new UserError(`${p.name} has already voted.`);
    applyBallot(g, ballot, rand);
    g.voted.push(playerId);
    if (g.voted.length >= g.players.length) resolveBallots(g, g.crown, rand);
  });
}

function closeVoting(round) {
  return updateGame((g) => {
    requireHost(g);
    if (g.phase !== 'play' || ballotRound(g) !== round) throw new UserError('The vote already moved on.');
    if (!g.voted.length) throw new UserError('Nobody has voted yet.');
    resolveBallots(g, g.crown, rand);
  });
}

function breakTieAction(optionId) {
  return updateGame((g) => {
    if (g.phase !== 'tiebreak') throw new UserError('The tie was already broken.');
    if (!isMine(g, g.tie.decider) && g.host !== S.clientId) throw new UserError('Someone else breaks this tie.');
    breakTie(g, optionId);
  });
}

function refreshFamilyInfo(g) {
  if (S.family && g.family === S.familyCode) {
    g.familyNames = S.family.members.map((m) => m.name);
    g.crown = S.family.members[0] ? S.family.members[0].name : null;
  }
}

function decideAgain() {
  return updateGame((g) => { requireHost(g); resetToOptions(g); refreshFamilyInfo(g); });
}

function startOver() {
  return updateGame((g) => { requireHost(g); resetToLobby(g); refreshFamilyInfo(g); });
}

async function endGame() {
  const code = S.route.code;
  await updateGame(() => null);
  if (S.family && S.family.activeGame === code) {
    await updateFamily((f) => { if (f.activeGame === code) f.activeGame = null; });
  }
  goBack();
}

/* =====================================================================
   UI event handlers
   ===================================================================== */

async function onMemberTap(id) {
  const members = S.family.members;
  const index = members.findIndex((m) => m.id === id);
  if (index < 0) return;
  const m = members[index];

  if (S.mode === 'delete') {
    const ok = await confirmDialog({
      title: 'Remove person',
      message: `Remove ${m.name}? Their statistics will be deleted too.`,
      ok: 'Remove',
      danger: true,
    });
    if (ok) run(() => removeMember(id));
  } else if (S.mode === 'edit') {
    const name = await promptDialog({
      title: 'Edit name',
      value: m.name,
      validate: (n) => nameError(n, S.family.members.filter((x) => x.id !== id).map((x) => x.name)),
    });
    if (name && name !== m.name) run(() => renameMember(id, name));
  } else if (index === 0) {
    run(() => decide(id));
  } else {
    const above = members.slice(0, index).map((x) => x.name);
    const ok = await confirmDialog({
      title: 'Confirm decision',
      message: `${listJoin(above)} deferred their turn. ${m.name} decides?`,
      ok: 'Confirm',
    });
    if (ok) run(() => decide(id));
  }
}

async function addMemberDialog() {
  const name = await promptDialog({
    title: 'Add family member',
    ok: 'Add',
    validate: (n) => nameError(n, S.family.members.map((m) => m.name)),
  });
  if (name) run(() => addMember(name));
}

function setMode(mode) {
  S.mode = mode;
  render();
}

async function openGame(known = S.family.activeGame || null) {
  let expected = known;
  if (expected) {
    let existing = null;
    try { existing = await S.store.get('games', expected); } catch { existing = null; }
    if (existing) {
      const choice = await choiceDialog({
        title: 'A game is already in progress',
        message: 'Only one game can run at a time. Join it, or end it for everyone and start a new one?',
        choices: [
          { label: 'End it & start new', value: 'new' },
          { label: 'Join', value: 'join', primary: true },
        ],
      });
      if (choice === 'join') { navigate('#/game/' + expected); return; }
      if (choice !== 'new') return;
    }
    // If the game no longer exists, `expected` is a stale pointer that we replace.
  }
  try {
    await createGame(expected);
  } catch (e) {
    if (e instanceof GameInProgress) {
      // Someone else started a game a moment ago; ask again with the fresh info.
      openGame(e.code);
      return;
    }
    if (!(e instanceof UserError)) console.error(e);
    toast(e instanceof UserError ? e.message : 'Something went wrong. Check your internet connection and try again.');
  }
}

async function onTakeOver() {
  const ok = await confirmDialog({
    title: 'Take over as host?',
    message: "Use this if the host's phone is stuck or gone. Your phone will control the game from now on.",
    ok: 'Take over',
  });
  if (ok) run(takeOverHost);
}

async function onResetStats() {
  const ok = await confirmDialog({
    title: 'Reset all statistics?',
    message: "Every person's decision count goes back to zero on all phones. The order of the list stays the same. This can't be undone.",
    ok: 'Reset',
    danger: true,
  });
  if (ok && await run(resetStats)) toast('Statistics reset.');
}

async function onCloseVoting(round) {
  const ok = await confirmDialog({
    title: 'Close voting now?',
    message: "Anyone who hasn't voted yet won't be counted.",
    ok: 'Close voting',
  });
  if (ok) run(() => closeVoting(round));
}

async function onBreakTie(id) {
  const g = S.game;
  const decider = playerById(g, g.tie.decider);
  const ok = await confirmDialog({
    title: `Pick "${optName(g, id)}"?`,
    message: isMine(g, g.tie.decider) ? null : `You're breaking the tie for ${decider ? decider.name : 'the 👑'}.`,
    ok: 'Pick it',
  });
  if (ok) run(() => breakTieAction(id));
}

async function onEliminate(option, turn) {
  const g = S.game;
  const cur = currentPlayer(g);
  const forOther = cur.device !== S.clientId;
  const ok = await confirmDialog({
    title: `Eliminate "${option.text}"?`,
    message: forOther ? `You're playing this turn for ${cur.name}.` : null,
    ok: 'Eliminate',
    danger: true,
  });
  if (!ok) return;
  // Hide it on this phone straight away, and keep this phone's list frozen
  // as it stands after this elimination until its next turn.
  const snapKey = S.elimSnap && S.elimSnap.key;
  S.elimPending = { key: snapKey, id: option.id };
  const done = await run(() => eliminateAction(option.id, turn));
  if (done && S.elimSnap && S.elimSnap.key === snapKey) S.elimSnap.ids = S.elimSnap.ids.filter((id) => id !== option.id);
  S.elimPending = null;
  render();
}

async function onPlayFor(turnKey, player) {
  const ok = await confirmDialog({
    title: `Play this turn for ${player.name}?`,
    message: `This shows you the current list. Only do it if ${player.name} is stuck.`,
    ok: 'Play for them',
  });
  if (ok) { S.playFor = turnKey; render(); }
}

function familyDialog() {
  const code = S.familyCode;
  openModal((close) => [
    h('h2', {}, 'Your family'),
    h('div', { class: 'muted small center' }, 'Family code'),
    h('div', { class: 'big-code' }, code),
    h('p', { class: 'muted small' }, S.store.mode === 'local'
      ? "Demo mode: other phones can't join until Firebase is set up (see README)."
      : 'On another phone, open this app and enter this code, or send them the invite link.'),
    h('div', { class: 'stack' },
      h('button', {
        class: 'btn primary',
        onClick: () => shareLink('Family Decision Maker', `Join our family in Family Decision Maker (code ${code})`, inviteUrl(code)),
      }, '📤 Share invite link'),
      h('button', {
        class: 'btn text',
        onClick: async () => {
          close();
          const ok = await confirmDialog({
            title: 'Leave family on this phone?',
            message: `This phone will stop showing the family. Nobody else is affected, and you can rejoin any time with code ${code}.`,
            ok: 'Leave',
          });
          if (ok) leaveFamily();
        },
      }, 'Leave family on this phone')),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', onClick: () => close() }, 'Close')),
  ]);
}

/* =====================================================================
   Views
   ===================================================================== */

function appBar(title, { back = false, actions = [] } = {}) {
  return h('header', { class: 'appbar' },
    back && h('button', { class: 'icon-btn', 'aria-label': 'Back', onClick: goBack }, '←'),
    h('h1', {}, title),
    actions);
}

function demoBanner() {
  if (!S.store || S.store.mode !== 'local') return null;
  return h('div', { class: 'banner demo', id: 'demo-banner' },
    h('span', {}, '🧪'),
    h('span', { class: 'grow small' },
      h('strong', {}, 'Demo mode. '),
      "Nothing here touches your real family data; it stays in this browser. Open a second tab to act as another phone."));
}

function loadingView(key = 'loading') {
  return h('div', { class: 'screen', 'data-key': key },
    h('div', { class: 'center-fill' }, h('div', { class: 'spinner', 'aria-label': 'Loading' })));
}

function messageView(key, title, message, buttonLabel, onClick) {
  return h('div', { class: 'screen', 'data-key': key },
    appBar('Family Decision Maker'),
    h('main', { class: 'content' },
      h('section', { class: 'card' },
        h('h2', {}, title),
        h('p', { class: 'muted' }, message),
        buttonLabel && h('button', { class: 'btn primary', onClick }, buttonLabel))));
}

function codeForm(id, label, onCode) {
  return h('form', {
    class: 'row',
    onSubmit: (e) => {
      e.preventDefault();
      const c = normCode(document.getElementById(id).value);
      if (c.length < 4) { toast('Enter the code.'); return; }
      run(() => onCode(c));
    },
  },
  h('input', { id, class: 'input code-input', placeholder: 'Code', maxlength: 8, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Code' }),
  h('button', { class: 'btn', type: 'submit' }, label));
}

function welcomeView() {
  const names = S.draftNames;
  const addDraft = (e) => {
    e.preventDefault();
    const input = document.getElementById('new-name');
    const n = input.value.trim();
    const err = nameError(n, names);
    if (err) { toast(err); return; }
    names.push(n);
    input.value = '';
    render();
    input.focus();
  };

  return h('div', { class: 'screen', 'data-key': 'welcome' },
    appBar('Family Decision Maker'),
    h('main', { class: 'content' },
      demoBanner(),
      h('p', { class: 'muted' }, "The decision making methods our family finds most useful, on everyone's phone."),

      h('section', { class: 'card' },
        h('h2', {}, 'Start a new family'),
        h('p', { class: 'muted small' }, "Who's in your family? Add everyone in the order you want them to take turns deciding."),
        h('form', { class: 'row', onSubmit: addDraft },
          h('input', { id: 'new-name', class: 'input', placeholder: 'Name', maxlength: 30, autocomplete: 'off', 'aria-label': 'Name' }),
          h('button', { class: 'btn', type: 'submit' }, 'Add')),
        names.length > 0 && h('ol', { class: 'chips', id: 'draft-names' },
          names.map((n, i) => h('li', { class: 'chip', 'data-key': 'd-' + n },
            `${i + 1}. ${n}`,
            h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${n}`, onClick: () => { names.splice(i, 1); render(); } }, '×')))),
        h('button', {
          class: 'btn primary block',
          id: 'create-family',
          disabled: names.length === 0,
          onClick: () => run(() => createFamily([...names])),
        }, names.length ? `Create family (${names.length})` : 'Create family')),

      h('section', { class: 'card' },
        h('h2', {}, 'Join your family'),
        h('p', { class: 'muted small' }, 'Already set up on another phone? Enter the family code shown there under 👪.'),
        codeForm('join-family-code', 'Join', joinFamily)),

      h('section', { class: 'card' },
        h('h2', {}, 'Join a game'),
        h('p', { class: 'muted small' }, "Joining someone's group decision? Enter the game code."),
        codeForm('join-game-code', 'Join game', (c) => navigate('#/game/' + c)))));
}

function joinInviteView() {
  const code = S.route.code;
  return h('div', { class: 'screen', 'data-key': 'invite' },
    appBar('Family Decision Maker'),
    h('main', { class: 'content' },
      h('section', { class: 'card' },
        h('h2', {}, "You've been invited to a family"),
        h('div', { class: 'big-code' }, code),
        S.familyCode && h('p', { class: 'muted small' }, `This phone is currently in family ${S.familyCode}. Joining will switch to the new family.`),
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn text', onClick: () => location.replace('#/') }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: () => run(() => joinFamily(code)) }, 'Join family')))));
}

function tool(icon, label, onClick, disabled = false) {
  return h('button', { class: 'tool', onClick, disabled, 'aria-label': label },
    h('span', { class: 'tool-icon' }, icon), h('span', {}, label));
}

function bottomBar() {
  if (S.mode !== 'normal') {
    const del = S.mode === 'delete';
    return h('footer', { class: 'bottombar', id: 'bottombar' },
      h('div', { class: `modebar ${S.mode}` },
        h('div', { class: 'grow' },
          h('strong', {}, del ? 'DELETE MODE' : 'EDIT MODE'),
          h('div', { class: 'muted small' }, del ? 'Tap a person to remove them' : 'Tap a person to rename them')),
        h('button', { class: 'btn primary', onClick: () => setMode('normal') }, 'Done')));
  }
  const empty = S.family.members.length === 0;
  return h('footer', { class: 'bottombar', id: 'bottombar' },
    h('div', { class: 'tools' },
      tool('➕', 'Add', addMemberDialog),
      tool('🗑️', 'Delete', () => setMode('delete'), empty),
      tool('✏️', 'Edit', () => setMode('edit'), empty)),
    h('button', { class: 'btn primary block big', onClick: openGame }, '🎲 Decide together'));
}

function homeView() {
  const f = S.family;
  const members = f.members;
  const mode = S.mode;

  return h('div', { class: `screen mode-${mode}`, 'data-key': 'home' },
    appBar('Who decides?', {
      actions: [
        h('button', { class: 'icon-btn', 'aria-label': 'Statistics', title: 'Statistics', onClick: () => navigate('#/stats') }, '📊'),
        h('button', { class: 'icon-btn', 'aria-label': 'Family and invite', title: 'Family and invite', onClick: familyDialog }, '👪'),
      ],
    }),
    h('main', { class: 'content' },
      demoBanner(),
      f.activeGame && mode === 'normal' && h('div', { class: 'banner', id: 'game-banner' },
        h('span', {}, '🎲'),
        h('span', { class: 'grow' }, 'A group decision is in progress.'),
        h('button', { class: 'btn primary', onClick: () => navigate('#/game/' + f.activeGame) }, 'Join')),
      members.length === 0
        ? h('section', { class: 'card center', id: 'empty' },
          h('div', { class: 'emoji-xl' }, '👪'),
          h('p', { class: 'muted' }, 'Nobody is in the list yet.'),
          h('button', { class: 'btn primary', onClick: addMemberDialog }, 'Add a person'))
        : [
          h('ol', { class: 'plist', id: 'plist' },
            members.map((m, i) => h('li', { 'data-key': 'm-' + m.id },
              h('button', { class: 'person' + (i === 0 ? ' first' : ''), onClick: () => onMemberTap(m.id) },
                h('span', { class: 'pos' }, i + 1),
                h('span', { class: 'name' }, m.name),
                i === 0 && h('span', { class: 'crown', title: 'Decides next' }, '👑'),
                mode !== 'normal' && h('span', { class: 'mode-icon' }, mode === 'delete' ? '🗑️' : '✏️'))))),
          mode === 'normal' && h('p', { class: 'muted small center hint', id: 'hint' },
            members.length > 1
              ? 'Tap the person who made a decision. They move to the bottom.'
              : 'Add more people with ➕.'),
        ]),
    bottomBar());
}

function statsView() {
  const members = S.family.members;
  const total = members.reduce((s, m) => s + (m.decisions || 0), 0);
  const max = Math.max(1, ...members.map((m) => m.decisions || 0));

  return h('div', { class: 'screen', 'data-key': 'stats' },
    appBar('Statistics', { back: true }),
    h('main', { class: 'content' },
      h('section', { class: 'card center' },
        h('div', { class: 'stat-total' }, total),
        h('div', { class: 'muted small' }, total === 1 ? 'decision made' : 'decisions made')),
      members.length === 0 && h('p', { class: 'muted center' }, 'No statistics yet.'),
      members.map((m) => {
        const entries = Object.entries(m.positions || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
        return h('section', { class: 'card', 'data-key': 's-' + m.id },
          h('div', { class: 'row' },
            h('h2', { class: 'grow' }, m.name),
            h('strong', {}, `${m.decisions || 0} ${m.decisions === 1 ? 'decision' : 'decisions'}`)),
          h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${((m.decisions || 0) / max) * 100}%` })),
          entries.length
            ? [h('div', { class: 'muted small' }, 'Position in the list when they decided:'),
              h('div', { class: 'chips' }, entries.map(([pos, n]) => h('span', { class: 'chip' }, `#${pos}: ${n}`)))]
            : h('div', { class: 'muted small' }, 'No decisions yet.'));
      }),
      members.length > 0 && h('button', {
        class: 'btn text block danger-text', id: 'reset-stats', disabled: total === 0, onClick: onResetStats,
      }, 'Reset statistics')));
}

/* ---------- Group decision views ---------- */

function gameView() {
  const code = S.route.code;
  const g = S.game;
  if (!S.store || g === undefined) return loadingView('game-loading');
  if (g === null) {
    const current = S.family && S.family.activeGame && S.family.activeGame !== code ? S.family.activeGame : null;
    return current
      ? messageView('game-ended', 'This game has ended',
        'The host ended this game or replaced it with a new one. Your family has another game in progress.',
        'Join the current game', () => location.replace('#/game/' + current))
      : messageView('game-ended', 'This game has ended',
        `There's no game with code ${code} any more. It may have been ended by the host.`,
        'Back to home', goBack);
  }
  const isHost = g.host === S.clientId;
  if (g.phase !== 'options' && S.finder) S.finder = null;
  const M = METHODS[g.method] || METHODS.elimination;
  const titles = { lobby: '🎲 Players', options: '🎲 Options', play: `${M.icon} ${M.label}`, tiebreak: '👑 Tie-break', winner: '🎉 Decision made!' };
  const phaseView = { lobby: lobbyPhase, options: optionsPhase, play: playPhase, tiebreak: tiebreakPhase, winner: winnerPhase }[g.phase];
  const body = phaseView ? phaseView(g, isHost) : h('p', { class: 'muted' }, 'This game was made by a newer version of the app. Refresh to update.');

  // Warn if this phone is in an old game while the family plays a different one.
  const current = S.family && g.family === S.familyCode && S.family.activeGame && S.family.activeGame !== code
    ? S.family.activeGame : null;
  const hasPlayerHere = g.players.some((p) => p.device === S.clientId);

  return h('div', { class: 'screen', 'data-key': `game-${code}-${g.phase}` },
    appBar(titles[g.phase] || '🎲', {
      back: true,
      actions: [h('span', { class: 'tag code-tag', title: 'Game code' }, code)],
    }),
    h('main', { class: 'content' },
      demoBanner(),
      current && h('div', { class: 'banner demo', id: 'other-game-banner' },
        h('span', {}, '⚠️'),
        h('span', { class: 'grow small' }, "This isn't your family's current game."),
        h('button', { class: 'btn primary', onClick: () => location.replace('#/game/' + current) }, 'Switch')),
      g.phase !== 'lobby' && !hasPlayerHere && addPlayerCard(g),
      body,
      g.phase !== 'lobby' && hasPlayerHere && (S.showAddPlayer === code
        ? addPlayerCard(g)
        : h('div', { class: 'center' }, h('button', {
          class: 'btn text small', id: 'show-add-player', onClick: () => { S.showAddPlayer = code; render(); },
        }, '+ Add another player on this phone'))),
      !isHost && hasPlayerHere && h('div', { class: 'center takeover' },
        h('button', { class: 'btn text small', id: 'take-over', onClick: onTakeOver }, "Host's phone stuck? Take over as host"))));
}

function addPlayerCard(g) {
  const taken = new Set(g.players.map((p) => p.name.toLowerCase()));
  const suggestions = (g.familyNames || []).filter((n) => !taken.has(n.toLowerCase()));
  const mine = g.players.filter((p) => p.device === S.clientId);
  const late = g.phase !== 'lobby';

  const submitName = (e) => {
    e.preventDefault();
    const input = document.getElementById('player-name');
    const n = input.value.trim();
    if (!n) return;
    run(() => addPlayer(n)).then((ok) => { if (ok) input.value = ''; });
  };

  let lateNote = null;
  if (g.phase === 'play' && g.method === 'elimination') lateNote = 'New players join at the end of the turn order.';
  else if (g.phase === 'play' && BALLOT_METHODS.has(g.method)) lateNote = 'New players vote in the current round.';
  else if (g.phase === 'tiebreak' || g.phase === 'winner') lateNote = 'New players join in from the next round.';

  return h('section', { class: 'card', id: 'add-player-card' },
    h('h2', {}, mine.length ? 'Add more players on this phone' : late ? 'Join in: who is playing on this phone?' : 'Who is playing on this phone?'),
    h('p', { class: 'muted small' }, 'Tap your name. If several people share this phone, add each of them. Each person can only play from one phone.'),
    lateNote && h('p', { class: 'muted small' }, lateNote),
    suggestions.length > 0 && h('div', { class: 'chips' },
      suggestions.map((n) => h('button', { class: 'chip', 'data-key': 's-' + n, onClick: () => run(() => addPlayer(n)) }, '+ ' + n))),
    h('form', { class: 'row', onSubmit: submitName },
      h('input', { id: 'player-name', class: 'input', placeholder: 'Another name', maxlength: 30, autocomplete: 'off', 'aria-label': 'Player name' }),
      h('button', { class: 'btn', type: 'submit' }, 'Add')));
}

function lobbyPhase(g, isHost) {
  const code = S.route.code;

  return [
    h('section', { class: 'card center', id: 'code-card' },
      h('div', { class: 'muted small' }, 'Game code'),
      h('div', { class: 'big-code' }, code),
      h('p', { class: 'muted small' }, 'Others join with this code, or from the banner on their home screen.'),
      h('button', { class: 'btn', onClick: () => shareLink('Decide together', `Join our group decision (code ${code})`, gameUrl(code)) }, '📤 Share game link')),

    h('section', { class: 'card', id: 'players-card' },
      h('h2', {}, `Players (${g.players.length})`),
      g.players.length === 0
        ? h('p', { class: 'muted small' }, 'No players yet.')
        : h('ul', { class: 'list' }, g.players.map((p) => h('li', { 'data-key': 'p-' + p.id },
          h('span', { class: 'grow' }, p.name),
          p.device === S.clientId && h('span', { class: 'tag' }, 'this phone'),
          p.device === g.host && p.device !== S.clientId && h('span', { class: 'tag muted-tag' }, "host's phone"),
          (p.device === S.clientId || isHost) && h('button', {
            class: 'icon-btn sm', 'aria-label': `Remove ${p.name}`, onClick: () => run(() => removePlayer(p.id)),
          }, '×'))))),

    addPlayerCard(g),

    isHost
      ? h('button', { class: 'btn primary block big', id: 'to-options', disabled: g.players.length < 2, onClick: () => run(toOptions) },
        g.players.length < 2 ? 'Need at least 2 players' : 'Next: add options →')
      : h('p', { class: 'center muted' }, 'Waiting for the host to continue…'),
  ];
}

function optionsPhase(g, isHost) {
  const submitOption = (e) => {
    e.preventDefault();
    const input = document.getElementById('option-input');
    const text = input.value.trim();
    if (!text) return;
    const id = uid();
    input.value = ''; // clear right away so the next option can be typed
    rememberMyOption(id); // before saving, so this phone shows it as soon as it arrives
    run(() => addOption(id, text)).then((ok) => { if (!ok && !input.value) input.value = text; });
  };
  if (S.finder && S.finder.code === S.route.code) return finderView(g);
  const need = minOptions(g);
  const M = METHODS[g.method];
  const show = settingsOf(g).showOptions;
  const visible = show ? g.options : g.options.filter((o) => S.myOptionIds.has(o.id));
  const hidden = g.options.length - visible.length;

  return [
    h('section', { class: 'card', id: 'option-entry' },
      h('p', { class: 'muted small' }, show
        ? "Everyone can add options from their own phone, as many as they like. Nobody can see who suggested what."
        : "Everyone can add options from their own phone, as many as they like. You only see your own until the decision starts, so nobody can tell who suggested what."),
      h('form', { class: 'row', onSubmit: submitOption },
        h('input', { id: 'option-input', class: 'input', placeholder: 'Add an option', maxlength: 60, autocomplete: 'off', 'aria-label': 'Option' }),
        h('button', { class: 'btn', type: 'submit' }, 'Add')),
      h('button', { class: 'btn block finder-btn', id: 'open-finder', onClick: openFinder }, '🔍 Find restaurants, activities & movies'),
      need === 0 && h('p', { class: 'muted small' }, 'Options aren’t needed when the wheel picks a person.')),

    h('section', { class: 'card', id: 'options-card' },
      h('h2', {}, `Options (${g.options.length})`),
      g.options.length === 0 && h('p', { class: 'muted small' }, 'No options yet.'),
      visible.length > 0 && h('ul', { class: 'list' }, visible.map((o) => h('li', { 'data-key': 'o-' + o.id },
        h('span', { class: 'grow' }, o.text),
        !show && h('span', { class: 'tag muted-tag' }, 'yours'),
        (S.myOptionIds.has(o.id) || (isHost && show)) && h('button', {
          class: 'icon-btn sm', 'aria-label': `Remove ${o.text}`, title: 'Remove', onClick: () => run(() => removeOption(o.id)),
        }, '×')))),
      hidden > 0 && h('p', { class: 'muted small', id: 'hidden-note' },
        `🙈 ${hidden} ${hidden === 1 ? 'option' : 'options'} from others ${hidden === 1 ? 'is' : 'are'} hidden until the decision starts.`),
      isHost && setting("Everyone's options while adding", segmented('showOptions', show, [[false, 'Hidden'], [true, 'Shown (you can remove any)']], false))),

    h('p', { class: 'muted small' }, 'Playing: ' + g.players.map((p) => p.name).join(', ')),

    methodCard(g, isHost),

    isHost
      ? h('div', { class: 'stack', id: 'host-controls' },
        h('button', { class: 'btn primary block big', id: 'start-play', disabled: g.options.length < need, onClick: () => run(startDeciding) },
          g.options.length < need ? `Need at least ${need} options` : `Start: ${M.icon} ${M.label} →`),
        h('button', { class: 'btn text', onClick: () => run(backToLobby) }, '← Back to players'))
      : h('p', { class: 'center muted' }, 'The host picks how to decide and starts when everyone is done.'),
  ];
}

/* ---------- Find nearby (restaurants, activities, movies) ---------- */

function openFinder() {
  const saved = prefs.get('lastLoc');
  S.finder = {
    code: S.route.code, cat: 'food', sub: 'any', radius: prefs.get('finderRadius', 1),
    loc: saved, editingLoc: !saved, locating: false, req: 0,
    loading: false, results: null, error: null, movies: null,
  };
  render();
  if (saved) runSearch();
  else useMyLocation();
}

function closeFinder() {
  clearTimeout(searchTimer);
  if (searchAbort) searchAbort.abort();
  S.finder = null;
  render();
}

function setFinder(changes) {
  Object.assign(S.finder, changes);
  if ('radius' in changes) prefs.set('finderRadius', changes.radius);
  runSearch();
}

async function useMyLocation() {
  const f = S.finder;
  Object.assign(f, { locating: true, error: null });
  render();
  try {
    const loc = await locateMe();
    if (S.finder === f) setFinderLocation(loc);
  } catch {
    if (S.finder !== f) return;
    Object.assign(f, { locating: false, editingLoc: true, error: "Couldn't get your location. Type a city or ZIP instead." });
    render();
  }
}

async function lookupPlace(text) {
  const f = S.finder;
  Object.assign(f, { locating: true, error: null });
  render();
  try {
    const loc = await geocode(text);
    if (S.finder !== f) return;
    if (loc) { setFinderLocation(loc); return; }
    f.error = `Couldn't find "${text}". Try a city name or ZIP code.`;
  } catch {
    if (S.finder !== f) return;
    f.error = "Couldn't look that up. Check your connection and try again.";
  }
  f.locating = false;
  render();
}

function setFinderLocation(loc) {
  Object.assign(S.finder, { loc, locating: false, editingLoc: false });
  prefs.set('lastLoc', loc);
  runSearch();
}

// Results already fetched in this session, so flipping back to a type or
// distance doesn't search again (and doesn't use up the map server's limit).
const placeCache = new Map();
let searchTimer = null;
let searchAbort = null;

function runSearch() {
  const f = S.finder;
  if (!f) return;
  if (f.cat === 'movies') { loadMovies(); return; }
  if (!f.loc) { render(); return; }
  const key = `${f.cat}|${f.sub}|${f.radius}|${f.loc.lat.toFixed(4)},${f.loc.lon.toFixed(4)}`;
  clearTimeout(searchTimer);
  if (searchAbort) searchAbort.abort(); // cancel a search that's still running
  if (placeCache.has(key)) {
    Object.assign(f, { loading: false, error: null, errorDetail: null, results: placeCache.get(key) });
    render();
    return;
  }
  Object.assign(f, { loading: true, slow: false, error: null, errorDetail: null, results: null });
  render();
  // Wait for taps to settle so quick changes become a single search.
  searchTimer = setTimeout(() => doSearch(f, key), 500);
}

async function doSearch(f, key) {
  const req = ++f.req;
  const ctrl = new AbortController();
  searchAbort = ctrl;
  const slowTimer = setTimeout(() => { if (S.finder === f && req === f.req) { f.slow = true; render(); } }, 6000);
  try {
    const results = await searchPlaces(f.cat, f.sub, f.loc, RADII[f.radius], ctrl.signal);
    placeCache.set(key, results);
    if (S.finder !== f || req !== f.req) return;
    f.results = results;
  } catch (e) {
    if (e.name === 'AbortError') return; // replaced by a newer search
    console.warn(e);
    if (S.finder !== f || req !== f.req) return;
    f.error = 'The map service is busy or unreachable. Try again in a moment.';
    f.errorDetail = e.reasons ? e.reasons.join(' · ') : String(e.message || e);
  } finally {
    clearTimeout(slowTimer);
    if (searchAbort === ctrl) searchAbort = null;
  }
  f.loading = false;
  render();
}

async function loadMovies() {
  const f = S.finder;
  if (!moviesEnabled || f.movies) { render(); return; }
  const req = ++f.req;
  Object.assign(f, { loading: true, error: null });
  render();
  try {
    const movies = await nowPlaying();
    if (S.finder !== f || req !== f.req) return;
    f.movies = movies;
  } catch (e) {
    console.error(e);
    if (S.finder !== f || req !== f.req) return;
    f.error = "Couldn't load the movie list. Try again in a moment.";
  }
  f.loading = false;
  render();
}

async function addFound(name) {
  const text = name.trim().slice(0, 60);
  const id = uid();
  rememberMyOption(id);
  if (await run(() => addOption(id, text))) toast(`Added "${text}"`);
}

function finderView(g) {
  const f = S.finder;
  const mine = new Set(g.options.filter((o) => S.myOptionIds.has(o.id)).map((o) => o.text.toLowerCase()));
  return [
    h('div', { class: 'row', id: 'finder-head' },
      h('button', { class: 'btn text', id: 'close-finder', onClick: closeFinder }, '← Back to options'),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted small' }, `${mine.size} added by you`)),
    h('section', { class: 'card', id: 'finder' },
      h('div', { class: 'seg finder-tabs' }, Object.entries(CATEGORIES).map(([id, c]) => h('button', {
        class: id === f.cat ? 'on' : '', 'data-key': 'cat-' + id, 'aria-pressed': String(id === f.cat),
        onClick: () => { if (id !== f.cat) setFinder({ cat: id, sub: 'any', results: null, error: null }); },
      }, `${c.icon} ${c.short || c.label}`))),
      f.cat === 'movies' ? moviesPanel(f, mine) : placesPanel(f, mine)),
  ];
}

function locationRow(f) {
  if (f.locating) return h('p', { class: 'muted small', id: 'loc-row' }, '📍 Finding the location…');
  if (f.editingLoc || !f.loc) {
    return h('form', {
      class: 'loc-form', id: 'loc-form',
      onSubmit: (e) => {
        e.preventDefault();
        const v = document.getElementById('place-input').value.trim();
        if (v) lookupPlace(v);
      },
    },
    h('div', { class: 'small muted' }, 'Search near'),
    h('div', { class: 'row' },
      h('input', { id: 'place-input', class: 'input', placeholder: 'City, address or ZIP', autocomplete: 'off', 'aria-label': 'City, address or ZIP' }),
      h('button', { class: 'btn', type: 'submit' }, 'Go')),
    h('div', { class: 'row' },
      h('button', { class: 'btn text small', type: 'button', onClick: useMyLocation }, '📍 Use my location'),
      f.loc && h('button', { class: 'btn text small', type: 'button', onClick: () => { f.editingLoc = false; f.error = null; render(); } }, 'Cancel')));
  }
  return h('div', { class: 'row', id: 'loc-row' },
    h('span', { class: 'grow small' }, `📍 Near ${f.loc.label}`),
    h('button', { class: 'btn text small', onClick: () => { f.editingLoc = true; render(); } }, 'Change'));
}

function finderStatus(f, emptyText) {
  if (f.loading) {
    return h('div', { class: 'finder-status center' }, h('div', { class: 'spinner inline' }),
      h('p', { class: 'muted small' }, f.slow ? 'Still searching… the free map service is slow right now.' : 'Searching…'));
  }
  if (f.error) {
    return h('div', { class: 'finder-status' }, h('p', { class: 'error-text' }, f.error),
      f.errorDetail && h('p', { class: 'muted small', id: 'error-detail' }, `Details: ${f.errorDetail}`),
      (f.loc || f.cat === 'movies') && h('button', { class: 'btn', onClick: () => { f.movies = null; runSearch(); } }, 'Try again'));
  }
  return emptyText ? h('p', { class: 'muted finder-status' }, emptyText) : null;
}

function resultRow(item, mine, sub) {
  const added = mine.has(item.name.trim().slice(0, 60).toLowerCase());
  return h('li', { 'data-key': 'r-' + item.id },
    item.poster !== undefined && (item.poster
      ? h('img', { class: 'poster', src: item.poster, alt: '', loading: 'lazy' })
      : h('div', { class: 'poster' })),
    h('div', { class: 'grow' }, h('div', { class: 'result-name' }, item.name), sub && h('div', { class: 'muted small' }, sub)),
    added
      ? h('span', { class: 'tag' }, '✓ Added')
      : h('button', { class: 'btn add-btn', 'aria-label': `Add ${item.name}`, onClick: () => addFound(item.name) }, '+ Add'));
}

function placesPanel(f, mine) {
  const cat = CATEGORIES[f.cat];
  const status = finderStatus(f, f.results && !f.results.length ? 'Nothing found. Try a bigger distance or another type.' : null);
  return [
    locationRow(f),
    f.error && !f.loc && h('p', { class: 'error-text' }, f.error),
    setting('Type', h('div', { class: 'chips sub-chips' }, cat.subs.map((s) => h('button', {
      class: 'chip' + (s.id === f.sub ? ' current' : ''), 'data-key': 'sub-' + s.id,
      onClick: () => { if (s.id !== f.sub) setFinder({ sub: s.id }); },
    }, s.label)))),
    setting('Within', h('div', { class: 'seg' }, RADII.map((r, i) => h('button', {
      class: i === f.radius ? 'on' : '', 'data-key': 'rad-' + i,
      onClick: () => { if (i !== f.radius) setFinder({ radius: i }); },
    }, `${r} ${unitLabel}`)))),
    f.loc && status,
    f.results && f.results.length > 0 && !f.loading && h('ul', { class: 'list results', id: 'results' },
      f.results.map((p) => resultRow(p, mine, [p.detail, formatDistance(p.km)].filter(Boolean).join(' · ')))),
    h('p', { class: 'muted small attribution' }, 'Place data © OpenStreetMap contributors'),
  ];
}

function moviesPanel(f, mine) {
  const theaters = h('button', { class: 'btn block', id: 'find-theaters', onClick: () => setFinder({ cat: 'activities', sub: 'cinemas', results: null }) }, '🎦 Movie theaters nearby');
  if (!moviesEnabled) {
    return [
      h('p', { class: 'muted' }, "🎬 The list of movies now playing needs a free key from The Movie Database (TMDB), which hasn't been set up yet."),
      theaters,
    ];
  }
  return [
    h('p', { class: 'muted small' }, 'Now playing in theaters, best rated first.'),
    finderStatus(f, f.movies && !f.movies.length ? 'No movies found right now.' : null),
    f.movies && f.movies.length > 0 && !f.loading && h('ul', { class: 'list results', id: 'results' },
      f.movies.map((m) => resultRow(m, mine, [m.rating ? `⭐ ${m.rating}` : null, m.year].filter(Boolean).join(' · ')))),
    theaters,
    h('p', { class: 'muted small attribution' }, 'This product uses the TMDB API but is not endorsed or certified by TMDB.'),
  ];
}

/* ---------- method picker & settings ---------- */

function methodCard(g, isHost) {
  const M = METHODS[g.method];
  return h('section', { class: 'card', id: 'method-card' },
    h('h2', {}, 'How will you decide?'),
    isHost
      ? h('div', { class: 'method-grid' }, METHOD_ORDER.map((m) => h('button', {
        class: 'method' + (m === g.method ? ' on' : ''),
        'data-key': 'm-' + m,
        'aria-pressed': String(m === g.method),
        onClick: () => { if (m !== g.method) run(() => setMethod(m)); },
      }, h('span', { class: 'method-icon' }, METHODS[m].icon), h('span', {}, METHODS[m].label))))
      : h('div', { class: 'method-current' }, h('span', { class: 'method-icon' }, M.icon), h('strong', {}, M.label)),
    h('p', { class: 'muted small method-desc' }, M.desc),
    methodSettings(g, isHost));
}

function setting(label, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'small muted' }, label), control);
}

function segmented(key, value, choices, disabled) {
  return h('div', { class: 'seg', role: 'group' }, choices.map(([v, label]) => h('button', {
    class: v === value ? 'on' : '',
    'data-key': `${key}-${v}`,
    'aria-pressed': String(v === value),
    disabled,
    onClick: () => { if (v !== value) run(() => setSetting(key, v)); },
  }, label)));
}

function stepper(key, value, display, min, max, disabled) {
  return h('div', { class: 'stepper' },
    h('button', { class: 'btn step', 'aria-label': 'Less', disabled: disabled || value <= min, onClick: () => run(() => setSetting(key, value - 1)) }, '−'),
    h('span', { class: 'step-value' }, display),
    h('button', { class: 'btn step', 'aria-label': 'More', disabled: disabled || value >= max, onClick: () => run(() => setSetting(key, value + 1)) }, '+'));
}

function methodSettings(g, isHost) {
  const s = settingsOf(g);
  const off = !isHost;
  if (g.method === 'vote') {
    return setting('Style', segmented('voteStyle', s.voteStyle, [['single', 'One choice each'], ['approval', 'Approval: tick all you like']], off));
  }
  if (g.method === 'random') {
    return setting('Pick', segmented('randomTarget', s.randomTarget, [['option', 'An option'], ['person', 'A person to decide']], off));
  }
  if (g.method === 'points') {
    const pts = pointsEach(g);
    return [
      setting('Points per person', stepper('points', pts, s.points ? String(pts) : `${pts} (one per option)`, 1, 99, off)),
      setting('Most points on one option', stepper('maxPer', s.maxPer, s.maxPer ? String(s.maxPer) : 'No limit', 0, 99, off)),
      s.maxPer > 0 && s.maxPer * g.options.length < pts
        && h('p', { class: 'error-text' }, 'This limit is too low to spend all the points.'),
    ];
  }
  if (g.method === 'veto') {
    return [
      setting('Vetoes per person', stepper('vetoes', s.vetoes, String(s.vetoes), 1, 5, off)),
      setting('Then decide the rest by', segmented('vetoThen', s.vetoThen, [['random', 'Random pick'], ['vote', 'Vote']], off)),
    ];
  }
  if (g.method === 'ranked') return h('p', { class: 'muted small' }, 'Ties for last place are broken by fewest 2nd-choice votes, then at random.');
  if (['vote', 'points', 'stars'].includes(g.method) || g.method === 'bracket') {
    return h('p', { class: 'muted small' }, g.method === 'bracket'
      ? 'Everyone picks a favorite in every matchup of a round before passing the phone. A tied matchup is settled by a coin flip.'
      : 'Ties are broken by the 👑 on your priority list if they’re playing, otherwise at random.');
  }
  return null;
}

/* ---------- playing ---------- */

const optName = (g, id) => (g.names && g.names[id]) || '?';

function vetoedNote(g) {
  return g.vetoed && g.vetoed.length
    ? h('p', { class: 'small muted', id: 'vetoed-note' }, '🚫 Vetoed: ' + g.vetoed.map((id) => optName(g, id)).join(', '))
    : null;
}

function playPhase(g, isHost) {
  if (g.method === 'elimination') return eliminatePhase(g, isHost);
  if (g.method === 'random') return randomPhase(g, isHost);
  return ballotPhase(g, isHost);
}

// Secrecy: each phone sees the list as it stood after its own last turn and
// only catches up when its turn comes round again, so it can't tell who
// knocked out what. (Phones without players stay on the starting list.)
function eliminatePhase(g, isHost) {
  const cur = currentPlayer(g);
  const mine = cur.device === S.clientId;
  const turnKey = `${S.route.code}:${g.playId}:${g.turn}:${g.options.length}`;
  const playingFor = isHost && !mine && S.playFor === turnKey;
  const live = mine || playingFor;

  const snapKey = `${S.route.code}:${g.playId}`;
  if (!S.elimSnap || S.elimSnap.key !== snapKey) S.elimSnap = { key: snapKey, ids: (g.allOptions || g.options).map((o) => o.id) };
  if (live) S.elimSnap.ids = g.options.map((o) => o.id);
  const pending = S.elimPending && S.elimPending.key === snapKey ? S.elimPending.id : null;
  const shown = S.elimSnap.ids.filter((id) => id !== pending);
  const liveIds = new Set(g.options.map((o) => o.id));
  const behind = shown.filter((id) => !liveIds.has(id)).length;

  return [
    h('div', { class: 'turn-banner' + (live ? ' mine' : ''), id: 'turn-banner' },
      mine
        ? [h('strong', {}, `${cur.name}, it's your turn!`), h('div', { class: 'small' }, 'Tap an option to eliminate it.')]
        : playingFor
          ? [h('strong', {}, `Playing for ${cur.name}`), h('div', { class: 'small' }, 'Tap an option to eliminate it for them.')]
          : [h('strong', {}, `Waiting for ${cur.name}…`),
            isHost && h('button', { class: 'btn text small', id: 'play-for', onClick: () => onPlayFor(turnKey, cur) }, `${cur.name} stuck? Play this turn for them`)]),

    h('section', { class: 'card', id: 'order-card' },
      h('div', { class: 'muted small' }, 'Turn order'),
      h('ol', { class: 'chips' }, g.order.map((id, i) => {
        const p = playerById(g, id);
        return h('li', { class: 'chip' + (i === g.turn ? ' current' : ''), 'data-key': 't-' + id }, p ? p.name : '?');
      }))),

    h('p', { class: 'muted small', id: 'left-count' }, `${g.options.length} options left`),
    !live && h('p', { class: 'muted small', id: 'stale-note' }, behind > 0
      ? `👀 This is the list from your last turn. ${behind} more ${behind === 1 ? 'has' : 'have'} been knocked out since; you'll see which on your turn, so nobody can tell who knocked out what.`
      : "👀 You'll see the latest list on your turn, so nobody can tell who knocked out what."),

    h('div', { id: 'options' }, shown.map((id) => h('button', {
      class: 'option-btn', 'data-key': 'o-' + id, disabled: !live,
      onClick: () => onEliminate({ id, text: optName(g, id) }, g.turn),
    }, h('span', { class: 'grow' }, optName(g, id)), h('span', { class: 'x', 'aria-hidden': 'true' }, '✕')))),
  ];
}

function randomPhase(g, isHost) {
  const byPerson = settingsOf(g).randomTarget === 'person';
  const items = byPerson ? g.players.map((p) => p.name) : g.options.map((o) => o.text);
  S.spinWatch = S.route.code; // this phone saw the wheel before it spun, so animate it
  return [
    vetoedNote(g),
    h('section', { class: 'card', id: 'spin-card' },
      h('h2', {}, byPerson ? 'Who will decide?' : 'Spin for the winner'),
      h('div', { class: 'spin-list' }, items.map((t, i) => h('div', { class: 'spin-item', 'data-key': 'c' + i }, t)))),
    isHost
      ? h('button', { class: 'btn primary block big', id: 'spin-btn', onClick: () => run(spinAction) }, '🎡 Spin!')
      : h('p', { class: 'center muted' }, 'Waiting for the host to spin…'),
  ];
}

function ballotPhase(g, isHost) {
  const round = ballotRound(g);
  const voters = myVoters(g);
  if (!voters.some((p) => p.id === S.ballotFor)) S.ballotFor = voters[0] ? voters[0].id : null;
  const total = g.players.length;
  const done = g.voted.length;

  return [
    vetoedNote(g),
    g.method === 'bracket' && bracketTree(g),
    h('section', { class: 'card', id: 'vote-status' },
      h('div', { class: 'row' },
        h('strong', { class: 'grow' }, `${done} of ${total} voted`),
        isHost && done > 0 && done < total && h('button', { class: 'btn text small', id: 'close-voting', onClick: () => onCloseVoting(round) }, 'Close voting')),
      h('div', { class: 'chips' }, g.players.map((p) => {
        const has = g.voted.includes(p.id);
        return h('span', { class: 'chip' + (has ? ' done' : ''), 'data-key': 'v-' + p.id }, (has ? '✓ ' : '… ') + p.name);
      }))),
    S.ballotFor
      ? ballotCard(g, playerById(g, S.ballotFor), voters, round)
      : h('p', { class: 'center muted', id: 'waiting' }, g.players.some((p) => p.device === S.clientId)
        ? 'Thanks! Waiting for everyone else to vote…'
        : 'Waiting for everyone to vote…'),
  ];
}

function draftFor(g, pid) {
  const key = `${S.route.code}:${ballotRound(g)}:${pid}`;
  if (!S.draft || S.draft.key !== key) S.draft = { key, data: emptyDraft(g) };
  return S.draft;
}

function emptyDraft(g) {
  const s = settingsOf(g);
  if (g.method === 'vote') return s.voteStyle === 'approval' ? [] : null;
  if (g.method === 'points' || g.method === 'stars') return {};
  if (g.method === 'ranked' || g.method === 'veto') return [];
  return {}; // bracket: matchup index -> pick
}

function ballotHint(g) {
  const s = settingsOf(g);
  switch (g.method) {
    case 'vote': return s.voteStyle === 'approval' ? 'Tick every option you’d be happy with.' : 'Tap your choice.';
    case 'points': return `Spread ${g.pointsEach} points however you like${s.maxPer ? ` (at most ${s.maxPer} on one option)` : ''}.`;
    case 'ranked': return 'Tap options in order of preference, favorite first. Rank as many as you like. Tap again to un-rank.';
    case 'veto': return `Pick ${g.vetoesEach === 1 ? 'the one option' : `${g.vetoesEach} options`} you’d most like to rule out.`;
    case 'stars': return 'Rate each option. Tap the same star again to clear it.';
    case 'bracket': return 'Pick your favorite in every matchup this round, then pass the phone if someone else votes on it.';
    default: return '';
  }
}

function ballotProblem(g, data) {
  const s = settingsOf(g);
  switch (g.method) {
    case 'vote':
      if (s.voteStyle === 'approval') return data.length ? null : 'Tick at least one';
      return data ? null : 'Pick one';
    case 'bracket': {
      const more = openMatches(g).filter((m) => !data[m.j]).length;
      return more === 0 ? null : `Pick ${more} more ${more === 1 ? 'matchup' : 'matchups'}`;
    }
    case 'points': {
      const left = g.pointsEach - Object.values(data).reduce((t, n) => t + n, 0);
      return left === 0 ? null : `${left} ${left === 1 ? 'point' : 'points'} left to spend`;
    }
    case 'ranked': return data.length ? null : 'Rank at least one';
    case 'veto': {
      const more = g.vetoesEach - data.length;
      return more === 0 ? null : `Pick ${more} more to veto`;
    }
    default: return null;
  }
}

function ballotCard(g, player, voters, round) {
  const d = draftFor(g, player.id);
  const problem = ballotProblem(g, d.data);
  const submit = () => run(() => submitBallot(player.id, d.data, round));
  return h('section', { class: 'card ballot', id: 'ballot' },
    voters.length > 1 && [
      h('p', { class: 'small muted' }, 'Several people vote on this phone. Pass it around so each person votes in secret.'),
      h('div', { class: 'chips' }, voters.map((p) => h('button', {
        class: 'chip' + (p.id === player.id ? ' current' : ''), 'data-key': 'bf-' + p.id,
        onClick: () => { S.ballotFor = p.id; render(); },
      }, p.name)))],
    h('h2', {}, `${player.name}'s ballot`),
    h('p', { class: 'muted small' }, ballotHint(g)),
    ballotEditor(g, d),
    h('button', { class: 'btn primary block big', id: 'submit-ballot', disabled: !!problem, onClick: submit }, problem || `Submit ${player.name}'s vote`),
    h('p', { class: 'muted small center' }, '🔒 Secret. A vote can’t be changed after it’s submitted.'));
}

function ballotEditor(g, d) {
  const s = settingsOf(g);
  const set = (v) => { d.data = v; render(); };
  const opts = g.options;

  if (g.method === 'bracket') {
    const open = openMatches(g);
    return h('div', { id: 'editor' }, open.map((m, k) => h('div', { class: 'match-pick', 'data-key': 'mp' + m.j },
      h('div', { class: 'small muted' }, `Matchup ${k + 1} of ${open.length}`),
      h('div', { class: 'choices' }, [m.x, m.y].map((id, i) => [
        i === 1 && h('div', { class: 'vs center' }, 'vs'),
        h('button', {
          class: 'choice' + (d.data[m.j] === id ? ' on' : ''), 'data-key': 'c-' + id, 'aria-pressed': String(d.data[m.j] === id),
          onClick: () => set({ ...d.data, [m.j]: id }),
        }, h('span', { class: 'grow' }, optName(g, id)), h('span', { class: 'mark' }, d.data[m.j] === id ? '●' : '○')),
      ])))));
  }

  if (g.method === 'vote' && s.voteStyle !== 'approval') {
    return h('div', { class: 'choices', id: 'editor' }, opts.map((o) => h('button', {
      class: 'choice' + (d.data === o.id ? ' on' : ''), 'data-key': 'c-' + o.id, 'aria-pressed': String(d.data === o.id),
      onClick: () => set(o.id),
    }, h('span', { class: 'grow' }, o.text), h('span', { class: 'mark' }, d.data === o.id ? '●' : '○'))));
  }

  if (g.method === 'vote' || g.method === 'veto') {
    const veto = g.method === 'veto';
    return h('div', { class: 'choices', id: 'editor' }, opts.map((o) => {
      const on = d.data.includes(o.id);
      return h('button', {
        class: 'choice' + (on ? ' on' : '') + (veto ? ' veto' : ''), 'data-key': 'c-' + o.id, 'aria-pressed': String(on),
        onClick: () => {
          if (on) set(d.data.filter((id) => id !== o.id));
          else if (veto && d.data.length >= g.vetoesEach) toast(`You can only veto ${g.vetoesEach}. Tap one to undo it first.`);
          else set([...d.data, o.id]);
        },
      }, h('span', { class: 'grow' }, o.text), h('span', { class: 'mark' }, on ? (veto ? '🚫' : '☑') : '☐'));
    }));
  }

  if (g.method === 'points') {
    const used = Object.values(d.data).reduce((t, n) => t + n, 0);
    const left = g.pointsEach - used;
    const change = (id, delta) => set({ ...d.data, [id]: (d.data[id] || 0) + delta });
    return h('div', { id: 'editor' },
      h('div', { class: 'points-left' + (left === 0 ? ' done' : '') }, `${left} of ${g.pointsEach} points left`),
      opts.map((o) => {
        const n = d.data[o.id] || 0;
        return h('div', { class: 'points-row', 'data-key': 'p-' + o.id },
          h('span', { class: 'grow' }, o.text),
          h('button', { class: 'btn step', 'aria-label': `Less for ${o.text}`, disabled: n <= 0, onClick: () => change(o.id, -1) }, '−'),
          h('span', { class: 'pts' }, n),
          h('button', {
            class: 'btn step', 'aria-label': `More for ${o.text}`,
            disabled: left <= 0 || (s.maxPer > 0 && n >= s.maxPer), onClick: () => change(o.id, 1),
          }, '+'));
      }));
  }

  if (g.method === 'stars') {
    return h('div', { id: 'editor' }, opts.map((o) => {
      const r = d.data[o.id] || 0;
      return h('div', { class: 'stars-row', 'data-key': 's-' + o.id },
        h('span', { class: 'grow' }, o.text),
        h('span', { class: 'stars' }, [1, 2, 3, 4, 5].map((k) => h('button', {
          class: 'star' + (k <= r ? ' on' : ''), 'aria-label': `${k} stars for ${o.text}`,
          onClick: () => set({ ...d.data, [o.id]: r === k ? 0 : k }),
        }, '★'))));
    }));
  }

  if (g.method === 'ranked') {
    return h('div', { id: 'editor' },
      h('div', { class: 'choices' }, opts.map((o) => {
        const rank = d.data.indexOf(o.id) + 1;
        return h('button', {
          class: 'choice' + (rank ? ' on' : ''), 'data-key': 'c-' + o.id,
          onClick: () => set(rank ? d.data.filter((id) => id !== o.id) : [...d.data, o.id]),
        }, h('span', { class: 'rank' }, rank || ''), h('span', { class: 'grow' }, o.text));
      })),
      d.data.length > 0 && h('button', { class: 'btn text small', onClick: () => set([]) }, 'Clear ranking'));
  }
  return null;
}

// The whole bracket, round by round, so everyone can follow along.
function bracketTree(g) {
  const b = g.bracket;
  if (!b || !b.rounds) return null;
  const n = b.rounds.length;
  const roundName = (r) => (r === n - 1 ? 'Final' : r === n - 2 ? 'Semifinals' : r === n - 3 ? 'Quarterfinals' : `Round ${r + 1}`);
  const champion = g.phase === 'winner' && b.rounds[n - 1].matches[0].winner;
  const slot = (m, id, v) => {
    const decided = !!m.winner && !m.bye;
    return h('div', { class: 'slot' + (decided && id === m.winner ? ' win' : '') + (decided && id && id !== m.winner ? ' lose' : '') + (!id ? ' empty' : '') },
      h('span', { class: 'grow' }, id ? optName(g, id) : m.bye ? 'bye' : 'TBD'),
      decided && h('span', { class: 'v' }, v));
  };
  return h('section', { class: 'card', id: 'bracket-tree' },
    h('h2', {}, '🏆 Bracket'),
    h('div', { class: 'bracket-scroll' }, h('div', { class: 'bracket' },
      b.rounds.map((rd, r) => h('div', { class: 'bracket-col' + (g.phase === 'play' && r === b.round ? ' current' : ''), 'data-key': 'br' + r },
        h('div', { class: 'bracket-col-title' }, roundName(r)),
        h('div', { class: 'bracket-matches' },
          rd.matches.map((m, j) => h('div', { class: 'mbox' + (m.bye ? ' bye' : ''), 'data-key': `mb${r}-${j}` },
            slot(m, m.x, m.vx), slot(m, m.y, m.vy),
            m.coin && h('div', { class: 'coin' }, '🪙 coin flip'))),
          r === n - 1 && champion && h('div', { class: 'mbox champ', 'data-key': 'champ' },
            h('div', { class: 'slot win' }, '🏆 ' + optName(g, champion)))))))),
    n > 3 && h('p', { class: 'muted small' }, 'Swipe sideways to see the whole bracket.'),
    g.phase === 'play' && h('p', { class: 'muted small' }, `Voting on: ${roundName(b.round)}`));
}

/* ---------- ties ---------- */

function tiebreakPhase(g, isHost) {
  const decider = playerById(g, g.tie.decider);
  const mine = isMine(g, g.tie.decider);
  const can = mine || isHost;
  return [
    h('div', { class: 'turn-banner' + (mine ? ' mine' : ''), id: 'tie-banner' },
      h('strong', {}, "It's a tie!"),
      h('div', { class: 'small' }, mine
        ? `${decider.name}, you're the 👑 on the priority list, so you break the tie.`
        : `${decider ? decider.name : 'The 👑'} breaks the tie as the 👑 on the priority list…${isHost ? ' (As the host you can tap for them.)' : ''}`)),
    h('div', { id: 'tie-options' }, g.tie.ids.map((id) => h('button', {
      class: 'option-btn tie', 'data-key': 't-' + id, disabled: !can, onClick: () => onBreakTie(id),
    }, h('span', { class: 'grow' }, optName(g, id)), h('span', { class: 'x' }, '👑')))),
    scoresCard(g),
  ];
}

/* ---------- results ---------- */

function scoresCard(g) {
  const r = g.result;
  if (!r || r.kind !== 'scores') return null;
  const stars = g.method === 'stars';
  const value = (id) => (stars ? (r.ballots ? r.tally[id] / r.ballots : 0) : r.tally[id]);
  const idsSorted = Object.keys(r.tally).sort((a, b) => value(b) - value(a));
  const max = Math.max(1e-9, ...idsSorted.map(value));
  const label = (id) => {
    const v = value(id);
    if (stars) return `★ ${v.toFixed(1)}`;
    if (g.method === 'points') return `${v} ${v === 1 ? 'point' : 'points'}`;
    return `${v} ${v === 1 ? 'vote' : 'votes'}`;
  };
  return h('section', { class: 'card', id: 'scores' },
    h('h2', {}, 'Results'),
    idsSorted.map((id) => h('div', { class: 'score-row', 'data-key': 'sc-' + id },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, optName(g, id)), h('strong', {}, label(id))),
      h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width:${(value(id) / max) * 100}%` })))),
    h('p', { class: 'muted small' }, `${r.ballots} ${r.ballots === 1 ? 'ballot' : 'ballots'} counted.`));
}

function roundCard(g, round, i) {
  const idsSorted = Object.keys(round.counts).sort((a, b) => round.counts[b] - round.counts[a]);
  const out = [].concat(round.eliminated);
  const outNames = listJoin(out.map((id) => optName(g, id)));
  const outText = out.length > 1 && out.every((id) => round.counts[id] === 0)
    ? `❌ ${outNames} got no first-choice votes, so they're all knocked out at once.`
    : out.length > 1
    ? `❌ ${outNames} are knocked out together. They tied for last, and even combined they had fewer votes than the next option, so the tie couldn't change the result.`
    : `❌ ${outNames} is knocked out${round.tie === 'second' ? ' (tied for last; fewest 2nd-choice votes)' : round.tie === 'random' ? ' (tied for last; picked at random)' : ''}.`;
  return h('section', { class: 'card', 'data-key': 'round-' + i },
    h('h2', {}, `Round ${i + 1}`),
    h('ul', { class: 'list' }, idsSorted.map((id) => h('li', { class: out.includes(id) ? 'out' : '', 'data-key': 'rc-' + id },
      h('span', { class: 'grow' }, optName(g, id)), h('strong', {}, round.counts[id])))),
    h('p', { class: 'small' }, outText),
    round.exhausted > 0 && h('p', { class: 'muted small' }, `${round.exhausted} ${round.exhausted === 1 ? 'ballot has' : 'ballots have'} no choices left.`));
}

function revealKey(g) {
  return `${S.route.code}:${g.playId}:${g.result.rounds.map((r) => [].concat(r.eliminated).join('+')).join(',')}`;
}

function rankedRevealDone(g) {
  const key = revealKey(g);
  if (!S.reveal || S.reveal.key !== key) S.reveal = { key, n: 1, done: false };
  return S.reveal.done;
}

function rankedReveal(g) {
  const rounds = g.result.rounds;
  const n = S.reveal.n;
  return [
    h('p', { class: 'muted center' }, 'Counting the ranked ballots, one round at a time…'),
    rounds.slice(0, n).map((r, i) => roundCard(g, r, i)),
    h('div', { class: 'stack' },
      h('button', {
        class: 'btn primary block big', id: 'next-round',
        onClick: () => { if (n < rounds.length) S.reveal.n++; else S.reveal.done = true; render(); },
      }, n < rounds.length ? 'Next round ▶' : 'Show the winner 🎉'),
      h('button', { class: 'btn text', onClick: () => { S.reveal.done = true; render(); } }, 'Skip to the result')),
  ];
}

function spinKey(g) { return `${S.route.code}:${g.spin.at}:${g.spin.pick}`; }

function spinFinished(g) {
  const key = spinKey(g);
  if (S.spinDone === key) return true;
  if (S.spinAnim && S.spinAnim.key === key) return false;
  if (S.spinWatch === S.route.code) {
    S.spinWatch = null;
    startSpin(key, g.spin.candidates.length, g.spin.pick);
    return false;
  }
  S.spinDone = key; // joined after the spin; just show the result
  return true;
}

function startSpin(key, n, pick) {
  const steps = n * Math.max(2, Math.ceil(18 / n)) + pick;
  S.spinAnim = { key, i: 0 };
  let k = 0;
  const tick = () => {
    if (!S.spinAnim || S.spinAnim.key !== key) return;
    k++;
    S.spinAnim.i = k % n;
    render();
    if (k >= steps) {
      setTimeout(() => { S.spinDone = key; S.spinAnim = null; render(); }, 700);
      return;
    }
    const t = k / steps;
    setTimeout(tick, 45 + 380 * t * t * t);
  };
  setTimeout(tick, 45);
}

function spinningView(g) {
  return h('section', { class: 'card', id: 'spinning' },
    h('h2', { class: 'center' }, '🎡 Spinning…'),
    h('div', { class: 'spin-list' }, g.spin.candidates.map((t, i) => h('div', {
      class: 'spin-item' + (S.spinAnim && S.spinAnim.i === i ? ' on' : ''), 'data-key': 'c' + i,
    }, t))));
}

function winnerPhase(g, isHost) {
  const r = g.result || {};
  if (g.spin && !spinFinished(g)) return spinningView(g);
  if (r.kind === 'ranked' && !rankedRevealDone(g)) return rankedReveal(g);
  const M = METHODS[g.method];

  return [
    h('div', { class: 'winner', id: 'winner' },
      h('div', { class: 'emoji-xl' }, '🎉'),
      h('div', { class: 'muted' }, r.byPerson ? 'The wheel says' : 'The winner is'),
      h('div', { class: 'winner-name' }, g.winner),
      r.note && h('p', { class: 'muted small' }, r.note),
      h('div', { class: 'muted small' }, `Decided by ${M.icon} ${M.label}`)),
    vetoedNote(g),
    scoresCard(g),
    r.kind === 'ranked' && r.rounds.map((round, i) => roundCard(g, round, i)),
    r.kind === 'bracket' && bracketTree(g),
    isHost
      ? h('div', { class: 'stack', id: 'winner-controls' },
        h('button', { class: 'btn primary big', id: 'decide-again', onClick: () => run(decideAgain) }, 'Decide again with the same options'),
        h('button', { class: 'btn', id: 'start-over', onClick: () => run(startOver) }, 'Start over with new options'),
        h('button', { class: 'btn text', id: 'end-game', onClick: () => run(endGame) }, 'End game and go home'))
      : h('div', { class: 'stack' },
        h('p', { class: 'muted small center' }, 'The host can start another round.'),
        h('button', { class: 'btn', onClick: goBack }, 'Back to home')),
  ];
}

/* ---------- top-level render ---------- */

function currentView() {
  if (S.storeError) {
    return messageView('error', "Couldn't connect", S.storeError,
      'Try again', () => location.reload());
  }
  if (!S.store) return loadingView();
  const r = S.route;
  if (r.name === 'game') return gameView();
  if (r.name === 'joinFamily') return joinInviteView();
  if (!S.familyCode) return welcomeView();
  if (S.family === undefined) return loadingView();
  if (S.family === null) {
    return messageView('family-missing', 'Family not found',
      `The family with code ${S.familyCode} no longer exists.`, 'Start over', leaveFamily);
  }
  if (r.name === 'stats') return statsView();
  return homeView();
}

function render() {
  patchChildren($app, [currentView()]);
}

async function main() {
  try {
    S.store = await createStore();
  } catch (e) {
    console.error(e);
    S.storeError = `Could not connect to Firebase (${e.message || e}). Check js/firebase-config.js and that Anonymous sign-in is enabled. See the README.`;
    render();
    return;
  }
  S.clientId = getClientId(S.store.mode);
  if (S.route.name === 'joinFamily' && S.route.code === S.familyCode) location.replace('#/');
  syncSubscriptions();
  render();
}

main();
