// ui/linkTerms.ts — inline term links for the Study tab's prose (2026-10-14).
//
// WHY THIS EXISTS. rolo walked prod as a first-time visitor and found the
// HOW IT PLAYS sheet — the best beginner screen in the app — written in
// vocabulary a beginner does not have: "bash boat", "chum line", "3-bank",
// "inlane", "machete", none of it defined where it is read. The glossary
// exists (ui/glossary.ts, data/glossary.json) and can already open AT a term
// (openGlossary(term), P7a); the gap was that nothing in the prose pointed at
// it. This module turns the words in a paragraph that the app can explain into
// buttons, and leaves every other character exactly as authored.
//
// TWO KINDS OF LINK, ONE PASS.
//   - GLOSSARY: a term (or one of its authored aliases) from data/glossary.json.
//     Tapping it opens the glossary at that entry.
//   - SHOT: the name of one of THIS machine's own shots. Tapping it moves the
//     Study tour to that shot so it lights on the map. A beginner reading
//     "complete the left 3-bank" needs WHERE it is as much as WHAT it is, and
//     the map is the only thing in the app that can answer where.
//   The caller supplies both handlers; this module only builds DOM.
//
// MATCHING, and the measurement behind each rule:
//   - LONGEST TERM FIRST, across BOTH kinds, over the whole paragraph. "Left
//     Inlane" (a Jaws shot) claims its span before "Inlane" (a glossary term)
//     is even tried, so the more specific reference wins and the two never
//     nest. Equal lengths: a SHOT beats a glossary entry (it is the more
//     specific answer — this table's own target, with its own notes in LEARN —
//     and the glossary stays one tap away in the header), then alphabetical,
//     so the result never depends on the order a content file is sorted in
//     (the same lesson glossary.ts's findTerm learned the hard way).
//   - CASE-INSENSITIVE, WHOLE-WORD. A boundary is any character that is not
//     a letter, a digit or a HYPHEN, so "Premium/LE" links LE and "lit
//     inlane." links inlane, but "Pro" never matches inside "progress" and
//     "Lock" never matches inside "Flip-Lock" (a Jaws feature name, measured:
//     with the hyphen counted as a boundary it linked to the ball-lock entry).
//     A multi-word term still matches ACROSS a hyphen ("skill-shot"), because
//     that hyphen is inside the key, not at its edge — see keyRegex.
//   - ACRONYMS ARE CASE-SENSITIVE. A glossary key the glossary itself writes
//     in capitals (EM, LE, VUK) only matches in capitals. Measured: the
//     case-insensitive rule linked the 'Em of "Ride 'Em Cowboy" (Cactus
//     Canyon) to the electromechanical entry.
//   - HYPHEN == SPACE inside a term, the same normalisation findTerm uses, so
//     the glossary's "Lane change" matches prose "lane-change" and the shot
//     "Left 3-Bank" matches "left 3 bank". A straight apostrophe in a key also
//     matches a curly one in prose.
//   - A PLURAL "s"/"es" rides along ("pop bumpers", "modes", "inlanes") — the
//     prose is written for readers, not to match a dictionary headword.
//   - ONCE PER CALL per target. Callers pass one paragraph at a time, so the
//     first "inlane" in a paragraph is a link and the third is just a word: a
//     paragraph that is half buttons is harder to read than one with none.
//
// SHOT NAMES ARE MATCHED BY THEIR READABLE PARTS, not only verbatim. Measured
// on Jaws (2026-10-14): the shot names are "Left Orbit (West Beach)",
// "Captive Ball / Bash Boat", "Left 3-Bank (Fish Finder)" — and the HOW IT
// PLAYS prose says "bash boat" and "left 3-bank", never the full name. A
// verbatim-only rule linked almost nothing on the machine rolo was reading.
// So each shot answers to its full name, its name with every parenthetical
// removed, each parenthetical's own parts, and each side of a " / " — every
// one a string the dataset authored as a name for that shot; nothing is
// guessed, stemmed or fuzzy-matched.
//   A DERIVED PART MUST BE TWO WORDS OR MORE (the full name is exempt).
//   Measured across the catalog: single-word fragments are where this went
//   wrong — "Track Orbit (left)" contributed "left", "Groot Mouth (Lock)"
//   contributed "lock", "Mansion Entrance / House" contributed "house", and
//   between them they turned 100+ ordinary words into shot buttons. Two-word
//   parts ("Bash Boat", "Left 3-Bank", "Upper Flipper") are names; one-word
//   fragments are mostly directions and verbs.
//
// GLOSSARY KEYS THAT ARE ORDINARY ENGLISH IN RULES PROSE ARE NOT LINKED — see
// PROSE_STOPWORDS below for the list and the measurement behind it.
//
// SANITISED BY CONSTRUCTION. Every character of `text` reaches the page as a
// Text node or as a button's textContent. There is no innerHTML anywhere in
// this module, and no data string is ever interpreted as markup — the dataset
// is served publicly and edited by hand, and a `<` in a rules sentence must
// render as a `<`.

