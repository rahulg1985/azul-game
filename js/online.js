/*
 * Azul — online mode adapter (Firebase Realtime Database).
 *
 * Exposes window.AzulOnline. Firebase compat SDKs are loaded dynamically
 * from the gstatic CDN only when the user actually enters online mode, and
 * only when js/config.js holds real (non-placeholder) values. If anything
 * is missing, `init()` resolves to false and the UI shows "Online play
 * isn't set up yet" — local mode never depends on this file.
 *
 * Room shape in RTDB:
 *   rooms/{code} = {
 *     meta:    { hostIdx: 0, status: 'lobby'|'playing'|'finished', createdAt,
 *                // Local+Online rooms add:
 *                mode: 'hybrid', localCount: 2|3 }
 *              // In a hybrid room, seats 0..localCount-1 all belong to
 *              // the host's device; later seats are one per guest device.
 *     players: ['Name', ...],                 // seat order; index = playerIdx
 *     state:   <AzulEngine state JSON | null> // null while in the lobby
 *     live:    { sel, move }                  // ephemeral play-by-play:
 *                                             // the current player's tile
 *                                             // selection and move
 *                                             // announcements, so every
 *                                             // screen replays the same
 *                                             // flight before the turn
 *                                             // switches (see app.js)
 *   }
 *
 * Moves are applied with a transaction on rooms/{code}/state: the engine
 * runs inside the transaction on the server-confirmed state, so two
 * clients can never desync or move out of turn.
 */
