/*
 * Azul engine test suite — plain Node, no dependencies.
 * Run: node test/engine.test.js   (exit code 0 = all pass)
 */
'use strict';

const E = require('../js/engine.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    failed++;
    failures.push(name + ': ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'not equal') + ' (expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual) + ')');
  }
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || 'not deep-equal') + ' (expected ' + b + ', got ' + a + ')');
}

function throwsWith(fn, pattern, msg) {
  try {
    fn();
  } catch (err) {
    if (pattern && !pattern.test(err.message)) {
      throw new Error((msg || 'wrong error') + ' (error was: ' + err.message + ')');
    }
    return;
  }
  throw new Error(msg || 'expected an error to be thrown');
}

function emptyWall() {
  return Array.from({ length: 5 }, () => [false, false, false, false, false]);
}

/** A controlled mid-game state: empty table, no bag/lid noise. */
function draftFixture(playerCount) {
  const n = playerCount || 2;
  const names = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
  const s = E.createGame(names, 42);
  s.factories = s.factories.map(() => []);
  s.center = [];
  s.bag = [];
  s.lid = [];
  s.centerHasMarker = true;
  s.currentPlayer = 0;
  s.startingPlayer = 0;
  s.nextStartingPlayer = 0;
  s.players.forEach((p) => {
    p.patternLines = [[], [], [], [], []];
    p.wall = emptyWall();
    p.floor = [];
    p.score = 0;
  });
  return s;
}

/** Fixture for calling resolveRound directly. */
function resolveFixture() {
  const s = draftFixture(2);
  s.centerHasMarker = false;
  return s;
}

// ------------------------------------------------------------ wall layout --
test('wall layout: row 0 is the base order', () => {
  const row0 = [0, 1, 2, 3, 4].map((c) => E.wallColor(0, c));
  deepEq(row0, ['blue', 'yellow', 'red', 'black', 'cyan']);
});

test('wall layout: each row shifted, every row and column holds each color once', () => {
  eq(E.wallColor(1, 0), 'cyan', 'row 1 starts with cyan');
  eq(E.wallColor(4, 4), 'blue', 'wallColor(4,4)');
  for (let r = 0; r < 5; r++) {
    const rowColors = new Set([0, 1, 2, 3, 4].map((c) => E.wallColor(r, c)));
    eq(rowColors.size, 5, 'row ' + r + ' has 5 distinct colors');
  }
  for (let c = 0; c < 5; c++) {
    const colColors = new Set([0, 1, 2, 3, 4].map((r) => E.wallColor(r, c)));
    eq(colColors.size, 5, 'column ' + c + ' has 5 distinct colors');
  }
});

// ------------------------------------------------------------------ setup --
[2, 3, 4].forEach((n) => {
  test('setup counts for ' + n + ' players', () => {
    const names = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
    const s = E.createGame(names, 123);
    const expectedFactories = { 2: 5, 3: 7, 4: 9 }[n];
    eq(s.factories.length, expectedFactories, 'factory count');
    s.factories.forEach((f) => eq(f.length, 4, 'each factory holds 4 tiles'));
    eq(s.bag.length, 100 - 4 * expectedFactories, 'bag remainder');
    const total = s.bag.length + s.factories.reduce((a, f) => a + f.length, 0);
    eq(total, 100, 'total tiles in play at setup');
    eq(s.center.length, 0, 'center starts empty');
    eq(s.centerHasMarker, true, 'marker starts in the center');
    eq(s.phase, 'draft');
    eq(s.round, 1);
  });
});

test('setup is reproducible for a fixed seed', () => {
  const a = E.createGame(['A', 'B'], 99);
  const b = E.createGame(['A', 'B'], 99);
  deepEq(a.factories, b.factories, 'same factories');
  deepEq(a.bag, b.bag, 'same bag');
  eq(a.startingPlayer, b.startingPlayer, 'same starting player');
});

test('createGame rejects bad player counts', () => {
  throwsWith(() => E.createGame(['solo'], 1), /2 to 4/);
  throwsWith(() => E.createGame(['a', 'b', 'c', 'd', 'e'], 1), /2 to 4/);
});