import type { GlossaryData } from './glossary'

/** A derived shot-name part needs at least this many words — see the header. */
const SHOT_PART_MIN_WORDS = 2

/** Glossary keys (terms or aliases, lower-cased, hyphens as spaces) that are
 *  NOT linked inside prose, because in rules prose they are the glossary sense
 *  too rarely for a button to be the right default.
 *
 *  MEASURED (2026-10-14) over every catalog machine's howItPlays objective,
 *  loop, scoring, light lit/flashing/then text and shot notes — whole-word,
 *  plurals included:
 *    head    62 hits — toy heads ("Rath's head drops", "Rotating head in a
 *            vice", "FooBot Head"), never the backbox (the alias's sense).
 *    special 197 — split between the replay award ("lights the Special") and
 *            names that only contain the word ("Special Attack", "Fastball
 *            Special"); a coin-flip is not a link.
 *    gate    116 — "harpoon gate", "six gate objectives", "Gate opens during
 *            Drive Fast": a rules gate as often as the wire one. The specific
 *            alias "one-way gate" is NOT stopped and still links.
 *    trap    54 — "trap door", "Trap dinos for perks" next to the cradle sense
 *            ("Trap on the left flipper").
 *  Checked and deliberately NOT stopped: "edition" (8 hits, all "all
 *  editions" — the Trim sense) and "code" (5 hits, 3 of them the software).
 *  This follows findTerm's own rule: landing someone on the WRONG entry is
 *  worse than not offering one. Every stopped entry is still in the glossary,
 *  one tap away from the header. */
const PROSE_STOPWORDS: ReadonlySet<string> = new Set(['head', 'special', 'gate', 'trap'])

/** The minimal shot shape this needs — id and display name. */
export interface LinkableShot {
  id: string
  name: string
}

export interface LinkTermsOptions {
  glossary: GlossaryData | null | undefined
  shots: readonly LinkableShot[] | null | undefined
  /** Called with the GLOSSARY ENTRY'S OWN term name (not the prose spelling),
   *  so openGlossary(term) lands on exactly the entry that matched. */
  onGlossaryTerm?: (term: string) => void
  /** Called with the shot's id. */
  onShot?: (shotId: string) => void
}

/** One run of a paragraph: plain text, or a span that links somewhere. */
export type TermSegment =
  | { kind: 'text'; text: string }
  | { kind: 'glossary'; text: string; term: string }
  | { kind: 'shot'; text: string; shotId: string }

interface Candidate {
  key: string
  kind: 'glossary' | 'shot'
  /** glossary: the entry's term; shot: the shot id. */
  target: string
  re: RegExp
}

/** findTerm's spelling (glossary.ts termKey): lower-case, hyphens as spaces,
 *  whitespace collapsed. Duplicated rather than exported from glossary.ts for
 *  the reason study.ts duplicates small private helpers — widening another
 *  module's surface for a one-liner costs more than the line. */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The regex one key matches in prose: its words separated by any run of
 *  spaces or hyphens, an optional plural, and a TRAILING boundary as a
 *  lookahead. The LEADING boundary is checked by hand in matchTerms, because a
 *  lookbehind is a SyntaxError at construction on Safari before 16.4 — and a
 *  throw here would take the whole Study tab down with it.
 *  `caseSensitive` is the acronym rule (see the header): the key is then
 *  matched exactly as the glossary capitalises it. */
