import type { HitZone } from './hit-reactions'
import type { WeaponItem, WeaponName } from './types'
import { GAIT_SPEED } from '../lab/gait'

// Faster mission running, with stride/cadence adaptation shared with the lab.
export const ENEMY_RUN_SPEED = GAIT_SPEED.run * 1.5
export const HOSTAGE_RUN_SPEED = 2.6
/**
 * Hostages (the compound's and every level's prisoners) can be hurt: by guards' stray rounds, by your own bullets,
 * knife and grenades, and by charges. `health` is what each starts with; a head hit counts `head` times. If one dies
 * the mission is lost. Guards hold fire rather than shoot through a hostage at you; their misses can still hit one.
 */
export const HOSTAGE = { health: 100, head: 3 } as const

/** Ordinary jumps and drops up to about 2.3 m are safe; taller falls scale with impact energy. */
export function fallDamage(landingSpeed: number) {
  if (!Number.isFinite(landingSpeed) || landingSpeed <= 10) return 0
  return Math.min(100, (landingSpeed * landingSpeed - 100) * 0.3)
}

/** Call of Duty-style player health: every enemy bullet removes a quarter, so the fourth hit is lethal.
 * Each bullet hit grants a second of bullet immunity, so a burst cannot land all four at once.
 * After a short pause without damage, health refills to full. Landings keep energy-based damage. */
/**
 * Aim steadiness, in radians. Sway is a slow drift of the crosshair (shots follow it): small standing still,
 * growing with speed, smaller crouched, smallest prone, and reduced while aiming down the sights. Spread is a
 * random cone added while moving or in the air, scaled by the same stance factors. Every weapon uses these.
 */
export const AIM_STEADINESS = {
  sway: { stand: 0.003, crouch: 0.0017, prone: 0.0007, perSpeed: 0.0015, airborne: 0.004 },
  spread: { perSpeed: 0.0035, airborne: 0.03, unscopedSniper: 0.02 },
  /** Firing without aiming: a base cone per weapon, plus bloom that builds with each hip shot and settles when you stop. */
  hip: { pistol: 0.008, silenced: 0.008, smg: 0.011, ak: 0.012 } as Partial<Record<WeaponName, number>>,
  bloom: { perShot: 0.0045, max: 0.02, settleDelay: 0.3, recoveryPerSecond: 0.06 },
  stance: { stand: 1, crouch: 0.6, prone: 0.35 },
  aimed: 0.6,
} as const

/**
 * How fast you move with each thing in your hands, CS-style: the knife is fastest, then each weapon is slower the
 * bigger it is, down to the sniper rifle at about half. Walking and sprinting both scale; you can sprint while aiming,
 * at `aimed` of that.
 */
export const MOVE_SPEED = {
  weapon: { knife: 1, grenade: 0.98, pistol: 0.95, silenced: 0.95, smg: 0.9, shotgun: 0.8, ak: 0.75, sniper: 0.55 } as Record<WeaponName | 'grenade', number>,
  aimed: 0.85,
} as const

/** Aiming stops a sprint: with right click held (or the sniper's scope up) you walk at most. */
export const canSprint = (aiming: boolean) => !aiming
/** Weapons whose aim is a toggle, like a sniper scope: right click raises it and leaves it up until you click again. */
export const TOGGLE_AIM: readonly string[] = ['sniper']
export const aimToggles = (weapon?: string | null) => !!weapon && TOGGLE_AIM.includes(weapon)

/**
 * Guards never hear walking (or sneaking) feet; sprinting carries this far in the open, in metres (through a wall,
 * about 0.42 of it: see ai.ts audible). A guard who hears running comes at it fast, ready to fight.
 */
export const SPRINT_FOOTSTEP_RADIUS = 16

export const PLAYER_HEALTH = { max: 100, bulletHits: 4, bulletImmunity: 1, regenDelay: 5, regenPerSecond: 40 } as const
export const PLAYER_BULLET_DAMAGE = PLAYER_HEALTH.max / PLAYER_HEALTH.bulletHits

