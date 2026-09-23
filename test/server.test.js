/* ==========================================================================
   Multiplayer tests - real HTTP server, real WebSocket clients, real rounds.
   Run with:  node test/server.test.js
   ========================================================================== */
'use strict';

process.env.UNO_BOT_DELAY = process.env.UNO_BOT_DELAY || '15';
process.env.UNO_OFFLINE_GRACE = process.env.UNO_OFFLINE_GRACE || '300';

const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { server } = require(path.join(__dirname, '..', 'server', 'server.js'));

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------- test client */

function connect(port, name) {
  return new Promise((resolve, reject) => {
    const c = {
      name,
      playerId: null,
      code: null,
      view: null,
      errors: [],
      states: 0,
      autoplay: false,
      inFlight: null,
      unoSent: false,
      ws: new WebSocket(`ws://127.0.0.1:${port}/ws`)
    };

    c.send = msg => c.ws.send(JSON.stringify(msg));
    c.waiters = [];
    c.until = (predicate, label, timeout = 15000) => new Promise((res, rej) => {
      if (predicate(c)) { return res(c); }
      const entry = { predicate, res, rej, label };
      entry.timer = setTimeout(() => {
        c.waiters = c.waiters.filter(w => w !== entry);
        rej(new Error(`timed out waiting for ${label} (${name})`));
      }, timeout);
      c.waiters.push(entry);
    });

    function settle() {
      c.waiters.slice().forEach(w => {
        if (w.predicate(c)) {
          clearTimeout(w.timer);
          c.waiters = c.waiters.filter(x => x !== w);
          w.res(c);
        }
      });
    }

    c.ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') { c.playerId = msg.playerId; }
      if (msg.t === 'room') { c.code = msg.code; }
      if (msg.t === 'error') { c.errors.push(msg.message); c.inFlight = null; }
      if (msg.t === 'state') {
        c.view = msg.view;
        c.states++;
        if (c.autoplay) { play(c); }
      }
      settle();
    });

    c.ws.on('open', () => { c.send({ t: 'hello', playerId: c.playerId }); });
    c.ws.on('error', reject);
    c.until(x => !!x.playerId, 'handshake', 5000).then(() => resolve(c), reject);
  });
}

// A minimal but complete player: matches, draws, picks colours, shouts UNO.
//
// It sends one action at a time. A broadcast can land while our own move is
// still in flight - being caught for not calling UNO changes our hand mid-air -
// and acting on that stale view would send a card we have already put down.
function stillPending(v, sent) {
  if (!v.you || !v.you.isTurn || v.turnPhase !== sent.phase) { return false; }
  if (sent.type === 'play') { return v.you.hand.some(card => card.id === sent.cardId); }
  return true;
}

function play(c) {
  const v = c.view;
  if (!v || !v.you || v.phase !== 'playing') { c.inFlight = null; return; }

  if (c.inFlight) {
    if (stillPending(v, c.inFlight)) { return; }
    c.inFlight = null;
  }

  if (v.you.canCallUno && !c.unoSent) { c.unoSent = true; c.send({ t: 'act', action: { type: 'uno' } }); }
  if (!v.you.canCallUno) { c.unoSent = false; }
  if (!v.you.isTurn) { return; }

  const fire = (action) => {
    c.inFlight = Object.assign({ phase: v.turnPhase }, action);
    c.send({ t: 'act', action: action });
  };

  if (v.awaitingColor) {
    return fire({ type: 'color', color: v.colorChoices[Math.floor(Math.random() * v.colorChoices.length)] });
  }

  if (v.canRespond) {
    return fire({ type: Math.random() < 0.3 ? 'challenge' : 'accept' });
  }

  const playable = v.you.hand.filter(card => card.playable);
  if (playable.length) {
    return fire({ type: 'play', cardId: playable[Math.floor(Math.random() * playable.length)].id });
  }
  if (v.canPass) { return fire({ type: 'pass' }); }
  if (v.canDraw) { return fire({ type: 'draw' }); }
}

/* -------------------------------------------------------------- the tests */

