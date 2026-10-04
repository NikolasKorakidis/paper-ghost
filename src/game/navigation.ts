import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import type { CollisionWorld } from '../player/collision'
import { openAngle, setDoorOpen } from '../world/doors'
import type { EmitSound } from './types'

export type GridPoint = { x: number; z: number }
const key = (x: number, z: number) => `${x},${z}`
/** A grid cell as one number, for the search's own bookkeeping (no strings made per cell). */
const cellKey = (x: number, z: number) => (x + 32768) * 65536 + (z + 32768)
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const
const flat = (dx: number, dz: number) => Math.sqrt(dx * dx + dz * dz)
/** Grid distance with diagonal moves (the exact cost of an open path between two cells). */
const octile = (dx: number, dz: number) => {
  const a = Math.abs(dx), b = Math.abs(dz)
  return a > b ? a + (Math.SQRT2 - 1) * b : b + (Math.SQRT2 - 1) * a
}
/**
 * How far guards' searches lean toward the goal (weighted A*; 1 is the shortest route). Kept at 1: leaning (1.4-1.8)
 * looked at fewer cells but picked other corridors out of the barracks, where reserves met head-on and jammed
 * (scripts/security-checks.ts). The octile estimate already makes the plain search look at fewer cells than before.
 */
const PLAN_GREED = 1
/** A step from one cell to a neighbour as one number: the cell, and which of the nine directions (see forgetNear). */
const edgeKey = (a: GridPoint, b: GridPoint) => cellKey(a.x, a.z) * 9 + (b.x - a.x + 1) * 3 + (b.z - a.z + 1)
const none: THREE.Object3D[] = []

/** Bounded A*, also used by deterministic obstacle/doorway regression checks. */
export function gridPath(start: GridPoint, goal: GridPoint, traversable: (x: number, z: number) => boolean,
  edge: (a: GridPoint, b: GridPoint) => boolean = () => true, limit = 1800): GridPoint[] {
  return finish(gridPathJob(start, goal, traversable, edge, limit))
}

function finish<T>(job: Generator<void, T>): T {
  let result = job.next()
  while (!result.done) result = job.next()
  return result.value
}

function* gridPathJob(start: GridPoint, goal: GridPoint, traversable: (x: number, z: number) => boolean,
  edge: (a: GridPoint, b: GridPoint) => boolean, limit: number, nearestOnFail = false, greed = 1): Generator<void, GridPoint[]> {
  type Node = GridPoint & { g: number; f: number; parent: Node | null }
  const heap: Node[] = []
  const push = (node: Node) => {
    heap.push(node)
    let i = heap.length - 1
    while (i) {
      const parent = (i - 1) >> 1
      if (heap[parent].f <= node.f) break
      heap[i] = heap[parent]; i = parent
    }
    heap[i] = node
  }
  const pop = () => {
    const first = heap[0], end = heap.pop()!
    if (heap.length) {
      let i = 0
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1
        if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++
        if (heap[child].f >= end.f) break
        heap[i] = heap[child]; i = child
      }
      heap[i] = end
    }
    return first
  }
  const cost = new Map<number, number>([[cellKey(start.x, start.z), 0]])
  const routeTo = (node: Node) => {
    const route: GridPoint[] = []
    for (let cursor: Node | null = node; cursor; cursor = cursor.parent) route.push({ x: cursor.x, z: cursor.z })
    return route.reverse()
  }
  const remaining = (node: GridPoint) => flat(goal.x - node.x, goal.z - node.z)
  const first: Node = { ...start, g: 0, f: greed * octile(goal.x - start.x, goal.z - start.z), parent: null }
  // The reachable cell nearest the goal so far: where to go if the goal itself cannot be reached.
  let closest = first
  push(first)
  for (let visited = 0; heap.length && visited < limit; visited++) {
    const node = pop()
    if (node.g !== cost.get(cellKey(node.x, node.z))) continue
    if (node.x === goal.x && node.z === goal.z) return routeTo(node)
    if (remaining(node) < remaining(closest)) closest = node
    for (const [dx, dz] of NEIGHBOURS) {
      yield
      const x = node.x + dx, z = node.z + dz
      const g = node.g + (dx && dz ? Math.SQRT2 : 1)
      if (g >= (cost.get(cellKey(x, z)) ?? Infinity) || !traversable(x, z)) continue
      // A diagonal cannot cut the corner of a wall, a furnishing or another blocked cell.
      if (dx && dz && (!traversable(node.x + dx, node.z) || !traversable(node.x, node.z + dz))) continue
      if (!edge(node, { x, z })) continue
      cost.set(cellKey(x, z), g)
      push({ x, z, g, f: g + greed * octile(goal.x - x, goal.z - z), parent: node })
    }
  }
  // The goal cannot be reached: as near as it can, if that is a real step closer (else nothing).
  return nearestOnFail && remaining(closest) < remaining(first) - 2 ? routeTo(closest) : []
}