(function () {
  'use strict';

  var SDK_VERSION = '10.12.5';
  var SDK_FILES = ['firebase-app-compat.js', 'firebase-database-compat.js'];
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

  var db = null;
  var initPromise = null;

  function configIsPlaceholder(cfg) {
    if (!cfg || typeof cfg !== 'object') return true;
    if (!cfg.apiKey || !cfg.databaseURL) return true;
    return /YOUR_[A-Z_]+/.test(cfg.apiKey) || /YOUR_[A-Z_]+/.test(cfg.databaseURL);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Loads config (ES module) and the Firebase SDKs on first use.
  // Resolves true when online play is ready, false when not configured.
  function init() {
    if (initPromise) return initPromise;
    initPromise = (async function () {
      var cfg = window.FIREBASE_CONFIG || null;
      if (!cfg) {
        try {
          var mod = await import('./config.js');
          cfg = mod.firebaseConfig || window.FIREBASE_CONFIG || null;
        } catch (e) {
          cfg = null;
        }
      }
      if (configIsPlaceholder(cfg)) return false;
      try {
        for (var i = 0; i < SDK_FILES.length; i++) {
          await loadScript(
            'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/' + SDK_FILES[i]
          );
        }
        if (!window.firebase) return false;
        if (!window.firebase.apps.length) window.firebase.initializeApp(cfg);
        db = window.firebase.database();
        return true;
      } catch (e) {
        return false;
      }
    })();
    return initPromise;
  }

  function isReady() {
    return !!db;
  }

  function makeCode() {
    var code = '';
    var arr = new Uint32Array(6);
    window.crypto.getRandomValues(arr);
    for (var i = 0; i < 6; i++) code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
    return code;
  }

  function roomRef(code) {
    return db.ref('rooms/' + code);
  }

  function storageKey(code) {
    return 'azul-room-' + code;
  }

  function storedSeat(code) {
    try {
      var raw = window.localStorage.getItem(storageKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSeat(code, name, playerIdx) {
    try {
      window.localStorage.setItem(
        storageKey(code),
        JSON.stringify({ name: name, playerIdx: playerIdx })
      );
    } catch (e) { /* private mode etc. — rejoin by name still works in lobby */ }
  }

  function forgetSeat(code) {
    try {
      window.localStorage.removeItem(storageKey(code));
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------- rooms ------
  async function createRoom(name) {
    for (var attempt = 0; attempt < 8; attempt++) {
      var code = makeCode();
      var ref = roomRef(code);
      var snap = await ref.once('value');
      if (snap.exists()) continue; // code collision — try another
      await ref.set({
        meta: {
          hostIdx: 0,
          status: 'lobby',
          createdAt: window.firebase.database.ServerValue.TIMESTAMP
        },
        players: [name],
        state: null
      });
      saveSeat(code, name, 0);
      return { code: code, playerIdx: 0 };
    }
    throw new Error('Could not create a room — please try again.');
  }

  async function joinRoom(code, name) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Room codes are 6 characters.');
    var ref = roomRef(code);

    // Rejoin: a stored seat (or an exact name match) in an existing room.
    var snap = await ref.once('value');
    if (!snap.exists()) throw new Error('Room ' + code + ' not found.');
    var room = snap.val();
    var players = room.players || [];
    // NOTE: no stored-seat reclaim here. A stored seat belongs to whoever
    // used this browser before; trusting it silently seats a new player in
    // someone else's chair. Rejoin works by name instead: the byName
    // branches below return the seat whose name matches the entered name.
    var byName = players.indexOf(name);
    if (byName !== -1 && room.meta.status !== 'lobby') {
      saveSeat(code, name, byName);
      return { code: code, playerIdx: byName };
    }
    if (room.meta.status !== 'lobby') {
      throw new Error('That game has already started.');
    }
    if (byName !== -1) {
      saveSeat(code, name, byName);
      return { code: code, playerIdx: byName };
    }
    if (players.length >= 4) throw new Error('That room is full (4 players).');

    // Append the seat atomically; bail if the room filled up meanwhile.
    var myIdx = -1;
    var result = await ref.child('players').transaction(function (current) {
      var list = current || [];
      if (list.length >= 4) return undefined; // abort
      myIdx = list.length;
      list.push(name);
      return list;
    });
    if (!result.committed || myIdx === -1) {
      throw new Error('That room just filled up.');
    }
    saveSeat(code, name, myIdx);
    return { code: code, playerIdx: myIdx };
  }

  // Local+Online: the host device seats 2–3 named players at once.
  // They occupy seats 0..names.length-1; guests join one seat each via
  // joinRoom afterwards (the 4-player cap there applies as usual).
  async function createHybridRoom(names) {
    for (var attempt = 0; attempt < 8; attempt++) {
      var code = makeCode();
      var ref = roomRef(code);
      var snap = await ref.once('value');
      if (snap.exists()) continue; // code collision — try another
      await ref.set({
        meta: {
          hostIdx: 0,
          status: 'lobby',
          createdAt: window.firebase.database.ServerValue.TIMESTAMP,
          mode: 'hybrid',
          localCount: names.length
        },
        players: names.slice(),
        state: null
      });
      saveSeat(code, names[0], 0);
      var idxs = names.map(function (_, i) { return i; });
      return { code: code, playerIdx: 0, playerIdxs: idxs };
    }
    throw new Error('Could not create a room — please try again.');
  }

  // The host device leaving a hybrid lobby takes all its local seats
  // with it — without them the room can't be played, so it is deleted
  // and the guests see the usual "room no longer exists" path.
  async function deleteRoom(code) {
    try {
      await roomRef(code).remove();
    } finally {
      forgetSeat(code);
    }
  }

  // Subscribe to a room. cb(roomObject | null). Returns an unsubscribe fn.
  function watchRoom(code, cb) {
    var ref = roomRef(code);
    var handler = function (snap) { cb(snap.val()); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  // Host only: build a fresh engine state from the seated names and flip
  // the room to 'playing'. Also used for "Play again".
  async function startGame(code) {
    var ref = roomRef(code);
    var snap = await ref.child('players').once('value');
    var names = snap.val() || [];
    if (names.length < 2) throw new Error('You need at least 2 players to start.');
    var seed = Math.floor(Math.random() * 0xffffffff);
    var state = window.AzulEngine.createGame(names, seed);
    await ref.update({
      state: state,
      'meta/status': 'playing'
    });
  }

  // Apply one draft move through a transaction on the authoritative state.
  async function submitMove(code, playerIdx, move) {
    var ref = roomRef(code).child('state');
    var error = null;
    var result = await ref.transaction(function (current) {
      if (!current) {
        error = 'The game has not started yet.';
        return undefined;
      }
      try {
        // `current` is a fresh JSON copy owned by the SDK — safe to mutate.
        // RTDB prunes empty arrays, so repair the shape before the engine
        // (and the UI) ever see it.
        current = window.AzulEngine.normalize(current);
        return window.AzulEngine.applyDraft(current, playerIdx, move);
      } catch (e) {
        error = e.message;
        return undefined; // abort — state unchanged
      }
    });
    if (!result.committed) {
      throw new Error(error || 'That move was rejected — the game may have moved on.');
    }
    var newState = result.snapshot.val();
    if (newState) {
      // Repair RTDB-pruned arrays before the UI renders from this copy.
      newState = window.AzulEngine.normalize(newState);
      if (newState.phase === 'finished') {
        await roomRef(code).update({ 'meta/status': 'finished' });
      }
    }
    return newState;
  }

  // Leave a room. While it is still a lobby, the seat is removed (other
  // clients re-derive their seat index by name). Mid-game, leaving only
  // unsubscribes locally — the seat stays so the player can rejoin.
  async function leaveRoom(code, playerIdx) {
    try {
      var ref = roomRef(code);
      var snap = await ref.once('value');
      if (snap.exists() && snap.val().meta.status === 'lobby') {
        await ref.child('players').transaction(function (current) {
          var list = current || [];
          if (playerIdx >= 0 && playerIdx < list.length) list.splice(playerIdx, 1);
          return list;
        });
        var after = await ref.child('players').once('value');
        if (!after.exists() || (after.val() || []).length === 0) {
          await ref.remove(); // last one out deletes the room
        }
      }
    } finally {
      forgetSeat(code);
    }
  }

  // Ephemeral play-by-play (fire-and-forget): the current player's tile
  // selection, so the other screens can highlight the same group while
  // they decide. Cleared with null when the selection is put back or a
  // move starts.
  function setLiveSelection(code, sel) {
    if (!db) return;
    var ref = roomRef(code).child('live/sel');
    if (sel) {
      ref.set(sel).catch(function () { /* ignore */ });
      ref.onDisconnect().remove();
    } else {
      ref.remove().catch(function () { /* ignore */ });
    }
  }

  // Announce a move the moment its flight starts, so the other screens
  // replay the flight with the same timing and only apply the new state
  // (which arrives separately through the move transaction) once their
  // flight lands. `id` makes each announcement unique.
  function setLiveMove(code, mv) {
    if (!db) return;
    roomRef(code).child('live/move').set(mv).catch(function () { /* ignore */ });
  }

  // Host taps on the celebration screen: flag it so every player
  // leaves the celebration and returns home together.
  function endCelebration(code) {
    return roomRef(code).child('meta/celebrationDone').set(true);
  }

  window.AzulOnline = {
    init: init,
    isReady: isReady,
    createRoom: createRoom,
    createHybridRoom: createHybridRoom,
    deleteRoom: deleteRoom,
    joinRoom: joinRoom,
    watchRoom: watchRoom,
    startGame: startGame,
    submitMove: submitMove,
    setLiveSelection: setLiveSelection,
    setLiveMove: setLiveMove,
    endCelebration: endCelebration,
    leaveRoom: leaveRoom,
    storedSeat: storedSeat,
    saveSeat: saveSeat,
    forgetSeat: forgetSeat
  };
})();