// --------------------------------------------------------------- drafting --
test('draft from factory takes ALL tiles of the color, leftovers go to center', () => {
  const s = draftFixture();
  s.factories[0] = ['red', 'red', 'blue', 'yellow'];
  s.factories[1] = ['cyan'];
  E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'red', dest: 3 });
  deepEq(s.players[0].patternLines[3], ['red', 'red'], 'both reds placed');
  deepEq(s.factories[0], [], 'factory emptied');
  deepEq(s.center, ['blue', 'yellow'], 'leftovers moved to center');
  eq(s.currentPlayer, 1, 'turn passes');
});

test('draft from a factory does not touch the center marker', () => {
  const s = draftFixture();
  s.factories[0] = ['blue', 'blue', 'blue', 'blue'];
  s.factories[1] = ['cyan'];
  E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'blue', dest: 4 });
  eq(s.centerHasMarker, true, 'marker still in center');
  eq(s.players[0].floor.length, 0, 'no marker on floor');
});

test('first center take gives the marker to the floor and sets next starting player', () => {
  const s = draftFixture();
  s.factories[0] = ['cyan'];
  s.center = ['red', 'red'];
  E.applyDraft(s, 0, { source: { kind: 'center' }, color: 'red', dest: 2 });
  eq(s.players[0].floor[0], E.FIRST, 'marker is the first floor entry');
  eq(s.centerHasMarker, false, 'marker left the center');
  eq(s.nextStartingPlayer, 0, 'taker starts the next round');
  deepEq(s.players[0].patternLines[2], ['red', 'red'], 'tiles placed');

  // Second player takes from the center: no marker anymore.
  s.center.push('blue');
  E.applyDraft(s, 1, { source: { kind: 'center' }, color: 'blue', dest: 'floor' });
  assert(!s.players[1].floor.includes(E.FIRST), 'second taker gets no marker');
  eq(s.nextStartingPlayer, 0, 'next starting player unchanged');
});

test('draft rejects a move out of turn and a color that is not there', () => {
  const s = draftFixture();
  s.factories[0] = ['red'];
  s.factories[1] = ['cyan'];
  throwsWith(
    () => E.applyDraft(s, 1, { source: { kind: 'factory', index: 0 }, color: 'red', dest: 0 }),
    /turn/, 'out-of-turn move must throw');
  throwsWith(
    () => E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'blue', dest: 0 }),
    /no blue tiles/, 'absent color must throw');
});

test('line placement: mixed color rejected', () => {
  const s = draftFixture();
  s.players[0].patternLines[1] = ['red'];
  s.factories[0] = ['blue', 'blue'];
  s.factories[1] = ['cyan'];
  eq(E.isLineLegal(s, 0, 'blue', 1), false, 'isLineLegal says no');
  throwsWith(
    () => E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'blue', dest: 1 }),
    /already holds/, 'mixed-color line must throw');
});

test('line placement: full line rejected', () => {
  const s = draftFixture();
  s.players[0].patternLines[0] = ['blue'];
  s.factories[0] = ['blue'];
  s.factories[1] = ['cyan'];
  eq(E.isLineLegal(s, 0, 'blue', 0), false);
  throwsWith(
    () => E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'blue', dest: 0 }),
    /already full/, 'full line must throw');
});

test('line placement: color already on that wall row rejected', () => {
  const s = draftFixture();
  // red sits at row 2, column 4 on the standard wall
  eq(E.wallColumnFor(2, 'red'), 4);
  s.players[0].wall[2][4] = true;
  s.factories[0] = ['red'];
  s.factories[1] = ['cyan'];
  eq(E.isLineLegal(s, 0, 'red', 2), false);
  throwsWith(
    () => E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'red', dest: 2 }),
    /already has a red/, 'wall conflict must throw');
});

test('line placement: overflow beyond capacity goes to the floor', () => {
  const s = draftFixture();
  s.players[0].patternLines[2] = ['red', 'red']; // capacity 3, one space left
  s.factories[0] = ['red', 'red', 'red', 'blue'];
  s.factories[1] = ['cyan'];
  E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'red', dest: 2 });
  deepEq(s.players[0].patternLines[2], ['red', 'red', 'red'], 'line filled to capacity');
  deepEq(s.players[0].floor, ['red', 'red'], 'two overflow tiles on the floor');
  deepEq(s.center, ['blue'], 'factory leftover in the center');
});

