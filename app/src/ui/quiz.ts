// ui/quiz.ts — "KNOW THIS TABLE": a five-question recall quiz over the loaded
// machine's own data. No native source to mirror; this is a web-first feature.
//
// WHY A QUIZ. Everything else in the app is reading: the Goals tab, the Study
// step-through, the guide pages. Retrieval practice — being made to produce an
// answer before seeing it — fixes material in memory far better than another
// pass of rereading, and it also tells the player which parts they only THINK
// they know. So this asks, then answers immediately with the reason.
//
// WHERE THE QUESTIONS COME FROM. Only `state.data` — the machine's own shots,
// goals and howItPlays. No network, no hand-written question bank, nothing that
// can drift from the dataset. buildQuiz() is a pure function of (data, seed):
//
//   goal-start   "What starts <multiball/mode goal>?"   → its first step's shot
//   light-shot   "Which shot is the <light group>?"     → one of its shot sites
//   light-lit    "What does a lit <light group> do?"    → that group's `lit`
//   ladder       "On ball one, the ladder says to…"     → scoring[0].text
//   category     "Which goal is in the <category> category?"  (fallback)
//   goal-first   "What is the first shot of <goal>?"    (last-resort fallback,
//                any routed goal outside multiball/mode)
//
// THE SEED is machine id + local calendar day (quizSeed), so the set is stable
// within a day — reopen it after a game and you get the same five — and moves
// on tomorrow. Every random choice (which candidates, which distractors, the
// option order) flows from that string through a seeded PRNG; Math.random is
// never called. RETRY replays the same set: the point is to get THESE right.
//
// HONESTY RULES the generators keep, because a quiz with two right answers (or
// none) teaches the wrong thing with total confidence:
//   * a distractor is never another correct answer — light-shot excludes EVERY
//     shot site of the group, category excludes every goal in that category;
//   * options are unique by normalized text, and the answer is always among
//     them (the companion suite, tests/quiz.test.mjs, pins both against real
//     data files);
//   * any-order goals (`ordered === false`) have no "first shot", so they never
//     feed goal-start/goal-first;
//   * with a `trim` of 'pro', premium-le shots and the goals that need them are
//     out — a Pro player is never asked about a shot their machine lacks. The
//     same goes for a light group that lives only on premium-le shots, and for
//     any text the data itself marks "Premium/LE only";
//   * the prompt never gives the answer away: a shot question whose correct
//     shot shares a distinctive word with the thing asked about ("What starts
//     Fish Finder…?" → "Left 3-Bank (Fish Finder)") is not asked.
// Fewer than QUIZ_MIN buildable questions → [] and the sheet says so, rather
// than a one-question "quiz".
//
// UI: a shared overlay sheet (ui/sheet.ts, variant 'overlay' — role=dialog,
// Escape, focus capture/return, Tab wrap), one question at a time, the same
// shape as ui/glossary.ts. Integration is one call from a Study-tab pill:
// openQuiz(state, { showGoalOnShots }). This module edits no other file.

import './quiz.css'
import type { GameData, Goal, GoalCategory, LightGroup, Shot } from '../models'
import type { AppState } from '../state'
import { createSheet, type SheetHandle } from './sheet'
import { CATEGORY_META, isPathless } from './goalMeta'

// ---------------------------------------------------------------------------
// Pure generator
// ---------------------------------------------------------------------------

export type QuestionKind = 'goal-start' | 'light-shot' | 'light-lit' | 'ladder' | 'category' | 'goal-first'

export interface Question {
  /** Stable per subject, e.g. 'goal-start:jaws-mb-1'. Also seeds the option shuffle. */
  id: string
  kind: QuestionKind
  prompt: string
  /** 3..4 options, unique by normalized text, already shuffled by seed. */
  options: string[]
  correctIndex: number
  /** === options[correctIndex]; kept so callers never re-index. */
  answer: string
  /** One sentence from the data that explains the answer. May be ''. */
  why: string
  /** The goal the question is about, when it is about one (drives "Show me"). */
  goal: Goal | null
}

