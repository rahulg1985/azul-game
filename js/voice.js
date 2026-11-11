/*
 * Azul — in-room voice chat (WebRTC mesh, Firebase RTDB signaling).
 *
 * Exposes window.AzulVoice. Audio flows directly peer-to-peer between the
 * 2–4 players in a room (full mesh); Firebase only carries the signaling
 * (offers/answers/ICE) and voice presence, under:
 *
 *   rooms/{code}/voice/members/{playerIdx} = { name, muted, mic, ts }
 *   rooms/{code}/voice/signals/{toIdx}/{pushId} = { from, kind, data }
 *
 * The lower player index always initiates the peer connection, which
 * keeps offer/answer glare impossible without extra negotiation logic.
 * ICE uses Google's public STUN servers; there is no TURN relay, so a
 * small minority of very strict networks may not connect audio (the
 * game itself is unaffected).
 *
 * Playback: remote audio is routed through ONE shared WebAudio context
 * (MediaStreamSource -> GainNode -> destination). On iOS, a plain
 * <audio> element carrying WebRTC audio is routed to the quiet earpiece
 * receiver while the mic is live; WebAudio output goes to the loud
 * speaker, which is what players expect. The <audio> element is kept
 * per peer as a fallback sink for browsers where the WebAudio route is
 * unavailable, and the speaker toggle drives the gain (or the element's
 * muted flag on the fallback path).
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
    joinSeq: 0,
    blocked: false, // mic permission denied / unavailable on last attempt
    code: null,
    myIdx: -1,
    myName: '',
    stream: null,
    muted: false,
    speakerOn: true,
    ctx: null,     // shared AudioContext for playback + speaking meters
    members: {},   // idx -> { name, muted, mic, ts }
    pcs: {},       // idx -> RTCPeerConnection
    audioEls: {},  // idx -> <audio> (fallback sink)
    nodes: {},     // idx -> { source, gain } WebAudio playback route
    routed: {},    // idx -> true when the WebAudio route carries the audio
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

  // One shared AudioContext for every voice stream. Created lazily —
  // before the first user gesture it starts out suspended and the app's
  // pointerdown unlock (unlockAudio) resumes it.
  function actx() {
    if (S.ctx) return S.ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      S.ctx = new AC();
      S.ctx.onstatechange = function () {
        if (window.AzulAudioLog) window.AzulAudioLog('Voice sound engine: ' + S.ctx.state);
      };
      if (window.AzulAudioLog) window.AzulAudioLog('Voice sound engine: ' + S.ctx.state);
    } catch (e) { S.ctx = null; }
    return S.ctx;
  }

  function snapshot() {
    var members = Object.keys(S.members).map(function (k) {
      var idx = parseInt(k, 10);
      var pc = S.pcs[idx];
      return {
        idx: idx,
        name: S.members[k].name,
        muted: !!S.members[k].muted,
        mic: S.members[k].mic !== false,
        speaker: S.members[k].speaker !== false,
        speaking: !!S.speaking[idx],
        connected: !!pc && pc.connectionState === 'connected',
        me: idx === S.myIdx
      };
    }).sort(function (a, b) { return a.idx - b.idx; });
    if (S.active) {
      var haveMe = members.some(function (m) { return m.me; });
      if (!haveMe) {
        members.push({
          idx: S.myIdx, name: S.myName, muted: S.muted, mic: !!S.stream,
          speaker: S.speakerOn,
          speaking: !!S.speaking.me, connected: true, me: true
        });
        members.sort(function (a, b) { return a.idx - b.idx; });
      }
    }
    return {
      active: S.active,
      joining: S.joining,
      blocked: S.blocked,
      hasMic: !!S.stream,
      muted: S.muted,
      speakerOn: S.speakerOn,
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
      mic: !!S.stream,
      speaker: S.speakerOn,
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
      connectToEligiblePeers();
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

  // Connect only when both sides can actually do audio: I need my mic
  // stream, and the peer's presence must not say mic:false (a member who
  // joined without a mic flips to mic:true when their mic lands, which
  // re-fires the members listener and connects us then).
  function connectToEligiblePeers() {
    if (!S.stream) return;
    Object.keys(S.members).forEach(function (k) {
      var idx = parseInt(k, 10);
      if (idx === S.myIdx || S.pcs[idx]) return;
      if (S.members[k].mic === false) return;
      if (S.myIdx < idx) startPeer(idx, true); // lower index initiates
    });
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
      if (pc.connectionState === 'disconnected' && S.active && S.myIdx < idx) {
        // Transient network wobble (common when a phone switches
        // Wi-Fi/cellular): ask ICE to re-negotiate instead of dropping.
        setTimeout(function () {
          if (S.pcs[idx] !== pc || pc.connectionState !== 'disconnected' || !S.active) return;
          try {
            if (pc.restartIce) pc.restartIce();
            pc.createOffer({ iceRestart: true })
              .then(function (offer) { return pc.setLocalDescription(offer); })
              .then(function () { send(idx, 'offer', pc.localDescription.toJSON()); })
              .catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }, 2500);
      }
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
  function playEl(el) {
    try {
      var p = el.play();
      if (p && p.catch) p.catch(function () { /* retried on next tap / timer */ });
    } catch (e) { /* ignore */ }
  }

  function attachAudio(idx, stream) {
    detachAudio(idx);
    // Fallback sink. Kept rendered (1px, transparent) rather than
    // display:none — some mobile browsers refuse to play hidden media.
    var el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    el.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;' +
      'opacity:.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(el);
    S.audioEls[idx] = el;

    // Primary route: WebAudio -> loud speaker (see file header).
    var routed = false;
    try {
      var ctx = actx();
      if (ctx) {
        var source = ctx.createMediaStreamSource(stream);
        var gain = ctx.createGain();
        gain.gain.value = S.speakerOn ? 1 : 0;
        source.connect(gain);
        gain.connect(ctx.destination);
        var an = ctx.createAnalyser();
        an.fftSize = 256;
        source.connect(an);
        S.nodes[idx] = { source: source, gain: gain };
        S.analysers[idx] = { ctx: ctx, node: an };
        if (!S.speakTimer) S.speakTimer = setInterval(pollSpeaking, 220);
        routed = true;
      }
    } catch (e) { routed = false; }
    S.routed[idx] = routed;

    // When the WebAudio route carries the sound, the element stays
    // muted (it just keeps the stream warm); otherwise the element IS
    // the speaker and obeys the speaker toggle.
    el.muted = routed ? true : !S.speakerOn;
    el.volume = 1;
    playEl(el);
    // Autoplay policies can hold element playback until the user taps;
    // retry a few times so the fallback path recovers on its own.
    [600, 1500, 3000].forEach(function (d) {
      setTimeout(function () {
        if (S.audioEls[idx] === el && el.paused) playEl(el);
        var c = S.ctx;
        if (c && c.state === 'suspended') { /* resumes on next tap */ }
      }, d);
    });
  }

  function detachAudio(idx) {
    var n = S.nodes[idx];
    if (n) {
      try { n.source.disconnect(); } catch (e) { /* ignore */ }
      try { n.gain.disconnect(); } catch (e) { /* ignore */ }
      delete S.nodes[idx];
    }
    delete S.routed[idx];
    var el = S.audioEls[idx];
    if (el) { try { el.srcObject = null; el.remove(); } catch (e) { /* ignore */ } }
    delete S.audioEls[idx];
    unwatchSpeaking(idx);
  }

  // Autoplay policies can hold remote audio until the user taps; the app
  // calls this on pointerdown so the first move tap also unlocks sound.
  // It also resumes the shared playback context — the call runs inside
  // the tap, which is exactly the gesture iOS requires.
  function unlockAudio() {
    var ctx = actx();
    if (ctx && ctx.state === 'suspended') {
      try { var rp = ctx.resume(); if (rp && rp.catch) rp.catch(function () {}); } catch (e) { /* ignore */ }
    }
    Object.keys(S.audioEls).forEach(function (k) {
      var el = S.audioEls[k];
      if (el && el.paused) playEl(el);
    });
  }

  // Speaker on/off: silences (or restores) everyone's voice on THIS
  // device only — the mic keeps sending. Drives the WebAudio gain on
  // the primary route and the element mute on the fallback route.
  function setSpeaker(on) {
    S.speakerOn = !!on;
    Object.keys(S.nodes).forEach(function (k) {
      var n = S.nodes[k];
      if (n && n.gain) {
        try { n.gain.gain.value = S.speakerOn ? 1 : 0; } catch (e) { /* ignore */ }
      }
    });
    Object.keys(S.audioEls).forEach(function (k) {
      var el = S.audioEls[k];
      if (el) el.muted = S.routed[k] ? true : !S.speakerOn;
    });
    if (S.active) heartbeat(); // others see my speaker state in their list
    emit();
  }

  // ------------------------------------------------------------- speaking --
  function watchSpeaking(key, stream) {
    // Local mic meter only — remote meters are wired in attachAudio.
    try {
      var ctx = actx();
      if (!ctx) return;
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
    if (S.active && S.code === code && S.myIdx === myIdx && S.stream) return;
    if (S.joining) return;
    // Already present in this room but mic-less (blocked earlier): a fresh
    // call just retries the microphone, keeping the existing presence.
    var resumeMicOnly = S.active && S.code === code && S.myIdx === myIdx;
    if (S.active && !resumeMicOnly) leave();
    var seq = ++S.joinSeq;
    S.joining = true;
    S.blocked = false;
    actx(); // create the playback context as early as possible
    emit();
    try {
      if (!resumeMicOnly) {
        var ready = false;
        try { ready = await window.AzulOnline.init(); } catch (e) { ready = false; }
        if (seq !== S.joinSeq) return;
        if (!ready || !window.firebase) throw new Error('Voice is unavailable right now.');
        S.code = code; S.myIdx = myIdx; S.myName = myName;
        S.active = true;
        var myRef = vRef('members/' + myIdx);
        await myRef.set({
          name: myName, muted: S.muted, mic: false, speaker: S.speakerOn,
          ts: window.firebase.database.ServerValue.TIMESTAMP
        });
        if (seq !== S.joinSeq) return;
        myRef.onDisconnect().remove();
        vRef('signals/' + myIdx).onDisconnect().remove();
        S.hbTimer = setInterval(heartbeat, 20000);
        listenMembers();
        listenSignals();
      }
      S.joining = false;
      emit();
      await acquireMic(seq);
    } catch (err) {
      if (seq !== S.joinSeq) return;
      S.joining = false;
      if (!S.active) S.blocked = true;
      emit();
      throw err;
    }
  }

  async function acquireMic(seq) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      S.blocked = true;
      emit();
      throw new Error('This browser cannot share a microphone here.');
    }
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (err) {
      if (seq === S.joinSeq) { S.blocked = true; emit(); }
      throw err;
    }
    if (seq !== S.joinSeq) {
      // Left the room while the mic prompt was up — drop the stream.
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      return;
    }
    S.stream = stream;
    S.blocked = false;
    unlockAudio(); // mic grant counts as engagement — wake playback up
    watchSpeaking('me', stream);
    vRef('members/' + S.myIdx).update({
      mic: true, ts: window.firebase.database.ServerValue.TIMESTAMP
    }).catch(function () { /* ignore */ });
    connectToEligiblePeers();
    emit();
  }

  function leave() {
    S.joinSeq++;
    if (S.hbTimer) { clearInterval(S.hbTimer); S.hbTimer = null; }
    if (S.speakTimer) { clearInterval(S.speakTimer); S.speakTimer = null; }
    if (S.membersRef && S.membersHandler) S.membersRef.off('value', S.membersHandler);
    if (S.signalsRef && S.signalsHandler) S.signalsRef.off('child_added', S.signalsHandler);
    Object.keys(S.pcs).forEach(function (k) { closePeer(parseInt(k, 10)); });
    Object.keys(S.audioEls).forEach(function (k) { detachAudio(parseInt(k, 10)); });
    Object.keys(S.nodes).forEach(function (k) { detachAudio(parseInt(k, 10)); });
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
    setSpeaker: setSpeaker,
    updateIdentity: updateIdentity,
    unlockAudio: unlockAudio,
    isActive: function () { return S.active; },
    ctxState: function () { return S.ctx ? S.ctx.state : 'Not started yet'; },
    snapshot: snapshot,
    setCallbacks: function (cb) {
      if (cb.onChange) S.onChange = cb.onChange;
      if (cb.onError) S.onError = cb.onError;
    },
    _state: S // exposed for diagnostics/tests
  };
})();
