// Port of: PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/fx/
//   FXTheme.kt (vocabulary table), CelebrationEngine.kt (fire/tier/dedupe
//   rules), CelebrationLayer.kt (particle + sprite motion maths, banner).
// (mirrors PinballGenieIOS/PinballGenie/FX/{FXTheme,CelebrationEngine,
// CelebrationLayer}.swift — both native platforms implement the identical
// FX-SPEC table). Spec: specs/FX-SPEC.md.
//
// Trigger contract (FX-SPEC "Trigger contract", STATUS 2026-07-08): ball
// tracking / step-hit celebrations are REMOVED on both native platforms —
// the only remaining trigger is manual goal completion, which always fires
// the GOAL tier (2200ms / 60 particles / 10 sprites). This port hardcodes
// the GOAL tier for the same reason; there is no reachable STEP-tier call
// site in the web app either.
//
// Deviation from CONTRACTS.md signature `celebrate(host, fxTheme)`: an
// optional third `opts.bannerText` param was added (backward compatible —
// existing 2-arg calls are unaffected) so the integrator can pass the
// completed goal's title for the native-parity "<TITLE> COMPLETE!" banner;
// omit it and a generic "COMPLETE!" banner is shown instead.
//
// `opts.showBanner` (default true) additionally lets a caller that already
// surfaces its own on-screen completion text suppress this banner and keep
// only the particles/sprites/sound — DESIGN-NOTES §2.6 specs celebration as
// ONE completion message (particle burst + a single top-center toast pill),
// not this banner AND a caller's own toast stacked on top of each other.
// ar/arview.ts's AR toast pill passes `showBanner:false` for this reason;
// app.ts's non-AR goal-detail view has no separate completion text, so it
// keeps the default and is unaffected.

import { playCelebration } from './sound'

type MotionPattern = 'swim' | 'burst' | 'rain' | 'spin' | 'rise'

interface FXThemeDef {
  glyphs: string[]
  palette: string[] // CSS colors, particle order
  motion: MotionPattern
}