// No armor or damage immunity: every confirmed hit applies this damage immediately.
export const ENEMY_HEALTH = 100
export const HIT_MULTIPLIERS: Record<HitZone, number> = { head: 2.2, torso: 1, arm: 0.6, leg: 0.7 }
export const WEAPON_RULES = {
  pistol: { label: 'Pistol', capacity: 12, reload: 1.85, interval: 0.25, range: 110, damage: 30, automatic: false, kick: 0.03, settle: 0.55 },
  ak: { label: 'AK rifle', capacity: 30, reload: 2.3, interval: 0.12, range: 170, damage: 34, automatic: true, kick: 0.022, settle: 0.6 },
  smg: { label: 'SMG', capacity: 24, reload: 2.05, interval: 0.085, range: 100, damage: 24, automatic: true, kick: 0.012, settle: 0.65 },
  shotgun: { label: 'Pump shotgun', capacity: 6, reload: 0.65, interval: 0.9, range: 32, damage: 28, automatic: false, kick: 0.11, settle: 0.84 },
  sniper: { label: 'Sniper rifle', capacity: 5, reload: 2.9, interval: 1.35, range: 220, damage: 65, automatic: false, kick: 0.048, settle: 0.85 },
  silenced: { label: 'Silenced pistol', capacity: 12, reload: 1.85, interval: 0.25, range: 110, damage: 30, automatic: false, kick: 0.024, settle: 0.55 },
  // Melee: no magazine, range is arm's reach, and the attack itself is timed by KNIFE below.
  knife: { label: 'Combat knife', capacity: 0, reload: 0, interval: 0.45, range: 1.7, damage: 40, automatic: false, kick: 0, settle: 0 },
} as const

/** Left click slashes, right click stabs. Any knife hit from behind is lethal, as in Counter-Strike. */
export const KNIFE = {
  range: 1.7,
  slash: { damage: 40, interval: 0.45, duration: 0.34, hitAt: 0.11 },
  stab: { damage: 90, interval: 1.0, duration: 0.72, hitAt: 0.23 },
} as const
export type KnifeAttack = 'slash' | 'stab'

/** Aiming down the sights magnifies the view; the sniper uses its adjustable scope instead. */
export const AIM_ZOOM: Partial<Record<WeaponName, number>> = { pistol: 1.25, silenced: 1.25, smg: 1.5, ak: 2 }
/** How far the shooter's own client plays a suppressed report. Guards never hear it (see EnemyDirector.hear). */
export const SILENCED_REPORT_RADIUS = 5

export const ENEMY_WEAPONS = {
  pistol: { magazine: 12, reload: 1.9, damage: 10, burst: 3, gap: 0.2, pause: [0.65, 0.95] },
  ak: { magazine: 30, reload: 2.4, damage: 9, burst: 4, gap: 0.11, pause: [0.55, 0.85] },
  smg: { magazine: 24, reload: 2.1, damage: 7, burst: 5, gap: 0.08, pause: [0.5, 0.75] },
  shotgun: { magazine: 6, reload: 3.9, damage: 14, burst: 1, gap: 0.9, pause: [1.2, 1.6] },
  sniper: { magazine: 5, reload: 2.9, damage: 32, burst: 1, gap: 1.35, pause: [2.0, 2.6] },
} as const

/**
 * Guards' ammunition: a full magazine and `spare` more on them. Out of everything, a guard runs to the nearest supply
 * crate still standing and restocks there (so blowing the crates up starves them); with none left he takes cover and
 * stops shooting. You can restock at the crates too: each gun's spare ammunition back up to `player` magazines.
 * A sniper rifle taken from a guard holds one magazine and nothing more.
 */
/**
 * Ammunition, in magazines counting the one in the gun. The player carries at most `player` of any gun (also what a
 * crate refills to, and the most a gun picked up off the floor brings); guards carry `enemy` and restock at the supply
 * crates when they run dry (with none left, they draw their knives). A gun lying about the level holds one magazine.
 * `supplyReach`: how close to a crate a guard must be to restock (m).
 */
