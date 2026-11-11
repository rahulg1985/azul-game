/*
 * Azul — Tile Game UI + controllers (local pass-and-play and online rooms).
 * Plain script; depends on window.AzulEngine (js/engine.js) and, only for
 * online mode, window.AzulOnline (js/online.js).
 */
(function () {
  'use strict';

  var E = window.AzulEngine;
  var $ = function (sel) { return document.querySelector(sel); };

  // ------------------------------------------------------------ utilities --
  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3000);
  }

  function show(screenId) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.add('hidden'); });
    $('#' + screenId).classList.remove('hidden');
    window.scrollTo({ top: 0 });
  }

  // -------------------------------------------------------------- session --
  // session = {
  //   mode: 'local' | 'online',
  //   state: <engine state>,
  //   // online only:
  //   code, playerIdx, myName, unwatch
  // }
  var session = null;
  var selection = null; // { source: {kind, index?}, color }
  var highlight = {};   // "playerIdx:row:col" -> true for just-tiled cells
  var lastTurnKey = null; // "round:currentPlayer" — drives the turn-change animation

  function setHighlightFromResolve(state) {
    highlight = {};
    (state.lastResolve || []).forEach(function (sum, pi) {
      (sum.placements || []).forEach(function (pl) {
        highlight[pi + ':' + pl.row + ':' + pl.col] = true;
      });
    });
  }

  // ------------------------------------------------------------ home screen --
  var localCount = 2;

  function wireHome() {
    $('#local-count').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-count]');
      if (!btn) return;
      localCount = parseInt(btn.dataset.count, 10);
      this.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.local-name').forEach(function (input, i) {
        input.classList.toggle('hidden', i >= localCount);
      });
    });

    $('#btn-local-start').addEventListener('click', function () {
      var names = [];
      document.querySelectorAll('.local-name').forEach(function (input, i) {
        if (i < localCount) names.push(input.value.trim() || ('Player ' + (i + 1)));
      });
      startLocalGame(names);
    });

    $('#btn-create-room').addEventListener('click', function () { createRoomFlow(this); });
    $('#btn-join-room').addEventListener('click', function () { joinRoomFlow(this); });
    $('#join-code').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') joinRoomFlow($('#btn-join-room'));
    });
  }

  function startLocalGame(names) {
    session = {
      mode: 'local',
      state: E.createGame(names, Math.floor(Math.random() * 0xffffffff))
    };
    selection = null;
    highlight = {};
    show('screen-game');
    renderGame();
  }

  // -------------------------------------------------------- online flows ---
  function rememberName(name) {
    try { window.localStorage.setItem('azul-my-name', name); } catch (e) { /* ignore */ }
  }

  function onlineName() {
    var name = $('#online-name').value.trim();
    if (!name) {
      toast('Enter your name first.', true);
      $('#online-name').focus();
      return null;
    }
    rememberName(name);
    return name;
  }

  // Returns true when online mode is ready; otherwise surfaces the
  // "not configured" notice and returns false.
  function ensureOnline() {
    return window.AzulOnline.init().then(function (ready) {
      if (!ready) {
        $('#online-unavailable').classList.remove('hidden');
        toast("Online play isn't set up yet on this copy — local games work fully.", true);
      }
      return ready;
    });
  }

  function busy(btn, fn) {
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';
    return fn().finally(function () {
      btn.disabled = false;
      btn.textContent = old;
    });
  }

  function createRoomFlow(btn) {
    var name = onlineName();
    if (!name) return;
    busy(btn, function () {
      return ensureOnline().then(function (ready) {
        if (!ready) return;
        return window.AzulOnline.createRoom(name).then(function (res) {
          enterRoom(res.code, res.playerIdx, name);
        });
      }).catch(function (err) { toast(err.message, true); });
    });
  }

  function joinRoomFlow(btn) {
    var name = onlineName();
    if (!name) return;
    var code = $('#join-code').value.trim().toUpperCase();
    if (!code) {
      toast('Enter the room code.', true);
      $('#join-code').focus();
      return;
    }
    busy(btn, function () {
      return ensureOnline().then(function (ready) {
        if (!ready) return;
        return window.AzulOnline.joinRoom(code, name).then(function (res) {
          enterRoom(res.code, res.playerIdx, name);
        });
      }).catch(function (err) { toast(err.message, true); });
    });
  }

  function enterRoom(code, playerIdx, myName) {
    leaveRoomWatch();
    session = {
      mode: 'online',
      state: null,
      code: code,
      playerIdx: playerIdx,
      myName: myName,
      unwatch: null
    };
    // Per-tab session restore: a reload of THIS tab rejoins the room.
    // (sessionStorage is per-tab, so a friend opening the invite link in a
    // new tab or on another device is never auto-seated as someone else.)
    try {
      window.sessionStorage.setItem('azul-session',
        JSON.stringify({ code: code, name: myName }));
    } catch (e) { /* ignore */ }
    selection = null;
    highlight = {};
    session.unwatch = window.AzulOnline.watchRoom(code, onRoomUpdate);
    show('screen-lobby');
  }

  function leaveRoomWatch() {
    if (session && session.unwatch) {
      session.unwatch();
      session.unwatch = null;
    }
  }

  function onRoomUpdate(room) {
    if (!session || session.mode !== 'online') return;
    if (!room) {
      toast('That room no longer exists.', true);
      goHome();
      return;
    }
    var players = room.players || [];
    session.roomMeta = room.meta;

    // Seats can shift if someone leaves the lobby — re-derive mine by name.
    if (session.myName && players[session.playerIdx] !== session.myName) {
      var idx = players.indexOf(session.myName);
      if (idx !== -1) {
        session.playerIdx = idx;
        window.AzulOnline.saveSeat(session.code, session.myName, idx);
      }
    }

    if (room.meta.status === 'lobby' || !room.state) {
      renderLobby(room);
      show('screen-lobby');
      return;
    }

    var prev = session.state;
    // RTDB round-trips prune empty arrays — repair before rendering.
    session.state = window.AzulEngine.normalize(room.state);

    if (!prev || prev.round !== session.state.round || session.state.phase === 'finished') {
      if (session.state.lastResolve) setHighlightFromResolve(session.state);
    }
    if (session.state.phase === 'finished') {
      renderGameOver();
      show('screen-gameover');
      return;
    }
    if (selection && session.state.currentPlayer !== session.playerIdx) selection = null;
    show('screen-game');
    renderGame();
    if (prev && prev.currentPlayer !== session.playerIdx &&
        session.state.currentPlayer === session.playerIdx) {
      toast('Your turn, ' + session.myName + '!');
    }
  }

  function inviteLink(code) {
    return window.location.href.split('?')[0].split('#')[0] + '?room=' + code;
  }

  function renderLobby(room) {
    var players = room.players || [];
    var isHost = session.playerIdx === room.meta.hostIdx;
    $('#lobby-code').textContent = session.code;
    $('#invite-link').value = inviteLink(session.code);
    $('#lobby-count').textContent = '(' + players.length + '/4)';
    $('#lobby-players').innerHTML = players.map(function (name, i) {
      var tags = '';
      if (i === room.meta.hostIdx) tags += '<span class="tag">Host</span>';
      if (i === session.playerIdx) tags += '<span class="tag me">You</span>';
      return '<li>' + esc(name) + '<span>' + tags + '</span></li>';
    }).join('');

    var startBtn = $('#btn-start-online');
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = players.length < 2;
      $('#lobby-status').textContent = players.length < 2
        ? 'Waiting for at least one more player to join…'
        : 'Everyone in? Start when ready — late joiners can’t enter a running game.';
    } else {
      startBtn.classList.add('hidden');
      $('#lobby-status').textContent = 'Waiting for the host to start the game…';
    }
  }

  function wireLobby() {
    $('#btn-copy-link').addEventListener('click', function () {
      var input = $('#invite-link');
      input.select();
      input.setSelectionRange(0, input.value.length);
      var done = function () { toast('Invite link copied — send it to your friends!'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () {
          document.execCommand('copy');
          done();
        });
      } else {
        document.execCommand('copy');
        done();
      }
    });

    $('#btn-start-online').addEventListener('click', function () {
      var btn = this;
      busy(btn, function () {
        return window.AzulOnline.startGame(session.code)
          .catch(function (err) { toast(err.message, true); });
      });
    });

    $('#btn-leave-room').addEventListener('click', function () {
      var code = session.code;
      var idx = session.playerIdx;
      leaveRoomWatch();
      if (window.AzulOnline.isReady()) {
        window.AzulOnline.leaveRoom(code, idx).catch(function () { /* ignore */ });
      }
      session = null;
      goHome();
    });
  }

  // ------------------------------------------------------------ game screen --
  function canInteract() {
    if (!session || !session.state || session.state.phase !== 'draft') return false;
    if (session.mode === 'local') return true;
    return session.state.currentPlayer === session.playerIdx;
  }

  function tileHtml(color, mini) {
    return '<span class="tile tile-' + color + (mini ? ' mini' : '') + '"></span>';
  }

  function groupHtml(source, color, count, mini) {
    var sel = selection && selection.color === color &&
      selection.source.kind === source.kind &&
      (source.kind === 'center' || selection.source.index === source.index);
    var tiles = '';
    for (var i = 0; i < count; i++) tiles += tileHtml(color, mini);
    return '<button type="button" class="tile-group' +
      (canInteract() ? ' pickable' : '') + (sel ? ' selected' : '') + '"' +
      ' data-kind="' + source.kind + '"' +
      (source.kind === 'factory' ? ' data-index="' + source.index + '"' : '') +
      ' data-color="' + color + '"' +
      (canInteract() ? '' : ' disabled') +
      ' aria-label="' + count + ' ' + color + ' tiles">' +
      tiles +
      (count > 1 ? '<span class="group-count">' + count + '</span>' : '') +
      '</button>';
  }

  function groupsHtml(tiles, source, mini) {
    var counts = {};
    tiles.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    return E.COLORS.filter(function (c) { return counts[c]; })
      .map(function (c) { return groupHtml(source, c, counts[c], mini); })
      .join('');
  }

  function renderGame() {
    var s = session.state;
    if (!s) return;
    var cur = s.players[s.currentPlayer];

    // --- banner ---
    var main;
    var sub;
    if (s.phase === 'finished') {
      main = 'Game finished';
      sub = '';
    } else if (session.mode === 'online' && s.currentPlayer !== session.playerIdx) {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'Waiting for ' + cur.name + ' to play…';
    } else if (session.mode === 'online') {
      main = 'Round ' + s.round + ' — your turn!';
      sub = 'Tap tiles in a factory or the center, then tap where they go.';
    } else {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'Pass the device to ' + cur.name + ', then tap tiles to draft.';
    }
    var chips = s.players.map(function (p, i) {
      return '<span class="score-chip' + (i === s.currentPlayer && s.phase === 'draft' ? ' active' : '') + '">' +
        esc(p.name) + ': ' + p.score + '</span>';
    }).join('');
    $('#turn-banner').innerHTML =
      '<div class="turn-main">' + esc(main) + '</div>' +
      (sub ? '<div class="turn-sub">' + esc(sub) + '</div>' : '') +
      '<div class="score-chips">' + chips + '</div>';

    // --- factories ---
    $('#factories').innerHTML = s.factories.map(function (tiles, i) {
      return '<div class="factory' + (tiles.length ? '' : ' empty') + '">' +
        (tiles.length ? groupsHtml(tiles, { kind: 'factory', index: i }, true)
                      : '<span class="center-empty">empty</span>') +
        '</div>';
    }).join('');

    // --- center ---
    var centerHtml = '';
    if (s.centerHasMarker) {
      centerHtml += '<span class="marker-token" title="Starting player marker — first to take from the center gets it (and a −1 floor penalty)">1st</span>';
    }
    centerHtml += groupsHtml(s.center, { kind: 'center' }, true);
    if (!centerHtml) centerHtml = '<span class="center-empty">The center is empty.</span>';
    $('#center-pile').innerHTML = centerHtml;

    // --- hint ---
    var hint = '';
    if (selection) {
      var srcTiles = selection.source.kind === 'factory'
        ? s.factories[selection.source.index] : s.center;
      var n = srcTiles.filter(function (t) { return t === selection.color; }).length;
      var from = selection.source.kind === 'factory'
        ? 'factory ' + (selection.source.index + 1) : 'the center';
      hint = 'Selected ' + n + ' ' + selection.color + ' tile' + (n === 1 ? '' : 's') +
        ' from ' + from + ' — now tap a highlighted pattern line on ' + cur.name +
        '’s board, or their floor line.';
    } else if (canInteract()) {
      hint = session.mode === 'online' ? 'Your move: tap a group of tiles to pick them up.'
                                       : cur.name + ': tap a group of tiles to pick them up.';
    }
    $('#selection-hint').textContent = hint;

    // --- boards: turn player first (full size), then the rest ---
    var boardsEl = $('#boards');
    var prevRects = {};
    boardsEl.querySelectorAll('.board').forEach(function (b) {
      var r = b.getBoundingClientRect();
      // Document coordinates, so a page scroll between renders can't skew the deltas.
      prevRects[b.dataset.player] = {
        left: r.left + window.scrollX, top: r.top + window.scrollY,
        width: r.width, height: r.height
      };
    });
    var order = s.players.map(function (_, i) { return i; });
    order.sort(function (a, b) {
      if (a === s.currentPlayer) return -1;
      if (b === s.currentPlayer) return 1;
      return a - b;
    });
    boardsEl.innerHTML = order.map(function (pi) {
      return boardHtml(s, pi);
    }).join('');

    // Turn changed? FLIP-animate every board from its old spot to its new
    // one: the old board glides down, the next player's board glides up
    // into place — like the boards are being shuffled by hand (~1s).
    var turnKey = s.round + ':' + s.currentPlayer + ':' + s.phase;
    var turnChanged = lastTurnKey !== null && turnKey !== lastTurnKey && s.phase === 'draft';
    lastTurnKey = turnKey;
    if (turnChanged) {
      var bannerEl = $('#turn-banner');
      bannerEl.classList.add('pulse');
      bannerEl.scrollIntoView({ block: 'start' });
      boardsEl.querySelectorAll('.board').forEach(function (b) {
        var old = prevRects[b.dataset.player];
        if (!old || !b.animate) return;
        var nr = b.getBoundingClientRect();
        var dx = old.left - (nr.left + window.scrollX);
        var dy = old.top - (nr.top + window.scrollY);
        var sx = old.width / nr.width;
        var sy = old.height / nr.height;
        if (!dx && !dy && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
        b.style.zIndex = b.classList.contains('turn') ? 3 : 2;
        var anim = b.animate([
          { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')' },
          { transform: 'translate(0px, 0px) scale(1, 1)' }
        ], { duration: 1000, easing: 'cubic-bezier(.3, .7, .3, 1)' });
        anim.onfinish = function () { b.style.zIndex = ''; };
      });
      var topBoard = $('#boards .board.turn');
      if (topBoard) topBoard.classList.add('turn-enter');
    }
  }

  function boardHtml(s, pi) {
    var p = s.players[pi];
    var isTurnBoard = pi === s.currentPlayer && s.phase === 'draft';
    var interact = canInteract() && isTurnBoard;

    var lines = '';
    for (var i = 0; i < 5; i++) {
      var line = p.patternLines[i];
      var slots = '';
      for (var j = 0; j < i + 1; j++) {
        slots += line[j]
          ? '<span class="slot filled">' + tileHtml(line[j]) + '</span>'
          : '<span class="slot"></span>';
      }
      var cls = 'pline';
      if (interact && selection) {
        cls += E.isLineLegal(s, pi, selection.color, i) ? ' droppable' : ' blocked';
      }
      lines += '<div class="' + cls + '" data-owner="' + pi + '" data-dest-line="' + i + '">' + slots + '</div>';
    }

    var wall = '';
    for (var r = 0; r < 5; r++) {
      for (var c = 0; c < 5; c++) {
        var color = E.wallColor(r, c);
        if (p.wall[r][c]) {
          wall += '<span class="wall-cell filled' +
            (highlight[pi + ':' + r + ':' + c] ? ' just-placed' : '') + '">' +
            tileHtml(color) + '</span>';
        } else {
          wall += '<span class="wall-cell ghost-' + color + '"></span>';
        }
      }
    }

    var floorSlots = '';
    for (var k = 0; k < E.FLOOR_SIZE; k++) {
      var cell = '';
      var entry = p.floor[k];
      if (entry === E.FIRST) cell = '<span class="marker-token inline">1st</span>';
      else if (entry) cell = tileHtml(entry);
      floorSlots += '<span class="floor-slot"><span class="floor-pen">' +
        E.FLOOR_PENALTIES[k] + '</span><span class="floor-cell">' + cell + '</span></span>';
    }

    var youTag = session.mode === 'online' && pi === session.playerIdx
      ? ' <span class="you">(you)</span>' : '';

    return '<div class="board' + (isTurnBoard ? ' turn' : ' compact') + '" data-player="' + pi + '">' +
      '<div class="board-head"><span class="board-name">' + esc(p.name) + youTag + '</span>' +
      '<span class="board-score">★ ' + p.score + '</span></div>' +
      '<div class="board-main"><div class="pattern-lines">' + lines + '</div>' +
      '<div class="wall">' + wall + '</div></div>' +
      '<div class="floor-line"><div class="floor-label">Floor line (penalties)</div>' +
      '<div class="floor-slots' + (interact && selection ? ' droppable' : '') +
      '" data-owner="' + pi + '" data-dest-floor="1">' + floorSlots + '</div></div>' +
      '</div>';
  }

  function wireGame() {
    $('#screen-game').addEventListener('click', function (ev) {
      if (!session || !session.state) return;

      var group = ev.target.closest('.tile-group');
      if (group && !group.disabled) {
        var source = group.dataset.kind === 'factory'
          ? { kind: 'factory', index: parseInt(group.dataset.index, 10) }
          : { kind: 'center' };
        var color = group.dataset.color;
        if (selection && selection.color === color &&
            selection.source.kind === source.kind &&
            (source.kind === 'center' || selection.source.index === source.index)) {
          selection = null; // tap again to put them back
        } else {
          selection = { source: source, color: color };
        }
        renderGame();
        return;
      }

      var lineEl = ev.target.closest('[data-dest-line]');
      if (lineEl && selection) {
        if (parseInt(lineEl.dataset.owner, 10) === session.state.currentPlayer) {
          attemptMove(parseInt(lineEl.dataset.destLine, 10));
        }
        return;
      }

      var floorEl = ev.target.closest('[data-dest-floor]');
      if (floorEl && selection) {
        if (parseInt(floorEl.dataset.owner, 10) === session.state.currentPlayer) {
          attemptMove('floor');
        }
      }
    });

    $('#btn-quit-game').addEventListener('click', function () {
      if (session && session.mode === 'online') {
        var code = session.code;
        var idx = session.playerIdx;
        leaveRoomWatch();
        if (window.AzulOnline.isReady()) {
          window.AzulOnline.leaveRoom(code, idx).catch(function () { /* ignore */ });
        }
      }
      session = null;
      selection = null;
      goHome();
    });
  }

  function attemptMove(dest) {
    var s = session.state;
    var move = { source: selection.source, color: selection.color, dest: dest };

    if (session.mode === 'local') {
      var prevRound = s.round;
      try {
        E.applyDraft(s, s.currentPlayer, move);
      } catch (err) {
        toast(err.message, true);
        return;
      }
      selection = null;
      afterLocalMove(prevRound);
      return;
    }

    // Online: the move runs inside a transaction on the shared state.
    window.AzulOnline.submitMove(session.code, session.playerIdx, move)
      .then(function (newState) {
        selection = null;
        if (newState) {
          session.state = window.AzulEngine.normalize(newState);
          if (newState.phase === 'finished') {
            if (newState.lastResolve) setHighlightFromResolve(newState);
            renderGameOver();
            show('screen-gameover');
          } else {
            renderGame();
          }
        }
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function afterLocalMove(prevRound) {
    var s = session.state;
    if (s.phase === 'finished') {
      if (s.lastResolve) setHighlightFromResolve(s);
      renderGameOver();
      show('screen-gameover');
      return;
    }
    if (s.round !== prevRound && s.lastResolve) {
      setHighlightFromResolve(s);
      var parts = s.players.map(function (p, i) {
        var sum = s.lastResolve[i];
        return p.name + ' +' + sum.gained + (sum.penalty ? ' (' + sum.penalty + ' floor)' : '');
      });
      toast('Wall-tiling — ' + parts.join(' · '));
    } else {
      highlight = {};
    }
    renderGame();
  }

  // ------------------------------------------------------------ game over --
  function renderGameOver() {
    var s = session.state;
    var winnerNames = s.winners.map(function (i) { return s.players[i].name; });
    $('#gameover-title').textContent = s.winners.length === 1
      ? '🏆 ' + winnerNames[0] + ' wins!'
      : '🏆 It’s a tie — ' + winnerNames.join(' & ') + ' win!';

    var order = s.players.map(function (_, i) { return i; })
      .sort(function (a, b) { return s.players[b].score - s.players[a].score; });

    $('#gameover-results').innerHTML = order.map(function (pi) {
      var p = s.players[pi];
      var b = s.endBonuses[pi];
      var bonusLine = 'End bonuses: <strong>+' + b.total + '</strong> — ' +
        'rows ' + b.rows + ' (+' + b.rows * 2 + ') · ' +
        'columns ' + b.columns + ' (+' + b.columns * 7 + ') · ' +
        'colors ' + b.colors + ' (+' + b.colors * 10 + ')';
      return '<div class="result-row' + (s.winners.indexOf(pi) !== -1 ? ' winner' : '') + '">' +
        '<div class="result-head"><span>' + esc(p.name) + '</span><span>★ ' + p.score + '</span></div>' +
        '<div class="result-bonus">' + bonusLine + '</div></div>';
    }).join('');

    var playAgain = $('#btn-play-again');
    var note = $('#play-again-note');
    if (session.mode === 'online') {
      var snap = session.roomMeta;
      var isHost = snap ? session.playerIdx === snap.hostIdx : false;
      playAgain.classList.toggle('hidden', !isHost);
      note.classList.toggle('hidden', isHost);
    } else {
      playAgain.classList.remove('hidden');
      note.classList.add('hidden');
    }
  }

  function wireGameOver() {
    $('#btn-play-again').addEventListener('click', function () {
      if (!session) return;
      if (session.mode === 'local') {
        var names = session.state.players.map(function (p) { return p.name; });
        startLocalGame(names);
      } else {
        var btn = this;
        busy(btn, function () {
          return window.AzulOnline.startGame(session.code)
            .catch(function (err) { toast(err.message, true); });
        });
      }
    });
    $('#btn-gameover-home').addEventListener('click', function () {
      if (session && session.mode === 'online') leaveRoomWatch();
      session = null;
      selection = null;
      goHome();
    });
  }

  function goHome() {
    try { window.sessionStorage.removeItem('azul-session'); } catch (e) { /* ignore */ }
    show('screen-home');
  }

  // ----------------------------------------------------------------- init --
  function init() {
    wireHome();
    wireLobby();
    wireGame();
    wireGameOver();

    // Prefill the remembered name.
    try {
      var savedName = window.localStorage.getItem('azul-my-name');
      if (savedName) $('#online-name').value = savedName;
    } catch (e) { /* ignore */ }

    // Invite link? Jump straight to the join flow for that room.
    var params = new URLSearchParams(window.location.search);
    var room = (params.get('room') || '').toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(room)) {
      $('#join-code').value = room;
      var note = $('#invite-note');
      note.textContent = '🎉 You’ve been invited to room ' + room +
        ' — enter your name and tap “Join game”.';
      note.classList.remove('hidden');
      var seat = window.AzulOnline.storedSeat(room);
      if (seat && seat.name) $('#online-name').value = seat.name;
      $('#online-name').focus();
      // If this copy has no Firebase keys, say so right away.
      window.AzulOnline.init().then(function (ready) {
        if (!ready) $('#online-unavailable').classList.remove('hidden');
      });
    }

    // Reload restore: if THIS tab was in a room, silently rejoin it (by
    // name — works for the lobby and for a game already in progress).
    try {
      var saved = window.sessionStorage.getItem('azul-session');
      if (saved) {
        var savedSession = JSON.parse(saved);
        if (savedSession && savedSession.code && savedSession.name &&
            (!room || room === savedSession.code)) {
          window.AzulOnline.init().then(function (ready) {
            if (!ready || session) return;
            window.AzulOnline.joinRoom(savedSession.code, savedSession.name)
              .then(function (res) {
                enterRoom(res.code, res.playerIdx, savedSession.name);
                toast('Welcome back — rejoined room ' + res.code + '.');
              })
              .catch(function () {
                try { window.sessionStorage.removeItem('azul-session'); } catch (e) { /* ignore */ }
              });
          });
        }
      }
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