// FX-SPEC "Vocabulary" table — mirrors FXTheme.kt's `table` EXACTLY
// (glyphs, palette, motion; the `sound` column lives in fx/sound.ts).
const THEMES: Record<string, FXThemeDef> = {
  shark: { glyphs: ['🦈', '🦈', '🌊'], palette: ['#32ADE6', '#E8ECF2'], motion: 'swim' },
  fin: { glyphs: ['🦈', '🌊'], palette: ['#32ADE6', '#0D294D'], motion: 'swim' },
  raft: { glyphs: ['🛟', '🌊'], palette: ['#FF9500', '#32ADE6'], motion: 'rise' },
  boat: { glyphs: ['🚤', '⚓', '🌊'], palette: ['#E8ECF2', '#32ADE6'], motion: 'swim' },
  barrel: { glyphs: ['🛢️', '💥'], palette: ['#FFCC00', '#FF3B30'], motion: 'rain' },
  beach: { glyphs: ['🏖️', '⛱️', '🌊'], palette: ['#FFCC00', '#32ADE6'], motion: 'rise' },
  harpoon: { glyphs: ['🔱', '💨'], palette: ['#E8ECF2', '#34C759'], motion: 'burst' },
  gear: { glyphs: ['⚙️', '🔧'], palette: ['#E8ECF2', '#FF9500'], motion: 'spin' },
  wave: { glyphs: ['🌊', '💦'], palette: ['#32ADE6', '#00C7BE'], motion: 'rise' },
  briefcase: { glyphs: ['💼', '✨'], palette: ['#FFCC00', '#FF9500'], motion: 'burst' },
  dance: { glyphs: ['🕺', '💃', '🪩'], palette: ['#AF52DE', '#FFCC00'], motion: 'spin' },
  car: { glyphs: ['🚗', '💨', '🔥'], palette: ['#FF3B30', '#FF9500'], motion: 'swim' },
  watch: { glyphs: ['⌚', '✨'], palette: ['#FFCC00', '#E8ECF2'], motion: 'spin' },
  burger: { glyphs: ['🍔', '🍟', '✨'], palette: ['#FF9500', '#FFCC00'], motion: 'rain' },
  gun: { glyphs: ['🔫', '💥'], palette: ['#FF3B30', '#FFCC00'], motion: 'burst' },
  cash: { glyphs: ['💵', '💰', '🪙'], palette: ['#34C759', '#FFCC00'], motion: 'rain' },
  crown: { glyphs: ['👑', '🏆', '✨'], palette: ['#FFCC00', '#AF52DE'], motion: 'burst' },
  sparkle: { glyphs: ['✨', '⭐', '💫'], palette: ['#FFCC00', '#32ADE6'], motion: 'burst' },
  kaiju: { glyphs: ['🦖', '🔥', '💥'], palette: ['#34C759', '#FF9500'], motion: 'swim' },
  heatray: { glyphs: ['⚡', '🔥', '☢️'], palette: ['#32ADE6', '#AF52DE'], motion: 'burst' },
  mecha: { glyphs: ['🤖', '⚡', '💥'], palette: ['#E8ECF2', '#FF3B30'], motion: 'burst' },
  city: { glyphs: ['🏙️', '💥', '🔥'], palette: ['#FF9500', '#FF3B30'], motion: 'rain' },
  monster: { glyphs: ['🐉', '👾', '⚡'], palette: ['#FFCC00', '#AF52DE'], motion: 'burst' },
  moth: { glyphs: ['🦋', '✨'], palette: ['#00C7BE', '#FFCC00'], motion: 'rise' },
  military: { glyphs: ['🚁', '🚀', '💥'], palette: ['#34C759', '#FF3B30'], motion: 'burst' },
  train: { glyphs: ['🚆', '⚡', '💨'], palette: ['#FFCC00', '#32ADE6'], motion: 'swim' },
  saucer: { glyphs: ['🛸', '👾', '✨'], palette: ['#34C759', '#AF52DE'], motion: 'spin' },
  pika: { glyphs: ['⚡', '⭐', '✨'], palette: ['#FFCC00', '#FF9500'], motion: 'burst' },
  pokeball: { glyphs: ['🔴', '⚪', '✨'], palette: ['#FF3B30', '#E8ECF2'], motion: 'spin' },
  balloon: { glyphs: ['🎈', '💨', '✨'], palette: ['#AF52DE', '#FF3B30'], motion: 'rise' },
  battle: { glyphs: ['⚔️', '💥', '🔥'], palette: ['#FF3B30', '#FFCC00'], motion: 'burst' },
  badge: { glyphs: ['🏅', '⭐', '✨'], palette: ['#FFCC00', '#32ADE6'], motion: 'spin' },
  evolve: { glyphs: ['💫', '🌟', '✨'], palette: ['#AF52DE', '#00C7BE'], motion: 'rise' },
  martian: { glyphs: ['👽', '💥', '✨'], palette: ['#34C759', '#AF52DE'], motion: 'spin' },
  cow: { glyphs: ['🐄', '💫', '✨'], palette: ['#E8ECF2', '#34C759'], motion: 'rise' },
  kong: { glyphs: ['🦍', '💥', '🔥'], palette: ['#FF9500', '#34C759'], motion: 'swim' },
  jungle: { glyphs: ['🌴', '🐍', '🌿'], palette: ['#34C759', '#00C7BE'], motion: 'rise' },
  demo: { glyphs: ['👹', '🕷️', '💥'], palette: ['#FF3B30', '#0D294D'], motion: 'burst' },
  upside: { glyphs: ['🌀', '👾', '🌫️'], palette: ['#AF52DE', '#32ADE6'], motion: 'rain' },
  eggo: { glyphs: ['🧇', '⭐', '✨'], palette: ['#FFCC00', '#FF9500'], motion: 'rain' },
  lights: { glyphs: ['💡', '🎄', '✨'], palette: ['#FF3B30', '#FFCC00'], motion: 'spin' },
  psychic: { glyphs: ['🧠', '💫', '✨'], palette: ['#AF52DE', '#00C7BE'], motion: 'burst' },
  deadite: { glyphs: ['🧟', '💀', '💥'], palette: ['#34C759', '#FF3B30'], motion: 'burst' },
  chainsaw: { glyphs: ['🪚', '💥', '🔥'], palette: ['#FF3B30', '#E8ECF2'], motion: 'spin' },
  tome: { glyphs: ['📖', '💀', '✨'], palette: ['#AF52DE', '#FF3B30'], motion: 'rise' },
  ghost: { glyphs: ['👻', '💫', '✨'], palette: ['#AF52DE', '#34C759'], motion: 'rise' },
  worm: { glyphs: ['🪱', '🌀', '💥'], palette: ['#E8ECF2', '#AF52DE'], motion: 'swim' },
  beetle: { glyphs: ['🪲', '👻', '✨'], palette: ['#34C759', '#AF52DE'], motion: 'spin' },
  dragon: { glyphs: ['🐉', '🔥', '💥'], palette: ['#FF3B30', '#34C759'], motion: 'swim' },
  dice: { glyphs: ['🎲', '✨', '⭐'], palette: ['#FF3B30', '#E8ECF2'], motion: 'spin' },
  quest: { glyphs: ['⚔️', '🛡️', '✨'], palette: ['#E8ECF2', '#FFCC00'], motion: 'burst' },
  magic: { glyphs: ['🔮', '✨', '💫'], palette: ['#AF52DE', '#32ADE6'], motion: 'rise' },
  coin: { glyphs: ['🪙', '✨', '💰'], palette: ['#FFCC00', '#E8ECF2'], motion: 'rain' },
  dog: { glyphs: ['🐕', '⭐', '✨'], palette: ['#FF9500', '#E8ECF2'], motion: 'swim' },
  hotel: { glyphs: ['🏨', '🔑', '✨'], palette: ['#FFCC00', '#0D294D'], motion: 'rise' },
  guitar: { glyphs: ['🎸', '⚡', '✨'], palette: ['#FF3B30', '#AF52DE'], motion: 'burst' },
  skull: { glyphs: ['💀', '⚡', '🔥'], palette: ['#E8ECF2', '#FF3B30'], motion: 'burst' },
  turtle: { glyphs: ['🐢', '🍕', '💥'], palette: ['#34C759', '#FF9500'], motion: 'swim' },
  hero: { glyphs: ['🦸', '💥', '⭐'], palette: ['#FF3B30', '#32ADE6'], motion: 'burst' },
  spider: { glyphs: ['🕷️', '🕸️', '💥'], palette: ['#0D294D', '#FF3B30'], motion: 'rain' },
  space: { glyphs: ['🚀', '⭐', '🌌'], palette: ['#32ADE6', '#AF52DE'], motion: 'rise' },
  cowboy: { glyphs: ['🤠', '🌵', '⭐'], palette: ['#FF9500', '#FFCC00'], motion: 'swim' },
  castle: { glyphs: ['🏰', '🔥', '⚔️'], palette: ['#AF52DE', '#FF9500'], motion: 'rain' },
  bone: { glyphs: ['🦴', '💀', '✨'], palette: ['#E8ECF2', '#00C7BE'], motion: 'rain' },
  extreme: { glyphs: ['🏍️', '💨', '🔥'], palette: ['#FF3B30', '#FFCC00'], motion: 'swim' },
}

