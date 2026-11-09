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

### Elimination Game (🎲)
Completely separate from the priority list: it never changes the order or the statistics. **Only one game per family runs at a time:** starting a game while one is running asks whether to join it or end it for everyone and start fresh.
1. **Players.** Anyone in the family taps the game banner (or enters the game code / opens the shared link) and adds themselves by name. One phone can add several people (for example, kids without phones). Each person can only play from one phone. Minimum 2 players.
2. **Options.** Everyone adds options from their own phone at the same time, as many as they like. You can remove options you added yourself. Nobody can see who suggested what.
3. **Eliminate.** The turn order is shuffled once and then stays fixed. The current player is highlighted on every phone and their phone buzzes. On your turn you tap an option to eliminate it. The host can play a turn for someone who is stuck.
4. **Winner.** If the host's phone gets stuck, any player's phone can **take over as host**. When one option is left, the host can **Play again** (same players) or **End game**, which deletes the game completely.

**Privacy:** the game stores no record of who suggested or eliminated anything, and nothing from it is kept after the host ends it.

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
| `js/app.js` | Screens, actions and game logic |
| `js/store.js` | Data layer: Firestore, or localStorage in demo mode |
| `js/firebase-config.js` | Your Firebase web config |
| `firestore.rules` | Firestore security rules |

Data model: `families/{code}` holds `{ members: [{id, name, decisions, positions}], activeGame }`, with members in priority order. `games/{code}` holds `{ host, phase, players: [{id, name, device}], options: [{id, text}], order, turn, winner }`. Every change runs as a transaction, so taps on two phones at the same moment can't corrupt the list.

## Ideas for later
- Native Android/iOS apps (for example by wrapping this web app), if the home-screen web app isn't enough.
- More decision methods.
- Clean up abandoned games automatically (a Firestore TTL policy on `createdAt`).
