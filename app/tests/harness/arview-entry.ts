// app/tests/harness/arview-entry.ts — browser entry for SUITE 4's harness.
// Mounts the REAL src/ar/arview.ts mountAR() (which in turn mounts the REAL
// src/ar/calibrate.ts and src/ar/camera.ts) against a hand-rolled AppState.
// The ONLY substitution is src/ar/tracker.ts -> ./tracker.stub.ts (see that
// file's header for why, and for which real behaviors each mode models).
//
// Built by ./build.mjs; driven by ../arview-statemachine.e2e.py.

import { mountAR } from '../../src/ar/arview'
import type { AppState } from '../../src/state'
import type { GameData, Goal, Machine } from '../../src/models'

const MACHINES: Machine[] = [
  { id: 'jaws', name: 'Jaws (Stern, 2024)', shortTitle: 'JAWS', resource: 'jaws_goals' },
  { id: 'godzilla', name: 'Godzilla (Stern, 2021)', shortTitle: 'GODZILLA', resource: 'godzilla_goals' },
]

function makeData(machine: string): GameData {
  return {
    machine,
    defaultFx: null,
    shots: [
      { id: 's1', name: 'Left ramp', type: 'ramp', x: 0.3, y: 0.6, trim: 'all' },
      { id: 's2', name: 'Right orbit', type: 'orbit', x: 0.7, y: 0.7, trim: 'all' },
    ],
    goals: [
      {
        id: 'g1',
        title: 'Test combo',
        category: 'multiball',
        summary: 'demo',
        difficulty: 2,
        reward: 'Multiball',
        steps: [
          { shot: 's1', action: 'Shoot the left ramp' },
          { shot: 's2', action: 'Shoot the right orbit' },
        ],
      },
    ],
    sources: [],
  }
}

function makeState(): AppState {
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((fn) => fn())
  const data = makeData('Jaws (Stern, 2024)')
  const state: AppState = {
    machines: MACHINES,
    machine: MACHINES[0]!,
    data,
    shotsByID: new Map(data.shots.map((s) => [s.id, s])),
    selectedGoal: null,
    stepIndex: 0,
    ballPosition: 'any',
    highlightMode: 'auto',
    async selectMachine(m: Machine): Promise<void> {
      // Mirrors the real state.ts shape: async (fetches the dataset), resets
      // selection, notifies. Delay is configurable so the suite can hold a
      // machine switch open across an await point.
      const delay = (window as unknown as { __selectMachineDelayMs?: number }).__selectMachineDelayMs ?? 0
      if (delay > 0) await new Promise((r) => window.setTimeout(r, delay))
      state.machine = m
      const d = makeData(m.name)
      state.data = d
      state.shotsByID = new Map(d.shots.map((s) => [s.id, s]))
      state.selectedGoal = null
      state.stepIndex = 0
      state.highlightMode = 'auto'
      emit()
    },
    select(g: Goal): void {
      state.selectedGoal = g
      state.stepIndex = 0
      state.highlightMode = 'auto'
      emit()
    },
    clearSelection(): void {
      state.selectedGoal = null
      state.stepIndex = 0
      emit()
    },
    nextStep(): void {
      if (!state.selectedGoal) return
      state.stepIndex = Math.min(state.stepIndex + 1, state.selectedGoal.steps.length - 1)
      emit()
    },
    prevStep(): void {
      state.stepIndex = Math.max(state.stepIndex - 1, 0)
      emit()
    },
    goToStep(i: number): void {
      if (!state.selectedGoal) return
      state.stepIndex = Math.max(0, Math.min(i, state.selectedGoal.steps.length - 1))
      emit()
    },
    restartGoal(): void {
      state.stepIndex = 0
      emit()
    },
    pauseHighlight(): void {
      state.highlightMode = 'manual'
      emit()
    },
    resumeHighlight(): void {
      state.highlightMode = 'auto'
      emit()
    },
    onChange(fn: () => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return state
}

const host = document.getElementById('ar-host')!
const handle = mountAR(host, makeState())
;(window as unknown as { __ar: unknown }).__ar = handle
;(window as unknown as { __arReady: boolean }).__arReady = true
