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

  // ---------------------------------------------------------- sound check --
  function refreshSoundCheck() {
    var b = $('#sc-browser');
    if (!b) return;
    b.textContent = navigator.userAgent;
    $('#sc-ctx').textContent = audioCtx ? audioCtx.state : 'Not started yet';
    var ss = window.speechSynthesis;
    $('#sc-speech').textContent = !ss ? 'Not available in this browser'
      : ss.speaking ? 'Speaking now'
      : ss.pending ? 'Waiting to speak'
      : ss.paused ? 'Paused'
      : 'Ready';
    var V = window.AzulVoice;
    $('#sc-voice').textContent = V && V.ctxState ? V.ctxState() : '—';
    var log = $('#audio-log');
    if (log) log.textContent = audioLog.length ? audioLog.slice(-14).join('\n') : 'No audio events yet.';
  }

  function wireSoundCheck() {
    document.querySelectorAll('.btn-sc-open').forEach(function (b) {
      b.addEventListener('click', function () {
        refreshSoundCheck();
        $('#sound-check').classList.remove('hidden');
      });
    });
    var close = $('#btn-sc-close');
    if (close) close.addEventListener('click', function () {
      $('#sound-check').classList.add('hidden');
    });
    var panel = $('#sound-check');
    if (panel) panel.addEventListener('click', function (e) {
      if (e.target === panel) panel.classList.add('hidden');
    });
    var testSound = $('#btn-sc-sound');
    if (testSound) testSound.addEventListener('click', function () {
      alog('Test sound tapped');
      playPickup();
      setTimeout(playWhoosh, 300);
      setTimeout(playPlace, 1600);
      setTimeout(refreshSoundCheck, 100);
    });
    var testSpeak = $('#btn-sc-speak');
    if (testSpeak) testSpeak.addEventListener('click', function () {
      speakAloud('Sound check. Announcements are working.');
      setTimeout(refreshSoundCheck, 100);
    });
  }

  // -------------------------------------------------------------- session --
  // session = {
  //   mode: 'local' | 'online',
  //   state: <engine state>,
  //   // online only:
  //   code, playerIdx, myName, unwatch,
  //   // mySeats: every seat this device plays — [playerIdx] normally;
  //   // in a Local+Online room the host device owns seats 0..localCount-1.
  //   mySeats
  // }
  var session = null;

  // Does this device play seat i? Single source for every turn check,
  // so Local+Online seats behave exactly like "my" seat everywhere.
  function ownsSeat(i) {
    if (!session) return false;
    if (session.mySeats && session.mySeats.length) {
      return session.mySeats.indexOf(i) !== -1;
    }
    return i === session.playerIdx;
  }
  var selection = null; // { source: {kind, index?}, color }
  var remoteSel = null; // another player's live selection (online): {by, kind, index, color}
  var remoteReplay = null; // a remote move being replayed here: {id, by, landed, stash, timer}
  var lastRemoteMoveId = null;
  var flying = false; // tile flight animation in progress (input locked)
  var holdNextSwitch = false; // pause 1s after a flight lands, before the switch
  var switchHoldSeq = 0; // invalidates a stale held switch after re-renders
  var highlight = {};   // "playerIdx:row:col" -> true for just-tiled cells
  var lastTurnKey = null; // "round:currentPlayer" — drives the turn-change animation
  var voiceOptOut = false; // user tapped "Leave voice" in this room session
  var voiceLockCut = false; // voice auto-disconnected for privacy (screen off / app hidden); reconnect is manual only
  var lastAnnouncedRound = null; // round-end pause/dictation handled up to this round
  var startAnnouncedKey = null; // game-start announcement already spoken for this game
  var finalAnnouncedKey = null;  // score signature of the last announced game-over
  var celebrating = false;       // winner celebration overlay is showing
  var overviewOn = false;        // zoomed-out all-boards view (game screen)
  var roundOverlayTimer = null;

  // ---------------------------------------------------------- sound & voice --
  var soundOn = true;
  try { soundOn = localStorage.getItem('azul-sound') !== 'off'; } catch (e) { /* ignore */ }
  var audioCtx = null;
  var speakTimer = null;

  // ------------------------------------------------ audio diagnostics --
  // A small ring log of what the audio stack actually did — speech
  // start/finish/error events and sound-engine state changes — shown
  // in the Sound Check panel. On iPhone this is the evidence that
  // separates "the announcement never started" from "it started but
  // came out somewhere inaudible" (earpiece routing, silent switch).
  var audioLog = [];
  function alog(msg) {
    var d = new Date();
    var ts = ('0' + d.getHours()).slice(-2) + ':' +
      ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    audioLog.push(ts + ' ' + msg);
    if (audioLog.length > 40) audioLog.shift();
    var sc = $('#sound-check');
    if (sc && !sc.classList.contains('hidden')) refreshSoundCheck();
  }
  window.AzulAudioLog = alog;

  var lastCtxState = '';
  function noteCtxState() {
    if (!audioCtx) return;
    if (audioCtx.state !== lastCtxState) {
      lastCtxState = audioCtx.state;
      alog('Game sound engine: ' + lastCtxState);
    }
  }

  function ensureAudio() {
    if (!soundOn) return null;
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      audioCtx.onstatechange = noteCtxState;
      noteCtxState();
    }
    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
      try { audioCtx.resume(); } catch (e) { /* ignore */ }
    }
    return audioCtx;
  }

  // Coming back to the tab can leave the engine suspended/interrupted
  // on iOS — wake it (the next tap finishes the job if iOS insists on
  // a gesture).
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      if (audioCtx && audioCtx.state !== 'running') {
        try { audioCtx.resume(); } catch (e) { /* ignore */ }
      }
      if (window.AzulVoice) window.AzulVoice.unlockAudio();
    }
  });

  // iOS/Safari keep WebAudio and speech locked until a real user gesture
  // unlocks them; the first sound here is often attempted from a timer or
  // a sync callback, which leaves both silently dead. Prime both on the
  // first tap anywhere.
  var speechPrimed = false;
  function unlockAudio() {
    if (soundOn) ensureAudio();
    if ('speechSynthesis' in window) {
      // iOS can leave the speech queue paused after a backgrounding or
      // an interrupted utterance; a paused queue swallows every later
      // announcement silently, so un-pause it on every tap.
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } catch (e) { /* ignore */ }
    }
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

  // v77: block WebKit's gesture-zoom outright (companion to the
  // viewport maximum-scale + touch-action rules) so Chrome on iOS
  // can never rescale the page mid-game.
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function (e) { e.preventDefault(); });

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
        var ss = window.speechSynthesis;
        // Only cancel when something is actually queued — an idle
        // cancel() is what makes iOS drop the utterance that follows.
        if (ss.speaking || ss.pending) ss.cancel();
        // iOS drops an utterance spoken in the same tick as a cancel() —
        // give it a beat, and resume() in case the queue was left paused.
        setTimeout(function () {
          try {
            window.speechSynthesis.resume();
            var u = new SpeechSynthesisUtterance(name + '’s turn now');
            u.rate = 1.02;
            u.onstart = function () { alog('Announcement started: ' + name + '’s turn'); };
            u.onend = function () { alog('Announcement finished: ' + name + '’s turn'); };
            u.onerror = function (ev) { alog('Announcement ERROR (' + (ev && ev.error ? ev.error : 'unknown') + '): ' + name + '’s turn'); };
            alog('Announcement requested: ' + name + '’s turn');
            window.speechSynthesis.speak(u);
            // Belt and braces: un-pause again right after queueing.
            window.speechSynthesis.resume();
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
    var hybrid = $('#setup-hybrid');
    if (chooser) chooser.classList.toggle('hidden', !!which);
    if (local) local.classList.toggle('hidden', which !== 'local');
    if (online) online.classList.toggle('hidden', which !== 'online');
    if (hybrid) hybrid.classList.toggle('hidden', which !== 'hybrid');
    // While a setup form is open, hide the logo header entirely and put
    // the form at the very top — otherwise the phone keyboard pushes the
    // name fields around and they have to be scrolled into view by hand.
    document.body.classList.toggle('config-open', !!which);
    if (which) window.scrollTo(0, 0);
  }

  function wireHome() {
    $('#btn-mode-local').addEventListener('click', function () { showHomeSetup('local'); });
    $('#btn-mode-online').addEventListener('click', function () { showHomeSetup('online'); });
    $('#btn-mode-hybrid').addEventListener('click', function () { showHomeSetup('hybrid'); });
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

    // Local+Online setup: 2 or 3 players on this device.
    setHybridCount(hybridCount);
    $('#hybrid-count').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-count]');
      if (!btn) return;
      setHybridCount(parseInt(btn.dataset.count, 10));
    });
    $('#btn-create-hybrid').addEventListener('click', function () { enterFullscreen(); createHybridRoomFlow(this); });

    $('#btn-create-room').addEventListener('click', function () { enterFullscreen(); createRoomFlow(this); });
    $('#btn-join-room').addEventListener('click', function () { enterFullscreen(); joinRoomFlow(this); });
    $('#join-code').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') joinRoomFlow($('#btn-join-room'));
    });
  }

  var hybridCount = 2;

  function setHybridCount(n) {
    hybridCount = Math.max(2, Math.min(3, n));
    document.querySelectorAll('.hybrid-row').forEach(function (row, i) {
      row.classList.toggle('hidden', i >= hybridCount);
    });
    var picker = $('#hybrid-count');
    if (picker) {
      picker.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.count, 10) === hybridCount);
      });
    }
  }

  function createHybridRoomFlow(btn) {
    var names = [];
    document.querySelectorAll('.hybrid-name').forEach(function (input, i) {
      if (i < hybridCount) names.push(input.value.trim() || ('Player ' + (i + 1)));
    });
    rememberName(names[0]);
    busy(btn, function () {
      return ensureOnline().then(function (ready) {
        if (!ready) return;
        return window.AzulOnline.createHybridRoom(names).then(function (res) {
          enterRoom(res.code, res.playerIdx, names[0], res.playerIdxs);
        });
      }).catch(function (err) { toast(err.message, true); });
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

  function enterRoom(code, playerIdx, myName, mySeats) {
    leaveRoomWatch();
    session = {
      mode: 'online',
      state: null,
      code: code,
      playerIdx: playerIdx,
      myName: myName,
      mySeats: mySeats || [playerIdx],
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
    resetLiveState();
    voiceOptOut = false;
    voiceLockCut = false;
    startVoiceAuto(); // voice chat is on by default in online rooms
  }

  function resetLiveState() {
    if (remoteReplay && remoteReplay.timer) clearTimeout(remoteReplay.timer);
    remoteReplay = null;
    remoteSel = null;
    lastRemoteMoveId = null;
  }

  function leaveRoomWatch() {
    resetLiveState();
    voiceLockCut = false;
    if (window.AzulVoice) window.AzulVoice.leave();
    dismissRoundOverlay();
    stopCelebration();
    if (session && session.unwatch) {
      session.unwatch();
      session.unwatch = null;
    }
  }

  // A cheap fingerprint of the parts of the state a move can change —
  // used to tell a real state change apart from a live-field echo.
  function stateKey(st) {
    if (!st) return '';
    return st.round + ':' + st.currentPlayer + ':' + st.phase + '|' +
      st.factories.map(function (f) { return f.length; }).join(',') + '|' +
      st.center.length + '|' +
      st.players.map(function (p) {
        return p.score + '/' +
          p.patternLines.map(function (l) { return l.length; }).join('') + '/' +
          p.floor.length;
      }).join('|');
  }

  // Live play-by-play from the room: another player's selection shows on
  // this screen as they decide, and their move announcement starts the
  // same flight here before the new state is applied.
  function handleLive(room) {
    var live = room.live || {};
    var sel = live.sel || null;
    remoteSel = (sel && !ownsSeat(sel.by))
      ? { by: sel.by, kind: sel.kind, index: sel.index, color: sel.color }
      : null;
    var mv = live.move || null;
    if (!mv || ownsSeat(mv.by) || mv.id === lastRemoteMoveId) return;
    if (!session.state || session.state.phase !== 'draft') return;
    if (mv.by !== session.state.currentPlayer) return;
    if (remoteReplay || flying) return;
    // Even when this snapshot already carries the mover's new state
    // (the state write and the move announcement landed together), the
    // replay still works: this screen's DOM and session.state are
    // pre-move until onRoomUpdate applies the snapshot, and that same
    // call stashes this very room into the replay handleLive starts.
    // (Skipping here was why observers sometimes got no flight and no
    // hold — just the board switch, or nothing at all.)
    lastRemoteMoveId = mv.id;
    startRemoteReplay(mv);
  }

  function startRemoteReplay(mv) {
    var sel = {
      source: mv.kind === 'factory'
        ? { kind: 'factory', index: mv.index } : { kind: 'center' },
      color: mv.color
    };
    remoteSel = null; // the selection is being placed now
    remoteReplay = { id: mv.id, by: mv.by, landed: false, stash: null, timer: null };
    flying = true; // input lock, same as the mover's screen during a flight
    var started = flyTilesForMove(sel, mv.dest, mv.by, function () {
      if (!remoteReplay || remoteReplay.id !== mv.id) return;
      remoteReplay.landed = true;
      if (remoteReplay.stash) finishRemoteReplay();
    });
    if (!started) { // nothing to fly with on this screen — don't wedge
      remoteReplay = null;
      flying = false;
      return;
    }
    remoteReplay.timer = setTimeout(function () {
      if (!remoteReplay || remoteReplay.id !== mv.id) return;
      if (remoteReplay.stash) { finishRemoteReplay(); return; }
      // The mover's move never landed (rejected?) — just resync.
      remoteReplay = null;
      flying = false;
      renderGame();
    }, 6000);
  }

  function finishRemoteReplay() {
    var st = remoteReplay && remoteReplay.stash;
    if (!st) return;
    if (remoteReplay.timer) clearTimeout(remoteReplay.timer);
    remoteReplay = null;
    // Same landing as the mover's screen: apply the move, hold the old
    // arrangement for a second, then the boards switch and announce.
    holdNextSwitch = true;
    applyGameRoom(st, window.AzulEngine.normalize(st.state));
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

    // Local+Online: the host device owns seats 0..localCount-1. A
    // rejoin (or a lobby seat shift) re-derives ownership from the
    // room meta, so a refreshed host tab gets all its seats back.
    var meta = room.meta || {};
    if (meta.mode === 'hybrid') {
      var lc = meta.localCount || 1;
      if (session.playerIdx < lc) {
        var seats = [];
        for (var si = 0; si < lc; si++) seats.push(si);
        session.mySeats = seats;
      } else {
        session.mySeats = [session.playerIdx];
      }
    }

    if (room.meta.status === 'lobby' || !room.state) {
      renderLobby(room);
      show('screen-lobby');
      return;
    }

    handleLive(room);

    // RTDB round-trips prune empty arrays — repair before rendering.
    var incoming = window.AzulEngine.normalize(room.state);
    var changed = stateKey(incoming) !== stateKey(session.state);
    if (remoteReplay) {
      // A move is being replayed on this screen: hold the new state
      // until the flight lands, then apply it with the usual pause.
      if (changed) {
        remoteReplay.stash = room;
        if (remoteReplay.landed) finishRemoteReplay();
      }
      return;
    }
    if (flying && !changed) return; // my own live-write echo, mid-flight
    applyGameRoom(room, incoming);
  }

  function applyGameRoom(room, incoming) {
    var prev = session.state;
    session.state = incoming;

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
    if (selection && !ownsSeat(session.state.currentPlayer)) selection = null;
    show('screen-game');
    renderGame();
    if (prev && !ownsSeat(prev.currentPlayer) &&
        ownsSeat(session.state.currentPlayer)) {
      toast(session.mySeats && session.mySeats.length > 1
        ? session.state.players[session.state.currentPlayer].name + '’s turn — this device!'
        : 'Your turn, ' + session.myName + '!');
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
    var isHybrid = room.meta.mode === 'hybrid';
    var listHtml = players.map(function (name, i) {
      var tags = '';
      if (i === room.meta.hostIdx) tags += '<span class="tag">Host</span>';
      if (i === session.playerIdx) tags += '<span class="tag me">You</span>';
      else if (isHybrid && session.mySeats && session.mySeats.indexOf(i) !== -1) {
        tags += '<span class="tag device">This device</span>';
      }
      return '<li>' + esc(name) + '<span>' + tags + '</span></li>';
    }).join('');
    if (isHybrid && room.meta.status === 'lobby') {
      for (var oi = players.length; oi < 4; oi++) {
        listHtml += '<li class="open">Open seat<span><span class="tag">Waiting…</span></span></li>';
      }
    }
    $('#lobby-players').innerHTML = listHtml;

    var startBtn = $('#btn-start-online');
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = players.length < 2;
      $('#lobby-status').textContent = players.length < 2
        ? 'Waiting for at least one more player to join…'
        : (isHybrid && players.length < 4
          ? 'Friends can still join with the link — or tap Start to play with ' + players.length + ' players.'
          : 'Everyone in? Tap Start when ready — players can’t join once the game begins.');
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
      var multiSeat = session.mySeats && session.mySeats.length > 1;
      leaveRoomWatch();
      if (window.AzulOnline.isReady()) {
        if (multiSeat && window.AzulOnline.deleteRoom) {
          // Host device of a Local+Online room: all its seats leave
          // together, which ends the room for everyone.
          window.AzulOnline.deleteRoom(code).catch(function () { /* ignore */ });
        } else {
          window.AzulOnline.leaveRoom(code, idx).catch(function () { /* ignore */ });
        }
      }
      session = null;
      goHome();
    });
  }

  // ------------------------------------------------------------ game screen --
  function canInteract() {
    if (!session || !session.state || session.state.phase !== 'draft') return false;
    if (session.mode === 'local') return true;
    return ownsSeat(session.state.currentPlayer);
  }

  // The selection the board painters show: my own while I am deciding,
  // otherwise the live selection of the player whose turn it is, so in
  // online games everyone watches the same group get picked up.
  function visibleSelection() {
    if (selection) return selection;
    if (remoteSel && session && session.state &&
        session.state.phase === 'draft' &&
        remoteSel.by === session.state.currentPlayer) {
      return {
        source: remoteSel.kind === 'factory'
          ? { kind: 'factory', index: remoteSel.index } : { kind: 'center' },
        color: remoteSel.color
      };
    }
    return null;
  }

  function tileHtml(color, mini) {
    return '<span class="tile tile-' + color + (mini ? ' mini' : '') + '"></span>';
  }

  function groupHtml(source, color, count, mini) {
    var vs = visibleSelection();
    var sel = vs && vs.color === color &&
      vs.source.kind === source.kind &&
      (source.kind === 'center' || vs.source.index === source.index);
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
      var vs = visibleSelection();
      var sel = vs && vs.color === color &&
        vs.source.kind === 'factory' && vs.source.index === source.index;
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
    } else if (session.mode === 'online' && !ownsSeat(s.currentPlayer)) {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'Waiting for ' + cur.name + ' to make a move…';
    } else if (session.mode === 'online' && session.mySeats && session.mySeats.length > 1) {
      main = 'Round ' + s.round + ' — ' + cur.name + '’s turn';
      sub = 'This device — pass to ' + cur.name + ' and play their turn.';
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
      centerHtml += '<span class="marker-token" title="Starting player marker — first to take from the center gets it (and a −1 floor penalty)">1</span>';
    }
    centerHtml += groupsHtml(s.center, { kind: 'center' }, true);
    if (!centerHtml) centerHtml = '<span class="center-empty">The center is empty.</span>';
    $('#center-pile').innerHTML = centerHtml;

    // --- hint ---
    var hint = '';
    if (selection) {
      // Next step only — what was picked is already obvious on screen.
      hint = 'Tap highlighted row to place the tile.';
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
    if (!overviewOn) {
      order.sort(function (a, b) {
        if (a === s.currentPlayer) return -1;
        if (b === s.currentPlayer) return 1;
        return a - b;
      });
    }
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
    if (turnChanged && overviewOn) {
      // Overview shows every board already — no circle switch. Keep
      // the same landing bookkeeping and announcement, minus motion.
      holdNextSwitch = false;
      flying = false;
      if (!justEndedRound) speakTurn(cur.name);
    } else if (turnChanged) {
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
        // FLIP, done the Safari-safe way: first pin every board at its
        // pre-switch spot with an inline transform and force a reflow
        // so that displaced state is the board's committed style, THEN
        // create the arc animation on the next frame. Creating a WAAPI
        // animation in the same frame as the innerHTML rebuild (or in
        // the same frame an inline transform is cleared) lets iOS
        // Safari silently drop it — the boards just snapped into place
        // on iPhone while Android animated fine. The flying tiles never
        // hit this because they are born displaced via left/top and
        // animated with fill:'forwards'.
        switchBoards.forEach(function (it) {
          it.b.style.transform = 'translate(' + it.dx + 'px, ' + it.dy + 'px)';
          it.b.style.zIndex = it.isIn ? 3 : 2;
        });
        void boardsEl.offsetWidth; // commit the displaced state
        requestAnimationFrame(function () {
          switchBoards.forEach(function (it) {
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
            var b = it.b;
            var done = function () { b.style.transform = ''; b.style.zIndex = ''; };
            var anim = null;
            try {
              anim = b.animate(keyframes, { duration: 1000, easing: 'cubic-bezier(.4, .05, .3, 1)', fill: 'both' });
            } catch (e) { anim = null; }
            if (anim) {
              anim.onfinish = done;
              setTimeout(done, 1200); // safety net if onfinish is swallowed
            } else {
              done();
            }
          });
          var topBoard = $('#boards .board.turn');
          if (topBoard) topBoard.classList.add('turn-enter');
        });
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
          // Boards stay pinned at their old spots (inline transforms
          // set above) — startSwitch takes it from there.
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
    placeZoomButton();
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
      var lineSel = isTurnBoard ? visibleSelection() : null;
      if (lineSel) {
        cls += E.isLineLegal(s, pi, lineSel.color, i) ? ' droppable' : ' blocked';
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
      if (entry === E.FIRST) cell = '<span class="marker-token inline">1</span>';
      else if (entry) cell = tileHtml(entry);
      floorSlots += '<span class="floor-slot"><span class="floor-pen">' +
        E.FLOOR_PENALTIES[k] + '</span><span class="floor-cell">' + cell + '</span></span>';
    }

    var youTag = '';
    if (session.mode === 'online' && ownsSeat(pi)) {
      youTag = pi === session.playerIdx
        ? ' <span class="you">(you)</span>'
        : ' <span class="you">(this device)</span>';
    }

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
      '<div class="floor-line">' +
      '<div class="floor-slots' + (lineSel ? ' droppable' : '') +
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
        if (session.mode === 'online' && window.AzulOnline.setLiveSelection) {
          window.AzulOnline.setLiveSelection(session.code, selection ? {
            by: session.state.currentPlayer,
            kind: selection.source.kind,
            index: selection.source.kind === 'factory' ? selection.source.index : 0,
            color: selection.color
          } : null);
        }
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

    var zoomBtn = $('#btn-zoom');
    if (zoomBtn) {
      zoomBtn.addEventListener('click', function () {
        if (flying) return; // never re-layout mid-flight
        setOverview(!overviewOn);
      });
    }
    window.addEventListener('resize', function () { placeZoomButton(); });
    window.addEventListener('scroll', function () {
      if (!zoomBtn || zoomBtn.classList.contains('hidden')) return;
      if (zoomScrollQueued) return;
      zoomScrollQueued = true;
      requestAnimationFrame(function () {
        zoomScrollQueued = false;
        placeZoomButton();
      });
    }, { passive: true });

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
      overviewOn = false;
      var boardsElQ = $('#boards');
      if (boardsElQ) boardsElQ.classList.remove('overview');
      goHome();
    });
  }

  // ---------------------------------------------------------- zoom view --
  // A floating magnifying-glass button hovers over the boards (fixed
  // position, no layout space of its own), anchored to the table
  // card's bottom-right corner — the same spot in both views (v76).
  // Zooming out is a pure view change: the boards
  // shrink into one grid in seat order. Flights keep landing on the
  // right slots because flyTilesForMove measures live positions.
  var ICON_ZOOM_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="15.5" y1="15.5" x2="21" y2="21"></line><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"></line></svg>';
  var ICON_ZOOM_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="15.5" y1="15.5" x2="21" y2="21"></line><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"></line><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"></line></svg>';
  var zoomScrollQueued = false;

  function setOverview(on) {
    overviewOn = !!on;
    var boardsEl = $('#boards');
    if (boardsEl) boardsEl.classList.toggle('overview', overviewOn);
    if (session && session.state) renderGame(); // re-render in the new scale/order
    placeZoomButton();
  }

  function placeZoomButton() {
    var btn = $('#btn-zoom');
    if (!btn) return;
    var inGame = session && session.state &&
      !$('#screen-game').classList.contains('hidden');
    if (!inGame) { btn.classList.add('hidden'); return; }
    var boards = document.querySelectorAll('#boards .board');
    if (!boards.length) { btn.classList.add('hidden'); return; }
    // Always visible while a game is on screen (v73). v72 only
    // showed it when the boards overflowed the screen, so in a
    // 2-player local game — where both boards happen to fit — the
    // button never appeared and the feature could not be found.
    var first = boards[0].getBoundingClientRect();
    btn.classList.remove('hidden');
    btn.innerHTML = overviewOn ? ICON_ZOOM_IN : ICON_ZOOM_OUT;
    btn.setAttribute('aria-label', overviewOn
      ? 'Zoom in — back to normal view' : 'Zoom out — see all boards');
    if (flying) return; // mid-flight/switch the boards are displaced — don't chase them
    // Anchor (v76, user-marked spot): the bottom-right corner of the
    // table card (factories/center), centred on its bottom edge —
    // the factories area is identical in both views, so the button
    // sits in exactly the same place whether zoomed in or out.
    // (v73–v75 anchored it to the first board's score, which moved
    // between views because the boards change size and order.)
    var table = document.querySelector('.table-area');
    var r = table ? table.getBoundingClientRect() : first;
    btn.style.top = Math.max(4, r.bottom - 20) + 'px';
    btn.style.left = Math.max(4, r.right - 50) + 'px';
  }

  // Fly the selected tiles in a slow circular arc — down and to the
  // right — into the exact slots they will occupy, with a whoosh. The
  // moment they land the move applies (tiles take their real positions,
  // selection clears), then the turn switch pauses a full second so
  // everyone can take in what was played.
  function flyAndMove(dest, targetEl) {
    if (flying || !selection) return;
    var sel = { source: selection.source, color: selection.color };
    if (session.mode === 'online') {
      // Announce the move as its flight starts, so the other players'
      // screens replay the same flight with the same timing and switch
      // the turn only after it lands. The selection is consumed.
      if (window.AzulOnline.setLiveMove) {
        window.AzulOnline.setLiveMove(session.code, {
          by: session.state.currentPlayer,
          kind: sel.source.kind,
          index: sel.source.kind === 'factory' ? sel.source.index : 0,
          color: sel.color,
          dest: dest,
          id: Date.now() + ':' + session.state.currentPlayer
        });
      }
      if (window.AzulOnline.setLiveSelection) {
        window.AzulOnline.setLiveSelection(session.code, null);
      }
    }
    flying = true;
    var started = flyTilesForMove(sel, dest, session.state.currentPlayer, function () {
      holdNextSwitch = true;
      attemptMove(dest);
    });
    if (!started) {
      flying = false;
      attemptMove(dest);
    }
  }

  // The flight itself, shared by the mover and by remote screens
  // replaying the mover's announcement: the picked tiles arc into the
  // exact slots they will occupy on the mover's board (overflow to the
  // floor), factory leftovers arc into the center at the same time, the
  // source tiles are hidden while their copies fly, and onLanded runs
  // the moment the flight lands. Returns false when there is nothing to
  // fly with (elements missing / no animation support).
  function flyTilesForMove(sel, dest, moverIdx, onLanded) {
    var s = session.state;
    if (!s) return false;

    // Source tiles: the picked color group in its factory / the center.
    var tiles = [];
    var factoryEl = null;
    var pileEl = null;
    if (sel.source.kind === 'factory') {
      factoryEl = document.querySelectorAll('#factories .factory')[sel.source.index] || null;
      pileEl = factoryEl;
    } else {
      pileEl = $('#center-pile');
    }
    if (pileEl) {
      pileEl.querySelectorAll('.tile-group').forEach(function (g) {
        if (g.dataset.color === sel.color) {
          g.querySelectorAll('.tile').forEach(function (t) { tiles.push(t); });
        }
      });
    }
    var board = document.querySelector('.board[data-player="' + moverIdx + '"]');
    var targetEl = null;
    if (board) {
      targetEl = dest === 'floor'
        ? board.querySelector('.floor-slots')
        : board.querySelector('[data-dest-line="' + dest + '"]');
    }
    // NOTE: no reduced-motion skip here — the flight is a requested
    // feature; the OS setting silently killed it on the user's phone.
    if (!tiles.length || !targetEl || !tiles[0].animate) return false;
    playWhoosh();

    // Landing spots: the exact slots the tiles are about to occupy
    // (overflow past a full pattern line runs to the floor line).
    var cur = s.players[moverIdx];
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
      var ofSlot = board
        ? board.querySelectorAll('.floor-slot')[cur.floor.length + (i - free)] : null;
      return spotCenter(ofSlot, targetEl, 0.8);
    });

    var clones = [];
    var FLIGHT_MS = 1150;
    function spawnFlight(t, ex, ey, delay) {
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
        duration: FLIGHT_MS, delay: delay, easing: 'ease-in-out', fill: 'forwards'
      });
    }
    // Hide the originals while their copies fly — no duplicated tiles.
    tiles.forEach(function (t) {
      var g = t.closest('.tile-group');
      if (g) g.classList.add('tile-away');
    });
    tiles.forEach(function (t, i) { spawnFlight(t, spots[i].x, spots[i].y, i * 90); });

    // The factory's leftover tiles fly to the center pile at the same
    // time, fanning into the middle of the pile.
    var leftoverCount = 0;
    if (sel.source.kind === 'factory' && factoryEl) {
      var centerEl = $('#center-pile');
      if (centerEl) {
        var cr = centerEl.getBoundingClientRect();
        var leftTiles = [];
        factoryEl.querySelectorAll('.tile-group').forEach(function (g) {
          if (g.dataset.color === sel.color) return;
          g.querySelectorAll('.tile').forEach(function (t) { leftTiles.push(t); });
        });
        leftoverCount = leftTiles.length;
        leftTiles.forEach(function (t) {
          var g = t.closest('.tile-group');
          if (g) g.classList.add('tile-away');
        });
        leftTiles.forEach(function (t, j) {
          var ex = cr.left + cr.width / 2 +
            (j - (leftTiles.length - 1) / 2) * (cr.width > 140 ? 26 : 12);
          var ey = cr.top + cr.height / 2;
          spawnFlight(t, ex, ey, j * 90);
        });
      }
    }
    // Land -> onLanded: for the mover the move applies at once (tiles
    // take their real positions, selection clears) and renderGame holds
    // the turn switch for 1s; remote screens do the same with the state
    // that arrived from the mover's transaction.
    setTimeout(function () {
      document.querySelectorAll('.tile-away').forEach(function (el) {
        el.classList.remove('tile-away');
      });
      clones.forEach(function (c) { c.remove(); });
      onLanded();
    }, FLIGHT_MS + (Math.max(tiles.length, leftoverCount) - 1) * 90);
    return true;
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
    window.AzulOnline.submitMove(session.code, session.state.currentPlayer, move)
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
    if (!V || !session || session.mode !== 'online' || voiceOptOut || voiceLockCut) {
      renderVoice();
      return;
    }
    V.join(session.code, session.playerIdx, session.myName).catch(function () {
      // Mic blocked or unavailable — the voice box shows "Enable voice".
      renderVoice();
    });
    renderVoice();
  }

  // ----------------------------------------------------- voice privacy --
  // If the screen turns off or the app goes to the background while
  // voice chat is live, tear voice down COMPLETELY — AzulVoice.leave()
  // stops the mic tracks, closes every peer connection and removes this
  // player's voice presence, so the other players see them leave voice.
  // Coming back does NOT rejoin: reconnecting is a manual tap on the
  // "Reconnect Voice Chat" button (renderVoice shows it while
  // voiceLockCut is set, and startVoiceAuto refuses to auto-join).
  // A live mic on a locked phone in a pocket is a privacy breach.
  function disconnectVoiceForPrivacy() {
    var V = window.AzulVoice;
    if (!V || !session || session.mode !== 'online') return;
    if (voiceOptOut || voiceLockCut) return;
    var snap = V.snapshot();
    if (!snap.active && !snap.joining) return;
    V.leave();
    voiceLockCut = true;
    alog('Voice chat disconnected: screen off / app hidden — manual reconnect required (privacy).');
    renderVoice();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) disconnectVoiceForPrivacy();
  });
  window.addEventListener('pagehide', disconnectVoiceForPrivacy);
  document.addEventListener('freeze', disconnectVoiceForPrivacy);

  // WhatsApp-style call icons (inline SVG, stroke style, 24x24).
  var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" stroke="none"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"></path><path d="M12 18v3.5"></path></svg>';
  var ICON_MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" stroke="none"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"></path><path d="M12 18v3.5"></path><line x1="3.5" y1="3.5" x2="20.5" y2="20.5"></line></svg>';
  var ICON_SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"></path><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"></path><path d="M18 7a7 7 0 0 1 0 10"></path></svg>';
  var ICON_SPK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"></path><line x1="16" y1="9.5" x2="21.5" y2="15"></line><line x1="21.5" y1="9.5" x2="16" y2="15"></line></svg>';
  var ICON_CALL = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.4 11.4 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"></path></svg>';
  var ICON_HANGUP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><g transform="rotate(135 12 12)"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.4 11.4 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"></path></g></svg>';

  function renderVoice() {
    var V = window.AzulVoice;
    var snap = V ? V.snapshot()
      : { active: false, joining: false, blocked: false, muted: false, speakerOn: true, hasMic: false, members: [] };
    var inOnline = !!(session && session.mode === 'online');
    document.querySelectorAll('.voice-box').forEach(function (box) {
      box.classList.toggle('hidden', !inOnline);
      if (!inOnline) return;
      var status = box.querySelector('.voice-status');
      var members = box.querySelector('.voice-members');
      var controls = box.querySelector('.voice-controls');
      if (status) {
        status.textContent = snap.joining ? '· Connecting…'
          : snap.active && snap.blocked ? '· Mic blocked'
          : snap.active && snap.hasMic ? '· On'
          : snap.active ? '· Connecting…'
          : voiceLockCut ? '· Disconnected — screen was off'
          : snap.blocked ? '· Mic blocked'
          : '· Off';
      }
      if (members) {
        // Every player's name carries two icons: mic (are they talking
        // or not) and speaker (are they listening or not). On my own
        // chip they are working buttons; on other players they show
        // that player's synced state.
        members.innerHTML = snap.members.length ? snap.members.map(function (m) {
          var micOff = !m.mic || m.muted;
          var spkOff = m.speaker === false;
          var micHtml, spkHtml;
          if (m.me) {
            micHtml = '<button type="button" class="vchip-btn btn-voice-mute' + (micOff ? ' off' : '') +
              '" title="' + (!m.mic ? 'Enable microphone' : (m.muted ? 'Unmute microphone' : 'Mute microphone')) +
              '" aria-label="My microphone">' + (micOff ? ICON_MIC_OFF : ICON_MIC) + '</button>';
            spkHtml = '<button type="button" class="vchip-btn btn-voice-speaker' + (spkOff ? ' off' : '') +
              '" title="' + (spkOff ? 'Turn speaker on' : 'Turn speaker off') +
              '" aria-label="My speaker">' + (spkOff ? ICON_SPK_OFF : ICON_SPK) + '</button>';
          } else {
            micHtml = '<span class="vchip-ic' + (micOff ? ' off' : '') +
              '" title="' + (!m.mic ? 'Mic blocked' : (m.muted ? 'Mic off' : 'Mic on')) + '">' +
              (micOff ? ICON_MIC_OFF : ICON_MIC) + '</span>';
            spkHtml = '<span class="vchip-ic' + (spkOff ? ' off' : '') +
              '" title="' + (spkOff ? 'Speaker off — not listening' : 'Speaker on — listening') + '">' +
              (spkOff ? ICON_SPK_OFF : ICON_SPK) + '</span>';
          }
          return '<span class="voice-chip' + (m.speaking ? ' speaking' : '') + '">' +
            '<span class="voice-chip-name">' + esc(m.name) + (m.me ? ' (you)' : '') + '</span>' +
            micHtml + spkHtml +
            (!m.mic ? '<span class="voice-chip-note">Mic blocked</span>' : '') +
            (!m.me && snap.active && m.mic && !m.connected ? '<span class="voice-chip-note">Connecting…</span>' : '') +
            '</span>';
        }).join('') : '<span class="voice-none">No one in voice yet</span>';
      }
      if (controls) {
        // WhatsApp-style call bar: one Enable button while voice is
        // off; once on, a round button per feature — mic on/off,
        // speaker on/off, and a red hang-up to leave voice.
        if (snap.joining) {
          controls.innerHTML =
            '<button type="button" class="vbtn vbtn-enable" disabled>' +
            ICON_CALL + '<span>Connecting…</span></button>';
        } else if (!snap.active || !snap.hasMic) {
          controls.innerHTML = (voiceLockCut && !snap.active
            ? '<button type="button" class="vbtn vbtn-enable btn-voice-reconnect" aria-label="Reconnect voice chat">' +
              ICON_CALL + '<span>Reconnect Voice Chat</span></button>'
            : '<button type="button" class="vbtn vbtn-enable btn-voice-toggle" aria-label="Enable voice chat">' +
              ICON_CALL + '<span>Enable Voice Chat</span></button>') +
            (snap.active
              ? '<button type="button" class="vbtn vbtn-leave btn-voice-leave" aria-label="Leave voice chat">' + ICON_HANGUP + '</button>'
              : '');
        } else {
          controls.innerHTML =
            '<button type="button" class="vbtn btn-voice-mute' + (snap.muted ? ' off' : '') +
            '" aria-label="' + (snap.muted ? 'Unmute microphone' : 'Mute microphone') +
            '" title="' + (snap.muted ? 'Unmute' : 'Mute') + '">' +
            (snap.muted ? ICON_MIC_OFF : ICON_MIC) + '</button>' +
            '<button type="button" class="vbtn btn-voice-speaker' + (snap.speakerOn === false ? ' off' : '') +
            '" aria-label="' + (snap.speakerOn === false ? 'Turn speaker on' : 'Turn speaker off') +
            '" title="' + (snap.speakerOn === false ? 'Speaker off' : 'Speaker on') + '">' +
            (snap.speakerOn === false ? ICON_SPK_OFF : ICON_SPK) + '</button>' +
            '<button type="button" class="vbtn vbtn-leave btn-voice-leave" aria-label="Leave voice chat" title="Leave voice">' +
            ICON_HANGUP + '</button>';
        }
      }
    });
  }

  function wireVoice() {
    if (window.AzulVoice) {
      window.AzulVoice.setCallbacks({ onChange: function () { renderVoice(); } });
    }
    // Delegated: renderVoice() rebuilds the call-bar buttons per state,
    // so the handlers live on the document, not on the buttons.
    document.addEventListener('click', function (ev) {
      var V = window.AzulVoice;
      if (!V || !ev.target.closest) return;
      if (ev.target.closest('.btn-voice-mute')) {
        var snapM = V.snapshot();
        if (!snapM.hasMic) {
          // No mic yet (blocked or still joining): the mic button acts
          // as Enable Voice and retries the microphone.
          if (session && session.mode === 'online' && !snapM.joining) {
            voiceOptOut = false;
            voiceLockCut = false;
            V.unlockAudio();
            V.join(session.code, session.playerIdx, session.myName)
              .catch(function (err) { toast(err.message || 'Microphone unavailable', true); });
            renderVoice();
          }
          return;
        }
        V.setMuted(!snapM.muted);
        return;
      }
      if (ev.target.closest('.btn-voice-speaker')) {
        V.setSpeaker(!V.snapshot().speakerOn);
        return;
      }
      if (ev.target.closest('.btn-voice-leave')) {
        voiceOptOut = true;
        V.leave();
        renderVoice();
        return;
      }
      if (ev.target.closest('.btn-voice-reconnect')) {
        if (!session || session.mode !== 'online') return;
        // The ONLY way back into voice after a privacy disconnect:
        // a deliberate tap. This click is the user gesture the mic
        // prompt and playback unlock need.
        voiceLockCut = false;
        voiceOptOut = false;
        V.unlockAudio();
        V.join(session.code, session.playerIdx, session.myName)
          .catch(function (err) { toast(err.message || 'Microphone unavailable', true); });
        renderVoice();
        return;
      }
      if (ev.target.closest('.btn-voice-toggle')) {
        if (!session || session.mode !== 'online') return;
        voiceOptOut = false;
        voiceLockCut = false;
        // This click is a user gesture — wake the playback context now,
        // before the async mic prompt, so remote audio can play.
        V.unlockAudio();
        V.join(session.code, session.playerIdx, session.myName)
          .catch(function (err) { toast(err.message || 'Microphone unavailable', true); });
        renderVoice();
      }
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
      var ssA = window.speechSynthesis;
      if (ssA.speaking || ssA.pending) ssA.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onstart = function () { alog('Speech started: ' + text.slice(0, 40)); };
      u.onend = function () { alog('Speech finished: ' + text.slice(0, 40)); finish(); };
      u.onerror = function (ev) { alog('Speech ERROR (' + (ev && ev.error ? ev.error : 'unknown') + '): ' + text.slice(0, 40)); finish(); };
      alog('Speech requested: ' + text.slice(0, 40));
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
    voiceLockCut = false;
    if (window.AzulVoice) window.AzulVoice.leave();
    dismissRoundOverlay();
    dismissCelebration();
    stopCelebration();
    try { window.sessionStorage.removeItem('azul-session'); } catch (e) { /* ignore */ }
    // Land on the mode chooser, not on whichever setup screen was used.
    document.body.classList.remove('config-open');
    $('#home-chooser').classList.remove('hidden');
    $('#setup-local').classList.add('hidden');
    $('#setup-online').classList.add('hidden');
    show('screen-home');
  }

  // ----------------------------------------------------------------- init --
  // Self-update: if this tab is running an older build than the server
  // (a long-lived phone tab keeps the HTML it first loaded), reload once
  // so new versions actually reach the player.
  function checkForUpdate() {
    try {
      var meta = document.querySelector('meta[name="azul-build"]');
      if (!meta || !window.fetch) return;
      var mine = parseInt(meta.getAttribute('content'), 10);
      fetch('version.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var latest = parseInt(data && data.v, 10);
          if (!latest || latest <= mine) return;
          var key = 'azul-reloaded-for';
          try {
            if (sessionStorage.getItem(key) === String(latest)) return;
            sessionStorage.setItem(key, String(latest));
          } catch (e) { /* ignore */ }
          window.location.reload();
        })
        .catch(function () { /* offline — ignore */ });
    } catch (e) { /* ignore */ }
  }

  function init() {
    checkForUpdate();
    wireHome();
    wireLobby();
    wireGame();
    wireGameOver();
    wireVoice();
    wireFullscreen();
    wireSoundCheck();

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
