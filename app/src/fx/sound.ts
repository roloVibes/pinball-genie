// Port of: PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/fx/SoundSynth.kt
// (mirrors PinballGenieIOS/PinballGenie/FX/SoundSynth.swift)
// and the "Sound recipes" table in specs/FX-SPEC.md.
//
// Additive-synth sound engine. Renders each recipe's segment table offline
// into a mono 44.1kHz Float32 PCM buffer (same maths as the native
// `render()`), wraps it in an AudioBuffer, and plays it once per call via a
// fresh AudioBufferSourceNode. Buffers are cached per (recipe, tier) like the
// native `cache` map. AudioContext is created lazily on first call — call
// this from inside a user-gesture handler (button click) so autoplay
// policies don't block it.
//
// Deviation from native: FXTheme→recipe resolution is duplicated here as a
// small name→recipe map (native's `FXTheme.sound` field is defined once and
// read by the call site before calling SoundSynth.play(recipe, tier); the
// web fx/celebrate.ts and fx/sound.ts are separate contract files owned by
// the same agent but meant to be independently self-contained, so each
// carries its own copy of the FX-SPEC vocabulary table rather than importing
// across files).

type Wave = 'sine' | 'tri' | 'square' | 'noise'
type Env = 'decay' | 'triangle'

interface Segment {
  wave: Wave
  f0: number
  f1: number
  startMs: number
  durMs: number
  gain: number
  env?: Env // default 'decay'
}

export type CelebrationTierName = 'step' | 'goal'

// FX-SPEC "Tiers" — sound gain column.
const TIER_GAIN: Record<CelebrationTierName, number> = { step: 0.6, goal: 1.0 }

const SAMPLE_RATE = 44_100

// ---- FX-SPEC "Vocabulary" table, sound-recipe column only (name -> recipe id) ----
const THEME_SOUND: Record<string, string> = {
  shark: 'lowPulse',
  fin: 'lowPulse',
  raft: 'bounceArp',
  boat: 'horn',
  barrel: 'thudRoll',
  beach: 'gullWave',
  harpoon: 'whooshThunk',
  gear: 'ratchet',
  wave: 'swell',
  briefcase: 'shimmer',
  dance: 'funkRiff',
  car: 'engineRev',
  watch: 'tickChime',
  burger: 'sizzleDing',
  gun: 'doubleBang',
  cash: 'chaChing',
  crown: 'fanfare',
  sparkle: 'glissUp',
  kaiju: 'roar',
  heatray: 'zapBeam',
  mecha: 'engineRev',
  city: 'sirenStomp',
  monster: 'roar',
  moth: 'shimmer',
  military: 'doubleBang',
  train: 'horn',
  saucer: 'glissUp',
  pika: 'pikaChirp',
  pokeball: 'catchClick',
  balloon: 'swell',
  battle: 'doubleBang',
  badge: 'shimmer',
  evolve: 'glissUp',
  martian: 'theremin',
  cow: 'bounceArp',
  kong: 'roar',
  jungle: 'swell',
  demo: 'roar',
  upside: 'swell',
  eggo: 'sizzleDing',
  lights: 'tickChime',
  psychic: 'shimmer',
  deadite: 'roar',
  chainsaw: 'engineRev',
  tome: 'swell',
  ghost: 'swell',
  worm: 'thudRoll',
  beetle: 'funkRiff',
  dragon: 'roar',
  dice: 'bounceArp',
  quest: 'whooshThunk',
  magic: 'glissUp',
  coin: 'chaChing',
  dog: 'bounceArp',
  hotel: 'tickChime',
  guitar: 'powerChord',
  skull: 'powerChord',
  turtle: 'funkRiff',
  hero: 'fanfare',
  spider: 'whooshThunk',
  space: 'glissUp',
  cowboy: 'horn',
  castle: 'thudRoll',
  bone: 'ratchet',
  extreme: 'engineRev',
}

function ratchet(): Segment[] {
  const segs: Segment[] = []
  for (let i = 0; i < 6; i++) {
    segs.push({ wave: 'square', f0: 900, f1: 900, startMs: i * 90, durMs: 35, gain: 0.5 })
  }
  return segs
}