test('floor as destination: fills 7 slots, excess tiles go to the lid', () => {
  const s = draftFixture();
  s.players[0].floor = ['blue', 'blue', 'blue', 'blue', 'blue', 'blue']; // 6 of 7
  s.factories[0] = ['red', 'red', 'red'];
  s.factories[1] = ['cyan'];
  E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'red', dest: 'floor' });
  eq(s.players[0].floor.length, 7, 'floor capped at 7');
  deepEq(s.lid, ['red', 'red'], 'excess tiles in the lid');
});

test('legalMoves lists distinct (source, color) options', () => {
  const s = draftFixture();
  s.factories[0] = ['red', 'red', 'blue'];
  s.center = ['blue', 'cyan', 'cyan'];
  const moves = E.legalMoves(s, 0);
  const keys = moves.map((m) => (m.source.kind === 'factory' ? 'f' + m.source.index : 'c') + ':' + m.color);
  deepEq(keys.sort(), ['c:blue', 'c:cyan', 'f0:blue', 'f0:red']);
});

// ---------------------------------------------------------------- scoring --
test('scoring: isolated tile scores 1', () => {
  const s = resolveFixture();
  s.players[0].patternLines[0] = ['blue']; // row 0, col 0
  E.resolveRound(s);
  eq(s.players[0].score, 1, 'isolated tile = 1 point');
  eq(s.players[0].wall[0][0], true, 'tile on the wall');
  deepEq(s.players[0].patternLines[0], [], 'line cleared');
});

test('scoring: horizontal run scores its length', () => {
  const s = resolveFixture();
  s.players[0].wall[0][0] = true;
  s.players[0].wall[0][2] = true;
  s.players[0].patternLines[0] = ['yellow']; // row 0, col 1 — bridges the gap
  E.resolveRound(s);
  eq(s.players[0].score, 3, 'run of 3 horizontally = 3 points');
});

test('scoring: vertical run scores its length, extra line tiles go to lid', () => {
  const s = resolveFixture();
  s.players[0].wall[0][1] = true;
  s.players[0].wall[2][1] = true;
  s.players[0].patternLines[1] = ['blue', 'blue']; // row 1, col 1
  E.resolveRound(s);
  eq(s.players[0].score, 3, 'run of 3 vertically = 3 points');
  // The spare tile went to the lid at wall-tiling, then the round rollover
  // immediately recycled the lid into the bag and out to the factories.
  const recycled = s.factories.reduce((a, f) => a.concat(f), []).concat(s.bag, s.lid);
  eq(recycled.filter((t) => t === 'blue').length, 1, 'second tile of the completed line was recycled via the lid');
});

test('scoring: horizontal and vertical runs add together', () => {
  const s = resolveFixture();
  s.players[0].wall[0][1] = true;
  s.players[0].wall[2][1] = true;
  s.players[0].wall[1][0] = true;
  s.players[0].wall[1][2] = true;
  s.players[0].patternLines[1] = ['blue', 'blue']; // lands at (1,1): H=3, V=3
  E.resolveRound(s);
  eq(s.players[0].score, 6, 'H 3 + V 3 = 6 points');
});

test('scoring: scorePlacement helper directly', () => {
  const wall = emptyWall();
  wall[2][2] = true;
  eq(E.scorePlacement(wall, 2, 2), 1, 'isolated');
  wall[2][3] = true;
  wall[2][4] = true;
  eq(E.scorePlacement(wall, 2, 2), 3, 'horizontal 3');
  wall[1][2] = true;
  wall[0][2] = true;
  eq(E.scorePlacement(wall, 2, 2), 6, 'horizontal 3 + vertical 3');
});

test('wall-tiling: incomplete pattern lines stay for the next round', () => {
  const s = resolveFixture();
  s.players[0].patternLines[2] = ['red', 'red']; // capacity 3 — incomplete
  E.resolveRound(s);
  deepEq(s.players[0].patternLines[2], ['red', 'red'], 'incomplete line untouched');
  eq(s.players[0].score, 0, 'no points scored');
});

