/*
 * Azul — Tile Game UI + controllers (local pass-and-play and online rooms).
 * Plain script; depends on window.AzulEngine (js/engine.js) and, only for
 * online mode, window.AzulOnline (js/online.js).
 */
(function () {
  'use strict';

  var E = window.AzulEngine;
  var $ = function (sel) { return document.querySelector(sel); };

  var REDUCED_MOTION = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

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
    document.body.classList.toggle('in-game',
      screenId === 'screen-game' || screenId === 'screen-gameover');
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------ fullscreen --
  // Fullscreen is entered from start/join click handlers (it must stay in
  // the user-gesture call stack). Failures are expected — iPhone Safari has
  // no element fullscreen, and online guests have no gesture when the host
  // starts — so rejections are swallowed quietly, never toasted.
  var fsSupported = !!(document.documentElement && document.documentElement.requestFullscreen);

  function enterFullscreen() {
    if (!fsSupported || document.fullscreenElement) return;
    try {
      var p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () { /* not allowed here — ignore */ });
    } catch (e) { /* ignore */ }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  function updateFsButton() {
    var b = $('#btn-fullscreen');
    if (!b) return;
    var inFs = !!document.fullscreenElement;
    b.textContent = inFs ? '🗗' : '⛶';
    b.setAttribute('aria-label', inFs ? 'Exit Full Screen' : 'Full Screen');
  }

  function isStandalone() {
    return (window.navigator && window.navigator.standalone) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function onFsButton() {
    if (fsSupported) { toggleFullscreen(); return; }
    // No page fullscreen on this browser (iPhone Safari): show how to
    // install Azul to the home screen, where it runs truly full screen.
    $('#fs-help').classList.remove('hidden');
  }

  function wireFullscreen() {
    var b = $('#btn-fullscreen');
    if (!b) return;
    if (isStandalone()) { b.classList.add('hidden'); return; } // already full screen
    b.classList.remove('hidden');
    b.addEventListener('click', onFsButton);
    document.addEventListener('fullscreenchange', updateFsButton);
    var close = $('#btn-fs-help-close');
    if (close) close.addEventListener('click', function () {
      $('#fs-help').classList.add('hidden');
    });
    var help = $('#fs-help');
    if (help) help.addEventListener('click', function (e) {
      if (e.target === help) help.classList.add('hidden');
    });
    updateFsButton();
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
  var flying = false; // tile flight animation in progress (input locked)
  var holdNextSwitch = false; // pause 1s after a flight lands, before the switch
  var switchHoldSeq = 0; // invalidates a stale held switch after re-renders
  var highlight = {};   // "playerIdx:row:col" -> true for just-tiled cells
  var lastTurnKey = null; // "round:currentPlayer" — drives the turn-change animation
  var voiceOptOut = false; // user tapped "Leave voice" in this room session
  var lastAnnouncedRound = null; // round-end pause/dictation handled up to this round
  var startAnnouncedKey = null; // game-start announcement already spoken for this game
  var finalAnnouncedKey = null;  // score signature of the last announced game-over
  var celebrating = false;       // winner celebration overlay is showing
  var roundOverlayTimer = null;

  // ---------------------------------------------------------- sound & voice --
  var soundOn = true;
  try { soundOn = localStorage.getItem('azul-sound') !== 'off'; } catch (e) { /* ignore */ }
  var audioCtx = null;
  var speakTimer = null;

  function ensureAudio() {
    if (!soundOn) return null;
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // iOS/Safari keep WebAudio and speech locked until a real user gesture
  // unlocks them; the first sound here is often attempted from a timer or
  // a sync callback, which leaves both silently dead. Prime both on the
  // first tap anywhere.
  var speechPrimed = false;
  function unlockAudio() {
    if (soundOn) ensureAudio();
    if (!speechPrimed && ('speechSynthesis' in window)) {
      speechPrimed = true;
      try {
        var prime = new SpeechSynthesisUtterance('ready');
        prime.volume = 0;
        window.speechSynthesis.speak(prime);
        window.speechSynthesis.resume();
      } catch (e) { /* ignore */ }
    }
  }
  document.addEventListener('pointerdown', unlockAudio, true);

  // One ceramic "clack": a woody knock (pitch-dropping triangle) + a short
  // filtered-noise click, like a tile tapped on a board.
  function ceramicClack(delay, baseFreq, vol) {
    if (!audioCtx) return;
    var ctx = audioCtx;
    var t = ctx.currentTime + delay;
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, t + 0.07);
    var og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og); og.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.1);
    var len = Math.max(1, Math.floor(ctx.sampleRate * 0.03));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.1;
    var ng = ctx.createGain(); ng.gain.value = vol * 0.9;
    src.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
    src.start(t);
  }

  function playPickup() { if (ensureAudio()) { ceramicClack(0, 920, 0.20); ceramicClack(0.07, 1180, 0.12); } }
  function playPutback() { if (ensureAudio()) ceramicClack(0, 700, 0.10); }
  function playPlace() { if (ensureAudio()) { ceramicClack(0, 620, 0.30); ceramicClack(0.09, 540, 0.22); } }

  // Whoosh for the flying tiles: white noise through a band-pass filter
  // that sweeps up then down, with a swell-and-fade envelope.
  function playWhoosh() {
    if (!ensureAudio()) return;
    var ctx = audioCtx;
    var t = ctx.currentTime;
    var dur = 1.2;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(); src.buffer = buf;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(2100, t + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(420, t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // Short celebratory chime when the winner celebration opens.
  function playFanfare() {
    if (!ensureAudio()) return;
    var ctx = audioCtx;
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      var t = ctx.currentTime + i * 0.13;
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.55);
    });
  }

  // Firecracker pop + crackle for the winner celebration.
  function playPop() {
    if (!ensureAudio()) return;
    var ctx = audioCtx;
    var t = ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * 0.18));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.16);
    var g = ctx.createGain(); g.gain.value = 0.22;
    src.connect(lp); lp.connect(g); g.connect(ctx.destination);
    src.start(t);
    [0.05, 0.11].forEach(function (dl) {
      var s2 = ctx.createBufferSource(); s2.buffer = buf;
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400;
      var g2 = ctx.createGain(); g2.gain.value = 0.07;
      s2.connect(bp); bp.connect(g2); g2.connect(ctx.destination);
      s2.start(t + dl); s2.stop(t + dl + 0.05);
    });
  }

  // After the boards finish shuffling, announce whose turn it is.
  function speakTurn(name) {
    if (!soundOn || !('speechSynthesis' in window)) return;
    if (speakTimer) clearTimeout(speakTimer);
    speakTimer = setTimeout(function () {
      try {
        window.speechSynthesis.cancel();
        // iOS drops an utterance spoken in the same tick as a cancel() —
        // give it a beat, and resume() in case the queue was left paused.
        setTimeout(function () {
          try {
            window.speechSynthesis.resume();
            var u = new SpeechSynthesisUtterance(name + '’s turn now');
            u.rate = 1.02;
            window.speechSynthesis.speak(u);
          } catch (e) { /* ignore */ }
        }, 60);
      } catch (e) { /* ignore */ }
    }, 1200);
  }

  function setSound(on) {
    soundOn = on;
    try { localStorage.setItem('azul-sound', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
    var b = $('#btn-sound');
    if (b) b.textContent = on ? '🔊 Sound On' : '🔇 Sound Off';
    if (!on && ('speechSynthesis' in window)) window.speechSynthesis.cancel();
  }

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

  // Single source of truth for how many local players are in the setup:
  // shows/hides that many name rows, syncs the (now hidden) legacy count
  // picker's active state, and shows "Add player" only below the max.
  function setLocalCount(n) {
    localCount = Math.max(2, Math.min(4, n));
    document.querySelectorAll('.local-row').forEach(function (row, i) {
      row.classList.toggle('hidden', i >= localCount);
    });
    document.querySelectorAll('.local-name').forEach(function (input, i) {
      input.classList.toggle('hidden', i >= localCount);
    });
    var picker = $('#local-count');
    if (picker) {
      picker.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.count, 10) === localCount);
      });
    }
    var addBtn = $('#btn-add-player');
    if (addBtn) addBtn.classList.toggle('hidden', localCount >= 4);
  }

  // Home starts as a mode chooser; picking a mode swaps in its setup card.
  function showHomeSetup(which) {
    var chooser = $('#home-chooser');
    var local = $('#setup-local');
    var online = $('#setup-online');
    if (chooser) chooser.classList.toggle('hidden', !!which);
    if (local) local.classList.toggle('hidden', which !== 'local');
    if (online) online.classList.toggle('hidden', which !== 'online');
  }

  function wireHome() {
    $('#btn-mode-local').addEventListener('click', function () { showHomeSetup('local'); });
    $('#btn-mode-online').addEventListener('click', function () { showHomeSetup('online'); });
    document.querySelectorAll('.btn-back').forEach(function (b) {
      b.addEventListener('click', function () { showHomeSetup(null); });
    });
    $('#btn-how').addEventListener('click', function () {
      $('#how-panel').classList.toggle('hidden');
    });

    // Legacy segmented picker is hidden in the UI now, but keep it wired
    // through the same setLocalCount so the state can never diverge.
    $('#local-count').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-count]');
      if (!btn) return;
      setLocalCount(parseInt(btn.dataset.count, 10));
    });

    $('#btn-add-player').addEventListener('click', function () {
      setLocalCount(localCount + 1);
    });
    document.querySelectorAll('.btn-remove-player').forEach(function (b) {
      b.addEventListener('click', function () {
        // Removing the player on row i leaves players 0..i-1 in the game.
        setLocalCount(parseInt(b.dataset.index, 10));
      });
    });
    setLocalCount(localCount);

    $('#btn-local-start').addEventListener('click', function () {
      enterFullscreen();
      var names = [];
      document.querySelectorAll('.local-name').forEach(function (input, i) {
        if (i < localCount) names.push(input.value.trim() || ('Player ' + (i + 1)));
      });
      startLocalGame(names);
    });

    $('#btn-create-room').addEventListener('click', function () { enterFullscreen(); createRoomFlow(this); });
    $('#btn-join-room').addEventListener('click', function () { enterFullscreen(); joinRoomFlow(this); });
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
        toast("Online play isn't available in this copy — local games work fully.", true);
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
    voiceOptOut = false;
    startVoiceAuto(); // voice chat is on by default in online rooms
  }

  function leaveRoomWatch() {
    if (window.AzulVoice) window.AzulVoice.leave();
    dismissRoundOverlay();
    stopCelebration();
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
        if (window.AzulVoice) window.AzulVoice.updateIdentity(idx);
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
      if (room.meta && room.meta.celebrationDone) {
        // The host tapped the celebration away: everyone goes home.
        if (celebrating) { dismissCelebration(); leaveRoomWatch(); goHome(); }
        return;
      }
      enterCelebration();
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
        : 'Everyone in? Tap Start when ready — players can’t join once the game begins.';
    } else {
      startBtn.classList.add('hidden');
      $('#lobby-status').textContent = 'Waiting for the host to start the game…';
    }
    renderVoice();
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
      enterFullscreen();
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

  // Factories show their 4 tiles as a strict 2x2 grid of individual tiles
  // so nothing can spill outside the disc. Each tile is its own button, but
  // it carries the same data-* contract as a color group: tapping any tile
  // selects that color's whole group. A color with 2+ tiles is aligned to
  // the right column of the grid, and its count badge sits on that color's
  // top-right tile.
  function factoryGridHtml(tiles, source) {
    var counts = {};
    tiles.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    // Display order: colors grouped together, most-duplicated first, dealt
    // into the right column first (cells 1, 3), then the left (0, 2).
    var colorOrder = E.COLORS.filter(function (c) { return counts[c]; })
      .sort(function (a, b) { return counts[b] - counts[a]; });
    var sorted = [];
    colorOrder.forEach(function (c) {
      for (var i = 0; i < counts[c]; i++) sorted.push(c);
    });
    var posOrder = [1, 3, 0, 2];
    var placed = [null, null, null, null];
    sorted.forEach(function (color, k) { placed[posOrder[k]] = color; });
    // Badge cell per color: its topmost cell, rightmost within that row.
    var badgeAt = {};
    placed.forEach(function (color, p) {
      if (!color || counts[color] < 2) return;
      var cur = badgeAt[color];
      if (cur === undefined || (p >> 1) < (cur >> 1) ||
          ((p >> 1) === (cur >> 1) && (p & 1) > (cur & 1))) badgeAt[color] = p;
    });
    return placed.map(function (color, p) {
      var sel = selection && selection.color === color &&
        selection.source.kind === 'factory' && selection.source.index === source.index;
      return '<button type="button" class="tile-group factory-tile' +
        (canInteract() ? ' pickable' : '') + (sel ? ' selected' : '') + '"' +
        ' data-kind="factory" data-index="' + source.index + '"' +
        ' data-color="' + color + '"' +
        (canInteract() ? '' : ' disabled') +
        ' aria-label="' + counts[color] + ' ' + color + ' tiles">' +
        tileHtml(color, true) +
        (badgeAt[color] === p ? '<span class="group-count">' + counts[color] + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function renderGame() {
    var s = session.state;
    if (!s) return;
    stopCelebration();
    var prevBannerHTML = $('#turn-banner').innerHTML;
    var prevHint = $('#selection-hint').textContent;
    var cur = s.players[s.currentPlayer];

    // --- banner ---
    var main;
    var sub;
    if (s.phase === 'finished') {
      main = 'Game finished';
      sub = '';
    } else if (session.mode === 'online' && s.currentPlayer !== session.playerIdx) {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'Waiting for ' + cur.name + ' to make a move…';
    } else if (session.mode === 'online') {
      main = 'Round ' + s.round + ' — your turn!';
      sub = 'Draft tiles from a factory or the center, then place them on a line.';
    } else {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'Pass the device to ' + cur.name + ' — draft tiles from a factory or the center.';
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
        (tiles.length ? factoryGridHtml(tiles, { kind: 'factory', index: i })
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
        ? 'Factory ' + (selection.source.index + 1) : 'the Center';
      hint = n + ' ' + selection.color + ' tile' + (n === 1 ? '' : 's') + ' selected' +
        ' from ' + from + ' — tap a highlighted pattern line, or the floor line.';
    } else if (canInteract()) {
      hint = 'Tap a group of tiles to pick them up.';
    }
    $('#selection-hint').textContent = hint;

    // --- round end? pause and dictate the scores before play resumes ---
    var justEndedRound = false;
    if (lastAnnouncedRound === null || s.round < lastAnnouncedRound) {
      lastAnnouncedRound = s.round; // baseline: fresh game, play-again or reload
    } else if (s.round > lastAnnouncedRound && s.lastResolve && s.phase === 'draft') {
      lastAnnouncedRound = s.round;
      justEndedRound = true;
      roundEndPause(s);
    }

    // --- fresh game? announce the round and the first player once ---
    if (s.phase === 'draft' && s.round === 1 &&
        s.players.every(function (p) {
          return p.floor.length === 0 &&
            p.patternLines.every(function (l) { return l.length === 0; });
        })) {
      var gameKey = (session.mode === 'online' ? session.code : 'local') + '|' +
        s.players.map(function (p) { return p.name; }).join(',') + '|' +
        (s.bag || []).slice(0, 12).join(',');
      if (startAnnouncedKey !== gameKey) {
        startAnnouncedKey = gameKey;
        speakAloud('Round 1 started. ' + s.players[s.currentPlayer].name + '’s turn now');
      }
    }

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

    // Turn changed? Circle-switch the boards over ~1s: the outgoing
    // board arcs slowly DOWN into its new slot while the next player's
    // board arcs slowly UP into the top slot, passing each other like a
    // revolving switch (with a whoosh); the announcement comes after.
    var turnKey = s.round + ':' + s.currentPlayer + ':' + s.phase;
    var turnChanged = lastTurnKey !== null && turnKey !== lastTurnKey && s.phase === 'draft';
    var prevPlayer = null;
    if (lastTurnKey) {
      var keyParts = lastTurnKey.split(':');
      if (keyParts.length === 3) prevPlayer = parseInt(keyParts[1], 10);
    }
    lastTurnKey = turnKey;
    if (turnChanged) {
      var bannerEl = $('#turn-banner');
      bannerEl.classList.add('pulse');
      bannerEl.scrollIntoView({ block: 'start' });
      // Collect every board that has to travel to its new slot.
      var switchBoards = [];
      boardsEl.querySelectorAll('.board').forEach(function (b) {
        var old = prevRects[b.dataset.player];
        if (!old || !b.animate) return;
        var nr = b.getBoundingClientRect();
        var dx = old.left - (nr.left + window.scrollX);
        var dy = old.top - (nr.top + window.scrollY);
        if (!dx && !dy) return;
        switchBoards.push({
          b: b, dx: dx, dy: dy,
          isIn: b.classList.contains('turn'),
          isOut: prevPlayer !== null && parseInt(b.dataset.player, 10) === prevPlayer
        });
      });
      var startSwitch = function () {
        playWhoosh();
        switchBoards.forEach(function (it) {
          it.b.style.zIndex = it.isIn ? 3 : 2;
          var keyframes;
          if (it.isIn || it.isOut) {
            // Swing out in opposite arcs with a slight tilt, like the
            // two boards are mounted on a revolving wheel.
            var arc = it.isIn ? -26 : 26;
            var tilt = it.isIn ? -1.4 : 1.4;
            keyframes = [
              { transform: 'translate(' + it.dx + 'px, ' + it.dy + 'px) rotate(0deg)' },
              { transform: 'translate(' + (it.dx * 0.5 + arc) + 'px, ' + (it.dy * 0.5) + 'px) rotate(' + tilt + 'deg) scale(.985)', offset: 0.5 },
              { transform: 'translate(0px, 0px) rotate(0deg) scale(1)' }
            ];
          } else {
            keyframes = [
              { transform: 'translate(' + it.dx + 'px, ' + it.dy + 'px)' },
              { transform: 'translate(0px, 0px)' }
            ];
          }
          var anim = it.b.animate(keyframes, { duration: 1000, easing: 'cubic-bezier(.4, .05, .3, 1)' });
          anim.onfinish = function () { it.b.style.zIndex = ''; };
        });
        var topBoard = $('#boards .board.turn');
        if (topBoard) topBoard.classList.add('turn-enter');
      };
      if (holdNextSwitch && !justEndedRound) {
        // The tiles just flew in and took their positions (this render
        // already applied the move and cleared the selection). Hold the
        // boards in the old arrangement for a full second so everyone
        // can take in the play, THEN switch the turn.
        holdNextSwitch = false;
        playPlace();
        var holdSeq = ++switchHoldSeq;
        var heldBannerHTML = bannerEl.innerHTML;
        bannerEl.innerHTML = prevBannerHTML;
        var hintEl = $('#selection-hint');
        var heldHint = hintEl.textContent;
        hintEl.textContent = prevHint;
        switchBoards.forEach(function (it) {
          it.b.style.transform = 'translate(' + it.dx + 'px, ' + it.dy + 'px)';
          it.b.style.zIndex = it.isIn ? 3 : 2;
        });
        setTimeout(function () {
          flying = false;
          if (holdSeq !== switchHoldSeq) return;
          bannerEl.innerHTML = heldBannerHTML;
          hintEl.textContent = heldHint;
          switchBoards.forEach(function (it) { it.b.style.transform = ''; });
          startSwitch();
          speakTurn(cur.name);
        }, 1000);
      } else {
        holdNextSwitch = false;
        flying = false;
        startSwitch();
        playPlace();
        if (!justEndedRound) speakTurn(cur.name); // round-end dictation takes over
      }
    } else if (holdNextSwitch) {
      holdNextSwitch = false;
      flying = false;
    }
    renderVoice();
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

    var resolve = s.lastResolve && s.lastResolve[pi];
    var roundChip = '';
    if (resolve) {
      var net = resolve.gained + resolve.penalty;
      roundChip = '<span class="round-chip" title="Last wall-tiling: +' + resolve.gained +
        ' from the wall' + (resolve.penalty ? ', ' + resolve.penalty + ' floor penalties' : '') +
        '">' + (net >= 0 ? '+' : '') + net + ' last round</span>';
    }

    return '<div class="board' + (isTurnBoard ? ' turn' : ' compact') +
      '" data-player="' + pi + '">' +
      '<div class="board-head"><span class="board-name">' + esc(p.name) + youTag + '</span>' +
      '<span class="board-right">' + roundChip +
      '<span class="board-score">★ ' + p.score + '</span></span></div>' +
      '<div class="board-main"><div class="pattern-lines">' + lines + '</div>' +
      '<div class="wall">' + wall + '</div></div>' +
      '<div class="floor-line"><div class="floor-label">Floor line</div>' +
      '<div class="floor-slots' + (interact && selection ? ' droppable' : '') +
      '" data-owner="' + pi + '" data-dest-floor="1">' + floorSlots + '</div></div>' +
      '</div>';
  }

  function wireGame() {
    $('#round-overlay').addEventListener('click', dismissRoundOverlay);

    $('#celebration').addEventListener('click', function () {
      if (!celebrating || !session) return;
      if (session.mode === 'online') {
        var isHost = session.roomMeta &&
          session.playerIdx === session.roomMeta.hostIdx;
        if (!isHost) { toast('Waiting for the host to tap…'); return; }
        if (window.AzulOnline.endCelebration) {
          window.AzulOnline.endCelebration(session.code);
        }
        leaveRoomWatch();
      }
      dismissCelebration();
      goHome();
    });

    $('#screen-game').addEventListener('click', function (ev) {
      if (!session || !session.state) return;
      if (flying) return; // tiles are mid-flight; ignore game taps

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
          playPutback();
        } else {
          selection = { source: source, color: color };
          playPickup();
        }
        renderGame();
        return;
      }

      var lineEl = ev.target.closest('[data-dest-line]');
      if (lineEl && selection) {
        if (parseInt(lineEl.dataset.owner, 10) === session.state.currentPlayer) {
          flyAndMove(parseInt(lineEl.dataset.destLine, 10), lineEl);
        }
        return;
      }

      var floorEl = ev.target.closest('[data-dest-floor]');
      if (floorEl && selection) {
        if (parseInt(floorEl.dataset.owner, 10) === session.state.currentPlayer) {
          flyAndMove('floor', floorEl);
        }
      }
    });

    $('#btn-sound').addEventListener('click', function () {
      setSound(!soundOn);
      if (soundOn) playPickup();
    });
    setSound(soundOn);

    $('#btn-quit-game').addEventListener('click', function () {
      if (speakTimer) clearTimeout(speakTimer);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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

  // Fly the selected tiles in a slow circular arc — down and to the
  // right — into the exact slots they will occupy, with a whoosh. The
  // moment they land the move applies (tiles take their real positions,
  // selection clears), then the turn switch pauses a full second so
  // everyone can take in what was played.
  function flyAndMove(dest, targetEl) {
    if (flying || !selection) return;
    var tiles = [];
    document.querySelectorAll('#screen-game .tile-group.selected').forEach(function (g) {
      g.querySelectorAll('.tile').forEach(function (t) { tiles.push(t); });
    });
    // NOTE: no reduced-motion skip here — the flight is a requested
    // feature; the OS setting silently killed it on the user's phone.
    if (!tiles.length || !targetEl || !tiles[0].animate) {
      attemptMove(dest);
      return;
    }
    flying = true;
    playWhoosh();

    // Landing spots: the exact slots the tiles are about to occupy
    // (overflow past a full pattern line runs to the floor line).
    var s = session.state;
    var cur = s.players[s.currentPlayer];
    function spotCenter(el, fallbackEl, fx) {
      var r = (el || fallbackEl).getBoundingClientRect();
      return el
        ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        : { x: r.left + r.width * fx, y: r.top + r.height / 2 };
    }
    var spots = tiles.map(function (t, i) {
      if (dest === 'floor') {
        var fslot = targetEl.querySelectorAll('.floor-slot')[cur.floor.length + i];
        return spotCenter(fslot, targetEl, 0.3 + 0.14 * i);
      }
      var lineLen = cur.patternLines[dest].length;
      var free = (dest + 1) - lineLen;
      if (i < free) {
        return spotCenter(targetEl.querySelectorAll('.slot')[lineLen + i], targetEl, 0.8);
      }
      var board = targetEl.closest('.board');
      var ofSlot = board
        ? board.querySelectorAll('.floor-slot')[cur.floor.length + (i - free)] : null;
      return spotCenter(ofSlot, targetEl, 0.8);
    });

    var clones = [];
    var FLIGHT_MS = 1150;
    tiles.forEach(function (t, i) {
      var r = t.getBoundingClientRect();
      var clone = t.cloneNode(true);
      clone.classList.add('fly-tile');
      clone.style.left = r.left + 'px';
      clone.style.top = r.top + 'px';
      clone.style.width = r.width + 'px';
      clone.style.height = r.height + 'px';
      document.body.appendChild(clone);
      clones.push(clone);
      var sx = r.left + r.width / 2;
      var sy = r.top + r.height / 2;
      var ex = spots[i].x;
      var ey = spots[i].y;
      // Circular motion: a quadratic arc bulging down-right, with the
      // tile making a full turn as it travels.
      var cx = Math.max(sx, ex) + 110;
      var cy = (sy + ey) / 2;
      var frames = [];
      var STEPS = 6;
      for (var k = 0; k <= STEPS; k++) {
        var u = k / STEPS;
        var bx = (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * ex;
        var by = (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * ey;
        frames.push({
          transform: 'translate(' + (bx - sx) + 'px, ' + (by - sy) + 'px) rotate(' +
            (360 * u) + 'deg) scale(' + (1 + 0.15 * Math.sin(Math.PI * u)) + ')',
          offset: u
        });
      }
      clone.animate(frames, {
        duration: FLIGHT_MS, delay: i * 90, easing: 'ease-in-out', fill: 'forwards'
      });
    });
    // Land -> the move applies at once (tiles take their real positions,
    // selection clears) -> renderGame holds the turn switch for 1s.
    setTimeout(function () {
      clones.forEach(function (c) { c.remove(); });
      holdNextSwitch = true;
      attemptMove(dest);
    }, FLIGHT_MS + (tiles.length - 1) * 90);
  }

  function attemptMove(dest) {
    var s = session.state;
    var move = { source: selection.source, color: selection.color, dest: dest };

    if (session.mode === 'local') {
      var prevRound = s.round;
      try {
        E.applyDraft(s, s.currentPlayer, move);
      } catch (err) {
        flying = false;
        holdNextSwitch = false;
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
            enterCelebration();
          } else {
            renderGame();
          }
        }
      })
      .catch(function (err) {
        flying = false;
        holdNextSwitch = false;
        toast(err.message, true);
      });
  }

  function afterLocalMove(prevRound) {
    var s = session.state;
    if (s.phase === 'finished') {
      if (s.lastResolve) setHighlightFromResolve(s);
      enterCelebration();
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

  // --------------------------------------------------------------- voice --
  // Voice chat is ON by default in online rooms: entering a room joins
  // voice automatically (the browser asks for mic permission the first
  // time). "Leave voice" opts out for the rest of that room session.
  function startVoiceAuto() {
    var V = window.AzulVoice;
    if (!V || !session || session.mode !== 'online' || voiceOptOut) {
      renderVoice();
      return;
    }
    V.join(session.code, session.playerIdx, session.myName).catch(function () {
      // Mic blocked or unavailable — the voice box shows "Enable voice".
      renderVoice();
    });
    renderVoice();
  }

  function renderVoice() {
    var V = window.AzulVoice;
    var snap = V ? V.snapshot()
      : { active: false, joining: false, blocked: false, muted: false, members: [] };
    var inOnline = !!(session && session.mode === 'online');
    document.querySelectorAll('.voice-box').forEach(function (box) {
      box.classList.toggle('hidden', !inOnline);
      if (!inOnline) return;
      var status = box.querySelector('.voice-status');
      var members = box.querySelector('.voice-members');
      var muteBtn = box.querySelector('.btn-voice-mute');
      var toggleBtn = box.querySelector('.btn-voice-toggle');
      if (status) {
        status.textContent = snap.joining ? '· Connecting…'
          : snap.active ? '· On'
          : snap.blocked ? '· Mic blocked' : '· Off';
      }
      if (members) {
        members.innerHTML = snap.members.length ? snap.members.map(function (m) {
          return '<span class="voice-chip' + (m.speaking ? ' speaking' : '') +
            (m.muted ? ' is-muted' : '') + '">' +
            (m.speaking ? '🔊 ' : '🎙️ ') + esc(m.name) + (m.me ? ' (you)' : '') +
            (m.muted ? ' 🔇' : '') +
            (!m.me && snap.active && !m.connected ? ' · Connecting…' : '') +
            '</span>';
        }).join('') : '<span class="voice-none">No one in voice yet</span>';
      }
      if (muteBtn) {
        muteBtn.disabled = !snap.active;
        muteBtn.textContent = snap.muted ? '🔊 Unmute' : '🔇 Mute';
      }
      if (toggleBtn) {
        toggleBtn.textContent = (snap.active || snap.joining) ? 'Leave Voice' : 'Enable Voice';
      }
    });
  }

  function wireVoice() {
    if (window.AzulVoice) {
      window.AzulVoice.setCallbacks({ onChange: function () { renderVoice(); } });
    }
    document.querySelectorAll('.btn-voice-mute').forEach(function (b) {
      b.addEventListener('click', function () {
        var V = window.AzulVoice;
        if (V) V.setMuted(!V.snapshot().muted);
      });
    });
    document.querySelectorAll('.btn-voice-toggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var V = window.AzulVoice;
        if (!V || !session || session.mode !== 'online') return;
        if (V.isActive()) {
          voiceOptOut = true;
          V.leave();
        } else {
          voiceOptOut = false;
          V.join(session.code, session.playerIdx, session.myName)
            .catch(function (err) { toast(err.message || 'Microphone unavailable', true); });
        }
        renderVoice();
      });
    });
  }

  // ------------------------------------------------------ round-end pause --
  // Speak text aloud (respecting the sound toggle); onEnd fires when the
  // speech finishes, or after a fallback delay when speech is off/absent.
  function speakAloud(text, onEnd) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      if (onEnd) onEnd();
    };
    if (!soundOn || !('speechSynthesis' in window)) {
      if (onEnd) setTimeout(finish, 3400);
      return;
    }
    try {
      if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onend = finish;
      u.onerror = finish;
      // Same iOS cancel-then-speak race as speakTurn: wait a beat first.
      setTimeout(function () {
        try {
          window.speechSynthesis.resume();
          window.speechSynthesis.speak(u);
        } catch (e) { finish(); }
      }, 60);
      setTimeout(finish, 12000); // fallback if onend never fires
    } catch (e) {
      if (onEnd) setTimeout(finish, 3400);
    }
  }

  function armRoundOverlay(ms) {
    if (roundOverlayTimer) clearTimeout(roundOverlayTimer);
    roundOverlayTimer = setTimeout(dismissRoundOverlay, ms);
  }

  function dismissRoundOverlay() {
    if (roundOverlayTimer) { clearTimeout(roundOverlayTimer); roundOverlayTimer = null; }
    var ov = $('#round-overlay');
    if (ov) ov.classList.add('hidden');
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
  }

  // Pause at the end of a round: show every player's round gains and
  // total, dictate the totals, and announce the next round.
  function roundEndPause(s) {
    var ended = s.round - 1;
    $('#round-title').textContent = 'Round ' + ended + ' complete';
    $('#round-scores').innerHTML = s.players.map(function (p, i) {
      var r = (s.lastResolve && s.lastResolve[i]) || { gained: 0, penalty: 0 };
      var net = r.gained + r.penalty;
      return '<div class="round-row"><span class="round-name">' + esc(p.name) + '</span>' +
        '<span class="round-detail">+' + r.gained + ' wall' +
        (r.penalty ? ' · ' + r.penalty + ' floor' : '') + '</span>' +
        '<span class="round-net">' + (net >= 0 ? '+' : '') + net + '</span>' +
        '<span class="round-total">★ ' + p.score + '</span></div>';
    }).join('');
    $('#round-next').textContent = 'Tap anywhere to start Round ' + s.round;
    $('#round-overlay').classList.remove('hidden');
    var text = 'Round ' + ended + ' over. ' + s.players.map(function (p) {
      return p.name + ': ' + p.score + ' points';
    }).join('. ') + '. Tap to start round ' + s.round + '.';
    // Tap-only: the next round never starts on its own — no auto-dismiss
    // after the speech, and no time cap.
    speakAloud(text);
  }

  function announceFinalScores(s) {
    var text = 'Game over. Final scores: ' + s.players.map(function (p) {
      return p.name + ': ' + p.score + ' points';
    }).join('. ') + '. ' + (s.winners.length === 1
      ? s.players[s.winners[0]].name + ' wins!'
      : 'It is a tie between ' + s.winners.map(function (i) {
          return s.players[i].name;
        }).join(' and ') + '!');
    speakAloud(text, null);
  }

  // ------------------------------------------------------------ fireworks --
  var fw = { raf: 0, running: false, parts: [], rockets: [], lastLaunch: 0, endAt: 0 };
  var FW_COLORS = ['#f4b400', '#4fb3c4', '#f2604f', '#63a4ec', '#f5f1e6'];

  function fwExplode(x, y, color) {
    for (var i = 0; i < 70; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 1 + Math.random() * 4.6;
      fw.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.75 + Math.random() * 0.45,
        color: Math.random() < 0.22 ? '#f5f1e6' : color
      });
    }
  }

  function startCelebration() {
    var cv = $('#fireworks');
    if (!cv || fw.running) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    fw.running = true;
    cv.classList.remove('hidden');
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    fw.parts = [];
    fw.rockets = [];
    fw.lastLaunch = 0;
    fw.endAt = Infinity; // runs until the celebration is tapped away
    var loop = function (ts) {
      if (!fw.running) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (Date.now() < fw.endAt && ts - fw.lastLaunch > 420) {
        fw.lastLaunch = ts;
        fw.rockets.push({
          x: cv.width * (0.15 + Math.random() * 0.7),
          y: cv.height + 6,
          vy: -(cv.height * 0.011 + Math.random() * 3),
          target: cv.height * (0.16 + Math.random() * 0.3),
          color: FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)]
        });
      }
      fw.rockets = fw.rockets.filter(function (r) {
        r.y += r.vy;
        r.vy += 0.05;
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffe9a8';
        ctx.fillRect(r.x - 1.5, r.y - 1.5, 3, 3);
        if (r.y <= r.target || r.vy >= -1) {
          fwExplode(r.x, r.y, r.color);
          if (soundOn) playPop();
          return false;
        }
        return true;
      });
      fw.parts = fw.parts.filter(function (p) {
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.045; p.vx *= 0.985; p.vy *= 0.99;
        p.life -= 0.011;
        if (p.life <= 0) return false;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
        return true;
      });
      ctx.globalAlpha = 1;
      if (Date.now() < fw.endAt || fw.parts.length || fw.rockets.length) {
        fw.raf = requestAnimationFrame(loop);
      } else {
        stopCelebration();
      }
    };
    fw.raf = requestAnimationFrame(loop);
  }

  function stopCelebration() {
    if (fw.raf) cancelAnimationFrame(fw.raf);
    fw.raf = 0;
    fw.running = false;
    fw.parts = [];
    fw.rockets = [];
    var cv = $('#fireworks');
    if (cv) {
      var ctx = cv.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      cv.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------ game over --
  // Game over: celebrate OVER the game screen — a transparent veil with
  // the congratulations gif and continuous fireworks (with pops), every
  // player's board visible below sorted by score. It stays until a tap
  // (online: the host's tap ends it for everyone) and then goes home.
  function enterCelebration() {
    var s = session.state;
    if (!s || s.phase !== 'finished' || celebrating) return;
    celebrating = true;
    flying = false;
    holdNextSwitch = false;
    selection = null;
    show('screen-game');
    $('#screen-game').classList.add('game-over-mode');
    window.scrollTo(0, 0);

    var winnerNames = s.winners.map(function (i) { return s.players[i].name; });
    var title = s.winners.length === 1
      ? '🏆 ' + winnerNames[0] + ' wins!'
      : '🏆 It’s a tie — ' + winnerNames.join(' & ') + ' win!';
    var scoresLine = s.players.map(function (p) {
      return p.name + ' ★ ' + p.score;
    }).join(' · ');
    $('#turn-banner').innerHTML =
      '<div class="turn-main">' + esc(title) + '</div>' +
      '<div class="turn-sub">Final scores — ' + esc(scoresLine) + '</div>';

    var order = s.players.map(function (_, i) { return i; })
      .sort(function (a, b) { return s.players[b].score - s.players[a].score; });
    $('#boards').innerHTML = order.map(function (pi) {
      return boardHtml(s, pi).replace('board turn', 'board');
    }).join('');

    var isOnline = session.mode === 'online';
    var isHost = !isOnline ||
      (session.roomMeta && session.playerIdx === session.roomMeta.hostIdx);
    $('#celebration-title').textContent = title;
    $('#celebration-sub').textContent = isOnline && !isHost
      ? 'Waiting for the host to tap…'
      : 'Tap anywhere to return home';
    $('#celebration').classList.remove('hidden');

    var finalKey = s.players.map(function (p) { return p.score; }).join(',') +
      '|' + s.winners.join(',');
    if (finalAnnouncedKey !== finalKey) {
      finalAnnouncedKey = finalKey;
      announceFinalScores(s);
      playFanfare();
    }
    startCelebration();
  }

  function dismissCelebration() {
    celebrating = false;
    stopCelebration();
    var ov = $('#celebration');
    if (ov) ov.classList.add('hidden');
    var gameEl = $('#screen-game');
    if (gameEl) gameEl.classList.remove('game-over-mode');
  }

  function renderGameOver() {
    var s = session.state;
    var finalKey = s.players.map(function (p) { return p.score; }).join(',') +
      '|' + s.winners.join(',');
    if (finalAnnouncedKey !== finalKey) {
      finalAnnouncedKey = finalKey;
      announceFinalScores(s);
      startCelebration();
    }
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
      enterFullscreen();
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
    if (window.AzulVoice) window.AzulVoice.leave();
    dismissRoundOverlay();
    dismissCelebration();
    stopCelebration();
    try { window.sessionStorage.removeItem('azul-session'); } catch (e) { /* ignore */ }
    // Land on the mode chooser, not on whichever setup screen was used.
    $('#home-chooser').classList.remove('hidden');
    $('#setup-local').classList.add('hidden');
    $('#setup-online').classList.add('hidden');
    show('screen-home');
  }

  // ----------------------------------------------------------------- init --
  function init() {
    wireHome();
    wireLobby();
    wireGame();
    wireGameOver();
    wireVoice();
    wireFullscreen();

    // First tap anywhere also unlocks remote voice audio (autoplay rules).
    document.addEventListener('pointerdown', function () {
      if (window.AzulVoice) window.AzulVoice.unlockAudio();
    });

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
      showHomeSetup('online'); // jump straight to the join setup
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
