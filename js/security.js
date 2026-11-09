// Family PIN protection. Stored on the family document as
//   security: { pinHash, salt, protect: { [actionKey]: true } }
// The PIN itself is never stored, only a salted SHA-256 hash. This keeps
// kids from casually changing things; it is not strong security (anyone with
// the family code and developer tools can reach the data).

export const SECTIONS = [
  {
    id: 'decide', label: '👑 Decision maker',
    items: [
      ['decide.tap', 'Record who made a decision'],
      ['decide.undo', 'Undo a decision'],
      ['decide.add', 'Add people'],
      ['decide.edit', 'Rename people'],
      ['decide.delete', 'Delete people'],
      ['decide.reset', 'Reset statistics'],
      ['decide.game', 'Start or replace a group decision'],
      ['decide.endGame', 'End a group decision'],
    ],
  },
  {
    id: 'trackers', label: '📋 Trackers',
    items: [
      ['trk.done', 'Record Done'],
      ['trk.actual', 'Record who actually did it'],
      ['trk.absent', 'Mark someone away or back'],
      ['trk.swap', 'Swap jobs'],
      ['trk.penalty', 'Give penalties'],
      ['trk.undo', 'Undo'],
      ['trk.create', 'Create trackers'],
      ['trk.edit', 'Edit tracker people, jobs and settings'],
      ['trk.delete', 'Delete trackers'],
    ],
  },
];

export const ALL_KEYS = SECTIONS.flatMap((s) => s.items.map(([k]) => k));

export const PRESETS = {
  open: { label: 'Open', keys: [] },
  moderate: {
    label: 'Moderate',
    keys: ['decide.delete', 'decide.reset', 'trk.penalty', 'trk.undo', 'trk.edit', 'trk.delete'],
  },
  all: { label: 'Protect all', keys: ALL_KEYS },
};

export function presetProtect(name) {
  return Object.fromEntries(PRESETS[name].keys.map((k) => [k, true]));
}

// Which preset (if any) matches the current checkboxes.
export function matchingPreset(protect) {
  const on = ALL_KEYS.filter((k) => protect && protect[k]).sort().join();
  return Object.keys(PRESETS).find((name) => [...PRESETS[name].keys].sort().join() === on) || null;
}

export const isValidPin = (pin) => /^\d{4,8}$/.test(pin);

export async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkPin(security, pin) {
  if (!security || !security.pinHash) return true;
  return (await hashPin(pin, security.salt)) === security.pinHash;
}

export const needsPin = (security, key) => !!(security && security.pinHash && security.protect && security.protect[key]);
