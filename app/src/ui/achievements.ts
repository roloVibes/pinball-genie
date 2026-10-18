// ui/achievements.ts — Achievements tab: an overview (overall progress +
// one row per machine) drilling down into a per-machine checklist. Design
// concept comes from an Xbox-achievements-style reference, DE-TRADEMARKED
// per the build brief: the STRUCTURE (per-game rows with progress, a
// per-game detail list, an overall progress header) is kept, everything else
// is rendered in this app's own glass/category-color language — see
// achievements.css's header comment. No trophy/gamerscore icon clones, no
// Xbox-green styling, no emoji anywhere in this module.
//
// Mount pattern mirrors ui/glossary.ts / overlay/map2d.ts / ar/arview.ts:
// dynamic-imported by app.ts on first visit to the tab (mountApp's
// `achievementsMounted` flag), never re-imported afterward — subsequent
// visits just toggle the panel's `hidden` attribute and call the returned
// handle's onShow() (see below). Content file: none — this tab reads
// GameData.achievements off the SAME `/data/<resource>.json` files
// models.ts's fetchGameData already fetches for the Goals/Map/AR tabs (v4
// schema addition, models.ts's Achievement/GameData.achievements).
//
// PER-USER SERVER-BACKED PERSISTENCE (rolo's explicit requirement — a
// shared device must never leak one user's checkmarks into another's view):
// server/pinball_auth.py's docstring is the contract this module is built
// against, verbatim:
//   GET  /whoami            -> 200 {"user": name} signed in; 401 otherwise
//   GET  /api/achievements  -> 200 THIS USER's { machineId: { achId: epochMs
//                              } } blob ({} if none)
//   PUT  /api/achievements  -> replaces the user's blob wholesale (this
//                              module always sends the FULL in-memory blob,
//                              never a partial patch); 204 = saved
// NO localStorage is used for progress, at all, anywhere in this file — see
// the module header's own "PER-USER" note in the feature spec this was
// built from. In-memory + the server round trip is the whole model. A 401
// — whether because this visitor never signed in (Phase 5: the site is
// public, an account is an opt-in upgrade, not a gate) or a session expired
// mid-visit — degrades to the SAME read-only sign-in banner (renderSignInBanner
// below) rather than crashing; every fetch/parse/save step below fails soft
// (see each function's own comment) per that same fail-soft discipline. The
// banner is deliberately phrased as an invitation, never as an error state or
// as "sign in AGAIN" — most visitors reading it have no account yet at all.
//
// Achievement -> Goal linkage: each Achievement.goal is a Goal.id in the
// SAME machine's dataset (schema v4 authoring rule — see models.ts). The
// per-machine page's "SHOW ME" affordance resolves that id against the
// machine's own goals (cached alongside its achievements, see
// MachineAchState below); an achievement whose linked goal doesn't resolve
// (stale dataset — parallel dataset authoring is still landing machine by
// machine) renders its row normally but disables SHOW ME instead of
// throwing (feature spec item 6).
//
// D6 (2026-07-29 security review) / D3 (2026-07-30 review): the /whoami
// check now lives in ui/session.ts, shared with ui/account.ts, instead of
// being fetched here directly — see boot() below and session.ts's own
// header for why (this used to fire /whoami AND /api/achievements
// unconditionally in one Promise.all, doubling the 401 rate a signed-out
// visitor cost against the fail2ban jail). A signed-in user's "Manage
// account" entry point (D3 — Export/Sign out/Delete, ui/account.ts) also
// lives in this tab now, in the exact slot the signed-out banner uses — see
// renderAccountBanner() below for why Achievements, not the header or a 4th
// tab, is that feature's home.

import './achievements.css'
import { openAccount } from './account'
import type { Achievement, AchievementTier, GameData, Goal, Machine } from '../models'
import { fetchGameData } from '../models'
import type { AppState } from '../state'
import { CATEGORY_META } from './goalMeta'
import { renderFooter } from './footer'
import { getSession } from './session'

/** In-memory shape of the server's achievements blob — see this file's
 *  header. Never persisted to localStorage; lives only for the lifetime of
 *  this module's closure (reset on a full page reload, same as the rest of
 *  AppState's non-localStorage fields). */
