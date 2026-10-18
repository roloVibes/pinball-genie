// Standalone leading-glyph lookup for goal rows (app.ts's renderGoalRow,
// ar/arview.ts's buildGoalRow, and the new Map goal sheet).
//
// This is a DELIBERATE, standalone duplicate of fx/celebrate.ts's THEMES
// table (glyphs[0] per theme + the 'sparkle' fallback) — not an import of
// celebrate.ts. Per design_handoff_shot_coach/README.md's "State" section
// ("Deliberately removed: celebrations") and shotcoach-corrections.md #11:
// celebrations are removed from the product (fx/celebrate.ts + fx/sound.ts
// stay on disk, unimported by anything, same pattern as ar/quaddetect.ts) —
// importing celebrate.ts here just to read its glyph table would pull a
// celebration-triggering module back into the bundle graph for something
// that's purely presentational (a row's leading emoji), so the table is
// copied instead. celebrate.ts itself is untouched; this file does not
// import it and never will.
//
// Source of truth for the copied values: fx/celebrate.ts's `THEMES` const
// (FX-SPEC "Vocabulary" table, 65 motifs) — glyphs[0] of each entry, exactly
// as design_handoff_shot_coach/pg-data.js's FX_THEMES table also carries
// them (cross-checked against both).

const LEADING_GLYPH: Record<string, string> = {
  shark: '🦈',
  fin: '🦈',
  raft: '🛟',
  boat: '🚤',
  barrel: '🛢️',
  beach: '🏖️',
  harpoon: '🔱',
  gear: '⚙️',
  wave: '🌊',
  briefcase: '💼',
  dance: '🕺',
  car: '🚗',
  watch: '⌚',
  burger: '🍔',
  gun: '🔫',
  cash: '💵',
  crown: '👑',
  sparkle: '✨',
  kaiju: '🦖',
  heatray: '⚡',
  mecha: '🤖',
  city: '🏙️',
  monster: '🐉',
  moth: '🦋',
  military: '🚁',
  train: '🚆',
  saucer: '🛸',
  pika: '⚡',
  pokeball: '🔴',
  balloon: '🎈',
  battle: '⚔️',
  badge: '🏅',
  evolve: '💫',
  martian: '👽',
  cow: '🐄',
  kong: '🦍',
  jungle: '🌴',
  demo: '👹',
  upside: '🌀',
  eggo: '🧇',
  lights: '💡',
  psychic: '🧠',
  deadite: '🧟',
  chainsaw: '🪚',
  tome: '📖',
  ghost: '👻',
  worm: '🪱',
  beetle: '🪲',
  dragon: '🐉',
  dice: '🎲',
  quest: '⚔️',
  magic: '🔮',
  coin: '🪙',
  dog: '🐕',
  hotel: '🏨',
  guitar: '🎸',
  skull: '💀',
  turtle: '🐢',
  hero: '🦸',
  spider: '🕷️',
  space: '🚀',
  cowboy: '🤠',
  castle: '🏰',
  bone: '🦴',
  extreme: '🏍️',
}

const SPARKLE_FALLBACK = '✨'

/** Resolve a goal/game's `fx` theme name to its leading glyph — unknown,
 *  missing, or null/undefined all fall back to `sparkle`'s glyph (FX-SPEC),
 *  matching fx/celebrate.ts's own `resolveTheme` fallback rule. */
export function glyphFor(fx: string | null | undefined): string {
  if (fx && LEADING_GLYPH[fx]) return LEADING_GLYPH[fx]!
  return SPARKLE_FALLBACK
}
