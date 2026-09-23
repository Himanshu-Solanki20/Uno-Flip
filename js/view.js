/* ==========================================================================
   view.js - renders a view object. Reads state, writes DOM, decides nothing.
   ========================================================================== */
(function (ns) {
  'use strict';

  var C = ns.cards;
  var on = {};
  var lastSide = null;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- shell */

  function setScreen(name) {
    document.body.dataset.screen = name;
  }

  function openOverlay(id) { $(id).classList.add('is-open'); }
  function closeOverlay(id) { $(id).classList.remove('is-open'); }

  function closeAllOverlays() {
    Array.prototype.forEach.call(document.querySelectorAll('.overlay.is-open'),
      function (n) { n.classList.remove('is-open'); });
  }

  function toast(message, kind) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast is-open' + (kind ? ' toast-' + kind : '');
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () {
      node.classList.remove('is-open');
    }, 2600);
  }

  function setConnected(connected) {
    $('reconnect').classList.toggle('is-open', !connected);
  }

  /* ----------------------------------------------------------------- cards */

  function cardNode(face, opts) {
    opts = opts || {};
    var node = document.createElement(opts.button ? 'button' : 'div');
    node.className = 'uc uc-' + face.color + ' uc-t-' + face.type +
      (opts.extra ? ' ' + opts.extra : '');
    if (opts.button) { node.type = 'button'; }

    var glyph = C.glyph(face);
    var sub = C.subLabel(face);

    if (face.color === 'wild') {
      var wheel = document.createElement('span');
      wheel.className = 'uc-wheel';
      C.colorsFor(face.side).forEach(function (c) {
        var q = document.createElement('i');
        q.className = 'uc-q uc-q-' + c;
        wheel.appendChild(q);
      });
      node.appendChild(wheel);
    }

    var tl = document.createElement('span');
    tl.className = 'uc-pip uc-pip-tl';
    tl.textContent = glyph;

    var oval = document.createElement('span');
    oval.className = 'uc-oval';

    var big = document.createElement('span');
    big.className = 'uc-glyph';
    big.textContent = glyph;
    oval.appendChild(big);

    if (sub) {
      var small = document.createElement('span');
      small.className = 'uc-sub';
      small.textContent = sub;
      oval.appendChild(small);
    }

    var br = document.createElement('span');
    br.className = 'uc-pip uc-pip-br';
    br.textContent = glyph;

    node.appendChild(tl);
    node.appendChild(oval);
    node.appendChild(br);
    node.title = C.name(face);
    return node;
  }

  function cardBack(extra) {
    var node = document.createElement('div');
    node.className = 'uc uc-back' + (extra ? ' ' + extra : '');
    var oval = document.createElement('span');
    oval.className = 'uc-back-oval';
    oval.textContent = 'UNO';
    node.appendChild(oval);
    return node;
  }

  /* ----------------------------------------------------------------- lobby */

  function renderLobby(v, ctx) {
    $('room-code').textContent = v.code || 'OFFLINE';
    $('share-panel').hidden = !v.code;

    if (v.code && ctx.joinUrl) {
      var qr = $('qr');
      qr.src = '/qr.svg?d=' + encodeURIComponent(ctx.joinUrl);
      qr.hidden = false;
      $('share-hint').textContent = 'Scan this, or open the address below and ' +
        'enter code ' + v.code + '.';
      $('share-urls').innerHTML = '';
      (ctx.urls || []).forEach(function (u) {
        var row = document.createElement('code');
        row.className = 'url-row';
        row.textContent = u;
        $('share-urls').appendChild(row);
      });
    }

    $('seat-count').textContent = v.players.length + '/' + v.maxSeats;

    var list = $('seat-list');
    list.innerHTML = '';
    v.players.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'seat-row' + (p.online || p.kind === 'bot' ? '' : ' is-offline');

      var dot = document.createElement('span');
      dot.className = 'avatar ' + (p.kind === 'bot' ? 'is-bot' : '');
      dot.textContent = p.name.slice(0, 1).toUpperCase();

      var name = document.createElement('span');
      name.className = 'seat-row-name';
      name.textContent = p.name;

      var tags = document.createElement('span');
      tags.className = 'seat-row-tags';
      if (p.isHost) { tags.appendChild(tag('HOST', 'host')); }
      if (p.kind === 'bot') { tags.appendChild(tag('BOT', 'bot')); }
      if (p.kind !== 'bot' && !p.online) { tags.appendChild(tag('AWAY', 'away')); }
      if (p.id === v.youId) { tags.appendChild(tag('YOU', 'you')); }

      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(tags);

      if (v.isHost && p.id !== v.youId) {
        var kick = document.createElement('button');
        kick.className = 'icon-btn icon-btn-sm';
        kick.textContent = '×';
        kick.title = 'Remove ' + p.name;
        kick.addEventListener('click', function () { on.kick(p.id); });
        li.appendChild(kick);
      }
      list.appendChild(li);
    });

    segment('opt-mode', v.mode);
    segment('opt-target', String(v.target));
    $('options-panel').classList.toggle('is-locked', !v.isHost);
    $('btn-add-bot').disabled = !v.isHost || v.players.length >= v.maxSeats;
    $('btn-deal').disabled = !v.isHost || v.players.length < 2;

    $('lobby-hint').textContent = !v.isHost
      ? 'Waiting for the host to deal…'
      : (v.players.length < 2
          ? 'Add a bot, or share the code to bring someone in.'
          : '');
  }

  function tag(text, kind) {
    var s = document.createElement('span');
    s.className = 'tag tag-' + kind;
    s.textContent = text;
    return s;
  }

  function segment(id, value) {
    Array.prototype.forEach.call($(id).querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('is-on', b.dataset.value === value);
    });
  }

  /* ----------------------------------------------------------------- table */

  function renderTable(v) {
    document.body.dataset.side = v.side || 'light';
    document.body.dataset.mode = v.mode;

    if (lastSide && v.side && v.side !== lastSide) { flipAnimation(); }
    lastSide = v.side;

    $('hud-code').textContent = v.code || 'Offline';
    $('hud-code').hidden = !v.code;
    $('hud-side').textContent = v.side === 'dark' ? 'Dark Side' : 'Light Side';
    $('hud-side').hidden = v.mode !== 'flip';
    $('hud-dir').textContent = v.direction === 1 ? '↻' : '↺';

    renderSeats(v);
    renderFelt(v);
    renderTray(v);
    renderLog(v);
  }

  function renderSeats(v) {
    var wrap = $('seats');
    wrap.innerHTML = '';

    var others = v.players.filter(function (p) { return p.id !== v.youId; });
    wrap.dataset.count = others.length;

    others.forEach(function (p) {
      var seat = document.createElement('div');
      seat.className = 'seat';
      if (p.isTurn) { seat.classList.add('is-turn'); }
      if (p.count === 1) { seat.classList.add('is-uno'); }
      if (p.kind !== 'bot' && !p.online) { seat.classList.add('is-away'); }

      var head = document.createElement('div');
      head.className = 'seat-top';

      var av = document.createElement('span');
      av.className = 'avatar' + (p.kind === 'bot' ? ' is-bot' : '');
      av.textContent = p.name.slice(0, 1).toUpperCase();

      var meta = document.createElement('span');
      meta.className = 'seat-meta';
      var nm = document.createElement('b');
      nm.textContent = p.name;
      var ct = document.createElement('small');
      ct.textContent = p.count + (p.count === 1 ? ' card' : ' cards') +
        ' · ' + p.score + ' pts';
      meta.appendChild(nm);
      meta.appendChild(ct);

      head.appendChild(av);
      head.appendChild(meta);

      if (p.count === 1 && p.calledUno) { head.appendChild(tag('UNO!', 'uno')); }
      if (p.kind !== 'bot' && !p.online) { head.appendChild(tag('AWAY', 'away')); }

      var fan = document.createElement('div');
      fan.className = 'seat-cards';
      var shown = Math.min(p.count, 8);
      for (var i = 0; i < shown; i++) {
        fan.appendChild(cardBack('uc-mini'));
      }
      if (p.count > shown) {
        var more = document.createElement('span');
        more.className = 'seat-more';
        more.textContent = '+' + (p.count - shown);
        fan.appendChild(more);
      }

      seat.appendChild(head);
      seat.appendChild(fan);
      wrap.appendChild(seat);
    });
  }

  function renderFelt(v) {
    $('draw-count').textContent = v.drawCount != null ? v.drawCount : '';
    $('pile-draw').disabled = !v.canDraw;
    $('pile-draw').classList.toggle('is-live', !!v.canDraw);

    var discard = $('pile-discard');
    discard.innerHTML = '';
    if (v.discardTop) {
      discard.appendChild(cardNode(v.discardTop, { extra: 'uc-big' }));
    }

    var chip = $('colour-now');
    chip.className = 'colour-now sw-' + (v.currentColor || 'none');
    chip.textContent = v.currentColor ? C.COLOR_NAMES[v.currentColor] : '';

    $('status').textContent = statusText(v);

    var actions = $('actions');
    actions.innerHTML = '';
    if (v.canCatch) {
      actions.appendChild(button('Catch ' + v.catchName + '!', 'btn btn-catch',
        function () { on.catchUno(); }));
    }
    if (v.canPass) {
      actions.appendChild(button('Pass', 'btn', function () { on.pass(); }));
    }
    if (v.canDraw) {
      actions.appendChild(button('Draw a card', 'btn btn-primary',
        function () { on.draw(); }));
    }
  }

  function statusText(v) {
    if (!v.you) { return 'Watching this round.'; }
    if (v.challenge && !v.canRespond) {
      return v.challenge.victimName + ' is deciding whether to challenge…';
    }
    if (v.you.isTurn) {
      if (v.turnPhase === 'awaitColor') { return 'Choose a colour…'; }
      if (v.turnPhase === 'challenge') { return 'Take it or challenge?'; }
      if (v.turnPhase === 'drawnDecision') { return 'You drew a card you can play.'; }
      var playable = v.you.hand.filter(function (c) { return c.playable; }).length;
      return playable ? 'Your turn.' : 'Nothing matches — take a card.';
    }
    var cur = v.players.filter(function (p) { return p.id === v.currentId; })[0];
    return cur ? cur.name + ' is playing…' : '';
  }

  function button(label, cls, fn) {
    var b = document.createElement('button');
    b.className = cls;
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function renderTray(v) {
    var tray = $('tray-cards');
    tray.innerHTML = '';

    if (!v.you) {
      $('tray-label').textContent = 'Spectating';
      $('btn-uno').disabled = true;
      return;
    }

    $('tray-label').textContent = v.you.hand.length +
      (v.you.hand.length === 1 ? ' card' : ' cards') + ' · ' + v.you.score + ' pts';

    v.you.hand.forEach(function (c) {
      var node = cardNode(c.face, {
        button: true,
        extra: (c.playable ? 'is-live' : 'is-dim') +
               (c.id === v.drawnCardId ? ' is-fresh' : '')
      });
      node.disabled = !c.playable;
      node.addEventListener('click', function () { on.play(c.id); });
      tray.appendChild(node);
    });

    var uno = $('btn-uno');
    uno.disabled = !v.you.canCallUno;
    uno.classList.toggle('is-armed', v.unoPending === indexOfYou(v));
  }

  function indexOfYou(v) {
    for (var i = 0; i < v.players.length; i++) {
      if (v.players[i].id === v.youId) { return i; }
    }
    return -1;
  }

  function renderLog(v) {
    var list = $('log');
    list.innerHTML = '';
    (v.log || []).forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'log-' + entry.kind;
      li.textContent = entry.text;
      list.appendChild(li);
    });
    list.scrollTop = list.scrollHeight;
  }

  /* -------------------------------------------------------------- colours */

  function showColourPicker(v) {
    var grid = $('colour-grid');
    grid.innerHTML = '';
    (v.colorChoices || []).forEach(function (colour) {
      var b = document.createElement('button');
      b.className = 'colour-pick sw-' + colour;
      b.type = 'button';
      b.textContent = C.COLOR_NAMES[colour];
      b.addEventListener('click', function () {
        closeOverlay('overlay-colour');
        on.colour(colour);
      });
      grid.appendChild(b);
    });
    openOverlay('overlay-colour');
  }

  /* ------------------------------------------------------------ challenge */

  function showChallenge(v) {
    var ch = v.challenge;
    $('challenge-title').textContent = ch.byName + ' played a ' + ch.card;
    $('challenge-sub').textContent = 'The colour is now ' +
      C.COLOR_NAMES[ch.color] + '.';
    $('btn-accept').textContent = ch.draw
      ? 'Take it (draw ' + ch.draw + ')'
      : 'Take it (draw until ' + C.COLOR_NAMES[ch.color] + ')';
    openOverlay('overlay-challenge');
  }

  /* --------------------------------------------------------------- scores */

  function scoreTable(v) {
    var rows = '<tr><th>Player</th><th>Score</th></tr>';
    v.players.slice().sort(function (a, b) { return b.score - a.score; })
      .forEach(function (p) {
        rows += '<tr' + (p.id === v.youId ? ' class="is-you"' : '') + '><td>' +
          escapeHtml(p.name) + '</td><td>' + p.score + '</td></tr>';
      });
    return rows;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function showScores(v) {
    $('scores-table').innerHTML = scoreTable(v);
    openOverlay('overlay-scores');
  }

  function showRoundEnd(v) {
    var w = v.lastWinner || {};
    var youWon = w.id === v.youId;
    var over = v.phase === 'gameOver';

    $('round-title').textContent = over
      ? (youWon ? 'You win!' : w.name + ' wins the game')
      : (youWon ? 'You won the round' : w.name + ' won the round');
    $('round-sub').textContent = w.name + ' scored ' + w.gained +
      ' from the other hands.';
    $('round-scores').innerHTML = scoreTable(v);
    $('btn-next').textContent = over ? 'Back to the lobby' : 'Next round';
    $('btn-next').hidden = !v.isHost;
    $('round-hint').textContent = v.isHost ? '' : 'Waiting for the host…';
    openOverlay('overlay-round');
  }

  function flipAnimation() {
    document.body.classList.add('is-flipping');
    window.setTimeout(function () {
      document.body.classList.remove('is-flipping');
    }, 640);
  }

  function init(handlers) {
    on = handlers || {};
  }

  ns.view = {
    init: init,
    setScreen: setScreen,
    renderLobby: renderLobby,
    renderTable: renderTable,
    showColourPicker: showColourPicker,
    showChallenge: showChallenge,
    showRoundEnd: showRoundEnd,
    showScores: showScores,
    openOverlay: openOverlay,
    closeOverlay: closeOverlay,
    closeAllOverlays: closeAllOverlays,
    toast: toast,
    setConnected: setConnected,
    resetSide: function () { lastSide = null; }
  };
})(window.UNO = window.UNO || {});
