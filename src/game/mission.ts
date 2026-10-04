import type { StationKind, Vec3 } from './types'
import { CAMERA_TERMINALS, RESCUE_LAYOUT } from './rescue-layout'
import { HOSTAGE, PLAYER_HEALTH } from './balance'

export const SIGNALS_COMPUTER_ID = CAMERA_TERMINALS.office

export type HostageState = { id: string; status: 'captive' | 'following' | 'loaded'; position: Vec3; routeIndex: number }
export type MissionState = {
  phase: 'active' | 'dead' | 'complete'
  /** Camera terminals shut down for good. Each one stops only its own cameras (rescue-layout `terminal`). */
  camerasOff: string[]; alarm: 'inactive' | 'active' | 'silenced'; alarmElapsed: number
  silencedElapsed: number; alarmPosition: Vec3 | null; reservesDispatched: number
  gateOpen: boolean; hostages: HostageState[]; jeep: 'waiting' | 'boarding' | 'escaping' | 'escaped'; escapeProgress: number
  detentionFound: boolean; cellsReached: boolean
  health: number; lastDamageAt: number; lastBulletAt: number | null; elapsed: number; supplies: string[]; distractionUntil: number
  shots: number; kills: number; detections: number
  /** Quest crates shot apart (ids from world/interiors.ts). */
  brokenCrates: string[]
  /** Enemy field radios switched off (F) and shot apart; either one takes a radio out of action. */
  disabledRadios: string[]; destroyedRadios: string[]
  /** The level's goals that are done (see goals.ts), and the 'objective' stations used. */
  goalsDone: string[]; usedStations: string[]
  /** Timed charges (MissionWorld.charges): when each was planted (mission time), and which have gone off. */
  chargesPlanted: Record<string, number>; chargesExploded: string[]
  /** Ceiling lamps shot out (their names): their rooms stay darker. Older saves have none. */
  lampsOut?: string[]
  /** Hostages' health by id (the compound's hostage-N, a level's captive ids); missing means unhurt. See hurtHostage. */
  hostageHealth: Record<string, number>
  /** Why the mission was lost when it was not the player dying (a hostage killed); shown on the failure page. */
  failure: string | null
}
/** A fresh run. Only the compound has hostages; other levels pass none. */
export const initialMission = (hostageSpawns: readonly Vec3[] = RESCUE_LAYOUT.hostageSpawns): MissionState => ({
  phase: 'active', camerasOff: [], alarm: 'inactive', alarmElapsed: 0, silencedElapsed: 0,
  alarmPosition: null, reservesDispatched: 0, gateOpen: false,
  hostages: hostageSpawns.map((position, index) => ({ id: `hostage-${index + 1}`, status: 'captive', position: [...position], routeIndex: index < 2 ? 1 : 0 })),
  jeep: 'waiting', escapeProgress: 0, detentionFound: false, cellsReached: false,
  health: 100, lastDamageAt: 0, lastBulletAt: null, elapsed: 0, supplies: [], distractionUntil: 0, shots: 0, kills: 0, detections: 0,
  brokenCrates: [], disabledRadios: [], destroyedRadios: [], goalsDone: [], usedStations: [], chargesPlanted: {}, chargesExploded: [],
  hostageHealth: {}, failure: null, lampsOut: [],
})
/** A radio is out of action once it is switched off or destroyed. */
export const radioOut = (state: MissionState, id: string) => state.disabledRadios.includes(id) || state.destroyedRadios.includes(id)
/** Whether a camera still watches: its terminal has not been shut down. */
export const cameraOnline = (state: MissionState, id: string) => {
  const terminal = RESCUE_LAYOUT.cameras.find(camera => camera.id === id)?.terminal
  return !terminal || !state.camerasOff.includes(terminal)
}
export const loadedCount = (state: MissionState) => state.hostages.filter(h => h.status === 'loaded').length
export const releasedCount = (state: MissionState) => state.hostages.filter(h => h.status !== 'captive').length

