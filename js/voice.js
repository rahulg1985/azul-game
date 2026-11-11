/*
 * Azul — in-room voice chat (WebRTC mesh, Firebase RTDB signaling).
 *
 * Exposes window.AzulVoice. Audio flows directly peer-to-peer between the
 * 2–4 players in a room (full mesh); Firebase only carries the signaling
 * (offers/answers/ICE) and voice presence, under:
 *
 *   rooms/{code}/voice/members/{playerIdx} = { name, muted, ts }
 *   rooms/{code}/voice/signals/{toIdx}/{pushId} = { from, kind, data }
 *
 * The lower player index always initiates the peer connection, which
 * keeps offer/answer glare impossible without extra negotiation logic.
 * ICE uses Google's public STUN servers; there is no TURN relay, so a
 * small minority of very strict networks may not connect audio (the
 * game itself is unaffected).
 */
(function () {
  'use strict';

  var ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };
  var STALE_MS = 90000; // presence older than this counts as gone

  var S = {
    active: false,
    joining: false,
    blocked: false, // mic permission denied / unavailable on last attempt
    code: null,
    myIdx: -1,
    myName: '',
    stream: null,
    muted: false,
    members: {},   // idx -> { name, muted, ts }
    pcs: {},       // idx -> RTCPeerConnection
    audioEls: {},  // idx -> <audio>
    iceQueue: {},  // idx -> [candidate] waiting for a remote description
    analysers: {}, // idx|'me' -> { ctx, node }
    speaking: {},  // idx|'me' -> true
    membersRef: null,
    membersHandler: null,
    signalsRef: null,
    signalsHandler: null,
    hbTimer: null,
    speakTimer: null,
    onChange: function () {},
    onError: function () {}
  };

  function db() { return window.firebase.database(); }
  function vRef(path) { return db().ref('rooms/' + S.code + '/voice/' + path); }
  function now() { return Date.now(); }

  function snapshot() {
    var members = Object.keys(S.members).map(function (k) {
      var idx = parseInt(k, 10);
      var pc = S.pcs[idx];
      return {
        idx: idx,
        name: S.members[k].name,
        muted: !!S.members[k].muted,
        speaking: !!S.speaking[idx],
        connected: !!pc && pc.connectionState === 'connected',
        me: idx === S.myIdx
      };
    }).sort(function (a, b) { return a.idx - b.idx; });
    if (S.active) {
      var haveMe = members.some(function (m) { return m.me; });
      if (!haveMe) {
        members.push({
          idx: S.myIdx, name: S.myName, muted: S.muted,
          speaking: !!S.speaking.me, connected: true, me: true
        });
        members.sort(function (a, b) { return a.idx - b.idx; });
      }
    }
    return {
      active: S.active,
      joining: S.joining,
      blocked: S.blocked,
      muted: S.muted,
      members: members
    };
  }

  function emit() { S.onChange(snapshot()); }

  function send(toIdx, kind, data) {
    vRef('signals/' + toIdx).push({ from: S.myIdx, kind: kind, data: data })
      .catch(function () { /* peer may have left; harmless */ });
  }

  // ------------------------------------------------------------ presence --
  function heartbeat() {
    if (!S.active) return;
    vRef('members/' + S.myIdx).update({
      muted: S.muted,
      ts: window.firebase.database.ServerValue.TIMESTAMP
    }).catch(function () { /* ignore */ });
  }

  function listenMembers() {
    S.membersRef = vRef('members');
    S.membersHandler = function (snap) {
      var val = snap.val() || {};
      var fresh = {};
      Object.keys(val).forEach(function (k) {
        var m = val[k];
        if (m && m.ts && now() - m.ts < STALE_MS) fresh[k] = m;
      });
      S.members = fresh;
      // Connect to / disconnect from peers as membership changes.
      Object.keys(fresh).forEach(function (k) {
        var idx = parseInt(k, 10);
        if (idx === S.myIdx || S.pcs[idx]) return;
        if (S.myIdx < idx) startPeer(idx, true); // lower index initiates
      });
      Object.keys(S.pcs).forEach(function (k) {
        if (!fresh[k]) closePeer(parseInt(k, 10));
      });
      emit();
    };
    S.membersRef.on('value', S.membersHandler);
  }

  // ------------------------------------------------------------ signaling --
  function listenSignals() {
    S.signalsRef = vRef('signals/' + S.myIdx);
    // Clear anything stale from a previous crashed session.
    S.signalsRef.remove().catch(function () { /* ignore */ });
    S.signalsHandler = function (snap) {
      var msg = snap.val();
      snap.ref.remove().catch(function () { /* ignore */ });
      if (!msg || typeof msg.from !== 'number') return;
      handleSignal(msg.from, msg.kind, msg.data);
    };
    S.signalsRef.on('child_added', S.signalsHandler);
  }

  function handleSignal(from, kind, data) {
    if (!S.active) return;
    if (kind === 'offer') {
      var pc = S.pcs[from] || startPeer(from, false);
      pc.setRemoteDescription(new RTCSessionDescription(data))
        .then(function () { return drainIce(from); })
        .then(function () { return pc.createAnswer(); })
        .then(function (ans) { return pc.setLocalDescription(ans); })
        .then(function () { send(from, 'answer', pc.localDescription.toJSON()); })
        .catch(function () { /* negotiation raced a leave — ignore */ });
    } else if (kind === 'answer') {
      var pcA = S.pcs[from];
      if (pcA && pcA.signalingState === 'have-local-offer') {
        pcA.setRemoteDescription(new RTCSessionDescription(data))
          .then(function () { return drainIce(from); })
          .catch(function () { /* ignore */ });
      }
    } else if (kind === 'ice' && data) {
      var pcI = S.pcs[from];
      if (pcI && pcI.remoteDescription) {
        pcI.addIceCandidate(new RTCIceCandidate(data)).catch(function () {});
      } else {
        (S.iceQueue[from] = S.iceQueue[from] || []).push(data);
      }
    }
  }

  function drainIce(idx) {
    var pc = S.pcs[idx];
    var q = S.iceQueue[idx] || [];
    S.iceQueue[idx] = [];
    return Promise.all(q.map(function (c) {
      return pc.addIceCandidate(new RTCIceCandidate(c)).catch(function () {});
    }));
  }

  // ---------------------------------------------------------------- peers --
  function startPeer(idx, initiator) {
    if (S.pcs[idx]) return S.pcs[idx];
    var pc = new RTCPeerConnection(ICE_CONFIG);
    S.pcs[idx] = pc;
    S.iceQueue[idx] = S.iceQueue[idx] || [];
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { pc.addTrack(t, S.stream); });
    }
    pc.onicecandidate = function (ev) {
      if (ev.candidate) send(idx, 'ice', ev.candidate.toJSON());
    };
    pc.ontrack = function (ev) {
      if (ev.streams && ev.streams[0]) attachAudio(idx, ev.streams[0]);
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        closePeer(idx);
        // The initiator retries while the peer is still in voice.
        if (S.active && S.members[idx] && S.myIdx < idx) {
          setTimeout(function () {
            if (S.active && S.members[idx] && !S.pcs[idx]) startPeer(idx, true);
          }, 1600);
        }
      }
      emit();
    };
    if (initiator) {
      pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { send(idx, 'offer', pc.localDescription.toJSON()); })
        .catch(function () { /* ignore */ });
    }
    emit();
    return pc;
  }

  function closePeer(idx) {
    var pc = S.pcs[idx];
    if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
    delete S.pcs[idx];
    delete S.iceQueue[idx];
    detachAudio(idx);
  }

  // ---------------------------------------------------------------- audio --
  function attachAudio(idx, stream) {
    detachAudio(idx);
    var el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    el.style.display = 'none';
    document.body.appendChild(el);
    S.audioEls[idx] = el;
    var p = el.play();
    if (p && p.catch) p.catch(function () { /* unlocked by unlockAudio() on next tap */ });
    watchSpeaking(idx, stream);
  }

  function detachAudio(idx) {
    var el = S.audioEls[idx];
    if (el) { try { el.srcObject = null; el.remove(); } catch (e) { /* ignore */ } }
    delete S.audioEls[idx];
    unwatchSpeaking(idx);
  }

  // Autoplay policies can hold remote audio until the user taps; the app
  // calls this on pointerdown so the first move tap also unlocks sound.
  function unlockAudio() {
    Object.keys(S.audioEls).forEach(function (k) {
      var el = S.audioEls[k];
      if (el && el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () {}); }
    });
    Object.keys(S.analysers).forEach(function (k) {
      var a = S.analysers[k];
      if (a && a.ctx.state === 'suspended') a.ctx.resume();
    });
  }

  // ------------------------------------------------------------- speaking --
  function watchSpeaking(key, stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var node = ctx.createAnalyser();
      node.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(node);
      S.analysers[key] = { ctx: ctx, node: node };
      if (!S.speakTimer) {
        S.speakTimer = setInterval(pollSpeaking, 220);
      }
    } catch (e) { /* speaking indicator is decorative */ }
  }

  function unwatchSpeaking(key) {
    var a = S.analysers[key];
    if (a) { try { a.ctx.close(); } catch (e) { /* ignore */ } }
    delete S.analysers[key];
    if (S.speaking[key]) { delete S.speaking[key]; emit(); }
  }

  function pollSpeaking() {
    var changed = false;
    Object.keys(S.analysers).forEach(function (key) {
      var a = S.analysers[key];
      var data = new Uint8Array(a.node.frequencyBinCount);
      a.node.getByteFrequencyData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) sum += data[i];
      var loud = sum / data.length > 14;
      var k = key === 'me' ? 'me' : parseInt(key, 10);
      if (!!S.speaking[k] !== loud) { S.speaking[k] = loud; changed = true; }
    });
    if (changed) emit();
  }

  // -------------------------------------------------------------- lifecycle --
  async function join(code, myIdx, myName) {
    if (S.active && S.code === code && S.myIdx === myIdx) return;
    if (S.joining) return;
    if (S.active) leave();
    S.joining = true;
    S.blocked = false;
    emit();
    try {
      var ready = await window.AzulOnline.init();
      if (!ready || !window.firebase) throw new Error('Voice is unavailable right now.');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('This browser cannot share a microphone here.');
      }
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      S.code = code; S.myIdx = myIdx; S.myName = myName;
      S.stream = stream;
      S.active = true;
      S.joining = false;
      var myRef = vRef('members/' + myIdx);
      await myRef.set({
        name: myName, muted: S.muted,
        ts: window.firebase.database.ServerValue.TIMESTAMP
      });
      myRef.onDisconnect().remove();
      vRef('signals/' + myIdx).onDisconnect().remove();
      S.hbTimer = setInterval(heartbeat, 20000);
      watchSpeaking('me', stream);
      listenMembers();
      listenSignals();
      emit();
    } catch (err) {
      S.joining = false;
      S.active = false;
      S.blocked = true;
      emit();
      throw err;
    }
  }

  function leave() {
    if (S.hbTimer) { clearInterval(S.hbTimer); S.hbTimer = null; }
    if (S.speakTimer) { clearInterval(S.speakTimer); S.speakTimer = null; }
    if (S.membersRef && S.membersHandler) S.membersRef.off('value', S.membersHandler);
    if (S.signalsRef && S.signalsHandler) S.signalsRef.off('child_added', S.signalsHandler);
    Object.keys(S.pcs).forEach(function (k) { closePeer(parseInt(k, 10)); });
    Object.keys(S.audioEls).forEach(function (k) { detachAudio(parseInt(k, 10)); });
    unwatchSpeaking('me');
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      S.stream = null;
    }
    if (S.active && S.code) {
      try {
        var myRef = vRef('members/' + S.myIdx);
        myRef.onDisconnect().cancel();
        myRef.remove().catch(function () { /* ignore */ });
        var inbox = vRef('signals/' + S.myIdx);
        inbox.onDisconnect().cancel();
        inbox.remove().catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
    S.active = false;
    S.joining = false;
    S.members = {};
    S.speaking = {};
    S.membersRef = null; S.membersHandler = null;
    S.signalsRef = null; S.signalsHandler = null;
    emit();
  }

  function setMuted(muted) {
    S.muted = !!muted;
    if (S.stream) {
      S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.muted; });
    }
    if (S.active) heartbeat();
    emit();
  }

  // Seat indices can shift in the lobby — re-key presence and peers.
  function updateIdentity(newIdx) {
    if (!S.active || newIdx === S.myIdx) return;
    var code = S.code, name = S.myName;
    leave();
    join(code, newIdx, name).catch(function () { /* UI shows Enable state */ });
  }

  window.AzulVoice = {
    join: join,
    leave: leave,
    setMuted: setMuted,
    updateIdentity: updateIdentity,
    unlockAudio: unlockAudio,
    isActive: function () { return S.active; },
    snapshot: snapshot,
    setCallbacks: function (cb) {
      if (cb.onChange) S.onChange = cb.onChange;
      if (cb.onError) S.onError = cb.onError;
    },
    _state: S // exposed for diagnostics/tests
  };
})();
