// PinballGenieWeb — identify/matcher.ts
//
// Pure port of the token/word matching contract in:
//   com.rolo.pinballgenie.identify.MachineIdentifier (Android — see
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/identify/MachineIdentifier.kt,
//   the `tokens()` / `words()` / `splitWords()` / `fold()` companion helpers)
// per the shared iOS/Android contract in
//   PinballARPipeline/specs/SPEC-MACHINE-ID.md ("Matching contract").
//
// Native identification is a *continuous* scan: MachineIdentifier.accept()
// folds each OCR frame into a per-machine hit counter and a machine becomes
// the candidate at counter >= 2. The web contract (CONTRACTS.md) is
// one-shot — a single OCR pass, matched once — so there is no counter/
// threshold state here: matchMachines() just returns every fully-satisfied
// machine, ranked by token count. identify/scan.ts takes the top of that
// list (or null) after one OCR pass.

import type { Machine } from '../models'

/** Uppercase, then fold diacritics (é→E) via NFD decomposition + stripping
 *  the combining marks it exposes — mirrors Kotlin's
 *  `Normalizer.normalize(str.uppercase(), Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "")`. */
function fold(raw: string): string {
  return raw.toUpperCase().normalize('NFD').replace(/\p{Mn}+/gu, '')
}

/** Fold, then split on every run of non `[A-Z0-9]` characters. */
function splitWords(raw: string): string[] {
  return fold(raw).split(/[^A-Z0-9]+/).filter((w) => w.length > 0)
}

/**
 * Tokens of a machine: `name` up to the first " (Manufacturer, Year)" opening
 * paren (legacy em dash "—" cutoff still honored for any caller passing the
 * pre-2026-07 format; whole name if neither is present) → uppercase → fold
 * diacritics → split on non-alphanumeric runs → keep tokens of length >= 3.
 *
 *   machineTokens("Jaws (Stern Pinball, 2024)")                       -> ["JAWS"]
 *   machineTokens("Pulp Fiction (Chicago Gaming Company, 2023)")      -> ["PULP", "FICTION"]
 *   machineTokens("Godzilla (Stern Pinball, 2021)")                   -> ["GODZILLA"]
 *   machineTokens("Pokémon (Stern Pinball, 2026)")                    -> ["POKEMON"]
 *
 * catalog.json's `name` stopped containing an em dash entirely as of the
 * 2026-07-28 legal-naming normalization ("Title[: Subtitle] (Manufacturer,
 * Year)") — the cutoff MUST also recognize "(" or every machine's tokens
 * would include its manufacturer and year, breaking OCR matching.
 */
