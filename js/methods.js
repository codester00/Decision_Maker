// Group decision methods: the registry plus the pure game logic for each.
//
// Every function here works on a plain game object `g` (a copy of the
// Firestore document) and mutates it. Nothing touches the DOM or the network,
// so the rules can be tested on their own. `rand()` returns a float in [0, 1).
//
// Privacy: simple votes only keep running totals (g.tally) and the list of
// players who have voted (g.voted), never who voted for what. Ranked ballots
// must be kept whole to count later rounds, so they are stored without a name
// and inserted at a random position.

export const METHODS = {
  elimination: {
    label: 'Elimination', icon: '🎯',
    desc: 'Take turns knocking out options, one at a time, until one is left.',
  },
  random: {
    label: 'Random pick', icon: '🎡',
    desc: 'Spin the wheel. Every phone watches the same spin.',
  },
  vote: {
    label: 'Vote', icon: '🗳️',
    desc: 'Everyone votes in secret. Most votes wins.',
  },
  points: {
    label: 'Points', icon: '💰',
    desc: 'Spread your points however you like. Put them all on one thing if you feel strongly.',
  },
  ranked: {
    label: 'Ranked choice', icon: '🥇',
    desc: 'Rank your favorites. The option with the fewest first choices is knocked out each round, and those votes move to their next choice.',
  },
  veto: {
    label: 'Veto round', icon: '🚫',
    desc: 'Everyone secretly vetoes options they can’t stand. The rest go to a random pick or a vote.',
  },
  bracket: {
    label: 'Bracket', icon: '🏆',
    desc: 'Options face off two at a time, tournament style. Everyone votes on each match.',
  },
  stars: {
    label: 'Star rating', icon: '⭐',
    desc: 'Rate every option from 0 to 5 stars. Highest total wins.',
  },
};

export const METHOD_ORDER = ['elimination', 'random', 'vote', 'points', 'ranked', 'veto', 'bracket', 'stars'];

// Methods where everyone fills in a secret ballot at the same time.
export const BALLOT_METHODS = new Set(['vote', 'points', 'ranked', 'veto', 'bracket', 'stars']);

export const DEFAULT_SETTINGS = {
  voteStyle: 'single', // single | approval
  points: null, // null = one point per option
  maxPer: 0, // 0 = no limit
  randomTarget: 'option', // option | person
  vetoes: 1,
  vetoThen: 'random', // random | vote
};

export class RuleError extends Error {}

/* ---------- helpers ---------- */

export function settingsOf(g) {
  return { ...DEFAULT_SETTINGS, ...(g.settings || {}) };
}

