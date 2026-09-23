/* ==========================================================================
   ai.js - opponent decision making. Simple heuristics, no lookahead.
   ========================================================================== */
(function (root, factory) {
  var ns = root.UNO || (root.UNO = {});
  factory(ns);
  if (typeof module === 'object' && module.exports) { module.exports = ns; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ns) {
  'use strict';

  var C = ns.cards;

  // How many cards of each colour the bot is holding on the current side.
  function colorCounts(g, botIdx) {
    var counts = {};
    C.colorsFor(g.side).forEach(function (c) { counts[c] = 0; });
    g.players[botIdx].hand.forEach(function (card) {
      var f = g.faceOf(card);
      if (counts.hasOwnProperty(f.color)) { counts[f.color]++; }
    });
    return counts;
  }

  // Higher is better. Wilds score low so they are saved for when they are
  // needed; attack cards score high when the next player is close to winning.
  function scoreCard(g, botIdx, card, counts) {
    var f = g.faceOf(card);
    var next = g.players[g.playerAt(1)];
    var threatened = next.hand.length <= 2;
    var score;

    switch (f.type) {
      case 'number':   score = 20 + f.value * 0.5; break;
      case 'flip':     score = 32; break;
      case 'reverse':  score = 36; break;
      case 'skip':     score = 44; break;
      case 'skipAll':  score = 50; break;
      case 'draw':     score = 52 + f.draw; break;
      case 'wild':     score = 6;  break;
      case 'wildDraw': score = 10; break;
      default:         score = 15;
    }

    // Press the advantage when someone is about to go out.
    if (threatened) {
      if (f.type === 'draw' || f.type === 'wildDraw') { score += 70; }
      if (f.type === 'skip' || f.type === 'skipAll')  { score += 55; }
      if (f.type === 'reverse' && g.players.length === 2) { score += 50; }
    }

    // Staying in a colour the bot is rich in keeps future turns open.
    if (counts.hasOwnProperty(f.color)) { score += counts[f.color] * 2; }

    // Shed expensive cards first - they cost points if someone else goes out.
    score += C.points(f) * 0.15;

    return score;
  }

  function bestColor(g, botIdx) {
    var counts = colorCounts(g, botIdx);
    var colors = C.colorsFor(g.side);
    var best = colors[0];
    var bestN = -1;
    colors.forEach(function (c) {
      if (counts[c] > bestN) { bestN = counts[c]; best = c; }
    });
    // Nothing in hand to protect - pick at random so the bot is not readable.
    if (bestN === 0) {
      best = colors[Math.floor(Math.random() * colors.length)];
    }
    return best;
  }

  // Returns { action: 'play', cardId, color } or { action: 'draw' }.
  function chooseMove(g, botIdx) {
    // Bots play fair: no Wild Draw while holding the colour in play.
    var options = g.playableCards(botIdx).filter(function (card) {
      return g.faceOf(card).type !== 'wildDraw' || g.wildDrawLegal(botIdx, card);
    });
    if (options.length === 0) { return { action: 'draw' }; }

    var counts = colorCounts(g, botIdx);
    var best = null;
    var bestScore = -Infinity;

    options.forEach(function (card) {
      var s = scoreCard(g, botIdx, card, counts);
      if (s > bestScore) { bestScore = s; best = card; }
    });

    var move = { action: 'play', cardId: best.id };
    if (C.isWild(g.faceOf(best))) { move.color = bestColor(g, botIdx); }
    return move;
  }

  // A freshly drawn playable card is worth playing, unless it would be a
  // bluffed Wild Draw. Returns a play move or { action: 'pass' }.
  function decideDrawn(g, botIdx, card) {
    if (g.faceOf(card).type === 'wildDraw' && !g.wildDrawLegal(botIdx, card)) {
      return { action: 'pass' };
    }
    var move = { action: 'play', cardId: card.id };
    if (C.isWild(g.faceOf(card))) { move.color = bestColor(g, botIdx); }
    return move;
  }

  // Whether to challenge a Wild Draw. A bot cannot see the hand, but the
  // more cards the player holds, the likelier one of them was the colour.
  function decideChallenge(g, botIdx) {
    var actor = g.challenge ? g.players[g.challenge.actor] : null;
    if (!actor) { return false; }
    return Math.random() < (actor.hand.length >= 6 ? 0.35 : 0.15);
  }

  // Bots are good but not perfect - now and then one forgets to call.
  function remembersUno() {
    return Math.random() > 0.15;
  }

  ns.ai = {
    chooseMove: chooseMove,
    decideDrawn: decideDrawn,
    decideChallenge: decideChallenge,
    bestColor: bestColor,
    remembersUno: remembersUno
  };
}));
