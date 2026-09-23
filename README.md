# UNO & UNO FLIP!

A complete browser implementation of **UNO** and **UNO FLIP!** in plain
HTML, CSS and JavaScript. No build step, no dependencies, no server —
double-click `index.html` and play.

## Playing

- **Mode** — Classic UNO (108 cards) or UNO FLIP! (112 double-sided cards)
- **Opponents** — 1 to 3 bots
- **Length** — a single round, or first to 300 / 500 points

Click a highlighted card to play it. Cards that do not match are dimmed.
If nothing matches, click the draw pile — if the card you draw is playable
you get the choice to play it or pass.

Shortcuts: <kbd>D</kbd> draw · <kbd>U</kbd> call UNO · <kbd>Esc</kbd> close a dialog

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
index.html        markup and the dialog panels
css/style.css     all styling, including both board themes
js/cards.js       deck construction, card faces, points, labels
js/game.js        the rules engine — all state, no DOM
js/ai.js          opponent heuristics
js/ui.js          rendering — all DOM, no rules
js/main.js        wiring, turn loop, timers, keyboard
```

The engine in `game.js` is completely independent of the interface: it takes
actions (`playCard`, `drawFromPile`, `chooseColor`, `callUno`) and exposes
state. That split is what makes it testable without a browser.

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

The rules engine is pure JavaScript with no DOM dependencies, so it can be
exercised from Node. During development it was run through 400 complete
bot-versus-bot rounds across both modes, checking on every turn that all 108
(or 112) cards are accounted for across hands, draw pile and discard pile,
that no bot plays an illegal card, and that every round terminates with a
winner holding an empty hand. The interface was driven end-to-end in jsdom —
dealing, playing, drawing, colour picking, flipping and finishing a round.
