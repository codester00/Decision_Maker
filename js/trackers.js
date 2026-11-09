// Trackers: long-term rotations of people through tasks (after-dinner jobs,
// who presses the elevator button...). Pure logic, no DOM or network, so it
// can be unit-tested in Node. Every action function mutates the tracker
// object `t` (a copy of the Firestore document) and records history.
//
// Fairness model (the owner's idea): each round, every present person earns a
// "fair share" of each task that is handed out (1 / number of people sharing
// it). Each time they actually do the task, it counts as a real turn.
//   behind = fair share - effective turns
// Effective turns leave out penalty extras (chores) and count turns lost to a
// penalty (privileges) as used, so penalties never get "evened out" later.
// With Catch-up on, whoever is most behind goes next; the rotation order only
// breaks ties. With nothing unusual happening, that gives exactly the same
// result as the plain rotation.

export const KINDS = {
  privilege: { label: 'Privilege', desc: 'Something fun, like pressing the elevator button. A penalty means losing turns.' },
  chore: { label: 'Chore', desc: 'A job, like doing the dishes. A penalty means doing extra turns.' },
};

export const ORDERS = {
  cycle: { label: 'Straight rotation', desc: 'Same order every time, so everyone can see whose turn is next.' },
  shuffle: { label: 'Fair shuffle', desc: 'Random order, but everyone gets each job once before anyone repeats.' },
  random: { label: 'Random', desc: 'A fresh random pick every time. Can be streaky; Catch-up helps.' },
};

export const DEFAULT_SETTINGS = {
  order: 'cycle',
  catchUp: false, // whoever is furthest behind their fair share goes first
  absence: 'skip', // skip: no share while away; owe: still earn a share, so they're owed turns
  extraJobs: 'one', // one: one job per person, extra jobs unassigned; all: every job assigned
  preview: true, // show "Up next"
};

export class TrackerError extends Error {}

const HISTORY_CAP = 2000;
const UNDO_CAP = 20;
const EPS = 1e-9;

/* ---------- helpers ---------- */

export const settingsOf = (t) => ({ ...DEFAULT_SETTINGS, ...(t.settings || {}) });
export const activePeople = (t) => t.people.filter((p) => p.active !== false);
export const activeTasks = (t) => t.tasks.filter((x) => x.active !== false);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function statsFor(t, pid) {
  if (!t.stats) t.stats = {};
  if (!t.stats[pid]) t.stats[pid] = { turns: {}, share: {}, forfeit: {}, served: {}, penalties: 0, penaltyTurns: 0 };
  return t.stats[pid];
}

const num = (o, k) => (o && o[k]) || 0;

// Turns that count for fairness.
export function effectiveTurns(t, pid, taskId) {
  const s = (t.stats || {})[pid];
  if (!s) return 0;
  return num(s.turns, taskId) - num(s.served, taskId) + num(s.forfeit, taskId);
}

export function behind(t, pid, taskId) {
  const s = (t.stats || {})[pid];
  return (s ? num(s.share, taskId) : 0) - effectiveTurns(t, pid, taskId);
}

/* ---------- creating ---------- */

export function newTracker({ family, name, icon, kind, people, tasks, settings }, seed) {
  const t = {
    family, name, icon: icon || '📋', kind: kind || 'chore',
    people: people.map((p) => ({ id: p.id, name: p.name, memberId: p.memberId || null, active: true })),
    tasks: tasks.map((x) => ({ id: x.id, name: x.name, active: true })),
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    seedBase: seed >>> 0,
    round: 0,
    ptr: {},
    stats: {},
    pending: {},
    roundInfo: { absent: [], swaps: [] },
    history: [],
    undo: [],
    seq: 0,
    createdAt: Date.now(),
  };
  validate(t);
  fixPointers(t);
  return t;
}