function keyRegex(key: string, caseSensitive: boolean): RegExp {
  const words = key.split(' ').map((w) => escapeRe(w).replace(/'/g, "['’]"))
  return new RegExp(`${words.join('[\\s\\-]+')}(?:es|s)?(?![A-Za-z0-9-])`, caseSensitive ? 'g' : 'gi')
}

/** Letters, digits and the hyphen are "inside a word" for boundary purposes —
 *  see the header for why the hyphen is. */
const isWordChar = (c: string | undefined): boolean => c != null && /[A-Za-z0-9-]/.test(c)

/** A glossary spelling that is all capitals (and has a letter) — EM, LE, VUK. */
function isAcronym(raw: string): boolean {
  const compact = raw.replace(/[\s-]/g, '')
  return /[A-Z]/.test(compact) && /^[A-Z0-9]+$/.test(compact)
}

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length

/** Every readable name a shot answers to — see the header's measurement. The
 *  full name always counts; a part derived from it counts only when it has at
 *  least SHOT_PART_MIN_WORDS words. */
export function shotNameParts(name: string): string[] {
  const out = new Set<string>()
  const full = name.trim()
  if (full) out.add(full)
  const addPart = (s: string): void => {
    const t = s.trim().replace(/\s+/g, ' ')
    if (t && wordCount(t) >= SHOT_PART_MIN_WORDS) out.add(t)
  }
  const parens = [...full.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!)
  const stripped = full.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  addPart(stripped)
  for (const inner of parens) for (const p of inner.split('/')) addPart(p)
  for (const p of stripped.split('/')) addPart(p)
  return [...out]
}

function buildCandidates(glossary: GlossaryData | null | undefined, shots: readonly LinkableShot[] | null | undefined): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  const push = (rawKey: string, kind: Candidate['kind'], target: string): void => {
    const key = normKey(rawKey)
    if (!key) return
    if (kind === 'glossary' && PROSE_STOPWORDS.has(key)) return
    // One candidate per (key, kind): two shots that share a part name (a
    // machine with two "Spinner"s) keep the first, rather than making the
    // link's destination depend on which one the sort happened to try.
    const dedupe = `${kind}\u0000${key}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    const acronym = kind === 'glossary' && isAcronym(rawKey)
    out.push({ key, kind, target, re: keyRegex(acronym ? key.toUpperCase() : key, acronym) })
  }
  for (const shot of shots ?? []) {
    if (!shot || typeof shot.name !== 'string') continue
    for (const part of shotNameParts(shot.name)) push(part, 'shot', shot.id)
  }
  for (const cat of glossary?.categories ?? []) {
    for (const t of cat.terms ?? []) {
      if (!t || typeof t.term !== 'string') continue
      push(t.term, 'glossary', t.term)
      for (const a of t.aliases ?? []) push(a, 'glossary', t.term)
    }
  }
  // Longest first; a shot before a glossary entry of the same length; then
  // alphabetical — see the header for why each tiebreak exists.
  out.sort((a, b) => b.key.length - a.key.length || (a.kind === b.kind ? 0 : a.kind === 'shot' ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}

/** THE PURE HALF: `text` split into plain and linked runs. No DOM, so the
 *  matching rules are testable on real dataset strings without a document.
 *  Concatenating every segment's `text` gives back `text` exactly — nothing is
 *  re-cased, trimmed or dropped. */
export function matchTerms(
  text: string,
  { glossary, shots }: Pick<LinkTermsOptions, 'glossary' | 'shots'>,
): TermSegment[] {
  if (!text) return []
  const candidates = buildCandidates(glossary, shots)
  const taken: { start: number; end: number; c: Candidate }[] = []
  const linkedTargets = new Set<string>()
  for (const c of candidates) {
    const targetKey = `${c.kind}\u0000${c.target}`
    if (linkedTargets.has(targetKey)) continue
    c.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = c.re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (m[0].length === 0) {
        c.re.lastIndex++
        continue
      }
      if (isWordChar(text[start - 1])) continue
      if (taken.some((t) => start < t.end && end > t.start)) continue
      taken.push({ start, end, c })
      linkedTargets.add(targetKey)
      break
    }
  }
  taken.sort((a, b) => a.start - b.start)
  const segments: TermSegment[] = []
  let cursor = 0
  for (const t of taken) {
    if (t.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, t.start) })
    const span = text.slice(t.start, t.end)
    segments.push(t.c.kind === 'shot' ? { kind: 'shot', text: span, shotId: t.c.target } : { kind: 'glossary', text: span, term: t.c.target })
    cursor = t.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/** `text` as a DocumentFragment of Text nodes and term buttons — see the
 *  header. Append the result into the paragraph element the text used to be
 *  the textContent of.
 *
 *  THE BUTTONS ARE REAL <button type="button">s, styled by `.term-link` as a
 *  dotted-underline word (styles.css), with vertical padding cancelled by an
 *  equal negative margin so the hit area clears the 44px rule while the LINE
 *  HEIGHT of the paragraph does not move. Their accessible name starts with
 *  the visible word (WCAG 2.5.3 Label in Name) and says what the tap does. */
export function linkTerms(text: string, opts: LinkTermsOptions): DocumentFragment {
  const frag = document.createDocumentFragment()
  for (const seg of matchTerms(text, opts)) {
    if (seg.kind === 'text') {
      frag.appendChild(document.createTextNode(seg.text))
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = seg.text
    if (seg.kind === 'glossary') {
      btn.className = 'term-link term-link-glossary'
      btn.setAttribute('aria-label', `${seg.text}: open in the glossary`)
      const term = seg.term
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation?.()
        opts.onGlossaryTerm?.(term)
      })
    } else {
      btn.className = 'term-link term-link-shot'
      btn.setAttribute('aria-label', `${seg.text}: show this shot on the playfield`)
      const shotId = seg.shotId
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation?.()
        opts.onShot?.(shotId)
      })
    }
    frag.appendChild(btn)
  }
  return frag
}
