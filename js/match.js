/* ==========================================================================
   match.js - a table: seats, bots, timers and per-player views.

   Runs unchanged on the server (authoritative, one match per room) and in the
   browser (offline play against bots). It owns the engine in game.js and is
   the only thing that ever sees every hand.
   ========================================================================== */
(function (root, factory) {
  var ns = root.UNO || (root.UNO = {});
  factory(ns);
  if (typeof module === 'object' && module.exports) { module.exports = ns; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ns) {
  'use strict';

  var C = ns.cards;

  var BOT_NAMES = ['Ruby', 'Milo', 'Sage', 'Nova', 'Otto', 'Wren', 'Pip'];

  var DEFAULTS = {
    botDelay: 950,      // how long a bot pauses before moving
    unoGrace: 3500,     // latest a bot will wait before catching a missed UNO
    offlineGrace: 6000, // how long a dropped player is waited for
    maxSeats: 6
  };

  function createMatch(opts) {
    opts = opts || {};

    var m = {
      code: opts.code || null,
      mode: opts.mode || 'flip',
      target: opts.target || 0,
      phase: 'lobby',                 // lobby | playing | roundOver | gameOver
      seats: [],                      // { id, name, kind, online, score }
      hostId: null,
      game: null,
      roundNo: 0,
      createdAt: Date.now()
    };

    var cfg = {
      botDelay: opts.botDelay || DEFAULTS.botDelay,
      unoGrace: opts.unoGrace || DEFAULTS.unoGrace,
      offlineGrace: opts.offlineGrace || DEFAULTS.offlineGrace
    };

    var onUpdate = opts.onUpdate || function () {};
    var turnTimer = null;
    var unoTimer = null;
    var catchPlan = null;   // { at, delay } - when a bot will catch a missed UNO

    /* -------------------------------------------------------------- seats */

    function seatOf(id) {
      for (var i = 0; i < m.seats.length; i++) {
        if (m.seats[i].id === id) { return m.seats[i]; }
      }
      return null;
    }

    function seatIndex(id) {
      for (var i = 0; i < m.seats.length; i++) {
        if (m.seats[i].id === id) { return i; }
      }
      return -1;
    }

    function nextBotName() {
      var used = m.seats.map(function (s) { return s.name; });
      for (var i = 0; i < BOT_NAMES.length; i++) {
        if (used.indexOf(BOT_NAMES[i]) < 0) { return BOT_NAMES[i]; }
      }
      return 'Bot ' + (m.seats.length + 1);
    }

    function uniqueName(name) {
      var base = (name || 'Player').trim().slice(0, 14) || 'Player';
      var candidate = base;
      var n = 2;
      while (m.seats.some(function (s) { return s.name === candidate; })) {
        candidate = base + ' ' + n++;
      }
      return candidate;
    }

    function addSeat(seat) {
      if (m.seats.length >= DEFAULTS.maxSeats) {
        return { ok: false, error: 'The table is full.' };
      }
      if (m.phase === 'playing') {
        return { ok: false, error: 'Wait for the round to finish.' };
      }
      var entry = {
        id: seat.id,
        name: seat.kind === 'bot' ? nextBotName() : uniqueName(seat.name),
        kind: seat.kind || 'human',
        online: seat.kind !== 'bot',
        score: 0
      };
      m.seats.push(entry);
      if (!m.hostId && entry.kind === 'human') { m.hostId = entry.id; }
      touch('seat');
      return { ok: true, seat: entry };
    }

    function removeSeat(id) {
      var i = seatIndex(id);
      if (i < 0) { return { ok: false }; }
      m.seats.splice(i, 1);
      if (m.hostId === id) {
        var nextHost = m.seats.filter(function (s) { return s.kind === 'human'; })[0];
        m.hostId = nextHost ? nextHost.id : null;
      }
      if (m.phase === 'playing' && m.seats.filter(isLive).length < 2) {
        m.phase = 'lobby';
        m.game = null;
      }
      touch('seat');
      return { ok: true };
    }

    function setOnline(id, online) {
      var s = seatOf(id);
      if (!s) { return; }
      s.online = online;
      touch('presence');
    }

    function isLive(s) { return s.kind === 'bot' || s.online; }

    // A seat the match should play automatically: a bot, or a human who has
    // dropped out and whose grace period is over.
    function isAutoPlayed(seat) {
      return seat && (seat.kind === 'bot' || !seat.online);
    }

    function setOptions(o) {
      if (m.phase === 'playing') { return { ok: false, error: 'Round in progress.' }; }
      if (o.mode) { m.mode = o.mode; }
      if (typeof o.target === 'number') { m.target = o.target; }
      touch('options');
      return { ok: true };
    }

    /* ------------------------------------------------------------ rounds */

    function start() {
      if (m.seats.length < 2) {
        return { ok: false, error: 'You need at least two players.' };
      }
      m.game = ns.createGame({
        mode: m.mode,
        target: m.target,
        players: m.seats.map(function (s) { return { id: s.id, name: s.name, score: s.score }; })
      });
      m.roundNo = 1;
      m.game.startRound();
      m.game.round = m.roundNo;
      m.phase = 'playing';
      touch('start');
      return { ok: true };
    }

    function nextRound() {
      if (m.phase !== 'roundOver') { return { ok: false }; }
      // Seats may have changed between rounds - rebuild, carrying the scores.
      m.game = ns.createGame({
        mode: m.mode,
        target: m.target,
        players: m.seats.map(function (s) { return { id: s.id, name: s.name, score: s.score }; })
      });
      m.roundNo++;
      m.game.startRound();
      m.game.round = m.roundNo;
      m.phase = 'playing';
      touch('start');
      return { ok: true };
    }

    function syncScores() {
      if (!m.game) { return; }
      m.game.players.forEach(function (p) {
        var s = seatOf(p.id);
        if (s) { s.score = p.score; }
      });
    }

    /* ------------------------------------------------------------ actions */

    // act: { type: 'play'|'draw'|'pass'|'color'|'uno'|'next', cardId, color }
    function action(playerId, act) {
      var seat = seatOf(playerId);
      if (!seat) { return { ok: false, error: 'You are not at this table.' }; }

      if (act.type === 'next') {
        if (playerId !== m.hostId) { return { ok: false, error: 'Only the host can deal.' }; }
        if (m.phase === 'gameOver') {
          m.phase = 'lobby';
          m.game = null;
          m.roundNo = 0;
          m.seats.forEach(function (s) { s.score = 0; });
          touch('reset');
          return { ok: true };
        }
        return nextRound();
      }

      if (m.phase !== 'playing' || !m.game) {
        return { ok: false, error: 'The round is not running.' };
      }

      var g = m.game;
      var idx = seatIndex(playerId);

      if (act.type === 'uno') {
        var res = g.callUno(idx);
        if (res.ok) { touch('uno'); }
        return res;
      }

      // Anyone may catch a missed UNO, whoever's turn it is.
      if (act.type === 'catch') {
        if (!g.unoPending || g.unoPending.player === idx) {
          return { ok: false, error: 'There is nobody to catch.' };
        }
        if (g.catchUno(idx) === null) {
          touch('uno');
          return { ok: false, error: 'Too late - they already called UNO.' };
        }
        touch('caught');
        return { ok: true };
      }

      if (g.current !== idx) { return { ok: false, error: 'It is not your turn.' }; }

      var result;
      switch (act.type) {
        case 'play':  result = g.playCard(act.cardId, act.color); break;
        case 'color': result = g.chooseColor(act.color); break;
        case 'draw':  result = g.drawFromPile(); break;
        case 'pass':  result = g.passAfterDraw(); break;
        case 'accept':    result = g.respondToWildDraw(false); break;
        case 'challenge': result = g.respondToWildDraw(true); break;
        default:      return { ok: false, error: 'Unknown action.' };
      }

      if (!result.ok) {
        return { ok: false, error: result.reason || 'That move is not allowed.' };
      }

      afterMove(idx);
      return result;
    }

    // Shared tail for both human and bot moves.
    function afterMove(idx) {
      var g = m.game;
      var seat = m.seats[idx];

      // Bots and auto-played seats shout UNO for themselves.
      if (seat && isAutoPlayed(seat) &&
          g.players[idx] && g.players[idx].hand.length === 1 &&
          ns.ai.remembersUno()) {
        g.callUno(idx);
      }

      if (g.phase === 'roundOver' || g.phase === 'gameOver') {
        syncScores();
        m.phase = (g.phase === 'gameOver') ? 'gameOver' : 'roundOver';
      }

      touch('move');
    }

    /* ------------------------------------------------------------- timers */

    function clearTimers() {
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
      if (unoTimer) { clearTimeout(unoTimer); unoTimer = null; }
    }

    function scheduleWork() {
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
      if (unoTimer) { clearTimeout(unoTimer); unoTimer = null; }

      if (m.phase !== 'playing' || !m.game) { return; }
      var g = m.game;

      // A missed UNO: a bot at the table catches it after a human-like pause.
      // Humans get the same window to hit Catch first.
      var catcher = g.unoPending ? botCatcher(g.unoPending.player) : -1;
      if (catcher >= 0) {
        if (!catchPlan || catchPlan.at !== g.unoPending.at) {
          catchPlan = {
            at: g.unoPending.at,
            delay: cfg.unoGrace * (0.45 + Math.random() * 0.55)
          };
        }
        var left = Math.max(0, catchPlan.delay - (Date.now() - g.unoPending.at));
        unoTimer = setTimeout(function () {
          unoTimer = null;
          if (m.game === g && g.unoPending && g.catchUno(catcher) !== null) {
            touch('caught');
          }
        }, left);
      }

      var seat = m.seats[g.current];
      if (isAutoPlayed(seat)) {
        var delay = seat.kind === 'bot' ? cfg.botDelay : cfg.offlineGrace;
        // A bot moving on closes the catch window - leave people time to shout.
        if (g.unoPending) { delay += cfg.botDelay * 1.5; }
        turnTimer = setTimeout(function () {
          turnTimer = null;
          if (m.game === g && m.phase === 'playing') { botMove(); }
        }, delay);
      }
    }

    // Any bot other than the one who forgot, or -1.
    function botCatcher(forgot) {
      var bots = [];
      m.seats.forEach(function (s, i) {
        if (s.kind === 'bot' && i !== forgot) { bots.push(i); }
      });
      return bots.length ? bots[Math.floor(Math.random() * bots.length)] : -1;
    }

    function botMove() {
      var g = m.game;
      var idx = g.current;

      if (g.phase === 'awaitColor') {
        g.chooseColor(ns.ai.bestColor(g, idx));
        afterMove(idx);
        return;
      }

      if (g.phase === 'challenge') {
        g.respondToWildDraw(ns.ai.decideChallenge(g, idx));
        afterMove(idx);
        return;
      }

      if (g.phase === 'drawnDecision') {
        var drawn = g.players[idx].hand.filter(function (c) { return c.id === g.drawnCardId; })[0];
        var pick = drawn ? ns.ai.decideDrawn(g, idx, drawn) : { action: 'pass' };
        if (pick.action === 'play') {
          g.playCard(pick.cardId, pick.color);
        } else {
          g.passAfterDraw();
        }
        afterMove(idx);
        return;
      }

      var move = ns.ai.chooseMove(g, idx);
      if (move.action === 'play') {
        g.playCard(move.cardId, move.color);
        afterMove(idx);
        return;
      }

      var res = g.drawFromPile();
      if (res.playable) {
        // Pause again before playing the card that was just drawn.
        touch('draw');
        return;
      }
      afterMove(idx);
    }

    function touch(reason) {
      scheduleWork();
      onUpdate(reason);
    }

    /* -------------------------------------------------------------- views */

    function publicSeat(seat, i) {
      var g = m.game;
      var p = g ? g.players[i] : null;
      var row = {
        id: seat.id,
        name: seat.name,
        kind: seat.kind,
        online: seat.online,
        isHost: seat.id === m.hostId,
        score: p ? p.score : seat.score,
        count: p ? p.hand.length : 0,
        calledUno: p ? p.calledUno : false,
        isTurn: !!(g && m.phase === 'playing' && g.current === i)
      };

      return row;
    }

    function view(playerId) {
      var idx = seatIndex(playerId);
      var g = m.game;

      var v = {
        code: m.code,
        phase: m.phase,
        mode: m.mode,
        target: m.target,
        hostId: m.hostId,
        youId: playerId,
        isHost: playerId === m.hostId,
        seated: idx >= 0,
        players: m.seats.map(publicSeat),
        maxSeats: DEFAULTS.maxSeats
      };

      if (!g) { return v; }

      var myTurn = (m.phase === 'playing' && g.current === idx);

      v.round = g.round;
      v.side = g.side;
      v.direction = g.direction;
      v.currentColor = g.currentColor;
      v.currentId = m.seats[g.current] ? m.seats[g.current].id : null;
      v.turnPhase = g.phase;
      v.drawCount = g.drawPile.length;
      v.discardCount = g.discardPile.length;
      v.discardTop = g.discardPile.length ? g.topFace() : null;
      v.log = g.log.slice(-40);

      v.awaitingColor = myTurn && g.phase === 'awaitColor';
      v.colorChoices = C.colorsFor(g.side);
      v.canDraw = myTurn && g.phase === 'turn';
      v.canPass = myTurn && g.phase === 'drawnDecision';
      v.drawnCardId = myTurn ? g.drawnCardId : null;
      v.unoPending = g.unoPending ? g.unoPending.player : null;
      v.canCatch = !!(g.unoPending && idx >= 0 && g.unoPending.player !== idx &&
        m.phase === 'playing');
      v.catchName = g.unoPending ? g.players[g.unoPending.player].name : null;

      if (g.phase === 'challenge' && g.challenge) {
        v.challenge = {
          byId: m.seats[g.challenge.actor] ? m.seats[g.challenge.actor].id : null,
          byName: g.players[g.challenge.actor].name,
          victimName: g.players[g.current].name,
          card: C.name(g.challenge.face),
          color: g.challenge.color,
          draw: g.challenge.face.drawMode === 'untilColor' ? null : g.challenge.face.draw
        };
      }
      v.canRespond = myTurn && g.phase === 'challenge';

      if (idx >= 0) {
        var me = g.players[idx];
        v.you = {
          id: playerId,
          name: m.seats[idx].name,
          score: me.score,
          calledUno: me.calledUno,
          isTurn: myTurn,
          canCallUno: me.hand.length <= 2 && !me.calledUno,
          hand: me.hand.map(function (card) {
            var playable = myTurn && g.isPlayable(card) &&
              (g.phase === 'turn' ||
               (g.phase === 'drawnDecision' && card.id === g.drawnCardId));
            return {
              id: card.id,
              face: C.activeFace(card, g.side),
              playable: playable
            };
          })
        };
      }

      if (g.lastWinner) {
        v.lastWinner = {
          id: m.seats[g.lastWinner.index] ? m.seats[g.lastWinner.index].id : null,
          name: g.players[g.lastWinner.index].name,
          gained: g.lastWinner.gained
        };
      }

      return v;
    }

    /* -------------------------------------------------------------- expose */

    m.addSeat = addSeat;
    m.removeSeat = removeSeat;
    m.setOnline = setOnline;
    m.setOptions = setOptions;
    m.seatOf = seatOf;
    m.seatIndex = seatIndex;
    m.start = start;
    m.action = action;
    m.view = view;
    m.clearTimers = clearTimers;
    m.humanCount = function () {
      return m.seats.filter(function (s) { return s.kind === 'human'; }).length;
    };
    m.onlineCount = function () {
      return m.seats.filter(function (s) { return s.kind === 'human' && s.online; }).length;
    };

    return m;
  }

  ns.createMatch = createMatch;
  ns.BOT_NAMES = BOT_NAMES;
}));
