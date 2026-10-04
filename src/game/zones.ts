import * as THREE from 'three'
import { ZONES } from './balance'

/*
 * Zones: the level split into areas the way Metal Gear Solid V splits its maps into outposts. Each main building and
 * its yard is one zone (derived from the buildings, or authored on the level), and every guard belongs to the zone of
 * his post. A zone has an alert phase of its own, and the zones talk to each other by radio:
 *
 *   normal   nothing is wrong.
 *   caution  something is wrong somewhere: guards turn toward it, a few cover the side it is on, all are quicker to spot.
 *   search   no one sees you, but they know you are here (a body, a lost contact): search teams sweep out by direction.
 *   alert    someone in this zone has eyes on you.
 *
 * An alert or a search in one zone puts every other zone in caution, looking that way (by radio; without the radio,
 * only zones within shouting range). Phases run down on timers: alert → search once contact is lost, search → caution,
 * caution → normal. Plain data in and out, so it scales to any level and saves with a checkpoint.
 */

export type ZonePhase = 'normal' | 'caution' | 'search' | 'alert'
/**
 * An area of the level: a rectangle on the ground (`half` its half-size), turned `yaw` about its centre. `yard` is how
 * much of that is the ground round its buildings: where zones' yards overlap, a point belongs to the nearer building.
 */
export type ZoneSpec = { id: string; name: string; center: [number, number]; half: [number, number]; yaw?: number; yard?: number }
export type Zone = ZoneSpec & {
  phase: ZonePhase
  /** Seconds left in this phase (alert: seconds since contact was last had). */
  timer: number
  /** Where the trouble is: what this zone's guards look toward and search round. */
  focus: THREE.Vector3 | null
  /** Which way the intruder was going, if known (flat, unit length). */
  heading: THREE.Vector3 | null
  /** The zone the trouble is in (itself, or the one that called the caution). */
  source: number
  /** Seconds to the zone's next radio check-in (see EnemyDirector.checkIn). */
  checkIn: number
  /** Guards the radio has already found missing at a check-in (by id): each is reported once. */
  reported: string[]
  /** Seconds before this zone may call for help again (a squad falling back). */
  help: number
  /** How often this zone has been on alert or searched (its memory of you, after MGS5's adapting enemy). */
  heat: number
  /** Where you were first seen, or bodies found, each time (newest last; at most four). */
  entries: THREE.Vector3[]
}
export type ZoneChange = { zone: number; from: ZonePhase; to: ZonePhase }
export type ZoneSnapshot = { phase: ZonePhase; timer: number; focus: [number, number, number] | null; heading: [number, number, number] | null; source: number; checkIn?: number; reported?: string[]; help?: number; heat?: number; entries?: [number, number, number][] }[]

const RANK: Record<ZonePhase, number> = { normal: 0, caution: 1, search: 2, alert: 3 }

/**
 * Zones from the buildings in `root` (anything with userData.footprint): each building with a yard round it
 * (ZONES.yard m); buildings within ZONES.join m of each other make one zone (a barracks and its wing, the cells and
 * their block). Named after the biggest building in it.
 */
export function zonesFromBuildings(root: THREE.Object3D, yard: number = ZONES.yard, join: number = ZONES.join): ZoneSpec[] {
  type Box = { minX: number; maxX: number; minZ: number; maxZ: number; name: string; area: number }
  const boxes: Box[] = []
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(), corner = new THREE.Vector3()
  root.updateMatrixWorld(true)
  root.traverse(object => {
    const footprint = object.userData.footprint as [number, number] | undefined
    if (!footprint) return
    object.matrixWorld.decompose(position, quaternion, scale)
    const box: Box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, name: object.name.split(' · ')[0] || 'Building', area: footprint[0] * footprint[1] }
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      corner.set(x * footprint[0] / 2, 0, z * footprint[1] / 2).applyQuaternion(quaternion).add(position)
      box.minX = Math.min(box.minX, corner.x); box.maxX = Math.max(box.maxX, corner.x)
      box.minZ = Math.min(box.minZ, corner.z); box.maxZ = Math.max(box.maxZ, corner.z)
    }
    boxes.push(box)
  })
  // Buildings (nearly) touching join, chained: one zone per group.
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const A = boxes[a], B = boxes[b]
    if (A.minX - join < B.maxX && B.minX - join < A.maxX && A.minZ - join < B.maxZ && B.minZ - join < A.maxZ) parent[find(a)] = find(b)
  }
  const groups = new Map<number, Box[]>()
  boxes.forEach((box, i) => { const r = find(i); groups.set(r, [...groups.get(r) ?? [], box]) })
  const used = new Map<string, number>()
  return [...groups.values()].map(members => {
    const minX = Math.min(...members.map(m => m.minX)) - yard, maxX = Math.max(...members.map(m => m.maxX)) + yard
    const minZ = Math.min(...members.map(m => m.minZ)) - yard, maxZ = Math.max(...members.map(m => m.maxZ)) + yard
    const name = members.reduce((a, b) => b.area > a.area ? b : a).name
    const count = (used.get(name) ?? 0) + 1
    used.set(name, count)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return { id: count > 1 ? `${slug}-${count}` : slug, name, center: [(minX + maxX) / 2, (minZ + maxZ) / 2], half: [(maxX - minX) / 2, (maxZ - minZ) / 2], yard } satisfies ZoneSpec
  })
}

