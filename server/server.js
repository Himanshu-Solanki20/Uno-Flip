/* ==========================================================================
   server.js - static file host + authoritative multiplayer server.

   The server owns every match. Clients never see a hand they are not entitled
   to: each socket is sent its own redacted view built by match.js, and every
   action is validated against the real game state before it is applied.
   ========================================================================== */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 3000;

// The shared engine - the exact files the browser loads.
const UNO = require(path.join(ROOT, 'js', 'cards.js'));
require(path.join(ROOT, 'js', 'game.js'));
require(path.join(ROOT, 'js', 'ai.js'));
require(path.join(ROOT, 'js', 'match.js'));

/* ----------------------------------------------------------- static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const PUBLIC_DIRS = ['css', 'js'];

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname = decodeURIComponent(url.pathname);

  // A join link carries the room code: /r/ABCD -> serve the app, the client
  // reads the code back out of the address bar.
  if (/^\/r\/[A-Z0-9]{4}\/?$/i.test(pathname)) { pathname = '/'; }

  if (pathname === '/qr.svg') {
    const text = url.searchParams.get('d') || '';
    try {
      const svg = await QRCode.toString(text, {
        type: 'svg', margin: 1, width: 240,
        color: { dark: '#10121a', light: '#ffffff' }
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(svg);
    } catch (e) {
      res.writeHead(400).end('bad qr request');
    }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  // Only css/ and js/ are reachable - no traversal, no server/ or node_modules.
  const rel = path.normalize(pathname).replace(/^[\\/]+/, '');
  const top = rel.split(/[\\/]/)[0];
  if (!PUBLIC_DIRS.includes(top)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const target = path.join(ROOT, rel);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  sendFile(res, target);
});

/* ------------------------------------------------------------------ rooms */

const rooms = new Map();     // CODE -> { code, match, sockets:Set, emptySince }
const sockets = new Set();   // every live connection

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomFillSync(new Uint8Array(4)))
      .map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function createRoom(options) {
  const code = newCode();
  const room = { code, sockets: new Set(), emptySince: null };
  room.match = UNO.createMatch({
    code,
    mode: options.mode || 'flip',
    target: options.target || 0,
    // Tunable so the test suite does not have to sit through bot pauses.
    botDelay: Number(process.env.UNO_BOT_DELAY) || undefined,
    unoGrace: Number(process.env.UNO_UNO_GRACE) || undefined,
    offlineGrace: Number(process.env.UNO_OFFLINE_GRACE) || undefined,
    onUpdate: () => broadcast(room)
  });
  rooms.set(code, room);
  log(`room ${code} created`);
  return room;
}

function broadcast(room) {
  for (const ws of room.sockets) {
    if (ws.readyState !== ws.OPEN) { continue; }
    send(ws, { t: 'state', view: room.match.view(ws.playerId) });
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify(msg)); }
}

function fail(ws, message) {
  send(ws, { t: 'error', message });
}

function leaveRoom(ws, { drop } = {}) {
  const room = ws.room;
  if (!room) { return; }
  room.sockets.delete(ws);
  ws.room = null;

  if (drop) {
    room.match.removeSeat(ws.playerId);
  } else {
    room.match.setOnline(ws.playerId, false);
    broadcast(room);
  }

  if (room.match.onlineCount() === 0) {
    room.emptySince = Date.now();
  }
}

