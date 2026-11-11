/*
 * Azul — rules engine (official Azul rules, base game, standard colored wall).
 *
 * Pure logic: no DOM, no Firebase, no I/O. The whole game state is plain
 * JSON-serializable data (including the RNG state) so it can be stored in
 * Firebase Realtime Database and synced verbatim between clients.
 *
 * Works in the browser as window.AzulEngine (plain <script> tag) and in
 * Node via module.exports (used by test/engine.test.js).
 */
(function (global) {
  'use strict';

  var COLORS = ['blue', 'yellow', 'red', 'black', 'cyan']; // cyan = light blue
  var WALL_BASE = ['blue', 'yellow', 'red', 'black', 'cyan'];
  var FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
  var FLOOR_SIZE = 7;
  var FACTORY_COUNT = { 2: 5, 3: 7, 4: 9 };
  var TILES_PER_COLOR = 20;
  var FIRST = 'FIRST'; // starting-player marker token, sits on a floor line

  // ---------------------------------------------------------------- wall ---
  // Standard colored wall: each row is the base order shifted by one.
  function wallColor(row, col) {
    return WALL_BASE[(((col - row) % 5) + 5) % 5];
  }

  function wallColumnFor(row, color) {
    for (var c = 0; c < 5; c++) {
      if (wallColor(row, c) === color) return c;
    }
    return -1;
  }

  // ----------------------------------------------------------------- RNG ---
  // mulberry32 with the state kept inside the game state (one integer), so
  // seeded games are reproducible and the state survives JSON round-trips.
  function rngNext(state) {
    var a = (state.rngState + 0x6D2B79F5) | 0;
    state.rngState = a;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function shuffleInPlace(state, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rngNext(state) * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // -------------------------------------------------------------- players ---
  function emptyWall() {
    var wall = [];
    for (var r = 0; r < 5; r++) wall.push([false, false, false, false, false]);
    return wall;
  }

  function newPlayer(name) {
    return {
      name: String(name),
      score: 0,
      patternLines: [[], [], [], [], []], // line i holds up to i+1 tiles
      wall: emptyWall(),                  // 5x5 booleans
      floor: []                           // tiles and/or the FIRST marker
    };
  }

  // ----------------------------------------------------------------- bag ---
  // Draw up to `count` tiles from the bag; when the bag runs out, the lid is
  // shuffled back into the bag and drawing continues.
  function drawTiles(state, count) {
    var out = [];
    while (out.length < count) {
      if (state.bag.length === 0) {
        if (state.lid.length === 0) break;
        state.bag = shuffleInPlace(state, state.lid.splice(0, state.lid.length));
      }
      out.push(state.bag.pop());
    }
    return out;
  }

  function refillFactories(state) {
    for (var i = 0; i < state.factories.length; i++) {
      state.factories[i] = drawTiles(state, 4);
    }
  }

  // ------------------------------------------------------------ game setup --
  function createGame(names, seed) {
    if (!Array.isArray(names) || names.length < 2 || names.length > 4) {
      throw new Error('Azul needs 2 to 4 players.');
    }
    var state = {
      version: 1,
      seed: (seed == null ? 1 : seed) >>> 0,
      rngState: 0,
      players: names.map(newPlayer),
      factories: [],
      center: [],
      centerHasMarker: true,
      bag: [],
      lid: [],
      startingPlayer: 0,
      currentPlayer: 0,
      nextStartingPlayer: 0,
      round: 1,
      phase: 'draft', // 'draft' | 'finished'
      winners: null,      // array of player indices once finished
      endBonuses: null,   // per-player {rows, columns, colors, total} once finished
      lastResolve: null,  // per-player {gained, penalty, placements} of last wall-tiling
      movesPlayed: 0
    };
    state.rngState = state.seed | 0;

    COLORS.forEach(function (color) {
      for (var i = 0; i < TILES_PER_COLOR; i++) state.bag.push(color);
    });
    shuffleInPlace(state, state.bag);

    var factoryCount = FACTORY_COUNT[names.length];
    for (var f = 0; f < factoryCount; f++) state.factories.push([]);

    state.startingPlayer = Math.floor(rngNext(state) * names.length);
    state.currentPlayer = state.startingPlayer;
    state.nextStartingPlayer = state.startingPlayer;

    refillFactories(state);
    return state;
  }

  // --------------------------------------------------------- move legality --
  // A pattern line accepts `color` when it is not full, holds no other color,
  // and the matching wall row does not already contain that color.
  function isLineLegal(state, playerIdx, color, lineIdx) {
    var player = state.players[playerIdx];
    if (!player || lineIdx < 0 || lineIdx > 4) return false;
    var line = player.patternLines[lineIdx];
    if (line.length >= lineIdx + 1) return false;
    if (line.length > 0 && line[0] !== color) return false;
    var col = wallColumnFor(lineIdx, color);
    if (player.wall[lineIdx][col]) return false;
    return true;
  }

  // Distinct draft options: one per (source, color) pair currently available.
  // The destination (pattern line or floor) is the player's own choice.
  function legalMoves(state, playerIdx) {
    var moves = [];
    if (!state || state.phase !== 'draft') return moves;
    function addFrom(tiles, source) {
      var seen = {};
      tiles.forEach(function (t) {
        if (!seen[t]) {
          seen[t] = true;
          moves.push({ source: source, color: t });
        }
      });
    }
    state.factories.forEach(function (tiles, i) {
      addFrom(tiles, { kind: 'factory', index: i });
    });
    addFrom(state.center, { kind: 'center' });
    return moves;
  }

  // -------------------------------------------------------------- drafting --
  // move = { source: {kind:'factory', index} | {kind:'center'},
  //          color: 'blue'|..., dest: 0..4 | 'floor' }
  // Validates everything before mutating, so a rejected move leaves the
  // state untouched. Mutates and returns `state`.
  function applyDraft(state, playerIdx, move) {
    if (!state || state.phase !== 'draft') {
      throw new Error('The game is finished — no more moves.');
    }
    if (playerIdx !== state.currentPlayer) {
      throw new Error('It is not ' + state.players[playerIdx].name + "'s turn.");
    }
    if (!move || !move.source || COLORS.indexOf(move.color) === -1) {
      throw new Error('Invalid move.');
    }
    var player = state.players[playerIdx];

    // --- source ---
    var isFactory = move.source.kind === 'factory';
    var factoryIdx = -1;
    var sourceTiles;
    if (isFactory) {
      factoryIdx = move.source.index;
      if (typeof factoryIdx !== 'number' || factoryIdx < 0 || factoryIdx >= state.factories.length) {
        throw new Error('No such factory.');
      }
      sourceTiles = state.factories[factoryIdx];
    } else if (move.source.kind === 'center') {
      sourceTiles = state.center;
    } else {
      throw new Error('Invalid move source.');
    }
    var available = 0;
    sourceTiles.forEach(function (t) { if (t === move.color) available++; });
    if (available === 0) {
      throw new Error('There are no ' + move.color + ' tiles there.');
    }

    // --- destination ---
    var toFloor = move.dest === 'floor';
    if (!toFloor) {
      var dest = move.dest;
      if (typeof dest !== 'number' || dest < 0 || dest > 4) {
        throw new Error('Invalid destination — pick a pattern line or the floor.');
      }
      var line = player.patternLines[dest];
      if (line.length >= dest + 1) {
        throw new Error('That pattern line is already full.');
      }
      if (line.length > 0 && line[0] !== move.color) {
        throw new Error('That line already holds ' + line[0] + ' tiles — one color per line.');
      }
      var wcol = wallColumnFor(dest, move.color);
      if (player.wall[dest][wcol]) {
        throw new Error('Your wall already has a ' + move.color + ' tile in that row.');
      }
    }

    // --- take the tiles ---
    var taken = [];
    if (isFactory) {
      var leftovers = [];
      sourceTiles.forEach(function (t) {
        (t === move.color ? taken : leftovers).push(t);
      });
      state.factories[factoryIdx] = [];
      for (var i = 0; i < leftovers.length; i++) state.center.push(leftovers[i]);
    } else {
      var rest = [];
      sourceTiles.forEach(function (t) {
        (t === move.color ? taken : rest).push(t);
      });
      state.center = rest;
      if (state.centerHasMarker) {
        // First player to take from the center also takes the starting
        // player marker onto their floor line and starts the next round.
        state.centerHasMarker = false;
        state.nextStartingPlayer = playerIdx;
        player.floor.push(FIRST);
      }
    }

    // --- place the tiles ---
    var overflow = taken.slice();
    if (!toFloor) {
      var space = (dest + 1) - player.patternLines[dest].length;
      var placed = overflow.splice(0, space);
      for (var j = 0; j < placed.length; j++) player.patternLines[dest].push(placed[j]);
    }
    while (overflow.length > 0) {
      if (player.floor.length < FLOOR_SIZE) player.floor.push(overflow.shift());
      else state.lid.push(overflow.shift()); // floor full: broken tiles go to the lid
    }

    state.movesPlayed++;

    // --- next turn / end of round ---
    var roundOver =
      state.center.length === 0 &&
      state.factories.every(function (f) { return f.length === 0; });
    if (roundOver) {
      resolveRound(state);
    } else {
      state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    }
    return state;
  }

  // ------------------------------------------------------------- scoring ----
  // Points for a tile just placed at (row, col) on a wall that already
  // includes it: the linked horizontal run plus the linked vertical run;
  // a completely isolated tile scores 1.
  function scorePlacement(wall, row, col) {
    var h = 1;
    var c;
    for (c = col - 1; c >= 0 && wall[row][c]; c--) h++;
    for (c = col + 1; c < 5 && wall[row][c]; c++) h++;
    var v = 1;
    var r;
    for (r = row - 1; r >= 0 && wall[r][col]; r--) v++;
    for (r = row + 1; r < 5 && wall[r][col]; r++) v++;
    if (h === 1 && v === 1) return 1;
    return (h > 1 ? h : 0) + (v > 1 ? v : 0);
  }

  function completeRows(player) {
    var n = 0;
    player.wall.forEach(function (row) {
      if (row.every(Boolean)) n++;
    });
    return n;
  }

  function hasCompleteRow(player) {
    return completeRows(player) > 0;
  }

  function completeCols(player) {
    var n = 0;
    for (var c = 0; c < 5; c++) {
      var ok = true;
      for (var r = 0; r < 5; r++) if (!player.wall[r][c]) ok = false;
      if (ok) n++;
    }
    return n;
  }

  function completeColors(player) {
    var n = 0;
    COLORS.forEach(function (color) {
      var ok = true;
      for (var r = 0; r < 5; r++) {
        for (var c = 0; c < 5; c++) {
          if (wallColor(r, c) === color && !player.wall[r][c]) ok = false;
        }
      }
      if (ok) n++;
    });
    return n;
  }

  // Pure: computes end-of-game bonuses, final scores and winners without
  // mutating the state. Tie-break: most complete horizontal rows, then a
  // shared win.
  function computeEndResults(state) {
    var details = state.players.map(function (p) {
      var rows = completeRows(p);
      var cols = completeCols(p);
      var colors = completeColors(p);
      return {
        rows: rows,
        columns: cols,
        colors: colors,
        total: rows * 2 + cols * 7 + colors * 10
      };
    });
    var finalScores = state.players.map(function (p, i) {
      return p.score + details[i].total;
    });
    var best = Math.max.apply(null, finalScores);
    var tied = [];
    finalScores.forEach(function (s, i) { if (s === best) tied.push(i); });
    var bestRows = Math.max.apply(null, tied.map(function (i) { return details[i].rows; }));
    var winners = tied.filter(function (i) { return details[i].rows === bestRows; });
    return { details: details, finalScores: finalScores, winners: winners };
  }

  function finishGame(state) {
    var res = computeEndResults(state);
    state.players.forEach(function (p, i) { p.score = res.finalScores[i]; });
    state.endBonuses = res.details;
    state.winners = res.winners;
    state.phase = 'finished';
  }

  // --------------------------------------------------------- round resolve --
  // Wall-tiling + floor penalties for every player, then either the game
  // ends (someone completed a horizontal wall row) or the next round is
  // prepared. Mutates and returns `state`.
  function resolveRound(state) {
    var summary = [];
    state.players.forEach(function (player) {
      var gained = 0;
      var placements = [];
      for (var row = 0; row < 5; row++) {
        var line = player.patternLines[row];
        if (line.length === row + 1) { // complete line only
          var color = line[0];
          var col = wallColumnFor(row, color);
          player.wall[row][col] = true;
          var pts = scorePlacement(player.wall, row, col);
          gained += pts;
          placements.push({ row: row, col: col, color: color, points: pts });
          for (var k = 1; k < line.length; k++) state.lid.push(line[k]);
          player.patternLines[row] = [];
        }
      }
      var penalty = 0;
      player.floor.forEach(function (t, i) {
        penalty += FLOOR_PENALTIES[Math.min(i, FLOOR_PENALTIES.length - 1)];
        if (t !== FIRST) state.lid.push(t);
      });
      player.floor = [];
      player.score = Math.max(0, player.score + gained + penalty);
      summary.push({ gained: gained, penalty: penalty, placements: placements });
    });
    state.lastResolve = summary;

    if (state.players.some(hasCompleteRow)) {
      finishGame(state);
      return state;
    }

    state.startingPlayer = state.nextStartingPlayer;
    state.currentPlayer = state.startingPlayer;
    state.nextStartingPlayer = state.startingPlayer; // default if marker goes untaken
    state.centerHasMarker = true;
    state.round += 1;
    refillFactories(state);
    return state;
  }

  // -------------------------------------------------------------- exports ---
  var AzulEngine = {
    COLORS: COLORS,
    WALL_BASE: WALL_BASE,
    FLOOR_PENALTIES: FLOOR_PENALTIES,
    FLOOR_SIZE: FLOOR_SIZE,
    FACTORY_COUNT: FACTORY_COUNT,
    FIRST: FIRST,
    wallColor: wallColor,
    wallColumnFor: wallColumnFor,
    createGame: createGame,
    legalMoves: legalMoves,
    isLineLegal: isLineLegal,
    applyDraft: applyDraft,
    resolveRound: resolveRound,
    scorePlacement: scorePlacement,
    hasCompleteRow: hasCompleteRow,
    completeRows: completeRows,
    completeCols: completeCols,
    completeColors: completeColors,
    computeEndResults: computeEndResults
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AzulEngine;
  }
  global.AzulEngine = AzulEngine;
})(typeof window !== 'undefined' ? window : globalThis);
