# UNO & UNO FLIP!

A complete implementation of **UNO** and **UNO FLIP!** in plain HTML, CSS and
ES5 JavaScript. No build step and no framework — but there *is* a small Node
server, because the same game also plays across devices: deal a table on a
laptop and let a phone join it over the network or the internet.

## Running it

### 1. On one machine, against bots

Open `index.html` in a browser. Nothing to install — offline play against
1–3 bots works straight off the filesystem. Online play is hidden in this
mode, because a `file://` page cannot open a socket.

### 2. On your own network, with real people

```sh
npm install     # once — ws and qrcode
npm start       # http://localhost:3000
```

The banner prints a second address like `http://192.168.1.14:3000`. That is
the one other devices on the same Wi-Fi use. The host taps **Create**, reads
out the four-letter code (or shows the QR), and everyone else taps **Join**.

On iPhones, type the address by hand. Safari's autocomplete likes to turn it
into `https://`, which this local server does not speak.

`PORT` overrides the port.

### 3. On the internet

The server reads `PORT` from the environment, binds `0.0.0.0`, and the client
upgrades to `wss://` by itself whenever the page is served over HTTPS — so any
Node host will do, with no code changes. `render.yaml` is a ready blueprint for
[Render](https://render.com): push this repo to GitHub, pick **New → Blueprint**
in Render, and choose the repo.

Two things to know about a free instance: it goes to sleep after 15 idle
minutes, so the first player back waits about 50 seconds for it to boot, and
rooms live only in memory, so a sleep or a redeploy ends whatever game was
running. A single sitting is fine; a game left open overnight is not.

## Playing

- **Mode** — Classic UNO (108 cards) or UNO FLIP! (112 double-sided cards)
- **Opponents** — 1 to 3 bots, or real players, or a mix
- **Length** — a single round, or first to 300 / 500 points

Click a highlighted card to play it. Cards that do not match are dimmed.
If nothing matches, click the draw pile — if the card you draw is playable
you get the choice to play it or pass.

Shortcuts: <kbd>D</kbd> draw · <kbd>U</kbd> call UNO · <kbd>C</kbd> catch a
player who forgot · <kbd>M</kbd> mute · <kbd>Esc</kbd> close a dialog

## UNO FLIP!

Every card has a Light face and a Dark face. Play starts on the Light Side.
Playing a **Flip** card turns the draw pile, the discard pile and every hand
over to the Dark Side — the whole board re-themes and the cards in your hand
become something else entirely.

| Light Side | Dark Side |
| --- | --- |
| Draw One | **Draw Five** |
| Skip | **Skip Everyone** — play returns to you |
| Reverse | Reverse |
| Wild Draw Two | **Wild Draw Colour** — the next player draws until that colour turns up |
| Flip | Flip — back to the Light Side |

House rule: opponents' cards stay **face down** in both modes. The real
FLIP deck would let you see the other side of their cards, but this game
sends only a card count, so nobody learns anything about another hand.

## Scoring

The winner of a round scores the cards left in everyone else's hands:

| Card | Points |
| --- | --- |
| Number card | face value |
| Light action (Skip, Reverse, Draw One, Flip) | 20 |
| Dark action (Skip Everyone, Reverse, Draw Five, Flip) | 30 |
| Wild | 40 |
| Wild Draw Two / Wild Draw Four | 50 |
| Wild Draw Colour | 60 |

## Calling UNO

Play your second-to-last card and the **UNO!** button starts pulsing. You
have 3.5 seconds to hit it — miss the window and you draw two. The bots
mostly remember, but not always.

## Project layout

```
index.html          markup and the dialog panels
css/app.css         all styling, including both board themes

js/cards.js         deck construction, card faces, points, labels
js/game.js          the rules engine — all state, no DOM
js/ai.js            opponent heuristics
js/match.js         seats, rounds and the per-player redacted view

js/view.js          rendering — all DOM, no rules
js/app.js           wiring, routing, keyboard
js/session.js       one interface over a local game and a networked one
js/sound.js         Web Audio effects, no audio files

server/server.js    static host + authoritative multiplayer server
test/               engine and multiplayer suites
```

The first four `js/` files are the shared engine: the browser loads them with
`<script>` and `server/server.js` `require`s **the same files**, so a rule is
written once and both sides agree on it. That is why they stay ES5-flavoured
and free of any DOM reference.

`session.js` is what makes online and offline play identical to the rest of the
interface. `createNetSession` relays actions to the server over a WebSocket;
`createLocalSession` runs the same `match.js` in the tab against bots. Both
expose the same methods and emit the same per-player view, so `app.js` and
`view.js` never learn which one is live.

Nothing trusts the client. `match.js` is the only thing that ever sees every
hand; it builds a redacted view per player, and the server re-checks every
action against the real state before applying it.

## House rules used

A few places where real UNO is ambiguous or fiddly, and what this
implementation does:

- **Draw penalties do not stack.** A Draw Two cannot be answered with another
  Draw Two; the next player draws and is skipped.
- **Wild Draws can be challenged** (official rule). A Wild Draw Four, Two or
  Colour is only allowed while holding no card of the colour in play. The
  victim may take it or challenge: a bluffer draws the penalty instead, and a
  wrong challenger draws the penalty plus two and is skipped. Bots never bluff.
- **Forgetting UNO** (official rule): any other player can hit *Catch!* until
  the next player moves; the forgetful player draws two. Bots catch too.
- **Action starters act on the first player** (official rule). A Wild Draw
  starter is shuffled back; a Wild lets the first player choose the colour; a
  Flip starter turns the round over to the Dark Side.
- **Reverse acts as a Skip in a two-player game**, per the official rules.
- **A dry deck ends the round.** If a draw finds no card anywhere (every card
  but the top discard is in a hand), the lowest-scoring hand wins the round.

## Testing

```sh
npm test                    # the rules engine
node test/server.test.js    # rooms, sockets, redaction, reconnects
```

`npm test` runs hundreds of complete bot-versus-bot rounds across both modes,
checking on every turn that all 108 (or 112) cards are accounted for across
hands, draw pile and discard pile, that no bot plays an illegal card, and that
every round ends with a winner holding an empty hand.

The multiplayer suite is not part of `npm test` because it binds a port. It
starts a real server, connects real WebSockets, and checks that seats, rounds,
disconnects and rejoins behave — and that a socket is never sent a hand it is
not entitled to see.