export const AMMO = { player: 2, enemy: 4, supplyReach: 1.3 } as const
/** The most rounds the player may carry for a gun of `capacity`, the loaded magazine included. */
export const playerAmmoCap = (capacity: number) => capacity * AMMO.player

/** Chance a player's head shot blows the guard's head apart (always lethal). Other weapons never do. */
export const HEAD_BURST_CHANCE: Partial<Record<WeaponName, number>> = { pistol: 0.1, silenced: 0.1, smg: 0.1, ak: 0.25, sniper: 1 }

/**
 * Critical hits, which only the tutorial turns on: the chance a hit is critical by weapon (a head shot doubles it),
 * and how much harder a critical hit lands.
 */
export const CRITICAL_HITS = { chance: { pistol: 0.12, silenced: 0.12, smg: 0.08, ak: 0.1, shotgun: 0.05, sniper: 0.25, knife: 0.15 } as Record<WeaponName, number>, headBonus: 2, multiplier: 1.75 } as const
export const criticalChance = (weapon: WeaponName | undefined, zone: HitZone) =>
  Math.min(1, (CRITICAL_HITS.chance[weapon ?? 'ak'] ?? 0) * (zone === 'head' ? CRITICAL_HITS.headBonus : 1))

/**
 * Bulky Boy: a giant black riot breacher in an ink-grey helmet, plate vest and pouches, who fights with an AK like
 * his guards (`damage` times their rounds). His gear is his armour: while it holds it soaks body hits from any side
 * and only `bleed` of the damage reaches him; the pouches are shot off at two thirds, the helmet at one third, the
 * vest when it breaks. Head shots go straight through. Sniper rounds hit him for `sniper` times their damage instead
 * of killing outright. He is a better shot than his guards: `accuracy` is added to their hit chance, and he takes
 * `aimDelay` of their aiming time before his first round.
 */
export const BOSS_RULES = { health: 1150, armor: 800, bleed: 0.3, sniper: 2.2, speed: 0.9, scale: 2.05, damage: 1.6, accuracy: 0.12, aimDelay: 0.5,
  /** He hears this many times further than a guard, and in a fight he walks at you until he is this close (m), firing as he comes. */
  hearing: 2.2, closeIn: 7 } as const

/** Player sniper rounds are lethal on any confirmed hit (the boss excepted). */
export function hitDamage(weapon: WeaponName | undefined, zone: HitZone, baseDamage: number, boss = false) {
  if (weapon === 'sniper' && boss) return Math.max(0, baseDamage) * HIT_MULTIPLIERS[zone] * BOSS_RULES.sniper
  if (weapon === 'sniper') return ENEMY_HEALTH
  return Math.max(0, baseDamage) * HIT_MULTIPLIERS[zone]
}

/** Responsive combat: reaction runs alongside weapon presentation, never after it. */
/**
 * How guards spot you. A soldier sees `soldier` m while calm and `engaged` m once he has seen you; a sniper sees
 * `sniper` of the level's longest side (no less than `sniperMin`, no more than `sniperMax`). A guard who spots you is
 * not sure at first: a yellow ? over him fills for `notice` seconds while he keeps you in view, then he is alerted
 * (a red !) and fights. Inside `pointBlank` m, or already hunting you (suspicion `hunting` and up: he heard you run,
 * was shot at), he is alerted at once and fires almost straight away. Out of view, the ? drains `forget` times as
 * fast as it filled. Guards within `squadLink` m of each other (and `squadRise` m in height) form a squad, unless the
 * level names squads (EnemySpec.squad): one alerted, the whole squad is, and they share where you are.
 */
