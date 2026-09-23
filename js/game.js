/* ==========================================================================
   game.js - the rules engine. Holds all state; knows nothing about the DOM.
   ========================================================================== */
(function (root, factory) {
  var ns = root.UNO || (root.UNO = {});
  factory(ns);
  if (typeof module === 'object' && module.exports) { module.exports = ns; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ns) {
  'use strict';

  var C = ns.cards;

  /* ------------------------------------------------------------------ init */

  // config.players is [{ id, name }] in seating order.
  function createGame(config) {
    var players = (config.players || []).map(function (p, i) {
      return {
        index: i,
        id: p.id,
        name: p.name,
        hand: [],
        score: p.score || 0,
        calledUno: false
      };
    });

    var g = {
      mode: config.mode || 'flip',
      target: config.target || 0,        // 0 = single round
      players: players,
      round: 0,

      side: 'light',
      drawPile: [],
      discardPile: [],
      currentColor: null,
      current: 0,
      direction: 1,                      // 1 = clockwise, -1 = anticlockwise

      phase: 'setup',                    // setup|turn|awaitColor|drawnDecision|
                                         // challenge|roundOver|gameOver
      pendingCardId: null,               // wild waiting for a colour
      starterWild: false,                // the turned-up starter is a Wild
      drawnCardId: null,                 // just-drawn card the player may still play
      challenge: null,                   // wild draw the victim may challenge
      deckDry: false,                    // a draw found no card anywhere
      unoPending: null,                  // { player, at } - can be caught
      lastWinner: null,
      log: []
    };

    /* ---------------------------------------------------------- utilities */

    function say(text, kind) {
      g.log.push({ text: text, kind: kind || 'info' });
      if (g.log.length > 120) { g.log.shift(); }
    }

    function topCard() {
      return g.discardPile[g.discardPile.length - 1];
    }

    function topFace() {
      return C.activeFace(topCard(), g.side);
    }

    function faceOf(card) {
      return C.activeFace(card, g.side);
    }

    function playerAt(steps) {
      var n = g.players.length;
      return ((g.current + g.direction * steps) % n + n) % n;
    }

    function advance(steps) {
      g.current = playerAt(steps);
    }

    function cardIn(hand, cardId) {
      for (var i = 0; i < hand.length; i++) {
        if (hand[i].id === cardId) { return i; }
      }
      return -1;
    }

    /* ------------------------------------------------------------- drawing */

    function replenish() {
      if (g.drawPile.length > 0) { return true; }
      if (g.discardPile.length <= 1) { return false; }
      var top = g.discardPile.pop();
      g.drawPile = C.shuffle(g.discardPile);
      g.discardPile = [top];
      say('The draw pile was empty - the discards were reshuffled.', 'info');
      return g.drawPile.length > 0;
    }

    function drawOne(playerIdx) {
      if (!replenish()) { g.deckDry = true; return null; }
      var card = g.drawPile.pop();
      g.players[playerIdx].hand.push(card);
      if (g.players[playerIdx].hand.length !== 1) {
        g.players[playerIdx].calledUno = false;
      }
      return card;
    }

    function drawMany(playerIdx, count) {
      var drawn = 0;
      for (var i = 0; i < count; i++) {
        if (drawOne(playerIdx)) { drawn++; }
      }
      return drawn;
    }

    // Dark-side Wild Draw Colour: keep drawing until the chosen colour appears.
    function drawUntilColor(playerIdx, color) {
      var drawn = 0;
      while (drawn < 40) {
        var card = drawOne(playerIdx);
        if (!card) { break; }
        drawn++;
        if (faceOf(card).color === color) { break; }
      }
      return drawn;
    }

    /* ---------------------------------------------------------- the round */

    function startRound() {
      g.round++;
      g.drawPile = C.buildDeck(g.mode);
      g.discardPile = [];
      g.side = 'light';
      g.direction = 1;
      g.pendingCardId = null;
      g.starterWild = false;
      g.drawnCardId = null;
      g.challenge = null;
      g.deckDry = false;
      g.unoPending = null;
      g.lastWinner = null;
      g.log = [];

      g.players.forEach(function (p) {
        p.hand = [];
        p.calledUno = false;
      });

      for (var deal = 0; deal < 7; deal++) {
        g.players.forEach(function (p) { p.hand.push(g.drawPile.pop()); });
      }

      // Turn over a starter card. A Wild Draw goes back and another is turned.
      var rejected = [];
      var starter = g.drawPile.pop();
      while (starter && C.activeFace(starter, 'light').type === 'wildDraw') {
        rejected.push(starter);
        starter = g.drawPile.pop();
      }
      g.drawPile = C.shuffle(g.drawPile.concat(rejected));
      g.discardPile = [starter];
      g.currentColor = C.activeFace(starter, 'light').color;

      g.current = 0;
      g.phase = 'turn';
      say('Round ' + g.round + ' - starting card is the ' +
          C.name(topFace()) + '.', 'info');
      starterEffect();
      return g;
    }

    // Official rule: an action card turned up as the starter acts on the
    // first player. Seat 0 plays first; the last seat is the dealer.
    function starterEffect() {
      var f = topFace();

      if (f.type === 'flip') {
        flipSides();
        f = topFace();
      }

      switch (f.type) {
        case 'wild':
        case 'wildDraw':                  // only reachable via a flip
          g.currentColor = null;
          g.starterWild = true;
          g.phase = 'awaitColor';
          say(g.players[0].name + ' chooses the starting colour.', 'info');
          break;

        case 'skip':
          say(g.players[0].name + ' is skipped by the starting card.', 'play');
          advance(1);
          break;

        case 'skipAll':
          say('Skip Everyone to start - ' + g.players[0].name + ' plays.', 'play');
          break;

        case 'reverse':
          g.direction = -1;
          g.current = g.players.length - 1;
          say('Reverse to start - the dealer, ' + g.players[g.current].name +
              ', plays first.', 'play');
          break;

        case 'draw':
          drawMany(0, f.draw);
          say(g.players[0].name + ' draws ' + f.draw +
              ' from the starting card and is skipped.', 'penalty');
          advance(1);
          break;
      }
    }

    /* -------------------------------------------------------- playability */

    function isPlayable(card) {
      return C.facePlayable(faceOf(card), topFace(), g.currentColor);
    }

    function playableCards(playerIdx) {
      return g.players[playerIdx].hand.filter(isPlayable);
    }

    /* -------------------------------------------------------- side flipping */

    function flipSides() {
      g.side = (g.side === 'light') ? 'dark' : 'light';
      g.drawPile.reverse();                 // the whole pile is turned over
      var nf = topFace();
      if (nf.color !== 'wild') { g.currentColor = nf.color; }
      say('FLIP! Everything turns over to the ' +
          (g.side === 'dark' ? 'Dark' : 'Light') + ' Side.', 'flip');
    }

    /* -------------------------------------------------------------- effects */

    function applyEffect(actor, f, chosenColor) {
      var steps = 1;
      var victim;

      switch (f.type) {
        case 'reverse':
          if (g.players.length === 2) {
            steps = 2;                       // with two players it is a Skip
            say(g.players[actor].name + ' reversed - ' +
                g.players[playerAt(1)].name + ' is skipped.', 'play');
          } else {
            g.direction *= -1;
            say('Direction reversed.', 'play');
          }
          break;

        case 'skip':
          victim = playerAt(1);
          say(g.players[victim].name + ' is skipped.', 'play');
          steps = 2;
          break;

        case 'skipAll':
          say('Everyone else is skipped - ' + g.players[actor].name +
              ' goes again.', 'play');
          steps = 0;
          break;

        case 'draw':
          victim = playerAt(1);
          drawMany(victim, f.draw);
          say(g.players[victim].name + ' draws ' + f.draw +
              ' and is skipped.', 'penalty');
          steps = 2;
          break;

        case 'wildDraw':
          wildDrawPenalty(playerAt(1), f, chosenColor, 0);
          say(g.players[playerAt(1)].name + ' is skipped.', 'penalty');
          steps = 2;
          break;

        case 'flip':
          flipSides();
          break;
      }

      return steps;
    }

    // Hand a Wild Draw penalty to one player, plus `extra` cards for a
    // failed challenge.
    function wildDrawPenalty(who, f, color, extra) {
      var n;
      if (f.drawMode === 'untilColor') {
        n = drawUntilColor(who, color);
        say(g.players[who].name + ' draws ' + n + ' looking for ' +
            C.COLOR_NAMES[color] + '.', 'penalty');
      } else {
        n = drawMany(who, f.draw);
        say(g.players[who].name + ' draws ' + n + '.', 'penalty');
      }
      if (extra) {
        drawMany(who, extra);
        say(g.players[who].name + ' draws ' + extra + ' more for the failed challenge.',
            'penalty');
      }
    }

    /* ------------------------------------------------------------ challenge */

    // Official rule: a Wild Draw may only be played while holding no other card
    // of the colour in play. Playing it anyway is a bluff the victim can call.
    function wildDrawLegal(playerIdx, card) {
      return !g.players[playerIdx].hand.some(function (other) {
        return other.id !== card.id && faceOf(other).color === g.currentColor;
      });
    }

    // The victim of a Wild Draw either takes it or challenges it.
    //   guilty   -> the player who played it takes the penalty instead, and
    //               the challenger plays normally
    //   innocent -> the challenger takes the penalty plus two, and is skipped
    function respondToWildDraw(challenge) {
      var res = resolveWildDraw(challenge);
      if (res.ok && g.deckDry) {
        endDryRound();
        res.roundOver = true;
      }
      return res;
    }

    function resolveWildDraw(challenge) {
      if (g.phase !== 'challenge' || !g.challenge) { return { ok: false }; }
      var ch = g.challenge;
      var victim = g.current;
      var victimName = g.players[victim].name;
      var actorName = g.players[ch.actor].name;
      g.challenge = null;
      closeUnoWindow(victim);

      if (!challenge) {
        say(victimName + ' takes the ' + C.name(ch.face) + '.', 'info');
        wildDrawPenalty(victim, ch.face, ch.color, 0);
        advance(1);
        g.phase = 'turn';
        return { ok: true };
      }

      say(victimName + ' challenges ' + actorName + '!', 'play');
      if (!ch.legal) {
        say(actorName + ' was bluffing and takes the penalty.', 'win');
        wildDrawPenalty(ch.actor, ch.face, ch.color, 0);
        g.phase = 'turn';
        return { ok: true, guilty: true };
      }
      say(actorName + ' played it fairly.', 'info');
      wildDrawPenalty(victim, ch.face, ch.color, 2);
      advance(1);
      g.phase = 'turn';
      return { ok: true, guilty: false };
    }

    function handPoints(p) {
      return p.hand.reduce(function (n, card) { return n + C.points(faceOf(card)); }, 0);
    }

    // Every card but the top discard is in someone's hand, so the round can
    // loop forever. It ends there and the lightest hand takes it.
    function endDryRound() {
      say('The deck has run dry - the lowest hand wins the round.', 'info');
      g.challenge = null;
      g.unoPending = null;
      endRound(lightestHand());
    }

    function lightestHand() {
      var best = 0;
      g.players.forEach(function (p, i) {
        if (handPoints(p) < handPoints(g.players[best])) { best = i; }
      });
      return best;
    }

    /* ---------------------------------------------------------- scoring */

    function endRound(winnerIdx) {
      var gained = 0;
      g.players.forEach(function (p) {
        if (p.index === winnerIdx) { return; }
        p.hand.forEach(function (card) { gained += C.points(faceOf(card)); });
      });
      g.players[winnerIdx].score += gained;
      g.lastWinner = { index: winnerIdx, gained: gained };

      say(g.players[winnerIdx].name + ' went out and scored ' + gained +
          ' points.', 'win');

      var done = (g.target === 0) ||
                 (g.players[winnerIdx].score >= g.target);
      g.phase = done ? 'gameOver' : 'roundOver';
    }

    /* ------------------------------------------------------- public actions */

    // Play a card from the current player. Wild cards need chosenColor; if it
    // is missing the game parks in the awaitColor phase.
    function playCard(cardId, chosenColor) {
      if (g.phase !== 'turn' && g.phase !== 'drawnDecision') {
        return { ok: false, reason: 'not your turn' };
      }

      var actor = g.current;
      var hand = g.players[actor].hand;
      var idx = cardIn(hand, cardId);
      if (idx < 0) { return { ok: false, reason: 'card not in hand' }; }

      var card = hand[idx];
      if (!isPlayable(card)) { return { ok: false, reason: 'card does not match' }; }

      var f = faceOf(card);

      if (C.isWild(f) && C.colorsFor(g.side).indexOf(chosenColor) < 0) {
        g.pendingCardId = cardId;
        g.phase = 'awaitColor';
        return { ok: true, needsColor: true };
      }

      // Judged against the colour in play before this card changes it.
      var legal = f.type === 'wildDraw' ? wildDrawLegal(actor, card) : true;

      // Commit the play.
      closeUnoWindow(actor);
      hand.splice(idx, 1);
      g.discardPile.push(card);
      g.drawnCardId = null;
      g.pendingCardId = null;

      g.currentColor = C.isWild(f) ? chosenColor : f.color;

      say(g.players[actor].name + ' played ' + C.name(f) +
          (C.isWild(f) ? ' and chose ' + C.COLOR_NAMES[chosenColor] : '') +
          '.', 'play');

      if (hand.length === 1 && !g.players[actor].calledUno) {
        g.unoPending = { player: actor, at: Date.now() };
      }

      // A Wild Draw waits for its victim to take it or challenge it - unless
      // it was the last card, when the round is over and it simply applies.
      if (f.type === 'wildDraw' && hand.length > 0) {
        g.challenge = { actor: actor, face: f, color: chosenColor, legal: legal };
        advance(1);
        g.phase = 'challenge';
        say(g.players[g.current].name + ' can take it or challenge.', 'info');
        return { ok: true, challenge: true };
      }

      // Going out ends the round, after the card has had its effect.
      var steps = applyEffect(actor, f, chosenColor);

      if (hand.length === 0) {
        endRound(actor);
        return { ok: true, roundOver: true };
      }
      if (g.deckDry) {
        endDryRound();
        return { ok: true, roundOver: true };
      }

      advance(steps);
      g.phase = 'turn';
      return { ok: true };
    }

    // Resolve a parked wild card.
    function chooseColor(color) {
      if (g.phase !== 'awaitColor') { return { ok: false }; }
      if (C.colorsFor(g.side).indexOf(color) < 0) { return { ok: false }; }

      if (g.starterWild) {
        g.starterWild = false;
        g.currentColor = color;
        g.phase = 'turn';
        say(g.players[g.current].name + ' chose ' + C.COLOR_NAMES[color] +
            ' to start.', 'play');
        return { ok: true };
      }

      if (!g.pendingCardId) { return { ok: false }; }
      var cardId = g.pendingCardId;
      g.phase = 'turn';
      g.pendingCardId = null;
      return playCard(cardId, color);
    }

    // Current player takes a card from the pile.
    function drawFromPile() {
      if (g.phase !== 'turn') { return { ok: false }; }

      var actor = g.current;
      closeUnoWindow(actor);
      var card = drawOne(actor);
      if (!card) {
        endDryRound();
        return { ok: true, roundOver: true };
      }

      say(g.players[actor].name + ' drew a card.', 'draw');

      if (isPlayable(card)) {
        g.drawnCardId = card.id;
        g.phase = 'drawnDecision';
        return { ok: true, playable: true, card: card };
      }

      advance(1);
      return { ok: true, playable: false, card: card };
    }

    // Decline to play the card that was just drawn.
    function passAfterDraw() {
      if (g.phase !== 'drawnDecision') { return { ok: false }; }
      closeUnoWindow(g.current);
      say(g.players[g.current].name + ' passed.', 'info');
      g.drawnCardId = null;
      g.phase = 'turn';
      advance(1);
      return { ok: true };
    }

    /* ------------------------------------------------------------- the call */

    function callUno(playerIdx) {
      var p = g.players[playerIdx];
      if (p.hand.length > 2) { return { ok: false }; }
      p.calledUno = true;
      if (g.unoPending && g.unoPending.player === playerIdx) {
        g.unoPending = null;
      }
      say(p.name + ' called UNO!', 'win');
      return { ok: true };
    }

    // Official rule: someone who forgot to call UNO can be caught by any
    // other player until the next player starts their turn.
    function catchUno(byIdx) {
      if (!g.unoPending) { return null; }
      var idx = g.unoPending.player;
      if (byIdx === idx) { return null; }
      g.unoPending = null;
      if (g.players[idx].hand.length !== 1 || g.players[idx].calledUno) {
        return null;
      }
      drawMany(idx, 2);
      say((byIdx != null ? g.players[byIdx].name + ' caught ' : '') +
          g.players[idx].name + (byIdx != null ? ' - ' : ' ') +
          'forgot to call UNO and draws 2.', 'penalty');
      return idx;
    }

    // The next player acting closes the window for catching everyone else.
    function closeUnoWindow(actor) {
      if (g.unoPending && g.unoPending.player !== actor) { g.unoPending = null; }
    }

    /* ---------------------------------------------------------------- next */

    function nextRound() {
      if (g.phase !== 'roundOver') { return g; }
      return startRound();
    }

    /* --------------------------------------------------------------- expose */

    g.startRound   = startRound;
    g.nextRound    = nextRound;
    g.topCard      = topCard;
    g.topFace      = topFace;
    g.faceOf       = faceOf;
    g.isPlayable   = isPlayable;
    g.playableCards = playableCards;
    g.playCard     = playCard;
    g.chooseColor  = chooseColor;
    g.drawFromPile = drawFromPile;
    g.passAfterDraw = passAfterDraw;
    g.callUno      = callUno;
    g.catchUno     = catchUno;
    g.wildDrawLegal = wildDrawLegal;
    g.respondToWildDraw = respondToWildDraw;
    g.playerAt     = playerAt;

    return g;
  }

  ns.createGame = createGame;
}));