(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  console.log(`\nserver listening on ${port}`);

  /* --- static hosting ---------------------------------------------------- */
  console.log('\nstatic hosting');
  const get = p => new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}${p}`, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => res({ status: r.statusCode, body, type: r.headers['content-type'],
                              location: r.headers.location }));
    }).on('error', rej);
  });

  check('serves the app', (await get('/')).body.includes('UNO FLIP'));
  check('serves a join link', (await get('/?r=ABCD')).body.includes('UNO FLIP'));
  const legacy = await get('/r/ABCD');
  check('redirects an old path join link',
    legacy.status === 302 && legacy.location === '/?r=ABCD', legacy.status + ' ' + legacy.location);
  check('serves the stylesheet', (await get('/css/app.css')).status === 200);
  check('serves the engine', (await get('/js/game.js')).status === 200);
  const qr = await get('/qr.svg?d=' + encodeURIComponent('http://example.test/?r=ABCD'));
  check('renders a join QR code', qr.status === 200 && qr.body.includes('<svg'));
  check('hides the server source', (await get('/server/server.js')).status === 404);
  check('blocks path traversal',
    (await get('/css/../../package.json')).status === 404);

  /* --- lobby ------------------------------------------------------------- */
  console.log('\nlobby');
  const alice = await connect(port, 'Alice');
  const bob = await connect(port, 'Bob');
  const cara = await connect(port, 'Cara');

  alice.send({ t: 'create', name: 'Alice', mode: 'flip', target: 300 });
  await alice.until(c => !!c.code, 'room code');
  check('creating a table returns a four character code', /^[A-Z0-9]{4}$/.test(alice.code));
  check('the creator is the host', alice.view.isHost === true);

  bob.send({ t: 'join', code: alice.code, name: 'Bob' });
  await bob.until(c => !!c.view && c.view.seated, 'bob seated');
  cara.send({ t: 'join', code: alice.code.toLowerCase(), name: 'Cara' });
  await cara.until(c => !!c.view && c.view.seated, 'cara seated');

  check('a lowercase code still joins', cara.view.code === alice.code);
  await alice.until(c => c.view.players.length === 3, 'three seats');
  check('everyone sees the same table', alice.view.players.length === 3 &&
    bob.view.players.length === 3 && cara.view.players.length === 3);
  check('only the host is flagged as host',
    bob.view.isHost === false && cara.view.isHost === false);

  bob.send({ t: 'start' });
  await bob.until(c => c.errors.length > 0, 'host-only rejection');
  check('a guest cannot start the round', /host/i.test(bob.errors[0]), bob.errors[0]);

  bob.send({ t: 'addBot' });
  await wait(120);
  check('a guest cannot add bots', alice.view.players.length === 3);

  alice.send({ t: 'addBot' });
  await alice.until(c => c.view.players.length === 4, 'bot seated');
  check('the host can add a bot',
    alice.view.players.filter(p => p.kind === 'bot').length === 1);

  const joinerName = alice.view.players.find(p => p.id === bob.playerId).name;
  check('names carry across to the other clients', joinerName === 'Bob');

  /* --- dealing ----------------------------------------------------------- */
  console.log('\ndealing');
  alice.send({ t: 'start' });
  await alice.until(c => c.view.phase === 'playing', 'round start');
  await bob.until(c => c.view.phase === 'playing', 'bob sees the round');
  await cara.until(c => c.view.phase === 'playing', 'cara sees the round');

  // An action starter (or a bot moving first) can already have changed hands,
  // so check that every card is accounted for rather than exact counts.
  const inHands = alice.view.players.reduce((n, p) => n + p.count, 0);
  check('the deck is split between hands and piles',
    inHands + alice.view.drawCount + alice.view.discardCount === 112,
    inHands + alice.view.drawCount + alice.view.discardCount);
  check('everyone agrees on the top card',
    JSON.stringify(alice.view.discardTop) === JSON.stringify(bob.view.discardTop));

  /* --- privacy ----------------------------------------------------------- */
  console.log('\nprivacy');
  const leaks = [];
  [alice, bob, cara].forEach(c => {
    c.view.players.forEach(p => {
      if (p.id === c.playerId) { return; }
      if (p.hand || p.cards) { leaks.push(`${c.name} can see ${p.name}'s hand`); }
      if (p.reverseFaces) { leaks.push(`${c.name} sees ${p.name}'s card faces`); }
    });
    if (c.view.you.id !== c.playerId) { leaks.push(`${c.name} got the wrong seat`); }
  });
  check('no client is sent another hand', leaks.length === 0, leaks.join('; '));
  check('you only ever receive your own card ids',
    alice.view.you.hand.every(card => typeof card.id === 'string'));

  /* --- illegal moves ----------------------------------------------------- */
  console.log('\nrejected moves');
  const offTurn = [alice, bob, cara].find(c => !c.view.you.isTurn);
  offTurn.errors.length = 0;
  offTurn.send({ t: 'act', action: { type: 'play', cardId: offTurn.view.you.hand[0].id } });
  await offTurn.until(c => c.errors.length > 0, 'out of turn rejection');
  check('playing out of turn is refused', /turn/i.test(offTurn.errors[0]), offTurn.errors[0]);

  const onTurn = [alice, bob, cara].find(c => c.view.you.isTurn);
  if (onTurn) {
    onTurn.errors.length = 0;
    onTurn.send({ t: 'act', action: { type: 'play', cardId: 'forged-card-id' } });
    await onTurn.until(c => c.errors.length > 0, 'forged card rejection');
    check('a forged card id is refused', onTurn.errors.length === 1, onTurn.errors[0]);
  }

  /* --- reconnection ------------------------------------------------------ */
  console.log('\nreconnection');
  const bobId = bob.playerId;
  const bobHand = bob.view.you.hand.length;
  bob.ws.close();
  await alice.until(c => c.view.players.some(p => p.id === bobId && !p.online),
    'bob marked away');
  check('a dropped player is shown as away', true);

  const bobAgain = await connect(port, 'Bob');
  bobAgain.playerId = bobId;
  bobAgain.send({ t: 'hello', playerId: bobId });
  await bobAgain.until(c => c.playerId === bobId, 'bob identity restored');
  bobAgain.send({ t: 'join', code: alice.code, name: 'Bob' });
  await bobAgain.until(c => !!c.view && c.view.seated, 'bob back at the table');

  check('reconnecting returns you to your own seat', bobAgain.view.you.id === bobId);
  check('the table did not gain a duplicate seat', bobAgain.view.players.length === 4);
  check('the hand survived the disconnection',
    bobAgain.view.you.hand.length >= bobHand - 2, // the bot may have played for Bob
    `${bobAgain.view.you.hand.length} vs ${bobHand}`);
  check('the player is online again',
    bobAgain.view.players.find(p => p.id === bobId).online === true);

  /* --- play the round out ------------------------------------------------ */
  console.log('\na full round over the wire');
  // Start from a clean slate - the rejection tests above deliberately produced
  // errors, and from here on any error at all is a genuine failure.
  [alice, bobAgain, cara].forEach(c => {
    c.errors.length = 0;
    c.autoplay = true;
    c.inFlight = null;
    play(c);
  });

  const finished = c => c.view.phase === 'roundOver' || c.view.phase === 'gameOver';
  await Promise.all([alice, bobAgain, cara].map(c => c.until(finished, 'round finished', 40000)));
  [alice, bobAgain, cara].forEach(c => { c.autoplay = false; });

  check('the round reaches an end', !!alice.view.lastWinner);
  const winnerId = alice.view.lastWinner.id;
  check('all clients agree on the winner',
    bobAgain.view.lastWinner.id === winnerId && cara.view.lastWinner.id === winnerId);
  check('the winner scored the other hands', alice.view.lastWinner.gained >= 0);
  check('scores were written to every seat',
    alice.view.players.find(p => p.id === winnerId).score === alice.view.lastWinner.gained);

  const unexpected = [alice, bobAgain, cara].flatMap(c => c.errors);
  check('no server rejections during honest play', unexpected.length === 0, unexpected.join('; '));

  /* --- next round -------------------------------------------------------- */
  console.log('\nnext round');
  if (alice.view.phase === 'roundOver') {
    alice.send({ t: 'act', action: { type: 'next' } });
    await alice.until(c => c.view.phase === 'playing', 'second round');
    check('the host can deal again', alice.view.round === 2, 'round ' + alice.view.round);
    check('scores carried into the new round',
      alice.view.players.some(p => p.score > 0));
  } else {
    check('game ended on the target score', alice.view.phase === 'gameOver');
  }

  /* --- leaving ----------------------------------------------------------- */
  console.log('\nleaving');
  cara.send({ t: 'leave' });
  await alice.until(c => c.view.players.length === 3, 'seat released');
  check('leaving frees the seat', alice.view.players.length === 3);

  [alice, bobAgain, cara].forEach(c => c.ws.close());
  await wait(150);
  server.close();

  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED\n`); process.exit(1); }
  console.log('all multiplayer checks passed\n');
  process.exit(0);
})().catch(e => {
  console.error('\nFAILED: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
