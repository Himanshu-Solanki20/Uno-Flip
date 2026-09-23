/* ==========================================================================
   cards.js - deck construction, card faces and card metadata
   ========================================================================== */
(function (root, factory) {
  var ns = root.UNO || (root.UNO = {});
  factory(ns);
  if (typeof module === 'object' && module.exports) { module.exports = ns; }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ns) {
  'use strict';

  var LIGHT_COLORS = ['red', 'yellow', 'green', 'blue'];
  var DARK_COLORS  = ['pink', 'teal', 'orange', 'purple'];

  var COLOR_NAMES = {
    red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue',
    pink: 'Pink', teal: 'Teal', orange: 'Orange', purple: 'Purple'
  };

  var nextId = 1;

  /* ---------------------------------------------------------------- faces */

  // A face is one printed side of a card.
  //   type: number | skip | skipAll | reverse | draw | flip | wild | wildDraw
  function face(side, color, type, extra) {
    var f = {
      side: side,
      color: color,      // one of the eight colours, or 'wild'
      type: type,
      value: null,       // number cards only
      draw: 0,           // how many the next player draws
      drawMode: null     // 'count' | 'untilColor'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
    }
    return f;
  }

  /* Light side of an UNO FLIP! deck - 112 faces. */
  function lightFlipFaces() {
    var faces = [];
    LIGHT_COLORS.forEach(function (color) {
      for (var v = 1; v <= 9; v++) {
        faces.push(face('light', color, 'number', { value: v }));
        faces.push(face('light', color, 'number', { value: v }));
      }
      for (var i = 0; i < 2; i++) {
        faces.push(face('light', color, 'skip'));
        faces.push(face('light', color, 'reverse'));
        faces.push(face('light', color, 'draw', { draw: 1, drawMode: 'count' }));
        faces.push(face('light', color, 'flip'));
      }
    });
    for (var w = 0; w < 4; w++) {
      faces.push(face('light', 'wild', 'wild'));
      faces.push(face('light', 'wild', 'wildDraw', { draw: 2, drawMode: 'count' }));
    }
    return faces;
  }

  /* Dark side of an UNO FLIP! deck - 112 faces. */
  function darkFlipFaces() {
    var faces = [];
    DARK_COLORS.forEach(function (color) {
      for (var v = 1; v <= 9; v++) {
        faces.push(face('dark', color, 'number', { value: v }));
        faces.push(face('dark', color, 'number', { value: v }));
      }
      for (var i = 0; i < 2; i++) {
        faces.push(face('dark', color, 'skipAll'));
        faces.push(face('dark', color, 'reverse'));
        faces.push(face('dark', color, 'draw', { draw: 5, drawMode: 'count' }));
        faces.push(face('dark', color, 'flip'));
      }
    });
    for (var w = 0; w < 4; w++) {
      faces.push(face('dark', 'wild', 'wild'));
      faces.push(face('dark', 'wild', 'wildDraw', { drawMode: 'untilColor' }));
    }
    return faces;
  }

  /* Classic UNO - 108 faces. */
  function classicFaces() {
    var faces = [];
    LIGHT_COLORS.forEach(function (color) {
      faces.push(face('light', color, 'number', { value: 0 }));
      for (var v = 1; v <= 9; v++) {
        faces.push(face('light', color, 'number', { value: v }));
        faces.push(face('light', color, 'number', { value: v }));
      }
      for (var i = 0; i < 2; i++) {
        faces.push(face('light', color, 'skip'));
        faces.push(face('light', color, 'reverse'));
        faces.push(face('light', color, 'draw', { draw: 2, drawMode: 'count' }));
      }
    });
    for (var w = 0; w < 4; w++) {
      faces.push(face('light', 'wild', 'wild'));
      faces.push(face('light', 'wild', 'wildDraw', { draw: 4, drawMode: 'count' }));
    }
    return faces;
  }

  /* ---------------------------------------------------------------- decks */

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  // A card holds both printed sides. Classic cards have no dark side.
  function buildDeck(mode) {
    var cards = [];
    if (mode === 'classic') {
      classicFaces().forEach(function (f) {
        cards.push({ id: 'c' + (nextId++), light: f, dark: null });
      });
    } else {
      var light = lightFlipFaces();
      var dark  = shuffle(darkFlipFaces());     // a real deck has fixed light/dark
      for (var i = 0; i < light.length; i++) {  // pairings; a random pairing plays
        cards.push({                            // exactly the same way
          id: 'c' + (nextId++),
          light: light[i],
          dark: dark[i]
        });
      }
    }
    return shuffle(cards);
  }

  /* ------------------------------------------------------------ accessors */

  // The face that is currently showing, given the side the game is on.
  function activeFace(card, side) {
    return (side === 'dark' && card.dark) ? card.dark : card.light;
  }

  // The face that is currently hidden (null for a classic single-sided card).
  function hiddenFace(card, side) {
    return (side === 'dark' && card.dark) ? card.light : card.dark;
  }

  function isWild(f) {
    return f.type === 'wild' || f.type === 'wildDraw';
  }

  // Can this face be played on top of topFace while currentColor is in play?
  function facePlayable(f, topFace, currentColor) {
    if (isWild(f)) { return true; }
    if (f.color === currentColor) { return true; }
    if (f.type === 'number' && topFace.type === 'number') { return f.value === topFace.value; }
    if (f.type !== 'number' && f.type === topFace.type) { return true; }
    return false;
  }

  function points(f) {
    if (f.type === 'number') { return f.value; }
    if (f.type === 'wild') { return 40; }
    if (f.type === 'wildDraw') { return f.drawMode === 'untilColor' ? 60 : 50; }
    return f.side === 'dark' ? 30 : 20;   // skip / skipAll / reverse / draw / flip
  }

  /* -------------------------------------------------------------- display */

  function glyph(f) {
    switch (f.type) {
      case 'number':   return String(f.value);
      case 'skip':     return '⊘';          // circle with slash
      case 'skipAll':  return '⊘';
      case 'reverse':  return '⇄';          // left-right arrows
      case 'flip':     return '↻';          // clockwise open arrow
      case 'draw':     return '+' + f.draw;
      case 'wild':     return '✦';          // four-pointed star
      case 'wildDraw': return f.drawMode === 'untilColor' ? '+?' : '+' + f.draw;
      default:         return '?';
    }
  }

  function subLabel(f) {
    switch (f.type) {
      case 'skipAll':  return 'ALL';
      case 'flip':     return 'FLIP';
      case 'wild':     return 'WILD';
      case 'wildDraw': return 'WILD';
      default:         return '';
    }
  }

  function name(f) {
    var color = f.color === 'wild' ? '' : COLOR_NAMES[f.color] + ' ';
    switch (f.type) {
      case 'number':   return color + f.value;
      case 'skip':     return color + 'Skip';
      case 'skipAll':  return color + 'Skip Everyone';
      case 'reverse':  return color + 'Reverse';
      case 'flip':     return color + 'Flip';
      case 'draw':     return color + 'Draw ' + f.draw;
      case 'wild':     return 'Wild';
      case 'wildDraw': return f.drawMode === 'untilColor'
                              ? 'Wild Draw Colour'
                              : 'Wild Draw ' + (f.draw === 4 ? 'Four' : 'Two');
      default:         return 'Card';
    }
  }

  ns.cards = {
    LIGHT_COLORS: LIGHT_COLORS,
    DARK_COLORS: DARK_COLORS,
    COLOR_NAMES: COLOR_NAMES,
    colorsFor: function (side) { return side === 'dark' ? DARK_COLORS : LIGHT_COLORS; },
    buildDeck: buildDeck,
    shuffle: shuffle,
    activeFace: activeFace,
    hiddenFace: hiddenFace,
    isWild: isWild,
    facePlayable: facePlayable,
    points: points,
    glyph: glyph,
    subLabel: subLabel,
    name: name
  };
}));
