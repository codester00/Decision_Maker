// "Find nearby" data: restaurants and activities from OpenStreetMap
// (Overpass API, free, no key), city/ZIP lookup from Nominatim, and
// movies now playing from TMDB (free key, set in js/api-keys.js).

import { tmdbKey } from './api-keys.js';

/* ---------- categories ----------
   Each sub-category is a list of Overpass tag filters; results must also
   have a name. Cuisine values in OpenStreetMap look like "pizza;italian". */

const FOOD = '["amenity"~"^(restaurant|fast_food)$"]';
const CUISINE_RE = {};
const cuisine = (re) => `${FOOD}["cuisine"~"${re}",i]`;

export const CATEGORIES = {
  food: {
    label: 'Restaurants', short: 'Food', icon: '🍽️',
    subs: [
      { id: 'any', label: 'Any', q: [FOOD] },
      { id: 'american', label: 'American', q: [cuisine('american|diner|steak|chicken|wings')] },
      { id: 'pizza', label: 'Pizza', q: [cuisine('pizza')] },
      { id: 'mexican', label: 'Mexican', q: [cuisine('mexican|tex-mex|burrito|taco')] },
      { id: 'italian', label: 'Italian', q: [cuisine('italian|pasta')] },
      { id: 'chinese', label: 'Chinese', q: [cuisine('chinese|dim_sum')] },
      { id: 'japanese', label: 'Japanese & sushi', q: [cuisine('japanese|sushi|ramen')] },
      { id: 'thai', label: 'Thai', q: [cuisine('thai')] },
      { id: 'indian', label: 'Indian', q: [cuisine('indian|curry')] },
      { id: 'vietnamese', label: 'Vietnamese', q: [cuisine('vietnamese|pho')] },
      { id: 'korean', label: 'Korean', q: [cuisine('korean')] },
      { id: 'mediterranean', label: 'Mediterranean', q: [cuisine('mediterranean|greek|lebanese|middle_eastern|turkish|falafel|kebab')] },
      { id: 'burger', label: 'Burgers', q: [cuisine('burger')] },
      { id: 'bbq', label: 'BBQ', q: [cuisine('barbecue|bbq')] },
      { id: 'breakfast', label: 'Breakfast', q: [cuisine('breakfast|pancake|brunch|waffle')] },
      { id: 'seafood', label: 'Seafood', q: [cuisine('seafood|fish')] },
      { id: 'sandwich', label: 'Sandwiches', q: [cuisine('sandwich|deli|bagel|sub')] },
      { id: 'fastfood', label: 'Fast food', q: ['["amenity"="fast_food"]'] },
      {
        id: 'dessert', label: 'Dessert & coffee',
        q: ['["amenity"~"^(ice_cream|cafe)$"]', '["shop"~"^(bakery|pastry|confectionery)$"]',
          cuisine('ice_cream|dessert|donut|frozen_yogurt|cupcake|crepe')],
      },
    ],
  },
  activities: {
    label: 'Activities', icon: '🎯',
    subs: [
      { id: 'parks', label: 'Parks & playgrounds', q: ['["leisure"~"^(park|playground|nature_reserve|dog_park)$"]'] },
      { id: 'museums', label: 'Museums', q: ['["tourism"~"^(museum|gallery)$"]'] },
      { id: 'zoos', label: 'Zoos & aquariums', q: ['["tourism"~"^(zoo|aquarium)$"]'] },
      { id: 'bowling', label: 'Bowling', q: ['["leisure"="bowling_alley"]'] },
      { id: 'minigolf', label: 'Mini golf', q: ['["leisure"="miniature_golf"]'] },
      { id: 'arcades', label: 'Arcades', q: ['["leisure"="amusement_arcade"]'] },
      { id: 'trampoline', label: 'Trampoline parks', q: ['["leisure"="trampoline_park"]'] },
      { id: 'escape', label: 'Escape rooms', q: ['["leisure"="escape_game"]'] },
      {
        id: 'swim', label: 'Swimming & water parks',
        q: ['["leisure"~"^(water_park|swimming_area)$"]', '["leisure"="swimming_pool"]["access"!~"private|customers|members"]'],
      },
      { id: 'skating', label: 'Skating', q: ['["leisure"="ice_rink"]', '["sport"~"roller_skating|skateboard",i]["leisure"~"^(sports_centre|pitch)$"]'] },
      { id: 'climbing', label: 'Climbing', q: ['["sport"~"climbing",i]["leisure"~"^(sports_centre|pitch)$"]'] },
      { id: 'themeparks', label: 'Theme parks', q: ['["tourism"="theme_park"]'] },
      { id: 'cinemas', label: 'Movie theaters', q: ['["amenity"="cinema"]'] },
      { id: 'libraries', label: 'Libraries', q: ['["amenity"="library"]'] },
      { id: 'sights', label: 'Sights', q: ['["tourism"~"^(attraction|viewpoint)$"]'] },
    ],
  },
  movies: { label: 'Movies', icon: '🎬', subs: [] },
};

