/* ==========================================================================
   sound.js - table sounds, synthesised with Web Audio. No audio files.

   Browser only. iOS keeps audio locked until the first tap, so the context
   is created (or resumed) inside a user gesture by unlock().
   ========================================================================== */
(function (ns) {
  'use strict';

  var KEY = 'uno.muted';
  var ctx = null;
  var master = null;
  var muted = readMuted();

  function readMuted() {
    try { return window.localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  function saveMuted() {
    try { window.localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  // Must run inside a real gesture (click, touchend, keydown) - iOS ignores
  // pointerdown and touchstart for unlocking audio.
  function unlock() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }

    // Safari 16.4+: treat this as media playback, so the ring/silent switch
    // does not mute it.
    try {
      if (navigator.audioSession) { navigator.audioSession.type = 'playback'; }
    } catch (e) { /* not supported */ }

    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    // 'interrupted' is iOS after a call or leaving the app.
    if (ctx.state !== 'running' && ctx.resume) { ctx.resume(); }

    // Older iOS only unlocks once something actually plays inside the gesture.
    var blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start(0);
  }

  /* ------------------------------------------------------------ building */

  // A single pitched note with a quick attack and exponential fade.
  function tone(at, freq, len, type, vol, slideTo) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) { osc.frequency.exponentialRampToValueAtTime(slideTo, at + len); }
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(vol || 0.3, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
    osc.connect(gain);
    gain.connect(master);
    osc.start(at);
    osc.stop(at + len + 0.02);
  }

  // A burst of filtered noise - the papery part of a card sound.
  function noise(at, len, freq, vol) {
    var frames = Math.floor(ctx.sampleRate * len);
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) { data[i] = Math.random() * 2 - 1; }

    var src = ctx.createBufferSource();
    src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 0.9;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(vol || 0.5, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + len);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(at);
  }

  var SOUNDS = {
    card: function (t) {
      noise(t, 0.09, 1800, 0.7);
      tone(t, 180, 0.08, 'triangle', 0.25);
    },
    draw: function (t) {
      noise(t, 0.16, 3200, 0.35);
    },
    deal: function (t) {
      for (var i = 0; i < 5; i++) { noise(t + i * 0.07, 0.07, 2600, 0.3); }
    },
    turn: function (t) {
      tone(t, 880, 0.16, 'sine', 0.22);
      tone(t + 0.1, 1320, 0.22, 'sine', 0.18);
    },
    uno: function (t) {
      tone(t, 523, 0.12, 'square', 0.12);
      tone(t + 0.09, 659, 0.12, 'square', 0.12);
      tone(t + 0.18, 784, 0.3, 'square', 0.14);
    },
    flip: function (t) {
      tone(t, 220, 0.45, 'sine', 0.3, 1400);
      noise(t, 0.4, 900, 0.2);
    },
    error: function (t) {
      tone(t, 150, 0.2, 'sawtooth', 0.12);
    },
    win: function (t) {
      [523, 659, 784, 1047].forEach(function (f, i) {
        tone(t + i * 0.12, f, i === 3 ? 0.5 : 0.16, 'triangle', 0.3);
      });
    },
    lose: function (t) {
      [392, 330, 262].forEach(function (f, i) {
        tone(t + i * 0.18, f, 0.28, 'triangle', 0.25);
      });
    }
  };

  // play('card') now, or play('turn', 0.2) a fifth of a second later.
  function play(name, delay) {
    if (muted || !ctx || ctx.state !== 'running' || !SOUNDS[name]) { return; }
    try {
      SOUNDS[name](ctx.currentTime + (delay || 0));
    } catch (e) { /* audio is decoration - never break the game over it */ }
  }

  function setMuted(value) {
    muted = !!value;
    saveMuted();
  }

  ns.sound = {
    unlock: unlock,
    play: play,
    setMuted: setMuted,
    isMuted: function () { return muted; }
  };
})(window.UNO = window.UNO || {});