/* --------------------------------------------------------- the socket API */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.room = null;
  sockets.add(ws);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) {
      log('handler error: ' + e.message);
      fail(ws, 'Something went wrong on the server.');
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    leaveRoom(ws);
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'hello': {
      // The browser keeps its id so a refresh or a dropped Wi-Fi connection
      // returns to the same seat.
      ws.playerId = typeof msg.playerId === 'string' && msg.playerId.length <= 32
        ? msg.playerId : newId();
      // One live socket per identity.
      for (const other of sockets) {
        if (other !== ws && other.playerId === ws.playerId) {
          send(other, { t: 'replaced' });
          other.close();
        }
      }
      send(ws, { t: 'hello', playerId: ws.playerId, urls: lanUrls() });
      return;
    }

    case 'create': {
      if (!ws.playerId) { return fail(ws, 'Handshake first.'); }
      leaveRoom(ws, { drop: true });
      const room = createRoom({ mode: msg.mode, target: msg.target });
      const added = room.match.addSeat({ id: ws.playerId, name: msg.name, kind: 'human' });
      if (!added.ok) { return fail(ws, added.error); }
      ws.room = room;
      room.sockets.add(ws);
      send(ws, { t: 'room', code: room.code, urls: lanUrls(room.code) });
      broadcast(room);
      return;
    }

    case 'join': {
      if (!ws.playerId) { return fail(ws, 'Handshake first.'); }
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { return fail(ws, 'No table with that code.'); }

      leaveRoom(ws, { drop: true });

      const existing = room.match.seatOf(ws.playerId);
      if (existing) {
        room.match.setOnline(ws.playerId, true);   // reconnecting
      } else {
        const added = room.match.addSeat({ id: ws.playerId, name: msg.name, kind: 'human' });
        if (!added.ok) { return fail(ws, added.error); }
      }

      ws.room = room;
      room.sockets.add(ws);
      room.emptySince = null;
      send(ws, { t: 'room', code: room.code, urls: lanUrls(room.code) });
      broadcast(room);
      return;
    }

    case 'leave': {
      leaveRoom(ws, { drop: true });
      send(ws, { t: 'left' });
      return;
    }

    case 'addBot': {
      const room = requireHost(ws);
      if (!room) { return; }
      const added = room.match.addSeat({ id: 'bot-' + newId(), kind: 'bot' });
      if (!added.ok) { fail(ws, added.error); }
      return;
    }

    case 'kick': {
      const room = requireHost(ws);
      if (!room) { return; }
      if (msg.id === ws.playerId) { return fail(ws, 'You cannot remove yourself.'); }
      room.match.removeSeat(msg.id);
      for (const other of room.sockets) {
        if (other.playerId === msg.id) {
          send(other, { t: 'kicked' });
          leaveRoom(other, { drop: true });
        }
      }
      return;
    }

    case 'options': {
      const room = requireHost(ws);
      if (!room) { return; }
      const res = room.match.setOptions({ mode: msg.mode, target: msg.target });
      if (!res.ok) { fail(ws, res.error); }
      return;
    }

    case 'start': {
      const room = requireHost(ws);
      if (!room) { return; }
      const res = room.match.start();
      if (!res.ok) { fail(ws, res.error); }
      return;
    }

    case 'act': {
      const room = ws.room;
      if (!room) { return fail(ws, 'You are not at a table.'); }
      const res = room.match.action(ws.playerId, msg.action || {});
      if (!res.ok) {
        fail(ws, res.error || 'That move is not allowed.');
        send(ws, { t: 'state', view: room.match.view(ws.playerId) });
      }
      return;
    }

    case 'ping':
      send(ws, { t: 'pong' });
      return;
  }
}

function requireHost(ws) {
  const room = ws.room;
  if (!room) { fail(ws, 'You are not at a table.'); return null; }
  if (room.match.hostId !== ws.playerId) { fail(ws, 'Only the host can do that.'); return null; }
  return room;
}

/* ------------------------------------------------------------ housekeeping */

// Drop sockets that stopped answering, and reap rooms nobody came back to.
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.match.onlineCount() === 0) {
      if (!room.emptySince) { room.emptySince = now; }
      if (now - room.emptySince > 5 * 60 * 1000) {
        room.match.clearTimers();
        rooms.delete(code);
        log(`room ${code} closed (empty)`);
      }
    } else {
      room.emptySince = null;
    }
  }
}, 30000).unref();

/* ------------------------------------------------------------------ boot */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) { out.push(net.address); }
    }
  }
  return out;
}

function lanUrls(code) {
  const suffix = code ? '/r/' + code : '';
  return lanAddresses().map(ip => `http://${ip}:${PORT}${suffix}`);
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const urls = lanUrls();
    console.log('');
    console.log('  UNO FLIP!  multiplayer server');
    console.log('  ' + '-'.repeat(38));
    console.log(`  this computer   http://localhost:${PORT}`);
    urls.forEach(u => console.log(`  other devices   ${u}`));
    if (!urls.length) {
      console.log('  other devices   (no network interface found)');
    }
    console.log('');
    console.log('  Open the address on your phone, tap Join, and enter the');
    console.log('  four-letter code the host sees. Ctrl-C to stop.');
    console.log('');
  });
}

module.exports = { server, rooms, PORT };