// "Any" activity, kept to three lookups so it stays quick for the server.
CATEGORIES.activities.subs.unshift({
  id: 'any', label: 'Any',
  q: [
    '["leisure"~"^(park|playground|bowling_alley|miniature_golf|amusement_arcade|trampoline_park|escape_game|water_park|ice_rink)$"]',
    '["tourism"~"^(museum|gallery|zoo|aquarium|theme_park|attraction)$"]',
    '["amenity"~"^(cinema|library)$"]',
  ],
});

/* Fallback search (Nominatim) when the Overpass servers are down: search
   phrases per sub-category, plus a client-side cuisine filter for food.
   Nominatim returns at most 50 results per phrase and allows ~1 request/s. */
const NOMINATIM_PHRASES = {
  food: { any: ['restaurant', 'fast food'], fastfood: ['fast food'], dessert: ['ice cream', 'cafe'] },
  activities: {
    any: ['museum', 'park', 'cinema'], parks: ['park', 'playground'], museums: ['museum'], zoos: ['zoo', 'aquarium'],
    bowling: ['bowling alley'], minigolf: ['miniature golf'], arcades: ['amusement arcade'], trampoline: ['trampoline park'],
    escape: ['escape room'], swim: ['water park', 'swimming pool'], skating: ['ice rink'], climbing: ['climbing'],
    themeparks: ['theme park'], cinemas: ['cinema'], libraries: ['library'], sights: ['attraction'],
  },
};
for (const sub of CATEGORIES.food.subs) {
  const m = sub.q.map((q) => q.match(/\["cuisine"~"([^"]+)"/)).find(Boolean);
  if (m) CUISINE_RE[sub.id] = new RegExp(m[1], 'i');
}

/* ---------- distance ---------- */

export const USES_MILES = /^en-(US|GB|LR|MM)/i.test(navigator.language || '');
export const RADII = USES_MILES ? [1, 3, 5, 10, 25] : [2, 5, 10, 20, 40];
const UNIT_KM = USES_MILES ? 1.609344 : 1;
export const unitLabel = USES_MILES ? 'mi' : 'km';

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function formatDistance(km) {
  const v = km / UNIT_KM;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unitLabel}`;
}

/* ---------- OpenStreetMap ---------- */

// Public Overpass servers. The main one is tried first; it allows each
// internet connection only a couple of searches at a time ("429" when busy)
// and is sometimes overloaded ("502"/"504"). If it fails, the backups and the
// Nominatim fallback are asked at the same time.
const OVERPASS = [
  { url: 'https://overpass-api.de/api/interpreter', name: 'main server' },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', name: 'backup server 1' },
  { url: 'https://overpass.private.coffee/api/interpreter', name: 'backup server 2' },
];

export function buildQuery(selectors, lat, lon, radius) {
  const meters = Math.round(radius * UNIT_KM * 1000);
  const parts = selectors.map((s) => `nwr${s}["name"](around:${meters},${lat.toFixed(5)},${lon.toFixed(5)});`).join('');
  return `[out:json][timeout:25];(${parts});out center tags 400;`;
}

class Timeout extends Error {}

// fetch with a time limit; also stops early if `outer` (the caller's signal) aborts.
async function fetchWithTimeout(url, options = {}, ms = 30000, outer = null) {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const onOuter = () => ctrl.abort();
  if (outer) outer.addEventListener('abort', onOuter);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new Timeout('timed out');
    throw e;
  } finally {
    clearTimeout(t);
    if (outer) outer.removeEventListener('abort', onOuter);
  }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

function reasonFor(e, res) {
  if (res && res.status === 429) return 'too many searches right now';
  if (res && res.status === 504) return 'overloaded';
  if (res) return `error ${res.status}`;
  if (e instanceof Timeout) return 'took too long';
  return "couldn't connect";
}

export class SearchError extends Error {
  constructor(reasons) { super(reasons.join('; ')); this.reasons = reasons; }
}

async function overpassOnce(server, body, loc, ms, signal) {
  let res = null;
  try {
    res = await fetchWithTimeout(server.url, {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, ms, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.remark && /runtime error/i.test(json.remark) && !(json.elements || []).length) throw new Error(json.remark);
    return parsePlaces(json, loc);
  } catch (e) {
    if (e.name === 'AbortError' && signal && signal.aborted) throw e;
    const err = new Error(reasonFor(e, res));
    err.status = res && res.status;
    throw err;
  }
}

// Resolves to { results, limited }. `limited` means the results came from the
// simpler Nominatim fallback. Throws SearchError (a reason per server) if
// everything fails, or an AbortError if a newer search replaced this one.
export async function searchPlaces(catId, subId, loc, radius, signal = null) {
  const sub = CATEGORIES[catId].subs.find((s) => s.id === subId) || CATEGORIES[catId].subs[0];
  const body = 'data=' + encodeURIComponent(buildQuery(sub.q, loc.lat, loc.lon, radius));
  const reasons = [];
  const [main, ...backups] = OVERPASS;

  // 1. Main server, with one retry if it's just busy.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { results: await overpassOnce(main, body, loc, 12000, signal), limited: false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt === 0 && e.status === 429) { await wait(3000, signal); continue; }
      reasons.push(`${main.name}: ${e.message}`);
      break;
    }
  }

  // 2. Backups and the fallback at the same time; prefer a backup's full results.
  const fallback = searchNominatim(catId, sub.id, loc, radius, signal).then(
    (results) => ({ results, limited: true }),
    (e) => { if (e.name === 'AbortError') throw e; reasons.push(`simple search: ${e.message}`); return null; },
  );
  fallback.catch(() => {}); // not awaited if a backup wins; avoid an unhandled rejection warning
  const backupWin = Promise.any(backups.map((srv) => overpassOnce(srv, body, loc, 10000, signal).catch((e) => {
    if (e.name !== 'AbortError') reasons.push(`${srv.name}: ${e.message}`);
    throw e;
  }))).then((results) => ({ results, limited: false }));
  backupWin.catch(() => {});
  // Once the fallback has an answer, give the backups only 3 more seconds.
  const fallbackSoon = fallback.then((fb) => (fb ? wait(3000, signal).then(() => fb) : new Promise(() => {})));
  const first = await Promise.race([backupWin, fallbackSoon]).catch(() => null);
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (first) return first;
  const fb = await fallback;
  if (fb) return fb;
  throw new SearchError(reasons);
}

async function searchNominatim(catId, subId, loc, radius, signal) {
  const phrases = NOMINATIM_PHRASES[catId][subId] || NOMINATIM_PHRASES[catId].any;
  const km = radius * UNIT_KM;
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((loc.lat * Math.PI) / 180));
  const viewbox = [loc.lon - dLon, loc.lat + dLat, loc.lon + dLon, loc.lat - dLat].map((v) => v.toFixed(5)).join(',');
  const re = catId === 'food' ? CUISINE_RE[subId] : null;
  const elements = [];
  for (const [i, phrase] of phrases.entries()) {
    if (i > 0) await wait(1100, signal); // Nominatim asks for at most one request per second
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=50&bounded=1&extratags=1'
      + `&viewbox=${viewbox}&q=${encodeURIComponent(phrase)}`;
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10000, signal);
    } catch (e) {
      if (e.name === 'AbortError' && signal && signal.aborted) throw e;
      throw new Error(reasonFor(e, null));
    }
    if (!res.ok) throw new Error(reasonFor(null, res));
    for (const r of await res.json()) {
      const tags = { ...(r.extratags || {}), name: r.name, [r.category]: r.type };
      if (re && !(re.test(tags.cuisine || '') || re.test(r.name || ''))) continue;
      elements.push({ type: r.osm_type, id: r.osm_id, lat: Number(r.lat), lon: Number(r.lon), tags });
    }
  }
  return parsePlaces({ elements }, loc).filter((p) => p.km <= km);
}

const pretty = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function describe(t) {
  if (t.cuisine) return t.cuisine.split(/[;,]/).map((c) => pretty(c.trim())).filter(Boolean).slice(0, 3).join(', ');
  const kind = t.amenity || t.leisure || t.tourism || t.shop || '';
  return kind ? pretty(kind) : '';
}

// Turn Overpass results into a list sorted by distance, one entry per name
// (chains keep their nearest location).
export function parsePlaces(json, loc) {
  const byName = new Map();
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const name = (t.name || '').trim();
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat == null || lon == null) continue;
    const km = distanceKm(loc.lat, loc.lon, lat, lon);
    const key = name.toLowerCase();
    const prev = byName.get(key);
    if (prev && prev.km <= km) continue;
    byName.set(key, { id: `${el.type}/${el.id}`, name, km, detail: describe(t), street: t['addr:street'] || '' });
  }
  return [...byName.values()].sort((a, b) => a.km - b.km).slice(0, 80);
}

// City, address or ZIP -> { lat, lon, label }
export async function geocode(text) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=' + encodeURIComponent(text);
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit) return null;
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name.split(',').slice(0, 2).join(',').trim() };
}

export function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'your location' }),
      (e) => reject(e),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

/* ---------- movies (TMDB) ---------- */

export const moviesEnabled = !!tmdbKey;

export async function nowPlaying() {
  const lang = navigator.language || 'en-US';
  const region = (lang.split('-')[1] || 'US').toUpperCase();
  // Accepts either the short "API Key" or the long "API Read Access Token".
  const bearer = tmdbKey.length > 40;
  const base = 'https://api.themoviedb.org/3/movie/now_playing';
  const pages = await Promise.all([1, 2].map(async (page) => {
    const url = `${base}?language=${encodeURIComponent(lang)}&region=${region}&page=${page}${bearer ? '' : `&api_key=${encodeURIComponent(tmdbKey)}`}`;
    const res = await fetchWithTimeout(url, { headers: bearer ? { Authorization: `Bearer ${tmdbKey}`, Accept: 'application/json' } : { Accept: 'application/json' } }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).results || [];
  }));
  const seen = new Set();
  return pages.flat().filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => ({
    id: 'tmdb/' + m.id,
    name: m.title,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    year: (m.release_date || '').slice(0, 4),
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : null,
  })).sort((a, b) => (b.rating || 0) - (a.rating || 0));
}