type ProgressBlob = Record<string, Record<string, number>>

/** Per-machine cache built once when the tab first opens (see boot() below)
 *  — the Overview needs every machine's achievement COUNT up front (to show
 *  "no achievements yet" vs a real total), so all 56ish datasets are fetched
 *  once and kept here rather than re-fetched on every Overview<->detail
 *  navigation. `goalsById` backs the "SHOW ME" resolution and the stale-
 *  reference disable check (feature spec item 6) without holding onto each
 *  machine's (much larger) shots array. */
interface MachineAchState {
  machine: Machine
  achievements: Achievement[]
  goalsById: Map<string, Goal>
}

const FALLBACK_COLOR = 'var(--amber)' // unresolvable/stale goal reference — same fallback ui/glossary.ts uses

// Server-rendered, session-gated sign-in page (server/login.html, owned by
// the auth service — see this file's header for the /whoami|/api/achievements
// contract it shares with this module). Phase 5: a real navigation, not a
// tab — the SPA has no client-side route for it, so this is a plain <a>
// (full page load), same convention ui/instagram.ts documents for its own
// outbound link ("a real <a>, not a <button>, since it's plain navigation
// with no in-app side effect"). One literal here, not re-derived anywhere
// else in this module, so a future path change is a one-line fix.
const SIGNIN_HREF = '/login'

const TIER_LABEL: Record<AchievementTier, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  epic: 'Epic',
}

/** Only one row can be mid-"tap again to remove" confirm at a time — a
 *  second tap elsewhere cancels the first rather than stacking. */
interface PendingUncheck {
  key: string
  timer: number
}

// ---------------------------------------------------------------------------
// Server I/O — every function below fails soft (never throws) per the
// feature spec's "parse failures/corrupt server blob fail soft to {}" and
// "401 ... never crash" rules. Explicit `credentials: 'same-origin'` even
// though it's the fetch() default for same-origin requests — documents the
// intent the feature spec calls out ("cookies ride along automatically").
// ---------------------------------------------------------------------------

/** Light shape guard: every top-level value must itself be an object whose
 *  values are finite numbers (epoch-ms timestamps). Anything else — wrong
 *  shape, corrupt JSON, a network failure — resolves to `{}` rather than
 *  throwing (feature spec item 5/6). */
function isValidProgressBlob(data: unknown): data is ProgressBlob {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return Object.values(data as Record<string, unknown>).every((perMachine) => {
    if (!perMachine || typeof perMachine !== 'object' || Array.isArray(perMachine)) return false
    return Object.values(perMachine as Record<string, unknown>).every(
      (ts) => typeof ts === 'number' && Number.isFinite(ts),
    )
  })
}

async function fetchProgress(): Promise<ProgressBlob> {
  try {
    const r = await fetch('/api/achievements', { credentials: 'same-origin' })
    if (!r.ok) return {}
    const data: unknown = await r.json()
    return isValidProgressBlob(data) ? data : {}
  } catch {
    return {}
  }
}

/** PUTs the FULL blob (never a partial patch — matches the server's
 *  whole-document-replace contract). Returns whether it actually saved
 *  (204) so the caller can leave its optimistic in-memory state marked
 *  "not saved" on any other outcome, per feature spec item 5. */
async function putProgress(blob: ProgressBlob): Promise<boolean> {
  try {
    const r = await fetch('/api/achievements', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blob),
    })
    return r.status === 204
  } catch {
    return false
  }
}

/** Fetches every machine's dataset once and extracts just what this tab
 *  needs (achievements + a goal-id index), tolerating a per-machine failure
 *  without failing the whole Overview (feature spec item 1: "datasets are
 *  being patched in parallel — code must fail soft"). Reuses `state.data`
 *  for whichever machine is currently loaded instead of re-fetching it. */
