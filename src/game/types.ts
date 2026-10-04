import type * as THREE from 'three'
import type { CollisionWorld } from '../player/collision'

export type Vec3 = [number, number, number]
export type WeaponName = 'pistol' | 'ak' | 'smg' | 'shotgun' | 'sniper' | 'silenced' | 'knife'
/** Guards carry firearms only; the knife and suppressed pistol are the player's kit. */
export type GuardWeapon = Exclude<WeaponName, 'silenced' | 'knife'>
/** `stand` is the yaw an upright pickup faces, leaning back against a wall; without it a pickup lies flat. */
export type WeaponItem = { id: string; name: WeaponName; magazine: number; reserve: number; position?: Vec3; stand?: number }
export type SoundEvent = { kind: string; position?: THREE.Vector3; source?: THREE.Vector3; intensity?: number; radius?: number; text?: string; voice?: string; speaker?: number; weapon?: WeaponName; zone?: import('./hit-reactions').HitZone }
export type EmitSound = (event: SoundEvent) => void
export type StationKind = 'radio' | 'release' | 'brake' | 'signal' | 'extract' | 'supply' | 'distraction' | 'hostage' | 'cameras' | 'alarm' | 'gate' | 'jeep' | 'rally' | 'objective'
export type Station = { id: string; kind: StationKind; object: THREE.Object3D; point: THREE.Vector3; label: string }
export type EnemySpec = { id: string; name: string; position: Vec3; patrol: Vec3[]; weapon: GuardWeapon; reserve?: boolean; alarmExit?: Vec3; facing?: number; role?: 'sniper' | 'guard'; patrolMode?: 'perimeter'
  /** A training target: it never sees, moves or fights, only takes hits. */
  dummy?: boolean
  /** Comes back this many seconds after dying (training targets). */
  respawn?: number
  /** Starting health (default ENEMY_HEALTH). */
  health?: number
  /** Armour soaks body hits until it breaks (see BOSS_RULES); head shots go straight through. */
  armor?: number
  /** The armoured brute: huge, slow, immune to instant kills. */
  boss?: boolean
  /** A boss body modelled with Rodin (game/boss-models.ts) worn in place of the stickman. */
  look?: import('./boss-models').BossLook
  /** Starts in reserve and only a script wakes it (never the alarm). */
  held?: boolean
  /** The squad he belongs to: alerted together, they hunt you together. Without it, guards near each other form one (DETECTION.squadLink). */
  squad?: string
  /** The zone (game/zones.ts) he belongs to, by id. Without it, the zone his post is in or nearest to. */
  zone?: string
  /** Frag grenades he carries (default COMBAT_ROLES.grenade.carry for rifles and SMGs, none otherwise). */
  grenades?: number
  /** He carries his zone's radio (its operator). Without it, the guard nearest the zone's radio set, or its middle. */
  radio?: boolean }
/**
 * The mission on a level: where the player starts, who is there, what can be used, and what has to be done.
 * `level` is the level's id (levels/catalog.ts): saves are kept under it. `goals` are the mission's objectives
 * (game/goals.ts); the compound's rescue predates them and runs on `rescue` instead. `briefing` is what the pause
 * page shows about this mission.
 */
export type MissionWorld = { level: string; root: THREE.Group; stations: Station[]; enemies: EnemySpec[]; spawn: Vec3; lookAt: Vec3
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; tutorial?: boolean
  goals?: import('./goals').GoalSpec[]
  briefing?: Briefing
  /**
   * The level's areas, each with its own alert phase (game/zones.ts). Without them, one per building and its yard, and
   * one round each squad posted out in the open.
   */
  zones?: import('./zones').ZoneSpec[]
  /** Prisoners held on the level, freed by using a station (game/captives.ts). */
  captives?: CaptiveSpec[]
  /** Timed charges: picked up at one station, planted at another, then they go off (game/charges.ts). */
  charges?: ChargeSpec[]
  rescue?: { gate: THREE.Group; jeep: THREE.Group; cameras: { id: string; pivot: THREE.Group; lamp: THREE.Mesh }[]; cellDoors: THREE.Group[] } }
/**
 * A timed charge, like CS's bomb: taken at `pickup` (a collectible 'objective' station), planted at `plant` (holding
 * still for `plantTime` seconds), then it ticks for `fuse` seconds and goes off at `blast.center`: lethal within
 * `blast.lethal` m, hurting out to `blast.radius`. It hides the objects named in `destroys` and shows `wreck`.
 */
export type ChargeSpec = { id: string; name: string; pickup: string; plant: string; fuse: number; plantTime: number
  blast: { center: Vec3; radius: number; lethal: number }; destroys: string[]; wreck?: string }
/** A prisoner: where he sits (on a chair the level places there), which way he faces, and the station that frees him. */
export type CaptiveSpec = { id: string; name?: string; position: Vec3; facing: number; station: string }
/**
 * The mission's page in the menu. `premise` is the line under the title before play; `won` and `outro` the title
 * and line once the mission is complete; `tips` the route tips. `map` is the field map's SVG; without it one is drawn from the level's
 * buildings, stations and goal areas (game/field-map.ts).
 */