// ---------------------------------------------------------- floor penalty --
test('floor penalties follow the exact -1,-1,-2,-2,-2,-3,-3 sequence', () => {
  const s = resolveFixture();
  s.players[0].score = 20;
  s.players[0].floor = ['red', 'yellow', 'blue']; // -1 -1 -2 = -4
  s.players[1].score = 20;
  s.players[1].floor = ['red', 'red', 'red', 'red', 'red', 'red', 'red']; // full: -14
  E.resolveRound(s);
  eq(s.players[0].score, 16, 'three floor tiles cost 4');
  eq(s.players[1].score, 6, 'seven floor tiles cost 14');
  deepEq(s.players[0].floor, [], 'floor cleared after scoring');
  // Floor tiles went to the lid, then the rollover refill (empty bag) drew
  // them straight back out into the factories.
  const refilled = s.factories.reduce((a, f) => a + f.length, 0);
  eq(refilled + s.bag.length + s.lid.length, 10, 'all 10 floor tiles recycled, none lost');
});

test('floor penalties: the starting marker counts as a floor tile', () => {
  const s = resolveFixture();
  s.players[0].score = 5;
  s.players[0].floor = [E.FIRST];
  E.resolveRound(s);
  eq(s.players[0].score, 4, 'marker alone costs 1');
  eq(s.lid.length, 0, 'marker does not go to the lid');
});

test('floor penalties: score never drops below 0', () => {
  const s = resolveFixture();
  s.players[0].score = 2;
  s.players[0].floor = ['red', 'red', 'red']; // -4 against a score of 2
  E.resolveRound(s);
  eq(s.players[0].score, 0, 'score floored at 0');
});

test('round resolve: wall points and floor penalties combine', () => {
  const s = resolveFixture();
  s.players[0].score = 10;
  s.players[0].patternLines[0] = ['blue']; // +1
  s.players[0].floor = ['red', 'red'];     // -2
  E.resolveRound(s);
  eq(s.players[0].score, 9, '10 + 1 - 2 = 9');
  eq(s.lastResolve[0].gained, 1);
  eq(s.lastResolve[0].penalty, -2);
});

// ------------------------------------------------------------- round flow --
test('marker taker becomes the starting player of the next round', () => {
  const s = draftFixture();
  s.center = ['red'];
  s.centerHasMarker = true;
  s.factories[0] = ['blue'];
  // P1 takes the last factory tile (no marker), then P2 takes the center
  // tile with the marker, emptying the table and ending the round.
  E.applyDraft(s, 0, { source: { kind: 'factory', index: 0 }, color: 'blue', dest: 0 });
  E.applyDraft(s, 1, { source: { kind: 'center' }, color: 'red', dest: 0 });
  eq(s.round, 2, 'round advanced');
  eq(s.startingPlayer, 1, 'marker taker starts round 2');
  eq(s.currentPlayer, 1);
  eq(s.centerHasMarker, true, 'marker back in the center');
  // P2 also tiled their completed line 0 and paid 1 for the marker.
  eq(s.players[1].wall[0][E.wallColumnFor(0, 'red')], true, 'red tiled to the wall');
  eq(s.players[1].score, 0, '+1 for the tile, -1 for the marker = 0');
});

test('refill recycles the lid into the bag when the bag runs out', () => {
  const s = resolveFixture();
  // No complete row, so the round rolls over and factories refill.
  s.bag = ['blue', 'blue'];
  s.lid = ['red', 'red', 'red', 'red', 'red', 'red', 'red', 'red',
           'red', 'red', 'red', 'red', 'red', 'red', 'red', 'red',
           'red', 'red'];
  const lidCount = s.lid.length;
  E.resolveRound(s);
  const inFactories = s.factories.reduce((a, f) => a + f.length, 0);
  eq(inFactories, 20, 'all 5 factories refilled with 4 (2-player game)');
  eq(inFactories + s.bag.length + s.lid.length, 2 + lidCount, 'no tiles lost');
});

// -------------------------------------------------------------- game end ---
test('end bonuses: +2 per row, +7 per column, +10 per color', () => {
  const s = resolveFixture();
  // Player 0: complete row 0 and complete column 0.
  for (let c = 0; c < 5; c++) s.players[0].wall[0][c] = true;
  for (let r = 0; r < 5; r++) s.players[0].wall[r][0] = true;
  const res = E.computeEndResults(s);
  eq(res.details[0].rows, 1);
  eq(res.details[0].columns, 1);
  eq(res.details[0].colors, 0, 'no color complete yet');
  eq(res.details[0].total, 2 + 7);
  // Completing every blue cell (the diagonal) finishes one color.
  for (let i = 0; i < 5; i++) s.players[0].wall[i][i] = true; // wallColor(i,i) = blue
  const res2 = E.computeEndResults(s);
  eq(res2.details[0].colors, 1, 'blue complete');
  eq(res2.details[0].total, 2 + 7 + 10);
});