/**
 * How far apart a walked line is sampled (m). Not coarser: at 0.24 a line past a door jamb passed between two samples
 * that each fit, and the prisoner walked into the jamb (scripts/captive-follow-checks.ts).
 */
const SEGMENT_STEP = 0.16
/** looksOpen's two rays: knee height (over any step a guard climbs) and chest height. */
const LOOK_HEIGHTS = [0.55, 1.35] as const
/** How far round a door that opened or shut the navigation cache forgets what it knew (m). */
const DOOR_REACH = 3.2
/** How far round its start and goal a plan's search can reach (m): its 19-cell bounds, and a little more. */
const PLAN_REACH = 19 * 0.8 + 2

/** A low-resolution shared navigation cache built from the real player collision geometry. */
export class EnemyNavigation {
  private capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.27)
  /** Scratch vectors for the probes, so walking a line makes no garbage. */
  private probe = new THREE.Vector3()
  private stepPoint = new THREE.Vector3()
  private samplePoint = new THREE.Vector3()
  private stepDirection = new THREE.Vector3()
  private stepAhead = new THREE.Vector3()
  private doorLine = new THREE.Line3()
  private doorPoint = new THREE.Vector3()
  private ray = new THREE.Vector3()
  private origin = new THREE.Vector3()
  /**
   * The floor under each grid cell, by floor level (10 cm steps) then cell (cellKey). Numeric keys: no strings made per
   * probe, and a door's surroundings are forgotten by looking up its own cells instead of scanning the whole cache.
   */
  private samples = new Map<number, Map<number, THREE.Vector3 | null>>()
  private routes = new Map<string, THREE.Vector3[]>()
  /** Whether a guard can step from a cell to a neighbour, by floor level then edgeKey. */
  private edges = new Map<number, Map<number, boolean>>()
  private doorPositions: { door: THREE.Group; position: THREE.Vector3 }[]
  private doorState: number[] = []
  private ignored: THREE.Object3D[] = []
  private operable: boolean[] = []
  private doorRevision = 0
  /** Where each recent door change was, by revision, so a plan restarts only for a door near its search. */
  private doorChanges: { revision: number; position: THREE.Vector3 }[] = []
  readonly cellSize = 0.8
  constructor(private world: CollisionWorld, private doors: THREE.Group[], private emit: EmitSound) {
    this.doorPositions = doors.map(door => ({ door, position: door.getWorldPosition(new THREE.Vector3()) }))
  }

  private fits(position: THREE.Vector3, planning: boolean) {
    // A little planning clearance keeps interpolated steps clear of leaf tips.
    this.capsule.radius = planning ? 0.3 : 0.27
    this.capsule.start.copy(position).y += this.capsule.radius
    this.capsule.end.copy(position).y += 1.74 - this.capsule.radius
    // Only a closed, operable leaf can be removed from a planned route. An open
    // leaf is a real obstacle beside the threshold, as are frames and locked doors.
    return this.world.fits(this.capsule, planning ? this.operableLeaves() : none)
  }

  /** Hinges of closed, unlocked doors; rebuilt only when a door's flags change, because every planning probe asks. */
  private operableLeaves() {
    let changed = false
    for (let i = 0; i < this.doors.length; i++) {
      const operable = !this.doors[i].userData.open && !this.doors[i].userData.missionLocked
      if (operable !== this.operable[i]) { this.operable[i] = operable; changed = true }
    }
    if (changed) this.ignored = this.doors.filter((_, i) => this.operable[i]).flatMap(door => door.children.filter(child => child.userData.doorHinge))
    return this.ignored
  }

  /**
   * Each door's state as one number: open or shut, locked, which way it opened, and whether its leaf has finished
   * swinging. A swinging leaf counts once, when it starts and when it settles, not every frame of the swing:
   * otherwise every guard's half-made plan would start over each frame a door is moving.
   */
  private doorCode(door: THREE.Group) {
    const hinge = door.children.find(child => child.userData.doorHinge)
    const target = door.userData.open ? openAngle(door) : 0
    const settled = !hinge || Math.abs(hinge.rotation.y - target) < 1e-3
    return (door.userData.open ? 1 : 0) | (door.userData.missionLocked ? 2 : 0) | (door.userData.openSide === -1 ? 4 : 0) | (settled ? 8 : 0)
  }

  /**
   * Notice doors that changed since last time. Only what is near a changed door is forgotten (DOOR_REACH): the samples,
   * steps and routes round it. The rest of the cache stays good, so guards opening doors on their rounds no longer make
   * every guard on the level plan again from scratch. Cheap; call once a frame.
   */
  syncDoors() {
    const first = this.doorState.length !== this.doors.length
    const changed: number[] = []
    for (let i = 0; i < this.doors.length; i++) {
      const code = this.doorCode(this.doors[i])
      if (code !== this.doorState[i]) { this.doorState[i] = code; changed.push(i) }
    }
    if (first) { this.doorRevision++; this.clear() }
    else if (changed.length) {
      this.doorRevision++
      for (const i of changed) {
        const position = this.doorPositions[i].position
        this.forgetNear(position)
        this.doorChanges.push({ revision: this.doorRevision, position })
      }
      if (this.doorChanges.length > 64) this.doorChanges.splice(0, this.doorChanges.length - 64)
    }
    return this.doorRevision
  }

  /**
   * Forget the samples, steps and routes near a door that changed; and every failed route, which may now succeed. The
   * cells round the door are deleted by key (about a hundred lookups per level), whatever the size of the cache.
   */
  private forgetNear(center: THREE.Vector3) {
    const cell = this.cellSize, cx = Math.round(center.x / cell), cz = Math.round(center.z / cell)
    // Steps are kept by the cell they start from: one cell further out covers those that end in the door's reach.
    const reach = Math.ceil(DOOR_REACH / cell), stepReach = reach + 1
    for (const level of this.samples.values()) {
      for (let x = cx - reach; x <= cx + reach; x++) for (let z = cz - reach; z <= cz + reach; z++) level.delete(cellKey(x, z))
    }
    for (const level of this.edges.values()) {
      for (let x = cx - stepReach; x <= cx + stepReach; x++) for (let z = cz - stepReach; z <= cz + stepReach; z++) {
        const from = cellKey(x, z) * 9
        for (let direction = 0; direction < 9; direction++) level.delete(from + direction)
      }
    }
    const routeReach = (DOOR_REACH + cell) * (DOOR_REACH + cell)
    for (const [id, points] of this.routes) {
      let near = !points.length
      for (let i = 0; !near && i < points.length; i++) {
        const dx = points[i].x - center.x, dz = points[i].z - center.z
        near = dx * dx + dz * dz < routeReach
      }
      if (near) this.routes.delete(id)
    }
  }

  /** One floor level's cache (made on first use). */
  private levelCache<T>(caches: Map<number, Map<number, T>>, level: number) {
    let cache = caches.get(level)
    if (!cache) caches.set(level, cache = new Map())
    return cache
  }

  /** Whether a door changed after `revision` anywhere within `margin` of the box round `a` and `b`. */
  private doorChangedNear(revision: number, a: THREE.Vector3, b: THREE.Vector3, margin: number) {
    if (this.doorChanges.length && this.doorChanges[0].revision > revision + 1) return true
    return this.doorChanges.some(change => change.revision > revision &&
      change.position.x > Math.min(a.x, b.x) - margin && change.position.x < Math.max(a.x, b.x) + margin &&
      change.position.z > Math.min(a.z, b.z) - margin && change.position.z < Math.max(a.z, b.z) + margin)
  }

  floor(position: THREE.Vector3, planning = true) {
    const height = this.floorHeight(position, planning)
    return height === null ? null : new THREE.Vector3(position.x, height, position.z)
  }

  /** The height a guard would stand at over `position` (as floor does), or null; makes no garbage. */
  private floorHeight(position: THREE.Vector3, planning: boolean) {
    // Like PlayerBody, keep the whole foot footprint above a plinth while crossing its edge.
    const height = this.world.floor(position, 0.38, 0.65, 0.29)
    if (!Number.isFinite(height) || Math.abs(height - position.y) > 0.38) return null
    this.probe.set(position.x, height + 0.024, position.z)
    return this.fits(this.probe, planning) ? this.probe.y : null
  }

  /**
   * A quick look along a straight line at knee and chest height (above any step a guard can climb): false when
   * something solid is plainly in the way, true when nothing is or it cannot tell. Only ever used to skip a full segment check that would fail anyway; a
   * closed door counts as in the way (the grid search goes through doors properly).
   */
  private looksOpen(from: THREE.Vector3, to: THREE.Vector3, slack = 0.3) {
    if (Math.hypot(to.x - from.x, to.z - from.z) < 0.05) return true
    // Ends on different floors (a flight of stairs between): a straight line from one to the other passes under the
    // top step, so no quick answer; the full check decides. Within a step's height, along the slope between them.
    if (Math.abs(to.y - from.y) > 0.45) return true
    const distance = this.ray.subVectors(to, from).length()
    this.ray.divideScalar(distance)
    for (let i = 0; i < LOOK_HEIGHTS.length; i++) {
      this.origin.set(from.x, from.y + LOOK_HEIGHTS[i], from.z)
      // Something just short of the end is forgiven (`slack`): a destination may stand right by a wall.
      if (this.world.rayDistance(this.origin, this.ray, distance) < distance - Math.min(slack, distance * 0.25)) return false
    }
    return true
  }

  /** Samples the swept capsule, including floor continuity; never authorizes crossing a wall. */
  segment(from: THREE.Vector3, to: THREE.Vector3, planning = true) {
    return finish(this.segmentJob(from, to, planning))
  }

  private *segmentJob(from: THREE.Vector3, to: THREE.Vector3, planning = true): Generator<void, boolean> {
    const distance = Math.hypot(to.x - from.x, to.z - from.z)
    const steps = Math.max(1, Math.ceil(distance / SEGMENT_STEP))
    let y = from.y
    for (let i = 1; i <= steps; i++) {
      yield
      const t = i / steps
      const height = this.floorHeight(this.stepPoint.set(THREE.MathUtils.lerp(from.x, to.x, t), y, THREE.MathUtils.lerp(from.z, to.z, t)), planning)
      if (height === null) return false
      y = height
    }
    return Math.abs(y - to.y) < 0.45
  }

  /**
   * A step between two neighbouring grid cells, both already known to be floor a guard fits on: one sample midway
   * covers the gap between them (cells are 0.8 m apart, 1.13 diagonally; a guard is 0.6 m across, so no wall or fence
   * hides between three samples), and the floor must carry on without a drop or a climb he cannot make. Near a door,
   * the full check (see below).
   */
  private step2(from: THREE.Vector3, to: THREE.Vector3) {
    // By a door the full check: an open leaf is a thin plank whose tip can fall between three samples.
    const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2
    for (const { position } of this.doorPositions) {
      const dx = position.x - mx, dz = position.z - mz
      if (dx * dx + dz * dz < 2.5 * 2.5 && Math.abs(position.y - from.y) < 3) return this.segment(from, to)
    }
    const middle = this.floorHeight(this.stepPoint.set(mx, from.y, mz), true)
    // A cell can sit inside something solid (inside, a capsule touches no face): a look along the step at knee and
    // chest height sees the face it would have to pass.
    return middle !== null && Math.abs(middle - to.y) < 0.38 && Math.abs(to.y - from.y) < 0.45 && this.looksOpen(from, to, 0.02)
  }

  /**
   * Whether a guard can walk straight from one point to the other: a quick look for anything plainly in the way
   * first (no closed door counts as passable here), then the full check.
   */
  direct(from: THREE.Vector3, to: THREE.Vector3) {
    return this.looksOpen(from, to) && this.segment(from, to, false)
  }

  plan(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    return finish(this.createPlan(from, to))
  }

  /** A resumable job; the director advances these within a shared per-frame wall-clock budget. */
  *createPlan(from: THREE.Vector3, to: THREE.Vector3): Generator<void, THREE.Vector3[]> {
    // A door can move while this job is yielded, and another guard can then
    // invalidate the shared samples. Restart BEFORE resuming the old search:
    // its accepted cells may now sample as null, including during string-pulling.
    while (true) {
      let revision = this.syncDoors()
      const job = this.buildPlan(from, to)
      // The director checks the doors once a frame (syncDoors). A door changing within this search's reach (its bounds
      // run 19 cells round start and goal) starts it over; one elsewhere on the level does not.
      while (true) {
        if (revision !== this.doorRevision) {
          if (this.doorChangedNear(revision, from, to, PLAN_REACH)) break
          revision = this.doorRevision
        }
        const result = job.next()
        if (result.done) return result.value
        yield
      }
    }
  }

  /** The grid at `at`'s floor level (to the nearest 10 cm): its cached floor samples and steps. */
  private grid(at: THREE.Vector3) {
    const cell = this.cellSize
    // The floor a search is on, to the nearest 10 cm: every cell's floor must be within 0.38 m of it. (Half-metre
    // steps lost the ground beside a 0.28 m building plinth or a doorstep: 0.3 rounded up to 0.5.)
    const levelKey = Math.round(at.y * 10), level = levelKey / 10
    const samples = this.levelCache(this.samples, levelKey), edges = this.levelCache(this.edges, levelKey)
    const sample = (x: number, z: number) => {
      const id = cellKey(x, z)
      let point = samples.get(id)
      if (point === undefined) samples.set(id, point = this.floor(this.samplePoint.set(x * cell, level, z * cell)))
      return point
    }
    // By direction: the check follows the floor from `a`, so a→b and b→a can differ at a step.
    const edge = (a: GridPoint, b: GridPoint) => {
      const id = edgeKey(a, b)
      let open = edges.get(id)
      const from = sample(a.x, a.z), to = sample(b.x, b.z)
      if (!from || !to) return false
      if (open === undefined) edges.set(id, open = this.step2(from, to))
      return open
    }
    return { level, levelKey, sample, edge }
  }

  /** The nearest grid cell to `position` that he can walk to straight from there, or undefined. */
  private *nearestCell(position: THREE.Vector3, sample: (x: number, z: number) => THREE.Vector3 | null): Generator<void, GridPoint | undefined> {
    const cell = this.cellSize
    const x = Math.round(position.x / cell), z = Math.round(position.z / cell)
    const options: GridPoint[] = []
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) options.push({ x: x + dx, z: z + dz })
    options.sort((a, b) => Math.hypot(a.x * cell - position.x, a.z * cell - position.z) - Math.hypot(b.x * cell - position.x, b.z * cell - position.z))
    for (const option of options) {
      yield
      const point = sample(option.x, option.z)
      if (point && (yield* this.segmentJob(position, point))) return option
    }
    return undefined
  }

  /** A cell route as walking points, string-pulled a few cells at a time, keeping all wall and door clearance checks. Null if a cell is no longer floor. */
  private *stringPull(route: GridPoint[], sample: (x: number, z: number) => THREE.Vector3 | null): Generator<void, THREE.Vector3[] | null> {
    const points: THREE.Vector3[] = []
    for (let i = 0; i < route.length;) {
      const here = sample(route[i].x, route[i].z)
      if (!here) return null
      points.push(here.clone())
      let next = Math.min(route.length - 1, i + 8)
      const reach = (j: number) => sample(route[j].x, route[j].z) ?? points[points.length - 1]
      // A shortcut that plainly runs into something is not walked sample by sample.
      while (next > i + 1 && !(this.looksOpen(points[points.length - 1], reach(next)) && (yield* this.segmentJob(points[points.length - 1], reach(next))))) next--
      if (next === i) break
      i = next
    }
    return points
  }

  private *buildPlan(from: THREE.Vector3, to: THREE.Vector3): Generator<void, THREE.Vector3[]> {
    from = from.clone(); to = to.clone()
    // Straight there, if nothing is in the way. A long line is looked along first, so a wall between costs two rays
    // instead of a floor sample every step of the way.
    if ((Math.hypot(to.x - from.x, to.z - from.z) < 3 || this.looksOpen(from, to)) && (yield* this.segmentJob(from, to))) return [to.clone()]
    const { level, sample, edge } = this.grid(from)
    const start = yield* this.nearestCell(from, sample), goal = yield* this.nearestCell(to, sample)
    if (!start || !goal) return []
    const routeKey = `${key(start.x, start.z)}:${key(goal.x, goal.z)}:${level}`
    const existing = this.routes.get(routeKey)
    // An empty entry is a search that already exhausted its budget for this door state.
    if (existing) return existing.length ? existing.map(point => point.clone()).concat(to.clone()) : []
    const bounds = { minX: Math.min(start.x, goal.x) - 19, maxX: Math.max(start.x, goal.x) + 19,
      minZ: Math.min(start.z, goal.z) - 19, maxZ: Math.max(start.z, goal.z) + 19 }
    const route = yield* gridPathJob(start, goal, (x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ && !!sample(x, z),
      edge, 2200, true, PLAN_GREED)
    if (!route.length) { this.routes.set(routeKey, []); return [] }
    // Short of the goal (it cannot be reached: a roof, a locked room): as near as can be got to it, and no further.
    const partial = route[route.length - 1].x !== goal.x || route[route.length - 1].z !== goal.z
    const points = yield* this.stringPull(route, sample)
    if (!points) return []
    if (partial) return points
    this.routes.set(routeKey, points.map(point => point.clone()))
    return points.concat(to.clone())
  }

  /** Open a threshold only when the planned direction crosses it; physical clearance still gates movement. */
  prepareDoor(position: THREE.Vector3, next: THREE.Vector3) {
    // Every moving guard, every frame: the far-off doors are skipped before any work, and nothing is allocated.
    const segment = this.doorLine.set(position, next)
    for (const entry of this.doorPositions) {
      if (entry.door.userData.missionLocked) continue
      const dx = position.x - entry.position.x, dz = position.z - entry.position.z
      if (dx * dx + dz * dz > 2.2 * 2.2) continue
      const closest = segment.closestPointToPoint(entry.position, true, this.doorPoint)
      if (Math.hypot(closest.x - entry.position.x, closest.z - entry.position.z) > 0.85) continue
      if (!entry.door.userData.open) {
        setDoorOpen(entry.door, true, false, position)
        this.emit({ kind: 'door', position: entry.position.clone(), radius: 4 })
      }
    }
  }

  /** Resolve only a leaf that swung into a guard; never relocate through static geometry. */
  recoverDoorOverlap(position: THREE.Vector3) {
    const leaves = this.doorPositions.filter(({ door, position: center }) => door.userData.open &&
      Math.abs(center.y - position.y) < 0.5 && Math.hypot(center.x - position.x, center.z - position.z) < door.userData.width + 0.4)
      .flatMap(({ door }) => door.children.filter(child => child.userData.doorHinge))
    if (!leaves.length || this.fits(position, false) || !this.world.fits(this.capsule, leaves)) return null
    this.world.resolve(this.capsule, new THREE.Vector3())
    const resolved = this.capsule.start.clone().add(new THREE.Vector3(0, -this.capsule.radius, 0))
    if (resolved.distanceTo(position) > 0.6) return null
    return this.floor(resolved, false)
  }

  step(position: THREE.Vector3, destination: THREE.Vector3, distance: number) {
    const direction = this.stepDirection.subVectors(destination, position).setY(0)
    const travel = Math.min(distance, direction.length())
    if (!travel) return position.clone()
    direction.normalize()
    this.prepareDoor(position, this.stepAhead.copy(position).addScaledVector(direction, 1.8))
    return this.floor(position.clone().addScaledVector(direction, travel), false)
  }

  clear() { this.samples.clear(); this.routes.clear(); this.edges.clear(); this.doorChanges = [] }
}
