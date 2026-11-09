// "Find nearby" data: restaurants and activities from OpenStreetMap
// (Overpass API, free, no key), city/ZIP lookup from Nominatim, and
// movies now playing from TMDB (free key, set in js/api-keys.js).

import { tmdbKey } from './api-keys.js';

/* ---------- categories ----------
   Each sub-category is a list of Overpass tag filters; results must also
   have a name. Cuisine values in OpenStreetMap look like "pizza;italian". */

const FOOD = '["amenity"~"^(restaurant|fast_food)$"]';
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

// "Any" for activities = every activity sub-category.
CATEGORIES.activities.subs.unshift({
  id: 'any', label: 'Any',
  q: CATEGORIES.activities.subs.flatMap((s) => s.q),
});

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

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export function buildQuery(selectors, lat, lon, radius) {
  const meters = Math.round(radius * UNIT_KM * 1000);
  const parts = selectors.map((s) => `nwr${s}["name"](around:${meters},${lat.toFixed(5)},${lon.toFixed(5)});`).join('');
  return `[out:json][timeout:25];(${parts});out center tags 400;`;
}

async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function searchPlaces(catId, subId, loc, radius) {
  const sub = CATEGORIES[catId].subs.find((s) => s.id === subId) || CATEGORIES[catId].subs[0];
  const body = 'data=' + encodeURIComponent(buildQuery(sub.q, loc.lat, loc.lon, radius));
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parsePlaces(await res.json(), loc);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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
