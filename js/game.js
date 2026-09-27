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
        calledUno: false,
        place: 0,                        // 1, 2, ... once out of cards
        knocked: false                   // No Mercy: out on 25 cards
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
      finishOrder: [],                   // indices, in the order they went out
      loser: null,                       // the one left holding cards
      stack: null,                       // No Mercy: { total, min } owed by current
      setAside: [],                      // No Mercy: hands of knocked-out players
      log: []
    };

    var noMercy = g.mode === 'nomercy';
    var MERCY_LIMIT = 25;
    var KNOCKOUT_BONUS = 250;

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

    // Players who have gone out are stepped over.
    function playerAt(steps) {
      var n = g.players.length;
      var i = g.current;
      for (var k = 0; k < steps; k++) {
        do {
          i = ((i + g.direction) % n + n) % n;
        } while (!isIn(g.players[i]) && i !== g.current);
      }
      return i;
    }

    function isIn(p) { return !p.place && !p.knocked; }

    function activeCount() {
      return g.players.filter(isIn).length;
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
      if (g.discardPile.length <= 1 && g.setAside.length === 0) { return false; }
      var top = g.discardPile.pop();
      // No Mercy: knocked-out hands come back in when the deck is rebuilt.
      g.drawPile = C.shuffle(g.discardPile.concat(g.setAside));
      g.setAside = [];
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
      g.finishOrder = [];
      g.loser = null;
      g.stack = null;
      g.setAside = [];
      g.log = [];

      g.players.forEach(function (p) {
        p.hand = [];
        p.calledUno = false;
        p.place = 0;
        p.knocked = false;
      });

      for (var deal = 0; deal < 7; deal++) {
        g.players.forEach(function (p) { p.hand.push(g.drawPile.pop()); });
      }

      // Turn over a starter card. A Wild Draw goes back and another is turned;
      // No Mercy turns past every action card.
      var rejected = [];
      var starter = g.drawPile.pop();
      while (starter && (noMercy
          ? C.activeFace(starter, 'light').type !== 'number'
          : C.activeFace(starter, 'light').type === 'wildDraw')) {
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
      if (!noMercy) { starterEffect(); }
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

    // While a No Mercy penalty is owed, only a draw card worth at least the
    // last one may be stacked on it, whatever its colour.
    function isPlayable(card) {
      var f = faceOf(card);
      if (g.stack) { return C.isDrawCard(f) && f.draw >= g.stack.min; }
      return C.facePlayable(f, topFace(), g.currentColor);
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
          if (activeCount() === 2) {
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
    // loop forever. It ends there: the players still in are placed by hand,
    // lightest first, and the heaviest hand loses.
    function endDryRound() {
      say('The deck has run dry - the lowest hand places highest.', 'info');
      g.challenge = null;
      g.unoPending = null;
      g.stack = null;
      var left = [];
      g.players.forEach(function (p, i) { if (isIn(p)) { left.push(i); } });
      left.sort(function (a, b) {
        return handPoints(g.players[a]) - handPoints(g.players[b]);
      });
      if (noMercy) { winNoMercy(left[0]); return; }
      for (var k = 0; k < left.length - 1; k++) { finish(left[k]); }
      endRound();
    }

    /* ---------------------------------------------------------- scoring */

    // House rule: the round goes on after someone goes out, until a single
    // player is left holding cards - that player loses. Only the first one
    // out scores, taking every hand as it stood at that moment.
    function finish(idx) {
      var p = g.players[idx];
      g.finishOrder.push(idx);
      p.place = g.finishOrder.length;
      p.calledUno = false;
      if (g.unoPending && g.unoPending.player === idx) { g.unoPending = null; }

      if (p.place === 1) {
        var gained = 0;
        g.players.forEach(function (o) {
          if (o.index !== idx) { gained += handPoints(o); }
        });
        p.score += gained;
        g.lastWinner = { index: idx, gained: gained };
        say(p.name + ' went out first and scored ' + gained + ' points.', 'win');
      } else {
        say(p.name + ' went out in place ' + p.place + '.', 'win');
      }
    }

    function endRound() {
      g.players.forEach(function (p, i) {
        if (!p.place) { g.loser = i; }
      });
      if (g.loser !== null) {
        g.players[g.loser].place = g.players.length;
        say(g.players[g.loser].name + ' is left holding cards and loses the round.',
            'penalty');
      }

      var w = g.lastWinner ? g.players[g.lastWinner.index] : null;
      var done = (g.target === 0) || (w && w.score >= g.target);
      g.phase = done ? 'gameOver' : 'roundOver';
    }

    /* ------------------------------------------------------------ No Mercy */

    // Official rules (UNO Show 'Em No Mercy, Mattel HWV18). The first player
    // out wins the hand outright, as does the last player not knocked out.
    // The winner scores the hands still in play plus 250 per knockout.
    function winNoMercy(idx) {
      var p = g.players[idx];
      var knocked = 0;
      var gained = 0;
      g.players.forEach(function (o) {
        if (o.index === idx) { return; }
        if (o.knocked) { knocked++; } else { gained += handPoints(o); }
      });
      gained += knocked * KNOCKOUT_BONUS;
      p.score += gained;
      p.place = 1;
      g.finishOrder = [idx];
      g.lastWinner = { index: idx, gained: gained };
      g.stack = null;
      g.unoPending = null;
      g.drawnCardId = null;
      g.pendingCardId = null;
      say(p.name + ' wins the hand and scores ' + gained + ' points' +
          (knocked ? ' (' + knocked + ' knocked out).' : '.'), 'win');
      var done = (g.target === 0) || (p.score >= g.target);
      g.phase = done ? 'gameOver' : 'roundOver';
    }

    // Mercy rule: 25 cards or more and you are out of the game. The hand is
    // set aside until the deck is next rebuilt.
    function knockOut(idx) {
      var p = g.players[idx];
      say(p.name + ' has ' + p.hand.length + ' cards and is knocked out!', 'penalty');
      g.setAside = g.setAside.concat(p.hand);
      p.hand = [];
      p.knocked = true;
      p.calledUno = false;
      if (g.unoPending && g.unoPending.player === idx) { g.unoPending = null; }
    }

    // Runs after every No Mercy move: knock out full hands, crown a last
    // survivor, and move the turn on if its owner has just been knocked out.
    function settle() {
      if (!noMercy || g.phase === 'roundOver' || g.phase === 'gameOver') { return; }
      g.players.forEach(function (p, i) {
        if (isIn(p) && p.hand.length >= MERCY_LIMIT) { knockOut(i); }
      });
      var left = [];
      g.players.forEach(function (p, i) { if (isIn(p)) { left.push(i); } });
      if (left.length === 1) { winNoMercy(left[0]); return; }
      if (!isIn(g.players[g.current])) {
        g.current = playerAt(1);
        g.stack = null;
        g.drawnCardId = null;
        g.pendingCardId = null;
        g.phase = 'turn';
      }
    }

    // 0's Pass: every hand still in play moves on one seat, in the current
    // direction of play.
    function passHands() {
      var n = g.players.length;
      var order = [];
      var i = g.current;
      do {
        if (isIn(g.players[i])) { order.push(i); }
        i = ((i + g.direction) % n + n) % n;
      } while (i !== g.current);
      var hands = order.map(function (k) { return g.players[k].hand; });
      order.forEach(function (k, j) {
        g.players[order[(j + 1) % order.length]].hand = hands[j];
        g.players[k].calledUno = false;
      });
      say('Everyone passes their hand on.', 'play');
    }

    function swapHands(a, b) {
      var tmp = g.players[a].hand;
      g.players[a].hand = g.players[b].hand;
      g.players[b].hand = tmp;
      g.players[a].calledUno = false;
      g.players[b].calledUno = false;
      say(g.players[a].name + ' swaps hands with ' + g.players[b].name + '.', 'play');
    }

    // The effect of a No Mercy card that did not end the hand. Leaves the
    // turn and phase set for whoever acts next.
    function noMercyEffect(actor, f) {
      g.phase = 'turn';
      switch (f.type) {
        case 'number':
          if (f.value === 7) {
            var others = [];
            g.players.forEach(function (p, i) {
              if (i !== actor && isIn(p)) { others.push(i); }
            });
            if (others.length > 1) {
              g.phase = 'awaitSwap';             // the actor picks who
              return { ok: true, needsSwap: true };
            }
            swapHands(actor, others[0]);
          } else if (f.value === 0) {
            passHands();
          }
          advance(1);
          break;

        case 'skip':
          say(g.players[playerAt(1)].name + ' is skipped.', 'play');
          advance(2);
          break;

        case 'skipAll':
          say('Everyone else is skipped - ' + g.players[actor].name +
              ' goes again.', 'play');
          break;

        case 'reverse':
          if (activeCount() === 2) {
            say(g.players[actor].name + ' reversed - ' +
                g.players[playerAt(1)].name + ' is skipped.', 'play');
          } else {
            g.direction *= -1;
            say('Direction reversed.', 'play');
            advance(1);
          }
          break;

        case 'discardAll':
          advance(1);
          break;

        case 'roulette':
          advance(1);
          g.phase = 'rouletteColor';
          say(g.players[g.current].name + ' picks a colour for the roulette.', 'info');
          break;

        case 'draw':
        case 'wildDraw':
        case 'wildReverseDraw':
          var total = (g.stack ? g.stack.total : 0) + f.draw;
          g.stack = { total: total, min: f.draw };
          if (f.type === 'wildReverseDraw') {
            g.direction *= -1;
            // With two players it skips the other and the penalty comes
            // straight back - stack it again or take it.
            if (activeCount() !== 2) { advance(1); }
          } else {
            advance(1);
          }
          say(g.players[g.current].name + ' must stack a +' + f.draw +
              ' or better, or draw ' + total + '.', 'penalty');
          break;
      }
      return { ok: true };
    }

    // 7's Swap: the player who played the 7 names who to swap with.
    function swapWith(targetIdx) {
      if (g.phase !== 'awaitSwap') { return { ok: false }; }
      var t = g.players[targetIdx];
      if (!t || targetIdx === g.current || !isIn(t)) {
        return { ok: false, reason: 'pick another player who is still in' };
      }
      swapHands(g.current, targetIdx);
      g.phase = 'turn';
      advance(1);
      settle();
      return { ok: true };
    }

    // Colour Roulette: its victim names a colour, then turns cards until one
    // of that colour shows (wilds do not count), keeps them all and is skipped.
    function spinRoulette(color) {
      var victim = g.current;
      var n = drawUntilColor(victim, color);
      g.currentColor = color;
      say(g.players[victim].name + ' chose ' + C.COLOR_NAMES[color] + ' and drew ' +
          n + ' before one showed up.', 'penalty');
      g.phase = 'turn';
      if (g.deckDry) { endDryRound(); return { ok: true, roundOver: true }; }
      advance(1);
      settle();
      return { ok: true };
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
      // No Mercy: the card you drew is the one you must play.
      if (noMercy && g.phase === 'drawnDecision' && cardId !== g.drawnCardId) {
        return { ok: false, reason: 'play the card you drew' };
      }

      var f = faceOf(card);

      if (C.needsColor(f) && C.colorsFor(g.side).indexOf(chosenColor) < 0) {
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

      // Roulette leaves the colour open until its victim names one.
      g.currentColor = C.needsColor(f) ? chosenColor : (C.isWild(f) ? null : f.color);

      say(g.players[actor].name + ' played ' + C.name(f) +
          (C.needsColor(f) ? ' and chose ' + C.COLOR_NAMES[chosenColor] : '') +
          '.', 'play');

      // Discard All takes every other card of its colour with it, tucked
      // under it on the pile.
      if (f.type === 'discardAll') {
        var gone = hand.filter(function (c) { return faceOf(c).color === f.color; });
        var keep = hand.filter(function (c) { return faceOf(c).color !== f.color; });
        hand.length = 0;
        keep.forEach(function (c) { hand.push(c); });
        var under = g.discardPile.pop();
        g.discardPile = g.discardPile.concat(gone, [under]);
        if (gone.length) {
          say(g.players[actor].name + ' discards ' + gone.length + ' more ' +
              C.COLOR_NAMES[f.color] + '.', 'play');
        }
      }

      if (hand.length === 1 && !g.players[actor].calledUno) {
        g.unoPending = { player: actor, at: Date.now() };
      }

      if (noMercy) {
        if (hand.length === 0) {
          // Going out wins at once. A last draw card still lands, stacked
          // penalty and all, so it counts in the score.
          if (C.isDrawCard(f)) {
            var victim = playerAt(1);
            drawMany(victim, (g.stack ? g.stack.total : 0) + f.draw);
            g.stack = null;
            if (g.players[victim].hand.length >= MERCY_LIMIT) { knockOut(victim); }
          }
          winNoMercy(actor);
          return { ok: true, roundOver: true };
        }
        var nm = noMercyEffect(actor, f);
        settle();
        return nm;
      }

      // A Wild Draw waits for its victim to take it or challenge it - unless
      // it was the last card, when the player is out and it simply applies.
      if (f.type === 'wildDraw' && hand.length > 0 && !noMercy) {
        g.challenge = { actor: actor, face: f, color: chosenColor, legal: legal };
        advance(1);
        g.phase = 'challenge';
        say(g.players[g.current].name + ' can take it or challenge.', 'info');
        return { ok: true, challenge: true };
      }

      // Going out, after the card has had its effect. The round ends once
      // only one player still holds cards.
      var steps = applyEffect(actor, f, chosenColor);

      if (hand.length === 0) {
        finish(actor);
        if (activeCount() <= 1) {
          endRound();
          return { ok: true, roundOver: true };
        }
        if (g.deckDry) {
          endDryRound();
          return { ok: true, roundOver: true };
        }
        // Skip Everyone returns the turn to the actor, who is gone now.
        advance(Math.max(steps, 1));
        g.phase = 'turn';
        return { ok: true, finished: true };
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
      if (g.phase !== 'awaitColor' && g.phase !== 'rouletteColor') { return { ok: false }; }
      if (C.colorsFor(g.side).indexOf(color) < 0) { return { ok: false }; }
      if (g.phase === 'rouletteColor') { return spinRoulette(color); }

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
      if (noMercy) { return drawNoMercy(actor); }
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

    // No Mercy: a player owing a stacked penalty takes it all and is
    // skipped. Otherwise they draw until a card fits, and must play it.
    function drawNoMercy(actor) {
      var p = g.players[actor];
      if (g.stack) {
        var owed = g.stack.total;
        g.stack = null;
        var got = drawMany(actor, owed);
        say(p.name + ' takes the ' + owed + '.', 'penalty');
        if (g.deckDry && got < owed) { endDryRound(); return { ok: true, roundOver: true }; }
        advance(1);
        settle();
        return { ok: true, playable: false, took: got };
      }

      var n = 0;
      var card = null;
      while (p.hand.length < MERCY_LIMIT) {
        card = drawOne(actor);
        if (!card) { endDryRound(); return { ok: true, roundOver: true }; }
        n++;
        if (isPlayable(card)) { break; }
        card = null;
      }
      say(p.name + ' drew ' + n + (n === 1 ? ' card.' : ' cards.'), 'draw');

      if (!card) {                       // the Mercy rule got there first
        settle();
        return { ok: true, playable: false };
      }
      g.drawnCardId = card.id;
      g.phase = 'drawnDecision';
      return { ok: true, playable: true, card: card };
    }

    // Decline to play the card that was just drawn.
    function passAfterDraw() {
      if (g.phase !== 'drawnDecision') { return { ok: false }; }
      if (noMercy) { return { ok: false, reason: 'you must play the card you drew' }; }
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
      if (!isIn(p) || p.hand.length > 2) { return { ok: false }; }
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
      settle();
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
    g.swapWith     = swapWith;
    g.isIn         = function (i) { return isIn(g.players[i]); };
    g.playerAt     = playerAt;

    return g;
  }

  ns.createGame = createGame;
}));