export function shuffleWith(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function minOptions(g) {
  const s = settingsOf(g);
  if (g.method === 'random' && s.randomTarget === 'person') return 0;
  return 2;
}

export function pointsEach(g) {
  const s = settingsOf(g);
  return s.points || g.options.length;
}

export function vetoesEach(g) {
  return Math.max(1, Math.min(settingsOf(g).vetoes, g.options.length - 1));
}

// Bring documents from older versions of the app up to date.
export function normalizeGame(g) {
  if (!g) return g;
  if (g.phase === 'eliminate') { g.phase = 'play'; g.method = 'elimination'; }
  if (!g.method) g.method = 'elimination';
  if (!g.settings) g.settings = {};
  if (!g.players) g.players = [];
  if (!g.options) g.options = [];
  return g;
}

const PLAY_FIELDS = ['order', 'turn', 'tally', 'voted', 'ballots', 'bracket', 'spin', 'tie', 'winner',
  'result', 'vetoed', 'names', 'playId', 'pointsEach', 'vetoesEach', 'ballotCount'];

export function clearPlay(g) {
  for (const f of PLAY_FIELDS) delete g[f];
}

// Back to the options screen with the original options and method, ready
// to decide again (possibly with a different method).
export function resetToOptions(g) {
  if (g.allOptions) g.options = g.allOptions;
  if (g.setup) { g.method = g.setup.method; g.settings = g.setup.settings; }
  clearPlay(g);
  delete g.allOptions;
  delete g.setup;
  g.phase = 'options';
}

export function resetToLobby(g) {
  resetToOptions(g);
  g.options = [];
  g.phase = 'lobby';
}

// Identifies the current round of ballots, so a ballot can't land in the next one.
export const ballotRound = (g) => `${g.playId || 0}:${g.method}:${g.bracket ? g.bracket.history.length : 0}`;

/* ---------- starting ---------- */

export function startPlay(g, rand) {
  const s = settingsOf(g);
  const n = g.options.length;
  if (n < minOptions(g)) throw new RuleError(`Need at least ${minOptions(g)} options.`);
  if (g.players.length < 1) throw new RuleError('Need at least one player.');
  if (g.method === 'points' && s.maxPer > 0 && s.maxPer * n < pointsEach(g)) {
    throw new RuleError('The per-option limit is too low to spend all the points. Raise the limit or lower the points.');
  }
  clearPlay(g);
  g.setup = { method: g.method, settings: { ...g.settings } };
  g.allOptions = g.options.map((o) => ({ ...o }));
  g.names = Object.fromEntries(g.options.map((o) => [o.id, o.text]));
  g.playId = Math.floor(rand() * 1e9) + 1; // unique per round of deciding
  g.phase = 'play';
  initMethod(g, rand);
}

function initMethod(g, rand) {
  const ids = g.options.map((o) => o.id);
  g.voted = [];
  if (g.method === 'elimination') {
    g.order = shuffleWith(g.players.map((p) => p.id), rand); // randomized once, then fixed
    g.turn = 0;
  } else if (g.method === 'random') {
    g.spin = null;
  } else if (g.method === 'ranked') {
    g.ballots = [];
  } else if (g.method === 'bracket') {
    g.bracket = { queue: shuffleWith(ids, rand), winners: [], round: 1, history: [] };
    advanceBracket(g, rand);
  } else {
    g.tally = Object.fromEntries(ids.map((id) => [id, 0]));
    g.ballotCount = 0;
    if (g.method === 'points') g.pointsEach = pointsEach(g);
    if (g.method === 'veto') g.vetoesEach = vetoesEach(g);
  }
}

/* ---------- elimination ---------- */

export const currentPlayer = (g) => g.players.find((p) => p.id === (g.order || [])[g.turn]);

export function eliminate(g, optionId, rand) {
  if (!g.options.some((o) => o.id === optionId)) throw new RuleError('That option is already gone.');
  g.options = g.options.filter((o) => o.id !== optionId);
  if (g.options.length === 1) win(g, g.options[0].id, null, rand);
  else g.turn = (g.turn + 1) % g.order.length;
}

/* ---------- random ---------- */

export function spin(g, rand) {
  const s = settingsOf(g);
  const byPerson = s.randomTarget === 'person';
  const candidates = byPerson ? g.players.map((p) => p.name) : g.options.map((o) => o.text);
  if (candidates.length < 1) throw new RuleError('Nothing to pick from.');
  const pick = Math.floor(rand() * candidates.length);
  g.spin = { candidates, pick, at: Date.now() };
  g.phase = 'winner';
  g.winner = byPerson ? `${candidates[pick]} decides` : candidates[pick];
  g.result = { kind: 'random', byPerson, vetoed: g.vetoed || null };
}

/* ---------- ballots ---------- */

const ids = (g) => g.options.map((o) => o.id);
const isInt = (x) => Number.isInteger(x) && x >= 0;

// Checks a ballot and adds it to the game. Throws RuleError if invalid.
export function applyBallot(g, ballot, rand) {
  const valid = new Set(ids(g));
  const m = g.method;
  const s = settingsOf(g);

  if (m === 'vote' && s.voteStyle !== 'approval') {
    if (!valid.has(ballot)) throw new RuleError('Pick one option.');
    g.tally[ballot]++;
  } else if (m === 'vote') {
    const picks = [...new Set(ballot || [])];
    if (picks.length < 1) throw new RuleError('Tick at least one option.');
    if (!picks.every((id) => valid.has(id))) throw new RuleError('That option is gone.');
    picks.forEach((id) => g.tally[id]++);
  } else if (m === 'points') {
    const entries = Object.entries(ballot || {}).filter(([, n]) => n > 0);
    if (!entries.every(([id, n]) => valid.has(id) && isInt(n))) throw new RuleError('Invalid points.');
    const total = entries.reduce((t, [, n]) => t + n, 0);
    if (total !== g.pointsEach) throw new RuleError(`Use exactly ${g.pointsEach} points (you've used ${total}).`);
    if (s.maxPer > 0 && entries.some(([, n]) => n > s.maxPer)) throw new RuleError(`No more than ${s.maxPer} points on one option.`);
    entries.forEach(([id, n]) => { g.tally[id] += n; });
  } else if (m === 'veto') {
    const picks = [...new Set(ballot || [])];
    if (picks.length !== g.vetoesEach) throw new RuleError(`Veto exactly ${g.vetoesEach}.`);
    if (!picks.every((id) => valid.has(id))) throw new RuleError('That option is gone.');
    picks.forEach((id) => g.tally[id]++);
  } else if (m === 'stars') {
    const r = ballot || {};
    if (!Object.entries(r).every(([id, n]) => valid.has(id) && isInt(n) && n <= 5)) throw new RuleError('Invalid rating.');
    for (const id of valid) g.tally[id] += r[id] || 0;
  } else if (m === 'ranked') {
    const order = [...new Set(ballot || [])];
    if (order.length < 1) throw new RuleError('Rank at least one option.');
    if (!order.every((id) => valid.has(id))) throw new RuleError('That option is gone.');
    // Firestore can't store arrays inside arrays, so wrap each ballot.
    g.ballots.splice(Math.floor(rand() * (g.ballots.length + 1)), 0, { r: order });
  } else if (m === 'bracket') {
    if (!g.bracket.queue.slice(0, 2).includes(ballot)) throw new RuleError('Pick one of the two.');
    g.tally[ballot]++;
  } else {
    throw new RuleError('This method has no ballots.');
  }
  g.ballotCount = (g.ballotCount || 0) + 1;
}

// Called when everyone has voted (or the host closes voting).
export function resolveBallots(g, crownName, rand) {
  const m = g.method;
  if (m === 'bracket') return resolveMatch(g, crownName, rand);
  if (m === 'ranked') {
    const { winner, rounds } = instantRunoff(ids(g), g.ballots.map((b) => b.r), rand);
    g.result = { kind: 'ranked', rounds };
    return win(g, winner, null, rand);
  }
  if (m === 'veto') return resolveVeto(g, rand);
  // vote, points, stars: highest total wins
  g.result = { kind: 'scores', tally: { ...g.tally }, ballots: g.ballotCount, vetoed: g.vetoed || null };
  return finishWithScores(g, g.tally, crownName, rand);
}

function finishWithScores(g, scores, crownName, rand) {
  const top = topScorers(ids(g), scores);
  if (top.length === 1) return win(g, top[0], null, rand);
  return startTiebreak(g, top, crownName, rand);
}

export function topScorers(optionIds, scores) {
  const max = Math.max(...optionIds.map((id) => scores[id] || 0));
  return optionIds.filter((id) => (scores[id] || 0) === max);
}

/* ---------- ties ---------- */

// The family's 👑 (#1 on the priority list when the game started) breaks
// ties if they are playing. Otherwise the tie is broken at random.
function startTiebreak(g, tiedIds, crownName, rand) {
  const crown = crownName && g.players.find((p) => p.name.toLowerCase() === crownName.toLowerCase());
  if (crown) {
    g.phase = 'tiebreak';
    g.tie = { ids: tiedIds, decider: crown.id };
    return;
  }
  const pick = tiedIds[Math.floor(rand() * tiedIds.length)];
  win(g, pick, 'It was a tie, so the winner was picked at random.', rand);
}

export function breakTie(g, optionId) {
  if (g.phase !== 'tiebreak' || !g.tie.ids.includes(optionId)) throw new RuleError('Pick one of the tied options.');
  const decider = g.players.find((p) => p.id === g.tie.decider);
  win(g, optionId, `It was a tie. ${decider ? decider.name : 'The 👑'} broke it.`);
}

function win(g, optionId, note) {
  g.phase = 'winner';
  g.winner = (g.names && g.names[optionId]) || (g.options.find((o) => o.id === optionId) || {}).text || '?';
  g.result = { ...(g.result || {}), note: note || null };
}

/* ---------- veto ---------- */

function resolveVeto(g, rand) {
  const s = settingsOf(g);
  let survivors = g.options.filter((o) => !g.tally[o.id]);
  if (survivors.length === 0) {
    // Everything was vetoed: keep the least-vetoed options.
    const min = Math.min(...g.options.map((o) => g.tally[o.id]));
    survivors = g.options.filter((o) => g.tally[o.id] === min);
  }
  const keep = new Set(survivors.map((o) => o.id));
  g.vetoed = g.options.filter((o) => !keep.has(o.id)).map((o) => o.id);
  g.options = survivors;
  if (survivors.length === 1) {
    g.result = { kind: 'veto', vetoed: g.vetoed };
    return win(g, survivors[0].id, null, rand);
  }
  // Hand the survivors to the follow-up method.
  const vetoed = g.vetoed;
  g.method = s.vetoThen === 'vote' ? 'vote' : 'random';
  g.settings = { ...g.settings, voteStyle: 'single', randomTarget: 'option' };
  delete g.tally; delete g.ballotCount; delete g.vetoesEach;
  initMethod(g, rand);
  g.vetoed = vetoed;
}

/* ---------- bracket ---------- */

function advanceBracket(g, rand) {
  const b = g.bracket;
  for (;;) {
    if (b.queue.length === 1) {
      const lone = b.queue.shift();
      b.history.push({ round: b.round, x: lone, bye: true });
      b.winners.push(lone);
    }
    if (b.queue.length === 0) {
      if (b.winners.length === 1) {
        g.result = { kind: 'bracket', history: b.history };
        return win(g, b.winners[0], null, rand);
      }
      b.queue = b.winners;
      b.winners = [];
      b.round++;
      continue;
    }
    break;
  }
  g.tally = { [b.queue[0]]: 0, [b.queue[1]]: 0 };
  g.voted = [];
  g.ballotCount = 0;
}

function resolveMatch(g, crownName, rand) {
  const b = g.bracket;
  const [x, y] = b.queue;
  const vx = g.tally[x] || 0;
  const vy = g.tally[y] || 0;
  let w = vx > vy ? x : y;
  const coin = vx === vy;
  if (coin) w = rand() < 0.5 ? x : y;
  b.history.push({ round: b.round, x, y, vx, vy, winner: w, coin });
  b.winners.push(w);
  b.queue.splice(0, 2);
  advanceBracket(g, rand);
}

/* ---------- ranked choice (instant runoff) ---------- */

// Each round, count every ballot for its highest-ranked option still in the
// race, and knock out the option with the fewest votes. Ties for last place
// are broken by fewest 2nd-choice votes, then at random. Repeats until one
// option remains.
export function instantRunoff(optionIds, ballots, rand) {
  let remaining = [...optionIds];
  const second = Object.fromEntries(optionIds.map((id) => [id, 0]));
  for (const b of ballots) if (b[1] && b[1] in second) second[b[1]]++;
  const rounds = [];
  while (remaining.length > 1) {
    const counts = Object.fromEntries(remaining.map((id) => [id, 0]));
    let exhausted = 0;
    for (const b of ballots) {
      const top = b.find((id) => id in counts);
      if (top) counts[top]++;
      else exhausted++;
    }
    const min = Math.min(...remaining.map((id) => counts[id]));
    let lowest = remaining.filter((id) => counts[id] === min);
    let tie = null;
    if (lowest.length > 1) {
      const minSecond = Math.min(...lowest.map((id) => second[id]));
      const fewer = lowest.filter((id) => second[id] === minSecond);
      tie = fewer.length === 1 ? 'second' : 'random';
      lowest = fewer;
    }
    const out = lowest[Math.floor(rand() * lowest.length)];
    rounds.push({ counts, exhausted, eliminated: out, tie });
    remaining = remaining.filter((id) => id !== out);
  }
  return { winner: remaining[0], rounds };
}
