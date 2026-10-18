#!/usr/bin/env node
// app/tests/state-machine-load.test.mjs — SUITE 23: machine switching
// (src/state.ts), P6 L1 (2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/state-machine-load.test.mjs"
// or from app/:
//   node tests/state-machine-load.test.mjs
//
// WHY THIS SUITE EXISTS. Until P6 the header picker called
// `void state.selectMachine(m)` and `loadMachine` awaited fetchGameData with
// no try/catch at all. A failed dataset fetch therefore produced (a) an
// unhandled promise rejection, and (b) a UI that just sat on the previous
// machine with no explanation — the failure had nowhere to be seen. Every
// assertion below is about the CONTRACT that replaces that:
//
//   - loadMachine RESOLVES on failure (never rejects) and publishes the
//     outcome as state instead. Testing "does not reject" is the whole point:
//     a regression here is silent in the browser until a venue's Wi-Fi drops.
//   - A failure leaves `machine`/`data`/`shotsByID`/`trim` COMPLETELY
//     UNTOUCHED. Half-switching is the failure mode that would look like a
//     working app while showing one machine's name over another's shots.
//   - "Success" means the load that is still WANTED won. Two quick taps used
//     to race; the generation token means the loser writes nothing at all.
//   - Recents/pinned are persisted, deduped, capped, and validated against the
//     live catalog, so a stale stored id can never become a card that 404s.
//   - bootMachine STILL rejects, deliberately — main.ts's boot catch is the
//     app's only "Couldn't load Pinball Genie" surface.
//
// Pattern: esbuild bundles the REAL src/state.ts into a temp ESM file, driven
// against stub localStorage/fetch/window globals — the same technique as
// sheet.test.mjs and study.test.mjs (no test framework in this repo; see
// scripts/run-tests.mjs). The fetch stub is DEFERRED (each machine's response
// is resolved by hand) so the in-flight window is a real, observable state and
// two loads can genuinely overlap.
//
// Sections:
//   a. readMachineIdList: hostile/stale inputs, dedupe, cap, catalog gate.
//   b. pushRecentId: most-recent-first, dedupe-by-move, cap arithmetic.
//   c. Boot: restores both lists, records the booted machine as recent.
//   d. Success path: loading flag rises and falls, machine/data swap, recents.
//   e. Failure path: resolves, flags, and NOTHING about the loaded machine moves.
//   f. Retry after a failure loads the machine.
//   g. Races: a superseded load writes nothing; re-picking the current machine
//      clears a stale error and cancels an in-flight load.
//   h. Pinned: toggle round-trip, persistence, unknown-id refusal.
//   i. bootMachine still rejects, so main.ts's error surface survives.
//
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const statePath = resolve(srcDir, 'state.ts')