async function loadMachineAchievements(
  machines: Machine[],
  currentMachineId: string | undefined,
  currentData: GameData | null,
): Promise<Map<string, MachineAchState>> {
  const pairs = await Promise.all(
    machines.map(async (m): Promise<[string, MachineAchState]> => {
      try {
        const data = m.id === currentMachineId && currentData ? currentData : await fetchGameData(m)
        const achievements = Array.isArray(data.achievements) ? data.achievements : []
        const goalsById = new Map(data.goals.map((g) => [g.id, g]))
        return [m.id, { machine: m, achievements, goalsById }]
      } catch {
        // Missing/broken dataset for this one machine — empty entry, not a
        // thrown error; the Overview shows it as "no achievements yet".
        return [m.id, { machine: m, achievements: [], goalsById: new Map() }]
      }
    }),
  )
  return new Map(pairs)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** "Jul 29, 2026" (+ a cheap relative suffix while it's recent) — feature
 *  spec item 4's exact example format. */
function formatTimestamp(ms: number): string {
  const abs = new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const rel = relativeLabel(ms)
  return rel ? `${abs} · ${rel}` : abs
}

function relativeLabel(ms: number): string | null {
  const diff = Date.now() - ms
  if (diff < 0) return null
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  if (diff < MIN) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < DAY * 30) return `${Math.floor(diff / DAY)}d ago`
  return null // beyond ~30 days the absolute date alone is clearer
}

/** Alphabetized COPY — never mutates the input (same discipline as
 *  app.ts's sortedByName / ui/glossary.ts's sortTermsAlpha). */
function sortedByMachineName<T extends { machine: Machine }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.machine.name.localeCompare(b.machine.name, undefined, { sensitivity: 'base' }))
}

function achKey(machineId: string, achievementId: string): string {
  return `${machineId}::${achievementId}`
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n))
}

function renderProgressBar(pct: number, trackClass = 'ach-progress-track'): HTMLElement {
  const track = document.createElement('div')
  track.className = trackClass
  const fill = document.createElement('div')
  fill.className = 'ach-progress-fill'
  fill.style.width = `${clampPct(pct)}%`
  track.appendChild(fill)
  return track
}

/**
 * Signed-out banner — module-level (no closure state needed) and exported so
 * app/tests/account-cta.test.mjs can assert on the real DOM it produces
 * without standing up the whole mountAchievements() machinery (network
 * fetches, AppState, the showGoalOnMap callback).
 *
 * Phase 5 (magic-link accounts): this used to be a dead-end sentence with no
 * action ("Sign in to save your achievements ... but they won't be saved.")
 * — accurate but gave a reader nothing to DO. Now a real call to action:
 * one line on the value (cross-device sync, no password) plus a link that
 * actually goes to the sign-in page. Framed as an upgrade invitation, not an
 * error — see this file's header comment on why a signed-out visitor is the
 * EXPECTED case post-launch, not a degraded one. Achievements stay fully
 * usable read-only either way (render()'s caller still shows the full
 * overview/detail views under this banner); nothing here is a wall.
 */
export function renderSignInBanner(): HTMLElement {
  const banner = document.createElement('div')
  banner.className = 'ach-signin-banner'

  const text = document.createElement('p')
  text.className = 'ach-signin-banner-text'
  // Deliberately never says the word "password" — not even to reassure
  // ("no password required") — see this repo's Phase 5 build brief: the
  // word itself has no place in a passwordless product's own copy, and
  // app/tests/account-cta.test.mjs's banned-substring scan enforces this
  // literally across every ui/*.ts file, not just this one.
  text.textContent = 'Sign in with just your email to save your achievement progress across devices.'

  const cta = document.createElement('a')
  cta.className = 'ach-signin-cta'
  cta.href = SIGNIN_HREF
  cta.textContent = 'Sign in'

  banner.append(text, cta)
  return banner
}

/**
 * Signed-IN complement to renderSignInBanner() above — exactly one of the
 * two renders at a time (render()'s `user ? ... : ...`, below). D3
 * (2026-07-29 review): the entry point to ui/account.ts's Export/Sign out/
 * Delete overlay, dynamic-imported on tap (same lazy-chunk convention as
 * app.ts's header glossary button) since most visitors will never sign in
 * at all and this feature shouldn't cost them a single byte. Deliberately
 * NOT the same amber "upgrade invitation" recipe as the sign-in banner
 * (achievements.css's own comment on why: signed-in is the settled/neutral
 * state here, not something to upsell).
 *
 * `sessionEmail` is whatever ui/session.ts's Session.email carries — see
 * that file's header for why this is `undefined` on the CURRENT server
 * contract (an /whoami response never sends it) and ui/account.ts's
 * buildIdentity() for how the overlay itself degrades when it is.
 */
