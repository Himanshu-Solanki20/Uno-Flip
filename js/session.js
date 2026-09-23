/* ==========================================================================
   session.js - the app talks to a "session", never to a socket.

   NetSession   : relays actions to the authoritative server over a WebSocket,
                  reconnects on drop and rejoins the same seat.
   LocalSession : runs the identical match.js in this tab, for offline play
                  against bots. Same methods, same view objects.
   ========================================================================== */
(function (ns) {
  'use strict';

  var STORE_ID = 'uno.playerId';
  var STORE_NAME = 'uno.playerName';

  function store(key, value) {
    try {
      if (value === undefined) { return window.localStorage.getItem(key); }
      window.localStorage.setItem(key, value);
      return value;
    } catch (e) {
      return null;   // private mode / blocked storage
    }
  }

  function randomId() {
    return 'p' + Math.random().toString(36).slice(2, 11);
  }

  function savedName() {
    return store(STORE_NAME) || '';
  }

  /* ------------------------------------------------------------ net session */

  function createNetSession(cb) {
    cb = cb || {};

    var ws = null;
    var closed = false;
    var retry = 0;
    var retryTimer = null;

    var self = {
      kind: 'net',
      playerId: store(STORE_ID) || null,
      code: null,
      connected: false
    };

    // Replayed after a reconnect so a dropped phone lands back in its seat.
    var rejoin = null;
    var handshaken = false;   // a hello has been answered at least once
    var pending = [];         // messages taken before the socket was ready

    function url() {
      var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + window.location.host + '/ws';
    }

    function open() {
      if (closed) { return; }
      try {
        ws = new WebSocket(url());
      } catch (e) {
        scheduleRetry();
        return;
      }

      ws.onopen = function () {
        retry = 0;
        self.connected = true;
        if (cb.onStatus) { cb.onStatus(true); }
        send({ t: 'hello', playerId: self.playerId });
        flush();
      };

      ws.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        receive(msg);
      };

      ws.onclose = function () {
        self.connected = false;
        if (cb.onStatus) { cb.onStatus(false); }
        scheduleRetry();
      };

      ws.onerror = function () { /* onclose does the work */ };
    }

    function scheduleRetry() {
      if (closed || retryTimer) { return; }
      retry = Math.min(retry + 1, 6);
      retryTimer = window.setTimeout(function () {
        retryTimer = null;
        open();
      }, Math.min(500 * retry, 4000));
    }

    function receive(msg) {
      switch (msg.t) {
        case 'hello':
          self.playerId = msg.playerId;
          store(STORE_ID, msg.playerId);
          if (cb.onHello) { cb.onHello(msg); }
          if (handshaken && rejoin && rejoin.code) {
            send({ t: 'join', code: rejoin.code, name: rejoin.name });
          }
          handshaken = true;
          break;
        case 'room':
          self.code = msg.code;
          if (rejoin) { rejoin.code = msg.code; }
          if (cb.onRoom) { cb.onRoom(msg); }
          break;
        case 'state':
          if (cb.onState) { cb.onState(msg.view); }
          break;
        case 'error':
          if (cb.onError) { cb.onError(msg.message); }
          break;
        case 'kicked':
          rejoin = null; self.code = null;
          if (cb.onKicked) { cb.onKicked(); }
          break;
        case 'left':
          rejoin = null; self.code = null;
          if (cb.onLeft) { cb.onLeft(); }
          break;
        case 'replaced':
          closed = true;
          if (cb.onReplaced) { cb.onReplaced(); }
          break;
      }
    }

    // A tap can land before the socket has finished connecting - pressing
    // "Create a table" does exactly that - so hold anything that cannot go out
    // yet and send it the moment the connection is up.
    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else if (!closed && pending.length < 20) {
        pending.push(msg);
      }
    }

    function flush() {
      var queued = pending;
      pending = [];
      queued.forEach(send);
    }

    self.start = open;

    self.create = function (opts) {
      store(STORE_NAME, opts.name);
      rejoin = { code: null, name: opts.name };
      send({ t: 'create', name: opts.name, mode: opts.mode, target: opts.target });
    };

    self.join = function (opts) {
      store(STORE_NAME, opts.name);
      rejoin = { code: opts.code, name: opts.name };
      send({ t: 'join', code: opts.code, name: opts.name });
    };

    self.leave = function () { rejoin = null; pending = []; send({ t: 'leave' }); };
    self.addBot = function () { send({ t: 'addBot' }); };
    self.kick = function (id) { send({ t: 'kick', id: id }); };
    self.options = function (o) { send({ t: 'options', mode: o.mode, target: o.target }); };
    self.startRound = function () { send({ t: 'start' }); };
    self.act = function (action) { send({ t: 'act', action: action }); };
    self.dispose = function () {
      closed = true;
      if (retryTimer) { window.clearTimeout(retryTimer); }
      if (ws) { ws.close(); }
    };

    return self;
  }

  /* ---------------------------------------------------------- local session */

  function createLocalSession(cb) {
    cb = cb || {};

    var match = null;
    var self = {
      kind: 'local',
      playerId: store(STORE_ID) || randomId(),
      code: null,
      connected: true
    };
    store(STORE_ID, self.playerId);

    function push() {
      if (cb.onState && match) { cb.onState(match.view(self.playerId)); }
    }

    function guard(res) {
      if (res && !res.ok && res.error && cb.onError) { cb.onError(res.error); }
      return res;
    }

    self.start = function () { if (cb.onStatus) { cb.onStatus(true); } };

    self.create = function (opts) {
      store(STORE_NAME, opts.name);
      if (match) { match.clearTimers(); }
      match = ns.createMatch({
        mode: opts.mode,
        target: opts.target,
        onUpdate: push
      });
      match.addSeat({ id: self.playerId, name: opts.name, kind: 'human' });
      if (cb.onRoom) { cb.onRoom({ code: null, urls: [] }); }
      push();
    };

    self.join = function () {
      if (cb.onError) { cb.onError('Offline play cannot join another table.'); }
    };

    self.leave = function () {
      if (match) { match.clearTimers(); match = null; }
      if (cb.onLeft) { cb.onLeft(); }
    };

    self.addBot = function () {
      if (match) { guard(match.addSeat({ id: 'bot-' + randomId(), kind: 'bot' })); }
    };

    self.kick = function (id) { if (match) { match.removeSeat(id); } };
    self.options = function (o) { if (match) { guard(match.setOptions(o)); } };
    self.startRound = function () { if (match) { guard(match.start()); } };
    self.act = function (action) {
      if (!match) { return; }
      var res = match.action(self.playerId, action);
      if (!res.ok && res.error && cb.onError) { cb.onError(res.error); }
      push();
    };
    self.dispose = function () { if (match) { match.clearTimers(); match = null; } };

    return self;
  }

  ns.session = {
    createNetSession: createNetSession,
    createLocalSession: createLocalSession,
    savedName: savedName,
    randomId: randomId
  };
})(window.UNO = window.UNO || {});