// ---- FX-SPEC "Sound recipes" segment tables — direct port of SoundSynth.kt buildRecipes() ----
const RECIPES: Record<string, Segment[]> = {
  lowPulse: [
    { wave: 'sine', f0: 82, f1: 82, startMs: 0, durMs: 220, gain: 1.0 },
    { wave: 'sine', f0: 87, f1: 87, startMs: 260, durMs: 220, gain: 1.0 },
    { wave: 'sine', f0: 82, f1: 82, startMs: 520, durMs: 200, gain: 0.9 },
    { wave: 'sine', f0: 87, f1: 87, startMs: 760, durMs: 320, gain: 0.8 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 900, durMs: 250, gain: 0.15 },
  ],
  bounceArp: [
    { wave: 'tri', f0: 330, f1: 330, startMs: 0, durMs: 120, gain: 0.7 },
    { wave: 'tri', f0: 392, f1: 392, startMs: 140, durMs: 120, gain: 0.7 },
    { wave: 'tri', f0: 494, f1: 494, startMs: 280, durMs: 120, gain: 0.7 },
    { wave: 'tri', f0: 659, f1: 659, startMs: 420, durMs: 200, gain: 0.7 },
  ],
  horn: [
    { wave: 'square', f0: 130, f1: 130, startMs: 0, durMs: 450, gain: 0.5 },
    { wave: 'square', f0: 196, f1: 196, startMs: 100, durMs: 350, gain: 0.35 },
  ],
  thudRoll: [
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 80, gain: 0.9 },
    { wave: 'sine', f0: 150, f1: 60, startMs: 0, durMs: 500, gain: 0.8 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 200, durMs: 500, gain: 0.2 },
  ],
  gullWave: [
    { wave: 'sine', f0: 1400, f1: 900, startMs: 0, durMs: 180, gain: 0.4 },
    { wave: 'sine', f0: 1500, f1: 950, startMs: 260, durMs: 180, gain: 0.35 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 300, durMs: 700, gain: 0.18 },
  ],
  whooshThunk: [
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 350, gain: 0.5 },
    { wave: 'sine', f0: 220, f1: 90, startMs: 380, durMs: 180, gain: 0.9 },
  ],
  ratchet: ratchet(),
  swell: [{ wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 900, gain: 0.5, env: 'triangle' }],
  shimmer: [
    { wave: 'sine', f0: 880, f1: 1760, startMs: 0, durMs: 700, gain: 0.4 },
    { wave: 'sine', f0: 1109, f1: 2217, startMs: 80, durMs: 620, gain: 0.3 },
    { wave: 'sine', f0: 1319, f1: 2637, startMs: 160, durMs: 540, gain: 0.25 },
  ],
  funkRiff: [
    { wave: 'tri', f0: 98, f1: 98, startMs: 0, durMs: 150, gain: 0.8 },
    { wave: 'tri', f0: 131, f1: 131, startMs: 180, durMs: 120, gain: 0.8 },
    { wave: 'tri', f0: 98, f1: 98, startMs: 330, durMs: 100, gain: 0.8 },
    { wave: 'tri', f0: 147, f1: 147, startMs: 460, durMs: 220, gain: 0.8 },
    { wave: 'square', f0: 3000, f1: 3000, startMs: 520, durMs: 40, gain: 0.2 },
  ],
  engineRev: [
    { wave: 'square', f0: 70, f1: 240, startMs: 0, durMs: 600, gain: 0.6 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 650, gain: 0.2 },
    { wave: 'square', f0: 240, f1: 180, startMs: 620, durMs: 220, gain: 0.5 },
  ],
  tickChime: [
    { wave: 'square', f0: 1800, f1: 1800, startMs: 0, durMs: 30, gain: 0.4 },
    { wave: 'square', f0: 1800, f1: 1800, startMs: 250, durMs: 30, gain: 0.4 },
    { wave: 'sine', f0: 1319, f1: 1319, startMs: 500, durMs: 500, gain: 0.5 },
  ],
  sizzleDing: [
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 500, gain: 0.35 },
    { wave: 'sine', f0: 1568, f1: 1568, startMs: 550, durMs: 350, gain: 0.6 },
  ],
  doubleBang: [
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 140, gain: 1.0 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 220, durMs: 180, gain: 0.8 },
    { wave: 'sine', f0: 180, f1: 60, startMs: 0, durMs: 200, gain: 0.7 },
  ],
  chaChing: [
    { wave: 'square', f0: 2093, f1: 2093, startMs: 0, durMs: 50, gain: 0.5 },
    { wave: 'tri', f0: 1319, f1: 1319, startMs: 80, durMs: 120, gain: 0.5 },
    { wave: 'tri', f0: 1568, f1: 1568, startMs: 220, durMs: 120, gain: 0.5 },
    { wave: 'tri', f0: 2093, f1: 2093, startMs: 360, durMs: 260, gain: 0.6 },
  ],
  fanfare: [
    { wave: 'tri', f0: 523, f1: 523, startMs: 0, durMs: 180, gain: 0.8 },
    { wave: 'tri', f0: 659, f1: 659, startMs: 200, durMs: 180, gain: 0.8 },
    { wave: 'tri', f0: 784, f1: 784, startMs: 400, durMs: 180, gain: 0.8 },
    { wave: 'tri', f0: 1047, f1: 1047, startMs: 600, durMs: 500, gain: 0.8 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 580, durMs: 300, gain: 0.12 },
  ],
  glissUp: [
    { wave: 'sine', f0: 523, f1: 2093, startMs: 0, durMs: 550, gain: 0.5 },
    { wave: 'sine', f0: 1047, f1: 4186, startMs: 150, durMs: 400, gain: 0.25 },
  ],
  roar: [
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 650, gain: 0.35 },
    { wave: 'sine', f0: 110, f1: 65, startMs: 0, durMs: 700, gain: 0.9 },
    { wave: 'square', f0: 55, f1: 48, startMs: 150, durMs: 550, gain: 0.4 },
  ],
  zapBeam: [
    { wave: 'square', f0: 220, f1: 1760, startMs: 0, durMs: 450, gain: 0.45 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 460, durMs: 300, gain: 0.6 },
    { wave: 'sine', f0: 1760, f1: 880, startMs: 460, durMs: 280, gain: 0.5 },
  ],
  sirenStomp: [
    { wave: 'sine', f0: 600, f1: 950, startMs: 0, durMs: 350, gain: 0.5 },
    { wave: 'sine', f0: 950, f1: 600, startMs: 350, durMs: 350, gain: 0.5 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 700, durMs: 120, gain: 0.9 },
    { wave: 'sine', f0: 140, f1: 50, startMs: 700, durMs: 260, gain: 0.9 },
  ],
  pikaChirp: [
    { wave: 'tri', f0: 1047, f1: 1568, startMs: 0, durMs: 120, gain: 0.6 },
    { wave: 'tri', f0: 1568, f1: 2093, startMs: 150, durMs: 160, gain: 0.6 },
    { wave: 'square', f0: 2637, f1: 2637, startMs: 340, durMs: 60, gain: 0.3 },
  ],
  catchClick: [
    { wave: 'sine', f0: 220, f1: 180, startMs: 0, durMs: 120, gain: 0.7 },
    { wave: 'sine', f0: 220, f1: 180, startMs: 260, durMs: 120, gain: 0.7 },
    { wave: 'sine', f0: 220, f1: 180, startMs: 520, durMs: 120, gain: 0.7 },
    { wave: 'tri', f0: 1568, f1: 1568, startMs: 700, durMs: 300, gain: 0.6 },
  ],
  theremin: [
    { wave: 'sine', f0: 440, f1: 880, startMs: 0, durMs: 300, gain: 0.5 },
    { wave: 'sine', f0: 880, f1: 660, startMs: 300, durMs: 250, gain: 0.5 },
    { wave: 'sine', f0: 660, f1: 990, startMs: 550, durMs: 300, gain: 0.45 },
  ],
  powerChord: [
    { wave: 'square', f0: 82, f1: 82, startMs: 0, durMs: 400, gain: 0.7 },
    { wave: 'square', f0: 110, f1: 110, startMs: 0, durMs: 400, gain: 0.5 },
    { wave: 'square', f0: 165, f1: 165, startMs: 0, durMs: 400, gain: 0.35 },
    { wave: 'noise', f0: 0, f1: 0, startMs: 0, durMs: 80, gain: 0.4 },
    { wave: 'square', f0: 82, f1: 82, startMs: 450, durMs: 350, gain: 0.6 },
  ],
}