/** Resolve an fx name to its theme; unknown/missing -> `sparkle` (FX-SPEC). */
function resolveTheme(name: string | null | undefined): FXThemeDef {
  return (name && THEMES[name]) || THEMES.sparkle
}

// FX-SPEC "Tiers" — GOAL column only; see header comment on why STEP is unreachable.
const TIER = {
  durationMs: 2200,
  particleCount: 60,
  spriteCount: 10,
  spriteSizePx: 34,
  bannerFontPx: 28,
}

export interface CelebrateOpts {
  /** Completed goal's title; rendered as "<TITLE> COMPLETE!" (native banner
   *  format). Omit for a generic "COMPLETE!" banner. Ignored when
   *  `showBanner` is false. */
  bannerText?: string
  /** Draw the fading full-screen title banner. Default true (omitting this
   *  field reproduces the exact prior behavior). Set false when the caller
   *  already shows its own completion text, so only particles/sprites/sound
   *  play — see the file header's DESIGN-NOTES §2.6 note. */
  showBanner?: boolean
}

// Module-level guard: a goal celebration still playing wins over a re-fire,
// so mashing the completion control can't stack fanfares/audio (native
// parity: CelebrationEngine.fire()'s GOAL-vs-GOAL dedupe check).
let activeUntil = 0

/**
 * Fire a full-viewport celebration: emoji sprites + particle burst per the
 * resolved theme's motion pattern, plus a fading banner, plus the theme's
 * synthesized jingle (fx/sound.ts). Mounts a `position:fixed` canvas as a
 * child of `host`, sized to the viewport and DPR-aware; the canvas removes
 * itself when the tier duration elapses. Safe to call repeatedly — calls
 * that land while a celebration is already in flight are ignored.
 */