// ---------------------------------------------------------------------------
// Harness (identical shape to every other suite here)
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}
async function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = await fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}${evidence ? `\n          ${evidence}` : ''}`)
  } catch (err) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}\n          ${err && err.stack ? err.stack : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Fixtures — a miniature catalog + one dataset per machine.
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: 'jaws', name: 'Jaws (Stern Pinball, 2024)', shortTitle: 'JAWS', resource: 'jaws_goals' },
  { id: 'godzilla', name: 'Godzilla (Stern Pinball, 2021)', shortTitle: 'GODZILLA', resource: 'godzilla_goals' },
  { id: 'comet', name: 'Comet (Williams, 1985)', shortTitle: 'COMET', resource: 'comet_goals' },
  { id: 'bronco', name: 'Bronco (Gottlieb, 1977)', shortTitle: 'BRONCO', resource: 'bronco_goals' },
]

function datasetFor(id) {
  return {
    machine: `${id} dataset`,
    shots: [{ id: `${id}-shot`, name: `${id} shot`, type: 'ramp', x: 0.5, y: 0.5, trim: 'all' }],
    goals: [],
    sources: [],
  }
}

/** Installs the globals src/state.ts touches, plus a DEFERRED fetch: each
 *  request parks in `pending` until the test resolves or rejects it by hand.
 *  That is what makes "loading" an observable window rather than a value that
 *  has already flipped back by the time the test looks at it. */
function withEnv(fn, { storage = {} } = {}) {
  const prior = {
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    window: globalThis.window,
    performance: globalThis.performance,
  }
  const store = new Map(Object.entries(storage))
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.window = { location: { search: '' } }
  globalThis.performance = { now: () => 0 }

  const pending = new Map() // url -> { resolve, reject }
  const requested = []
  globalThis.fetch = (url) => {
    requested.push(url)
    return new Promise((res, rej) => {
      pending.set(url, {
        ok: (body) => res({ ok: true, status: 200, json: async () => body }),
        http: (status) => res({ ok: false, status, json: async () => ({}) }),
        boom: (message) => rej(new Error(message)),
      })
    })
  }
  /** Settles one parked request. Waits a microtask turn first, so a caller can
   *  `settle()` immediately after kicking a load off without racing the
   *  fetch() call itself. */
  async function settle(url, how, arg) {
    for (let i = 0; i < 50 && !pending.has(url); i += 1) await Promise.resolve()
    const p = pending.get(url)
    if (!p) throw new Error(`no pending request for ${url} (requested: ${requested.join(', ') || 'nothing'})`)
    pending.delete(url)
    p[how](arg)
    // Let the awaiting continuation inside state.ts run before returning.
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  function restore() {
    globalThis.localStorage = prior.localStorage
    globalThis.fetch = prior.fetch
    globalThis.window = prior.window
    globalThis.performance = prior.performance
  }
  const env = { store, settle, requested, pendingCount: () => pending.size }
  return Promise.resolve()
    .then(() => fn(env))
    .then(
      (v) => (restore(), v),
      (e) => (restore(), Promise.reject(e)),
    )
}

const DATA = (id) => `/data/${id}_goals.json`
const CATALOG_URL = '/data/catalog.json'

/** Boots a real AppState with `jaws` loaded and both lists restored from
 *  `storage`. Returns the state plus the env handle. */
async function bootedState(env, { storedMachine = 'jaws' } = {}) {
  if (storedMachine) env.store.set('pinballgenie.machineId', storedMachine)
  const p = createAppState()
  await env.settle(CATALOG_URL, 'ok', CATALOG)
  await env.settle(DATA(storedMachine || 'jaws'), 'ok', datasetFor(storedMachine || 'jaws'))
  return p
}

// ---------------------------------------------------------------------------
// Bundle the real module.
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-stateload-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(entry, `export * from ${JSON.stringify(statePath)}\n`)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
})
const {
  createAppState,
  readMachineIdList,
  pushRecentId,
  RECENT_MACHINES_KEY,
  PINNED_MACHINES_KEY,
  RECENT_MACHINES_CAP,
} = await import(pathToFileURL(outfile).href)

const CATALOG_IDS = new Set(CATALOG.map((m) => m.id))

// ===========================================================================
section('a. readMachineIdList: stale, hostile and malformed stored values')
// ===========================================================================

await test('a stored id whose machine has LEFT the catalog is dropped', () =>
  withEnv(async () => {
    globalThis.localStorage.setItem('k', JSON.stringify(['jaws', 'machine-that-was-retired', 'comet']))
    const out = readMachineIdList('k', CATALOG_IDS)
    assert(
      JSON.stringify(out) === JSON.stringify(['jaws', 'comet']),
      `expected the unknown id to be dropped, got ${JSON.stringify(out)}`,
    )
    return `["jaws","machine-that-was-retired","comet"] -> ${JSON.stringify(out)}`
  }))

await test('non-string entries are dropped without throwing', () =>
  withEnv(async () => {
    globalThis.localStorage.setItem('k', JSON.stringify(['jaws', 42, null, { id: 'comet' }, ['comet'], 'comet']))
    const out = readMachineIdList('k', CATALOG_IDS)
    assert(JSON.stringify(out) === JSON.stringify(['jaws', 'comet']), `got ${JSON.stringify(out)}`)
    return `6 mixed-type entries -> ${JSON.stringify(out)}`
  }))

await test('duplicates collapse to the first occurrence', () =>
  withEnv(async () => {
    globalThis.localStorage.setItem('k', JSON.stringify(['jaws', 'comet', 'jaws', 'jaws']))
    const out = readMachineIdList('k', CATALOG_IDS)
    assert(JSON.stringify(out) === JSON.stringify(['jaws', 'comet']), `got ${JSON.stringify(out)}`)
    return JSON.stringify(out)
  }))

await test('the cap is applied AFTER filtering, not before', () =>
  withEnv(async () => {
    // Two junk ids up front: a cap applied to the raw array would return
    // nothing at all here.
    globalThis.localStorage.setItem('k', JSON.stringify(['nope-1', 'nope-2', 'jaws', 'comet', 'bronco']))
    const out = readMachineIdList('k', CATALOG_IDS, 2)
    assert(JSON.stringify(out) === JSON.stringify(['jaws', 'comet']), `got ${JSON.stringify(out)}`)
    return `cap 2 over 2 junk + 3 real -> ${JSON.stringify(out)}`
  }))

await test('malformed JSON, a stored object, and a never-set key all read as []', () =>
  withEnv(async () => {
    globalThis.localStorage.setItem('bad', '{not json')
    globalThis.localStorage.setItem('obj', JSON.stringify({ jaws: true }))
    for (const key of ['bad', 'obj', 'never-set']) {
      const out = readMachineIdList(key, CATALOG_IDS)
      assert(Array.isArray(out) && out.length === 0, `${key} -> ${JSON.stringify(out)}`)
    }
    return 'malformed / object / absent -> [] x3'
  }))

await test('a localStorage that THROWS on getItem reads as [] (private mode)', () =>
  withEnv(async () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error('SecurityError: localStorage is disabled')
      },
      setItem() {
        throw new Error('SecurityError: localStorage is disabled')
      },
    }
    const out = readMachineIdList('k', CATALOG_IDS)
    assert(Array.isArray(out) && out.length === 0, `got ${JSON.stringify(out)}`)
    return 'throwing storage -> []'
  }))

// ===========================================================================
section('b. pushRecentId: most-recent-first, dedupe by MOVE, cap')
// ===========================================================================

await test('a new id goes to the front', () => {
  const out = pushRecentId(['comet', 'jaws'], 'bronco')
  assert(JSON.stringify(out) === JSON.stringify(['bronco', 'comet', 'jaws']), JSON.stringify(out))
  return JSON.stringify(out)
})

await test('a REVISIT moves the id up instead of listing it twice', () => {
  const out = pushRecentId(['comet', 'jaws', 'bronco'], 'jaws')
  assert(JSON.stringify(out) === JSON.stringify(['jaws', 'comet', 'bronco']), JSON.stringify(out))
  assert(out.filter((x) => x === 'jaws').length === 1, 'jaws must appear exactly once')
  return JSON.stringify(out)
})

await test(`the cap holds at ${RECENT_MACHINES_CAP} and drops the OLDEST`, () => {
  let list = []
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  for (const id of ids) list = pushRecentId(list, id)
  assert(list.length === RECENT_MACHINES_CAP, `expected ${RECENT_MACHINES_CAP} entries, got ${list.length}`)
  assert(list[0] === 'h', `newest first: expected 'h', got ${list[0]}`)
  assert(!list.includes('a') && !list.includes('b'), `oldest two should be gone: ${JSON.stringify(list)}`)
  return `pushed 8 -> ${JSON.stringify(list)}`
})

// ===========================================================================
section('c. Boot restores both persisted lists and records the booted machine')
// ===========================================================================

await test('recents/pinned come back from localStorage, filtered to the catalog', () =>
  withEnv(
    async (env) => {
      const state = await bootedState(env)
      assert(
        JSON.stringify(state.pinnedMachineIds) === JSON.stringify(['comet', 'bronco']),
        `pinned: ${JSON.stringify(state.pinnedMachineIds)}`,
      )
      // 'jaws' was booted, so it is prepended to the restored recents.
      assert(
        JSON.stringify(state.recentMachineIds) === JSON.stringify(['jaws', 'comet']),
        `recents: ${JSON.stringify(state.recentMachineIds)}`,
      )
      return `pinned ${JSON.stringify(state.pinnedMachineIds)} · recents ${JSON.stringify(state.recentMachineIds)}`
    },
    {
      storage: {
        [PINNED_MACHINES_KEY]: JSON.stringify(['comet', 'gone-from-catalog', 'bronco']),
        [RECENT_MACHINES_KEY]: JSON.stringify(['comet', 'also-gone']),
      },
    },
  ))

// ===========================================================================
section('d. Success path: the loading flag is a real window, then the swap')
// ===========================================================================

await test('machineLoading is TRUE while the dataset is in flight and FALSE after', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const seen = []
    state.onChange(() => seen.push(state.machineLoading))
    const godzilla = CATALOG[1]
    const p = state.selectMachine(godzilla)
    // Give the synchronous part of loadMachine (flag + notify) a turn to run.
    await Promise.resolve()
    assert(state.machineLoading === true, 'expected machineLoading true while the fetch is parked')
    assert(state.machine.id === 'jaws', 'the OLD machine must still be the loaded one mid-flight')
    await env.settle(DATA('godzilla'), 'ok', datasetFor('godzilla'))
    await p
    assert(state.machineLoading === false, 'expected machineLoading false after settle')
    assert(state.machine.id === 'godzilla', `expected godzilla, got ${state.machine.id}`)
    assert(state.machineError === null, `expected no error, got ${JSON.stringify(state.machineError)}`)
    assert(seen.includes(true) && seen.includes(false), `subscribers saw both edges: ${JSON.stringify(seen)}`)
    return `notify sequence machineLoading: ${JSON.stringify(seen)}`
  }))

await test('a successful switch prepends to recents AND persists them', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'ok', datasetFor('godzilla'))
    await p
    assert(
      JSON.stringify(state.recentMachineIds) === JSON.stringify(['godzilla', 'jaws']),
      `in memory: ${JSON.stringify(state.recentMachineIds)}`,
    )
    const persisted = JSON.parse(env.store.get(RECENT_MACHINES_KEY))
    assert(
      JSON.stringify(persisted) === JSON.stringify(['godzilla', 'jaws']),
      `on disk: ${JSON.stringify(persisted)}`,
    )
    return `localStorage[${RECENT_MACHINES_KEY}] = ${JSON.stringify(persisted)}`
  }))

// ===========================================================================
section('e. Failure path: resolves, flags, and nothing else moves')
// ===========================================================================

await test('selectMachine RESOLVES on a network error (it must never reject)', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    let rejected = null
    const p = state.selectMachine(CATALOG[1]).catch((e) => (rejected = e))
    await env.settle(DATA('godzilla'), 'boom', 'NetworkError: Failed to fetch')
    await p
    assert(rejected === null, `expected a resolved promise, got rejection: ${rejected}`)
    return 'promise resolved; no rejection observed'
  }))

await test('an HTTP 404 is a failure too (models.ts throws on !r.ok)', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'http', 404)
    await p
    assert(state.machineError !== null, 'expected machineError to be set for a 404')
    assert(/404/.test(state.machineError.message), `message should name the status: ${state.machineError.message}`)
    return `machineError.message = ${JSON.stringify(state.machineError.message)}`
  }))

await test('machineError names the machine that FAILED, not the one still loaded', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await p
    assert(state.machineError?.machineId === 'godzilla', `got ${JSON.stringify(state.machineError)}`)
    assert(state.machine.id === 'jaws', 'the loaded machine is still jaws')
    return `machineError = ${JSON.stringify(state.machineError)} while state.machine.id = ${state.machine.id}`
  }))

await test('a failed switch leaves machine/data/shotsByID/trim COMPLETELY untouched', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const before = {
      machine: state.machine,
      data: state.data,
      shots: [...state.shotsByID.keys()],
      trim: state.trim,
      loading: state.machineLoading,
    }
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await p
    assert(state.machine === before.machine, 'machine object identity changed')
    assert(state.data === before.data, 'data object identity changed')
    assert(JSON.stringify([...state.shotsByID.keys()]) === JSON.stringify(before.shots), 'shotsByID changed')
    assert(state.trim === before.trim, 'trim changed')
    assert(state.machineLoading === false, 'machineLoading must be cleared on failure')
    return `machine/data identity preserved; shotsByID still ${JSON.stringify(before.shots)}`
  }))

await test('a FAILED machine is not written into recents', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await p
    assert(
      !state.recentMachineIds.includes('godzilla'),
      `recents must not contain a machine that never loaded: ${JSON.stringify(state.recentMachineIds)}`,
    )
    return `recents after the failure: ${JSON.stringify(state.recentMachineIds)}`
  }))

// ===========================================================================
section('f. Retry: the same machine, tapped again, loads')
// ===========================================================================

await test('Retry after a failure clears the error and completes the switch', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const first = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await first
    assert(state.machineError !== null, 'precondition: the first attempt failed')

    const second = state.selectMachine(CATALOG[1])
    await Promise.resolve()
    assert(state.machineError === null, 'the error must clear the moment a retry starts')
    await env.settle(DATA('godzilla'), 'ok', datasetFor('godzilla'))
    await second
    assert(state.machine.id === 'godzilla', `expected godzilla after retry, got ${state.machine.id}`)
    assert(state.machineError === null && state.machineLoading === false, 'flags must be clean after a retry')
    return 'fail -> retry -> godzilla loaded, flags clean'
  }))

// ===========================================================================
section('g. Races: a superseded load writes nothing')
// ===========================================================================

await test('two overlapping switches: the SUPERSEDED one cannot win, even settling last', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const a = state.selectMachine(CATALOG[1]) // godzilla — will settle LAST
    await Promise.resolve()
    const b = state.selectMachine(CATALOG[2]) // comet — the one the user wants
    await Promise.resolve()
    await env.settle(DATA('comet'), 'ok', datasetFor('comet'))
    await b
    assert(state.machine.id === 'comet', `expected comet, got ${state.machine.id}`)
    // Now the abandoned request finally answers. Pre-P6 this clobbered comet.
    await env.settle(DATA('godzilla'), 'ok', datasetFor('godzilla'))
    await a
    assert(state.machine.id === 'comet', `the superseded load overwrote the wanted one: ${state.machine.id}`)
    assert(state.machineLoading === false, 'machineLoading must be false')
    assert(
      !state.recentMachineIds.includes('godzilla'),
      `a superseded load must not touch recents: ${JSON.stringify(state.recentMachineIds)}`,
    )
    return `godzilla settled after comet and changed nothing; recents ${JSON.stringify(state.recentMachineIds)}`
  }))

await test('a superseded load that FAILS raises no banner for a machine nobody is waiting on', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const a = state.selectMachine(CATALOG[1]) // godzilla — abandoned
    await Promise.resolve()
    const b = state.selectMachine(CATALOG[2]) // comet
    await Promise.resolve()
    await env.settle(DATA('comet'), 'ok', datasetFor('comet'))
    await b
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await a
    assert(state.machineError === null, `expected no error, got ${JSON.stringify(state.machineError)}`)
    assert(state.machine.id === 'comet', `expected comet, got ${state.machine.id}`)
    return 'abandoned failure suppressed; comet still loaded, no error state'
  }))

await test('re-picking the CURRENT machine clears a stale error from a failed switch', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const p = state.selectMachine(CATALOG[1])
    await env.settle(DATA('godzilla'), 'boom', 'Failed to fetch')
    await p
    assert(state.machineError !== null, 'precondition: an error is showing')
    let notified = 0
    state.onChange(() => (notified += 1))
    await state.selectMachine(CATALOG[0]) // jaws — already loaded
    assert(state.machineError === null, 'the stale error must be cleared')
    assert(notified > 0, 'clearing the error must notify subscribers so the banner re-renders')
    assert(state.machine.id === 'jaws' && state.machineLoading === false, 'jaws must still be loaded, not reloading')
    return `error cleared with ${notified} notify(s); no refetch (requests: ${env.pendingCount()} parked)`
  }))

await test('re-picking the current machine CANCELS an in-flight switch to a third', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const a = state.selectMachine(CATALOG[1]) // godzilla in flight
    await Promise.resolve()
    assert(state.machineLoading === true, 'precondition: a load is in flight')
    await state.selectMachine(CATALOG[0]) // jaws — the machine already loaded
    assert(state.machineLoading === false, 'the in-flight load must be cancelled, not left spinning')
    await env.settle(DATA('godzilla'), 'ok', datasetFor('godzilla'))
    await a
    assert(state.machine.id === 'jaws', `the cancelled load still landed: ${state.machine.id}`)
    return 'in-flight godzilla cancelled; its late success changed nothing'
  }))

// ===========================================================================
section('h. Pinned: toggle round-trip, persistence, unknown-id refusal')
// ===========================================================================

await test('togglePinned stars, unstars, notifies, and persists both times', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    let notified = 0
    state.onChange(() => (notified += 1))
    assert(state.isPinned('comet') === false, 'precondition: comet is not pinned')
    const on = state.togglePinned('comet')
    assert(on === true, 'togglePinned should return the NEW state (true)')
    assert(state.isPinned('comet') === true, 'comet should be pinned')
    assert(JSON.parse(env.store.get(PINNED_MACHINES_KEY)).includes('comet'), 'not persisted')
    const off = state.togglePinned('comet')
    assert(off === false, 'togglePinned should return false when unstarring')
    assert(state.isPinned('comet') === false, 'comet should be unpinned')
    assert(!JSON.parse(env.store.get(PINNED_MACHINES_KEY)).includes('comet'), 'unpin not persisted')
    assert(notified === 2, `expected 2 notifies, got ${notified}`)
    return `pin -> ${JSON.stringify(JSON.parse(env.store.get(PINNED_MACHINES_KEY)))} after unpin, 2 notifies`
  }))

await test('pins survive a reload (persisted, then restored by createAppState)', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    state.togglePinned('comet')
    state.togglePinned('bronco')
    const persisted = env.store.get(PINNED_MACHINES_KEY)
    // Second boot, same storage map: exactly what a page refresh does.
    const p2 = createAppState()
    await env.settle(CATALOG_URL, 'ok', CATALOG)
    await env.settle(DATA('jaws'), 'ok', datasetFor('jaws'))
    const reloaded = await p2
    assert(
      JSON.stringify(reloaded.pinnedMachineIds) === JSON.stringify(['comet', 'bronco']),
      `after reload: ${JSON.stringify(reloaded.pinnedMachineIds)}`,
    )
    return `persisted ${persisted} -> restored ${JSON.stringify(reloaded.pinnedMachineIds)}`
  }))

await test('an id outside the catalog is REFUSED, not persisted', () =>
  withEnv(async (env) => {
    const state = await bootedState(env)
    const out = state.togglePinned('../../etc/passwd')
    assert(out === false, 'togglePinned must return false for an unknown id')
    assert(state.pinnedMachineIds.length === 0, `pinned list was written: ${JSON.stringify(state.pinnedMachineIds)}`)
    assert(env.store.get(PINNED_MACHINES_KEY) === undefined, 'nothing should have been persisted')
    return 'unknown id refused; nothing in memory, nothing on disk'
  }))

// ===========================================================================
section('i. bootMachine still REJECTS — main.ts is the only boot-error surface')
// ===========================================================================

await test('createAppState rejects when the BOOT machine fails to load', () =>
  withEnv(async (env) => {
    const p = createAppState()
    await env.settle(CATALOG_URL, 'ok', CATALOG)
    let caught = null
    const settled = p.catch((e) => (caught = e))
    await env.settle(DATA('jaws'), 'boom', 'Failed to fetch')
    await settled
    assert(caught instanceof Error, `expected createAppState to reject, got ${caught}`)
    assert(/Failed to fetch/.test(caught.message), `message should carry the cause: ${caught.message}`)
    return `rejected with: ${caught.message}`
  }))

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })

const failed = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${results.length} checks)`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`)
  process.exit(1)
}
