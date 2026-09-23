/* ==========================================================================
   Engine tests - deck composition and many complete bot-vs-bot rounds.
   Run with:  npm test
   ========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

const UNO = require(path.join(ROOT, 'js', 'cards.js'));
require(path.join(ROOT, 'js', 'game.js'));
require(path.join(ROOT, 'js', 'ai.js'));
require(path.join(ROOT, 'js', 'match.js'));

const C = UNO.cards;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label + (detail ? ' -> ' + detail : ''));
  }
}

/* ------------------------------------------------------------ deck shape */

console.log('\ndeck composition');

const classic = C.buildDeck('classic');
const flip = C.buildDeck('flip');

check('classic deck is 108 cards', classic.length === 108, classic.length);
check('flip deck is 112 cards', flip.length === 112, flip.length);
check('classic cards are single sided', classic.every(c => !c.dark));
check('flip cards are paired light/dark',
  flip.every(c => c.light.side === 'light' && c.dark && c.dark.side === 'dark'));

function tally(deck, side) {
  const counts = {};
  deck.forEach(c => {
    const f = side === 'dark' ? c.dark : c.light;
    const k = C.name(f);
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

const cc = tally(classic, 'light');
check('classic has one 0 per colour', cc['Red 0'] === 1 && cc['Blue 0'] === 1);
check('classic has two 7s per colour', cc['Red 7'] === 2);
check('classic has 4 Wild Draw Four', cc['Wild Draw Four'] === 4);

const fl = tally(flip, 'light');
const fd = tally(flip, 'dark');
check('flip light has no 0 cards', !fl['Red 0']);
check('flip light has two Flip per colour', fl['Red Flip'] === 2);
check('flip light has Draw 1', fl['Red Draw 1'] === 2);
check('flip dark has Draw 5', fd['Pink Draw 5'] === 2);
check('flip dark has Skip Everyone', fd['Pink Skip Everyone'] === 2);
check('flip dark has 4 Wild Draw Colour', fd['Wild Draw Colour'] === 4);

/* --------------------------------------------------- scoring of the faces */

console.log('\ncard values');
const face = (deck, name, side) =>
  deck.map(c => (side === 'dark' ? c.dark : c.light)).find(f => C.name(f) === name);

check('number cards score face value', C.points(face(classic, 'Red 7')) === 7);
check('light actions score 20', C.points(face(classic, 'Red Skip')) === 20);
check('dark actions score 30', C.points(face(flip, 'Pink Draw 5', 'dark')) === 30);
check('wild scores 40', C.points(face(classic, 'Wild')) === 40);
check('wild draw four scores 50', C.points(face(classic, 'Wild Draw Four')) === 50);
check('wild draw colour scores 60', C.points(face(flip, 'Wild Draw Colour', 'dark')) === 60);

/* ----------------------------------------------------- full round soak test */

function playRound(mode, seats, maxTurns = 4000) {
  const players = [];
  for (let i = 0; i < seats; i++) players.push({ id: 'p' + i, name: 'P' + i });

  const g = UNO.createGame({ mode, target: 0, players });
  g.startRound();

  const totalCards = mode === 'classic' ? 108 : 112;
  let turns = 0, flips = 0, lastSide = g.side;

  while (g.phase !== 'gameOver' && g.phase !== 'roundOver') {
    if (++turns > maxTurns) throw new Error('round never finished');

    const accounted = g.players.reduce((n, p) => n + p.hand.length, 0) +
      g.drawPile.length + g.discardPile.length;
    if (accounted !== totalCards) {
      throw new Error(`card leak: ${accounted}/${totalCards} on turn ${turns}`);
    }

    const idx = g.current;

    if (g.phase === 'awaitColor') {
      if (!g.chooseColor(UNO.ai.bestColor(g, idx)).ok) throw new Error('starter colour refused');
      continue;
    }
    if (g.phase === 'challenge') {
      const actor = g.challenge.actor;
      const before = g.players[actor].hand.length;
      const res = g.respondToWildDraw(UNO.ai.decideChallenge(g, idx));
      if (!res.ok) throw new Error('challenge response refused');
      if (res.guilty) throw new Error('a bot bluffed a Wild Draw');
      if (g.players[actor].hand.length !== before) throw new Error('honest player was punished');
      continue;
    }

    const move = UNO.ai.chooseMove(g, idx);

    if (move.action === 'play') {
      const res = g.playCard(move.cardId, move.color);
      if (!res.ok) throw new Error('illegal AI play: ' + res.reason);
    } else {
      const res = g.drawFromPile();
      const f = res.playable ? UNO.ai.decideDrawn(g, idx, res.card) : null;
      if (f && f.action === 'play') {
        const r2 = g.playCard(f.cardId, f.color);
        if (!r2.ok) throw new Error('illegal AI follow-up: ' + r2.reason);
      } else if (g.phase === 'drawnDecision') {
        g.passAfterDraw();
      }
    }

    if (g.players[idx].hand.length === 1 && Math.random() < 0.8) g.callUno(idx);
    if (g.unoPending && Math.random() < 0.5) g.catchUno((idx + 1) % seats);
    if (g.side !== lastSide) { flips++; lastSide = g.side; }
  }

  if (!g.lastWinner) throw new Error('no winner recorded');
  if (g.players[g.lastWinner.index].hand.length !== 0 && !g.deckDry) {
    throw new Error('winner holds cards');
  }
  return { turns, flips };
}

console.log('\n400 complete rounds');
let soakError = null;
const stats = { classic: [], flip: [] };
try {
  for (let i = 0; i < 400; i++) {
    const mode = i % 2 ? 'flip' : 'classic';
    stats[mode].push(playRound(mode, 2 + (i % 4)));
  }
} catch (e) {
  soakError = e.message;
}
check('every round finishes cleanly with no card leak', !soakError, soakError);

if (!soakError) {
  for (const mode of ['classic', 'flip']) {
    const rows = stats[mode];
    const avg = k => (rows.reduce((n, r) => n + r[k], 0) / rows.length).toFixed(1);
    console.log(`       ${mode}: ${rows.length} rounds, avg ${avg('turns')} turns` +
      (mode === 'flip' ? `, avg ${avg('flips')} flips` : ''));
  }
}

/* ---------------------------------------------------------- rules details */

console.log('\nrule details');

function dealtGame(mode, seats) {
  const players = [];
  for (let i = 0; i < seats; i++) players.push({ id: 'p' + i, name: 'P' + i });
  const g = UNO.createGame({ mode, target: 0, players });
  g.startRound();
  return g;
}

// A fresh round forced onto a plain Red 5 starter, seat 0 to play.
function fixedGame(mode, seats) {
  const g = dealtGame(mode, seats);
  const five = (side, color) => ({ side, color, type: 'number', value: 5, draw: 0, drawMode: null });
  g.discardPile = [{ id: 'start', light: five('light', 'red'),
    dark: mode === 'classic' ? null : five('dark', 'pink') }];
  g.players.forEach(p => { p.hand = p.hand.slice(0, 7); });
  Object.assign(g, { side: 'light', direction: 1, current: 0, phase: 'turn',
    currentColor: 'red', starterWild: false });
  return g;
}

// Reverse is a Skip in a two-player game.
{
  const g = fixedGame('classic', 2);
  const rev = { id: 'x1', light: { side: 'light', color: g.currentColor, type: 'reverse',
    value: null, draw: 0, drawMode: null }, dark: null };
  g.players[0].hand.push(rev);
  const before = g.direction;
  g.playCard('x1');
  check('reverse with two players acts as a skip',
    g.current === 0 && g.direction === before);
}

// Reverse flips direction with three or more.
{
  const g = fixedGame('classic', 3);
  const rev = { id: 'x2', light: { side: 'light', color: g.currentColor, type: 'reverse',
    value: null, draw: 0, drawMode: null }, dark: null };
  g.players[0].hand.push(rev);
  g.playCard('x2');
  check('reverse flips direction with three players', g.direction === -1 && g.current === 2);
}

// Skip Everyone returns play to the same player.
{
  const g = fixedGame('flip', 3);
  g.side = 'dark';
  g.currentColor = 'pink';
  const skipAll = { id: 'x3',
    light: { side: 'light', color: 'red', type: 'number', value: 3, draw: 0, drawMode: null },
    dark: { side: 'dark', color: 'pink', type: 'skipAll', value: null, draw: 0, drawMode: null } };
  g.discardPile.push({ id: 'top', light: null,
    dark: { side: 'dark', color: 'pink', type: 'number', value: 4, draw: 0, drawMode: null } });
  g.players[0].hand.push(skipAll);
  g.playCard('x3');
  check('skip everyone returns play to the same player', g.current === 0);
}

// Flip turns the board over and takes the colour from the new face.
{
  const g = fixedGame('flip', 3);
  const flipCard = { id: 'x4',
    light: { side: 'light', color: g.currentColor, type: 'flip', value: null, draw: 0, drawMode: null },
    dark: { side: 'dark', color: 'teal', type: 'flip', value: null, draw: 0, drawMode: null } };
  g.players[0].hand.push(flipCard);
  g.playCard('x4');
  check('flip switches to the dark side', g.side === 'dark');
  check('flip takes the colour from the new face', g.currentColor === 'teal');
}

// A drawn card that cannot be played passes the turn on.
{
  const g = fixedGame('classic', 3);
  g.players[0].hand = [];
  const before = g.players[0].hand.length;
  g.drawFromPile();
  check('drawing adds exactly one card', g.players[0].hand.length === before + 1);
}

// UNO penalty.
{
  const g = fixedGame('classic', 3);
  g.players[1].hand = [g.players[1].hand[0]];
  g.unoPending = { player: 1, at: Date.now() };
  g.players[1].calledUno = false;
  g.catchUno();
  check('forgetting UNO costs two cards', g.players[1].hand.length === 3);
}
{
  const g = fixedGame('classic', 3);
  g.players[1].hand = [g.players[1].hand[0]];
  g.unoPending = { player: 1, at: Date.now() };
  g.callUno(1);
  check('calling UNO avoids the penalty',
    g.catchUno() === null && g.players[1].hand.length === 1);
}

// Wild Draw challenges.
function wildDrawSetup(holdsColour) {
  const g = fixedGame('classic', 3);
  g.currentColor = 'red';
  g.discardPile.push({ id: 'topR', light: { side: 'light', color: 'red', type: 'number',
    value: 5, draw: 0, drawMode: null }, dark: null });
  const wd4 = { id: 'wd4', light: { side: 'light', color: 'wild', type: 'wildDraw',
    value: null, draw: 4, drawMode: 'count' }, dark: null };
  const filler = { id: 'f1', light: { side: 'light', color: holdsColour ? 'red' : 'blue',
    type: 'number', value: holdsColour ? 7 : 8, draw: 0, drawMode: null }, dark: null };
  g.players[0].hand = [wd4, filler, filler, filler].map((c, i) => Object.assign({}, c, { id: c.id + i }));
  g.players[1].hand = g.players[1].hand.slice(0, 5);
  g.current = 0;
  g.phase = 'turn';
  g.playCard('wd40', 'green');
  return g;
}
{
  const g = wildDrawSetup(true);
  check('a Wild Draw waits for the victim to respond',
    g.phase === 'challenge' && g.current === 1 && g.players[1].hand.length === 5);
  check('holding the colour in play makes it a bluff', g.challenge.legal === false);
  const res = g.respondToWildDraw(true);
  check('a caught bluffer draws four instead', res.guilty && g.players[0].hand.length === 7);
  check('the challenger then plays normally',
    g.current === 1 && g.players[1].hand.length === 5 && g.phase === 'turn');
  check('the chosen colour still stands', g.currentColor === 'green');
}
{
  const g = wildDrawSetup(false);
  const res = g.respondToWildDraw(true);
  check('a wrong challenge costs four plus two', !res.guilty && g.players[1].hand.length === 11);
  check('the wrong challenger is skipped', g.current === 2);
}
{
  const g = wildDrawSetup(false);
  g.respondToWildDraw(false);
  check('taking it draws four and skips', g.players[1].hand.length === 9 && g.current === 2);
}
{
  const g = wildDrawSetup(false);
  const wild = { id: 'w9', light: { side: 'light', color: 'wild', type: 'wildDraw', value: null,
    draw: 4, drawMode: 'count' }, dark: null };
  g.players[1].hand.push(wild);
  check('you cannot play a card while deciding a challenge', !g.playCard('w9', 'red').ok);
}
{
  const g = fixedGame('classic', 3);
  g.currentColor = 'red';
  g.players[0].hand = [
    { id: 'a', light: { side: 'light', color: 'wild', type: 'wildDraw', value: null, draw: 4, drawMode: 'count' }, dark: null },
    { id: 'b', light: { side: 'light', color: 'red', type: 'number', value: 1, draw: 0, drawMode: null }, dark: null }
  ];
  const move = UNO.ai.chooseMove(g, 0);
  check('bots never bluff a Wild Draw', move.cardId === 'b');
  check('only the colour in play makes it illegal',
    !g.wildDrawLegal(0, g.players[0].hand[0]) &&
    (g.players[0].hand[1].light.color = 'blue', g.wildDrawLegal(0, g.players[0].hand[0])));
}

// A deck that runs completely dry ends the round.
{
  const g = fixedGame('classic', 3);
  const card = (color, value) => ({ id: color + value, light: { side: 'light', color,
    type: 'number', value, draw: 0, drawMode: null }, dark: null });
  g.drawPile = [];
  g.players[0].hand = [card('blue', 9), card('blue', 8)];
  g.players[1].hand = [card('green', 1)];
  g.players[2].hand = [card('yellow', 3), card('yellow', 4)];
  g.drawFromPile();
  check('a dry deck ends the round', g.phase === 'gameOver');
  check('the lowest hand wins a dry round', g.lastWinner.index === 1 && g.lastWinner.gained === 24);
}

// Catching a missed UNO.
{
  const g = fixedGame('classic', 3);
  g.players[0].hand = [g.players[0].hand[0]];
  g.unoPending = { player: 0, at: Date.now() };
  check('you cannot catch yourself', g.catchUno(0) === null && g.players[0].hand.length === 1);
  check('another player can catch you', g.catchUno(2) === 0 && g.players[0].hand.length === 3);
}
{
  const g = fixedGame('classic', 3);
  g.players[0].hand = [g.players[0].hand[0]];
  g.unoPending = { player: 0, at: Date.now() };
  g.current = 1;
  g.drawFromPile();
  check('the next player moving closes the catch window', g.unoPending === null);
}

// The starting card acts on the first player.
{
  const seen = {};
  let bad = null;
  for (let i = 0; i < 1500 && !bad; i++) {
    const g = dealtGame(i % 2 ? 'flip' : 'classic', 3);
    const f = g.topFace();
    seen[f.type] = true;
    const lightTop = C.activeFace(g.topCard(), 'light');
    if (lightTop.type === 'wildDraw') bad = 'a Wild Draw was the starter';
    else if (C.isWild(f) && !(g.phase === 'awaitColor' && g.current === 0)) bad = 'wild starter did not ask for a colour';
    else if (f.type === 'skip' && g.current !== 1) bad = 'skip starter did not skip';
    else if (f.type === 'reverse' && !(g.direction === -1 && g.current === 2)) bad = 'reverse starter wrong';
    else if (f.type === 'draw' && !(g.players[0].hand.length === 7 + f.draw && g.current === 1)) bad = 'draw starter wrong';
    else if (f.type === 'number' && g.current !== 0) bad = 'number starter moved the turn';
  }
  check('every kind of starting card resolves correctly', !bad, bad);
  check('action starters really occur', seen.skip && seen.reverse && seen.draw && seen.wild);
}
{
  const g = fixedGame('classic', 3);
  g.phase = 'awaitColor';
  g.starterWild = true;
  check('a starter colour must be a real colour', !g.chooseColor('pink').ok);
  check('choosing the starter colour begins play',
    g.chooseColor('blue').ok && g.currentColor === 'blue' && g.phase === 'turn');
}

/* --------------------------------------------------------- match + views */

console.log('\nmatch layer');
{
  const m = UNO.createMatch({ mode: 'flip', target: 0, botDelay: 100000 });
  m.addSeat({ id: 'alice', name: 'Alice', kind: 'human' });
  m.addSeat({ id: 'bob', name: 'Bob', kind: 'human' });
  m.addSeat({ id: 'bot1', kind: 'bot' });
  check('first human becomes host', m.hostId === 'alice');
  check('bots get names', !!m.seatOf('bot1').name);

  m.start();
  const v = m.view('alice');
  check('view exposes only your own hand',
    !!v.you && v.you.hand.length === m.game.players[0].hand.length);
  check('other seats expose no card ids',
    v.players.every(p => !p.hand && !p.cards));
  check('other seats expose only a count', v.players.every(p => typeof p.count === 'number'));
  check('flip mode hides opponent faces too',
    v.players.every(p => !p.reverseFaces));

  const bad = m.action('bob', { type: 'play', cardId: v.you.hand[0].id });
  check('you cannot play out of turn', !bad.ok);
  const nonsense = m.action('alice', { type: 'play', cardId: 'not-a-card' });
  check('you cannot play a card you do not hold', !nonsense.ok);

  const classicMatch = UNO.createMatch({ mode: 'classic', target: 0, botDelay: 100000 });
  classicMatch.addSeat({ id: 'a', name: 'A', kind: 'human' });
  classicMatch.addSeat({ id: 'b', name: 'B', kind: 'human' });
  classicMatch.start();
  const cv = classicMatch.view('a');
  check('classic mode hides opponent faces entirely',
    cv.players.every(p => !p.reverseFaces));
  classicMatch.clearTimers();
  m.clearTimers();
}

/* -------------------------------------------------------------------- end */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED\n`);
  process.exit(1);
}
console.log('all engine checks passed\n');