export function validate(t) {
  if (!t.name || !t.name.trim()) throw new TrackerError('Give the tracker a name.');
  if (activePeople(t).length < 1) throw new TrackerError('Add at least one person.');
  if (activeTasks(t).length < 1) throw new TrackerError('Add at least one job.');
  const names = activePeople(t).map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new TrackerError('Each person can only be added once.');
}

// Every task gets its own rotation pointer, staggered so that with 3 people
// and 3 jobs everyone starts on a different job.
function fixPointers(t) {
  if (!t.ptr) t.ptr = {};
  const n = Math.max(1, activePeople(t).length);
  activeTasks(t).forEach((task, j) => {
    if (typeof t.ptr[task.id] !== 'number') t.ptr[task.id] = j % n;
  });
}

/* ---------- planning a round ---------- */

// The rotation order of people for this round (ids of active people).
function rotationOrder(t) {
  const ids = activePeople(t).map((p) => p.id);
  if (settingsOf(t).order !== 'shuffle' || ids.length < 2) return ids;
  const cycle = Math.floor((t.round || 0) / ids.length);
  return shuffled(ids, mulberry32((t.seedBase || 1) + cycle * 7919));
}

// Works out who does what this round. Deterministic for a given tracker
// state, so every phone shows the same thing (random modes use a stored seed).
export function plan(t) {
  const s = settingsOf(t);
  const order = rotationOrder(t);
  const n = order.length;
  const absent = new Set((t.roundInfo && t.roundInfo.absent) || []);
  const present = order.filter((id) => !absent.has(id));
  const tasks = activeTasks(t);
  const slots = s.extraJobs === 'all' ? tasks : tasks.slice(0, present.length);
  const unassigned = tasks.filter((x) => !slots.includes(x)).map((x) => x.id);
  const rng = mulberry32(((t.seedBase || 1) ^ Math.imul((t.round || 0) + 1, 2654435761)) >>> 0);
  const pending = { ...(t.pending || {}) };
  const load = {};
  const assignments = [];
  const forfeits = [];
  const privilege = t.kind === 'privilege';

  for (const task of slots) {
    if (!present.length) { assignments.push({ taskId: task.id, personId: null }); continue; }
    const minLoad = Math.min(...present.map((id) => load[id] || 0));
    const pool = present.filter((id) => (load[id] || 0) === minLoad);
    const ptr = t.ptr[task.id] || 0;
    const randRank = s.order === 'random' ? Object.fromEntries(shuffled(pool, rng).map((id, i) => [id, i])) : null;
    const rank = (id) => (randRank ? randRank[id] : (((order.indexOf(id) - ptr) % n) + n) % n);
    const sorted = [...pool].sort((a, b) => {
      if (!privilege) {
        const pa = (pending[a] || 0) > 0 ? 1 : 0;
        const pb = (pending[b] || 0) > 0 ? 1 : 0;
        if (pa !== pb) return pb - pa; // chore penalty: extra turns go first
      }
      if (s.catchUp) {
        const d = behind(t, b, task.id) - behind(t, a, task.id);
        if (Math.abs(d) > EPS) return d;
      }
      return rank(a) - rank(b);
    });
    let pick = sorted[0];
    let penalty = false;
    if (privilege) {
      // Privilege penalty: skip people who are losing turns.
      const free = sorted.find((id) => !((pending[id] || 0) > 0));
      if (free) {
        for (const id of sorted) {
          if (id === free) break;
          forfeits.push({ taskId: task.id, personId: id });
          pending[id] -= 1;
        }
        pick = free;
      }
    } else if ((pending[pick] || 0) > 0) {
      penalty = true;
      pending[pick] -= 1;
    }
    load[pick] = (load[pick] || 0) + 1;
    assignments.push({ taskId: task.id, personId: pick, planned: pick, penalty });
  }

  // Agreed swaps for this round.
  for (const { a, b } of (t.roundInfo && t.roundInfo.swaps) || []) {
    for (const x of assignments) {
      if (x.personId === a) x.personId = b;
      else if (x.personId === b) x.personId = a;
    }
  }
  const busy = new Set(assignments.map((x) => x.personId));
  const off = present.filter((id) => !busy.has(id));
  return { round: t.round || 0, assignments, unassigned, off, absent: [...absent], forfeits };
}

