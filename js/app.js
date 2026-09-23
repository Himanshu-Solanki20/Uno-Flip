/* ==========================================================================
   app.js - screens, input and the session. The only file that decides things.
   ========================================================================== */
(function (ns) {
  'use strict';

  var view = ns.view;

  var session = null;
  var current = null;        // the latest view object
  var joinUrls = [];
  var colourOpen = false;
  var challengeOpen = false;
  var roundOpen = false;

  var canGoOnline = window.location.protocol !== 'file:';

  function $(id) { return document.getElementById(id); }

  function myName() {
    var name = ($('input-name').value || '').trim();
    return name || ns.session.savedName() || 'Player';
  }

  /* --------------------------------------------------------------- session */

  var callbacks = {
    onStatus: function (connected) {
      view.setConnected(connected || session.kind === 'local');
    },
    onHello: function (msg) {
      joinUrls = msg.urls || [];
      var code = codeFromUrl();
      if (code) { session.join({ code: code, name: myName() }); }
    },
    onRoom: function (msg) {
      joinUrls = msg.urls || joinUrls;
      if (msg.code && window.history.replaceState) {
        window.history.replaceState({}, '', '/?r=' + msg.code);
      }
    },
    onState: function (v) {
      var prev = current;
      current = v;
      route(v);
      playSounds(prev, v);
    },
    onError: function (message) {
      ns.sound.play('error');
      view.toast(message, 'bad');
    },
    onKicked: function () {
      current = null;
      view.closeAllOverlays();
      view.setScreen('home');
      view.toast('You were removed from the table.');
    },
    onLeft: function () {
      current = null;
      view.closeAllOverlays();
      view.setScreen('home');
      resetUrl();
    },
    onReplaced: function () {
      view.toast('This table was opened in another tab.', 'bad');
      view.setConnected(false);
    }
  };

  function useNet() {
    if (session && session.kind === 'net') { return session; }
    if (session) { session.dispose(); }
    session = ns.session.createNetSession(callbacks);
    session.start();
    return session;
  }

  function useLocal() {
    if (session) { session.dispose(); }
    session = ns.session.createLocalSession(callbacks);
    session.start();
    return session;
  }

  /* --------------------------------------------------------------- routing */

  function route(v) {
    if (!v || !v.seated) { view.setScreen('home'); return; }

    if (v.phase === 'lobby') {
      view.resetSide();
      roundOpen = false;
      view.closeOverlay('overlay-round');
      view.renderLobby(v, { urls: joinUrls, joinUrl: joinUrl(v.code) });
      view.setScreen('lobby');
      return;
    }

    view.renderTable(v);
    view.setScreen('table');

    // The colour sheet follows the server, so a reconnect re-opens it.
    if (v.awaitingColor && !colourOpen) {
      colourOpen = true;
      view.showColourPicker(v);
    } else if (!v.awaitingColor && colourOpen) {
      colourOpen = false;
      view.closeOverlay('overlay-colour');
    }

    if (v.canRespond && !challengeOpen) {
      challengeOpen = true;
      view.showChallenge(v);
    } else if (!v.canRespond && challengeOpen) {
      challengeOpen = false;
      view.closeOverlay('overlay-challenge');
    }

    var finished = (v.phase === 'roundOver' || v.phase === 'gameOver');
    if (finished && !roundOpen) {
      roundOpen = true;
      window.setTimeout(function () {
        if (current && (current.phase === 'roundOver' || current.phase === 'gameOver')) {
          view.showRoundEnd(current);
        }
      }, 500);
    } else if (!finished && roundOpen) {
      roundOpen = false;
      view.closeOverlay('overlay-round');
    }
  }

  /* ----------------------------------------------------------------- sounds */

  // Views carry no events, so sounds come from comparing one view to the next.
  function playSounds(prev, v) {
    var sound = ns.sound;
    if (!prev || !v || v.phase === 'lobby' || prev.phase === 'lobby' && v.phase !== 'playing') {
      return;
    }

    if (v.phase === 'playing' && prev.phase !== 'playing') {
      sound.play('deal');
    } else if (v.phase !== 'playing' && prev.phase === 'playing') {
      var won = v.lastWinner && v.lastWinner.id === v.youId;
      sound.play('card');
      sound.play(won ? 'win' : 'lose', 0.25);
      return;
    } else if (prev.side && v.side !== prev.side) {
      sound.play('flip');
    } else if (v.discardCount > prev.discardCount) {
      sound.play('card');
    } else if (v.drawCount < prev.drawCount) {
      sound.play('draw');
    }

    var shouted = v.players.some(function (p) {
      var before = prev.players.filter(function (q) { return q.id === p.id; })[0];
      return p.calledUno && !(before && before.calledUno);
    });
    if (shouted) { sound.play('uno', 0.1); }

    var yourTurn = v.you && v.you.isTurn && v.turnPhase === 'turn';
    var wasYourTurn = prev.you && prev.you.isTurn;
    if (yourTurn && !wasYourTurn) { sound.play('turn', 0.25); }
  }

  function renderSoundButton() {
    var b = $('btn-sound');
    var muted = ns.sound.isMuted();
    b.textContent = muted ? '🔇' : '🔊';
    b.setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
    b.setAttribute('aria-pressed', String(!muted));
  }

  function toggleSound() {
    ns.sound.unlock();
    ns.sound.setMuted(!ns.sound.isMuted());
    renderSoundButton();
    ns.sound.play('turn');
  }

  function joinUrl(code) {
    if (!code) { return null; }
    // On localhost the LAN address is the only one a phone can reach; anywhere
    // else (LAN ip, or a public host) the address already in the bar is right.
    var host = window.location.hostname;
    var local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    var base = (local && joinUrls[0]) || window.location.origin;
    // The code rides in the query, not the path: a page served at /r/CODE
    // resolves index.html's relative css/ and js/ against /r/ and loads
    // unstyled and dead. At the root they resolve, on file:// too.
    return base.replace(/\/?(?:\?r=|r\/)[A-Z0-9]{4}\/?$/i, '') + '/?r=' + code;
  }

  function codeFromUrl() {
    // /?r=CODE is the link we hand out; /r/CODE is an older one, which the
    // server redirects, but read it too for a link opened straight off disk.
    var m = window.location.search.match(/[?&]r=([A-Z0-9]{4})(?:&|$)/i) ||
            window.location.pathname.match(/^\/r\/([A-Z0-9]{4})\/?$/i);
    return m ? m[1].toUpperCase() : null;
  }

  function resetUrl() {
    if (window.history.replaceState) { window.history.replaceState({}, '', '/'); }
  }

  /* ---------------------------------------------------------- table actions */

  var handlers = {
    play: function (cardId) { session.act({ type: 'play', cardId: cardId }); },
    draw: function () { session.act({ type: 'draw' }); },
    pass: function () { session.act({ type: 'pass' }); },
    colour: function (colour) {
      colourOpen = false;
      session.act({ type: 'color', color: colour });
    },
    uno: function () { session.act({ type: 'uno' }); },
    catchUno: function () { session.act({ type: 'catch' }); },
    respond: function (challenge) {
      challengeOpen = false;
      view.closeOverlay('overlay-challenge');
      session.act({ type: challenge ? 'challenge' : 'accept' });
    },
    kick: function (id) { session.kick(id); }
  };

  /* ----------------------------------------------------------------- wiring */

  function wire() {
    $('input-name').value = ns.session.savedName();

    if (!canGoOnline) {
      $('btn-create').disabled = true;
      $('btn-join-open').disabled = true;
      $('home-note').textContent =
        'Opened straight from a file, so only offline play is available. ' +
        'Run "npm start" and open the address it prints to play across devices.';
    } else {
      $('home-note').textContent =
        'Everyone joins from their own phone or laptop — same Wi-Fi, same table.';
    }

    $('btn-create').addEventListener('click', function () {
      useNet().create({ name: myName(), mode: 'flip', target: 0 });
    });

    $('btn-join-open').addEventListener('click', function () {
      var row = $('join-row');
      row.hidden = !row.hidden;
      if (!row.hidden) { $('input-code').focus(); }
    });

    $('join-row').addEventListener('submit', function (e) {
      e.preventDefault();
      var code = ($('input-code').value || '').trim().toUpperCase();
      if (code.length !== 4) { view.toast('A code is four characters.', 'bad'); return; }
      useNet().join({ code: code, name: myName() });
    });

    $('input-code').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    $('btn-offline').addEventListener('click', function () {
      var s = useLocal();
      s.create({ name: myName(), mode: 'flip', target: 0 });
      s.addBot();
      s.addBot();
    });

    /* lobby */
    $('btn-lobby-back').addEventListener('click', function () { session.leave(); });
    $('btn-add-bot').addEventListener('click', function () { session.addBot(); });
    $('btn-deal').addEventListener('click', function () { session.startRound(); });

    $('btn-copy').addEventListener('click', function () {
      var text = joinUrl(current && current.code) || '';
      if (!text) { return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { view.toast('Join link copied.'); },
          function () { view.toast(text); }
        );
      } else {
        view.toast(text);
      }
    });

    segmentGroup('opt-mode', function (value) {
      session.options({ mode: value, target: current ? current.target : 0 });
    });
    segmentGroup('opt-target', function (value) {
      session.options({ mode: current ? current.mode : 'flip', target: parseInt(value, 10) });
    });

    /* table */
    $('pile-draw').addEventListener('click', handlers.draw);
    $('btn-uno').addEventListener('click', handlers.uno);
    $('btn-challenge').addEventListener('click', function () { handlers.respond(true); });
    $('btn-accept').addEventListener('click', function () { handlers.respond(false); });
    $('btn-next').addEventListener('click', function () {
      view.closeOverlay('overlay-round');
      roundOpen = false;
      session.act({ type: 'next' });
    });

    $('btn-menu').addEventListener('click', function () { view.openOverlay('overlay-menu'); });
    $('btn-rules').addEventListener('click', function () {
      view.closeOverlay('overlay-menu');
      view.openOverlay('overlay-rules');
    });
    $('btn-scores').addEventListener('click', function () {
      view.closeOverlay('overlay-menu');
      if (current) { view.showScores(current); }
    });
    $('btn-leave').addEventListener('click', function () {
      view.closeAllOverlays();
      session.leave();
    });

    $('btn-sound').addEventListener('click', toggleSound);
    renderSoundButton();

    // Browsers (iOS above all) only allow audio after the player touches the page.
    ['click', 'touchend', 'keydown'].forEach(function (type) {
      document.addEventListener(type, ns.sound.unlock, true);
    });

    $('btn-log').addEventListener('click', function () {
      $('log-drawer').classList.toggle('is-open');
    });
    $('btn-log-close').addEventListener('click', function () {
      $('log-drawer').classList.remove('is-open');
    });

    Array.prototype.forEach.call(document.querySelectorAll('.js-close'), function (b) {
      b.addEventListener('click', function () {
        b.closest('.overlay').classList.remove('is-open');
      });
    });

    document.addEventListener('keydown', function (e) {
      if (/^(input|textarea)$/i.test(e.target.tagName)) { return; }
      var key = e.key.toLowerCase();
      if (key === 'escape') {
        var open = document.querySelector('.overlay.is-open');
        if (open && open.id !== 'overlay-colour' && open.id !== 'overlay-round' &&
            open.id !== 'overlay-challenge') {
          open.classList.remove('is-open');
        }
        return;
      }
      if (document.querySelector('.overlay.is-open')) { return; }
      if (key === 'd' && current && current.canDraw) { handlers.draw(); }
      if (key === 'u') { handlers.uno(); }
      if (key === 'c' && current && current.canCatch) { handlers.catchUno(); }
      if (key === 'm') { toggleSound(); }
    });
  }

  function segmentGroup(id, onPick) {
    $(id).addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || !current || !current.isHost) { return; }
      onPick(btn.dataset.value);
    });
  }

  /* -------------------------------------------------------------------- boot */

  document.addEventListener('DOMContentLoaded', function () {
    view.init(handlers);
    wire();
    view.setScreen('home');

    // Arriving on a join link: connect and let onHello do the joining.
    if (canGoOnline && codeFromUrl()) {
      $('input-code').value = codeFromUrl();
      useNet();
    }
  });
})(window.UNO = window.UNO || {});