export type Briefing = { title: string; premise: string; won: string; outro: string; tips: string[]; map?: string; legend?: string[] }
/** `id` names a co-op player; solo play leaves it unset. */
export type PlayerSense = { feet: THREE.Vector3; eye: THREE.Vector3; velocity: THREE.Vector3; alive: boolean; radioEnabled: boolean; yaw?: number; id?: number }
export type Shot = { origin: THREE.Vector3; direction: THREE.Vector3; range: number; damage: number; weapon?: WeaponName; pelletIndex?: number; by?: number }
export type MeleeAttack = { origin: THREE.Vector3; direction: THREE.Vector3; damage: number; kind: import('./balance').KnifeAttack }
export type WeaponContext = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; world: CollisionWorld; emit: EmitSound; onShot: (shot: Shot) => void; onMelee?: (attack: MeleeAttack) => void; aimDistance?: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => number }
export type WeaponFrame = { active: boolean; climbing: boolean; moving: number; aiming: boolean; reducedMotion: boolean; feet: THREE.Vector3; hitPose?: import('./player-hit-reactions').PlayerHitPose; aimOffset?: import('./aim').AimOffset; spread?: number }
export type WeaponSnapshot = { slots: (WeaponItem | null)[]; selected: number; pickups: WeaponItem[]; nextId: number }
export type EnemyState = 'idle' | 'patrol' | 'guard' | 'suspicious' | 'investigate' | 'combat' | 'search' | 'dead' | 'reserve'
export type EnemySnapshot = { id: string; position: Vec3; yaw: number; health: number; state: EnemyState; suspicion: number; lastKnown: Vec3 | null; timer: number; waypoint: number; [key: string]: unknown }
export type AIContext = { scene: THREE.Scene; world: CollisionWorld; doors: THREE.Group[]; specs: EnemySpec[]; emit: EmitSound; damagePlayer: (amount: number, source: THREE.Vector3, hit?: import('./player-hit-reactions').PlayerBulletHit, playerId?: number) => void; dropWeapon: (item: WeaponItem) => void; onHit?: (hit: import('./hit-reactions').HitReaction) => void; onReact?: (reaction: EnemyReaction) => void; onFire?: (index: number, end: THREE.Vector3) => void; onSurfaceHit?: (point: THREE.Vector3, direction: THREE.Vector3, surface?: import('../player/collision').SurfaceHit, weapon?: WeaponName) => void
  /**
   * A hostage along a guard's round, within `reach` m: returns how far along he is, or null. With `damage` the round
   * hits him (the runtime hurts him); without, it only asks, so the guard can hold fire rather than shoot through him.
   */
  bystander?: (from: THREE.Vector3, direction: THREE.Vector3, reach: number, damage?: number, weapon?: WeaponName) => number | null
  /** The supply crates still standing, where a guard out of ammunition restocks: an id and the floor point by it. */
  supplies?: () => { id: string; position: THREE.Vector3 }[]
  /** The level's longest side (m): a sniper sees half of it (DETECTION.sniper). */
  mapSpan?: number
  /** Critical hits are on (the tutorial): see CRITICAL_HITS. */
  criticals?: boolean
  /** The level's authored zones (MissionWorld.zones); without them the director makes them from the buildings. */
  zones?: import('./zones').ZoneSpec[]
  /** The field radio sets on the level and whether each still works (game/radios.ts): a zone's sets carry its radio. */
  radioSets?: () => { id: string; position: THREE.Vector3; live: boolean }[]
  /** A guard throws a grenade (game/grenades.ts throwFrom): from `origin`, at `velocity`. */
  throwGrenade?: (kind: 'frag', origin: THREE.Vector3, velocity: THREE.Vector3) => void
  /** A zone's radio has gone silent (its operator killed, its sets out): it can no longer warn the others. */
  onRadioLost?: (zone: string) => void
  /**
   * Route planning normally gets 3 ms of each frame, so how far it gets depends on the machine. Checks that replay a
   * run exactly (checkpoint restores) give it this many planning steps a frame instead, which is the same everywhere.
   */
  planningSteps?: number }
/** A guard's hit reaction, as the host tells co-op guests to replay it. */
export type EnemyReaction = { index: number; clip: string; lethal: boolean; direction: Vec3; travel: number; deathClip: string; hit: { zone: import('./hit-reactions').HitZone; point: Vec3; bone?: string; weapon?: WeaponName; by?: number; burst?: boolean; damage?: number; critical?: boolean; armorBroken?: boolean } }
/** A guard as co-op guests draw it: position, facing, behaviour and pose, without the decision state. */
export type EnemyPuppet = { p: Vec3; y: number; s: EnemyState; v: number; a: Vec3 | null; o: import('../lab/postures').Posture; c: number | null; d: string; h?: true }
