// Tiny data layer with two interchangeable backends:
//   - FirebaseStore: Cloud Firestore, shared live between all phones.
//   - LocalStore:    localStorage, for demo mode. Tabs in the same browser
//                    see each other's changes, so each tab can act as a "phone".
//
// Interface (both backends):
//   watch(collection, id, onData, onError) -> unsubscribe()   onData(doc | null)
//   get(collection, id) -> Promise<doc | null>
//   update(collection, id, fn) -> Promise
//       Runs fn(currentDocOrNull) atomically. fn returns the new document,
//       null to delete it, or undefined to leave it unchanged. Throwing aborts.

import { firebaseConfig } from './firebase-config.js';

// Add ?demo to the address to force demo mode (handy for trying things out
// without touching the real family data).
export const isDemo = !(firebaseConfig && firebaseConfig.apiKey) || new URLSearchParams(location.search).has('demo');

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

class LocalStore {
  constructor() {
    this.mode = 'local';
    this.listeners = new Map();
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.startsWith('fdm:db:')) this._emit(e.key);
    });
  }

  _key(col, id) { return `fdm:db:${col}/${id}`; }

  _read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _emit(key) {
    const set = this.listeners.get(key);
    if (set) set.forEach((cb) => cb(this._read(key)));
  }

  watch(col, id, onData) {
    const key = this._key(col, id);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    const set = this.listeners.get(key);
    const cb = (d) => onData(d);
    set.add(cb);
    queueMicrotask(() => { if (set.has(cb)) cb(this._read(key)); });
    return () => set.delete(cb);
  }

  async get(col, id) { return this._read(this._key(col, id)); }

  async update(col, id, fn) {
    const key = this._key(col, id);
    const next = fn(this._read(key));
    if (next === undefined) return;
    if (next === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
    this._emit(key);
  }
}

class FirebaseStore {
  async init(config) {
    const [appMod, fs, authMod] = await Promise.all([
      import(FIREBASE_SDK + 'firebase-app.js'),
      import(FIREBASE_SDK + 'firebase-firestore.js'),
      import(FIREBASE_SDK + 'firebase-auth.js'),
    ]);
    const app = appMod.initializeApp(config);
    this.fs = fs;
    this.db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
    await authMod.signInAnonymously(authMod.getAuth(app));
    this.mode = 'firebase';
    return this;
  }

  _ref(col, id) { return this.fs.doc(this.db, col, id); }

  watch(col, id, onData, onError) {
    return this.fs.onSnapshot(
      this._ref(col, id),
      (snap) => onData(snap.exists() ? snap.data() : null),
      (err) => { console.error(err); if (onError) onError(err); },
    );
  }

  async get(col, id) {
    const snap = await this.fs.getDoc(this._ref(col, id));
    return snap.exists() ? snap.data() : null;
  }

  async update(col, id, fn) {
    const ref = this._ref(col, id);
    await this.fs.runTransaction(this.db, async (tx) => {
      const snap = await tx.get(ref);
      const next = fn(snap.exists() ? snap.data() : null);
      if (next === undefined) return;
      if (next === null) tx.delete(ref);
      else tx.set(ref, next);
    });
  }
}

export async function createStore() {
  if (!isDemo) return new FirebaseStore().init(firebaseConfig);
  return new LocalStore();
}