export function stationLabel(state: MissionState, kind: StationKind, id: string): string | null {
  if (state.phase !== 'active' || state.jeep === 'escaping') return null
  switch (kind) {
    case 'hostage': return state.hostages.find(h => h.id === id)?.status === 'captive' ? 'Unlock' : null
    case 'cameras': return state.camerasOff.includes(id) ? null : 'Disable cameras'
    case 'alarm': return state.alarm === 'active' ? 'Silence alarm' : null
    case 'gate': return state.gateOpen ? null : 'Open gate'
    case 'jeep': return loadedCount(state) < state.hostages.length ? 'Hostage needed' : !state.gateOpen ? 'Open gate first' : 'Board jeep'
    case 'rally': return state.hostages.some(h => h.status === 'following') ? 'Regroup hostage' : null
    case 'supply': return state.supplies.includes(id) ? null : 'Heal'
    case 'distraction': return state.elapsed < state.distractionUntil ? null : 'Ring bell'
    case 'radio': return radioOut(state, id) ? null : 'Switch off radio'
    // A level's own goal station: its label is the station's (the runtime supplies it).
    case 'objective': return state.usedStations.includes(id) ? null : 'Use'
    default: return null
  }
}

/** Geometry is validated by PlayerActions and runtime; transitions are independently idempotent. */
export function useStation(state: MissionState, kind: StationKind, id: string): { changed: boolean; message: string } {
  if (!stationLabel(state, kind, id)) return { changed: false, message: '' }
  switch (kind) {
    case 'hostage': {
      const hostage = state.hostages.find(h => h.id === id)!
      hostage.status = 'following'; state.detentionFound = state.cellsReached = true
      return { changed: true, message: 'Cell unlocked. Wait for him to stand, then lead him upstairs to the jeep.' }
    }
    case 'cameras': {
      state.camerasOff.push(id)
      const count = RESCUE_LAYOUT.cameras.filter(camera => camera.terminal === id).length
      return { changed: true, message: `${count === 1 ? 'This terminal\'s camera is' : `This terminal's ${count} cameras are`} shut down for good. Cameras on other networks keep watching until their own terminal is shut down.` }
    }
    case 'alarm': state.alarm = 'silenced'; state.silencedElapsed = 0; return { changed: true, message: 'Alarm silenced. Guards will search their last known contact, then return to duty.' }
    case 'gate': state.gateOpen = true; return { changed: true, message: 'Exit gate opening. Bring the hostage to the jeep.' }
    case 'jeep':
      if (loadedCount(state) !== state.hostages.length) return { changed: false, message: 'The hostage must be aboard. Lead him along the marked rescue route.' }
      if (!state.gateOpen) return { changed: false, message: 'Open the exit gate at the nearby panel first.' }
      state.jeep = 'escaping'; state.escapeProgress = 0
      return { changed: true, message: 'Hostage aboard. Escaping through the east gate.' }
    case 'rally': return { changed: true, message: 'Regrouping. Return along the rescue route to bring the hostage forward.' }
    case 'supply':
      if (state.health === 100) return { changed: false, message: 'Health is full. Leave the dressing for later.' }
      state.supplies.push(id); state.health = 100; return { changed: true, message: 'Field dressing used. Health restored.' }
    case 'distraction': state.distractionUntil = state.elapsed + 25; return { changed: true, message: 'Service bell ringing. Nearby guards will investigate.' }
    case 'radio': state.disabledRadios.push(id); return { changed: true, message: 'Radio switched off. It can\'t call for help now.' }
    case 'objective': state.usedStations.push(id); return { changed: true, message: '' }
    default: return { changed: false, message: '' }
  }
}

export function missionObjective(state: MissionState) {
  if (state.phase === 'dead') return state.failure ? `${state.failure} Retry the checkpoint.` : 'Rescue interrupted. Retry the insertion checkpoint.'
  if (state.phase === 'complete') return 'Hostage extracted. Mission complete.'
  if (state.jeep === 'escaping') return 'Escape the compound'
  if (releasedCount(state) < state.hostages.length) {
    if (!state.detentionFound) return 'Find the detention building in the east annex'
    if (!state.cellsReached) return 'Reach the underground cells'
    return 'Release the hostage in cell 01'
  }
  if (loadedCount(state) < state.hostages.length) return 'Escort the hostage to the jeep'
  if (!state.gateOpen) return 'Open the exit gate'
  return 'Board the jeep and escape'
}

/** `running` lets a co-op host keep the compound's clock going while its own player is down. */
export function advanceMission(state: MissionState, dt: number, running = state.phase === 'active') {
  if (!running) return false
  state.elapsed += Math.max(0, dt)
  if (state.phase === 'active' && state.health < PLAYER_HEALTH.max && state.elapsed - state.lastDamageAt >= PLAYER_HEALTH.regenDelay)
    state.health = Math.min(PLAYER_HEALTH.max, state.health + PLAYER_HEALTH.regenPerSecond * Math.max(0, dt))
  return true
}

/** Only the vehicle crossing the exit, with its full manifest, can finish the mission. */
export function completeEscape(state: MissionState, crossedGate: boolean) {
  if (state.phase !== 'active' || state.jeep !== 'escaping' || !state.gateOpen || loadedCount(state) !== state.hostages.length || !crossedGate) return false
  state.jeep = 'escaped'; state.phase = 'complete'; return true
}

export function damageMission(state: MissionState, amount: number) {
  if (state.phase !== 'active' || amount <= 0) return false
  state.health = Math.max(0, state.health - amount)
  state.lastDamageAt = state.elapsed
  if (!state.health) state.phase = 'dead'
  return true
}

/** Bullets that arrive within the immunity window after a bullet hit are ignored entirely. */
export function shootMission(state: MissionState, amount: number) {
  if (state.lastBulletAt !== null && state.elapsed - state.lastBulletAt < PLAYER_HEALTH.bulletImmunity) return false
  if (!damageMission(state, amount)) return false
  state.lastBulletAt = state.elapsed
  return true
}

/** Mission fields the co-op host owns. Health, death, supplies and shot count stay with each player. */
export const SHARED_MISSION_KEYS = ['camerasOff', 'alarm', 'alarmElapsed', 'silencedElapsed', 'alarmPosition',
  'reservesDispatched', 'gateOpen', 'hostages', 'jeep', 'escapeProgress', 'detentionFound', 'cellsReached', 'elapsed', 'distractionUntil',
  'kills', 'detections', 'brokenCrates', 'disabledRadios', 'destroyedRadios', 'goalsDone', 'usedStations', 'chargesPlanted', 'chargesExploded', 'hostageHealth', 'failure', 'lampsOut'] as const satisfies readonly (keyof MissionState)[]
export type SharedMission = Pick<MissionState, typeof SHARED_MISSION_KEYS[number]>

export function sharedMission(state: MissionState): SharedMission {
  return structuredClone(Object.fromEntries(SHARED_MISSION_KEYS.map(key => [key, state[key]]))) as SharedMission
}

/** A guest adopts the host's compound. Places a guest reached first stay discovered. */
export function applySharedMission(state: MissionState, shared: SharedMission) {
  const found = state.detentionFound, reached = state.cellsReached
  Object.assign(state, structuredClone(shared))
  state.detentionFound ||= found
  state.cellsReached ||= reached
  // A hostage killed on the host's side loses the mission for everyone.
  if (state.failure) state.phase = 'dead'
}

/** A hostage's health now (full until hurt). */
export const hostageHealth = (state: MissionState, id: string) => state.hostageHealth?.[id] ?? HOSTAGE.health
export const hostageAlive = (state: MissionState, id: string) => hostageHealth(state, id) > 0

/**
 * Hurt a hostage. Returns 'killed' when this blow kills him: the mission is then lost, with `name` in the reason.
 * A dead hostage, or a mission already over, takes no more.
 */
export function hurtHostage(state: MissionState, id: string, amount: number, name = 'A hostage'): 'hurt' | 'killed' | null {
  if (state.phase !== 'active' || amount <= 0 || !hostageAlive(state, id)) return null
  state.hostageHealth ??= {}
  state.hostageHealth[id] = Math.max(0, hostageHealth(state, id) - amount)
  if (state.hostageHealth[id] > 0) return 'hurt'
  state.phase = 'dead'
  state.failure = `${name} was killed.`
  return 'killed'
}