/** A zone round a group of guards' posts out in the open (a road block, a fuel depot without a building). */
export function zoneAround(id: string, name: string, points: THREE.Vector3[], yard: number = ZONES.yard): ZoneSpec {
  const minX = Math.min(...points.map(p => p.x)) - yard, maxX = Math.max(...points.map(p => p.x)) + yard
  const minZ = Math.min(...points.map(p => p.z)) - yard, maxZ = Math.max(...points.map(p => p.z)) + yard
  return { id, name, center: [(minX + maxX) / 2, (minZ + maxZ) / 2], half: [(maxX - minX) / 2, (maxZ - minZ) / 2], yard }
}

export class ZoneNetwork {
  readonly zones: Zone[]
  constructor(specs: ZoneSpec[]) {
    this.zones = specs.map((spec, i) => ({ ...spec, phase: 'normal', timer: 0, focus: null, heading: null, source: -1,
      checkIn: ZONES.radio.interval[0] + (ZONES.radio.interval[1] - ZONES.radio.interval[0]) * ((i * 0.618) % 1), reported: [], help: 0, heat: 0, entries: [] }))
  }

  /** How far `point` is outside zone `index` on the ground (0 inside); `inset` shrinks the zone first. */
  distanceTo(index: number, point: THREE.Vector3, inset = 0) {
    const zone = this.zones[index], yaw = zone.yaw ?? 0
    const dx = point.x - zone.center[0], dz = point.z - zone.center[1]
    const lx = Math.cos(yaw) * dx - Math.sin(yaw) * dz, lz = Math.sin(yaw) * dx + Math.cos(yaw) * dz
    const ox = Math.max(0, Math.abs(lx) - Math.max(0, zone.half[0] - inset)), oz = Math.max(0, Math.abs(lz) - Math.max(0, zone.half[1] - inset))
    return Math.hypot(ox, oz)
  }

  /** The zone `point` is in (where yards overlap, the one whose buildings are nearer), else the nearest within `reach`, else -1. */
  zoneAt(point: THREE.Vector3, reach = 0) {
    let best = -1, bestDistance = Infinity
    for (let i = 0; i < this.zones.length; i++) {
      if (this.distanceTo(i, point) > reach) continue
      const score = this.distanceTo(i, point, this.zones[i].yard ?? 0)
      if (score < bestDistance) { best = i; bestDistance = score }
    }
    return best
  }

  /** The distance between two zones' edges on the ground. */
  gap(a: number, b: number) {
    const A = this.zones[a], B = this.zones[b]
    const dx = Math.max(0, Math.abs(A.center[0] - B.center[0]) - A.half[0] - B.half[0])
    const dz = Math.max(0, Math.abs(A.center[1] - B.center[1]) - A.half[1] - B.half[1])
    return Math.hypot(dx, dz)
  }

  /** The highest phase on the level, and the zone that has it (for the HUD). */
  get highest() {
    let best = -1
    for (let i = 0; i < this.zones.length; i++) if (best < 0 || RANK[this.zones[i].phase] > RANK[this.zones[best].phase]) best = i
    return best < 0 ? null : this.zones[best]
  }