// Modest master volume applied on top of the recipe's own -1..1 scaling —
// the native AudioTrack plays at raw system volume; a browser tab firing
// full-scale synth blasts on every goal completion is unpleasant, so we trim
// it down here (contract: "volume modest").
const MASTER_GAIN = 0.55

// ---- Offline render (direct port of SoundSynth.kt render()) ----
function renderRecipe(segments: Segment[], tierGain: number): Float32Array {
  const totalMs = segments.reduce((m, s) => Math.max(m, s.startMs + s.durMs), 0)
  const totalSamples = Math.max(1, Math.round((totalMs / 1000 + 0.05) * SAMPLE_RATE)) // +50ms tail
  const buf = new Float32Array(totalSamples)
  const attackSamplesFull = Math.round(0.01 * SAMPLE_RATE) // 10ms attack

  for (const seg of segments) {
    const startSample = Math.round((seg.startMs / 1000) * SAMPLE_RATE)
    const segSamples = Math.round((seg.durMs / 1000) * SAMPLE_RATE)
    if (segSamples <= 0) continue
    const dur = seg.durMs / 1000
    const attack = Math.min(attackSamplesFull, segSamples)
    let phase = 0

    for (let n = 0; n < segSamples; n++) {
      const idx = startSample + n
      if (idx < 0 || idx >= buf.length) continue
      const localT = n / SAMPLE_RATE
      const progress = Math.min(localT / dur, 1)
      const freq = seg.f0 + (seg.f1 - seg.f0) * progress

      let s: number
      switch (seg.wave) {
        case 'sine':
          s = Math.sin(phase)
          break
        case 'tri':
          s = (2 / Math.PI) * Math.asin(Math.sin(phase))
          break
        case 'square':
          s = Math.sin(phase) >= 0 ? 1 : -1
          break
        case 'noise':
          s = Math.random() * 2 - 1
          break
      }
      phase += (2 * Math.PI * freq) / SAMPLE_RATE

      let env: number
      if (seg.env === 'triangle') {
        env = 1 - Math.abs(2 * progress - 1)
      } else if (n < attack) {
        env = n / Math.max(attack, 1)
      } else {
        const p = (n - attack) / Math.max(segSamples - attack, 1)
        env = Math.exp(-3 * p) * (1 - p) // exponential-ish, hits 0 at end
      }
      buf[idx] += s * env * seg.gain
    }
  }

  const scale = tierGain * 0.8
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i] * scale
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v
  }
  return out
}