/* ---------- actions ---------- */

function snapshot(t) {
  const { history, undo, ...rest } = t;
  return JSON.stringify(rest);
}

function record(t, entry, phone, now) {
  t.seq = (t.seq || 0) + 1;
  const e = { id: t.seq, at: now || Date.now(), by: phone || '', ...entry };
  if (!t.history) t.history = [];
  t.history.push(e);
  if (t.history.length > HISTORY_CAP) t.history.splice(0, t.history.length - HISTORY_CAP);
  return e;
}

// Save the state before an action so it can be undone.
function remember(t, label) {
  if (!t.undo) t.undo = [];
  t.undo.push({ snap: snapshot(t), label, seq: (t.seq || 0) + 1 });
  if (t.undo.length > UNDO_CAP) t.undo.splice(0, t.undo.length - UNDO_CAP);
}

const personExists = (t, pid) => activePeople(t).some((p) => p.id === pid);

// Record a finished round. `actual` lists who actually did each task
// ([{taskId, personId}]); leave it out to record the round as planned.
export function complete(t, actual, phone, now) {
  const s = settingsOf(t);
  const p = plan(t);
  const did = actual || p.assignments.filter((x) => x.personId).map(({ taskId, personId }) => ({ taskId, personId }));
  for (const d of did) {
    if (!personExists(t, d.personId)) throw new TrackerError('That person is no longer in this tracker.');
    if (!activeTasks(t).some((x) => x.id === d.taskId)) throw new TrackerError('That job is no longer in this tracker.');
  }
  remember(t, 'Done');
  const absent = new Set(p.absent);
  const everyone = activePeople(t).map((x) => x.id);
  const sharers = s.absence === 'owe' ? everyone : everyone.filter((id) => !absent.has(id));

  // Fair shares for each job handed out this round.
  for (const a of p.assignments) {
    if (!a.personId || !sharers.length) continue;
    for (const id of sharers) {
      const st = statsFor(t, id);
      st.share[a.taskId] = num(st.share, a.taskId) + 1 / sharers.length;
    }
  }
  // Real turns.
  for (const d of did) {
    const st = statsFor(t, d.personId);
    st.turns[d.taskId] = num(st.turns, d.taskId) + 1;
  }
  // Penalties carried out.
  if (!t.pending) t.pending = {};
  for (const f of p.forfeits) {
    const st = statsFor(t, f.personId);
    st.forfeit[f.taskId] = num(st.forfeit, f.taskId) + 1;
    t.pending[f.personId] = Math.max(0, (t.pending[f.personId] || 0) - 1);
  }
  for (const a of p.assignments) {
    if (!a.penalty) continue;
    if (did.some((d) => d.taskId === a.taskId && d.personId === a.planned)) {
      const st = statsFor(t, a.planned);
      st.served[a.taskId] = num(st.served, a.taskId) + 1;
      t.pending[a.planned] = Math.max(0, (t.pending[a.planned] || 0) - 1);
    }
  }
  for (const id of Object.keys(t.pending)) if (!t.pending[id]) delete t.pending[id];
  // Move each job's rotation on from whoever's turn it really was:
  // - someone else did it (a steal): the scheduled person keeps their place;
  // - a turn lost to a penalty: the rotation carries on from the person who
  //   lost it, so the turn goes to the next person and nobody else shifts.
  const order = rotationOrder(t);
  const n = Math.max(1, order.length);
  for (const a of p.assignments) {
    if (!a.planned) continue;
    const lost = p.forfeits.find((f) => f.taskId === a.taskId);
    if (lost) t.ptr[a.taskId] = (order.indexOf(lost.personId) + 1) % n;
    else if (did.some((d) => d.taskId === a.taskId && d.personId === a.planned)) t.ptr[a.taskId] = (order.indexOf(a.planned) + 1) % n;
    else t.ptr[a.taskId] = order.indexOf(a.planned) % n;
  }
  const changed = did.length !== p.assignments.filter((x) => x.personId).length
    || did.some((d) => !p.assignments.some((x) => x.taskId === d.taskId && x.personId === d.personId));
  record(t, {
    type: 'done',
    round: (t.round || 0) + 1,
    did,
    planned: changed ? p.assignments.filter((x) => x.personId).map(({ taskId, personId }) => ({ taskId, personId })) : null,
    absent: p.absent,
    forfeits: p.forfeits,
  }, phone, now);
  t.round = (t.round || 0) + 1;
  // Swaps are for one round; "away" stays until they're marked back.
  t.roundInfo = { absent: t.roundInfo.absent || [], swaps: [] };
}