test('tie-break: equal scores go to the player with more complete rows', () => {
  const s = resolveFixture();
  s.players[0].score = 50;
  for (let c = 0; c < 5; c++) s.players[0].wall[0][c] = true; // 1 row -> +2 = 52
  s.players[1].score = 52; // no bonuses -> 52
  const res = E.computeEndResults(s);
  deepEq(res.finalScores, [52, 52], 'scores tied after bonuses');
  deepEq(res.winners, [0], 'row count breaks the tie');
});

test('tie-break: identical scores and rows share the win', () => {
  const s = resolveFixture();
  s.players[0].score = 50;
  s.players[1].score = 50;
  for (let c = 0; c < 5; c++) {
    s.players[0].wall[0][c] = true;
    s.players[1].wall[0][c] = true;
  }
  const res = E.computeEndResults(s);
  deepEq(res.winners, [0, 1], 'shared win');
});

// ------------------------------------------------------------ full game ----
test('full scripted 2-player game finishes with bonuses applied', () => {
  const s = E.createGame(['Ada', 'Ben'], 20261110);
  let guard = 0;
  while (s.phase !== 'finished' && guard < 10000) {
    guard++;
    const me = s.currentPlayer;
    const options = E.legalMoves(s, me);
    assert(options.length > 0, 'current player always has a move during draft');
    // Greedy: prefer a line that already holds the color, then any legal
    // line (largest first), otherwise dump to the floor.
    let chosen = null;
    for (const opt of options) {
      for (let line = 4; line >= 0; line--) {
        const cur = s.players[me].patternLines[line];
        if (E.isLineLegal(s, me, opt.color, line) && cur[0] === opt.color) {
          chosen = { ...opt, dest: line };
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      for (const opt of options) {
        for (let line = 4; line >= 0; line--) {
          if (E.isLineLegal(s, me, opt.color, line)) {
            chosen = { ...opt, dest: line };
            break;
          }
        }
        if (chosen) break;
      }
    }
    if (!chosen) chosen = { ...options[0], dest: 'floor' };
    E.applyDraft(s, me, chosen);
  }
  eq(s.phase, 'finished', 'game reached the finished phase');
  assert(s.movesPlayed > 0 && guard < 10000, 'game finished within the move budget');
  assert(Array.isArray(s.winners) && s.winners.length >= 1, 'a winner was decided');
  const rowCompleter = s.players.findIndex((p) => E.hasCompleteRow(p));
  assert(rowCompleter >= 0, 'someone completed a horizontal row (the end trigger)');
  const bonus = s.endBonuses[rowCompleter];
  assert(bonus.rows >= 1, 'row completer has at least one row bonus');
  eq(bonus.total, bonus.rows * 2 + bonus.columns * 7 + bonus.colors * 10,
    'bonus total matches the official formula');
  s.players.forEach((p) => assert(p.score >= 0, 'scores never negative'));
  // Winner really holds the top score.
  const top = Math.max(...s.players.map((p) => p.score));
  s.winners.forEach((w) => eq(s.players[w].score, top, 'winner holds the top score'));
});

test('full scripted 4-player game also finishes', () => {
  const s = E.createGame(['A', 'B', 'C', 'D'], 777);
  let guard = 0;
  while (s.phase !== 'finished' && guard < 20000) {
    guard++;
    const me = s.currentPlayer;
    const options = E.legalMoves(s, me);
    let chosen = null;
    for (const opt of options) {
      for (let line = 0; line <= 4 && !chosen; line++) {
        if (E.isLineLegal(s, me, opt.color, line)) chosen = { ...opt, dest: line };
      }
      if (chosen) break;
    }
    if (!chosen) chosen = { ...options[0], dest: 'floor' };
    E.applyDraft(s, me, chosen);
  }
  eq(s.phase, 'finished', '4-player game finished');
  assert(s.winners.length >= 1, 'winner decided');
});

// --------------------------------------------------------------- summary ---
console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