export const DETECTION = {
  soldier: 45, engaged: 70, sniper: 0.5, sniperMin: 110, sniperMax: 220,
  notice: 3, pointBlank: 8, hunting: 0.7, forget: 0.5, quickShot: 0.3,
  /** How fast the ? fills against someone low: crouched 20% slower, prone half as fast. */
  stance: { crouch: 0.8, prone: 0.5 },
  squadLink: 28, squadRise: 7,
  /** How close each kind of fighter pushes in before he plants himself: shotguns rush right in, SMGs to mid range. */
  closeIn: { shotgun: 5, smg: 9, other: 9 },
  /** How far out riflemen take their flanking positions (m from where you were), and how far round to the side (degrees). */
  flank: { distance: [16, 26] as const, angle: 75 },
  /** The field of view, all of it (degrees): calm, and in a fight (when a soldier is turning his head about). */
  fov: 120, fovCombat: 140,
  /**
   * How fast the ? fills by where you are in his view (after Hitman and Metal Gear): full speed within `full` degrees
   * of straight ahead and within `near` metres; at the edge of his view `edge` as fast, at the end of his sight
   * `far` as fast.
   */
  peripheral: { full: 30, edge: 0.55 }, distance: { near: 22, far: 0.5 },
  /**
   * Caution (after Metal Gear's caution phase): after a body, a gunshot, losing you or running feet, a guard stays
   * jumpy for this many seconds, and his ? fills `rate` times as fast.
   */
  caution: { body: 90, gunshot: 60, lost: 60, footsteps: 20, rate: 1.5 },
  /** How far off a body on the ground is seen (m): far further than a person standing still in the shadows. */
  bodySight: 25,
  /**
   * Searches, by what started them: how far out the places he checks are (m from the centre), how many, and how long
   * the whole search may take (s). Hiding places (out of his view) first; a lost contact first where you were heading.
   */
  search: {
    noise: { reach: [2.5, 6] as const, points: 3, time: 11 },
    lost: { reach: [3, 9] as const, points: 4, time: 16 },
    body: { reach: [4, 14] as const, points: 5, time: 26 },
    /** A search team's sweep out from where the trouble was, along its own slice of the compass (ZONES.sweep). */
    sweep: { reach: [7, 26] as const, points: 4, time: 50 },
  },
} as const

/**
 * Zones (game/zones.ts), after Metal Gear Solid V's outposts: each building and its yard is an area with its own
 * alert phase, and the areas warn each other by radio.
 *
 * `yard`: how far round a building its zone reaches (m); `join`: buildings this close (m) are one zone. `reach`: a guard
 * posted this far outside every zone still belongs to the nearest. `lost`: an alert with no one seeing you for this
 * long becomes a search. `time`: how long a search and a caution last (s). `shout`: without the radio, only zones this
 * close (edge to edge, m) hear of trouble. `screen`: how many of a cautious zone's guards go to cover the side the
 * trouble is on, and how far inside the zone's edge they stand (m). `watch`: how long a cautious guard stops and looks
 * toward the trouble (s, at random between). `team`: guards per search team; `keep`: guards of a searching zone who stay
 * at their posts; `sweep.spread`: how wide each team's slice of the compass is (degrees; how far out and for how long:
 * DETECTION.search.sweep). `reinforce`: how many guards the nearest
 * cautious zone sends to a zone on alert, if it is within `reinforceReach` m. `radio`: see below.
 */
export const ZONES = {
  yard: 9, join: 3, reach: 40, lost: 8, shout: 45,
  time: { search: 75, caution: 150 },
  screen: { guards: 2, inset: 3 },
  watch: [4, 7] as const,
  team: 2, keep: 1,
  sweep: { spread: 50 },
  reinforce: 2, reinforceReach: 110,
  /**
   * The radio (after MGS5's command post): each zone's operator calls a check-in every `interval` seconds (at random
   * between); a guard who does not answer (dead) is reported missing, the zone goes on caution and the nearest calm
   * man goes to his post to look. A zone whose operator is dead, or whose radio sets are all out, has no radio.
   */
  radio: { interval: [70, 110] as const },
  /**
   * Districts (ZoneSpec.district): an alerted guard keeps within `margin` m of his district; he fights you only while
   * you are within `engage` m of it (or you shoot at him). Help comes only from the same district.
   */
  district: { margin: 1.5, engage: 8 },
  /**
   * The garrison adapts (after MGS5): each time a zone stands down from an alert or a search, the more often it has
   * been hit (`heat`), the more it changes. From `sentry` on, a man is posted where you were first seen, watching the
   * way you came (up to `sentries`); from `pairs`, its patrols walk in twos (the second `buddy` m behind); from `helmets`,
   * its men wear helmets, each of which stops one head shot (a sniper's round goes through), leaving `helmetDamage`.
   */
  adapt: { sentry: 1, sentries: 2, pairs: 2, buddy: 1.6, helmets: 3, helmetDamage: 15 },
} as const

