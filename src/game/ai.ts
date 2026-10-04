import * as THREE from 'three'
import { BulletTrails, bulletNearMiss } from './bullet-trails'
import { Capsule } from 'three/addons/math/Capsule.js'
import { EnemyActor, type ActorPostureSnapshot } from './actors'
import type { Posture } from '../lab/postures'
import { EnemyNavigation } from './navigation'
import { AMMO, BOSS_RULES, COMBAT_ROLES as ROLES, CRITICAL_HITS, GUNSHOT_HEARING, ENEMY_HEALTH, ENEMY_RUN_SPEED, ENEMY_WEAPONS as WEAPON, ENEMY_COMBAT as COMBAT, DETECTION, GRENADE_RULES, HEAD_BURST_CHANCE, WEAPON_RULES, ZONES, criticalChance, flashStrength, fragDamage, hitDamage, shotgunDamageMultiplier } from './balance'
import { GuardFlashlights } from './flashlights'
import { ZoneNetwork, compass, zoneAround, zonesFromBuildings, type ZoneChange, type ZonePhase, type ZoneSnapshot, type ZoneSpec } from './zones'
import { rayCapsuleDistance, reactionClipName, type HitReaction, type HitZone } from './hit-reactions'
import { playerHitTarget, type PlayerBulletHit } from './player-hit-reactions'
import type { AIContext, EnemyPuppet, EnemyReaction, EnemySnapshot, EnemySpec, EnemyState, PlayerSense, Shot, SoundEvent, Vec3, WeaponName } from './types'

const ignore = new THREE.Object3D()
/**
 * Wall-clock milliseconds of each frame route planning may use (advancePlans): PLANNING_BUDGET normally; more when
 * guards are queueing and the machine keeps up (frames at 50 fps or better); less on a machine already dropping
 * frames, so planning never adds to its lag (guards there just take a little longer to find their way).
 */
const PLANNING_BUDGET = 2, PLANNING_BUSY = 3, PLANNING_STRAINED = 1
/** Of that, what idle frames (no guard waiting on a route) spend warming routes up (ms). */
const WARM_BUDGET = 1
/** How long a search team's leader waits at a point for his men before moving on without them (s). */
const BOUND_HOLD = 5
const up = new THREE.Vector3(0, 1, 0)
const direction = new THREE.Vector3()
const eyeOffset = new THREE.Vector3(0, 1.5, 0)
// Per-frame targets for face and aim, which only read their argument.
const point = new THREE.Vector3(), aimPoint = new THREE.Vector3()
const clamp = THREE.MathUtils.clamp
const PHASE_ORDER: Record<ZonePhase, number> = { normal: 0, caution: 1, search: 2, alert: 3 }
/** Distance on the ground. */
const flat = (ax: number, az: number, bx: number, bz: number) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz))
/** The crowd grid's cells (m): guards are found by cell, so spacing checks cost the same with 40 guards or 400. */
const CROWD_CELL = 2
const crowdKey = (x: number, z: number) => (Math.floor(x / CROWD_CELL) + 32768) * 65536 + Math.floor(z / CROWD_CELL) + 32768
/**
 * Animation level of detail: a guard this far (m) from every player animates every 2nd frame, twice this far every
 * 4th, with the time saved up so nothing runs slow. Only the drawing thins out: he thinks and moves every frame.
 */
const ANIMATION_LOD = 55
/**
 * Furniture a man could hide behind or in (userData.furniture), checked first by searchers; a level can mark anything
 * else with userData.hidingSpot.
 */
const HIDING_FURNITURE = new Set(['locker-bank', 'wardrobe', 'bookcase', 'supply-shelf', 'supply-pallet', 'quest-crate', 'hay-bale', 'reception-counter', 'sofa', 'bed', 'maintenance-workbench', 'sideboard'])
/** Eye height above the feet: 1.65 standing, lower crouched or prone. */
const bodyHeight = (player: PlayerSense) => Math.max(0.3, player.eye.y - player.feet.y)
/** How fast a guard's ? fills watching this player: slower the lower he keeps (told apart by eye height). */
const noticeRate = (player: PlayerSense) => {
  const height = bodyHeight(player)
  return height < 0.8 ? DETECTION.stance.prone : height < 1.4 ? DETECTION.stance.crouch : 1
}

/** The cone operates horizontally; occlusion is a separate, real-geometry test. */
export function insideVisionCone(from: THREE.Vector3, yaw: number, target: THREE.Vector3, range = 36, halfAngle = 55) {
  const dx = target.x - from.x, dz = target.z - from.z
  const distance = Math.hypot(dx, dz)
  return distance <= range && Math.abs(target.y - from.y) < 13 &&
    (distance < 0.1 || (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / distance >= Math.cos(halfAngle * Math.PI / 180))
}

/** Heard at `distance` from a sound carrying `radius` m in the open: through walls only `muffled` as far. */
export function audible(distance: number, radius: number, unobstructed: boolean, muffled = 0.42) {
  return distance <= radius * (unobstructed ? 1 : muffled)
}

/** What a search is about: a noise, a contact lost, or a body found (DETECTION.search). */
export type SearchKind = keyof typeof DETECTION.search

/** Nearest positive ray hit on a world-upright enemy capsule; independent of animation triangle count. */
export function rayBodyDistance(origin: THREE.Vector3, rayDirection: THREE.Vector3, feet: THREE.Vector3) {
  const radius = 0.3, bottom = feet.y + radius, top = feet.y + 1.44
  const dx = origin.x - feet.x, dz = origin.z - feet.z
  const a = rayDirection.x * rayDirection.x + rayDirection.z * rayDirection.z
  const b = 2 * (dx * rayDirection.x + dz * rayDirection.z)
  const c = dx * dx + dz * dz - radius * radius
  let result = Infinity
  const discriminant = b * b - 4 * a * c
  if (a > 1e-8 && discriminant >= 0) {
    for (const t of [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)]) {
      const y = origin.y + rayDirection.y * t
      if (t >= 0 && y >= bottom && y <= top) result = Math.min(result, t)
    }
  }
  const ray = new THREE.Ray(origin, rayDirection)
  for (const y of [bottom, top]) {
    const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(feet.x, y, feet.z), radius), new THREE.Vector3())
    if (hit) result = Math.min(result, origin.distanceTo(hit))
  }
  return result
}

export type Tactic = 'hold' | 'cover' | 'peek' | 'flank' | 'charge' | 'retreat'

export type Enemy = {
  spec: EnemySpec
  actor: EnemyActor
  position: THREE.Vector3
  yaw: number
  health: number
  state: EnemyState
  suspicion: number
  lastKnown: THREE.Vector3 | null
  timer: number
  waypoint: number
  patrolStop: number
  path: THREE.Vector3[]
  pathTarget: THREE.Vector3 | null
  repath: number
  stuck: number
  senseTimer: number
  canSee: boolean
  lostFor: number
  shotTimer: number
  shots: number
  magazine: number
  /** Rounds he carries besides the magazine (AMMO.spare magazines to start); at none, he must restock at a crate. */
  reserve: number
  /** The supply crate he is heading for while out of ammunition, and where he will stand to take from it. */
  supply: { id: string; point: THREE.Vector3 } | null
  reloadTimer: number
  calloutTimer: number
  communicationTimer: number
  wait: number
  dropped: boolean
  random: number
  reserveRoute: boolean
  alarmResponse: boolean
  alarmExit: THREE.Vector3 | null
  post: THREE.Vector3 | null
  visitedWaypoints: number
  distanceWalked: number
  footstepDistance: number
  pathFailures: number
  // Move facing travel, stop, turn with a step animation, settle, then shoot.
  tactic: Tactic
  tacticTimer: number
  tacticPoint: THREE.Vector3 | null
  burst: number
  aimTime: number
  blockedFor: number
  contactMemory: number
  /** Seconds he has had you in view without being sure (the yellow ?); at DETECTION.notice he is alerted. */
  notice: number
  /** Seconds left of knowing he was shot at (saw the muzzle flash, was hit): spotting you then leaves no doubt. */
  provoked: number
  /** His squad (index into the director's squads): alerted together, they hunt together. */
  squad: number
  /** He has already taken a flanking position in this fight. */
  flanked: boolean
  suppress: number
  settledFor: number
  hitPause: number
  moveSpeed: number
  searchPoints: THREE.Vector3[]
  /** For each search point, what he looks at there (a hiding place), or null for a look round. */
  searchLooks: (THREE.Vector3 | null)[]
  searchIndex: number
  /** Posted where you came in, watching that way, for good (ZONES.adapt). */
  sentry: boolean
  /** The man whose round he walks, a few steps behind (a patrol in twos, ZONES.adapt). */
  buddy: Enemy | null
  /** Wearing a helmet (ZONES.adapt): it stops one head shot. */
  helmet: boolean
  /** Frag grenades left, and seconds before his squad may throw another (COMBAT_ROLES.grenade). */
  grenades: number
  grenadeCooldown: number
  /** Running from a grenade that landed by him: where to, and for how much longer (COMBAT_ROLES.dodge). */
  dodgePoint: THREE.Vector3 | null
  dodgeTimer: number
  /** Seconds a search team's leader has held at a point for his men to catch up (bounding: one moves, one covers). */
  bound: number
  woundArm: boolean
  woundLeg: boolean
  deathClip: string
  /** Killed by a head shot that blew the head apart. */
  headless: boolean
  /** Armour left (the boss); body hits wear it down first. */
  armor: number
  /** Seconds a respawning training target has been down. */
  respawnTimer: number
  speaker: number
  noticedBodies: string[]
  scanTimer: number
  scanDuration: number
  scanCooldown: number
  scanYaw: number
  defensiveTimer: number
  /** Seconds still blinded by a flashbang: he sees nothing and stands rubbing his eyes. */
  blind: number
  /** Co-op: the player this guard is engaging; undefined in solo play. */
  targetId?: number
  /** Seconds left of caution (DETECTION.caution): jumpy after a body, a gunshot or losing you; his ? fills faster. */
  caution: number
  /** Which way you were moving when he last saw you (flat, unit length), or null if you were standing still. */
  lastHeading: THREE.Vector3 | null
  /** What his current or next search is about. */
  searchKind: SearchKind
  /** Route searches in a row that could not reach their goal (see advancePlans): each waits longer to try again. */
  planFailStreak: number
  /** Seconds left in which he may slip past other guards: two met head-on where neither can step aside. */
  passThrough: number
  /** His place in the director's list (fixed). */
  slot: number
  /** His zone (index into the director's zones): the area of the level his post is in. -1 for none (training targets). */
  zone: number
  /** Where trouble was reported (his zone in caution): he looks that way while watchTimer runs, or for as long as he screens. */
  watch: THREE.Vector3 | null
  watchTimer: number
  /** He is covering the side of his zone the trouble is on (his post moved there) until the zone calms down. */
  screen: boolean
  /** His search team (-1 for none), his place in it (0 leads), and the way the team sweeps (flat, unit length). */
  team: number
  teamSlot: number
  sector: THREE.Vector3 | null
}

const tuple = (point: THREE.Vector3): Vec3 => [point.x, point.y, point.z]
const vector = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? new THREE.Vector3(...value as Vec3) : null
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const NUMBERS = ['repath', 'stuck', 'senseTimer', 'lostFor', 'shotTimer', 'shots', 'magazine', 'reserve', 'reloadTimer', 'calloutTimer', 'communicationTimer', 'wait',
  'patrolStop', 'visitedWaypoints', 'distanceWalked', 'footstepDistance', 'pathFailures', 'tacticTimer', 'burst', 'aimTime', 'blockedFor', 'contactMemory', 'notice', 'provoked', 'suppress', 'settledFor', 'hitPause', 'moveSpeed', 'searchIndex',
  'scanTimer', 'scanDuration', 'scanCooldown', 'scanYaw', 'defensiveTimer', 'armor', 'respawnTimer', 'blind', 'caution', 'planFailStreak', 'passThrough', 'watchTimer', 'team', 'teamSlot', 'bound', 'grenades', 'grenadeCooldown', 'dodgeTimer'] as const

export class EnemyDirector {
  readonly enemies: Enemy[] = []
  readonly navigation: EnemyNavigation
  private loaded = false
  private disposed = false
  private plans = new Map<Enemy, { target: THREE.Vector3; job: Generator<void, THREE.Vector3[]> }>()
  /** The guards whose plans are worked on this frame, reused frame to frame. */
  private planQueue: Enemy[] = []
  /**
   * Routes worth knowing before anyone asks (every patrol leg, then the way between neighbouring zones' posts), planned
   * with the planning time no guard is using: the ground they cross is then already sampled when a real plan needs it.
   */
  private warmQueue: [THREE.Vector3, THREE.Vector3][] = []
  private warming: Generator<void, THREE.Vector3[]> | null = null
  navigationFrameMs = 0
  navigationMaxFrameMs = 0
  private lastPlayer: PlayerSense | null = null
  private players: PlayerSense[] = []
  private reserveDestination: THREE.Vector3 | null = null
  private elapsed = 0
  readonly bulletTrails: BulletTrails
  /** Whether something other than walls hides `to` from `from` (smoke grenades); set by the mission. */
  obscured: ((from: THREE.Vector3, to: THREE.Vector3) => boolean) | null = null
  /** The level's areas and their alert phases (game/zones.ts); built in init. */
  zones = new ZoneNetwork([])
  /** Where each zone's guards see the intruder this frame (reused). */
  private zoneContact: (THREE.Vector3 | null)[] = []
  private teams = 0
  /** Each zone's radio operator (null: the zone has none to begin with), and the radio sets that stand in each zone. */
  private operators: (Enemy | null)[] = []
  private zoneSets: string[][] = []
  /** The guards' torches in dark rooms (game/flashlights.ts). */
  private flashlights: GuardFlashlights | null = null
  /** Hiding places on the level (furniture a man fits behind or in), each with its zone. */
  private hidingSpots: { position: THREE.Vector3; zone: number }[] = []
  /** When each sniper last radioed your position (COMBAT_ROLES.overwatch). */
  private overwatchAt = new Map<Enemy, number>()
  /** The radio sets still working, looked up at most every quarter second (radioSets builds a list each call). */
  private liveSets = new Set<string>()
  private liveSetsAt = -Infinity
  /** Which zones had their radio last frame, to tell the player when one goes silent. */
  private radioUp: boolean[] = []
  /** The guards up and about, by crowd cell (see CROWD_CELL); rebuilt once a frame, its lists reused. */
  private crowd = new Map<number, Enemy[]>()
  private frame = 0
  /** Animation time each guard has saved up while drawn at a lower rate (ANIMATION_LOD). */
  private animationDebt = new Map<Enemy, number>()
  private animationPose = new Map<Enemy, { pose: string; yaw: number }>()

  constructor(private context: AIContext, private actorFactory: (weapon: WeaponName) => Promise<EnemyActor> = EnemyActor.create) {
    this.navigation = new EnemyNavigation(context.world, context.doors, context.emit)
    this.bulletTrails = new BulletTrails(context.scene, 'Enemy bullet')
  }

  async init() {
    if (this.loaded) return
    // Sequential loads preserve the lab's rest-pose initialization order. Browser fetch cache reuses the GLB.
    for (let i = 0; i < this.context.specs.length; i++) {
      const spec = this.context.specs[i]
      const actor = await this.actorFactory(spec.weapon)
      if (this.disposed) { actor.dispose(); return }
      const position = new THREE.Vector3(...spec.position)
      const floor = this.navigation.floor(position)
      if (floor) position.copy(floor)
      actor.root.position.copy(position)
      actor.root.name = spec.name
      actor.root.visible = !spec.reserve
      const enemy: Enemy = {
        spec, actor, position, yaw: spec.facing ?? 0, health: spec.health ?? ENEMY_HEALTH, armor: spec.armor ?? 0, respawnTimer: 0,
        state: spec.reserve ? 'reserve' : spec.patrol.length > 1 ? 'patrol' : 'guard',
        suspicion: 0, lastKnown: null, timer: 0, waypoint: spec.patrol.length > 1 ? 1 : 0, patrolStop: 0,
        path: [], pathTarget: null, repath: 0, stuck: 0, senseTimer: (i % 6) * 0.016,
        canSee: false, lostFor: 0, shotTimer: 0, shots: 0, magazine: WEAPON[spec.weapon].magazine, reserve: WEAPON[spec.weapon].magazine * AMMO.spare, supply: null, reloadTimer: 0, calloutTimer: 0,
        communicationTimer: 0, wait: 0.5 + i * 0.13, dropped: false, random: 7391 + i * 3571,
        reserveRoute: false, alarmResponse: false, alarmExit: null, post: null, visitedWaypoints: 0, distanceWalked: 0, footstepDistance: 0, pathFailures: 0,
        tactic: 'hold', tacticTimer: 0, tacticPoint: null, burst: 0, aimTime: 0, blockedFor: 0, contactMemory: 0, notice: 0, provoked: 0, squad: -1, flanked: false, suppress: 0, settledFor: 0, hitPause: 0, moveSpeed: 0,
        searchPoints: [], searchLooks: [], searchIndex: 0, bound: 0,
        grenades: spec.grenades ?? (spec.weapon === 'ak' || spec.weapon === 'smg' ? ROLES.grenade.carry : 0), grenadeCooldown: 0, dodgePoint: null, dodgeTimer: 0, sentry: false, buddy: null, helmet: false, woundArm: false, woundLeg: false, deathClip: 'dieBody', headless: false, speaker: i % 4, noticedBodies: [],
        scanTimer: 0, scanDuration: 0, scanCooldown: 0, scanYaw: 0, defensiveTimer: 0, blind: 0,
        caution: 0, lastHeading: null, searchKind: 'noise', planFailStreak: 0, passThrough: 0,
        slot: i, zone: -1, watch: null, watchTimer: 0, screen: false, team: -1, teamSlot: 0, sector: null,
      }
      if (spec.boss) actor.makeBoss?.()
      if (spec.look) await actor.wearLook?.(spec.look)
      // Training targets carry no weapon to drop.
      if (spec.dummy) enemy.dropped = true
      if (spec.patrolMode === 'perimeter') {
        enemy.wait = 2 + this.random(enemy) * 2
        this.nextPatrolStop(enemy, 0)
      }
      actor.root.rotation.y = enemy.yaw
      this.enemies.push(enemy)
      this.context.scene.add(actor.root)
    }
    this.formSquads()
    this.formZones()
    this.flashlights = new GuardFlashlights(this.context.scene)
    this.loaded = true
  }

  /**
   * The level's zones: authored, or one per building and its yard. Each guard belongs to the one his post is in (or the
   * nearest within ZONES.reach, or the one his spec names); squads posted out in the open get a zone round them.
   */
  private formZones() {
    const specs: ZoneSpec[] = [...this.context.zones ?? zonesFromBuildings(this.context.scene)]
    const probe = new ZoneNetwork(specs)
    const homeless = new Map<number, Enemy[]>()
    for (const enemy of this.enemies) {
      if (enemy.spec.dummy) continue
      const post = new THREE.Vector3(...enemy.spec.position)
      enemy.zone = enemy.spec.zone ? specs.findIndex(zone => zone.id === enemy.spec.zone) : probe.zoneAt(post, ZONES.reach)
      if (enemy.zone < 0) homeless.set(enemy.squad, [...homeless.get(enemy.squad) ?? [], enemy])
    }
    for (const [squad, members] of homeless) {
      const name = members[0].spec.squad ?? `Squad ${squad + 1}`
      specs.push(zoneAround(`squad-${squad}`, name, members.map(enemy => new THREE.Vector3(...enemy.spec.position))))
      for (const enemy of members) enemy.zone = specs.length - 1
    }
    this.zones = new ZoneNetwork(specs)
    this.zoneContact = specs.map(() => null)
    this.assignRadios()
    this.findHidingSpots()
    this.queueWarmRoutes()
  }

  private findHidingSpots() {
    this.hidingSpots = []
    const position = new THREE.Vector3()
    this.context.scene.traverse(object => {
      if (!HIDING_FURNITURE.has(object.userData.furniture) && !object.userData.hidingSpot) return
      object.getWorldPosition(position)
      this.hidingSpots.push({ position: position.clone(), zone: this.zones.zoneAt(position, ZONES.reach) })
    })
  }