export function machineTokens(name: string): string[] {
  const cutIndex = name.search(/[—(]/)
  const head = cutIndex === -1 ? name : name.slice(0, cutIndex)
  return splitWords(head).filter((w) => w.length >= 3)
}

/** Word set of one OCR pass: uppercase, fold diacritics, split on
 *  non-alphanumeric runs (whitespace, punctuation, newlines between OCR
 *  lines all count as separators) — mirrors native's `words(strings)`. */
export function ocrWordSet(text: string): Set<string> {
  return new Set(splitWords(text))
}

/**
 * Machines whose EVERY token is a whole-word member of `ocrWords` (a machine
 * with zero tokens never matches — an empty token list is not a vacuous
 * match), sorted by token count descending (more specific titles rank
 * first). Ties keep catalog order (stable sort) — the web scan is one-shot
 * so there is no native-style hit-counter tiebreak.
 */
export function matchMachines(ocrWords: Set<string>, machines: Machine[]): Machine[] {
  const hits: { machine: Machine; tokenCount: number }[] = []
  for (const machine of machines) {
    const tokens = machineTokens(machine.name)
    if (tokens.length > 0 && tokens.every((t) => ocrWords.has(t))) {
      hits.push({ machine, tokenCount: tokens.length })
    }
  }
  return hits.sort((a, b) => b.tokenCount - a.tokenCount).map((h) => h.machine)
}

/** Result of {@link selfTest}: pass/fail counts plus the label of every
 *  failed assertion (empty when everything passed). */
export interface SelfTestResult {
  passed: number
  failedLabels: string[]
}

/**
 * Unit-test-style assertions for this module, meant for manual/dev-time
 * invocation (this project has no test runner wired into package.json —
 * see e.g. the browser console: `import('/src/identify/matcher.ts').then(m => console.log(m.selfTest()))`).
 * Non-throwing: inspect `failedLabels` for anything that didn't hold.
 */
export function selfTest(): SelfTestResult {
  const failedLabels: string[] = []
  let passed = 0
  const ok = (label: string, cond: boolean): void => {
    if (cond) passed += 1
    else failedLabels.push(label)
  }
  const sameArr = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i])

  // --- machineTokens -----------------------------------------------------
  ok('tokens: paren cutoff, single token', sameArr(machineTokens('Jaws (Stern Pinball, 2024)'), ['JAWS']))
  ok('tokens: multi-word head', sameArr(machineTokens('Pulp Fiction (Chicago Gaming Company, 2023)'), ['PULP', 'FICTION']))
  ok('tokens: simple', sameArr(machineTokens('Godzilla (Stern Pinball, 2021)'), ['GODZILLA']))
  ok('tokens: diacritic fold (Pokémon)', sameArr(machineTokens('Pokémon (Stern Pinball, 2026)'), ['POKEMON']))
  ok('tokens: no paren/dash uses whole name', sameArr(machineTokens('Godzilla'), ['GODZILLA']))
  ok('tokens: short pieces (<3 chars) dropped', sameArr(machineTokens('X-Men (Stern Pinball, 2012)'), ['MEN']))
  ok('tokens: all-short head yields no tokens', sameArr(machineTokens('Go (Stern Pinball, 1999)'), []))
  ok('tokens: legacy em dash cutoff still honored', sameArr(machineTokens('JAWS — Stern (2024)'), ['JAWS']))

  // --- matchMachines -------------------------------------------------------
  const catalog: Machine[] = [
    { id: 'jaws', name: 'Jaws (Stern Pinball, 2024)', shortTitle: 'JAWS', resource: 'jaws_goals' },
    { id: 'pulp-fiction', name: 'Pulp Fiction (Chicago Gaming Company, 2023)', shortTitle: 'PULP FICTION', resource: 'pulp_fiction_goals' },
    { id: 'pokemon', name: 'Pokémon (Stern Pinball, 2026)', shortTitle: 'POKÉMON', resource: 'pokemon_goals' },
    { id: 'zero-token', name: 'Go (Stern Pinball, 1999)', shortTitle: 'GO', resource: 'go_goals' },
  ]

  ok(
    'match: OCR containing POKEMON hits the Pokémon machine',
    sameArr(matchMachines(new Set(['POKEMON', 'STERN', 'PINBALL']), catalog).map((m) => m.id), ['pokemon']),
  )
  ok(
    'match: raw lowercase/accented OCR text folds the same way via ocrWordSet',
    sameArr(matchMachines(ocrWordSet('pokémon stern pinball'), catalog).map((m) => m.id), ['pokemon']),
  )
  ok(
    'match: partial tokens do not match (Pulp Fiction needs both words)',
    matchMachines(new Set(['PULP', 'SOMETHING', 'ELSE']), catalog).length === 0,
  )
  ok(
    'match: whole-word only — "JAWSOME" does not satisfy token "JAWS"',
    matchMachines(new Set(['JAWSOME']), catalog).length === 0,
  )
  ok(
    'match: a zero-token machine never matches',
    matchMachines(new Set(['GO', 'STERN', '1999']), catalog).every((m) => m.id !== 'zero-token'),
  )
  ok(
    'match: multiple hits sorted by token count desc',
    sameArr(
      matchMachines(new Set(['JAWS', 'PULP', 'FICTION']), catalog).map((m) => m.id),
      ['pulp-fiction', 'jaws'],
    ),
  )

  return { passed, failedLabels }
}