export function celebrate(host: HTMLElement, fxTheme: string | null, opts?: CelebrateOpts): void {
  const now = performance.now()
  if (now < activeUntil) return
  activeUntil = now + TIER.durationMs

  const theme = resolveTheme(fxTheme)
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const showBanner = opts?.showBanner !== false
  const bannerText = opts?.bannerText ? `${opts.bannerText.toUpperCase()} COMPLETE!` : 'COMPLETE!'
  const bannerColor = theme.palette[0]

  playCelebration(fxTheme, 'goal')

  const canvas = document.createElement('canvas')
  canvas.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;'
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    canvas.remove()
    return
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  function resize(): void {
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)
    canvas.style.width = `${window.innerWidth}px`
    canvas.style.height = `${window.innerHeight}px`
  }
  resize()
  window.addEventListener('resize', resize)

  // Origin: center of the host element (falls back to viewport center when
  // host isn't laid out yet), clamped on-screen. The native engine takes an
  // explicit tap-point origin; the web contract's celebrate(host, fxTheme)
  // has no such param, so the host's own center is the closest analog.
  const hostRect = host.getBoundingClientRect()
  const origin = {
    x: hostRect.width > 0 ? hostRect.left + hostRect.width / 2 : window.innerWidth / 2,
    y: hostRect.height > 0 ? hostRect.top + hostRect.height / 2 : window.innerHeight * 0.42,
  }

  let raf = 0
  const startTime = performance.now()

  function cleanup(): void {
    if (raf) cancelAnimationFrame(raf)
    window.removeEventListener('resize', resize)
    canvas.remove()
  }

  if (reduceMotion) {
    // Respect prefers-reduced-motion: no particle/sprite animation, just a
    // brief flash + the banner (when shown), then remove.
    drawReducedMotionFlash(ctx, dpr, canvas, bannerColor, bannerText, showBanner)
    window.setTimeout(cleanup, 600)
    return
  }

  function frame(t: number): void {
    const elapsedMs = t - startTime
    const tt = elapsedMs / TIER.durationMs
    if (tt >= 1) {
      cleanup()
      return
    }
    const w = window.innerWidth
    const h = window.innerHeight
    ctx!.save()
    ctx!.scale(dpr, dpr)
    ctx!.clearRect(0, 0, w, h)
    drawParticles(ctx!, theme, origin, tt)
    drawSprites(ctx!, theme, origin, tt, w, h)
    if (showBanner) drawBanner(ctx!, bannerColor, bannerText, elapsedMs, w, h)
    ctx!.restore()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
}

// ---- Particles (FX-SPEC: radial burst, gravity except swim/rise) ----