// "Away" stays on until they're marked back.
export function setAbsent(t, pid, isAbsent, phone, now) {
  if (!personExists(t, pid)) throw new TrackerError('That person is no longer in this tracker.');
  const set = new Set(t.roundInfo.absent || []);
  if (set.has(pid) === isAbsent) return;
  remember(t, isAbsent ? 'Mark absent' : 'Mark back');
  if (isAbsent) set.add(pid); else set.delete(pid);
  t.roundInfo.absent = [...set];
  record(t, { type: isAbsent ? 'absent' : 'back', person: pid }, phone, now);
}

export function swap(t, a, b, phone, now) {
  if (a === b) throw new TrackerError('Pick two different people.');
  if (!personExists(t, a) || !personExists(t, b)) throw new TrackerError('That person is no longer in this tracker.');
  remember(t, 'Swap');
  t.roundInfo.swaps = [...(t.roundInfo.swaps || []), { a, b }];
  record(t, { type: 'swap', a, b }, phone, now);
}

export function penalize(t, pid, count, note, phone, now) {
  const n = Math.floor(Number(count));
  if (!personExists(t, pid)) throw new TrackerError('Pick who gets the penalty.');
  if (!(n >= 1 && n <= 99)) throw new TrackerError('Pick a number from 1 to 99.');
  remember(t, 'Penalty');
  const others = activePeople(t).filter((p) => p.id !== pid);
  const tasks = activeTasks(t);
  if (t.kind === 'privilege' && settingsOf(t).catchUp && others.length) {
    // Exact and permanent: move n turns of fair share from them to everyone else.
    for (const task of tasks) {
      const amount = n / tasks.length;
      const st = statsFor(t, pid);
      st.share[task.id] = num(st.share, task.id) - amount;
      for (const o of others) {
        const os = statsFor(t, o.id);
        os.share[task.id] = num(os.share, task.id) + amount / others.length;
      }
    }
  } else {
    // Skip their next n turns (privilege) or give them the next n jobs (chore).
    if (!t.pending) t.pending = {};
    t.pending[pid] = (t.pending[pid] || 0) + n;
  }
  const st = statsFor(t, pid);
  st.penalties += 1;
  st.penaltyTurns += n;
  record(t, { type: 'penalty', person: pid, count: n, note: (note || '').trim().slice(0, 120) || null }, phone, now);
}