  /**
   * Raise zone `index` to `phase` (never lowers it; a fresh alert or search restarts its clock) with the trouble at
   * `focus`. An alert or search puts the other zones in caution, looking toward it: all of them with the radio, else only
   * those within ZONES.shout m. Returns what changed, for the director to act on.
   */
  raise(index: number, phase: Exclude<ZonePhase, 'normal'>, focus: THREE.Vector3, heading: THREE.Vector3 | null, radio: boolean): ZoneChange[] {
    const changes: ZoneChange[] = []
    const zone = this.zones[index]
    if (!zone) return changes
    const from = zone.phase
    if (RANK[phase] >= RANK[zone.phase]) {
      zone.phase = phase
      zone.timer = phase === 'alert' ? 0 : ZONES.time[phase]
      zone.source = index
      ;(zone.focus ??= new THREE.Vector3()).copy(focus)
      zone.heading = heading ? heading.clone() : null
      if (from !== phase) changes.push({ zone: index, from, to: phase })
    }
    if (phase === 'caution') return changes
    for (let i = 0; i < this.zones.length; i++) {
      if (i === index) continue
      const other = this.zones[i]
      if (!radio && this.gap(i, index) > ZONES.shout) continue
      if (RANK[other.phase] > RANK.caution) continue
      const was = other.phase
      other.phase = 'caution'
      other.timer = ZONES.time.caution
      other.source = index
      ;(other.focus ??= new THREE.Vector3()).copy(focus)
      other.heading = null
      if (was !== 'caution') changes.push({ zone: i, from: was, to: 'caution' })
    }
    return changes
  }

  /**
   * Run the clocks. `contact[i]` is where a guard of zone i sees the intruder this frame (or null). An alert with no
   * contact for ZONES.lost seconds becomes a search; a search runs out into caution, caution into normal.
   */
  update(dt: number, contact: (THREE.Vector3 | null)[]): ZoneChange[] {
    const changes: ZoneChange[] = []
    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i], from = zone.phase
      zone.help = Math.max(0, zone.help - dt)
      if (zone.phase === 'alert') {
        if (contact[i]) { zone.timer = 0; zone.focus?.copy(contact[i]!) }
        else if ((zone.timer += dt) > ZONES.lost) { zone.phase = 'search'; zone.timer = ZONES.time.search }
      } else if (zone.phase === 'search' || zone.phase === 'caution') {
        if ((zone.timer -= dt) <= 0) {
          zone.phase = zone.phase === 'search' ? 'caution' : 'normal'
          zone.timer = zone.phase === 'caution' ? ZONES.time.caution : 0
          if (zone.phase === 'normal') { zone.focus = null; zone.heading = null; zone.source = -1 }
        }
      }
      if (zone.phase !== from) changes.push({ zone: i, from, to: zone.phase })
    }
    return changes
  }

  snapshot(): ZoneSnapshot {
    const tuple = (v: THREE.Vector3 | null) => v ? [v.x, v.y, v.z] as [number, number, number] : null
    return this.zones.map(zone => ({ phase: zone.phase, timer: zone.timer, focus: tuple(zone.focus), heading: tuple(zone.heading), source: zone.source,
      checkIn: zone.checkIn, reported: [...zone.reported], help: zone.help, heat: zone.heat, entries: zone.entries.map(point => tuple(point)!) }))
  }

  restore(saved: ZoneSnapshot | undefined) {
    this.zones.forEach((zone, i) => {
      const entry = saved?.[i]
      zone.phase = entry && entry.phase in RANK ? entry.phase : 'normal'
      zone.timer = Number.isFinite(entry?.timer) ? entry!.timer : 0
      zone.focus = entry?.focus ? new THREE.Vector3(...entry.focus) : null
      zone.heading = entry?.heading ? new THREE.Vector3(...entry.heading) : null
      zone.source = Number.isInteger(entry?.source) ? entry!.source : -1
      if (Number.isFinite(entry?.checkIn)) zone.checkIn = entry!.checkIn!
      zone.reported = Array.isArray(entry?.reported) ? entry!.reported.filter(id => typeof id === 'string') : []
      zone.help = Number.isFinite(entry?.help) ? entry!.help! : 0
      zone.heat = Number.isFinite(entry?.heat) ? entry!.heat! : 0
      zone.entries = Array.isArray(entry?.entries) ? entry!.entries.map(point => new THREE.Vector3(...point)) : []
    })
  }
}

/** The compass word for a direction on the ground (north is -Z), for the guards' callouts. */
export function compass(direction: THREE.Vector3) {
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
  const angle = Math.atan2(direction.x, -direction.z)
  return words[(Math.round(angle / (Math.PI / 4)) + 8) % 8]
}