function drawParticles(
  ctx: CanvasRenderingContext2D,
  theme: FXThemeDef,
  origin: { x: number; y: number },
  t: number,
): void {
  const count = TIER.particleCount
  const durationSec = TIER.durationMs / 1000
  const elapsedSec = t * durationSec
  const gravity = theme.motion === 'swim' || theme.motion === 'rise' ? 0 : 180
  const alpha = Math.max(0, 1 - t / 0.8) // fade out by t = 0.8
  if (alpha <= 0.01) return

  for (let j = 0; j < count; j++) {
    const angle = rnd(j, 0xa1) * 2 * Math.PI
    const speed = 60 + rnd(j, 0xb2) * 160 // 60-220 px/s
    const radius = 2 + rnd(j, 0xc3) * 3 // 2-5 px
    const x = origin.x + Math.cos(angle) * speed * elapsedSec
    const y = origin.y + (Math.sin(angle) * speed * elapsedSec + 0.5 * gravity * elapsedSec * elapsedSec)
    ctx.globalAlpha = alpha
    ctx.fillStyle = theme.palette[j % theme.palette.length]
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ---- Sprites (FX-SPEC motion patterns) ----

function drawSprites(
  ctx: CanvasRenderingContext2D,
  theme: FXThemeDef,
  origin: { x: number; y: number },
  t: number,
  w: number,
  h: number,
): void {
  const count = TIER.spriteCount
  const ease = 1 - (1 - t) * (1 - t) // ease-out
  const spriteAlpha = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3) // fade last 30%
  if (spriteAlpha <= 0.01) return

  for (let i = 0; i < count; i++) {
    const glyph = theme.glyphs[i % theme.glyphs.length]
    let px = origin.x
    let py = origin.y
    let scale = 1
    let rotationDeg = 0

    switch (theme.motion) {
      case 'swim': {
        const stagger = (rnd(i, 0x11) * 2 - 1) * 60
        const yBase = origin.y + stagger
        const even = i % 2 === 0
        const startX = even ? -40 : w + 40
        const endX = even ? w + 40 : -40
        px = startX + (endX - startX) * ease
        py = yBase + Math.sin(t * 2 * 2 * Math.PI + rnd(i, 0x12) * 2 * Math.PI) * 12
        scale = 1 + 0.08 * Math.sin(t * 4 * Math.PI)
        break
      }
      case 'burst': {
        const angle = rnd(i, 0x21) * 2 * Math.PI
        const dist = 90 + rnd(i, 0x22) * 80 // 90-170 px
        const r = dist * ease
        px = origin.x + Math.cos(angle) * r
        py = origin.y + Math.sin(angle) * r
        const sign = rnd(i, 0x23) < 0.5 ? -1 : 1
        rotationDeg = sign * 40 * t
        break
      }
      case 'rain': {
        const baseX = origin.x + (rnd(i, 0x31) * 2 - 1) * 140
        const startY = -40
        const endY = origin.y + 200 // falls past origin.y + 160
        py = startY + (endY - startY) * t
        px = baseX + Math.sin(t * 3 * Math.PI + rnd(i, 0x32) * 2 * Math.PI) * 16
        break
      }
      case 'spin': {
        const radius = 40 + (90 - 40) * t
        const angle = (2 * Math.PI * i) / count + t * 1.5 * 2 * Math.PI
        px = origin.x + Math.cos(angle) * radius
        py = origin.y + Math.sin(angle) * radius
        break
      }
      case 'rise': {
        const baseX = origin.x + (rnd(i, 0x41) * 2 - 1) * 120
        const startY = origin.y + 120
        const endY = startY - 180 // floats up 180
        py = startY + (endY - startY) * ease
        px = baseX + Math.sin(t * 3 * Math.PI + rnd(i, 0x42) * 2 * Math.PI) * 16
        break
      }
    }

    drawSprite(ctx, glyph, px, py, TIER.spriteSizePx, scale, rotationDeg, spriteAlpha)
  }
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  sizePx: number,
  scale: number,
  rotationDeg: number,
  alpha: number,
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  if (rotationDeg) ctx.rotate((rotationDeg * Math.PI) / 180)
  if (scale !== 1) ctx.scale(scale, scale)
  ctx.font = `${sizePx}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(glyph, 0, 0)
  ctx.restore()
}

// ---- Banner ----

function drawBanner(
  ctx: CanvasRenderingContext2D,
  color: string,
  text: string,
  elapsedMs: number,
  w: number,
  h: number,
): void {
  const durationSec = TIER.durationMs / 1000
  const elapsed = elapsedMs / 1000
  const fadeIn = Math.min(elapsed / 0.15, 1)
  const fadeOut = Math.min(Math.max(durationSec - elapsed, 0) / 0.4, 1)
  const alpha = Math.min(fadeIn, fadeOut)
  if (alpha <= 0.01) return

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `bold ${TIER.bannerFontPx}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  ctx.fillStyle = color
  ctx.fillText(text, w / 2, h * 0.3)
  ctx.restore()
}

// ---- Reduced-motion fallback: subtle flash + static banner, no particles/sprites ----

function drawReducedMotionFlash(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  canvas: HTMLCanvasElement,
  color: string,
  bannerText: string,
  showBanner: boolean,
): void {
  const w = window.innerWidth
  const h = window.innerHeight
  const start = performance.now()
  const flashMs = 600

  function frame(t: number): void {
    const elapsed = t - start
    const p = Math.min(elapsed / flashMs, 1)
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    ctx.globalAlpha = 0.28 * (1 - p)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
    if (showBanner) drawBanner(ctx, color, bannerText, elapsed, w, h)
    if (p < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// ---- Deterministic per-index randomness (stable across redraws for a given index+salt) ----

function rnd(i: number, salt: number): number {
  let x = Math.imul(i + salt, 2654435761) // Knuth multiplicative hash
  x = Math.imul(x ^ (x >>> 16), 2246822519)
  x = Math.imul(x ^ (x >>> 13), 3266489917)
  x = (x ^ (x >>> 16)) >>> 0
  return x / 4294967296
}