// Change the name, icon, kind, people, jobs or settings. Stats are kept for
// people and jobs that are removed (they're just marked inactive).
export function edit(t, changes, phone, now) {
  remember(t, 'Edit');
  const before = JSON.stringify([t.name, t.icon, t.kind, t.settings, t.people, t.tasks]);
  if (changes.name !== undefined) t.name = changes.name.trim().slice(0, 40);
  if (changes.icon !== undefined) t.icon = changes.icon;
  if (changes.kind !== undefined) t.kind = changes.kind;
  if (changes.settings) t.settings = { ...settingsOf(t), ...changes.settings };
  if (changes.people) {
    const keep = new Map(changes.people.map((p) => [p.id, p]));
    const merged = changes.people.map((p) => ({ id: p.id, name: p.name.trim().slice(0, 30), memberId: p.memberId || null, active: true }));
    for (const old of t.people) if (!keep.has(old.id)) merged.push({ ...old, active: false });
    t.people = merged;
    t.roundInfo.absent = (t.roundInfo.absent || []).filter((id) => keep.has(id));
    t.roundInfo.swaps = (t.roundInfo.swaps || []).filter(({ a, b }) => keep.has(a) && keep.has(b));
  }
  if (changes.tasks) {
    const keep = new Set(changes.tasks.map((x) => x.id));
    const merged = changes.tasks.map((x) => ({ id: x.id, name: x.name.trim().slice(0, 40), active: true }));
    for (const old of t.tasks) if (!keep.has(old.id)) merged.push({ ...old, active: false });
    t.tasks = merged;
  }
  validate(t);
  fixPointers(t);
  const n = Math.max(1, activePeople(t).length);
  for (const k of Object.keys(t.ptr)) t.ptr[k] %= n;
  if (JSON.stringify([t.name, t.icon, t.kind, t.settings, t.people, t.tasks]) === before) {
    t.undo.pop();
    return false;
  }
  record(t, { type: 'edit' }, phone, now);
  return true;
}

export function undo(t, phone, now) {
  const last = (t.undo || []).pop();
  if (!last) throw new TrackerError('Nothing to undo.');
  const keepHistory = t.history || [];
  const keepUndo = t.undo;
  const restored = JSON.parse(last.snap);
  for (const k of Object.keys(t)) if (k !== 'history' && k !== 'undo') delete t[k];
  Object.assign(t, restored, { history: keepHistory, undo: keepUndo });
  const undone = keepHistory.find((e) => e.id === last.seq);
  if (undone) undone.undone = true;
  t.seq = Math.max(t.seq || 0, ...keepHistory.map((e) => e.id || 0));
  record(t, { type: 'undo', of: last.label }, phone, now);
}

export const lastUndoLabel = (t) => ((t.undo || []).length ? t.undo[t.undo.length - 1].label : null);

/* ---------- reading ---------- */

// The next few rounds, assuming everything goes as planned.
export function preview(t, count) {
  const sim = JSON.parse(snapshot(t));
  sim.history = [];
  sim.undo = [];
  sim.roundInfo = { absent: (t.roundInfo && t.roundInfo.absent) || [], swaps: [] };
  const out = [];
  complete(sim, null, '', 0);
  for (let i = 0; i < count; i++) {
    out.push(plan(sim));
    complete(sim, null, '', 0);
  }
  return out;
}

// Per-person totals for the stats page.
export function summary(t) {
  return activePeople(t).map((p) => {
    const s = (t.stats || {})[p.id] || {};
    const tasks = activeTasks(t);
    const turns = tasks.reduce((sum, x) => sum + num(s.turns, x.id), 0);
    const share = tasks.reduce((sum, x) => sum + num(s.share, x.id), 0);
    const eff = tasks.reduce((sum, x) => sum + effectiveTurns(t, p.id, x.id), 0);
    return {
      id: p.id,
      turns,
      byTask: Object.fromEntries(tasks.map((x) => [x.id, num(s.turns, x.id)])),
      share,
      behind: share - eff,
      penalties: s.penalties || 0,
      penaltyTurns: s.penaltyTurns || 0,
      pending: (t.pending || {})[p.id] || 0,
    };
  });
}

// Cumulative turns per person after each round (for the "over time" chart).
export function timeline(t) {
  const ids = activePeople(t).map((p) => p.id);
  const totals = Object.fromEntries(ids.map((id) => [id, 0]));
  const points = [{ round: 0, values: { ...totals } }];
  for (const e of t.history || []) {
    if (e.type !== 'done' || e.undone) continue;
    for (const d of e.did || []) if (d.personId in totals) totals[d.personId] += 1;
    points.push({ round: e.round, at: e.at, values: { ...totals } });
  }
  return points;
}