export interface QuizOptions {
  /** The player's MODEL selection (state.trim). 'pro' drops premium-le shots
   *  and the goals that route through them. Omitted = everything counts. */
  trim?: 'pro' | 'premium-le'
}

export const QUIZ_LENGTH = 5
export const QUIZ_MIN = 3
/** Options per question when the data has enough distractors. */
const MAX_OPTIONS = 4
/** Fewer than this many options is not a multiple-choice question. */
const MIN_OPTIONS = 3

/** The day's seed for a machine: `<machineId>:<local YYYY-MM-DD>`. Local, not
 *  UTC, so "today" turns over at the player's midnight, not London's. */
export function quizSeed(machineId: string, now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${machineId}:${y}-${m}-${d}`
}

/** FNV-1a 32-bit — a stable string hash to seed the PRNG with. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: tiny, fast, good enough to shuffle five questions. Returns
 *  floats in [0, 1). Deterministic for a given seed string. */
function rngFrom(seed: string): () => number {
  let a = hash32(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates on a COPY. */
function shuffled<T>(list: readonly T[], rnd: () => number): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** Comparison key for option text: two options that differ only in case or
 *  spacing are the same option. */
function optKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim() !== ''
}

/** The first sentence of a prose field — the "why" is one line, not a card. */
export function firstSentence(text: string | null | undefined): string {
  if (!nonEmpty(text)) return ''
  const t = text.trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(t)
  return (m ? m[1]! : t).trim()
}

/**
 * Assembles one question: dedupes the distractors against the answer and each
 * other, keeps up to MAX_OPTIONS - 1 of them in the order given (callers pass
 * them pre-shuffled / pre-prioritised), then shuffles the options with a PRNG
 * seeded by (seed, question id). Null when fewer than MIN_OPTIONS survive.
 */
function makeQuestion(
  ctx: Ctx,
  base: Omit<Question, 'options' | 'correctIndex' | 'answer'>,
  answer: string,
  distractors: readonly string[],
): Question | null {
  const seed = ctx.seed
  // Off-model text is never an option — not the answer (the question is then
  // about something this player's machine does not have) and not a distractor
  // (an obviously-wrong "Premium/LE only" option on a Pro is a free elimination).
  if (!nonEmpty(answer) || ctx.offModelText(answer)) return null
  const seen = new Set([optKey(answer)])
  const picked: string[] = []
  for (const d of distractors) {
    if (picked.length >= MAX_OPTIONS - 1) break
    if (!nonEmpty(d) || ctx.offModelText(d)) continue
    const k = optKey(d)
    if (seen.has(k)) continue
    seen.add(k)
    picked.push(d.trim())
  }
  if (picked.length + 1 < MIN_OPTIONS) return null
  const options = shuffled([answer.trim(), ...picked], rngFrom(`${seed}|opts|${base.id}`))
  const correctIndex = options.findIndex((o) => optKey(o) === optKey(answer))
  return { ...base, options, correctIndex, answer: options[correctIndex]! }
}

interface Ctx {
  seed: string
  shots: Shot[]
  shotsById: Map<string, Shot>
  goals: Goal[]
  lights: LightGroup[]
  data: GameData
  /** True for text the dataset itself marks as belonging to another model
   *  ("…extra ball (Premium/LE only).") while the player is on Pro. */
  offModelText(text: string): boolean
}

/** The data's own wording for premium-le-only content ("Premium/LE only",
 *  "Premium and LE only"). Narrow on purpose: most Premium/LE mentions in the
 *  corpus are comparisons ("on Premium/LE it holds the ball; on Pro it…")
 *  that are true on both models and fine to show. */
const PREMIUM_ONLY_RE = /\bpremium\s*(?:\/|and)\s*le\s+only\b/i

/** Words that name a KIND of shot or feature rather than a particular one —
 *  sharing one of these between a prompt and an answer gives nothing away,
 *  because the distractors carry them too ("Left Ramp" vs "Right Ramp"). Plus
 *  the prompts' own scaffolding words. */
const GIVEAWAY_STOPWORDS = new Set([
  'left', 'right', 'center', 'centre', 'upper', 'lower', 'ramp', 'ramps', 'lane', 'lanes', 'shot', 'shots',
  'ball', 'balls', 'multiball', 'mode', 'modes', 'orbit', 'loop', 'target', 'targets', 'what', 'starts',
  'first', 'with', 'from', 'into', 'then',
])

/** The distinctive words of a string: letters/digits runs of 4+ characters
 *  that are not stopwords. "Left 3-Bank (Fish Finder)" → bank, fish, finder. */
function distinctiveWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !GIVEAWAY_STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Does `answer` share a distinctive word with `subject` — the goal title or
 *  light name the prompt is built from? Then the prompt answers itself: the
 *  player matches words, not knowledge. */
function givesAway(subject: string, answer: string): boolean {
  const a = distinctiveWords(answer)
  for (const w of distinctiveWords(subject)) if (a.has(w)) return true
  return false
}

/** The routed goal's first shot, or null when there is no "first" to ask
 *  about: pathless, any-order, or a dangling/hidden shot id. */
function startShotOf(goal: Goal, ctx: Ctx): Shot | null {
  if (isPathless(goal) || goal.ordered === false) return null
  const first = goal.steps[0]
  return (first && ctx.shotsById.get(first.shot)) || null
}

/** Shot-name distractors for a question whose answer is `correctId`, never
 *  drawing from `exclude`. Shots that START other goals come first — they are
 *  the plausible wrong answers — then the rest of the table, each half in a
 *  seeded order. */
function shotDistractors(ctx: Ctx, exclude: ReadonlySet<string>, rnd: () => number): string[] {
  const starters = new Set<string>()
  for (const g of ctx.goals) {
    const s = startShotOf(g, ctx)
    if (s) starters.add(s.id)
  }
  const pool = ctx.shots.filter((s) => !exclude.has(s.id))
  const hot = shuffled(pool.filter((s) => starters.has(s.id)), rnd)
  const rest = shuffled(pool.filter((s) => !starters.has(s.id)), rnd)
  return [...hot, ...rest].map((s) => s.name)
}

function genGoalStart(ctx: Ctx, kind: 'goal-start' | 'goal-first'): Question[] {
  const wanted = (c: GoalCategory): boolean => (kind === 'goal-start' ? c === 'multiball' || c === 'mode' : c !== 'multiball' && c !== 'mode')
  const out: Question[] = []
  for (const goal of ctx.goals) {
    if (!wanted(goal.category)) continue
    const shot = startShotOf(goal, ctx)
    if (!shot || !nonEmpty(goal.title)) continue
    // A title that names its own start shot is not a question. Skipped, not
    // reworded: the other generators fill the slot (see PLAN).
    if (givesAway(goal.title, shot.name)) continue
    const rnd = rngFrom(`${ctx.seed}|${kind}|${goal.id}`)
    const q = makeQuestion(
      ctx,
      {
        id: `${kind}:${goal.id}`,
        kind,
        prompt: kind === 'goal-start' ? `What starts ${goal.title}?` : `What is the first shot of ${goal.title}?`,
        why: firstSentence(goal.summary),
        goal,
      },
      shot.name,
      shotDistractors(ctx, new Set([shot.id]), rnd),
    )
    if (q) out.push(q)
  }
  return out
}

function genLightShot(ctx: Ctx): Question[] {
  const out: Question[] = []
  for (const group of ctx.lights) {
    // Every resolvable shot site is a right answer; all of them are excluded
    // from the distractors, and the asked-for one is a seeded pick.
    const siteShots: Shot[] = []
    for (const site of group.sites) {
      if (!site || typeof site !== 'object' || !('shot' in site)) continue
      const shot = ctx.shotsById.get(site.shot)
      if (shot && !siteShots.includes(shot)) siteShots.push(shot)
    }
    if (siteShots.length === 0) continue
    // The asked-for site is drawn only from sites whose name does not repeat
    // the group's ("Fish Finder Awards" → "Left 3-Bank (Fish Finder)" answers
    // itself). Every site is still excluded from the distractors below.
    const askable = siteShots.filter((s) => !givesAway(group.name, s.name))
    if (askable.length === 0) continue
    const rnd = rngFrom(`${ctx.seed}|light-shot|${group.id}`)
    const correct = askable[Math.floor(rnd() * askable.length)]!
    const exclude = new Set(siteShots.map((s) => s.id))
    // Also exclude any other shot that happens to share a site's NAME — a
    // distinct id spelled the same would be a second right answer on screen.
    const siteNames = new Set(siteShots.map((s) => optKey(s.name)))
    for (const s of ctx.shots) if (siteNames.has(optKey(s.name))) exclude.add(s.id)
    const q = makeQuestion(
      ctx,
      {
        id: `light-shot:${group.id}`,
        kind: 'light-shot',
        prompt: siteShots.length === 1 ? `Which shot is the ${group.name}?` : `Which shot is part of the ${group.name}?`,
        why: firstSentence(group.then),
        goal: null,
      },
      correct.name,
      shotDistractors(ctx, exclude, rnd),
    )
    if (q) out.push(q)
  }
  return out
}

function genLightLit(ctx: Ctx): Question[] {
  const groups = ctx.lights.filter((g) => nonEmpty(g.lit))
  if (groups.length < MIN_OPTIONS) return []
  const out: Question[] = []
  for (const group of groups) {
    const rnd = rngFrom(`${ctx.seed}|light-lit|${group.id}`)
    const others = shuffled(groups.filter((g) => g !== group).map((g) => g.lit), rnd)
    const q = makeQuestion(
      ctx,
      {
        id: `light-lit:${group.id}`,
        kind: 'light-lit',
        prompt: `What does a lit ${group.name} do?`,
        why: firstSentence(group.then),
        goal: null,
      },
      group.lit,
      others,
    )
    if (q) out.push(q)
  }
  return out
}

function genLadder(ctx: Ctx): Question[] {
  const scoring = ctx.data.howItPlays?.scoring
  if (!Array.isArray(scoring) || scoring.length < 3) return []
  const first = scoring[0]
  if (!first || first.tier !== 'ball-one' || !nonEmpty(first.text)) return []
  const q = makeQuestion(
    ctx,
    {
      id: 'ladder:ball-one',
      kind: 'ladder',
      prompt: 'On ball one, the ladder says to…',
      why: firstSentence(ctx.data.howItPlays?.objective),
      goal: null,
    },
    first.text,
    scoring.slice(1).map((s) => s?.text ?? ''),
  )
  return q ? [q] : []
}

function genCategory(ctx: Ctx): Question[] {
  const out: Question[] = []
  for (const goal of ctx.goals) {
    const meta = CATEGORY_META[goal.category]
    if (!meta || !nonEmpty(goal.title)) continue
    const rnd = rngFrom(`${ctx.seed}|category|${goal.id}`)
    const others = shuffled(ctx.goals.filter((g) => g.category !== goal.category).map((g) => g.title), rnd)
    // A distractor that shares its TITLE with an in-category goal would be a
    // second right answer; drop those titles outright.
    const inCat = new Set(ctx.goals.filter((g) => g.category === goal.category).map((g) => optKey(g.title)))
    const q = makeQuestion(
      ctx,
      {
        id: `category:${goal.id}`,
        kind: 'category',
        prompt: `Which goal is in the ${meta.label} category?`,
        why: firstSentence(goal.summary),
        goal,
      },
      goal.title,
      others.filter((t) => nonEmpty(t) && !inCat.has(optKey(t))),
    )
    if (q) out.push(q)
  }
  return out
}

/** The question a slot in the plan draws from, in priority order. The first
 *  five give the designed mix; the tail fills from the fallbacks. */
const PLAN: QuestionKind[] = [
  'goal-start', 'light-shot', 'light-lit', 'ladder', 'goal-start',
  'light-shot', 'light-lit', 'category', 'category', 'goal-first',
  'category', 'goal-first', 'category', 'goal-first', 'category',
]

/** The subject a question is about, so one goal or one light group is never
 *  asked about twice in a set. */
function subjectOf(q: Question): string {
  if (q.goal) return `goal:${q.goal.id}`
  const i = q.id.indexOf(':')
  return q.kind.startsWith('light') ? `light:${q.id.slice(i + 1)}` : q.id
}

/**
 * Five (QUIZ_LENGTH) multiple-choice questions from one machine's data,
 * deterministic in `seed`. Fewer when the data cannot support five; [] when it
 * cannot support QUIZ_MIN. Never throws on malformed or thin data.
 */
export function buildQuiz(data: GameData, seed: string, opts: QuizOptions = {}): Question[] {
  try {
    return buildQuizUnsafe(data, seed, opts)
  } catch {
    // The generators guard every field they read; this is the last line for a
    // shape nobody anticipated. A missing quiz beats a crashed sheet.
    return []
  }
}

function buildQuizUnsafe(data: GameData, seed: string, opts: QuizOptions): Question[] {
  if (!data || typeof data !== 'object') return []
  const trim = opts.trim
  const visible = (s: Shot): boolean => !trim || !s.trim || s.trim === 'all' || s.trim === trim
  const shots = (Array.isArray(data.shots) ? data.shots : []).filter(
    (s): s is Shot => !!s && typeof s.id === 'string' && nonEmpty(s.name) && visible(s),
  )
  const shotsById = new Map(shots.map((s) => [s.id, s]))
  const allById = new Map((Array.isArray(data.shots) ? data.shots : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]))
  const goals = (Array.isArray(data.goals) ? data.goals : []).filter((g): g is Goal => {
    if (!g || typeof g.id !== 'string' || !Array.isArray(g.steps)) return false
    // Same rule as goalMeta.goalVisibleForTrim: a step on a hidden shot hides
    // the goal; a dangling id is a data bug, not a trim question.
    return g.steps.every((st) => {
      const s = st && allById.get(st.shot)
      return !s || visible(s)
    })
  })
  const rawLights = data.howItPlays?.lights
  const lights = (Array.isArray(rawLights) ? rawLights : []).filter(
    (g): g is LightGroup => !!g && typeof g.id === 'string' && nonEmpty(g.name) && Array.isArray(g.sites) && !offModelGroup(g),
  )
  /** A light group that lives ONLY on shots this model lacks (Jaws' Lookout
   *  Tower Extra Ball on a Pro). Every shot site must be a KNOWN, hidden shot:
   *  a group with a non-shot site, or a dangling id, is not a trim question. */
  function offModelGroup(g: LightGroup): boolean {
    const shotSites = g.sites.filter((site) => !!site && typeof site === 'object' && 'shot' in site)
    if (shotSites.length === 0 || shotSites.length !== g.sites.length) return false
    return shotSites.every((site) => {
      const s = allById.get((site as { shot: string }).shot)
      return !!s && !visible(s)
    })
  }
  const offModelText = (text: string): boolean => trim === 'pro' && PREMIUM_ONLY_RE.test(text)
  const ctx: Ctx = { seed, shots, shotsById, goals, lights, data, offModelText }

  const pools = new Map<QuestionKind, Question[]>()
  const fill = (kind: QuestionKind, qs: Question[]): void => {
    pools.set(kind, shuffled(qs, rngFrom(`${seed}|pick|${kind}`)))
  }
  fill('goal-start', genGoalStart(ctx, 'goal-start'))
  fill('light-shot', genLightShot(ctx))
  fill('light-lit', genLightLit(ctx))
  fill('ladder', genLadder(ctx))
  fill('category', genCategory(ctx))
  fill('goal-first', genGoalStart(ctx, 'goal-first'))

  const picked: Question[] = []
  const used = new Set<string>()
  // Strict pass: one question per subject (goal or light group). A question
  // skipped for a repeated subject is set aside for the relaxed pass below.
  let relaxed = false
  const keyOf = (q: Question): string => (relaxed ? q.id : subjectOf(q))
  const skipped = new Map<QuestionKind, Question[]>()
  const take = (kind: QuestionKind): boolean => {
    const pool = pools.get(kind) ?? []
    while (pool.length > 0) {
      const q = pool.shift()!
      if (used.has(keyOf(q))) {
        if (!relaxed) skipped.set(kind, [...(skipped.get(kind) ?? []), q])
        continue
      }
      used.add(keyOf(q))
      picked.push(q)
      return true
    }
    return false
  }
  /** Round-robins every pool in plan order until full or all are dry. */
  const sweep = (): void => {
    for (let progress = true; progress && picked.length < QUIZ_LENGTH; ) {
      progress = false
      for (const kind of new Set(PLAN)) {
        if (picked.length >= QUIZ_LENGTH) break
        if (take(kind)) progress = true
      }
    }
  }
  for (const kind of PLAN) {
    if (picked.length >= QUIZ_LENGTH) break
    take(kind)
  }
  sweep()
  // Still short on a lean table (four goals, no howItPlays): let a goal be the
  // subject of a SECOND, different kind of question — "what starts it" and
  // "which category is it in" ask different things. Question ids stay unique.
  if (picked.length < QUIZ_LENGTH) {
    relaxed = true
    for (const [kind, qs] of skipped) pools.set(kind, [...qs, ...(pools.get(kind) ?? [])])
    used.clear()
    for (const q of picked) used.add(q.id)
    sweep()
  }
  return picked.length >= QUIZ_MIN ? picked : []
}

/** `text` closed with a period — unless it already ends in sentence
 *  punctuation or a closing quote. Answers are often whole sentences from the
 *  data ("Shoot the lit arrow."), and a blind `${answer}.` printed "arrow..". */
export function withPeriod(text: string): string {
  const t = text.trimEnd()
  return /[.!?…"'”’]$/.test(t) ? t : `${t}.`
}

/** The score card's verdict line. */
export function verdictFor(score: number, total: number): string {
  if (total > 0 && score === total) return 'Every answer right. You know this table.'
  if (score * 2 >= total) return 'Close. Review the misses below, then run it again.'
  return 'Worth another pass. Review the answers below, then retry.'
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export interface QuizDoors {
  /** Close-and-navigate: show this goal's route on the Shots tab. */
  showGoalOnShots(goal: Goal): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

/** Opens the KNOW THIS TABLE quiz for the loaded machine as an overlay sheet.
 *  Returns a handle; destroy() is safe to call more than once. */
export function openQuiz(state: AppState, doors: QuizDoors): { destroy(): void } {
  const machine = state.machine
  const data = state.data
  const questions = machine && data ? buildQuiz(data, quizSeed(machine.id), { trim: state.trim }) : []

  let destroyed = false
  let sheet: SheetHandle | null = null
  function close(): void {
    if (destroyed) return
    destroyed = true
    sheet?.destroy()
    sheet = null
  }

  sheet = createSheet(document.body, {
    title: 'Know this table',
    maxHeightVh: 68,
    variant: 'overlay',
    closeButton: true,
    closeLabel: 'Close quiz',
    onDismiss: close,
  })

  let index = 0
  let score = 0
  const answers: (number | null)[] = questions.map(() => null)

  function mount(body: HTMLElement, focusTarget: HTMLElement | null): void {
    if (destroyed || !sheet) return
    sheet.setBody(body)
    focusTarget?.focus?.()
  }

  function renderEmpty(): void {
    const body = el('div', 'pg-quiz-body')
    const msg = el(
      'p',
      'pg-quiz-empty',
      data ? 'There is not enough on this table yet to build a quiz.' : 'Pick a table first, then come back for the quiz.',
    )
    const row = el('div', 'pg-quiz-actions')
    const done = button('pg-quiz-btn pg-quiz-btn-primary', 'DONE', close)
    row.append(done)
    body.append(msg, row)
    mount(body, done)
  }

  function renderQuestion(): void {
    const q = questions[index]!
    const body = el('div', 'pg-quiz-body')

    const progress = el('div', 'pg-quiz-progress')
    const eyebrow = el('span', 'pg-quiz-eyebrow', `Question ${index + 1} of ${questions.length}`)
    const dots = el('span', 'pg-quiz-dots')
    dots.setAttribute('aria-hidden', 'true')
    questions.forEach((_, i) => {
      const a = answers[i]
      const mark = i === index ? ' is-current' : a === null ? '' : a === questions[i]!.correctIndex ? ' is-right' : ' is-wrong'
      dots.append(el('span', `pg-quiz-dot${mark}`))
    })
    progress.append(eyebrow, dots)

    const promptId = `pg-quiz-prompt-${index}`
    const prompt = el('h3', 'pg-quiz-prompt', q.prompt)
    prompt.id = promptId
    prompt.setAttribute('tabindex', '-1')

    const list = el('div', 'pg-quiz-options')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-labelledby', promptId)

    const feedback = el('div', 'pg-quiz-feedback')
    feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-live', 'polite')

    const optionButtons: HTMLButtonElement[] = []
    let locked = false

    q.options.forEach((text, i) => {
      const b = button('pg-quiz-opt', '', () => choose(i))
      const letter = el('span', 'pg-quiz-opt-key', String.fromCharCode(65 + i))
      letter.setAttribute('aria-hidden', 'true')
      const label = el('span', 'pg-quiz-opt-text', text)
      b.append(letter, label)
      optionButtons.push(b)
      list.append(b)
    })

    function choose(i: number): void {
      if (locked) return
      locked = true
      answers[index] = i
      const right = i === q.correctIndex
      if (right) score++

      optionButtons.forEach((b, j) => {
        // aria-disabled, not disabled: a disabled button drops out of the tab
        // order, and the one the player just pressed must stay where focus is
        // until NEXT takes it.
        b.setAttribute('aria-disabled', 'true')
        b.classList.add('is-locked')
        if (j === q.correctIndex) {
          b.classList.add('is-right')
          b.setAttribute('aria-label', `${q.options[j]} (correct answer)`)
        } else if (j === i) {
          b.classList.add('is-wrong')
          b.setAttribute('aria-label', `${q.options[j]} (your answer)`)
        }
      })

      const verdict = el('p', `pg-quiz-verdict ${right ? 'is-right' : 'is-wrong'}`, right ? 'Right.' : `Not quite. It's ${withPeriod(q.answer)}`)
      feedback.append(verdict)
      if (q.why) feedback.append(el('p', 'pg-quiz-why', q.why))

      const actions = el('div', 'pg-quiz-actions')
      const goal = q.goal
      if (goal && !isPathless(goal)) {
        actions.append(
          button('pg-quiz-link', 'Show me on the playfield ›', () => {
            close()
            doors.showGoalOnShots(goal)
          }),
        )
      }
      const last = index === questions.length - 1
      const next = button('pg-quiz-btn pg-quiz-btn-primary', last ? 'SEE SCORE' : 'NEXT', () => {
        index++
        if (index >= questions.length) renderScore()
        else renderQuestion()
      })
      actions.append(next)
      feedback.append(actions)
      next.focus?.()
    }

    body.append(progress, prompt, list, feedback)
    mount(body, prompt)
  }

  function renderScore(): void {
    const body = el('div', 'pg-quiz-body')
    const card = el('div', 'pg-quiz-score')
    const head = el('h3', 'pg-quiz-score-head')
    head.setAttribute('tabindex', '-1')
    head.append(el('span', 'pg-quiz-score-num', `${score} / ${questions.length}`), el('span', 'pg-quiz-score-label', 'Know this table'))
    card.append(head, el('p', 'pg-quiz-score-verdict', verdictFor(score, questions.length)))

    const missed = questions.filter((q, i) => answers[i] !== q.correctIndex)
    if (missed.length > 0) {
      const list = el('ul', 'pg-quiz-missed')
      for (const q of missed) {
        const li = el('li', 'pg-quiz-missed-row')
        li.append(el('span', 'pg-quiz-missed-q', q.prompt), el('span', 'pg-quiz-missed-a', q.answer))
        list.append(li)
      }
      card.append(list)
    }

    const actions = el('div', 'pg-quiz-actions')
    actions.append(
      button('pg-quiz-btn', 'RETRY', () => {
        index = 0
        score = 0
        answers.fill(null)
        renderQuestion()
      }),
      button('pg-quiz-btn pg-quiz-btn-primary', 'DONE', close),
    )
    body.append(card, actions)
    mount(body, head)
  }

  if (questions.length === 0) renderEmpty()
  else renderQuestion()

  return { destroy: close }
}