/**
 * Squad roles in a fight (after Metal Gear Solid V's soldiers).
 *
 * `suppress`: when you duck out of sight, one man of the squad (the one holding with the most rounds) keeps firing at
 * where you were for `time` seconds (from `after` s after losing you, out to `range` m): blind rounds, pressure only,
 * while the others move. `grenade`: a man with a frag (`carry` each, rifles and SMGs) lobs it at where you went to
 * ground if you have been out of sight `after` to `until` seconds, `near` to `far` m off, with no comrade within
 * `clear` m of it; his squad then waits `cooldown` s before the next. `dodge`: a guard within `radius` m of a grenade
 * landing runs `distance` m from it. `fallBack`: once a squad has lost as many men as it has left, a wounded man (under
 * `health`) falls back to cover away from you and his zone calls for help again (at most every `call` s). `overwatch`:
 * a sniper who sees you radios your position every `every` s to the men hunting you within `reach` m. `knife`: below.
 */
export const COMBAT_ROLES = {
  suppress: { after: 0.6, time: 6, range: 45 },
  grenade: { carry: 1, after: 2.5, until: 14, near: 8, far: 28, clear: 7, cooldown: 25 },
  dodge: { radius: 6, distance: 8, time: 2.5 },
  fallBack: { health: 70, call: 30 },
  overwatch: { every: 3, reach: 120 },
  /**
   * Out of every round with no crate left, a guard draws his knife and comes for you: he stabs within `reach` m,
   * every `every` s, the blade landing `windup` s into the stab for `damage`.
   */
  knife: { reach: 1.6, every: 1.1, windup: 0.24, damage: 34 },
} as const

/**
 * How far an unsilenced gunshot carries to the guards (m), in the open; through walls `muffled` as far. The suppressed
 * pistol is never heard (see EnemyDirector.hear). Guards hear each other's gunfire too, and come to help.
 */
export const GUNSHOT_HEARING = { pistol: 60, ak: 75, smg: 70, shotgun: 75, sniper: 90, muffled: 0.55 } as const

export const ENEMY_COMBAT = {
  passiveRange: 20,
  sniperPassiveRange: 28,
  engagedRange: 60,
  sniperEngagedRange: 110,
  contactMemory: 8,
  senseIdle: 0.1,
  senseCombat: 0.05,
  settle: 0.16,
  aimHalfAngle: 12 * Math.PI / 180,
  turnSpeed: 7.5,
  aimDelay: 0.8,
  reaction: [0.8, 1.0],
  sniperReaction: [0.9, 1.1],
  openingHold: 1.75,
  blockedRetry: 0.05,
  blockedReposition: 0.3,
} as const

export const SHOTGUN_PELLETS = 8
// Buckshot fans out from the muzzle: about 1.57 m across at 10 m, 3.15 m at 20 m. Aiming does
// not change the barrel/choke, so ADS uses the same cone as hip fire.
export const SHOTGUN_BALLISTICS = { halfAngle: 4.5 * Math.PI / 180, fullDamageRange: 8, minimumDamageScale: 0.4 } as const

/** Pattern density does most of the range balancing; individual pellets also lose energy. */
export function shotgunDamageMultiplier(distance: number) {
  const travel = Math.max(0, Math.min(1, (distance - SHOTGUN_BALLISTICS.fullDamageRange) /
    (WEAPON_RULES.shotgun.range - SHOTGUN_BALLISTICS.fullDamageRange)))
  return 1 - travel * (1 - SHOTGUN_BALLISTICS.minimumDamageScale)
}