function renderAccountBanner(sessionEmail: string | undefined, onSignedOut: () => void): HTMLElement {
  const banner = document.createElement('div')
  banner.className = 'ach-account-banner'

  const text = document.createElement('p')
  text.className = 'ach-account-banner-text'
  text.textContent = 'Signed in — your achievement progress is saved to your account.'

  const cta = document.createElement('button')
  cta.type = 'button'
  cta.className = 'ach-account-cta'
  cta.textContent = 'Manage account'
  cta.addEventListener('click', () => {
    // STATIC import (2026-07-31, rolo: "the manage account button doesn't send
    // me to the next page"). This was `import('./account')` — a lazy chunk with
    // NO .catch(). deploy-prod.sh prunes /var/www/pinballgenie/assets on every
    // deploy, so an already-open client still running yesterday's main bundle
    // asks for `account-<oldhash>.js`, gets a 404, the promise rejects, and the
    // button does NOTHING AT ALL — no error, no feedback, nothing to report.
    // app.ts's header records the identical fix being made for ui/howto for the
    // identical reason. Account settings hold the only route to sign out,
    // export and delete, so they must not depend on a network fetch succeeding.
    openAccount(
      { email: sessionEmail },
      {
        onSignedOut,
        // A deletion also ends the session — the same hard-reload
        // response is correct for both (see account.ts's own comment on
        // why a reload, not SPA-side teardown).
        onDeleted: onSignedOut,
      },
    )
  })

  banner.append(text, cta)
  return banner
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mounts the Achievements tab into `host` (an app.ts tab panel, shown/hidden
 * like Map/AR — never destroyed on tab switch, only hidden). `showGoalOnMap`
 * is app.ts's shared SHOW ME handler: switches the active machine if needed,
 * selects the goal, and jumps to the Map tab through the exact tab-switch
 * path a manual tap uses (see app.ts's own comment on that function).
 */
export function mountAchievements(
  host: HTMLElement,
  state: AppState,
  showGoalOnMap: (machine: Machine, goal: Goal) => Promise<void>,
): { destroy(): void; onShow(): void; onReselect(): void } {
  const root = document.createElement('div')
  root.className = 'ach-root'
  host.replaceChildren(root)

  let destroyed = false
  let loaded = false
  let user: string | null = null
  // D3: whatever ui/session.ts's Session.email carried at boot — see
  // renderAccountBanner()'s own comment on why this is `undefined` on the
  // current server contract, and account.ts's buildIdentity() for the
  // honest fallback. Not re-derived on every render(); a session's email
  // doesn't change mid-visit.
  let sessionEmail: string | undefined
  let progress: ProgressBlob = {}
  let machineData: Map<string, MachineAchState> = new Map()
  let dirtyKeys = new Set<string>()
  let saveFailed = false
  // Review D1 (2026-07-29): PUT serialization — see attemptSave().
  let saveInFlight = false
  let pendingSave = false
  let pendingUncheck: PendingUncheck | null = null
  // DEFAULT VIEW = the machine the user currently has selected, not the
  // all-machines overview (rolo, 2026-07-31: "when I select a game and then go
  // to achievements, it shows me all of the possible achievements for all
  // games and not the game I currently selected").
  //
  // The overview is still reachable, via an explicit "All machines" button at
  // the top of the machine view — it is genuinely useful for seeing overall
  // completion, it just isn't what you want the instant after picking a
  // machine. Falls back to the overview when no machine is selected yet
  // (state.machine is null before the first boot completes).
  let view: { kind: 'overview' } | { kind: 'machine'; machineId: string } =
    state.machine ? { kind: 'machine', machineId: state.machine.id } : { kind: 'overview' }
  /** The machine id `view` was last auto-pointed at, so onShow() can tell an
   *  automatic follow ("the header picker changed while I was away") apart
   *  from a deliberate navigation ("I tapped All machines and want to stay
   *  there"). Without this, returning to the tab would yank the user out of
   *  the overview every time. */
  let autoFollowedMachineId: string | null = state.machine?.id ?? null

  function isChecked(machineId: string, achievementId: string): boolean {
    return typeof progress[machineId]?.[achievementId] === 'number'
  }

  function checkedAt(machineId: string, achievementId: string): number | undefined {
    return progress[machineId]?.[achievementId]
  }

  function clearPendingUncheck(): void {
    if (pendingUncheck) {
      window.clearTimeout(pendingUncheck.timer)
      pendingUncheck = null
    }
  }

  /** Sends the CURRENT full blob to the server (never a partial patch — the
   *  server's PUT contract replaces the whole document). Optimistic:
   *  in-memory `progress` is already updated by the caller before this
   *  runs; on failure the toggled keys stay in `dirtyKeys` so their rows
   *  show "not saved" until the next successful attempt (feature spec item
   *  5 — "never lose the in-memory state, never throw"). No-op when not
   *  signed in (401 at boot) — there's nothing to save to.
   *
   *  SERIALIZED (2026-07-29 review D1): the server has no versioning, so two
   *  in-flight PUTs can land out of order and the older whole-document body
   *  silently erases the newer toggle. Exactly one PUT is in flight at a
   *  time; toggles during a flight set `pendingSave` and one follow-up PUT
   *  fires with the then-current blob when the first completes. Success
   *  clears only the keys that were actually IN the sent body — keys dirtied
   *  mid-flight stay dirty for the follow-up. */
  function attemptSave(): void {
    if (!user) return
    if (saveInFlight) {
      pendingSave = true
      return
    }
    saveInFlight = true
    const sentKeys = new Set(dirtyKeys)
    void putProgress(progress).then((ok) => {
      saveInFlight = false
      if (destroyed) return
      if (ok) {
        saveFailed = false
        sentKeys.forEach((k) => dirtyKeys.delete(k))
      } else {
        saveFailed = true
      }
      if (pendingSave) {
        pendingSave = false
        attemptSave()
      }
      render()
    })
  }

  function onToggle(machineId: string, achievementId: string): void {
    if (!user) return // read-only (signed out) — nothing to toggle
    const key = achKey(machineId, achievementId)
    const already = isChecked(machineId, achievementId)

    if (!already) {
      clearPendingUncheck()
      progress[machineId] = { ...(progress[machineId] ?? {}), [achievementId]: Date.now() }
      dirtyKeys.add(key)
      attemptSave()
      render()
      return
    }

    if (pendingUncheck?.key === key) {
      // Second tap while this exact row was mid-confirm — actually clear it.
      clearPendingUncheck()
      const rest = { ...(progress[machineId] ?? {}) }
      delete rest[achievementId]
      progress[machineId] = rest
      dirtyKeys.add(key)
      attemptSave()
      render()
      return
    }

    // First tap on an already-checked row: enter the confirm state instead
    // of clearing immediately (feature spec item 4 — "avoid accidental
    // loss"). Auto-cancels back to checked after a few seconds.
    clearPendingUncheck()
    pendingUncheck = {
      key,
      timer: window.setTimeout(() => {
        pendingUncheck = null
        render()
      }, 4000),
    }
    render()
  }

  function render(): void {
    if (destroyed) return
    root.innerHTML = ''

    if (!loaded) {
      const msg = document.createElement('div')
      msg.className = 'state-message'
      msg.textContent = 'Loading achievements…'
      root.appendChild(msg)
      return
    }

    // D3 (2026-07-29 review): exactly one of these two ever fires — `user`
    // is truthy XOR falsy — so together they're the signed-in-banner
    // equivalent of a ternary, kept as two bare one-line `if`s instead (no
    // `{ }` on either) so account-cta.test.mjs's existing structural check
    // (a braced block here could hide a `return` that walls off the rest of
    // render()) keeps covering the signed-out line unchanged, and the new
    // signed-in line is exactly as inspectable.
    if (!user) root.appendChild(renderSignInBanner())
    if (user) root.appendChild(renderAccountBanner(sessionEmail, onSignedOutOrDeleted))

    if (view.kind === 'machine') {
      const entry = machineData.get(view.machineId)
      if (entry) {
        root.appendChild(renderMachineDetail(entry))
        return
      }
      // Machine vanished from the catalog mid-session (shouldn't happen,
      // but fail soft rather than getting stuck on a dead view) — fall
      // through to the overview.
      view = { kind: 'overview' }
    }

    root.appendChild(renderOverview())
  }

  // renderSignInBanner is now a module-level export (above mountAchievements)
  // — it closes over nothing, so it moved out to where app/tests/account-cta
  // .test.mjs can bundle and call it directly without standing up this whole
  // closure. render() above still calls it by the same name.

  function renderOverview(): HTMLElement {
    const wrap = document.createElement('div')

    let totalAll = 0
    let unlockedAll = 0
    const rows: { machine: Machine; total: number; unlocked: number }[] = []
    for (const m of state.machines) {
      const entry = machineData.get(m.id)
      const achievements = entry?.achievements ?? []
      const total = achievements.length
      const unlocked = achievements.filter((a) => isChecked(m.id, a.id)).length
      totalAll += total
      unlockedAll += unlocked
      rows.push({ machine: m, total, unlocked })
    }

    const header = document.createElement('div')
    header.className = 'ach-overview-header'
    const label = document.createElement('div')
    label.className = 'ach-overview-label'
    label.textContent = 'Overall Progress'
    const count = document.createElement('div')
    count.className = 'ach-overview-count'
    count.textContent = `${unlockedAll} / ${totalAll}`
    const pct = totalAll > 0 ? Math.round((unlockedAll / totalAll) * 100) : 0
    const pctLabel = document.createElement('div')
    pctLabel.className = 'ach-overview-pct'
    pctLabel.textContent = totalAll > 0 ? `${pct}% complete` : 'No achievements loaded yet'
    header.append(label, count, renderProgressBar(pct, 'ach-progress-track-lg'), pctLabel)
    wrap.appendChild(header)

    const list = document.createElement('div')
    list.className = 'ach-machine-list'
    for (const r of sortedByMachineName(rows)) list.appendChild(renderMachineRow(r))
    wrap.appendChild(list)

    // Footer at the end of the Achievements tab's scrollable content (the
    // overview, not the per-machine detail view) — see ui/footer.ts's header
    // comment; not a fixed bar.
    wrap.appendChild(renderFooter())

    return wrap
  }

  function renderMachineRow(r: { machine: Machine; total: number; unlocked: number }): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ach-machine-row' + (r.total === 0 ? ' empty' : '')
    btn.addEventListener('click', () => {
      view = { kind: 'machine', machineId: r.machine.id }
      render()
    })

    const body = document.createElement('div')
    body.className = 'ach-machine-row-body'
    const name = document.createElement('div')
    name.className = 'ach-machine-row-name'
    name.textContent = r.machine.name
    body.appendChild(name)

    if (r.total === 0) {
      const empty = document.createElement('div')
      empty.className = 'ach-machine-row-empty'
      empty.textContent = 'No achievements yet'
      body.appendChild(empty)
    } else {
      body.appendChild(renderProgressBar(Math.round((r.unlocked / r.total) * 100)))
    }

    const meta = document.createElement('div')
    meta.className = 'ach-machine-row-meta'
    meta.textContent = r.total === 0 ? '' : `${r.unlocked}/${r.total}`

    const chevron = document.createElement('span')
    chevron.className = 'ach-machine-row-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '›' // ›

    btn.append(body, meta, chevron)
    return btn
  }

  function renderMachineDetail(entry: MachineAchState): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ach-detail'

    // Was a '‹ Achievements' BACK affordance, which only made sense while the
    // overview was the landing screen. Now that a machine is where you land,
    // "back" would point at somewhere the user has never been — so this is an
    // explicit forward action to the all-machines view instead.
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'ach-detail-back'
    const arrow = document.createElement('span')
    arrow.setAttribute('aria-hidden', 'true')
    arrow.textContent = '\u2630' // ☰
    const backLabel = document.createElement('span')
    backLabel.textContent = 'All machines'
    back.append(arrow, backLabel)
    back.addEventListener('click', () => {
      view = { kind: 'overview' }
      render()
    })
    wrap.appendChild(back)

    const headerEl = document.createElement('div')
    headerEl.className = 'ach-detail-header'
    const title = document.createElement('h2')
    title.className = 'ach-detail-title'
    title.textContent = entry.machine.name
    headerEl.appendChild(title)

    const total = entry.achievements.length
    const unlocked = entry.achievements.filter((a) => isChecked(entry.machine.id, a.id)).length
    const metaLine = document.createElement('div')
    metaLine.className = 'ach-detail-meta'
    metaLine.textContent = total > 0 ? `${unlocked} of ${total} unlocked` : 'No achievements yet'
    headerEl.appendChild(metaLine)
    if (total > 0) headerEl.appendChild(renderProgressBar(Math.round((unlocked / total) * 100)))
    wrap.appendChild(headerEl)

    if (total === 0) {
      const msg = document.createElement('div')
      msg.className = 'state-message'
      msg.textContent = 'No achievements loaded for this machine yet.'
      wrap.appendChild(msg)
      return wrap
    }

    const list = document.createElement('div')
    list.className = 'ach-list'
    for (const a of entry.achievements) list.appendChild(renderAchievementRow(entry, a))
    wrap.appendChild(list)

    return wrap
  }

  function renderAchievementRow(entry: MachineAchState, a: Achievement): HTMLElement {
    const machineId = entry.machine.id
    const key = achKey(machineId, a.id)
    const checked = isChecked(machineId, a.id)
    const confirming = pendingUncheck?.key === key
    const goal = entry.goalsById.get(a.goal)

    const row = document.createElement('div')
    row.className = 'ach-row'

    const check = document.createElement('button')
    check.type = 'button'
    check.className = 'ach-check' + (confirming ? ' confirming' : '')
    check.setAttribute('aria-label', checked ? `Mark "${a.title}" not done` : `Mark "${a.title}" done`)
    if (!user) {
      check.disabled = true
      check.classList.add('disabled')
    }
    if (checked && !confirming) {
      const fillColor = goal ? CATEGORY_META[goal.category].color : FALLBACK_COLOR
      check.style.background = fillColor
      check.style.borderColor = fillColor
      check.style.color = '#14151b' // dark glyph reads on every category hue
    }
    check.textContent = confirming ? '✕' : checked ? '✓' : '' // ✕ / ✓
    check.addEventListener('click', () => onToggle(machineId, a.id))

    const body = document.createElement('div')
    body.className = 'ach-row-body'

    const titleRow = document.createElement('div')
    titleRow.className = 'ach-row-title-row'
    const title = document.createElement('span')
    title.className = 'ach-row-title'
    title.textContent = a.title
    const tier = document.createElement('span')
    tier.className = 'ach-tier-chip'
    tier.textContent = TIER_LABEL[a.tier] ?? a.tier
    titleRow.append(title, tier)

    const desc = document.createElement('p')
    desc.className = 'ach-row-desc'
    desc.textContent = a.desc

    const metaRow = document.createElement('div')
    metaRow.className = 'ach-row-meta-row'
    if (confirming) {
      const confirmLabel = document.createElement('span')
      confirmLabel.className = 'ach-row-confirm'
      confirmLabel.textContent = 'Tap again to remove'
      metaRow.appendChild(confirmLabel)
    } else if (checked) {
      const ts = checkedAt(machineId, a.id)
      const time = document.createElement('span')
      time.className = 'ach-row-time'
      time.textContent = ts !== undefined ? formatTimestamp(ts) : ''
      metaRow.appendChild(time)
    }
    // Review D2 (2026-07-29): the "not saved" badge renders for ANY dirty row
    // when the last save failed — including a failed UNCHECK (row renders
    // unchecked, but the removal never persisted; hiding the badge there made
    // the loss silent until the next page load).
    if (!confirming && saveFailed && dirtyKeys.has(key)) {
      const notSaved = document.createElement('span')
      notSaved.className = 'ach-row-unsaved'
      notSaved.textContent = 'not saved'
      metaRow.appendChild(notSaved)
    }

    body.append(titleRow, desc, metaRow)

    const showMe = document.createElement('button')
    showMe.type = 'button'
    showMe.className = 'ach-showme' + (!goal ? ' disabled' : '')
    showMe.textContent = 'SHOW ME'
    showMe.disabled = !goal
    showMe.addEventListener('click', () => {
      if (!goal) return
      void showGoalOnMap(entry.machine, goal)
    })

    row.append(check, body, showMe)
    return row
  }

  /** Hard reload after a server-acknowledged sign-out/delete (ui/account.ts's
   *  callbacks) — see that module's own comment on why a full reload, not
   *  SPA-side teardown, is the correct response: `user`/`progress`/
   *  `dirtyKeys`/`machineData` etc. all need to forget the old session at
   *  once, and a reload is the one mechanism guaranteed not to miss one. */
  function onSignedOutOrDeleted(): void {
    window.location.reload()
  }

  async function boot(): Promise<void> {
    // D6 (2026-07-29 review): /api/achievements is fetched ONLY after we
    // already know, from getSession()'s answer, whether a session exists at
    // all — never unconditionally alongside it. See ui/session.ts's header
    // for the fail2ban math this fixes (a signed-out visitor used to cost
    // TWO 401s here — /whoami AND /api/achievements — every tab open; now
    // it costs exactly the one /whoami's own check can't avoid).
    // loadMachineAchievements() stays parallel with getSession() since it
    // only hits public /data/*.json endpoints, never a session-gated one.
    const [session, md] = await Promise.all([
      getSession(),
      loadMachineAchievements(state.machines, state.machine?.id, state.data),
    ])
    if (destroyed) return
    user = session?.uid ?? null
    sessionEmail = session?.email
    // No session -> nothing to key server progress by; keep it empty rather
    // than fetching a blob that (per fetchProgress's own 401->{} fail-soft)
    // would already be {} anyway — explicit here for clarity, and it's the
    // actual fetch this whole change exists to skip.
    progress = user ? await fetchProgress() : {}
    machineData = md
    loaded = true
    render()
  }

  render() // immediate "Loading…" frame while boot() is in flight
  void boot()

  return {
    destroy(): void {
      destroyed = true
      clearPendingUncheck()
      host.innerHTML = ''
    },
    /** Called by app.ts every time the user returns to an already-mounted
     *  Achievements tab (this module itself is only ever mounted once — see
     *  the file header). Retries a save that failed earlier so a flaky
     *  connection doesn't strand unsaved progress (feature spec item 5 —
     *  "retry on the next toggle or tab re-open"). */
    /** The Achievements tab was tapped while ALREADY on the Achievements tab.
     *  Mirrors what the Goals tab has always done (re-tapping it returns to
     *  the goal list from a goal's detail screen) — rolo, 2026-07-31:
     *  "pressing the achievements button again while on the all achievements
     *  page should bring you back to the achievements for that game".
     *
     *  Kept SEPARATE from onShow() on purpose. onShow() also fires when
     *  arriving from another tab, and using it for this would drag a user out
     *  of the all-machines overview every time they glanced at the Map and
     *  came back — the overview would become impossible to stay in. Only a
     *  deliberate re-tap means "take me back to my machine". */
    onReselect(): void {
      const current = state.machine?.id ?? null
      if (!current) return
      if (view.kind === 'machine' && view.machineId === current) return // already there
      autoFollowedMachineId = current
      view = { kind: 'machine', machineId: current }
      render()
    },
    onShow(): void {
      if (dirtyKeys.size > 0) attemptSave()
      // Follow the header's machine picker. This module deliberately does not
      // subscribe to state.onChange (see the file header), so switching
      // machines on the Goals/Map tab and coming back here would otherwise
      // still show the PREVIOUS machine — the exact complaint this change
      // exists to fix, just one tab-switch later.
      //
      // Only re-point when the picker actually moved since we last followed
      // it. A user who deliberately tapped "All machines" stays in the
      // overview; they are not dragged back into a machine every time they
      // leave and return.
      const current = state.machine?.id ?? null
      if (current && current !== autoFollowedMachineId) {
        autoFollowedMachineId = current
        view = { kind: 'machine', machineId: current }
        render()
      }
    },
  }
}