let ctx: AudioContext | null = null
const bufferCache = new Map<string, AudioBuffer>()

/**
 * Lazily create/resume the shared AudioContext. Call only from a user-gesture
 * chain. Returns null when the browser exposes neither `AudioContext` nor
 * `webkitAudioContext` (no real target browser lacks both, but callers must
 * not assume a non-null result) — callers no-op in that case rather than
 * letting `new Ctor()` throw on an undefined constructor.
 */
function getContext(): AudioContext | null {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/**
 * iOS/Safari WebAudio unlock: creates/resumes the shared AudioContext (via
 * getContext(), same instance playCelebration uses) and plays a 1-sample
 * silent buffer through it. Must be called from inside a user-gesture chain
 * (pointerdown/touchend/click) — see main.ts's one-time first-gesture
 * listener. Safe to call repeatedly; a no-op once the context is already
 * running (getContext() only creates once, and resume() on an already-
 * running context is a cheap no-op per spec).
 */
export function primeAudio(): void {
  const audioCtx = getContext()
  if (!audioCtx) return
  const buffer = audioCtx.createBuffer(1, 1, SAMPLE_RATE)
  const src = audioCtx.createBufferSource()
  src.buffer = buffer
  src.connect(audioCtx.destination)
  src.start()
}

/**
 * Play the celebration jingle for an fx theme (resolved to a sound recipe
 * per the FX-SPEC vocabulary table). `theme` null/undefined/unknown falls
 * back to `sparkle`'s recipe (glissUp), matching FXTheme.resolve(). `tier`
 * defaults to 'goal' — the only tier the web app fires (see fx/celebrate.ts
 * header comment on the trigger contract).
 */
export function playCelebration(theme?: string | null, tier: CelebrationTierName = 'goal'): void {
  const recipeName = (theme && THEME_SOUND[theme]) || THEME_SOUND.sparkle
  const segments = RECIPES[recipeName]
  if (!segments) return

  const audioCtx = getContext()
  if (!audioCtx) return
  const key = `${recipeName}-${tier}`
  let buffer = bufferCache.get(key)
  if (!buffer) {
    const pcm = renderRecipe(segments, TIER_GAIN[tier])
    buffer = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE)
    buffer.getChannelData(0).set(pcm)
    bufferCache.set(key, buffer)
  }

  const src = audioCtx.createBufferSource()
  src.buffer = buffer
  const gainNode = audioCtx.createGain()
  gainNode.gain.value = MASTER_GAIN
  src.connect(gainNode).connect(audioCtx.destination)
  src.start()
}