/** Three slots, one weapon each: 1 knife, 2 sidearm (a pistol or an SMG), 3 primary (an AK, sniper rifle or shotgun). */
export const WEAPON_SLOTS = 3
export const WEAPON_SLOT: Record<WeaponName, number> = { knife: 0, pistol: 1, silenced: 1, smg: 1, ak: 2, sniper: 2, shotgun: 2 }
export const SNIPER_ZOOM = { min: 2, max: 8, initial: 4 } as const
/** Missions start with the knife out. */
export const STARTING_SLOT = 0
export function startingLoadout(): (WeaponItem | null)[] {
  return [
    { id: 'player-knife', name: 'knife', magazine: 0, reserve: 0 },
    { id: 'player-silenced', name: 'silenced', magazine: 12, reserve: 12 },
    null,
  ]
}

/**
 * Counter-Strike grenades. You carry at most one frag, two flashbangs and one smoke (`carry`). Hold left click to
 * pull the pin and let go for a full overhand throw; right click lobs it underhand; both together throw medium.
 * Nothing cooks: a frag or flash goes off `fuse` seconds after it leaves the hand, a smoke once it comes to rest.
 * Grenades bounce off walls (`bounce` keeps that much of the speed into the wall, `friction` along it) and roll to a stop.
 * - frag: full `damage` within `full` metres, falling off to nothing at `radius`; walls shelter you. It hurts you too.
 * - flash: anyone with a clear line to it is blinded. Facing it from within `near` metres blinds for `blind`
 *   seconds, then the white fades over `fade`; looking away or standing far off cuts both down, to nothing past `range`.
 * - smoke: a cloud `radius` metres across its widest, centred `rise` above where it lies, that grows for `grow`
 *   seconds, hides everything inside and behind it for `last` seconds, and thins away over `fade`.
 */
export type GrenadeKind = 'frag' | 'flash' | 'smoke'
export const GRENADE_RULES = {
  order: ['frag', 'flash', 'smoke'] as const,
  carry: { frag: 1, flash: 2, smoke: 1 } as Record<GrenadeKind, number>,
  label: { frag: 'Frag grenade', flash: 'Flashbang', smoke: 'Smoke grenade' } as Record<GrenadeKind, string>,
  throw: { full: 19, medium: 13, lob: 7.5, inherit: 0.6, gravity: 12, radius: 0.06, bounce: 0.42, friction: 0.72, roll: 5.5 },
  /** Seconds: the pin coming out, the throwing swing (the grenade leaves at `release`), and drawing the next one. */
  timing: { draw: 0.4, pin: 0.28, swing: 0.34, release: 0.11, next: 0.45 },
  fuse: { frag: 1.6, flash: 1.6, smoke: 3.5 } as Record<GrenadeKind, number>,
  frag: { radius: 10.5, full: 2.5, damage: 170, hearing: 90 },
  flash: { near: 8, range: 32, blind: 4.2, fade: 2.6, hearing: 55 },
  smoke: { settle: 0.35, radius: 3.9, rise: 1.6, grow: 1.4, last: 18, fade: 2.5, hearing: 14 },
} as const

/** Frag damage at `distance` metres from the blast, before walls. */
export function fragDamage(distance: number) {
  const { radius, full, damage } = GRENADE_RULES.frag
  if (!(distance < radius)) return 0
  return damage * Math.min(1, 1 - (distance - full) / (radius - full))
}

/**
 * How badly a flashbang blinds someone, from 0 (not at all) to 1 (full): `angle` is between where they look and the
 * flash (radians), `distance` how far it is. Seconds blind and seconds of fade are this times `blind` and `fade`.
 */
export function flashStrength(angle: number, distance: number) {
  const { near, range } = GRENADE_RULES.flash
  if (!(distance < range)) return 0
  const facing = angle <= 0.95 ? 1 : angle >= 2.6 ? 0.1 : 1 - 0.9 * (angle - 0.95) / (2.6 - 0.95)
  const far = distance <= near ? 1 : 1 - 0.75 * (distance - near) / (range - near)
  return facing * far
}
