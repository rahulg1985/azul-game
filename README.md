# Azul — Tile Game

A complete implementation of the Azul board game (official base-game rules)
for 2–4 players, as a dependency-free web app:

- **Local mode** — pass-and-play on one device.
- **Online mode** — create a room, share the invite link (`?room=CODE`);
  friends join from any browser with just a name. No accounts.

Pure HTML/CSS/vanilla JS. No build step, no npm. The only external
dependency is the Firebase JS SDK, loaded from CDN at runtime and only
when online mode is used.

> Unofficial fan implementation for personal play. Not affiliated with
> Plan B Games. All artwork is original CSS.

## Run it locally

Any static file server works:

```bash
cd azul-game
python3 -m http.server 8000
# then open http://localhost:8000
```

(or `npx serve .`, or drag the folder into any static host — GitHub Pages,
Netlify, Firebase Hosting, …)

Opening `index.html` directly via `file://` also works for **local** games.
Online mode needs the page served over http(s) so the ES-module config in
`js/config.js` can load.

## Enable online play (one-time Firebase setup)

Online mode ships **disabled**: `js/config.js` contains clearly marked
placeholder values, and the app detects them and shows “Online play isn’t
set up yet” while local games keep working. To enable it:

1. Go to the [Firebase console](https://console.firebase.google.com),
   create a project (any name, e.g. `azul-game`).
2. **Build → Realtime Database → Create database** (start in test mode,
   or use the rules below).
3. **Project settings → General → Your apps → Web (`</>`)** — register the
   app and copy the `firebaseConfig` object it shows you.
4. Paste those values into `js/config.js`, replacing every `YOUR_…`
   placeholder.
5. Reload the page — Create/Join room now work.

Suggested Realtime Database rules for a friends-only game (rooms are
unguessable 6-character codes; anyone with the link can join, which is
the point of the invite flow):

```json
{
  "rules": {
    "rooms": {
      "$code": { ".read": true, ".write": true }
    }
  }
}
```

These rules are intentionally permissive — fine for a personal game
shared by link, not for a public commercial service.

## How it works

```
index.html          page shell: home / lobby / game / game-over screens
css/styles.css      azulejo-inspired styling, CSS-drawn tiles
js/engine.js        the complete rules engine (pure JS, no DOM/Firebase)
js/app.js           UI rendering + local controller + online controller
js/online.js        Firebase RTDB adapter (rooms, transactions, rejoin)
js/config.js        your Firebase config (ES module + window fallback)
test/engine.test.js Node test suite for the engine
```

### Engine

`js/engine.js` exposes `window.AzulEngine` in the browser and
`module.exports` in Node. The entire game state is plain JSON data —
players, factories, center, bag, lid, round/phase, and even the seeded
RNG state (mulberry32) — so a state can be stored in Firebase and shipped
between clients verbatim, and seeded games are perfectly reproducible.

Key API:

- `createGame(names, seed)` — 2–4 players; factories 5/7/9 by player
  count, 4 tiles each, 100-tile bag (20 per color).
- `applyDraft(state, playerIdx, move)` — validates then applies a draft
  move `{source: {kind:'factory',index}|{kind:'center'}, color, dest}`,
  where `dest` is a pattern line `0–4` or `'floor'`. Throws an `Error`
  with a player-readable message for illegal moves (wrong turn, color not
  present, mixed/full line, wall conflict). Handles the starting-player
  marker, floor overflow to the lid, automatic wall-tiling and scoring at
  round end, next-round setup (lid shuffled back into the bag when it runs
  out), and end-of-game bonuses (+2/+7/+10) with the official tie-break
  (most complete horizontal rows, else shared win).
- `legalMoves(state, playerIdx)`, `isLineLegal(state, playerIdx, color, lineIdx)`,
  `wallColor(row, col)`, `scorePlacement(wall, row, col)`,
  `computeEndResults(state)` (pure bonus/winner calculation).

### Online sync

Rooms live at `rooms/{code}` in Realtime Database:

```js
{
  meta:    { hostIdx, status: 'lobby' | 'playing' | 'finished', createdAt },
  players: [names in seat order],
  state:   <engine state JSON, null in the lobby>
}
```

Every client renders from the room snapshot. A move is submitted as a
**transaction** on `rooms/{code}/state` that runs the engine against the
authoritative state — illegal or out-of-turn moves abort the transaction
and surface the engine’s error message, so clients can’t desync or cheat.
Your seat (`playerIdx`) is kept in `localStorage` per room, so closing
and reopening the tab (or the invite link) drops you back into your seat;
joining a running game with the same name also reclaims your seat.

## Tests

```bash
node test/engine.test.js
```

34 assertions covering the wall layout, setup counts for 2/3/4 players,
drafting (factory leftovers, center marker, all-of-a-color takes),
pattern-line legality, floor overflow, scoring (isolated/horizontal/
vertical/both), the exact floor-penalty sequence, score floor at 0,
round rollover with lid recycling, end bonuses, both tie-breaks, and two
full scripted games (2 and 4 players) played to completion.

## Not in v1 (by design)

AI bots, the gray “free placement” wall variant, accounts/friends lists,
chat, turn timers.