  /** Where to stand to look behind or into hiding place `spot`: a floor point beside it, the nearest to `from`. */
  private hidingPoint(spot: THREE.Vector3, from: THREE.Vector3) {
    let best: THREE.Vector3 | null = null
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3
      const point = this.navigation.floor(new THREE.Vector3(spot.x + Math.sin(angle) * 1.1, from.y, spot.z + Math.cos(angle) * 1.1))
      if (point && (!best || point.distanceTo(from) < best.distanceTo(from))) best = point
    }
    return best
  }

  /**
   * The hiding places a searcher should check round `center` (within `reach` m), nearest first, not already taken by
   * another searcher (seeing a locker is not seeing behind it): each a standing point and the place itself to look at.
   */
  private hidingChecks(enemy: Enemy, center: THREE.Vector3, reach: number, count: number, wedge?: { direction: THREE.Vector3; half: number }) {
    const checks: { point: THREE.Vector3; look: THREE.Vector3 }[] = []
    const spots = this.hidingSpots.filter(spot => Math.abs(spot.position.y - center.y) < 2.5 && spot.position.distanceTo(center) <= reach && (!wedge ||
      spot.position.clone().sub(center).setY(0).normalize().angleTo(wedge.direction) <= wedge.half))
      .sort((a, b) => a.position.distanceTo(center) - b.position.distanceTo(center))
    for (const spot of spots) {
      if (checks.length >= count) break
      // Already being checked by someone else on the search?
      if (this.enemies.some(ally => ally !== enemy && ally.state === 'search' && ally.searchLooks.some(look => look && look.distanceTo(spot.position) < 0.5))) continue
      const point = this.hidingPoint(spot.position, enemy.position)
      if (point && this.availablePosition(enemy, point, 1)) checks.push({ point, look: spot.position.clone().setY(spot.position.y + 0.6) })
    }
    return checks
  }

  /**
   * Each zone's radio: the sets standing in it, and its operator (EnemySpec.radio, else the guard posted nearest a set,
   * else the stationary guard nearest the zone's middle, else anyone).
   */
  private assignRadios() {
    const sets = this.context.radioSets?.() ?? []
    this.zoneSets = this.zones.zones.map(() => [])
    for (const set of sets) {
      const zone = this.zones.zoneAt(set.position)
      if (zone >= 0) this.zoneSets[zone].push(set.id)
    }
    this.operators = this.zones.zones.map((zone, index) => {
      const guards = this.enemies.filter(enemy => enemy.zone === index && !enemy.spec.dummy && !enemy.spec.reserve && !enemy.spec.boss)
      if (!guards.length) return null
      const named = guards.find(enemy => enemy.spec.radio)
      if (named) return named
      const post = (enemy: Enemy) => new THREE.Vector3(...enemy.spec.position)
      const radios = sets.filter(set => this.zoneSets[index].includes(set.id)).map(set => set.position)
      const center = new THREE.Vector3(zone.center[0], 0, zone.center[1])
      const score = (enemy: Enemy) => (radios.length ? Math.min(...radios.map(radio => post(enemy).distanceTo(radio))) : post(enemy).distanceTo(center)) +
        (enemy.spec.patrol.length > 1 ? 100 : 0) + (enemy.spec.role === 'sniper' ? 200 : 0)
      return guards.reduce((best, enemy) => score(enemy) < score(best) ? enemy : best)
    })
  }

  /** Whether zone `index` can use its radio: its operator is alive and, if it has radio sets, one of them still works. */
  zoneRadio(index: number) {
    if (index < 0 || !(this.lastPlayer?.radioEnabled ?? true)) return false
    const operator = this.operators[index]
    if (!operator || operator.health <= 0 || operator.state === 'dead') return false
    const sets = this.zoneSets[index]
    if (!sets?.length) return true
    if (this.elapsed - this.liveSetsAt > 0.25 || this.elapsed < this.liveSetsAt) {
      this.liveSetsAt = this.elapsed
      this.liveSets.clear()
      for (const set of this.context.radioSets?.() ?? []) if (set.live) this.liveSets.add(set.id)
    }
    return sets.some(id => this.liveSets.has(id))
  }

  /** Zone `index`'s radio operator, if it has one alive. */
  operator(index: number) {
    const operator = this.operators[index]
    return operator && operator.health > 0 && operator.state !== 'dead' ? operator : null
  }

  /**
   * A radio check-in in zone `index`: the operator calls round; any guard of the zone dead and not yet found or
   * reported does not answer. One missing: the zone goes on caution, and the nearest calm man goes to his post to look.
   */
  private checkIn(index: number) {
    const zone = this.zones.zones[index], operator = this.operator(index)
    if (!operator || operator.state === 'combat') return
    const found = new Set(this.enemies.flatMap(enemy => enemy.noticedBodies))
    const missing = this.enemies.filter(enemy => enemy.zone === index && (enemy.health <= 0 || enemy.state === 'dead') && !enemy.spec.dummy &&
      !found.has(enemy.spec.id) && !zone.reported.includes(enemy.spec.id))
    if (!missing.length) { this.say(operator, 'Radio check. All units, report.', 'clear'); return }
    const lost = missing[0]
    zone.reported.push(...missing.map(enemy => enemy.spec.id))
    this.say(operator, `${lost.spec.name}, report in. ${lost.spec.name}? Someone check his post!`, 'search', true)
    const post = this.navigation.floor(new THREE.Vector3(...lost.spec.position)) ?? lost.position.clone()
    this.raiseZone(index, 'caution', post)
    const checker = this.zoneGuards(index).filter(enemy => this.calm(enemy) && !enemy.screen && enemy.spec.role !== 'sniper' && enemy.spec.patrolMode !== 'perimeter')
      .sort((a, b) => a.position.distanceTo(post) - b.position.distanceTo(post))[0]
    if (!checker) return
    checker.lastKnown = post.clone(); checker.lostFor = 0
    checker.suspicion = Math.max(checker.suspicion, 0.3)
    checker.searchKind = 'noise'; checker.lastHeading = null
    this.enter(checker, 'investigate')
  }

  /** Every patrol leg, then a way between each pair of neighbouring zones (post to post), for idle-time planning. */
  private queueWarmRoutes() {
    this.warmQueue = []
    for (const enemy of this.enemies) {
      const route = enemy.spec.patrol
      if (enemy.spec.dummy || route.length < 2) continue
      for (let i = 0; i < route.length; i++) this.warmQueue.push([new THREE.Vector3(...route[i]), new THREE.Vector3(...route[(i + 1) % route.length])])
    }
    const posts = this.zones.zones.map((_, index) => this.enemies.find(enemy => enemy.zone === index && !enemy.spec.dummy && !enemy.spec.reserve))
    for (let a = 0; a < posts.length; a++) for (let b = a + 1; b < posts.length; b++) {
      if (!posts[a] || !posts[b] || this.zones.gap(a, b) > ZONES.reinforceReach) continue
      this.warmQueue.push([new THREE.Vector3(...posts[a]!.spec.position), new THREE.Vector3(...posts[b]!.spec.position)])
    }
    this.warming = null
  }

  /** Spend what is left of the planning budget, while no guard waits on a route, on the warm-up routes. */
  private warmRoutes(deadline: number) {
    while (performance.now() < deadline) {
      if (!this.warming) {
        const next = this.warmQueue.shift()
        if (!next) return
        this.warming = this.navigation.createPlan(next[0], next[1])
      }
      if (this.warming.next().done) this.warming = null
    }
  }

  /** The level's highest alert phase for the HUD: which, the zone's name, and how much of its time is left (0-1). */
  phaseStatus() {
    const zone = this.zones.highest
    if (!zone || zone.phase === 'normal') return null
    const left = zone.phase === 'alert' ? 1 : zone.timer / ZONES.time[zone.phase]
    // Caution is about trouble somewhere: name where it was.
    return { phase: zone.phase, zone: (this.zones.zones[zone.source] ?? zone).name, left }
  }

  /**
   * How much animation time to play for this guard this frame: all of it near a player; far off, every 2nd or 4th
   * frame (ANIMATION_LOD), the time between saved up, so a distant guard's clips run at the right speed, more coarsely.
   * Guards in a fight or reacting to a hit always animate every frame.
   */
  private animationStep(enemy: Enemy, dt: number, moving: boolean) {
    // Starting or stopping, turning, or a new state picks its clip at once: only steady walking and standing still
    // are drawn more coarsely.
    const pose = `${enemy.state}${moving ? '+' : ''}`, last = this.animationPose.get(enemy)
    const changed = !last || last.pose !== pose || Math.abs(last.yaw - enemy.yaw) > 1e-4
    if (last) { last.pose = pose; last.yaw = enemy.yaw } else this.animationPose.set(enemy, { pose, yaw: enemy.yaw })
    let nearest = Infinity
    for (const player of this.players) nearest = Math.min(nearest, flat(player.feet.x, player.feet.z, enemy.position.x, enemy.position.z))
    const every = changed || enemy.state === 'combat' || enemy.actor.reactionRemaining > 0 || nearest < ANIMATION_LOD ? 1 : nearest < ANIMATION_LOD * 2 ? 2 : 4
    const saved = (this.animationDebt.get(enemy) ?? 0) + dt
    // Spread over the frames by his place in the list, so the far guards do not all animate on the same frame.
    if (every > 1 && (this.frame + enemy.slot) % every !== 0) { this.animationDebt.set(enemy, saved); return 0 }
    this.animationDebt.set(enemy, 0)
    return Math.min(saved, 0.2)
  }

  /** The guards of zone `index` still up and about (not training targets). */
  private zoneGuards(index: number) {
    return this.enemies.filter(enemy => enemy.zone === index && enemy.health > 0 && enemy.state !== 'dead' && enemy.state !== 'reserve' && !enemy.spec.dummy)
  }

  /** Raise a zone's phase (see ZoneNetwork.raise) and act on what that changes. */
  private raiseZone(index: number, phase: Exclude<ZonePhase, 'normal'>, focus: THREE.Vector3, heading: THREE.Vector3 | null = null) {
    if (index < 0) return
    const changes = this.zones.raise(index, phase, focus, heading, this.zoneRadio(index))
    // A fresh search (another body, contact lost again) sends the teams out again from the new place.
    if (phase === 'search' && !changes.some(change => change.zone === index)) changes.push({ zone: index, from: 'search', to: 'search' })
    // The others' caution first: an alert's reinforcements come from zones that already know.
    for (const change of changes.sort((a, b) => PHASE_ORDER[a.to] - PHASE_ORDER[b.to])) this.zoneChanged(change)
  }

  /**
   * Once a frame: which zones have eyes on you, then the zones' clocks. A zone whose guard sees you goes to alert (and
   * the rest to caution); an alert without contact for ZONES.lost becomes a search.
   */
  private updateZones(dt: number) {
    if (!this.zones.zones.length) return
    const contact = this.zoneContact
    contact.fill(null)
    let heading: THREE.Vector3 | null = null
    for (const enemy of this.enemies) {
      if (enemy.zone < 0 || enemy.state !== 'combat' || !enemy.canSee || !enemy.lastKnown) continue
      contact[enemy.zone] = enemy.lastKnown
      heading = enemy.lastHeading
    }
    for (let i = 0; i < contact.length; i++) {
      if (contact[i] && this.zones.zones[i].phase !== 'alert') this.raiseZone(i, 'alert', contact[i]!, heading)
    }
    // The heading the intruder had when the zone lost him: kept for its search teams.
    for (let i = 0; i < contact.length; i++) if (contact[i] && heading) this.zones.zones[i].heading = heading.clone()
    for (const change of this.zones.update(dt, contact)) this.zoneChanged(change)
    // Radio check-ins, while the zone is calm or cautious and has its radio; and word when a zone's radio goes silent.
    for (let i = 0; i < this.zones.zones.length; i++) {
      const zone = this.zones.zones[i], radio = this.zoneRadio(i)
      if (this.radioUp[i] && !radio && this.operators[i]) this.context.onRadioLost?.(zone.name)
      this.radioUp[i] = radio
      if ((zone.phase !== 'normal' && zone.phase !== 'caution') || !radio || (zone.checkIn -= dt) > 0) continue
      const [low, high] = ZONES.radio.interval
      zone.checkIn = low + (high - low) * this.random(this.operators[i]!)
      this.checkIn(i)
    }
  }

  private zoneChanged(change: ZoneChange) {
    const zone = this.zones.zones[change.zone]
    const guards = this.zoneGuards(change.zone)
    // Its memory of you: each fresh alert or search, and where it started.
    if ((change.to === 'alert' || change.to === 'search') && (change.from === 'normal' || change.from === 'caution') && zone.focus && zone.source === change.zone) {
      zone.heat++
      zone.entries.push(zone.focus.clone())
      if (zone.entries.length > 4) zone.entries.shift()
    }
    // Standing down from a search: it adapts.
    if (change.to === 'caution' && change.from === 'search') this.adapt(change.zone)
    if (change.to === 'caution' && change.from === 'normal' && zone.focus) this.cautionZone(change.zone, guards)
    if (change.to === 'alert') this.reinforce(change.zone)
    if (change.to === 'search' && zone.focus) this.sendSearchTeams(change.zone, guards)
    if (change.to === 'normal') {
      // All clear: screens go back to their rounds, and nobody watches for anything any more.
      for (const enemy of guards) {
        if (!enemy.sentry) { enemy.watch = null; enemy.watchTimer = 0 }
        if (enemy.screen) {
          enemy.screen = false; enemy.post = null
          if (enemy.state === 'guard') { enemy.state = 'search'; this.enter(enemy, enemy.spec.patrol.length > 1 ? 'patrol' : 'guard') }
        }
      }
    }
  }

  /**
   * Zone `index` stands down from a search and adapts to you (ZONES.adapt), the more the more often it has been hit:
   * a sentry where you were first seen, watching the way you came; patrols in twos; helmets.
   */
  private adapt(index: number) {
    const zone = this.zones.zones[index], rules = ZONES.adapt
    const guards = this.zoneGuards(index).filter(enemy => enemy.spec.role !== 'sniper' && !enemy.spec.boss && enemy.spec.patrolMode !== 'perimeter')
    const entry = zone.entries[zone.entries.length - 1]
    const operator = this.operator(index)
    const told: string[] = []
    // Patrols in twos: a man on his own round joins another's, a few steps behind him.
    if (zone.heat >= rules.pairs) {
      const walkers = guards.filter(enemy => enemy.spec.patrol.length > 1 && !enemy.sentry && !enemy.buddy && !guards.some(other => other.buddy === enemy))
      if (walkers.length >= 2) { walkers[1].buddy = walkers[0]; told.push('patrols in pairs') }
    }
    // A sentry where you came in (just inside the zone), facing out the way you came.
    if (entry && zone.heat >= rules.sentry && guards.filter(enemy => enemy.sentry).length < Math.min(rules.sentries, zone.heat)) {
      const yard = zone.yard ?? 0
      const inside = new THREE.Vector3(
        clamp(entry.x, zone.center[0] - zone.half[0] + yard * 0.5, zone.center[0] + zone.half[0] - yard * 0.5), entry.y,
        clamp(entry.z, zone.center[1] - zone.half[1] + yard * 0.5, zone.center[1] + zone.half[1] - yard * 0.5))
      const candidates = guards.filter(enemy => !enemy.sentry && enemy !== operator && !enemy.buddy && !guards.some(other => other.buddy === enemy) &&
        (enemy.state === 'patrol' || enemy.state === 'guard' || enemy.state === 'search'))
        .sort((a, b) => (a.spec.patrol.length > 1 ? 1 : 0) - (b.spec.patrol.length > 1 ? 1 : 0) || a.position.distanceTo(inside) - b.position.distanceTo(inside))
      const spot = this.navigation.floor(inside) ?? this.navigation.floor(entry)
      const sentry = candidates[0]
      if (spot && sentry) {
        const out = direction.set(entry.x - zone.center[0], 0, entry.z - zone.center[1])
        if (out.lengthSq() < 1e-4) out.set(Math.sin(sentry.yaw), 0, Math.cos(sentry.yaw))
        sentry.sentry = true
        sentry.post = spot
        sentry.watch = spot.clone().addScaledVector(out.normalize(), 10)
        sentry.screen = false
        if (sentry.state !== 'search') this.enter(sentry, 'guard')
        told.push(`${sentry.spec.name}, hold the ${compass(out)} side`)
      }
    }
    // Helmets.
    if (zone.heat >= rules.helmets) {
      let fitted = 0
      for (const enemy of this.enemies) {
        if (enemy.zone !== index || enemy.helmet || enemy.spec.dummy || enemy.spec.boss || enemy.health <= 0) continue
        enemy.helmet = true; enemy.actor.wearHelmet?.(); fitted++
      }
      if (fitted) told.push('helmets on')
    }
    if (told.length && operator) this.say(operator, `Tighten up: ${told.join(', ')}!`, 'search', true)
  }

  /** The guards of zone `index` who are just going about their rounds (no fight, search or reserve duty). */
  private calm(enemy: Enemy) {
    return (enemy.state === 'patrol' || enemy.state === 'guard') && !enemy.alarmResponse && enemy.blind <= 0
  }

  /**
   * Caution in zone `index` (trouble elsewhere): everyone quicker to spot you; the calm ones stop and look toward the
   * trouble for a few seconds; the ZONES.screen.guards nearest it go to cover the zone's side that faces it.
   */
  private cautionZone(index: number, guards: Enemy[]) {
    const zone = this.zones.zones[index], focus = zone.focus!
    const source = this.zones.zones[zone.source]
    let announced = false
    for (const enemy of guards) {
      enemy.caution = Math.max(enemy.caution, DETECTION.caution.gunshot)
      if (!this.calm(enemy)) continue
      enemy.watch = focus.clone()
      enemy.watchTimer = ZONES.watch[0] + this.random(enemy) * (ZONES.watch[1] - ZONES.watch[0])
      if (!announced && zone.source !== index && source) {
        announced = true
        this.say(enemy, `Trouble at the ${source.name.toLowerCase()}! Eyes ${compass(direction.subVectors(focus, enemy.position))}!`, 'search', true)
      }
    }
    // Screens only from zones near enough to matter (within ZONES.reinforceReach); further off they just look.
    if (zone.source === index || zone.source < 0 || this.zones.gap(index, zone.source) > ZONES.reinforceReach) return
    // Screens: out to the edge of the zone that faces the trouble, standing a little apart, watching that way. Men
    // on rounds go first; a man posted in a room keeps his room if he can.
    const toward = direction.set(focus.x - zone.center[0], 0, focus.z - zone.center[1])
    if (toward.lengthSq() < 1e-6) return
    toward.normalize()
    const reach = Math.min(Math.abs(toward.x) > 1e-6 ? zone.half[0] / Math.abs(toward.x) : Infinity, Math.abs(toward.z) > 1e-6 ? zone.half[1] / Math.abs(toward.z) : Infinity) - ZONES.screen.inset
    const edge = new THREE.Vector3(zone.center[0] + toward.x * Math.max(0, reach), 0, zone.center[1] + toward.z * Math.max(0, reach))
    const rounds = (enemy: Enemy) => enemy.spec.patrol.length > 1 ? 0 : 1
    const screens = guards.filter(enemy => this.calm(enemy) && !enemy.sentry && enemy.spec.role !== 'sniper' && enemy.spec.patrolMode !== 'perimeter')
      .sort((a, b) => rounds(a) - rounds(b) || a.position.distanceTo(edge) - b.position.distanceTo(edge)).slice(0, ZONES.screen.guards)
    screens.forEach((enemy, slot) => {
      const side = (slot % 2 ? -1 : 1) * Math.ceil(slot / 2 + 0.5) * (screens.length > 1 ? 1.6 : 0)
      const spot = this.navigation.floor(new THREE.Vector3(edge.x - toward.z * side, enemy.position.y, edge.z + toward.x * side))
      if (!spot) return
      enemy.screen = true
      enemy.post = spot
      enemy.watch = focus.clone()
      if (enemy.state !== 'guard') this.enter(enemy, 'guard')
      else { enemy.path = []; enemy.pathTarget = null }
    })
  }

  /** A zone gone to alert: the nearest cautious zone within ZONES.reinforceReach sends ZONES.reinforce men (by radio). */
  private reinforce(index: number) {
    const zone = this.zones.zones[index]
    // Help is called by radio.
    if (!zone.focus || !this.zoneRadio(index)) return
    let nearest = -1
    for (let i = 0; i < this.zones.zones.length; i++) {
      if (i === index || this.zones.zones[i].phase !== 'caution' || this.zones.gap(i, index) > ZONES.reinforceReach) continue
      if (nearest < 0 || this.zones.gap(i, index) < this.zones.gap(nearest, index)) nearest = i
    }
    if (nearest < 0) return
    const focus = zone.focus
    const sent = this.zoneGuards(nearest).filter(enemy => this.calm(enemy) && !enemy.screen && !enemy.sentry && enemy.spec.role !== 'sniper' && enemy.spec.patrolMode !== 'perimeter')
      .sort((a, b) => a.position.distanceTo(focus) - b.position.distanceTo(focus)).slice(0, ZONES.reinforce)
    sent.forEach((enemy, i) => {
      enemy.lastKnown = focus.clone(); enemy.lostFor = 0
      enemy.suspicion = Math.max(enemy.suspicion, 0.6)
      enemy.searchKind = 'noise'; enemy.lastHeading = null
      enemy.caution = Math.max(enemy.caution, DETECTION.caution.gunshot)
      this.enter(enemy, 'investigate')
      if (!i) this.say(enemy, `Moving to support the ${zone.name.toLowerCase()}!`, 'search', true)
    })
  }

  /**
   * A search in zone `index` (a body found, contact lost): its guards, and any reinforcements on the ground there, make
   * teams of ZONES.team and each team sweeps out from where the trouble was along its own slice of the compass, the
   * first one the way the intruder was heading. ZONES.keep of them stay at their posts, watching that way.
   */
  private sendSearchTeams(index: number, guards: Enemy[]) {
    const zone = this.zones.zones[index], focus = zone.focus!
    const helpers = this.enemies.filter(enemy => enemy.zone !== index && (enemy.state === 'investigate' || enemy.state === 'search') &&
      enemy.health > 0 && this.zones.distanceTo(index, enemy.position) === 0)
    const able = [...guards, ...helpers].filter(enemy => !enemy.spec.dummy && !enemy.sentry && enemy.spec.role !== 'sniper' && enemy.spec.patrolMode !== 'perimeter' &&
      !(enemy.state === 'combat' && enemy.canSee) && enemy.blind <= 0)
      .sort((a, b) => a.position.distanceTo(focus) - b.position.distanceTo(focus))
    const keep = able.length > ZONES.team + ZONES.keep ? ZONES.keep : 0
    for (const enemy of able.splice(able.length - keep, keep)) { enemy.watch = focus.clone(); enemy.watchTimer = ZONES.watch[1] }
    // Teams of ZONES.team; one left over searches on his own, his own way.
    const count = Math.max(1, Math.ceil(able.length / ZONES.team))
    // Without a heading, the first team takes the way out of the zone from where the trouble was.
    const base = zone.heading ? Math.atan2(zone.heading.x, zone.heading.z) : Math.atan2(focus.x - zone.center[0], focus.z - zone.center[1])
    for (let t = 0; t < count; t++) {
      const members = able.slice(t * ZONES.team, (t + 1) * ZONES.team)
      if (!members.length) continue
      const angle = base + t * Math.PI * 2 / count
      const team = this.teams++
      members.forEach((enemy, slot) => {
        enemy.team = team; enemy.teamSlot = slot
        enemy.sector = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
        enemy.caution = Math.max(enemy.caution, DETECTION.caution.body)
        enemy.suspicion = Math.max(enemy.suspicion, 0.5)
        // Someone on his way to the place itself (the body, the last sighting) gets there first, then sweeps.
        if (enemy.state === 'investigate') return
        enemy.lastKnown = focus.clone(); enemy.lostFor = 0
        enemy.searchKind = 'sweep'
        if (enemy.state === 'search') { enemy.timer = 0; this.planSearch(enemy) }
        else this.enter(enemy, 'search')
        if (!slot) this.say(enemy, `Sweep ${compass(enemy.sector)}! Stay together!`, 'search', true)
      })
    }
  }

  get alertLevel() {
    if (this.enemies.some(enemy => enemy.state === 'combat')) return 'CONTACT — break line of sight'
    if (this.enemies.some(enemy => enemy.state === 'suspicious')) return 'SUSPICION — stay behind cover'
    if (this.enemies.some(enemy => enemy.state === 'investigate' || enemy.state === 'search')) return 'SEARCH — guards checking last contact'
    return 'UNDETECTED'
  }

  private random(enemy: Enemy) {
    enemy.random = (Math.imul(enemy.random, 1664525) + 1013904223) >>> 0
    return enemy.random / 4294967296
  }

  private say(enemy: Enemy, text: string, voice: string, force = false) {
    if (!force && enemy.calloutTimer > 0) return
    enemy.calloutTimer = 5
    this.context.emit({ kind: 'callout', position: enemy.position.clone().add(eyeOffset), radius: 55, text, voice, speaker: enemy.speaker })
  }

  private enter(enemy: Enemy, state: EnemyState) {
    if (enemy.state === state) return
    // A training target never becomes alert; it only stands or falls.
    if (enemy.spec.dummy && state !== 'dead' && state !== 'guard') return
    const previous = enemy.state
    enemy.state = state
    if (state === 'combat' || state === 'search') enemy.alarmExit = null
    if (state !== 'suspicious') { enemy.scanTimer = 0; enemy.actor.root.userData.alertScan = undefined }
    enemy.timer = 0
    enemy.path = []
    this.plans.delete(enemy)
    enemy.pathTarget = null
    enemy.repath = 0
    enemy.stuck = 0
    enemy.burst = 0
    // A state transition must not bypass an existing burst pause or reload.
    const reaction = enemy.spec.role === 'sniper' ? COMBAT.sniperReaction : COMBAT.reaction
    enemy.shotTimer = Math.max(enemy.shotTimer, reaction[0] + this.random(enemy) * (reaction[1] - reaction[0]))
    enemy.blockedFor = 0
    enemy.tactic = 'hold'; enemy.tacticTimer = 0; enemy.tacticPoint = null
    if (state === 'suspicious') this.say(enemy, 'Something nearby. Checking.', 'search')
    if (state === 'combat') {
      // A fight ends any search-team duty: when he loses you, his zone sends the teams out afresh.
      enemy.team = -1; enemy.teamSlot = 0; enemy.sector = null
      enemy.tacticTimer = COMBAT.openingHold; enemy.settledFor = 0; enemy.notice = DETECTION.notice; enemy.flanked = false
      this.say(enemy, 'Contact! Open fire!', 'contact', enemy.communicationTimer <= 0); this.communicate(enemy); enemy.aimTime = 0
      this.alertSquad(enemy)
    }
    if (state === 'investigate' && previous === 'combat') {
      enemy.suppress = 1.4; this.say(enemy, 'Lost him! Where did he go?', 'lost', true)
      // He goes to where he last saw you, then searches round it, first where you were heading; and stays jumpy.
      enemy.searchKind = 'lost'; enemy.caution = Math.max(enemy.caution, DETECTION.caution.lost)
    }
    if (state === 'search') { this.say(enemy, 'Come out! Check the corners.', 'search'); if (enemy.spec.role !== 'sniper') this.planSearch(enemy) }
    if (state === 'patrol' || state === 'guard') {
      enemy.team = -1; enemy.teamSlot = 0; enemy.sector = null
      enemy.notice = 0
      enemy.alarmResponse = false
      enemy.alarmExit = null
      enemy.lastKnown = null
      enemy.suspicion = 0
      enemy.lostFor = 0
      enemy.canSee = false
      enemy.suppress = 0
    }
  }

  private communicate(source: Enemy) {
    if (source.communicationTimer > 0 || !source.lastKnown) return
    source.communicationTimer = 7
    const radius = this.lastPlayer?.radioEnabled ? 58 : 20
    for (const ally of this.enemies) {
      if (ally === source || ['dead', 'reserve', 'combat'].includes(ally.state) || ally.position.distanceTo(source.position) > radius) continue
      if (!this.lastPlayer?.radioEnabled && !this.context.world.visible(source.position.clone().add(eyeOffset), ally.position.clone().add(eyeOffset), ignore)) continue
      ally.lastKnown = source.lastKnown.clone()
      ally.suspicion = Math.max(ally.suspicion, 0.4)
      ally.lostFor = 0
      ally.searchKind = source.searchKind; ally.lastHeading = source.lastHeading?.clone() ?? null
      ally.caution = Math.max(ally.caution, source.caution * 0.8)
      this.enter(ally, 'investigate')
    }
  }

  /**
   * How quickly his ? fills against you where you are in his view: full speed straight ahead and close, slower at the
   * edge of his view and at the end of his sight, faster while he is cautious. (Stance is separate: noticeRate.)
   */
  private awareness(enemy: Enemy, player: PlayerSense) {
    const dx = player.eye.x - enemy.position.x, dz = player.eye.z - enemy.position.z, distance = Math.hypot(dx, dz)
    const { peripheral, distance: falloff, fov, caution } = DETECTION
    const angle = distance < 0.1 ? 0 : Math.acos(clamp((Math.sin(enemy.yaw) * dx + Math.cos(enemy.yaw) * dz) / distance, -1, 1)) * 180 / Math.PI
    const side = angle <= peripheral.full ? 1 : THREE.MathUtils.lerp(1, peripheral.edge, clamp((angle - peripheral.full) / (fov / 2 - peripheral.full), 0, 1))
    const range = this.sightRange(enemy, false)
    const far = distance <= falloff.near ? 1 : THREE.MathUtils.lerp(1, falloff.far, clamp((distance - falloff.near) / Math.max(1, range - falloff.near), 0, 1))
    return side * far * (enemy.caution > 0 ? caution.rate : 1)
  }

  /** How far he sees you: calm, or `engaged` once he has had you in view (a sniper keeps tracking a little further). */
  private sightRange(enemy: Enemy, engaged: boolean) {
    if (enemy.spec.role === 'sniper') return this.sniperSight * (engaged ? 1.3 : 1)
    return engaged ? DETECTION.engaged : DETECTION.soldier
  }

  /** How far a sniper sees: half the level's longest side, within DETECTION's bounds. */
  private get sniperSight() {
    return THREE.MathUtils.clamp((this.context.mapSpan ?? 0) * DETECTION.sniper, DETECTION.sniperMin, DETECTION.sniperMax)
  }

  /**
   * Squads: the level's named ones (EnemySpec.squad), else guards near each other (DETECTION.squadLink, chained, on
   * about the same level). Training targets belong to none.
   */
  private formSquads() {
    const named = new Map<string, number>()
    let count = 0
    const parent = this.enemies.map((_, i) => i)
    const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]))
    const pool = this.enemies.map((enemy, i) => ({ enemy, i })).filter(({ enemy }) => !enemy.spec.dummy && !enemy.spec.squad)
    for (const a of pool) for (const b of pool) {
      if (b.i <= a.i) continue
      const pa = new THREE.Vector3(...a.enemy.spec.position), pb = new THREE.Vector3(...b.enemy.spec.position)
      if (Math.hypot(pa.x - pb.x, pa.z - pb.z) < DETECTION.squadLink && Math.abs(pa.y - pb.y) < DETECTION.squadRise) parent[root(a.i)] = root(b.i)
    }
    const clusters = new Map<number, number>()
    this.enemies.forEach((enemy, i) => {
      if (enemy.spec.dummy) { enemy.squad = -1; return }
      if (enemy.spec.squad) {
        if (!named.has(enemy.spec.squad)) named.set(enemy.spec.squad, count++)
        enemy.squad = named.get(enemy.spec.squad)!
        return
      }
      const r = root(i)
      if (!clusters.has(r)) clusters.set(r, count++)
      enemy.squad = clusters.get(r)!
    })
  }

  /** The others in his squad who are still up and about. */
  private squadmates(enemy: Enemy) {
    return enemy.squad < 0 ? [] : this.enemies.filter(other => other !== enemy && other.squad === enemy.squad && other.health > 0 &&
      other.state !== 'dead' && other.state !== 'reserve' && !other.spec.dummy)
  }

  /** One of them is alerted: the whole squad is, knowing where he last saw you, and comes for you. */
  private alertSquad(source: Enemy) {
    if (!source.lastKnown) return
    for (const ally of this.squadmates(source)) {
      if (ally.state === 'combat') continue
      const watching = ally.canSee
      if (!watching) ally.lastKnown = source.lastKnown.clone()
      ally.suspicion = 1; ally.notice = DETECTION.notice; ally.lostFor = 0
      this.enter(ally, 'combat')
      // One who already had you in view has been aiming all along: he fires almost at once.
      if (watching) { ally.shotTimer = Math.min(ally.shotTimer, DETECTION.quickShot); ally.aimTime = Math.max(ally.aimTime, this.aimDelay(ally)) }
    }
  }

  /** What he does in a squad fight: shotguns and SMGs rush in, the boss charges, snipers hold, the rest flank. */
  private fighting(enemy: Enemy): 'rush' | 'flank' | 'hold' {
    if (enemy.spec.role === 'sniper') return 'hold'
    if (enemy.spec.boss || enemy.spec.weapon === 'shotgun' || enemy.spec.weapon === 'smg') return 'rush'
    return 'flank'
  }

  /** How close he pushes in before planting himself and fighting. */
  private closeIn(enemy: Enemy) {
    if (enemy.spec.boss) return BOSS_RULES.closeIn
    return enemy.spec.weapon === 'shotgun' ? DETECTION.closeIn.shotgun : enemy.spec.weapon === 'smg' ? DETECTION.closeIn.smg : DETECTION.closeIn.other
  }

  /**
   * A flanking position for a rifleman: out to one side of where you were (alternating sides through the squad), at
   * rifle range, on floor he can reach, with a clear view of you. Null if there is none.
   */
  private flankPoint(enemy: Enemy, known: THREE.Vector3) {
    const away = Math.atan2(enemy.position.x - known.x, enemy.position.z - known.z)
    const index = this.squadmates(enemy).filter(other => this.fighting(other) === 'flank' && this.enemies.indexOf(other) < this.enemies.indexOf(enemy)).length
    const side = index % 2 ? -1 : 1
    const [near, far] = DETECTION.flank.distance
    const reach = THREE.MathUtils.clamp(enemy.position.distanceTo(known), near, far)
    for (const turn of [DETECTION.flank.angle, DETECTION.flank.angle * 0.6, DETECTION.flank.angle * 1.3]) for (const s of [side, -side]) {
      const angle = away + s * turn * Math.PI / 180
      const candidate = this.navigation.floor(new THREE.Vector3(known.x + Math.sin(angle) * reach, enemy.position.y, known.z + Math.cos(angle) * reach))
      if (!candidate || !this.availablePosition(enemy, candidate, 2.5)) continue
      if (!this.context.world.visible(candidate.clone().add(eyeOffset), known.clone().add(eyeOffset), ignore)) continue
      return candidate
    }
    return null
  }

  private target(enemy: Enemy) {
    return this.players.find(player => player.id === enemy.targetId) ?? this.players[0]
  }

  /** The nearest player this guard can actually see. The current target wins close calls, so aim does not flicker. */
  private sight(enemy: Enemy) {
    let best: PlayerSense | null = null, bestDistance = Infinity
    for (const player of this.players) {
      if (!this.sees(enemy, player)) continue
      const distance = player.feet.distanceTo(enemy.position) - (player.id === enemy.targetId ? 3 : 0)
      if (distance < bestDistance) { best = player; bestDistance = distance }
    }
    return best
  }

  private sees(enemy: Enemy, player: PlayerSense) {
    if (!player.alive || enemy.blind > 0) return false
    const origin = this.eye(enemy)
    const range = this.sightRange(enemy, enemy.contactMemory > 0 || enemy.state === 'combat')
    if (!insideVisionCone(origin, enemy.yaw, player.eye, range, (enemy.state === 'combat' ? DETECTION.fovCombat : DETECTION.fov) / 2)) return false
    const body = player.feet.clone().add(new THREE.Vector3(0, Math.min(0.95, bodyHeight(player) * 0.58), 0))
    return [player.eye, body].some(point => this.context.world.visible(origin, point, ignore) && !this.obscured?.(origin, point))
  }

  /**
   * A flashbang going off at `origin`: everyone with a clear line to it is blinded, for longer the more squarely they
   * face it and the closer they are (see flashStrength). Blinded guards stop where they are, see nothing, and afterwards
   * come to look where it went off. Returns who was blinded and for how long.
   */
  flash(origin: THREE.Vector3) {
    const blinded: { id: string; seconds: number; strength: number }[] = []
    for (const enemy of this.enemies) {
      if (enemy.state === 'reserve' || enemy.state === 'dead' || enemy.health <= 0) continue
      const eye = this.eye(enemy), toward = origin.clone().sub(eye)
      if (!this.context.world.visible(eye, origin, ignore) || this.obscured?.(eye, origin)) continue
      const distance = toward.length(), facing = new THREE.Vector3(Math.sin(enemy.yaw), 0, Math.cos(enemy.yaw))
      const strength = flashStrength(facing.angleTo(toward.normalize()), distance)
      if (strength <= 0.02) continue
      const seconds = GRENADE_RULES.flash.blind * strength + GRENADE_RULES.flash.fade * strength * 0.5
      enemy.blind = Math.max(enemy.blind, seconds)
      blinded.push({ id: enemy.spec.id, seconds, strength })
      if (enemy.spec.dummy) { enemy.actor.react('blinded', false); continue }
      // Hands over his face, staggering back and rooted to the spot (the 'blinded' clip, then 'blindedHold' while it
      // lasts, see update); the boss shrugs it off quicker.
      enemy.canSee = false; enemy.aimTime = 0; enemy.senseTimer = 0; enemy.moveSpeed = 0; enemy.settledFor = 0
      enemy.hitPause = Math.max(enemy.hitPause, seconds * (enemy.spec.boss ? 0.5 : 0.85))
      enemy.actor.react('blinded', false)
      enemy.lastKnown = origin.clone().setY(enemy.position.y)
      enemy.suspicion = 1
      if (enemy.state !== 'combat') this.enter(enemy, 'investigate')
      this.say(enemy, "I can't see!", 'hurt', true)
    }
    return blinded
  }

  /**
   * A frag grenade going off at `origin`: every guard within its radius and not sheltered by a wall takes
   * fragDamage, as a body hit (armour soaks it first). Thrown by player `by` in co-op. Returns who was hit and how hard.
   */
  blast(origin: THREE.Vector3, by?: number) {
    const hit: { id: string; damage: number; lethal: boolean }[] = []
    const from = origin.clone().add(new THREE.Vector3(0, 0.25, 0))
    for (let index = 0; index < this.enemies.length; index++) {
      const enemy = this.enemies[index]
      if (enemy.state === 'reserve' || enemy.state === 'dead' || enemy.health <= 0) continue
      const scale = enemy.actor.root.scale.y
      const points = [0.25, 1.1, 1.6].map(height => enemy.position.clone().add(new THREE.Vector3(0, height * scale, 0)))
      const chest = points[1], distance = Math.min(...points.map(point => point.distanceTo(origin)))
      const damage = fragDamage(distance)
      if (damage <= 0 || !points.some(point => this.context.world.visible(from, point, ignore))) continue
      const direction = chest.clone().sub(origin).setY(Math.max(0.15, chest.y - origin.y)).normalize()
      const before = enemy.health
      this.applyHit({ origin: from, direction, range: GRENADE_RULES.frag.radius, damage, by },
        { index, zone: 'torso', point: chest, bone: undefined, distance, direction }, true)
      hit.push({ id: enemy.spec.id, damage: before - enemy.health, lethal: enemy.health <= 0 })
    }
    return hit
  }

  /** How long a guard aims before the first round; Bulky Boy is quicker. */
  private aimDelay(enemy: Enemy) { return COMBAT.aimDelay * (enemy.spec.boss ? BOSS_RULES.aimDelay : 1) }
  private speed(enemy: Enemy, base: number) { return (enemy.woundLeg ? base * 0.6 : base) * (enemy.spec.boss ? BOSS_RULES.speed : 1) }

  /** A training target stands back up where it was posted, whole. */
  private revive(enemy: Enemy) {
    enemy.position.fromArray(enemy.spec.position)
    const floor = this.navigation.floor(enemy.position)
    if (floor) enemy.position.copy(floor)
    Object.assign(enemy, { health: enemy.spec.health ?? ENEMY_HEALTH, armor: enemy.spec.armor ?? 0, respawnTimer: 0, headless: false,
      yaw: enemy.spec.facing ?? 0, state: 'guard', hitPause: 0, blind: 0, deathClip: 'dieBody' })
    enemy.actor.root.position.copy(enemy.position)
    enemy.actor.root.rotation.y = enemy.yaw
    enemy.actor.restore('guard')
  }

  /** Wake held guards (a script, never the alarm): they take their posts, or come hunting for `toward`. */
  wake(ids: string[], toward?: THREE.Vector3) {
    for (const enemy of this.enemies) {
      if (!ids.includes(enemy.spec.id) || enemy.state !== 'reserve') continue
      enemy.actor.root.visible = true
      enemy.state = enemy.spec.patrol.length > 1 ? 'patrol' : 'guard'
      if (toward) { enemy.lastKnown = toward.clone(); enemy.suspicion = 1; this.enter(enemy, 'investigate') }
    }
  }

  private eye(enemy: Enemy) { return enemy.actor.eye?.() ?? enemy.position.clone().add(eyeOffset) }

  private posture(enemy: Enemy) { return enemy.actor.posture ?? 'stand' }

  private transitioning(enemy: Enemy) { return (enemy.actor.postureTransitionRemaining ?? 0) > 0 }

  /** Low stances need a level supported footprint, including room for the extended limbs. */
  private postureFits(enemy: Enemy, posture: Posture) {
    if (posture === 'stand' || posture === 'crouch') return true
    const radius = posture === 'prone' ? 1.05 : 0.52
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4
      const point = enemy.position.clone().add(new THREE.Vector3(Math.sin(angle) * radius, 0, Math.cos(angle) * radius))
      const floor = this.context.world.floor(point, 0.15, 0.25)
      if (!Number.isFinite(floor) || Math.abs(floor - enemy.position.y) > 0.12) return false
      const low = point.clone().add(new THREE.Vector3(0, 0.23, 0))
      if (!this.context.world.fits(new Capsule(low, low.clone().add(new THREE.Vector3(0, 0.32, 0)), 0.2))) return false
      if (this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' && other.position.distanceTo(point) < 0.55)) return false
    }
    return true
  }

  private stand(enemy: Enemy) {
    // A navigation request or large tracking turn cannot cancel a defensive hold.
    if (enemy.defensiveTimer > 0 && this.posture(enemy) !== 'stand') return false
    enemy.defensiveTimer = 0
    if (this.posture(enemy) !== 'stand') {
      enemy.actor.setPosture?.('stand')
      enemy.settledFor = 0
    }
    return !this.transitioning(enemy)
  }

  /** Use the current location, so an indoor patrol can take outdoor stances after leaving. */
  private protectedPost(enemy: Enemy) {
    if (enemy.spec.role === 'sniper') return true
    let protectedArea = false
    this.context.scene.traverse(object => {
      if (protectedArea) return
      const data = object.userData
      const tower = data.kind === 'water-tower' || data.kind === 'observation-tower'
      if (!tower && !(data.footprint && (data.enterable || data.accessible))) return
      const local = object.worldToLocal(enemy.position.clone())
      if (tower) {
        const radius = data.deckRadius ?? data.deckWidth / 2
        protectedArea = Math.abs(local.y - data.deckHeight) < 1 && Math.abs(local.x) < radius + 1 && Math.abs(local.z) < radius + 1
      } else {
        const [width, depth] = data.footprint
        protectedArea = Math.abs(local.x) <= width / 2 && Math.abs(local.z) <= depth / 2
      }
    })
    // Covers rooms without footprint metadata, including the underground detention block.
    return protectedArea || this.context.world.rayDistance(enemy.position.clone().add(eyeOffset), new THREE.Vector3(0, 1, 0), 16) < 16
  }

  /**
   * A body on the ground, seen from DETECTION.bodySight off by any guard not already fighting: "Man down!" He radios it,
   * runs to the body, and then searches the ground round it (a body search, DETECTION.search.body), hiding places
   * first; his squad joins in, each from his own side. All of them stay cautious for a good while.
   */
  private noticeBody(enemy: Enemy) {
    if (!['patrol', 'guard', 'suspicious', 'investigate', 'search'].includes(enemy.state)) return
    const eye = this.eye(enemy)
    for (const body of this.enemies) {
      if (body.state !== 'dead' || body.spec.dummy || enemy.noticedBodies.includes(body.spec.id)) continue
      const point = body.position.clone().add(new THREE.Vector3(0, 0.3, 0))
      if (!insideVisionCone(eye, enemy.yaw, point, DETECTION.bodySight, DETECTION.fov / 2) || !this.context.world.visible(eye, point, ignore)) continue
      enemy.noticedBodies.push(body.spec.id)
      enemy.lastKnown = body.position.clone()
      enemy.suspicion = Math.max(enemy.suspicion, 0.6)
      enemy.lostFor = 0
      enemy.searchKind = 'body'; enemy.lastHeading = null
      enemy.caution = Math.max(enemy.caution, DETECTION.caution.body)
      this.enter(enemy, 'investigate')
      this.say(enemy, 'Man down! Search the area!', 'search', true)
      this.communicate(enemy)
      for (const ally of this.squadmates(enemy)) {
        if (ally.state === 'combat' || ally.noticedBodies.includes(body.spec.id)) continue
        ally.noticedBodies.push(body.spec.id)
        ally.lastKnown = body.position.clone(); ally.lostFor = 0
        ally.searchKind = 'body'; ally.suspicion = Math.max(ally.suspicion, 0.6)
        ally.caution = Math.max(ally.caution, DETECTION.caution.body)
        this.enter(ally, 'investigate')
      }
      // A body means someone is here: his zone searches (in teams, round the body), and the others are put on caution.
      this.raiseZone(enemy.zone, 'search', body.position)
      break
    }
  }

  /** Nothing in the magazine and nothing to reload it with. Training targets never run out. */
  private dry(enemy: Enemy) { return !enemy.spec.dummy && enemy.magazine <= 0 && enemy.reserve <= 0 && enemy.reloadTimer <= 0 }

  private startReload(enemy: Enemy) {
    if (enemy.magazine > 0 || enemy.reloadTimer > 0) return
    if (enemy.reserve <= 0 && !enemy.spec.dummy) {
      if (!enemy.supply) this.say(enemy, 'I\'m out! Need ammo!', 'reload', true)
      return
    }
    enemy.reloadTimer = WEAPON[enemy.spec.weapon].reload
    enemy.shotTimer = enemy.reloadTimer
    enemy.burst = 0
    enemy.tacticTimer = 0
    this.say(enemy, 'Reloading! Cover me!', 'reload')
    this.context.emit({ kind: 'enemy-reload', position: enemy.position.clone(), radius: 5, weapon: enemy.spec.weapon })
  }

  /** Solo play passes one player. Co-op passes every player; each guard engages the nearest one it can see. */
  update(dt: number, sense: PlayerSense | PlayerSense[]) {
    if (!this.loaded || this.disposed || dt <= 0) return
    const players = Array.isArray(sense) ? sense : [sense]
    if (!players.length) return
    dt = Math.min(dt, 0.05)
    this.elapsed += dt
    this.players = players
    this.lastPlayer = players[0]
    // Even a difficult radio investigation must not monopolize a rendered frame.
    this.advancePlans(dt)
    this.indexCrowd()
    this.frame++
    this.bulletTrails.update(dt)
    for (const enemy of this.enemies) {
      if (enemy.state === 'reserve') continue
      enemy.blind = Math.max(0, enemy.blind - dt)
      if (enemy.state === 'dead') {
        this.flashlights?.set(enemy.spec.id, false, enemy.position, enemy.yaw, dt)
        enemy.actor.update(dt, 'dead', false)
        if (enemy.spec.respawn && (enemy.respawnTimer += dt) >= enemy.spec.respawn) this.revive(enemy)
        continue
      }
      // Still dazzled once the first stagger has played: keep the hands over the face, swaying, until it wears off.
      if (enemy.blind > 0.35 && enemy.actor.reactionRemaining <= 0 && (enemy.spec.dummy || enemy.hitPause > 0.2)) enemy.actor.react('blindedHold', false)
      // A training target just stands at its post, facing its way, and takes hits.
      if (enemy.spec.dummy) {
        enemy.hitPause = Math.max(0, enemy.hitPause - dt)
        enemy.actor.root.position.copy(enemy.position)
        enemy.actor.root.rotation.y = enemy.yaw
        enemy.actor.update(dt, 'guard', false)
        continue
      }
      let player = this.target(enemy)
      if (!player.alive) enemy.canSee = false
      enemy.timer += dt
      enemy.repath -= dt
      enemy.contactMemory = Math.max(0, enemy.contactMemory - dt)
      enemy.provoked = Math.max(0, enemy.provoked - dt)
      enemy.caution = Math.max(0, enemy.caution - dt)
      enemy.watchTimer = Math.max(0, enemy.watchTimer - dt)
      enemy.grenadeCooldown = Math.max(0, enemy.grenadeCooldown - dt)
      enemy.shotTimer = Math.max(0, enemy.shotTimer - dt)
      enemy.calloutTimer -= dt
      enemy.communicationTimer -= dt
      enemy.scanCooldown = Math.max(0, enemy.scanCooldown - dt)
      enemy.scanTimer = Math.max(0, enemy.scanTimer - dt)
      enemy.defensiveTimer = Math.max(0, enemy.defensiveTimer - dt)
      if (enemy.defensiveTimer <= 0) this.stand(enemy)
      enemy.moveSpeed = 0
      if (enemy.reloadTimer > 0) {
        enemy.reloadTimer -= dt
        if (enemy.reloadTimer <= 0) {
          const loaded = enemy.spec.dummy ? WEAPON[enemy.spec.weapon].magazine : Math.min(WEAPON[enemy.spec.weapon].magazine, enemy.reserve)
          enemy.magazine = loaded
          if (!enemy.spec.dummy) enemy.reserve -= loaded
          enemy.shotTimer = 0
        }
      }
      this.startReload(enemy)
      enemy.senseTimer -= dt
      if (enemy.senseTimer <= 0) {
        enemy.senseTimer = enemy.state === 'combat' ? COMBAT.senseCombat : COMBAT.senseIdle
        const seen = this.sight(enemy)
        enemy.canSee = !!seen
        // Only an actual sight query supplies a position; cached visibility never tracks a hidden player.
        if (seen) {
          player = seen; enemy.targetId = seen.id; enemy.lastKnown = seen.feet.clone(); enemy.contactMemory = COMBAT.contactMemory
          // Which way you were going, for the search if he loses you.
          const flat = Math.hypot(seen.velocity.x, seen.velocity.z)
          if (flat > 0.6) (enemy.lastHeading ??= new THREE.Vector3()).set(seen.velocity.x / flat, 0, seen.velocity.z / flat)
          else enemy.lastHeading = null
        }
        else this.noticeBody(enemy)
        if (seen && enemy.spec.role === 'sniper') this.overwatch(enemy, seen)
        // In a fight, whoever sees you tells his squad where you are: those who can't see you keep coming.
        if (seen && enemy.state === 'combat') for (const ally of this.squadmates(enemy)) {
          if (ally.state !== 'combat' || ally.canSee) continue
          if (ally.lastKnown) ally.lastKnown.copy(seen.feet); else ally.lastKnown = seen.feet.clone()
          ally.lostFor = 0
        }
      }
      if (enemy.canSee) {
        if (enemy.scanTimer > 0 && this.posture(enemy) === 'crouch') enemy.actor.setPosture?.('crouch', false)
        enemy.scanTimer = 0
        enemy.lostFor = 0
        enemy.aimTime += dt
        // Not sure at first (the yellow ?): he stops and watches for DETECTION.notice seconds before he is alerted.
        // Too close, or already hunting you, and there is no doubt at all.
        const close = !!enemy.lastKnown && enemy.lastKnown.distanceTo(enemy.position) < DETECTION.pointBlank
        const hunting = enemy.provoked > 0 || enemy.suspicion >= DETECTION.hunting
        // Watched you all the way through the ?, or you are on top of him: he has been aiming and fires almost at once.
        // Hunting you already, he reacts at the ordinary speed of a first sighting.
        let quick = close
        if (enemy.state !== 'combat' && (close || hunting)) enemy.notice = DETECTION.notice
        else if (enemy.state !== 'combat') { enemy.notice = Math.min(DETECTION.notice, enemy.notice + dt * noticeRate(player) * this.awareness(enemy, player)); quick ||= enemy.notice >= DETECTION.notice }
        if (enemy.state === 'combat' || enemy.notice >= DETECTION.notice) {
          enemy.suspicion = 1
          if (enemy.state !== 'combat') {
            this.enter(enemy, 'combat')
            if (quick) { enemy.shotTimer = Math.min(enemy.shotTimer, DETECTION.quickShot); enemy.aimTime = Math.max(enemy.aimTime, this.aimDelay(enemy)) }
          }
        } else if (enemy.state !== 'suspicious') {
          enemy.suspicion = Math.max(enemy.suspicion, 0.5)
          this.say(enemy, 'Hey! Who\'s there?', 'search', true)
          this.enter(enemy, 'suspicious')
        }
      } else {
        enemy.lostFor += dt
        enemy.aimTime = 0
        if (enemy.state !== 'combat') enemy.notice = Math.max(0, enemy.notice - dt * DETECTION.forget)
        enemy.suspicion = Math.max(0, enemy.suspicion - dt * 0.18)
        if (enemy.state === 'suspicious' && enemy.scanTimer <= 0 && enemy.lostFor > 0.65) this.enter(enemy, 'investigate')
        // A guard that ducked into cover chose to lose sight; only a real disappearance starts the hunt.
        const relocating = ['flank', 'charge', 'retreat'].includes(enemy.tactic) && enemy.tacticPoint && enemy.tacticTimer > 0
        // The suppressor stays in the fight for as long as he keeps your head down.
        const suppressing = enemy.tactic === 'hold' && this.suppressor(enemy) === enemy
        const patience = relocating ? 7 : suppressing ? ROLES.suppress.after + ROLES.suppress.time : enemy.tactic === 'cover' || enemy.tactic === 'peek' ? 4 : 1.5
        if (enemy.state === 'combat' && enemy.lostFor > patience) this.enter(enemy, 'investigate')
      }
      let moving = false
      if (enemy.hitPause > 0 || enemy.actor.reactionRemaining > 0 || this.transitioning(enemy)) {
        enemy.hitPause = Math.max(0, enemy.hitPause - dt)
        enemy.settledFor = 0
      } else if (enemy.dodgePoint && enemy.dodgeTimer > 0) {
        // Running from a grenade by his feet.
        enemy.dodgeTimer -= dt
        moving = this.move(enemy, enemy.dodgePoint, this.speed(enemy, ENEMY_RUN_SPEED), dt)
        if (enemy.dodgeTimer <= 0 || enemy.position.distanceTo(enemy.dodgePoint) < 0.6) { enemy.dodgePoint = null; enemy.dodgeTimer = 0; enemy.path = []; enemy.pathTarget = null }
      } else if (this.dry(enemy)) {
        moving = this.resupply(enemy, dt)
      } else if (enemy.state === 'combat') {
        moving = this.combat(enemy, player, dt)
      } else if (enemy.state === 'suspicious') {
        if (enemy.scanTimer > 0 && this.posture(enemy) !== 'prone' && this.posture(enemy) !== 'kneel') {
          const progress = 1 - enemy.scanTimer / enemy.scanDuration
          const yaw = enemy.scanYaw + Math.sin(progress * Math.PI * 2) * 0.7
          this.face(enemy, point.set(enemy.position.x + Math.sin(yaw), enemy.position.y, enemy.position.z + Math.cos(yaw)), dt, 2.8)
        // "What was that?": a glimpse does not turn his head at once. Only once the ? is a third full does he turn to it
        // (steadily, not in a snap), so a glimpse at the edge of his view, where the ? fills slowly, buys you time.
        } else if (enemy.scanTimer <= 0 && enemy.lastKnown && (enemy.notice >= DETECTION.notice * 0.3 || enemy.provoked > 0)) this.face(enemy, enemy.lastKnown, dt, 2.5)
      } else if (enemy.state === 'investigate') {
        if (enemy.spec.role === 'sniper') {
          if (enemy.lastKnown) this.face(enemy, enemy.lastKnown, dt, 2.2)
          if (enemy.timer > 3) this.enter(enemy, 'search')
        } else if (enemy.lastKnown) {
          const target = enemy.alarmExit ?? enemy.lastKnown
          // Closing in on where he lost you, he may lob a frag there first.
          if (enemy.searchKind === 'lost' && this.tryGrenade(enemy, enemy.lastKnown)) { enemy.path = []; enemy.pathTarget = null }
          moving = this.move(enemy, target, this.speed(enemy, enemy.suspicion >= 0.5 || enemy.spec.boss ? ENEMY_RUN_SPEED : 1.4), dt)
          if (!moving && !enemy.path.length) this.face(enemy, enemy.lastKnown, dt)
          if (enemy.alarmExit && enemy.position.distanceTo(enemy.alarmExit) < 1) { enemy.alarmExit = null; enemy.timer = 0 }
          else if (enemy.position.distanceTo(target) < 1 || enemy.timer > (enemy.alarmResponse ? 20 : 11)) this.enter(enemy, 'search')
        } else this.enter(enemy, 'search')
      } else if (enemy.state === 'search') {
        moving = this.search(enemy, dt)
      } else if (enemy.state === 'guard') {
        const post = enemy.post ?? point.fromArray(enemy.spec.position)
        // A queued plan reads its destination later, so it never receives the shared scratch point.
        // A screen runs to his place on the zone's edge; a cautious guard looks toward the trouble.
        if (enemy.position.distanceTo(post) > 0.6) moving = this.move(enemy, enemy.post ?? post.clone(), this.speed(enemy, enemy.screen ? ENEMY_RUN_SPEED : 1.25), dt)
        else if (enemy.watch && (enemy.screen || enemy.sentry || enemy.watchTimer > 0)) this.face(enemy, enemy.watch, dt, 2.2)
        else this.face(enemy, point.set(enemy.position.x + Math.sin(enemy.spec.facing ?? 0), enemy.position.y, enemy.position.z + Math.cos(enemy.spec.facing ?? 0)), dt)
      } else if (enemy.watch && enemy.watchTimer > 0) {
        // Trouble reported elsewhere: he stops on his round and looks that way for a moment.
        this.face(enemy, enemy.watch, dt, 2.2)
      } else if (enemy.buddy && enemy.buddy.state === 'patrol' && enemy.buddy.health > 0) {
        // Walking a comrade's round, a few steps behind and to his side.
        const leader = enemy.buddy, back = ZONES.adapt.buddy
        const spot = point.set(leader.position.x - Math.sin(leader.yaw) * back + Math.cos(leader.yaw) * 0.7, leader.position.y,
          leader.position.z - Math.cos(leader.yaw) * back - Math.sin(leader.yaw) * 0.7)
        if (enemy.position.distanceTo(spot) > 0.8) moving = this.move(enemy, spot.clone(), this.speed(enemy, leader.moveSpeed > 0 ? 1.7 : 1.4), dt)
        else this.face(enemy, point.set(enemy.position.x + Math.sin(leader.yaw), enemy.position.y, enemy.position.z + Math.cos(leader.yaw)), dt)
      } else if (enemy.spec.patrolMode === 'perimeter') {
        moving = this.perimeterPatrol(enemy, dt)
      } else {
        const route = enemy.spec.patrol
        if (route.length) {
          const destination = new THREE.Vector3(...route[enemy.waypoint % route.length])
          if (enemy.wait > 0) enemy.wait -= dt
          else if (enemy.position.distanceTo(destination) < (enemy.reserveRoute && enemy.waypoint === route.length - 1 ? 1.25 : 0.6)) {
            enemy.waypoint = (enemy.waypoint + 1) % route.length
            enemy.visitedWaypoints++
            enemy.wait = 1.3 + this.random(enemy) * 2.2
            enemy.path = []; enemy.pathTarget = null
            if (enemy.reserveRoute && enemy.waypoint === 0) {
              enemy.reserveRoute = false
              const point = this.reserveDestination ?? destination
              const index = Math.max(0, this.context.specs.filter(spec => spec.reserve).findIndex(spec => spec.id === enemy.spec.id))
              // A detail searches different standing positions, never a single console/crowd coordinate.
              const angle = index * 2.399
              enemy.post = null
              for (const radius of [1.45, 2.1, 0.75, 2.7]) {
                const candidate = this.navigation.floor(new THREE.Vector3(point.x + Math.sin(angle) * radius, enemy.position.y, point.z + Math.cos(angle) * radius))
                if (candidate && !this.enemies.some(other => other !== enemy && other.post && other.post.distanceTo(candidate) < 0.9)) { enemy.post = candidate; break }
              }
              enemy.post ??= enemy.position.clone()
              enemy.lastKnown = enemy.post.clone()
              this.enter(enemy, 'investigate')
            }
          } else moving = this.move(enemy, destination, this.speed(enemy, 1.4), dt)
        }
      }
      enemy.actor.root.position.copy(enemy.position)
      enemy.actor.root.rotation.y = enemy.yaw
      enemy.actor.root.userData.alertScan = enemy.scanTimer > 0 && this.posture(enemy) !== 'prone' && this.posture(enemy) !== 'kneel' ? 1 - enemy.scanTimer / enemy.scanDuration : undefined
      // Hunting through a dark room (searching, checking a noise, or fighting someone he cannot see): torch on.
      const hunting = enemy.state === 'search' || enemy.state === 'investigate' || (enemy.state === 'combat' && !enemy.canSee)
      this.flashlights?.set(enemy.spec.id, hunting && this.flashlights.dark(enemy.position), enemy.position, enemy.yaw, dt)
      const animate = this.animationStep(enemy, dt, moving)
      if (animate > 0) enemy.actor.update(animate, enemy.state, moving, enemy.canSee && enemy.lastKnown ? aimPoint.copy(enemy.lastKnown).setY(enemy.lastKnown.y + 1.65) : undefined, enemy.moveSpeed)
    }
    this.updateZones(dt)
  }

  /**
   * Out of ammunition: run to the nearest supply crate still standing and restock (a full magazine and AMMO.spare
   * more). With no crate left, get out of the threat's sight and keep his head down.
   */
  private resupply(enemy: Enemy, dt: number) {
    const supplies = this.context.supplies?.() ?? []
    if (enemy.supply && !supplies.some(crate => crate.id === enemy.supply!.id)) enemy.supply = null
    if (!enemy.supply) {
      let best: { id: string; point: THREE.Vector3 } | null = null, nearest = Infinity
      for (const crate of supplies) {
        const distance = crate.position.distanceTo(enemy.position) + Math.abs(crate.position.y - enemy.position.y) * 4
        if (distance >= nearest) continue
        // Somewhere to stand beside it: the crate itself is in the way.
        for (const radius of [0.9, 1.15]) for (let i = 0; i < 8; i++) {
          const angle = i / 8 * Math.PI * 2
          const point = this.navigation.floor(new THREE.Vector3(crate.position.x + Math.sin(angle) * radius, crate.position.y, crate.position.z + Math.cos(angle) * radius), false)
          if (point) { best = { id: crate.id, point }; nearest = distance; break }
        }
      }
      enemy.supply = best
      if (best) this.say(enemy, 'Going for ammo!', 'flank')
    }
    const run = this.speed(enemy, ENEMY_RUN_SPEED)
    if (enemy.supply) {
      if (enemy.position.distanceTo(enemy.supply.point) > AMMO.supplyReach) return this.move(enemy, enemy.supply.point, run, dt)
      // At the crate: restock and get back to it.
      const magazine = WEAPON[enemy.spec.weapon].magazine
      enemy.magazine = magazine; enemy.reserve = magazine * AMMO.spare; enemy.supply = null; enemy.shotTimer = 0.4
      enemy.tactic = 'hold'; enemy.tacticPoint = null; enemy.tacticTimer = 0
      this.context.emit({ kind: 'enemy-reload', position: enemy.position.clone(), radius: 5, weapon: enemy.spec.weapon })
      this.say(enemy, 'Restocked!', 'reload')
      return false
    }
    // Nothing left to restock from: into cover from wherever the threat was, and stay there.
    if (enemy.lastKnown) {
      const threat = enemy.lastKnown.clone().add(eyeOffset)
      if (!enemy.tacticPoint || enemy.tactic !== 'retreat') { enemy.tacticPoint = this.coverPoint(enemy, threat, true); enemy.tactic = 'retreat' }
      if (enemy.tacticPoint && enemy.position.distanceTo(enemy.tacticPoint) > 0.5) return this.move(enemy, enemy.tacticPoint, run, dt)
      this.face(enemy, enemy.lastKnown, dt)
    }
    return false
  }

  private nextPatrolStop(enemy: Enemy, from: number) {
    // Walk past intermediate points before choosing another 3–7 second lookout.
    const count = enemy.spec.patrol.length
    enemy.patrolStop = (from + 2 + Math.floor(this.random(enemy) * 4)) % count
  }

  private perimeterPatrol(enemy: Enemy, dt: number) {
    const route = enemy.spec.patrol
    if (route.length < 2) return false
    if (enemy.wait > 0) {
      enemy.wait = Math.max(0, enemy.wait - dt)
      if (enemy.visitedWaypoints > 0) {
        // Look out over the compound, rather than staring at the tank or path.
        const center = new THREE.Vector3()
        for (const point of route) center.add(new THREE.Vector3(...point))
        center.multiplyScalar(1 / route.length)
        this.face(enemy, enemy.position.clone().multiplyScalar(2).sub(center), dt, 1.8)
      }
      return false
    }
    const destination = new THREE.Vector3(...route[enemy.waypoint % route.length])
    if (enemy.position.distanceTo(destination) < 0.3) {
      if (enemy.waypoint === enemy.patrolStop) {
        enemy.wait = 3 + this.random(enemy) * 4
        this.nextPatrolStop(enemy, enemy.waypoint)
      }
      enemy.waypoint = (enemy.waypoint + 1) % route.length
      enemy.visitedWaypoints++
      enemy.path = []; enemy.pathTarget = null
      return false
    }
    return this.move(enemy, destination, this.speed(enemy, 1.25), dt)
  }

  // ---------------------------------------------------------------- combat tactics

  private squad(enemy: Enemy) {
    return this.enemies.filter(other => other !== enemy && other.state === 'combat' && other.health > 0 &&
      other.position.distanceTo(enemy.position) < 28 && other.lastKnown && enemy.lastKnown && other.lastKnown.distanceTo(enemy.lastKnown) < 12)
  }

  /** Reserve space for an ally's destination as well as its current body. */
  private availablePosition(enemy: Enemy, point: THREE.Vector3, spacing = 1.4) {
    return !this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' &&
      (other.position.distanceTo(point) < spacing || other.tacticPoint && other.tacticPoint.distanceTo(point) < spacing))
  }

  /** Walkable point near the enemy that real geometry hides from the threat's eye. Prefers close points; `away` prefers distance from the threat. */
  private coverPoint(enemy: Enemy, threat: THREE.Vector3, away: boolean) {
    let best: THREE.Vector3 | null = null, bestScore = -Infinity, found = 0
    const offset = this.random(enemy) * Math.PI * 2
    for (let i = 0; i < 10 && found < 4; i++) {
      const angle = offset + i * 0.628
      for (const radius of [2.6, 4.6, 6.8, 9.5]) {
        const candidate = this.navigation.floor(new THREE.Vector3(enemy.position.x + Math.sin(angle) * radius, enemy.position.y, enemy.position.z + Math.cos(angle) * radius))
        if (!candidate || !this.availablePosition(enemy, candidate) || this.context.world.visible(threat, candidate.clone().add(eyeOffset), ignore) || !this.navigation.segment(enemy.position, candidate, false)) continue
        const toThreat = Math.hypot(candidate.x - threat.x, candidate.z - threat.z)
        const score = -radius * 0.35 + (away ? toThreat * 0.25 : -Math.max(0, 5 - toThreat) * 0.5)
        found++
        if (score > bestScore) { bestScore = score; best = candidate }
        break
      }
    }
    return best
  }

  /** Short step out of cover to a point that exposes the threat again. */
  private peekPoint(enemy: Enemy, threat: THREE.Vector3) {
    const forward = threat.clone().sub(enemy.position).setY(0).normalize()
    for (const [side, ahead] of [[1.4, 0.2], [-1.4, 0.2], [2, 0.8], [-2, 0.8], [0, 1.6]]) {
      const candidate = this.navigation.floor(enemy.position.clone().add(new THREE.Vector3(forward.z * side + forward.x * ahead, 0, -forward.x * side + forward.z * ahead)))
      if (!candidate || !this.availablePosition(enemy, candidate) || !this.navigation.segment(enemy.position, candidate, false)) continue
      const origin = candidate.clone().add(eyeOffset)
      if (!this.context.world.visible(threat, origin, ignore)) continue
      const ray = threat.clone().sub(origin).normalize()
      if (!this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' && rayBodyDistance(origin, ray, other.position) < origin.distanceTo(threat))) return candidate
    }
    return null
  }

  /** A bounded run to a visible firing lane, never a chase to the player's feet. */
  private firingPosition(enemy: Enemy, known: THREE.Vector3, advance: boolean) {
    const forward = known.clone().sub(enemy.position).setY(0).normalize()
    const distance = Math.hypot(known.x - enemy.position.x, known.z - enemy.position.z)
    const ideal = enemy.spec.weapon === 'shotgun' ? 9 : enemy.spec.weapon === 'smg' ? 14 : enemy.spec.weapon === 'pistol' ? 16 : 22
    const ahead = advance ? Math.min(9, Math.max(0, distance - ideal)) : Math.min(2, Math.max(0, distance - ideal))
    const side = this.random(enemy) < 0.5 ? 1 : -1
    for (const lateral of [side * 5, -side * 5, side * 3, -side * 3]) {
      const candidate = this.navigation.floor(enemy.position.clone().addScaledVector(forward, ahead)
        .add(new THREE.Vector3(forward.z * lateral, 0, -forward.x * lateral)))
      if (!candidate || !this.availablePosition(enemy, candidate, 2.5) || !this.navigation.segment(enemy.position, candidate, false)) continue
      const origin = candidate.clone().add(eyeOffset), target = known.clone().add(eyeOffset)
      if (!this.context.world.visible(origin, target, ignore)) continue
      const ray = target.clone().sub(origin).normalize()
      if (this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' &&
        this.bodyHit(other, origin, ray, origin.distanceTo(target)))) continue
      return candidate
    }
    return null
  }

  private chooseTactic(enemy: Enemy) {
    const known = enemy.lastKnown!
    const threatEye = known.clone().add(eyeOffset)
    const distance = enemy.position.distanceTo(known)
    const roll = this.random(enemy)
    enemy.tacticPoint = null
    if (enemy.spec.role === 'sniper') { enemy.tactic = 'hold'; enemy.tacticTimer = 4; return }
    // Bulky Boy never takes cover or flanks: he walks straight at where you were, firing as he comes (see combat), and
    // plants himself only once he is on top of you. Short timers so he keeps re-aiming his walk at you.
    if (enemy.spec.boss) {
      const point = distance > BOSS_RULES.closeIn ? this.navigation.floor(known.clone()) : null
      enemy.tactic = point ? 'charge' : 'hold'; enemy.tacticPoint = point; enemy.tacticTimer = point ? 2.5 : 1.2
      if (point && roll < 0.3) this.say(enemy, roll < 0.15 ? 'Come here!' : 'You can\'t hide from me!', 'contact')
      return
    }
    // A squad that has lost half its men: the wounded fall back to cover away from you, and the zone calls for help.
    if (this.losingFight(enemy) && enemy.health < ROLES.fallBack.health && distance < 30 && !enemy.woundLeg) {
      // To cover away from you, or with none about, just back off the way he came.
      const away = direction.set(enemy.position.x - known.x, 0, enemy.position.z - known.z).normalize()
      const point = this.coverPoint(enemy, threatEye, true) ?? this.navigation.floor(enemy.position.clone().addScaledVector(away, 10))
      if (point) {
        enemy.tactic = 'retreat'; enemy.tacticPoint = point; enemy.tacticTimer = 6
        this.say(enemy, 'We\'re losing men! Fall back! Need backup!', 'flank', true)
        this.callForHelp(enemy.zone)
        return
      }
    }
    // Rushers (shotguns, SMGs) close in on you, firing once they are in range; reloading or badly hurt, they still
    // fall back below like anyone.
    const fighting = this.fighting(enemy)
    if (fighting === 'rush' && enemy.reloadTimer <= 0 && enemy.health >= 35) {
      const point = distance > this.closeIn(enemy) ? this.navigation.floor(known.clone()) : null
      enemy.tactic = point ? 'charge' : 'hold'; enemy.tacticPoint = point; enemy.tacticTimer = point ? 2.2 : 1.4
      if (point && roll < 0.25) this.say(enemy, roll < 0.12 ? 'Moving in!' : 'Pushing up!', 'flank')
      return
    }
    // Riflemen in a squad fight go wide, one at a time while another covers him (in view of you, planted, loaded): a flanking
    // position out to the side at rifle range, then they fight from cover. A lone guard, or one at a protected post
    // with you in view, keeps to the ordinary choices below.
    const mates = this.squadmates(enemy).filter(other => other.state === 'combat')
    const flanking = mates.some(other => this.fighting(other) === 'flank' && other.tactic === 'flank' && other.tacticTimer > 0)
    const covered = mates.some(other => other.canSee && other.tactic === 'hold' && other.settledFor >= COMBAT.settle && other.reloadTimer <= 0 && other.magazine > 0 && other.hitPause <= 0)
    if (fighting === 'flank' && covered && !flanking && !enemy.flanked && enemy.reloadTimer <= 0 && enemy.health >= 35 && !enemy.woundLeg && distance < 45 &&
      !(enemy.canSee && this.protectedPost(enemy))) {
      const point = this.flankPoint(enemy, known)
      enemy.flanked = true
      if (point) {
        enemy.tactic = 'flank'; enemy.tacticPoint = point; enemy.tacticTimer = 9
        this.say(enemy, roll < 0.5 ? 'Flanking left!' : 'Going wide!', 'flank'); return
      }
    }
    if (enemy.reloadTimer > 0 || enemy.health < 35) {
      if (!this.context.world.visible(threatEye, enemy.position.clone().add(eyeOffset), ignore)) {
        enemy.tactic = 'hold'; enemy.tacticTimer = Math.max(1, enemy.reloadTimer + 0.3); return
      }
      enemy.tacticPoint = this.coverPoint(enemy, threatEye, true)
      if (enemy.tacticPoint) { enemy.tactic = 'cover'; enemy.tacticTimer = 5; return }
      if (enemy.reloadTimer > 0) { enemy.tactic = 'hold'; enemy.tacticTimer = enemy.reloadTimer + 0.3; return }
    }
    if (distance < 6) {
      enemy.tactic = 'hold'
      enemy.tacticTimer = 3
      return
    }
    const squad = this.squad(enemy)
    // Fixed posts retain their shelter and height while they have contact.
    if (enemy.canSee && this.protectedPost(enemy)) { enemy.tactic = 'hold'; enemy.tacticTimer = 4; return }
    const covering = squad.some(ally => ally.canSee && ally.tactic === 'hold' && ally.settledFor >= COMBAT.settle && ally.reloadTimer <= 0 && ally.magazine > 0 && ally.hitPause <= 0)
    // Anyone of his squad on the move counts, however far out their flank has taken them.
    const repositioning = [...squad, ...mates.filter(mate => this.fighting(mate) === 'flank')].some(ally => ['flank', 'charge', 'cover', 'retreat', 'peek'].includes(ally.tactic))
    if (covering && !repositioning && roll < 0.6 && distance < 35 && !enemy.woundLeg) {
      const point = this.firingPosition(enemy, known, false)
      if (point) {
        enemy.tactic = 'flank'; enemy.tacticPoint = point; enemy.tacticTimer = 7
        this.say(enemy, 'Flanking! Keep him busy!', 'flank'); return
      }
    }
    // Keep a planted shooter covering the teammate who is changing angle.
    if (repositioning && enemy.canSee) {
      enemy.tactic = 'hold'; enemy.tacticTimer = 2; return
    }
    const cover = this.coverPoint(enemy, threatEye, false)
    if (cover && roll < 0.85) { enemy.tactic = 'cover'; enemy.tacticPoint = cover; enemy.tacticTimer = 5; return }
    // Only confirmed contact justifies a fast advance; teammates keep a covering lane.
    const effectiveRange = enemy.spec.weapon === 'shotgun' ? 12 : enemy.spec.weapon === 'smg' ? 18 : enemy.spec.weapon === 'pistol' ? 20 : 26
    const shouldAdvance = enemy.canSee && distance > effectiveRange && !enemy.woundLeg && (!squad.length || covering && !repositioning)
    enemy.tacticPoint = shouldAdvance ? this.firingPosition(enemy, known, true) : null
    enemy.tactic = enemy.tacticPoint ? 'charge' : 'hold'
    enemy.tacticTimer = enemy.tacticPoint ? 7 : 3.5
  }

  private combat(enemy: Enemy, player: PlayerSense, dt: number) {
    const known = enemy.lastKnown
    if (!known) return false
    // A defensive reaction keeps its planted firing window; existing burst and aim timers survive.
    if (enemy.defensiveTimer > 0) {
      enemy.tactic = 'hold'
      enemy.tacticPoint = null
      enemy.tacticTimer = Math.max(enemy.tacticTimer, enemy.defensiveTimer)
    } else enemy.tacticTimer -= dt
    // A nearby exposed threat takes priority over a long flank or advance.
    if (enemy.canSee && enemy.position.distanceTo(known) < this.closeIn(enemy) && (enemy.tactic === 'flank' || enemy.tactic === 'charge') && enemy.reloadTimer <= 0 && enemy.health >= 35) {
      enemy.tactic = 'hold'; enemy.tacticPoint = null; enemy.tacticTimer = COMBAT.openingHold
      enemy.path = []; enemy.pathTarget = null; this.plans.delete(enemy)
    }
    // Finish a live burst before moving; a reload can request shelter immediately.
    if (enemy.tacticTimer <= 0 && (enemy.burst <= 0 || !enemy.canSee || enemy.reloadTimer > 0)) this.chooseTactic(enemy)
    let moving = false
    const combatSpeed = this.speed(enemy, ENEMY_RUN_SPEED)
    switch (enemy.tactic) {
      case 'cover': case 'retreat': case 'flank': {
        const point = enemy.tacticPoint
        if (!point) { enemy.tacticTimer = 0; break }
        if (enemy.position.distanceTo(point) > 0.5) {
          moving = this.move(enemy, point, combatSpeed, dt)
          // A finished plan with no route means the point is unreachable: pick something else now.
          if (!enemy.path.length && !this.plans.has(enemy) && enemy.repath > 0) enemy.tacticTimer = 0
        } else if (enemy.tactic === 'cover') {
          if (enemy.reloadTimer > 0) { enemy.tacticTimer = Math.max(enemy.tacticTimer, enemy.reloadTimer + 0.3); break }
          // Arrived in cover: wait out the burst, then step out to fire.
          enemy.tactic = 'hold'; enemy.tacticTimer = 1.8; enemy.tacticPoint = this.peekPoint(enemy, known.clone().add(eyeOffset))
          if (enemy.tacticPoint) enemy.tactic = 'peek'
        } else {
          enemy.tactic = 'hold'; enemy.tacticPoint = null; enemy.tacticTimer = 3.5
          enemy.path = []; enemy.pathTarget = null; this.plans.delete(enemy)
          // Travel faces away from contact. Give the normal short reacquisition window
          // to turn back toward the remembered position, without learning a hidden one.
          enemy.lostFor = 0; enemy.senseTimer = 0
        }
        break
      }
      case 'peek': {
        // Step out to the exposed point and shoot; the next tactic choice usually returns to cover.
        if (enemy.tacticPoint && enemy.position.distanceTo(enemy.tacticPoint) > 0.3) {
          moving = this.move(enemy, enemy.tacticPoint, this.speed(enemy, 1.4), dt)
        } else {
          enemy.tactic = 'hold'; enemy.tacticTimer = 3
        }
        break
      }
      case 'charge': {
        if (enemy.tacticPoint && enemy.position.distanceTo(enemy.tacticPoint) > 0.5) moving = this.move(enemy, enemy.tacticPoint, combatSpeed, dt)
        else {
          enemy.tactic = 'hold'; enemy.tacticPoint = null; enemy.tacticTimer = 3.5
          enemy.path = []; enemy.pathTarget = null; this.plans.delete(enemy)
          enemy.lostFor = 0; enemy.senseTimer = 0
        }
        break
      }
      default: break
    }
    // An active route owns orientation, including while waiting on navigation or opening a door.
    const positioning = enemy.tactic !== 'hold' && !!enemy.tacticPoint && enemy.position.distanceTo(enemy.tacticPoint) > 0.5 || enemy.tactic === 'charge'
    if (!moving && !positioning) this.face(enemy, known, dt, COMBAT.turnSpeed)
    const aimYaw = Math.atan2(known.x - enemy.position.x, known.z - enemy.position.z)
    const aligned = Math.cos(aimYaw - enemy.yaw) >= Math.cos(COMBAT.aimHalfAngle)
    // Small tracking turns are valid firing poses; only locomotion or a large turn resets readiness.
    enemy.settledFor = moving || !aligned || positioning || this.transitioning(enemy) ? 0 : enemy.settledFor + dt
    // The boss fires on the move whenever he is facing you; everyone else has to stop and settle first.
    const ready = enemy.spec.boss ? aligned && !this.transitioning(enemy) : enemy.settledFor >= COMBAT.settle
    if (enemy.canSee) {
      this.communicate(enemy)
      if (ready && enemy.aimTime >= this.aimDelay(enemy) && enemy.shotTimer <= 0) {
        if (this.shoot(enemy, player)) enemy.blockedFor = 0
        else enemy.blockedFor += Math.max(dt, COMBAT.blockedRetry)
      }
      // A visible head over cover or a teammate in the doorway needs a new firing lane.
      if (enemy.blockedFor >= COMBAT.blockedReposition && enemy.spec.role !== 'sniper' && enemy.tactic === 'hold' && enemy.defensiveTimer <= 0) {
        const point = this.peekPoint(enemy, known.clone().add(eyeOffset))
        enemy.blockedFor = 0
        if (point) { enemy.tactic = 'peek'; enemy.tacticPoint = point; enemy.tacticTimer = 2 }
      }
    } else {
      // You ducked out of sight: the squad's suppressor keeps firing at where you were while the others move, and if
      // you stay down, someone lobs a frag at you.
      const { after, time, range } = ROLES.suppress
      if (ready && enemy.shotTimer <= 0 && enemy.lostFor >= after && enemy.lostFor <= after + time && enemy.position.distanceTo(known) <= range && this.suppressor(enemy) === enemy) {
        if (enemy.lostFor < after + 0.25) this.say(enemy, 'Suppressing fire! Keep his head down!', 'contact')
        this.shoot(enemy, player, true)
      }
      if (!moving) this.tryGrenade(enemy, known)
    }
    return moving
  }

  /**
   * His squad's suppressor while no one sees you: the first in the list of those holding their ground with rounds
   * left (not a sniper or a shotgun), if any comrade is in the fight with him. A fixed choice, so the job does not pass back and forth burst by burst.
   */
  private suppressor(enemy: Enemy) {
    // Suppression covers comrades on the move: a man fighting alone has nobody to cover.
    const mates = this.squadmates(enemy)
    if (!mates.some(mate => mate.state === 'combat')) return null
    let best: Enemy | null = null
    for (const other of [enemy, ...mates]) {
      if (other.state !== 'combat' || other.canSee || other.tactic !== 'hold' || other.spec.weapon === 'sniper' || other.spec.weapon === 'shotgun' || other.magazine + other.reserve <= 0) continue
      if (!best || other.slot < best.slot) best = other
    }
    return best
  }

  /**
   * Lob a frag at where you went to ground (COMBAT_ROLES.grenade): only if you have stayed out of sight a while, at a
   * throwing distance, with no comrade near where it lands and a clear arc over whatever you hide behind. The arc is
   * aimed a little short, for the roll.
   */
  private tryGrenade(enemy: Enemy, known: THREE.Vector3) {
    const rules = ROLES.grenade
    if (enemy.grenades <= 0 || enemy.grenadeCooldown > 0 || enemy.lostFor < rules.after || enemy.lostFor > rules.until || !this.context.throwGrenade) return false
    if (enemy.reloadTimer > 0 || enemy.hitPause > 0 || enemy.blind > 0 || enemy.spec.role === 'sniper' || enemy.spec.boss) return false
    const distance = flat(enemy.position.x, enemy.position.z, known.x, known.z)
    if (distance < rules.near || distance > rules.far || Math.abs(known.y - enemy.position.y) > 4) return false
    if (this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'dead' && other.state !== 'reserve' && other.position.distanceTo(known) < rules.clear)) return false
    const eye = this.eye(enemy)
    const top = eye.clone().lerp(known, 0.5)
    top.y = Math.max(eye.y, known.y) + 2.6
    const landing = known.clone().setY(known.y + 1.2)
    if (!this.context.world.visible(eye, top, ignore) || !this.context.world.visible(top, landing, ignore)) return false
    const aim = known.clone().lerp(enemy.position, Math.min(0.15, 1.2 / distance))
    const from = eye.clone().addScaledVector(direction.set(aim.x - eye.x, 0, aim.z - eye.z).normalize(), 0.4)
    const flight = clamp(distance / 11, 0.75, 1.6), gravity = GRENADE_RULES.throw.gravity
    const velocity = aim.clone().sub(from).divideScalar(flight)
    velocity.y += 0.5 * gravity * flight
    enemy.grenades--
    for (const mate of [enemy, ...this.squadmates(enemy)]) mate.grenadeCooldown = rules.cooldown
    enemy.shotTimer = Math.max(enemy.shotTimer, 1.2)
    this.say(enemy, 'Frag out!', 'contact', true)
    this.context.throwGrenade('frag', from, velocity)
    return true
  }

  /** A grenade landed at `at`: everyone within COMBAT_ROLES.dodge.radius runs from it, shouting. */
  private dodge(at: THREE.Vector3) {
    const { radius, distance, time } = ROLES.dodge
    let shouted = false
    for (const enemy of this.enemies) {
      if (enemy.health <= 0 || enemy.state === 'dead' || enemy.state === 'reserve' || enemy.spec.dummy || enemy.spec.boss || enemy.dodgeTimer > 0) continue
      if (enemy.position.distanceTo(at) > radius || Math.abs(enemy.position.y - at.y) > 2.5) continue
      const away = direction.set(enemy.position.x - at.x, 0, enemy.position.z - at.z)
      if (away.lengthSq() < 1e-4) away.set(Math.sin(enemy.yaw), 0, Math.cos(enemy.yaw))
      away.normalize()
      let spot: THREE.Vector3 | null = null
      for (const turn of [0, 0.7, -0.7, 1.4, -1.4]) {
        const heading = away.clone().applyAxisAngle(up, turn)
        const candidate = this.navigation.floor(enemy.position.clone().addScaledVector(heading, distance - enemy.position.distanceTo(at) + 2))
        if (candidate && candidate.distanceTo(at) > enemy.position.distanceTo(at)) { spot = candidate; break }
      }
      if (!spot) continue
      enemy.dodgePoint = spot; enemy.dodgeTimer = time
      enemy.path = []; enemy.pathTarget = null; this.plans.delete(enemy)
      if (!shouted) { shouted = true; this.say(enemy, 'Grenade! Get clear!', 'contact', true) }
    }
  }

  /** A squad that has lost as many men as it has left. */
  private losingFight(enemy: Enemy) {
    if (enemy.squad < 0) return false
    let dead = 0, alive = 0
    for (const other of this.enemies) {
      if (other.squad !== enemy.squad || other.spec.dummy || other.state === 'reserve') continue
      if (other.health <= 0 || other.state === 'dead') dead++; else alive++
    }
    return dead + alive >= 2 && dead >= alive
  }

  /** A squad in trouble calls for help (a fresh reinforcement from the nearest cautious zone), at most every COMBAT_ROLES.fallBack.call s. */
  private callForHelp(index: number) {
    const zone = this.zones.zones[index]
    if (!zone || zone.help > 0) return
    zone.help = ROLES.fallBack.call
    this.reinforce(index)
  }

  /**
   * A sniper with you in his scope radios your position to every man hunting you within COMBAT_ROLES.overwatch.reach:
   * they come for where you are, and those still searching drop it and come.
   */
  private overwatch(sniper: Enemy, seen: PlayerSense) {
    if (this.elapsed - (this.overwatchAt.get(sniper) ?? -Infinity) < ROLES.overwatch.every || !this.zoneRadio(sniper.zone)) return
    this.overwatchAt.set(sniper, this.elapsed)
    let told = 0
    for (const ally of this.enemies) {
      if (ally === sniper || ally.canSee || ally.spec.dummy || ally.health <= 0 || !(ally.state === 'combat' || ally.state === 'investigate' || ally.state === 'search')) continue
      if (ally.position.distanceTo(seen.feet) > ROLES.overwatch.reach) continue
      if (ally.lastKnown) ally.lastKnown.copy(seen.feet); else ally.lastKnown = seen.feet.clone()
      ally.lostFor = 0
      ally.lastHeading = sniper.lastHeading?.clone() ?? null
      if (ally.state === 'search') { ally.searchKind = 'lost'; this.enter(ally, 'investigate') }
      told++
    }
    if (!told) return
    const zone = this.zones.zoneAt(seen.feet)
    const place = zone >= 0 ? `by the ${this.zones.zones[zone].name.toLowerCase()}` : `${compass(direction.subVectors(seen.feet, sniper.position))} of me`
    this.say(sniper, `Sniper here, eyes on him ${place}!`, 'contact')
  }

  // ---------------------------------------------------------------- search

  /**
   * The places he checks round the centre of his search (the body, the sound, where he lost you), by what it is about
   * (DETECTION.search): hiding places he cannot see into first, then the rest; a lost contact first where you were
   * heading. Allies searching the same ground take different places.
   */
  private planSearch(enemy: Enemy) {
    enemy.searchPoints = []
    enemy.searchLooks = []
    enemy.searchIndex = 0
    enemy.wait = 0
    enemy.bound = 0
    if (enemy.sector) { this.planSweep(enemy); return }
    const plan = DETECTION.search[enemy.searchKind]
    const center = enemy.lastKnown ?? enemy.position
    const origin = enemy.position.clone().add(eyeOffset)
    const taken = (point: THREE.Vector3) => this.enemies.some(ally => ally !== enemy && ally.state === 'search' &&
      ally.searchPoints.slice(ally.searchIndex).some(assigned => assigned.distanceTo(point) < 2.5))
    const usable = (point: THREE.Vector3 | null): point is THREE.Vector3 => !!point && this.availablePosition(enemy, point) && !taken(point)
    const ahead: THREE.Vector3[] = []
    // Lost you while you were on the move: first where you were going, along the ground you could actually have
    // walked (straight on if you could, else the way the passage turns).
    if (enemy.searchKind === 'lost' && enemy.lastHeading) {
      const turned = new THREE.Vector3()
      search: for (const turn of [0, 0.6, -0.6, 1.2, -1.2]) {
        turned.copy(enemy.lastHeading).applyAxisAngle(up, turn)
        for (const along of [7, 4.5]) {
          const point = this.navigation.floor(center.clone().addScaledVector(turned, along))
          if (usable(point) && this.navigation.direct(center, point)) { ahead.push(point); break search }
        }
      }
    }
    // Then the hiding places round there he cannot see behind.
    const checks = this.hidingChecks(enemy, center, plan.reach[1] + 2, 2)
    const start = this.enemies.indexOf(enemy) * 1.2 + this.random(enemy) * 0.6
    const hidden: THREE.Vector3[] = [], open: THREE.Vector3[] = []
    const [near, far] = plan.reach
    for (let i = 0; i < 10; i++) {
      const angle = start + i * 0.628, radius = near + this.random(enemy) * (far - near)
      const point = this.navigation.floor(new THREE.Vector3(center.x + Math.sin(angle) * radius, center.y, center.z + Math.cos(angle) * radius))
      if (!usable(point) || [...ahead, ...hidden, ...open].some(other => other.distanceTo(point) < 2)) continue
      ;(this.context.world.visible(origin, point.clone().add(eyeOffset), ignore) ? open : hidden).push(point)
    }
    const points = [...ahead.map(point => ({ point, look: null as THREE.Vector3 | null })), ...checks,
      ...[...hidden, ...open].filter(point => !checks.some(check => check.point.distanceTo(point) < 2)).map(point => ({ point, look: null }))].slice(0, plan.points)
    enemy.searchPoints = points.map(entry => entry.point)
    enemy.searchLooks = points.map(entry => entry.look)
  }

  /**
   * A search team's sweep: out from where the trouble was along the team's slice of the compass (ZONES.sweep.spread
   * wide), nearer places first, each a little further out. The leader takes the line; the others walk beside him,
   * 2.2 m to alternate sides, so the team moves and looks as one.
   */
  private planSweep(enemy: Enemy) {
    enemy.searchKind = 'sweep'
    const plan = DETECTION.search.sweep, sector = enemy.sector!
    const center = enemy.lastKnown ?? enemy.position
    const base = Math.atan2(sector.x, sector.z), spread = ZONES.sweep.spread * Math.PI / 180
    const side = enemy.teamSlot ? (enemy.teamSlot % 2 ? 1 : -1) * Math.ceil(enemy.teamSlot / 2) * 2.2 : 0
    const [near, far] = plan.reach
    // The whole team draws the same line (seeded by the team), so the others keep beside their leader.
    let seed = 2654435761 * (enemy.team + 1) >>> 0
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
    for (let i = 0; i < plan.points; i++) {
      const along = near + (far - near) * (i + 0.5) / plan.points
      const angle = base + (next() - 0.5) * spread
      for (const nudge of [0, 0.35, -0.35, 0.7, -0.7]) {
        const a = angle + nudge * spread
        const x = center.x + Math.sin(a) * along + Math.cos(a) * side, z = center.z + Math.cos(a) * along - Math.sin(a) * side
        const found = this.navigation.floor(new THREE.Vector3(x, center.y, z))
        if (found && this.availablePosition(enemy, found, 1)) { enemy.searchPoints.push(found); enemy.searchLooks.push(null); break }
      }
    }
    // The leader also checks the hiding places in the team's slice, in order of distance along the way.
    if (enemy.teamSlot === 0) {
      const checks = this.hidingChecks(enemy, center, far, 2, { direction: sector, half: spread / 2 + 0.2 })
      for (const check of checks) {
        const out = check.point.distanceTo(center)
        let at = enemy.searchPoints.findIndex(point => point.distanceTo(center) > out)
        if (at < 0) at = enemy.searchPoints.length
        enemy.searchPoints.splice(at, 0, check.point); enemy.searchLooks.splice(at, 0, check.look)
      }
    }
  }

  /**
   * Searching: to each place in turn, at a careful walk (a quick one while still hunting you), and at each one a long
   * look round; back to his post once he has seen them all or his time (by what the search is about) runs out.
   */
  private search(enemy: Enemy, dt: number) {
    const plan = DETECTION.search[enemy.searchKind]
    const target = enemy.searchPoints[enemy.searchIndex]
    let moving = false
    if (target && enemy.timer < plan.time) {
      const look = enemy.searchIndex > 0 ? enemy.searchLooks[enemy.searchIndex - 1] : null
      if (enemy.wait > 0) {
        // At a hiding place he looks into it; elsewhere a slow look round.
        enemy.wait -= dt
        if (look) this.face(enemy, look, dt, 2.4)
        else enemy.yaw += Math.sin(enemy.timer * 1.6) * dt * 1.6
        return false
      }
      // A search team bounds: the leader does not move on until his men have caught up (or ZONES-length waits run out);
      // a man does not move up to his next place until the leader has reached his, and covers him meanwhile.
      const leader = enemy.team >= 0 && enemy.teamSlot > 0 ? this.enemies.find(other => other.team === enemy.team && other.teamSlot === 0 && other.state === 'search') : undefined
      if (leader && leader.searchIndex <= enemy.searchIndex && leader.searchPoints.length > enemy.searchIndex) {
        const watching = leader.searchPoints[leader.searchIndex] ?? leader.position
        this.face(enemy, watching, dt, 2.4)
        return false
      }
      if (enemy.team >= 0 && enemy.teamSlot === 0 && enemy.searchIndex > 0 && enemy.bound < BOUND_HOLD) {
        const behind = this.enemies.some(other => other !== enemy && other.team === enemy.team && other.state === 'search' &&
          other.searchIndex < enemy.searchIndex && other.searchPoints.length >= enemy.searchIndex && other.position.distanceTo(enemy.position) > 4)
        if (behind) { enemy.bound += dt; if (enemy.sector) this.face(enemy, point.copy(enemy.position).add(enemy.sector), dt, 2); return false }
      }
      if (enemy.position.distanceTo(target) < 0.7) { enemy.searchIndex++; enemy.bound = 0; enemy.wait = (enemy.searchLooks[enemy.searchIndex - 1] ? 2.2 : 1.6) + this.random(enemy) * 1.2; enemy.path = []; enemy.pathTarget = null }
      else moving = this.move(enemy, target, this.speed(enemy, enemy.suspicion >= 0.5 ? 2.2 : 1.4), dt)
      return moving
    }
    if (!target) enemy.yaw += dt * 0.65
    if (enemy.timer > plan.time || (!target && enemy.timer > 3)) {
      this.say(enemy, enemy.searchKind === 'body' ? 'Nothing. Stay sharp, he\'s still out there.' : 'All clear. Back to post.', 'clear')
      this.enter(enemy, enemy.post ? 'guard' : enemy.spec.patrol.length > 1 ? 'patrol' : 'guard')
    }
    return moving
  }

  // ---------------------------------------------------------------- movement

  private face(enemy: Enemy, target: THREE.Vector3, dt: number, speed = 3) {
    const desired = Math.atan2(target.x - enemy.position.x, target.z - enemy.position.z)
    const difference = Math.atan2(Math.sin(desired - enemy.yaw), Math.cos(desired - enemy.yaw))
    // A planted knee or prone body cannot spin in place to follow a flanking target.
    if (Math.abs(difference) > 0.6 && (this.posture(enemy) === 'prone' || this.posture(enemy) === 'kneel')) {
      this.stand(enemy)
      return
    }
    if (this.transitioning(enemy)) return
    enemy.yaw += clamp(difference, -speed * dt, speed * dt)
  }

  /** Avoid a new overlap; an already overlapping guard may walk out of the overlap. */
  /** Put every guard up and about in his crowd cell, for separated. Once a frame. */
  private indexCrowd() {
    for (const list of this.crowd.values()) list.length = 0
    for (const enemy of this.enemies) {
      if (enemy.state === 'dead' || enemy.state === 'reserve') continue
      const key = crowdKey(enemy.position.x, enemy.position.z)
      let list = this.crowd.get(key)
      if (!list) this.crowd.set(key, list = [])
      list.push(enemy)
    }
  }

  private separated(enemy: Enemy, next: THREE.Vector3, player?: THREE.Vector3) {
    // Every moving guard, every frame: only the guards in the crowd cells round the step (positions from the start of
    // the frame, a few centimetres old at most; the spacing is 0.62 m and the cells 2 m).
    if (enemy.passThrough <= 0) {
      const cx = Math.floor(next.x / CROWD_CELL), cz = Math.floor(next.z / CROWD_CELL)
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
        const list = this.crowd.get((i + 32768) * 65536 + j + 32768)
        if (!list) continue
        for (let k = 0; k < list.length; k++) {
          const other = list[k]
          if (other === enemy || other.state === 'dead' || other.state === 'reserve' || Math.abs(next.y - other.position.y) > 1.5) continue
          const distance = flat(next.x, next.z, other.position.x, other.position.z)
          if (distance < 0.62 && distance < flat(enemy.position.x, enemy.position.z, other.position.x, other.position.z) - 0.0001) return false
        }
      }
    }
    if (!player || Math.abs(next.y - player.y) >= 1.5) return true
    const distance = flat(next.x, next.z, player.x, player.z)
    return distance >= 0.62 || distance >= flat(enemy.position.x, enemy.position.z, player.x, player.z)
  }

  private move(enemy: Enemy, destination: THREE.Vector3, speed: number, dt: number) {
    if (enemy.hitPause > 0) return false
    // Only authored perimeter patrols let a marksman leave his current post.
    // Combat, sounds and alarms never send him chasing targets off the tower.
    if (enemy.spec.role === 'sniper' && (enemy.spec.patrolMode !== 'perimeter' || enemy.state !== 'patrol')) return false
    if (!this.stand(enemy)) return false
    const recovered = this.navigation.recoverDoorOverlap(enemy.position)
    if (recovered && this.separated(enemy, recovered, this.lastPlayer?.feet)) {
      enemy.position.copy(recovered)
      enemy.path = []; enemy.pathTarget = null; enemy.repath = 0; enemy.stuck = 0
    }
    // A destination that has moved a few metres (a target on the move) keeps the route and re-aims its last leg, if
    // that leg is still walkable, instead of planning the whole way again.
    if (enemy.pathTarget && enemy.path.length > 1 && !this.plans.has(enemy)) {
      const moved = enemy.pathTarget.distanceTo(destination)
      if (moved > 1.4 && moved < 4 && this.navigation.direct(enemy.path[enemy.path.length - 2], destination)) {
        enemy.path[enemy.path.length - 1] = destination.clone()
        enemy.pathTarget.copy(destination)
      }
    }
    // After failing to reach somewhere, a nearby destination waits out the back-off rather than searching again.
    const backingOff = enemy.planFailStreak > 0 && enemy.repath > 0 && !!enemy.pathTarget && enemy.pathTarget.distanceTo(destination) < 6
    if (!backingOff && (!enemy.pathTarget || enemy.pathTarget.distanceTo(destination) > 1.4 || (!enemy.path.length && enemy.repath <= 0 && !this.plans.has(enemy)))) {
      enemy.path = []
      enemy.pathTarget = destination.clone()
      this.plans.set(enemy, { target: destination.clone(), job: this.navigation.createPlan(enemy.position, destination) })
    }
    while (enemy.path.length && enemy.position.distanceTo(enemy.path[0]) < 0.24) {
      // Reaching a corner's tolerance radius does not authorize cutting across
      // a door tip (or wall) on the way to the following waypoint.
      if (enemy.path.length > 1 && !this.navigation.segment(enemy.position, enemy.path[1])) {
        // Standing on the corner with the onward leg blocked (a congestion bypass point is only
        // checked from where it was added) would march on the spot forever: plan again from here.
        if (enemy.position.distanceTo(enemy.path[0]) < 0.01) { enemy.path = []; enemy.pathTarget = null; enemy.repath = 0; return false }
        break
      }
      enemy.path.shift()
    }
    const target = enemy.path[0]
    if (!target) return false
    this.face(enemy, target, dt)
    const heading = Math.atan2(target.x - enemy.position.x, target.z - enemy.position.z)
    const angle = Math.atan2(Math.sin(heading - enemy.yaw), Math.cos(heading - enemy.yaw))
    // Finish the planted turn first: the in-place walk/run clips only support forward travel.
    if (Math.abs(angle) > 0.08) return false
    enemy.yaw += angle
    if (enemy.passThrough > 0) enemy.passThrough -= dt
    const next = this.navigation.step(enemy.position, target, speed * dt)
    if (next && this.separated(enemy, next, this.lastPlayer?.feet)) {
      const distance = enemy.position.distanceTo(next)
      enemy.distanceWalked += distance
      enemy.moveSpeed = distance / dt
      enemy.footstepDistance += distance
      enemy.position.copy(next)
      if (enemy.footstepDistance >= 0.85) {
        enemy.footstepDistance %= 0.85
        this.context.emit({ kind: 'enemy-footstep', position: enemy.position.clone(), radius: 5 })
      }
      enemy.stuck = 0
      return true
    }
    enemy.stuck += dt
    // Wait for a blocked catwalk to clear; don't sidestep toward its open edges.
    if (enemy.spec.patrolMode === 'perimeter') return false
    if (enemy.stuck > 0.75) {
      if (!next) {
        // A door can swing across an existing route. Replan around the actual
        // leaf instead of repeatedly sidestepping back onto the blocked segment.
        enemy.path = []; enemy.pathTarget = null; enemy.repath = 0; enemy.stuck = 0
        return false
      }
      // Route around congestion by turning and walking to a bypass point on a later frame.
      const perpendicular = target.clone().sub(enemy.position).setY(0).normalize()
      const side = (enemy.spec.id.charCodeAt(enemy.spec.id.length - 1) & 1) ? 1 : -1
      let stepped = false
      for (const [lateral, forward] of [[side * 0.85, 0], [-side * 0.85, 0], [side * 0.65, -0.8], [-side * 0.65, -0.8], [0, -1.2]]) {
        const bypass = enemy.position.clone().add(new THREE.Vector3(perpendicular.z * lateral + perpendicular.x * forward, 0, -perpendicular.x * lateral + perpendicular.z * forward))
        const alternative = this.navigation.floor(bypass, false)
        if (alternative && this.navigation.segment(enemy.position, alternative, false) && this.separated(enemy, alternative, this.lastPlayer?.feet)) {
          enemy.path.unshift(alternative)
          enemy.stuck = 0
          stepped = true
          break
        }
      }
      // Nowhere to step aside (a corridor, a doorway) and it is another guard in the way, not the player: rather than
      // both standing there and planning the same route again for ever, he slips past for a moment.
      if (!stepped && enemy.stuck > 1.6 && !this.separated(enemy, next)) enemy.passThrough = 1.2
    }
    if (enemy.stuck > 2.8) {
      enemy.path = []; enemy.pathTarget = null; enemy.repath = 0; enemy.stuck = 0
    }
    return false
  }

  private advancePlans(dt = 1 / 60) {
    // Route planning gets a few ms of each frame, never more: plans are resumable and carry on next frame.
    const budget = dt > 1 / 45 ? PLANNING_STRAINED : this.plans.size > 6 ? PLANNING_BUSY : PLANNING_BUDGET
    const started = performance.now(), deadline = started + budget, steps = this.context.planningSteps
    this.navigation.syncDoors()
    const pending = this.planQueue
    pending.length = 0
    for (const enemy of this.plans.keys()) pending.push(enemy)
    let index = 0
    for (let step = 0; pending.length && (steps ? step < steps : performance.now() < deadline); step++) {
      index %= pending.length
      const enemy = pending[index], plan = this.plans.get(enemy)
      if (!plan) { pending.splice(index, 1); continue }
      const result = plan.job.next()
      if (result.done) {
        this.plans.delete(enemy)
        enemy.path = result.value
        enemy.pathTarget = plan.target
        // A route that cannot be found (or only part of the way) is not searched for again at once: each failure in a
        // row waits longer before the next try (up to 10 s), so an unreachable spot does not eat the planning budget.
        const reached = enemy.path.length > 0 && enemy.path[enemy.path.length - 1].distanceTo(plan.target) < 0.5
        enemy.planFailStreak = reached ? 0 : enemy.planFailStreak + 1
        enemy.repath = reached ? 1.4 + this.random(enemy) * 0.4 : Math.min(10, 1.4 * 2 ** enemy.planFailStreak)
        if (!enemy.path.length) enemy.pathFailures++
        pending.splice(index, 1)
      } else index++
    }
    // Nobody waiting: up to WARM_BUDGET ms on routes guards will want later (never in exact replays: planningSteps).
    if (!pending.length && !steps && this.warmQueue.length + (this.warming ? 1 : 0) > 0) this.warmRoutes(Math.min(deadline, performance.now() + WARM_BUDGET))
    this.navigationFrameMs = performance.now() - started
    this.navigationMaxFrameMs = Math.max(this.navigationMaxFrameMs, this.navigationFrameMs)
  }

  // ---------------------------------------------------------------- shooting

  /** One round of a burst. Blind rounds go to the last contact and cannot damage: pressure, not punishment. */
  private shoot(enemy: Enemy, player: PlayerSense, blind = false) {
    if (!player.alive) return false
    if (enemy.moveSpeed > 0 || enemy.hitPause > 0 || enemy.actor.reactionRemaining > 0 || this.transitioning(enemy) || enemy.settledFor < COMBAT.settle || (!blind && enemy.aimTime < this.aimDelay(enemy))) return false
    const weapon = WEAPON[enemy.spec.weapon]
    if (enemy.reloadTimer > 0) return false
    if (enemy.magazine <= 0) {
      this.startReload(enemy)
      return false
    }
    // Blocked attempts are not rounds. Do not spend ammunition, burst slots or a full pause.
    enemy.shotTimer = COMBAT.blockedRetry
    // Fresh cone/occlusion checks at the damage event, not the cached perception result.
    if (!blind && !this.sees(enemy, player)) { enemy.canSee = false; enemy.aimTime = 0; enemy.senseTimer = 0; return false }
    const aimAt = blind ? enemy.lastKnown! : player.feet
    const yaw = Math.atan2(aimAt.x - enemy.position.x, aimAt.z - enemy.position.z)
    if (Math.cos(yaw - enemy.yaw) < Math.cos(COMBAT.aimHalfAngle)) return false
    const muzzle = enemy.actor.muzzle()
    // Aim at the chest, which is lower while the player crouches or lies prone.
    const target = aimAt.clone().add(new THREE.Vector3(0, THREE.MathUtils.clamp(bodyHeight(player) * 0.68, 0.25, 1.12), 0))
    // Aim at the exposed head when the torso is hidden by low cover.
    if (!this.context.world.visible(muzzle, target, ignore)) {
      if (blind || !this.context.world.visible(muzzle, player.eye, ignore)) return false
      target.copy(player.eye)
    }
    let distance = muzzle.distanceTo(target)
    direction.copy(target).sub(muzzle).normalize()
    if (this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' && this.bodyHit(other, muzzle, direction, distance))) return false
    // Nor through a hostage: they want him alive. A miss can still find one.
    if (this.context.bystander?.(muzzle, direction, distance) != null) return false
    const round = enemy.burst > 0 ? weapon.burst - enemy.burst : 0
    const recoil = round * 0.025
    const rangePenalty = enemy.spec.weapon === 'sniper' ? 0.004 : enemy.spec.weapon === 'smg' ? 0.017 : enemy.spec.weapon === 'pistol' ? 0.016 : 0.012
    const hitChance = blind ? 0 : clamp(0.72 - distance * rangePenalty - Math.min(0.18, player.velocity.length() * 0.025) - recoil - (enemy.woundArm ? 0.16 : 0) + Math.min(enemy.aimTime, 1.5) * 0.06 + (enemy.spec.boss ? BOSS_RULES.accuracy : 0), 0.08, 0.8 + (enemy.spec.boss ? BOSS_RULES.accuracy : 0))
    const hit = this.random(enemy) < hitChance
    let bodyHit: Pick<PlayerBulletHit, 'region' | 'side' | 'point'> = {
      region: target.y - player.feet.y > bodyHeight(player) * 0.9 ? 'head' : 'torso', side: 0, point: target.clone(),
    }
    if (hit && bodyHit.region !== 'head') {
      const candidate = playerHitTarget(player, this.random(enemy))
      // Never label an occluded limb as struck. Retain the exposed centre/head aim
      // if cover hides the sampled limb, then test the actual segment below.
      if (this.context.world.visible(muzzle, candidate.point, ignore)) {
        target.copy(candidate.point)
        bodyHit = candidate
      }
    }
    if (!hit) target.add(new THREE.Vector3((this.random(enemy) > 0.5 ? 1 : -1) * (0.7 + this.random(enemy) * (blind ? 2 : 1)), 0.2 + this.random(enemy) * (blind ? 1 : 0.6), 0))
    distance = muzzle.distanceTo(target)
    direction.copy(target).sub(muzzle).normalize()
    const range = Math.max(distance + 2, WEAPON_RULES[enemy.spec.weapon].range)
    const surface = this.context.world.raySurface(muzzle, direction, range)
    const obstruction = surface?.distance ?? range
    let hitPlayer = hit && obstruction >= muzzle.distanceTo(target) - 0.05
    const end = muzzle.clone().addScaledVector(direction, hitPlayer ? Math.min(distance, obstruction) : obstruction)
    // Avoid shooting through a friendly body standing across a doorway.
    if (this.enemies.some(other => other !== enemy && other.health > 0 && other.state !== 'reserve' && this.bodyHit(other, muzzle, direction, distance))) return false
    // A stray round (or one that would have reached the player) can find a hostage on its way: he takes it.
    const struck = this.context.bystander?.(muzzle, direction.clone(), muzzle.distanceTo(end), weapon.damage * (enemy.spec.boss ? BOSS_RULES.damage : 1), enemy.spec.weapon) ?? null
    if (struck != null) { hitPlayer = false; end.copy(muzzle).addScaledVector(direction, struck) }
    enemy.burst = (enemy.burst > 0 ? enemy.burst : weapon.burst) - 1
    enemy.shotTimer = enemy.burst > 0 ? weapon.gap : weapon.pause[0] + this.random(enemy) * (weapon.pause[1] - weapon.pause[0])
    enemy.shots++
    enemy.magazine--
    enemy.actor.shoot()
    this.context.onFire?.(this.enemies.indexOf(enemy), end)
    // A guard's muzzle report must reach every player it can engage. The local
    // flyby is additional feedback, not a substitute for hearing the firing gun.
    const reportRange = this.sightRange(enemy, true) + 20
    this.context.emit({ kind: `enemy-shot-${enemy.spec.weapon}`, position: muzzle.clone(), radius: reportRange })
    const near = !hitPlayer && bulletNearMiss(muzzle, end, player.eye)
    const shotDirection = direction.clone()
    const impact = !hitPlayer && struck == null && surface ? () => {
      this.context.emit({ kind: 'impact', position: end.clone(), radius: 18 })
      this.context.onSurfaceHit?.(end, shotDirection, surface, enemy.spec.weapon)
    } : undefined
    this.bulletTrails.emit(muzzle, end, enemy.spec.weapon, near ? { fraction: near.fraction, fire: () => {
      // Sound arrives with the visible round. Recheck the current listener and cover,
      // including a wall alongside the path, not only the original muzzle ray.
      const eye = this.lastPlayer?.eye
      if (!eye || !this.lastPlayer?.alive) return
      const pass = bulletNearMiss(muzzle, end, eye)
      if (pass && this.context.world.visible(pass.point, eye, ignore)) {
        this.context.emit({ kind: 'enemy-bullet-whiz', position: pass.point, source: muzzle.clone(), intensity: pass.intensity, radius: 5 })
      }
    } } : undefined, impact)
    if (hitPlayer) this.context.damagePlayer(weapon.damage * (enemy.spec.boss ? BOSS_RULES.damage : 1), enemy.position.clone(), {
      ...bodyHit, point: end.clone(), direction: direction.clone(), weapon: enemy.spec.weapon,
    }, player.id)
    return true
  }

  hear(event: SoundEvent) {
    if (!event.position || !event.radius || ['callout', 'ambience', 'door'].includes(event.kind)) return
    // A comrade firing: guards within earshot (and not in the fight already) come to back him up.
    if (event.kind.startsWith('enemy-shot')) { this.hearGunfire(event); return }
    if (event.kind === 'grenade-bounce' && event.position) this.dodge(event.position)
    if (event.kind.startsWith('enemy-')) return
    // The suppressed pistol has no flash and a report only the shooter hears: no guard reacts to the shot itself.
    if (event.kind === 'shot-silenced') return
    for (const enemy of this.enemies) {
      if (['dead', 'reserve', 'combat'].includes(enemy.state) || enemy.spec.dummy) continue
      const from = this.eye(enemy)
      const source = event.position.clone().add(new THREE.Vector3(0, 0.5, 0))
      const distance = from.distanceTo(source)
      // A visible muzzle disturbance within plausible view range is noticeable even when a
      // weapon's ordinary sound radius is shorter. It supplies a location, never a confirmed target.
      const shot = event.kind.includes('shot')
      const visibleShot = shot && insideVisionCone(from, enemy.yaw, event.position, this.sightRange(enemy, true)) &&
        this.context.world.visible(from, event.position, ignore)
      // Seeing the muzzle can interrupt a near-miss scan; hearing it through cover cannot.
      if (visibleShot) {
        if (enemy.scanTimer > 0 && this.posture(enemy) === 'crouch') enemy.actor.setPosture?.('crouch', false)
        enemy.contactMemory = COMBAT.contactMemory; enemy.scanTimer = 0; enemy.senseTimer = 0
        enemy.provoked = COMBAT.contactMemory
      }
      else if (enemy.scanTimer > 0) continue
      // Line of sight only decides the band between the muffled and the open radius; most guards are outside both.
      // A gunshot is loud enough to carry well through walls (GUNSHOT_HEARING.muffled).
      const radius = event.radius * (enemy.spec.boss ? BOSS_RULES.hearing : 1)
      const muffled = shot ? GUNSHOT_HEARING.muffled : 0.42
      if (!visibleShot && !audible(distance, radius, distance > radius * muffled && distance <= radius &&
        this.context.world.visible(from, source, ignore), muffled)) continue
      enemy.lastKnown = event.position.clone()
      // Weapon events originate at eye/muzzle height; routes need the surface below that sound.
      const floor = this.context.world.floor(event.position, 0.38, 2.2, 0.1)
      enemy.lastKnown.y = Number.isFinite(floor) ? floor + 0.006 : enemy.position.y
      enemy.lostFor = 0
      enemy.searchKind = 'noise'; enemy.lastHeading = null
      // Running feet are someone who shouldn't be there: he comes at them at a run (suspicion 0.5 and up), weapon up.
      // A gunshot he only heard could be anything: he walks over to check (a sound never counts as a sighting), and
      // stays cautious after.
      const running = event.kind === 'footstep'
      enemy.suspicion = Math.max(enemy.suspicion, running ? 0.7 : 0.25)
      if (shot) enemy.caution = Math.max(enemy.caution, DETECTION.caution.gunshot)
      else if (running) enemy.caution = Math.max(enemy.caution, DETECTION.caution.footsteps)
      this.enter(enemy, 'investigate')
      this.say(enemy, shot ? 'Gunshot! Moving to check it.' : running ? 'Footsteps! Someone\'s running!' : 'Heard something. Have a look.', 'search')
      // A shot heard puts his whole zone on caution, looking toward it.
      if (shot) this.raiseZone(enemy.zone, 'caution', enemy.lastKnown)
      // Shots are passed on by radio: the nearest of his comrades come too.
      if (shot) this.communicate(enemy)
    }
  }

  /**
   * A guard firing (`event` at his muzzle): any guard within GUNSHOT_HEARING of it who is not already fighting comes at
   * a run to back him up, to where the shots are, ready for a fight.
   */
  private hearGunfire(event: SoundEvent) {
    if (event.kind.endsWith('silenced')) return
    const reach = (GUNSHOT_HEARING as Record<string, number>)[event.kind.slice('enemy-shot-'.length)] ?? GUNSHOT_HEARING.ak
    const source = event.position!.clone().add(new THREE.Vector3(0, 0.5, 0))
    for (const enemy of this.enemies) {
      if (['dead', 'reserve', 'combat'].includes(enemy.state) || enemy.spec.dummy || enemy.spec.role === 'sniper') continue
      const from = this.eye(enemy), distance = from.distanceTo(source)
      if (distance < 1 || !audible(distance, reach, this.context.world.visible(from, source, ignore), GUNSHOT_HEARING.muffled)) continue
      const floor = this.context.world.floor(event.position!, 0.38, 2.2, 0.1)
      enemy.lastKnown = event.position!.clone().setY(Number.isFinite(floor) ? floor + 0.006 : enemy.position.y)
      enemy.lostFor = 0
      enemy.searchKind = 'noise'; enemy.lastHeading = null
      enemy.suspicion = Math.max(enemy.suspicion, 0.8)
      enemy.caution = Math.max(enemy.caution, DETECTION.caution.gunshot)
      if (enemy.state === 'investigate') continue
      this.enter(enemy, 'investigate')
      this.say(enemy, 'Shots fired! Moving to support!', 'search')
    }
  }

  /** Nearest animated limb/torso/head capsule along the shot; fake actors without a rig fall back to the upright body capsule. */
  private bodyHit(enemy: Enemy, origin: THREE.Vector3, normalized: THREE.Vector3, maxDistance: number) {
    const volumes = enemy.actor.hitVolumes as EnemyActor['hitVolumes'] | undefined
    if (volumes) {
      // Broad phase around the whole animated body before the per-capsule test, as big as the body (the boss is twice it).
      const size = enemy.actor.root.scale.y || 1
      const center = enemy.position.clone().add(new THREE.Vector3(0, 0.75 * size, 0))
      if (rayCapsuleDistance(origin, normalized, center, center, 1.9 * size) > maxDistance) return null
      const hit = volumes.raycast(origin, normalized, maxDistance)
      return hit && { distance: hit.distance, point: hit.point, zone: hit.zone, bone: hit.bone }
    }
    const distance = rayBodyDistance(origin, normalized, enemy.position)
    return distance <= maxDistance ? { distance, point: origin.clone().addScaledVector(normalized, distance), zone: 'torso' as HitZone, bone: undefined } : null
  }

  private nearestHit(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    let nearest: Enemy | undefined, best: ReturnType<EnemyDirector['bodyHit']> = null
    let distance = maxDistance
    const normalized = direction.clone().normalize()
    for (const enemy of this.enemies) {
      if (enemy.health <= 0 || enemy.state === 'reserve') continue
      const candidate = this.bodyHit(enemy, origin, normalized, distance)
      if (candidate && candidate.distance < distance) { nearest = enemy; best = candidate; distance = candidate.distance }
    }
    return { nearest, best, distance, normalized }
  }

  /** Read-only sight query uses the same animated volumes as damage, bounded by solid cover. */
  aimDistance(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    return this.nearestHit(origin, direction, maxDistance).distance
  }

  /** React to the travelled bullet segment, never its infinite ray or hidden shooter. */
  nearMiss(shot: Shot, maxDistance: number) {
    if (shot.direction.lengthSq() < 1e-8) return 0
    const normalized = shot.direction.clone().normalize()
    const surface = this.context.world.rayDistance(shot.origin, normalized, Math.min(maxDistance, shot.range))
    const { nearest, distance } = this.nearestHit(shot.origin, normalized, surface)
    const ray = new THREE.Ray(shot.origin, normalized)
    let count = 0
    for (const enemy of this.enemies) {
      if (enemy === nearest || enemy.spec.dummy || enemy.health <= 0 || ['dead', 'reserve'].includes(enemy.state) || enemy.scanCooldown > 0 ||
        enemy.hitPause > 0 || enemy.actor.reactionRemaining > 0 || this.transitioning(enemy)) continue
      const bulletPoint = new THREE.Vector3(), bodyPoint = new THREE.Vector3()
      const volumes = enemy.actor.hitVolumes?.volumes() ?? [{ a: enemy.position.clone().add(new THREE.Vector3(0, 0.3, 0)),
        b: enemy.position.clone().add(new THREE.Vector3(0, 1.65, 0)) }]
      let separation = Infinity
      for (const volume of volumes) {
        const bullet = new THREE.Vector3(), body = new THREE.Vector3()
        const candidate = ray.distanceSqToSegment(volume.a, volume.b, bullet, body)
        if (candidate < separation) { separation = candidate; bulletPoint.copy(bullet); bodyPoint.copy(body) }
      }
      const along = bulletPoint.clone().sub(shot.origin).dot(normalized)
      if (separation > 0.95 ** 2 || along < 0.05 || along >= distance ||
        !this.context.world.visible(bodyPoint, bulletPoint, ignore)) continue
      const roll = this.random(enemy)
      let posture: Posture = roll < 1 / 3 ? 'crouch' : roll < 2 / 3 ? 'prone' : 'kneel'
      const threat = enemy.canSee && enemy.lastKnown ? enemy.lastKnown : shot.origin
      const tooClose = Math.hypot(threat.x - enemy.position.x, threat.z - enemy.position.z) < 14
      if (posture === 'prone' && (tooClose || this.protectedPost(enemy)) || !this.postureFits(enemy, posture)) {
        posture = this.postureFits(enemy, 'kneel') ? 'kneel' : 'crouch'
      }
      const engaged = enemy.state === 'combat' || enemy.canSee
      // A missed round supplies its local passage, never a hidden shooter's coordinates.
      // Combatants keep their confirmed contact and existing reaction/burst timing.
      if (!engaged) {
        enemy.lastKnown = bulletPoint.clone().setY(enemy.position.y)
        enemy.suspicion = Math.max(enemy.suspicion, 0.45)
        enemy.lostFor = 0
        this.enter(enemy, 'suspicious')
      }
      enemy.scanDuration = 1.95 + this.random(enemy) * 0.15
      enemy.scanTimer = engaged ? 0 : enemy.scanDuration
      enemy.defensiveTimer = posture === 'prone' ? 7 + this.random(enemy) * 1.5 : posture === 'kneel' ? 4.5 : engaged ? 2.8 : enemy.scanDuration
      enemy.scanCooldown = Math.max(6, enemy.defensiveTimer + 5)
      enemy.scanYaw = Math.atan2(bulletPoint.x - enemy.position.x, bulletPoint.z - enemy.position.z)
      enemy.settledFor = 0
      enemy.moveSpeed = 0
      enemy.path = []; enemy.pathTarget = null; this.plans.delete(enemy)
      enemy.actor.setPosture?.(posture, !engaged && posture === 'crouch')
      enemy.actor.root.userData.alertScan = !engaged && posture === 'crouch' ? 0 : undefined
      count++
    }
    return count
  }

  /** Limit authored shotgun travel to clear, level floor before a wall or platform edge. */
  private shotgunTravel(enemy: Enemy, shotDirection: THREE.Vector3) {
    const forward = shotDirection.clone().setY(0)
    if (forward.lengthSq() < 1e-8) return 0
    forward.normalize()
    let distance = 0
    // The hips travel 1.72 m; reserve another 0.8 m for the falling torso beyond them.
    for (let step = 1; step <= 26; step++) {
      const travel = step / 26 * 2.53
      const point = enemy.position.clone().addScaledVector(forward, travel)
      let clear = true
      for (const side of [-0.4, 0, 0.4]) {
        const sample = point.clone().add(new THREE.Vector3(forward.z * side, 0, -forward.x * side))
        const floor = this.context.world.floor(sample, 0.16, 0.26)
        if (!Number.isFinite(floor) || Math.abs(floor - enemy.position.y) > 0.13) { clear = false; break }
      }
      const low = point.clone().add(new THREE.Vector3(0, 0.43, 0))
      if (!clear || !this.context.world.fits(new Capsule(low, low.clone().add(new THREE.Vector3(0, 1.1, 0)), 0.4))) break
      distance = travel
    }
    return clamp((distance - 0.8 + 1e-8) / 1.73, 0, 1)
  }

  /** The guard and body part a shot strikes, without applying it. Co-op guests report this to the host. */
  findHit(shot: Shot, maxDistance: number) {
    const { nearest, best, normalized } = this.nearestHit(shot.origin, shot.direction, Math.min(maxDistance, shot.range))
    if (!nearest || !best) return null
    return { index: this.enemies.indexOf(nearest), zone: best.zone, point: best.point, bone: best.bone, distance: best.distance, direction: normalized }
  }

  hit(shot: Shot, maxDistance: number) {
    const found = this.findHit(shot, maxDistance)
    return found ? this.applyHit(shot, found) : false
  }

  /** `explosive`: a frag blast, which is never critical and throws the dead back like buckshot. */
  applyHit(shot: Shot, found: NonNullable<ReturnType<EnemyDirector['findHit']>>, explosive = false) {
    const nearest = this.enemies[found.index]
    if (!nearest || nearest.health <= 0 || nearest.state === 'reserve' || nearest.state === 'dead') return false
    const best = found, normalized = found.direction
    const falloff = shot.weapon === 'shotgun' ? shotgunDamageMultiplier(best.distance) : 1
    const fromBehind = normalized.x * Math.sin(nearest.yaw) + normalized.z * Math.cos(nearest.yaw) > 0.25
    const boss = !!nearest.spec.boss
    // A head shot can blow the head apart, by weapon (see HEAD_BURST_CHANCE); that always kills. Not the boss's.
    // A helmet (ZONES.adapt) stops one head shot (not a sniper's round, a blade or a blast): it is knocked off and he
    // is only stunned.
    const helmeted = nearest.helmet && best.zone === 'head' && !explosive && shot.weapon !== 'sniper' && shot.weapon !== 'knife'
    if (helmeted) {
      nearest.helmet = false
      nearest.actor.loseHelmet?.()
      this.context.emit({ kind: 'impact', position: best.point.clone(), radius: 18 })
    }
    const burstChance = best.zone === 'head' && !boss && !helmeted ? HEAD_BURST_CHANCE[shot.weapon ?? 'ak'] ?? 0 : 0
    const headBurst = burstChance >= 1 || (burstChance > 0 && this.random(nearest) < burstChance)
    const critChance = this.context.criticals && !headBurst && !explosive ? criticalChance(shot.weapon, best.zone) : 0
    const critical = critChance > 0 && this.random(nearest) < critChance
    // A blade in the back always kills, except the boss.
    let damage = helmeted ? Math.min(ZONES.adapt.helmetDamage, nearest.health - 1)
      : headBurst || shot.weapon === 'knife' && fromBehind && !boss ? nearest.health
      : hitDamage(shot.weapon, best.zone, shot.damage, boss) * falloff * (critical ? CRITICAL_HITS.multiplier : 1)
    // Armour soaks body hits until it breaks; only a little of the hit gets through. Head shots ignore it.
    let armorBroken = false, soaked = 0
    // The boss's plate covers him all round; it sheds a piece at a time as it wears down.
    if (nearest.armor > 0 && best.zone !== 'head' && !headBurst) {
      // A blast gets round plate: armour takes only half of it.
      soaked = Math.min(nearest.armor, explosive ? damage * 0.5 : damage)
      nearest.armor -= soaked
      damage = damage - soaked + soaked * BOSS_RULES.bleed
      nearest.actor.armorLeft?.(nearest.armor / (nearest.spec.armor || 1))
      if (nearest.armor <= 0) { armorBroken = true; nearest.actor.breakArmor?.() }
    }
    const before = nearest.health
    nearest.health = Math.max(0, nearest.health - damage)
    nearest.contactMemory = COMBAT.contactMemory
    nearest.suspicion = 1; nearest.provoked = COMBAT.contactMemory
    nearest.canSee = false
    nearest.senseTimer = 0
    const lethal = nearest.health === 0
    const reaction: HitReaction = { zone: best.zone, point: best.point, direction: normalized, lethal, bone: best.bone, weapon: shot.weapon, targetId: nearest.spec.id, by: shot.by, headBurst,
      // The whole hit, even past the health that was left: a kill shows how hard it landed.
      damage: Math.max(before - nearest.health, damage), armorDamage: soaked, critical, armorBroken }
    nearest.scanTimer = 0
    nearest.actor.root.userData.alertScan = undefined
    const clip = explosive ? lethal ? 'dieShotgun' : 'flinchBody' : reactionClipName(reaction, fromBehind)
    const travel = lethal && (shot.weapon === 'shotgun' || explosive) ? this.shotgunTravel(nearest, normalized) : 1
    // The boss shrugs off ordinary hits; only a critical one, a blast or losing his armour staggers him.
    const staggers = !boss || lethal || critical || armorBroken || explosive
    if (staggers) nearest.actor.react(clip, lethal, normalized, travel)
    if (!lethal && staggers) { nearest.hitPause = nearest.actor.reactionRemaining || 0.6; nearest.settledFor = 0; nearest.moveSpeed = 0 }
    if (lethal) nearest.deathClip = nearest.actor.deathClip
    if (headBurst) { nearest.headless = true; nearest.actor.burstHead?.() }
    this.context.onHit?.(reaction)
    this.context.onReact?.({ index: found.index, clip, lethal, direction: tuple(normalized), travel, deathClip: nearest.deathClip,
      hit: { zone: best.zone, point: tuple(best.point), bone: best.bone, weapon: shot.weapon, by: shot.by, ...(headBurst ? { burst: true } : {}),
        damage: reaction.damage, critical, armorBroken } })
    this.context.emit({ kind: 'enemy-hit', position: best.point.clone(), radius: 14, zone: best.zone })
    this.context.emit({ kind: 'enemy-pain', position: nearest.position.clone().add(eyeOffset), radius: 38, speaker: nearest.speaker, zone: best.zone })
    if (lethal) {
      this.enter(nearest, 'dead')
      nearest.actor.update(0, 'dead', false)
      this.context.emit({ kind: 'enemy-down', position: nearest.position.clone(), radius: 5 })
      if (!nearest.dropped) {
        nearest.dropped = true
        // His gun with what is left in it and what he carried; a sniper rifle holds one magazine and no more.
        const sniper = nearest.spec.weapon === 'sniper'
        this.context.dropWeapon({ id: `enemy-${nearest.spec.id}`, name: nearest.spec.weapon,
          magazine: sniper ? WEAPON_RULES.sniper.capacity : nearest.magazine,
          reserve: sniper ? 0 : nearest.reserve, position: tuple(nearest.position) })
      }
      // A witness knows the body location. Only a visible muzzle identifies the shooter. Nobody mourns a training target.
      for (const ally of nearest.spec.dummy ? [] : this.enemies) {
        if (ally === nearest || ally.spec.dummy || ['dead', 'reserve', 'combat'].includes(ally.state) || ally.position.distanceTo(nearest.position) > 18) continue
        const body = nearest.position.clone().add(new THREE.Vector3(0, 0.9, 0))
        if (!this.context.world.visible(this.eye(ally), body, ignore)) continue
        // A knife or suppressed kill makes no report: only a guard actually looking at the body notices it.
        if ((shot.weapon === 'knife' || shot.weapon === 'silenced') && !insideVisionCone(this.eye(ally), ally.yaw, body, 18)) continue
        const eye = this.eye(ally)
        const sawShooter = insideVisionCone(eye, ally.yaw, shot.origin, this.sightRange(ally, true)) && this.context.world.visible(eye, shot.origin, ignore)
        ally.lastKnown = sawShooter ? shot.origin.clone().setY(this.lastPlayer?.feet.y ?? ally.position.y) : nearest.position.clone()
        if (sawShooter) { ally.contactMemory = COMBAT.contactMemory; ally.provoked = COMBAT.contactMemory }
        ally.suspicion = Math.max(ally.suspicion, 0.8)
        ally.lostFor = 0
        this.enter(ally, 'investigate')
        this.say(ally, 'Man down! Man down!', 'down', true)
      }
    } else if (nearest.spec.dummy) {
      nearest.hitPause = 0
    } else {
      if (best.zone === 'arm') nearest.woundArm = true
      if (best.zone === 'leg') nearest.woundLeg = true
      nearest.lastKnown = shot.origin.clone().setY(this.lastPlayer?.feet.y ?? nearest.position.y)
      nearest.suspicion = 1
      nearest.lostFor = 0
      // A hit supplies the disturbance location; confirmation still needs the actual cone and LOS.
      const shooter = this.players.find(player => player.id === shot.by) ?? this.lastPlayer
      const seesShooter = shooter ? this.sees(nearest, shooter) : false
      if (seesShooter) nearest.targetId = shooter?.id
      this.enter(nearest, seesShooter ? 'combat' : 'investigate')
      if (nearest.state === 'combat') { nearest.shotTimer = Math.max(nearest.shotTimer, COMBAT.aimDelay); nearest.tacticTimer = COMBAT.openingHold }
      else nearest.suppress = 1.4
      this.say(nearest, 'I am hit!', 'hurt')
    }
    return true
  }

  activateReserves(radioEnabled: boolean, destination: THREE.Vector3) {
    this.reserveDestination = destination.clone()
    let remaining = radioEnabled ? 4 : 2
    for (const enemy of this.enemies) {
      if (enemy.state !== 'reserve' || enemy.spec.held || remaining-- <= 0) continue
      enemy.actor.root.visible = true
      enemy.reserveRoute = true
      enemy.waypoint = 0
      enemy.wait = 0.6 * (radioEnabled ? 4 - remaining : 2 - remaining)
      this.enter(enemy, 'patrol')
      this.say(enemy, 'Inspection detail, check the signal.', 'search', true)
    }
  }

  /** A camera report is a place to investigate, never personal visual confirmation. */
  respondToAlarm(destination: THREE.Vector3, reserveCount = 0, notifyPatrols = true) {
    let activated = 0
    for (const enemy of this.enemies) {
      if (enemy.health <= 0 || enemy.state === 'dead') continue
      if (enemy.state === 'reserve') {
        if (activated >= reserveCount || enemy.spec.held) continue
        activated++
        enemy.actor.root.visible = true
        enemy.reserveRoute = false
        enemy.post = new THREE.Vector3(...enemy.spec.position)
        enemy.alarmExit = enemy.spec.alarmExit ? new THREE.Vector3(...enemy.spec.alarmExit) : null
      } else if (!notifyPatrols || enemy.position.y < -1 || enemy.state === 'combat' || enemy.canSee) continue
      enemy.alarmResponse = true
      enemy.lastKnown = destination.clone()
      enemy.lostFor = 0
      enemy.suspicion = Math.max(enemy.suspicion, 0.6)
      this.enter(enemy, 'investigate')
      this.say(enemy, 'Alarm! Check the reported position.', 'search')
    }
    return activated
  }

  silenceAlarm() {
    for (const enemy of this.enemies) {
      if (!enemy.alarmResponse || ['dead', 'reserve'].includes(enemy.state)) continue
      enemy.alarmResponse = false
      enemy.alarmExit = null
      // Silencing the panel cannot make a soldier forget a player still in sight.
      if (enemy.canSee || enemy.state === 'combat') continue
      this.enter(enemy, 'search')
    }
  }

  // ---------------------------------------------------------------- co-op replication

  /** What co-op guests need to draw each guard, without its decision state. */
  puppets(): EnemyPuppet[] {
    const r = (value: number) => Math.round(value * 1000) / 1000
    return this.enemies.map(enemy => ({
      p: [r(enemy.position.x), r(enemy.position.y), r(enemy.position.z)], y: r(enemy.yaw), s: enemy.state, v: r(enemy.moveSpeed),
      a: enemy.canSee && enemy.lastKnown ? [r(enemy.lastKnown.x), r(enemy.lastKnown.y + 1.65), r(enemy.lastKnown.z)] : null,
      o: this.posture(enemy), c: typeof enemy.actor.root.userData.alertScan === 'number' ? r(enemy.actor.root.userData.alertScan) : null, d: enemy.deathClip,
      ...(enemy.headless ? { h: true } : {}),
    }))
  }

  /** Co-op guests follow the host's guards instead of thinking. Positions ease between the host's updates. */
  follow(dt: number, puppets: EnemyPuppet[] | null) {
    if (!this.loaded || this.disposed) return
    this.bulletTrails.update(dt)
    const blend = 1 - Math.exp(-12 * Math.max(0, dt))
    this.enemies.forEach((enemy, index) => {
      const puppet = puppets?.[index]
      if (puppet) {
        const target = point.fromArray(puppet.p)
        if (enemy.position.distanceTo(target) > 4) enemy.position.copy(target)
        else enemy.position.lerp(target, blend)
        enemy.yaw += Math.atan2(Math.sin(puppet.y - enemy.yaw), Math.cos(puppet.y - enemy.yaw)) * blend
        if (puppet.s === 'dead' && enemy.state !== 'dead') { enemy.deathClip = puppet.d; enemy.actor.deathClip = puppet.d }
        if (puppet.h && !enemy.headless) { enemy.headless = true; enemy.actor.burstHead?.() }
        enemy.state = puppet.s
        enemy.health = puppet.s === 'dead' ? 0 : ENEMY_HEALTH
        enemy.moveSpeed = puppet.v
        if (puppet.o !== this.posture(enemy) && !this.transitioning(enemy) && enemy.actor.reactionRemaining <= 0) enemy.actor.setPosture?.(puppet.o)
        enemy.actor.root.userData.alertScan = puppet.c ?? undefined
      }
      enemy.actor.root.visible = enemy.state !== 'reserve'
      if (enemy.state === 'reserve') return
      enemy.actor.root.position.copy(enemy.position)
      enemy.actor.root.rotation.y = enemy.yaw
      if (enemy.state === 'dead') { enemy.actor.update(dt, 'dead', false); return }
      enemy.actor.update(dt, enemy.state, enemy.moveSpeed > 0, puppet?.a ? aimPoint.fromArray(puppet.a) : undefined, enemy.moveSpeed)
    })
  }

  /** Co-op guests replay the host's hit reaction on the same guard, and get the blood/audio description back. */
  replayReaction(reaction: EnemyReaction): HitReaction | null {
    const enemy = this.enemies[reaction.index]
    if (!enemy) return null
    const direction = new THREE.Vector3(...reaction.direction)
    enemy.actor.root.userData.alertScan = undefined
    enemy.actor.react(reaction.clip, reaction.lethal, direction, reaction.travel)
    if (reaction.lethal) {
      enemy.state = 'dead'; enemy.health = 0; enemy.deathClip = reaction.deathClip
      enemy.actor.update(0, 'dead', false)
    }
    if (reaction.hit.burst) { enemy.headless = true; enemy.actor.burstHead?.() }
    return { zone: reaction.hit.zone, point: new THREE.Vector3(...reaction.hit.point), direction, lethal: reaction.lethal,
      bone: reaction.hit.bone as HitReaction['bone'], weapon: reaction.hit.weapon, targetId: enemy.spec.id, by: reaction.hit.by, headBurst: !!reaction.hit.burst }
  }

  /** Co-op guests replay a guard's shot: recoil, muzzle flash and tracer. Returns the muzzle for sound and near-miss checks. */
  replayFire(index: number, end: THREE.Vector3) {
    const enemy = this.enemies[index]
    if (!enemy || enemy.state === 'dead' || enemy.state === 'reserve') return null
    enemy.actor.shoot()
    const muzzle = enemy.actor.muzzle()
    this.bulletTrails.emit(muzzle, end, enemy.spec.weapon)
    return muzzle
  }

  snapshot(): EnemySnapshot[] {
    return this.enemies.map(enemy => ({
      id: enemy.spec.id, position: tuple(enemy.position), yaw: enemy.yaw, health: enemy.health,
      state: enemy.state, suspicion: enemy.suspicion, lastKnown: enemy.lastKnown ? tuple(enemy.lastKnown) : null,
      timer: enemy.timer, waypoint: enemy.waypoint, path: enemy.path.map(tuple), pathTarget: enemy.pathTarget ? tuple(enemy.pathTarget) : null, planning: this.plans.has(enemy),
      ...Object.fromEntries(NUMBERS.map(field => [field, enemy[field]])),
      random: enemy.random, dropped: enemy.dropped, reserveRoute: enemy.reserveRoute, alarmResponse: enemy.alarmResponse,
      alarmExit: enemy.alarmExit ? tuple(enemy.alarmExit) : null, post: enemy.post ? tuple(enemy.post) : null,
      canSee: enemy.canSee, tactic: enemy.tactic, tacticPoint: enemy.tacticPoint ? tuple(enemy.tacticPoint) : null,
      searchPoints: enemy.searchPoints.map(tuple), searchLooks: enemy.searchLooks.map(look => look ? tuple(look) : null), woundArm: enemy.woundArm, woundLeg: enemy.woundLeg, deathClip: enemy.deathClip,
      headless: enemy.headless, noticedBodies: [...enemy.noticedBodies],
      lastHeading: enemy.lastHeading ? tuple(enemy.lastHeading) : null, searchKind: enemy.searchKind,
      dodgePoint: enemy.dodgePoint ? tuple(enemy.dodgePoint) : null, sentry: enemy.sentry, helmet: enemy.helmet, buddy: enemy.buddy?.spec.id ?? null,
      watch: enemy.watch ? tuple(enemy.watch) : null, sector: enemy.sector ? tuple(enemy.sector) : null, screen: enemy.screen,
      zones: this.zones.snapshot(),
      actorPosture: enemy.actor.postureSnapshot?.(),
      animationTime: enemy.actor.animationTime, elapsed: this.elapsed, reserveDestination: this.reserveDestination ? tuple(this.reserveDestination) : null,
    }))
  }

  restore(snapshot: EnemySnapshot[]) {
    this.plans.clear()
    this.flashlights?.clear()
    this.navigationFrameMs = this.navigationMaxFrameMs = 0
    this.clearTraces()
    this.lastPlayer = null
    for (const saved of snapshot) {
      const enemy = this.enemies.find(candidate => candidate.spec.id === saved.id)
      if (!enemy) continue
      enemy.position.fromArray(saved.position)
      enemy.yaw = saved.yaw; enemy.health = saved.health; enemy.state = saved.state
      enemy.suspicion = saved.suspicion; enemy.lastKnown = vector(saved.lastKnown)
      enemy.timer = saved.timer; enemy.waypoint = saved.waypoint
      enemy.path = Array.isArray(saved.path) ? saved.path.map(vector).filter((point): point is THREE.Vector3 => !!point) : []
      enemy.pathTarget = vector(saved.pathTarget)
      if (saved.planning && enemy.pathTarget) this.plans.set(enemy, { target: enemy.pathTarget.clone(), job: this.navigation.createPlan(enemy.position, enemy.pathTarget) })
      enemy.post = vector(saved.post)
      for (const field of NUMBERS) enemy[field] = number(saved[field])
      enemy.random = number(saved.random, 7391)
      // Older checkpoints recorded the water marksman as a fixed guard.
      if (enemy.spec.patrolMode === 'perimeter' && saved.patrolStop === undefined) {
        this.nextPatrolStop(enemy, enemy.waypoint)
        if (enemy.state === 'guard' && !enemy.post) enemy.state = 'patrol'
      }
      enemy.canSee = !!saved.canSee; enemy.dropped = !!saved.dropped; enemy.reserveRoute = !!saved.reserveRoute
      enemy.alarmResponse = !!saved.alarmResponse
      enemy.alarmExit = vector(saved.alarmExit)
      enemy.tactic = typeof saved.tactic === 'string' && ['hold', 'cover', 'peek', 'flank', 'charge', 'retreat'].includes(saved.tactic) ? saved.tactic as Tactic : 'hold'
      enemy.tacticPoint = vector(saved.tacticPoint)
      enemy.searchPoints = Array.isArray(saved.searchPoints) ? saved.searchPoints.map(vector).filter((point): point is THREE.Vector3 => !!point) : []
      enemy.searchLooks = enemy.searchPoints.map((_, i) => Array.isArray(saved.searchLooks) ? vector(saved.searchLooks[i]) : null)
      enemy.noticedBodies = Array.isArray(saved.noticedBodies) ? saved.noticedBodies.filter((id): id is string => typeof id === 'string') : []
      enemy.lastHeading = vector(saved.lastHeading)
      enemy.dodgePoint = vector(saved.dodgePoint)
      enemy.sentry = !!saved.sentry
      enemy.buddy = typeof saved.buddy === 'string' ? this.enemies.find(other => other.spec.id === saved.buddy) ?? null : null
      enemy.helmet = !!saved.helmet
      if (enemy.helmet) enemy.actor.wearHelmet?.(); else enemy.actor.loseHelmet?.()
      enemy.watch = vector(saved.watch); enemy.sector = vector(saved.sector); enemy.screen = !!saved.screen
      enemy.searchKind = typeof saved.searchKind === 'string' && saved.searchKind in DETECTION.search ? saved.searchKind as SearchKind : 'noise'
      enemy.woundArm = !!saved.woundArm; enemy.woundLeg = !!saved.woundLeg
      enemy.deathClip = typeof saved.deathClip === 'string' ? saved.deathClip : 'dieBody'
      enemy.actor.root.position.copy(enemy.position)
      enemy.actor.root.rotation.y = enemy.yaw
      enemy.actor.root.visible = enemy.state !== 'reserve'
      enemy.actor.restore(enemy.state, number(saved.animationTime), enemy.deathClip, saved.actorPosture as ActorPostureSnapshot | undefined)
      enemy.headless = enemy.state === 'dead' && !!saved.headless
      if (enemy.headless) enemy.actor.burstHead?.()
      if (enemy.spec.armor) enemy.actor.armorLeft?.(enemy.armor / enemy.spec.armor, true)
      if (enemy.spec.armor && enemy.armor <= 0) enemy.actor.breakArmor?.(true)
      enemy.actor.root.userData.alertScan = enemy.scanTimer > 0 && enemy.scanDuration > 0 && this.posture(enemy) !== 'prone' && this.posture(enemy) !== 'kneel' ? 1 - enemy.scanTimer / enemy.scanDuration : undefined
      this.elapsed = number(saved.elapsed)
      this.reserveDestination = vector(saved.reserveDestination)
    }
    // The zones' phases and clocks (each entry carries them; older checkpoints without them start calm).
    this.zones.restore(snapshot.find(saved => Array.isArray(saved.zones))?.zones as ZoneSnapshot | undefined)
    // The ground samples and routes stay good: only doors change them, and restored doors are noticed here.
    this.navigation.syncDoors()
  }

  private clearTraces() {
    this.bulletTrails.clear()
  }

  dispose() {
    this.disposed = true
    this.plans.clear()
    this.warmQueue = []; this.warming = null
    this.flashlights?.dispose()
    this.clearTraces()
    this.bulletTrails.dispose()
    this.enemies.forEach(enemy => enemy.actor.dispose())
    this.enemies.length = 0
    this.navigation.clear()
  }
}
