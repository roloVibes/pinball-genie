// src/theme.ts — the canvas half of the palette.
//
// styles.css's :root block is the SINGLE SOURCE for this app's colours (see
// its own header comment). Canvas cannot read a CSS custom property:
// CanvasRenderingContext2D.fillStyle takes a colour string, and the render
// loop is not going to call getComputedStyle() every frame to look one up. So
// the few colours the 2D playfield renderers need are mirrored here as plain
// constants.
//
// MIRROR, NOT FORK. Each constant below has a matching custom property in
// styles.css, and app/tests/tokens.test.mjs asserts the two are the same hex.
// Change one without the other and the test suite fails — that is the whole
// point of this file existing instead of the literals sitting inline at the
// call sites (which is where they were until 2026-08-14, in four different
// places, drifting quietly).
//
// The nine goal-category colours are the same kind of mirror but live in
// overlay/drawing.ts's CATEGORY_COLOR, which was already parity-gated and
// stays where it is — its consumers are drawing.ts-internal.
//
// Consumers: overlay/map2d.ts (card gradient ×2, letterbox) and ui/study.ts
// (card gradient, floating-label halo, letterbox).

/** Behind the playfield card — the letterboxed area the card is centred in.
 *  Was `#050d1f`, ported from Playfield2DView.kt
 *  (`Canvas modifier.background(Color(0xFF050D1F))`). BACKGLASS (P5,
 *  2026-08-14) makes it exactly the APP's own background: the strip of canvas
 *  around the card is now the same colour as the chrome behind it, which is
 *  what turns "an app with a map in it" into one continuous backglass.
 *  Mirrors styles.css --canvas-letterbox (and --bg, deliberately the same
 *  value). */
export const CANVAS_LETTERBOX = '#0a0b10'

/** Playfield card fill, gradient stop 0 (top-left). Mirrors --card-gradient-a.
 *  BACKGLASS: was #081a38 — one step deeper in the same navy family. */
export const CARD_GRADIENT_A = '#071834'

/** Playfield card fill, gradient stop 1 (bottom-right). Mirrors --card-gradient-b.
 *  BACKGLASS: was #0d294d, which survives in fx/celebrate.ts as a CONFETTI
 *  palette entry only (four machine themes use that navy) — it is no longer a
 *  design token, and tokens.test.mjs says so. */
export const CARD_GRADIENT_B = '#0e2b52'

/** Halo painted behind a floating label on the playfield so the text stays
 *  legible over playfield art. Same navy as the letterbox at 0.9 alpha; NOT a
 *  mirror of a CSS token (no DOM element paints it), so no CSS side exists to
 *  compare against — it lives here purely so ui/study.ts's label call site and
 *  the card colours are configured from one file. Note map2d.ts/drawing.ts's
 *  own halos use 0.85, a deliberately different weight; they are not this. */
export const CANVAS_LABEL_HALO = 'rgba(5, 11, 24, 0.9)'
