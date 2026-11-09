# CLAUDE.md

Notes for Claude sessions working on this repo. The README has the user-facing feature list and setup.

## What this is
Family Decision Maker: a mobile-first web app that several phones use together live. It's plain HTML/CSS/vanilla JS (ES modules) with **no build step and no npm dependencies**. Firebase Firestore provides real-time sync. It's hosted on GitHub Pages from `main` at https://codester00.github.io/Decision_Maker/.

The owner is not a developer. Explain things in plain language and give copy-paste-ready snippets and click-by-click steps for anything they must do themselves (Firebase console, GitHub settings).

## Files
- `js/app.js`: everything UI. A tiny `h()` DOM builder, a keyed DOM patcher (`patch`/`patchChildren`) so inputs keep focus while other phones' updates stream in, state `S`, hash routing (`#/`, `#/stats`, `#/game/CODE`, `#/join/CODE`), actions, views.
- `js/methods.js`: the decision methods. `METHODS` registry plus **pure** game logic (`startPlay`, `applyBallot`, `resolveBallots`, `instantRunoff`, bracket, veto, tie-breaks, `spin`, `eliminate`, `resetToOptions`). No DOM or network, so it can be unit-tested directly in Node (`import * as M from './js/methods.js'`). It throws `RuleError`, which `updateGame` in app.js turns into a user-facing message.
- `js/places.js`: "Find nearby" for option entry. `CATEGORIES` (food/activities sub-categories as Overpass tag filters; movies), `buildQuery`, `searchPlaces` (Overpass, POST, falls back from overpass-api.de to overpass.private.coffee), `parsePlaces` (dedupes chains by name, sorts by distance), `geocode` (Nominatim), `locateMe` (browser geolocation), `nowPlaying` (TMDB; key in `js/api-keys.js`, `null` hides the movie list). Results are added through the normal `addOption`, so the hidden-options rules apply.
- `js/store.js`: data layer with two backends. `FirebaseStore` (Firestore plus anonymous auth, SDK loaded from gstatic CDN v10.14.1) and `LocalStore` (localStorage; `storage` events sync between tabs). Interface: `watch`, `get`, `update(col, id, fn)`, where `fn(cur)` returns the new doc, `null` to delete, or `undefined` for no-op, and throwing aborts. **All writes go through `update` (a transaction).**
- `js/firebase-config.js`: the real project config (project `decision-maker-6207f`). Not secret.
- `firestore.rules`: the source of truth for the rules, but **changes must be pasted into the Firebase console by the owner** (Firestore → Rules → Publish). No Firebase CLI is set up.

## Data model
- `families/{code}`: `{ members: [{id, name, decisions, positions: {"1": n}}], activeGame, createdAt }`. The `members` array order is the priority order.
- `games/{code}`: `{ host, family, crown, familyNames, phase: lobby|options|play|tiebreak|winner, method, settings, players: [{id, name, device}], options: [{id, text}], createdAt }` plus per-round fields that `clearPlay` removes: `playId` (unique per round; part of `ballotRound`), `allOptions`/`setup` (to restore for "decide again"), `names` (id → text), `voted`, `tally`, `ballotCount`, `ballots` (ranked: `[{r: [ids]}]`, since Firestore can't nest arrays), `order`/`turn` (elimination), `bracket` (`{ round, rounds: [{ matches: [{x, y, winner, vx, vy, coin, bye}] }] }`, built in full at the start; old queue-style brackets are reset by `normalizeGame`), `spin`, `tie`, `vetoed`, `pointsEach`, `vetoesEach`, `winner`, `result`.
- Old game docs (`phase: 'eliminate'`, no `method`) are upgraded on read by `normalizeGame`.
- `device` is a per-phone client id (localStorage; per tab in demo mode).
- Real family data lives in Firestore, so **keep the code compatible with existing documents** (treat new fields as optional, default them on read).

## Rules the owner agreed to (don't break them)
- Group decisions never touch the priority list or stats, store no record of who suggested, eliminated or voted for what (totals only; ranked ballots unnamed and randomly placed), and are deleted when the host ends them.
- Secrecy rules: options are hidden from other phones while being added unless the host sets `settings.showOptions`, and shuffled at `startPlay`. A phone's own option ids live only in its sessionStorage (`fdm:myopts:CODE`). In Elimination each phone shows the list as of its own last turn (`S.elimSnap`; phones without players stay on the starting list), and the host must explicitly choose "play for" to see the live list on someone else's turn. Bracket ballots cover a whole round at once.
- Players can join at any phase (`addPlayer`): mid-Elimination they're appended to `order`; mid-vote they vote in the current round. Removing players is only allowed in lobby/options.
- Ranked choice eliminates in batches when tied-for-last options' combined votes are below the next option (covers zero-vote options); otherwise fewest 2nd choices, then random. `round.eliminated` is an array.
- Tie-breaks: 👑 (`g.crown`, the family's #1 when the game started or was reset) if playing, else random. Ranked choice: fewest 2nd choices, then random. Bracket: coin flip.
- Only one game per family: claim `activeGame` atomically (compare-and-set in `createGame`); replacing a game deletes the old one.
- A player name appears once per game and belongs to exactly one phone.
- Delete/Edit modes stay on until Done. Deferring (tapping someone below #1) asks for confirmation.

## Testing
- **The sandbox can't reach gstatic.com or github.io**, so the app can't run against real Firebase in a browser here. Test UI in **demo mode**: serve with `python3 -m http.server 8765` and open `http://localhost:8765/?demo`. `?demo` forces LocalStore and uses separate prefs (`fdm:pref:demo:*`), so it never mixes with real data.
- Simulate multiple phones with Playwright: several pages in **one** browser context share localStorage, and each page gets its own client id.
- The `Decision_Maker` cloud environment allows overpass-api.de, overpass.private.coffee and nominatim.openstreetmap.org for testing place search. overpass-api.de drops sandbox traffic and private.coffee is slow (retry in the background). Browser tests mock these with Playwright `context.route` and fake geolocation.
- Firebase backend checks (auth, rules) can be done from Node with the `firebase` npm package in the scratchpad (googleapis hosts are reachable).
- Firestore rejects shapes demo mode accepts (nested arrays, `undefined`), so after changing game data, write sample docs to real Firestore from Node (a throwaway `games/ZZ...` doc, deleted afterwards).
- Run `node --check js/*.js` before committing. Never commit test scripts or `node_modules`.

## Deploying
Pushing to `main` deploys via GitHub Pages in about a minute. Phones pick it up on refresh (home-screen app: close and reopen).
