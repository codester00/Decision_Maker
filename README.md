# Family Decision Maker

A small web app with the decision-making methods our family finds most useful. It runs in any phone or PC browser. Phones stay in sync live through Firebase, so people can use it together from different places.

## Features

### Priority list ("who decides?")
- One shared, ordered family list. **#1 (👑) gets to make the next decision.**
- Tap the person who made a decision and they move to the bottom.
  - Tapping #1 moves them right away. An **Undo** button appears for a few seconds.
  - Tapping someone lower asks for confirmation first ("Emma and Jake deferred their turn. Sophie decides?"). Only that person moves; everyone above keeps their place.
- ➕ add, 🗑️ delete mode, ✏️ edit mode. Delete and edit modes stay on until you tap **Done**.
- Names must be unique (not case-sensitive).

### Statistics (📊)
- For each person: total decisions, plus what position they were in when they decided (`#1: 12, #2: 2`). Counts are all-time until someone taps **Reset statistics** (asks for confirmation; the list order is kept). Deleting a person deletes their statistics.

### Decide together (🎲)
Group decisions on everyone's phones. They are completely separate from the priority list: they never change the order or the statistics. **Only one per family runs at a time:** starting one while another is running asks whether to join it or end it for everyone and start fresh.

1. **Players.** Family members tap the banner on their home screen (or enter the game code / open the shared link) and add themselves. One phone can add several people (for example, kids without phones), but each person plays from only one phone. Minimum 2 players. **Latecomers can join at any point:** mid-Elimination they go to the end of the turn order; mid-vote they vote in the current round.
2. **Options.** Everyone adds options from their own phone at the same time. By default **each phone sees only its own options** (plus a count of the others) until the decision starts; the host can switch to showing everyone's, which also lets the host remove any option. When the decision starts, options are shuffled so their order doesn't hint at who added them.
3. **Method.** The host picks how to decide (everyone sees the choice live) and starts:

| Method | How it works | Host settings |
| --- | --- | --- |
| 🎯 Elimination | Players take turns (in a shuffled, fixed order) knocking out one option until one is left. Each phone sees the list as it was after its own last turn and only catches up on its next turn, so nobody can tell who knocked out what. | |
| 🎡 Random pick | The host spins; every phone watches the same spin. | Pick an option, or a person to decide |
| 🗳️ Vote | Secret vote; most votes wins. | One choice each, or approval (tick all you like) |
| 💰 Points | Spread your points however you like, all on one option or split. | Points per person (default: one per option); most points on one option |
| 🥇 Ranked choice | Rank favorites. Each round the option with the fewest first choices is knocked out and those ballots move to their next choice, until one is left. Options with no first-choice votes all go in round 1, and options tied for last whose combined votes still trail the next option go together. Revealed round by round. | |
| 🚫 Veto round | Everyone secretly vetoes options; the survivors go to a random pick or a vote. If everything is vetoed, the least-vetoed options survive. | Vetoes per person; then random or vote |
| 🏆 Bracket | The whole bracket is shown from the start (with byes if needed). Each round, every voter picks a favorite in **all** of that round's matchups, then passes the phone. | |
| ⭐ Star rating | Rate every option 0–5 stars; highest total wins. | |

4. **Results.** The winner and the breakdown are shown on every phone. The host can **decide again with the same options** (maybe with another method), **start over**, or **end the game**, which deletes it completely.

**Ties:** for votes, points and stars, the family's 👑 (#1 on the priority list when the game started) breaks the tie if they're playing; otherwise it's random. Ranked choice breaks ties for last place by fewest 2nd-choice votes, then randomly. A tied bracket match is a coin flip.

**If something gets stuck:** the host can close voting early (missing votes aren't counted), break a tie for someone, or play a stuck player's Elimination turn (which shows the host the current list). If the host's phone is stuck, any player's phone can **take over as host**.

**Privacy:** votes are secret. The app keeps only running totals (and, for ranked choice, unnamed ballots in random order), never who suggested, eliminated or voted for what. Nothing is kept after the host ends the game. Two limits to know: with very few players, results can still be worked out (with two voters, the totals minus your own vote show the other's), and someone tech-savvy could inspect the shared database while voting is under way. Fixing the second would need a server, which this app doesn't have.

## Codes and joining
- Each family has a 6-character **family code** (👪 button). On another phone, open the app and enter the code, or send the **invite link**.
- Each game has its own **game code**. Guests who aren't in the family can join a game with just that code.
- Anyone with a code can see and change that family or game, so only share it with people you trust.

---

## Setup

The app is plain HTML/CSS/JavaScript with no build step. Until Firebase is configured it runs in **demo mode**: data stays in one browser, and each browser tab acts as a separate phone, so you can try everything right away.

### 1. Try it locally
Browsers won't load the app straight from a double-clicked file, so run a tiny local server from this folder:

```
python -m http.server 8000        (or: npx serve)
```

Then open http://localhost:8000. Open a second tab to play the other phone.

On the live site you can also add `?demo` to the address (https://codester00.github.io/Decision_Maker/?demo) to try things out with separate, browser-only data that never touches the real family.

### 2. Create the Firebase backend (free, about 10 minutes)
1. Go to https://console.firebase.google.com and click **Create a project** (Google Analytics is not needed).
2. **Build → Firestore Database → Create database.** Pick a location near you and start in **production mode**.
3. In Firestore, open the **Rules** tab, paste in the contents of [`firestore.rules`](firestore.rules), and click **Publish**.
4. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.** The app signs each phone in invisibly; nobody needs an account.
5. **Project settings (⚙️) → General → Your apps → Web (`</>`)**: register an app (Firebase Hosting is not needed) and copy the `firebaseConfig` object.
6. Paste that object into [`js/firebase-config.js`](js/firebase-config.js) in place of `null`. The values are not secret; the rules protect the data.

### 3. Put it online with GitHub Pages
1. Commit and push to `main`.
2. In GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
4. In Firebase: **Authentication → Settings → Authorized domains → Add domain** → `<your-username>.github.io`.
5. Open the link on each phone, and use **Add to Home Screen** in the browser menu to get an app icon.

## Project layout
| File | Purpose |
| --- | --- |
| `index.html` | Page shell |
| `css/styles.css` | Styles (mobile-first, light and dark mode) |
| `js/app.js` | Screens and actions |
| `js/methods.js` | Rules for each decision method (pure logic) |
| `js/store.js` | Data layer: Firestore, or localStorage in demo mode |
| `js/firebase-config.js` | Your Firebase web config |
| `firestore.rules` | Firestore security rules |

Data model: `families/{code}` holds `{ members: [{id, name, decisions, positions}], activeGame }`, with members in priority order. `games/{code}` holds the players, options, chosen method and settings, and the state of the current round (see `CLAUDE.md`). Every change runs as a transaction, so taps on two phones at the same moment can't corrupt the list.

## Ideas for later
- Native Android/iOS apps (for example by wrapping this web app), if the home-screen web app isn't enough.
- Clean up abandoned games automatically (a Firestore TTL policy on `createdAt`).
