import * as THREE from 'three'
import { lightBurst, type BurstOptions } from '../render/neon'
import { Lamps } from './lamps'
import { AlarmBeacons } from './beacons'
import { BulletTrails, bulletNearMiss } from './bullet-trails'
import { GRENADE_RULES, HOSTAGE, KNIFE, MOVE_SPEED, fragDamage, aimToggles, canSprint, PLAYER_BULLET_DAMAGE, PLAYER_HEALTH, SPRINT_FOOTSTEP_RADIUS, fallDamage } from './balance'
import type { EnvironmentCamera } from '../camera'
import type { FirstPersonController } from '../player/controller'
import type { ActionTarget } from '../player/actions'
import { isDoorFullyOpen, setDoorOpen } from '../world/doors'
import { EnemyDirector } from './ai'
import { FirstPersonWeapons } from './weapons'
import { Grenades, type GrenadeSnapshot } from './grenades'
import { MissionAudio } from './audio'
import { MissionHUD } from './hud'
import { MissionBlood, type BloodSnapshot } from './hit-reactions'
import { MissionImpacts } from './impacts'
import { CRATE_RULES, QuestCrates } from './crates'
import { MissionIntro } from './mission-intro'
import { deleteSave, finishCampaignMission, readCampaign, readSave, setNextRun, startCampaign, takeRun, writeSave, type RunKind } from './saves'
import { FIRST_LEVEL, campaignLevels, levelInfo } from '../levels/catalog'
import { goTo } from '../modes'
import { goalHint, goalObjectives, goalsComplete, goalUnlocked, updateGoals, type GoalSense } from './goals'
import { missionObjectives } from './objectives'
import { QuestRadios, RADIO_RULES } from './radios'
import { TUTORIAL_FEEDBACK, TutorialMode } from './tutorial'
import { PlayerHitReactions, type PlayerBulletHit } from './player-hit-reactions'
import { PlayerDeathSequence } from './player-death'
import { EscapeCinematic } from './escape-cinematic'
import { EscapeDust } from './escape-dust'
import { advanceMission, applySharedMission, missionObjective, completeEscape, damageMission, sharedMission, shootMission, initialMission, hurtHostage, loadedCount, radioOut, stationLabel, useStation, type MissionState } from './mission'
import { HostageEscort } from './hostages'
import { Captives } from './captives'
import { hostageAlong, hostagesNear, type HostageBody } from './hostage-harm'
import type { HostageActor } from './hostage-actor'
import { BossTags } from './boss-tags'
import { StatusTags } from './status-tags'
import { Charges } from './charges'
import { SecuritySystem } from './security'
import { RESCUE_LAYOUT } from './rescue-layout'
import { updateRescueJeepDoor } from './rescue-jeep'
import { Teammates } from './teammates'
import { AimSteadiness, offsetDirection } from './aim'
import { PlayerLean } from './lean'
import { CoopPanel } from './coop-panel'
import { CoopSession } from '../net/session'
import type { CoopMessage, NetSound, PlayerPose } from '../net/hub'
import type { EnemyPuppet, EnemySnapshot, MeleeAttack, MissionWorld, PlayerSense, Shot, SoundEvent, Station, StationKind, Vec3, WeaponItem, WeaponName, WeaponSnapshot } from './types'

/** `doors` holds 0 for closed, or the side an open leaf swung to (1 / -1). Older saves used booleans. */
/** Scroll distance for one weapon change, and the shortest gap between changes. */
const WHEEL_NOTCH = 40, WHEEL_REPEAT_MS = 140
/** A save to load once its level has been built, when Load game picked another level's save. */
const PENDING_LOAD = 'stickman-load-level'

type Checkpoint = { mission: MissionState; weapons: WeaponSnapshot; enemies: EnemySnapshot[]; doors: (number | boolean)[]; position: Vec3; quaternion: [number,number,number,number]; blood?: BloodSnapshot; grenades?: GrenadeSnapshot }

/** A gun's muzzle flash as light: warm, close, gone in a blink, without shadows (see lightBurst). */
const MUZZLE_FLASH: BurstOptions = { color: 0xffc77a, intensity: 16, range: 6.5, life: 0.07, hold: 0.02 }
const MUZZLE_SILENCED: BurstOptions = { color: 0xffd9a0, intensity: 3, range: 2.5, life: 0.05, hold: 0.01 }

export class MissionRuntime {
  state: MissionState
  readonly weapons: FirstPersonWeapons
  /** Frag, flash and smoke grenades: key 4, thrown with the mouse (see grenades.ts). */
  readonly grenades: Grenades
  readonly ai: EnemyDirector
  readonly audio = new MissionAudio()
  readonly blood: MissionBlood
  readonly impacts: MissionImpacts
  readonly crates: QuestCrates
  private intro = new MissionIntro()
  /** Set on load and by every checkpoint restore or restart; the next time play begins, the intro runs. */
  private introPending = true
  private wasPlaying = false
  readonly radios: QuestRadios
  /** Ceiling lamps a bullet can break (MissionState.lampsOut). */
  readonly lamps: Lamps
  /** Red rotating lights on the roofs round the alarm, sweeping while it sounds. */
  readonly beacons: AlarmBeacons
  /** The tutorial level's coach, damage numbers and boss bar; null in the mission. */
  readonly tutorial: TutorialMode | null
  readonly bulletTrails: BulletTrails
  readonly playerHits = new PlayerHitReactions()
  readonly death = new PlayerDeathSequence()
  readonly escape = new EscapeCinematic()
  readonly escapeDust: EscapeDust
  readonly hud: MissionHUD
  /** The hostage and his escort: only on a level with a rescue. */
  readonly escort: HostageEscort | null
  /** Prisoners a level holds, freed at their stations; null on a level without any. */
  readonly captives: Captives | null
  /** Health and armour over a boss's head, in missions (training has its own boss bar). */
  private bossTags: BossTags | null
  private statusTags: StatusTags | null
  /** The level's timed charges (C4); null on a level without any. */
  readonly charges: Charges | null
  readonly security: SecuritySystem
  readonly teammates: Teammates
  readonly coop: CoopSession
  private coopPanel: CoopPanel
  private poseTimer = 0
  /** Scroll accumulated toward the next weapon change; trackpads send many small deltas per notch. */
  private wheelTravel = 0
  private wheelSwitchedAt = 0
  private steadiness = new AimSteadiness()
  private lean = new PlayerLean()
  /** Q and E held down: lean left and right. */
  private leanKeys = new Set<string>()
  private worldTimer = 0
  /** Host: the latest pose of every other player. */
  private remote = new Map<number, PlayerPose>()
  /** Guest: the host's latest guards and hostage mood, and when they arrived. */
  private hostEnemies: EnemyPuppet[] | null = null
  private hostCower = false
  private lastWorldAt = 0
  private waitingNotice = 0
  /** Guest: doors this player just used keep their local state until the host has heard about it. */
  private doorHold = new Map<number, number>()
  ready = false
  readonly initialized: Promise<void>
  deaths = 0
  // Opt-in protection for staged checks; normal play always starts vulnerable.
  invincible = false
  private abort = new AbortController()
  private checkpoint: Checkpoint | null = null
  private initial: Checkpoint | null = null
  private active = false
  private aiming = false
  /** How this level was entered: from the campaign (saves, leads on), as a free mission, or neither (see RunKind). */
  private run: RunKind | null = null
  /** The campaign's next mission once this one is won (null after the last). */
  private nextLevel: string | null = null
  /** This run's win has been handled (campaign progress, the next-mission offer). */
  private won = false
  /** Right click is down (aiming holds while it is, except with a toggled scope). */
  private rightHeld = false
  /** Until when (performance.now) the frames keep running after a hostage is killed, so he is seen to fall. */
  private failingUntil = 0
  private stepTime = 0
  private interactionTime = 0
  private lastCaption = ''
  private lastCaptionAt = -100
  private wasVR = false
  private safePosition = new THREE.Vector3()
  private safeQuaternion = new THREE.Quaternion()
  private hitFlash = 0
  private impactPoint: THREE.Vector3 | null = null
  private disposed = false
  private gunfireUntil = 0

  constructor(private scene: THREE.Scene, private camera: EnvironmentCamera,
    readonly player: FirstPersonController, readonly world: MissionWorld, private invalidate: () => void) {
    this.state = initialMission(world.rescue ? RESCUE_LAYOUT.hostageSpawns : [])
    player.missionMode = true
    player.canPlay = () => this.ready && this.state.phase === 'active' && !this.escape.active
    if (!camera.perspective.parent) scene.add(camera.perspective)
    this.weapons = new FirstPersonWeapons({ scene, camera: camera.perspective, world: player.world,
      aimDistance: (origin, direction, maxDistance) => this.ai.aimDistance(origin, direction, maxDistance),
      emit: event => this.emit(event, true), onShot: shot => this.shot(shot), onMelee: attack => this.melee(attack) })
    this.blood = new MissionBlood(scene, player.world, id => {
      const enemy = this.ai?.enemies.find(candidate => candidate.spec.id === id)
      if (!enemy || enemy.state !== 'dead' || enemy.deathClip !== 'dieShotgun') return null
      return enemy.actor.rig.bones.chest.getWorldPosition(new THREE.Vector3())
    })
    this.impacts = new MissionImpacts(scene, player.world)
    this.crates = new QuestCrates(scene, event => this.audio.play(event))
    this.radios = new QuestRadios(scene, event => this.audio.play(event))
    const alarm = world.stations.find(station => station.kind === 'alarm')
    this.beacons = new AlarmBeacons(scene, alarm?.point ?? null)
    this.lamps = new Lamps(scene, point => { const floor = player.world.floor(point, 0.5, 8); return Number.isFinite(floor) ? floor : point.y - 2.5 })
    this.bulletTrails = new BulletTrails(scene, 'Player bullet')
    this.escapeDust = new EscapeDust(scene)
    player.lookSensitivity = () => this.weapons.lookSensitivity
    // CS-style: the knife is fastest, a sniper rifle about half; aiming slows you a little and stops a sprint.
    player.canSprint = () => canSprint(this.aiming && this.weapons.canAim && !this.grenades?.equipped)
    player.speedScale = () => {
      const held = this.grenades?.equipped ? 'grenade' : this.weapons.current?.name ?? 'knife'
      return MOVE_SPEED.weapon[held] * (this.aiming && this.weapons.canAim && !this.grenades?.equipped ? MOVE_SPEED.aimed : 1)
    }
    this.grenades = new Grenades({ scene, camera: camera.perspective, world: player.world, emit: event => this.emit(event, true),
      // A guest's guards are the host's puppets; only solo play and the host hurt and blind them.
      // (The AI is called first: `this.tutorial?.grenade(..., this.ai.blast(...))` skipped it outside training.)
      blast: origin => {
        if (this.role === 'guest') return
        const hits = this.ai.blast(origin, this.coop.active ? this.coop.hub.selfId : undefined)
        this.tutorial?.grenade('frag', hits)
        this.blastQuestItems(origin, GRENADE_RULES.frag.radius * 0.45)
        this.blastHostages(origin, GRENADE_RULES.frag.radius, fragDamage)
      },
      flash: origin => {
        if (this.role === 'guest') return
        const blinded = this.ai.flash(origin)
        this.tutorial?.grenade('flash', blinded)
      },
      damagePlayer: (amount, origin) => this.damage(amount, origin),
      onFlashed: seconds => this.audio.play({ kind: 'flash-ring', intensity: seconds }),
      onEmpty: () => this.invalidate() })
    // Training never runs out of grenades.
    this.grenades.endless = !!world.tutorial
    this.ai = new EnemyDirector({ scene, world: player.world, doors: player.actions.doors, specs: world.enemies,
      emit: event => this.emit(event, false), damagePlayer: (amount, source, hit, playerId) => this.damageFromGuard(amount, source, hit, playerId),
      supplies: () => this.crates.standing(),
      mapSpan: Math.max(world.bounds.maxX - world.bounds.minX, world.bounds.maxZ - world.bounds.minZ), zones: world.zones,
      throwGrenade: (kind, origin, velocity) => { if (this.role !== 'guest') this.grenades.throwFrom(kind, origin, velocity) },
      onRadioLost: zone => { if (this.state.phase === 'active') this.hud.notify(`${zone}: radio silent. They can't call for help.`, 4, true) },
      radioSets: () => [...this.radios.radios.keys()].map(id => ({ id, position: this.radios.center(id)!, live: !radioOut(this.state, id) })),
      bystander: (from, direction, reach, damage, weapon) => {
        const hostage = hostageAlong(this.hostageBodies(), from, direction, reach)
        if (hostage && damage) this.harmHostage(hostage.body, damage, hostage.head, hostage.point, direction, weapon)
        return hostage?.distance ?? null
      },
      onSurfaceHit: (point, direction, surface, weapon) => this.impacts.emit(point, direction, surface, weapon),
      dropWeapon: item => { this.weapons.addPickup(item); this.state.kills++; if (this.role === 'host') this.coop.send({ t: 'drop', item }) }, onHit: hit => {
        this.impactPoint = hit.point.clone(); this.blood.emitHit(hit)
        if (hit.by === undefined || hit.by === this.coop.hub.selfId) { this.audio.confirmHit(hit); this.tutorial?.hit(hit) }
      },
      criticals: !!world.tutorial && TUTORIAL_FEEDBACK.criticals,
      onReact: reaction => { if (this.role === 'host') this.coop.send({ t: 'ereact', r: reaction }) },
      onFire: (index, end) => { if (this.role === 'host') this.coop.send({ t: 'efire', i: index, end: end.toArray() as Vec3 }) } })
    this.hud = new MissionHUD(world, {
      // The mission starts over; training picks up at its last checkpoint (the boss line, once Bulky Boy is awake).
      retry: () => { if (this.coop.active) this.respawn(); else if (this.tutorial) this.retry(); else this.restart(); void this.audio.unlock(); this.player.requestControl() },
      restart: () => {
        // In co-op the host restarts everyone; a guest's own restart only returns them to the insertion point.
        if (this.role !== 'guest') this.restart()
        else if (this.state.phase === 'complete') this.hud.notify('The host starts the next run.', 4)
        else this.respawn()
        void this.audio.unlock(); this.player.requestControl()
      },
      volume: value => this.audio.setVolume(value), mute: value => this.audio.setMuted(value),
      load: level => this.loadSaved(level),
      newGame: () => { startCampaign(); this.enterLevel('campaign', FIRST_LEVEL) },
      continueGame: () => this.continueCampaign(),
      freeMission: level => this.enterLevel('free', level),
      nextMission: () => { if (this.nextLevel) this.enterLevel(this.run === 'free' ? 'free' : 'campaign', this.nextLevel) },
      objectives: () => this.objectiveList(),
      leaveWarning: () => {
        const room = this.coop.active ? ` You will leave co-op room ${this.coop.room}.` : ''
        // Leaving the tutorial loses nothing worth asking about.
        if (this.state.phase === 'active' && this.state.elapsed > 0 && this.saved) {
          // Solo progress is kept: leaving saves it, and Load mission picks it up again.
          if (!this.coop.active && this.saveProgress()) return 'Your mission progress is saved. Load game on the Campaign page picks it up again.'
          return `Your mission progress will be lost.${room}`
        }
        return room ? room.trim() : null
      } })
    // The level's goals drive the objectives when it has any; the compound's rescue has its own.
    const goals = world.goals
    const totals = { crates: this.crates.crates.size, radios: [...this.radios.radios.keys()] }
    this.hud.setObjectiveSource(goals
      ? { list: state => goalObjectives(state, goals, this.goalSense()), hint: state => goalHint(state, goals) }
      : { list: state => missionObjectives(state, totals), hint: missionObjective })
    this.ai.obscured = (from, to) => this.grenades.smokeBlocks(from, to)
    this.tutorial = world.tutorial ? new TutorialMode({
      camera: camera.perspective, enemies: () => this.ai.enemies,
      giveGrenades: () => this.grenades.give(),
      lineOfSight: (from, to) => !this.player.world.visible(from, to, new THREE.Object3D()) ? 'wall' : this.grenades.smokeBlocks(from, to) ? 'smoke' : 'clear',
      wake: (ids, toward) => this.ai.wake(ids, toward),
      checkpoint: () => { if (this.ready) this.checkpoint = this.snapshot() },
      restart: () => { this.restart(); this.player.requestControl() },
      reducedMotion: () => this.hud.reducedMotion,
    }) : null
    if (world.tutorial) this.hud.setTutorial()
    else if (world.level !== FIRST_LEVEL) this.hud.setStandalone()
    player.onPlayingChange = playing => {
      // Pausing a mission in progress saves it (only on the change from playing, not on every menu pause call).
      if (!playing && this.wasPlaying) this.saveProgress()
      this.wasPlaying = playing
      this.hud.setPlaying(playing)
      // A fresh start, restart or retry comes up out of the dark; resuming from pause does not.
      if (playing && this.introPending) { this.introPending = false; this.intro.play(this.hud.reducedMotion) }
      if (this.escape.active) this.hud.setEscape(this.escape)
    }
    this.teammates = new Teammates(scene, event => this.audio.play(event), invalidate)
    this.coop = new CoopSession(message => this.coopMessage(message))
    this.coop.onChange(() => {
      if (!this.coop.active) { this.teammates.clear(); this.remote.clear(); this.hostEnemies = null }
      for (const id of this.remote.keys()) if (!this.coop.hub.players.has(id)) this.remote.delete(id)
      this.invalidate()
    })
    this.coopPanel = new CoopPanel(document.querySelector('.coop-slot')!, document.querySelector('#coop-status')!, this.coop)
    this.escort = world.rescue ? new HostageEscort(scene, player.world, player.actions.doors) : null
    const rescue = world.goals?.find(goal => goal.kind === 'extract' && goal.captives)
    this.captives = world.captives?.length ? new Captives(scene, world.captives, player.world, player.actions.doors, rescue?.kind === 'extract' ? rescue.area : undefined) : null
    this.charges = world.charges?.length ? new Charges(scene, scene, world.charges, event => this.emit(event, false)) : null
    if (this.charges) {
      this.charges.onPlanted = spec => {
        const station = this.world.stations.find(candidate => candidate.id === spec.plant)
        if (station) this.finishUse(station)
      }
      this.charges.onExplode = (_spec, center) => this.chargeBlast(_spec, center)
    }
    this.bossTags = world.enemies.some(spec => spec.boss) && !world.tutorial ? new BossTags() : null
    this.statusTags = new StatusTags()
    this.security = new SecuritySystem(player.world, world, this.ai, event => this.emit(event, false))
    this.syncWorld()
    player.actions.extraTargets = () => this.targets()
    player.actions.onIdleUse = () => { if (this.isActive() && !this.grenades.equipped && !this.aiming) this.weapons.inspect() }
    player.actions.onAction = target => {
      this.weapons.cancel(); this.aiming = false; this.interactionTime = 0.25
      if (target.kind === 'door' || target.kind === 'ladder') this.emit({ kind: target.kind, position: target.point, radius: target.kind === 'door' ? 8 : 5 }, true)
      if (target.kind === 'door' && this.role === 'guest') {
        const index = this.player.actions.doors.indexOf(target.object as THREE.Group)
        this.doorHold.set(index, performance.now())
        this.coop.send({ t: 'door', id: this.coop.hub.selfId, i: index, open: Boolean(target.object.userData.open) })
      }
    }
    const options = { signal: this.abort.signal }
    document.querySelector('#walk-start')!.addEventListener('click', () => { void this.audio.unlock() }, options)
    window.addEventListener('keydown', this.keyDown, options)
    window.addEventListener('keyup', event => { if (this.leanKeys.delete(event.code)) this.invalidate() }, options)
    document.querySelector('#world')!.addEventListener('wheel', event => {
      const wheel = event as WheelEvent
      if (!this.isActive() || wheel.ctrlKey || wheel.metaKey || wheel.altKey) return
      wheel.preventDefault()
      // While scoped the wheel zooms the sniper scope; otherwise it cycles weapons (down: next, up: previous).
      if (this.aiming) { if (this.weapons.adjustScopeZoom(-Math.sign(wheel.deltaY))) this.invalidate(); return }
      this.wheelTravel += wheel.deltaMode === 1 ? wheel.deltaY * 40 : wheel.deltaY
      const now = performance.now()
      if (Math.abs(this.wheelTravel) < WHEEL_NOTCH || now - this.wheelSwitchedAt < WHEEL_REPEAT_MS) return
      // The wheel goes back to the guns from a grenade.
      if (this.grenades.equipped) { if (this.grenades.busy) return; this.grenades.holster() }
      if (this.weapons.cycle(Math.sign(this.wheelTravel))) this.aiming = this.rightHeld && this.weapons.canAim && !aimToggles(this.weapons.current?.name)
      this.wheelTravel = 0; this.wheelSwitchedAt = now
      this.invalidate()
    }, { ...options, passive: false })
    // Toggle aim so firing never requires simultaneous mouse buttons (Magic
    // Mouse / trackpads). Mouse events also report each button independently.
    window.addEventListener('mousedown', event => {
      if (!this.isActive() || event.target !== document.querySelector('#world')) return
      void this.audio.unlock()
      // A grenade in hand takes both buttons: left throws, right lobs.
      if (this.grenades.equipped) { this.grenades.press(event.button); this.invalidate(); return }
      if (event.button === 0) this.weapons.trigger(true)
      if (event.button === 2 && this.weapons.current?.name === 'knife') this.weapons.stab()
      else if (event.button === 2) {
        // Hold right click to aim (and zoom); releasing it returns to the normal view. The sniper's scope toggles
        // instead: one click puts it up, the next takes it down.
        this.rightHeld = true
        this.aiming = aimToggles(this.weapons.current?.name) ? !this.aiming && this.weapons.canAim : this.weapons.canAim
        if (this.weapons.current && !this.weapons.canAim) this.hud.notify("You can't aim with this weapon.", 2, true)
      }
      this.invalidate()
    }, options)
    window.addEventListener('mouseup', event => {
      this.grenades.release(event.button)
      if (event.button === 0) this.weapons.trigger(false)
      if (event.button === 2) { this.rightHeld = false; if (!aimToggles(this.weapons.current?.name)) this.aiming = false; this.invalidate() }
    }, options)
    window.addEventListener('blur', () => this.cancelInput(), options)
    document.addEventListener('pointerlockchange', () => { if (!player.playing) this.cancelInput() }, options)
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.cancelInput(); this.saveProgress() } }, options)
    window.addEventListener('pagehide', () => this.saveProgress(), options)
    this.initialized = this.initialize()
  }

  private async initialize() {
    try {
      await this.ai.init()
      await this.escort?.init()
      await this.captives?.init()
      if (this.disposed) return
      this.player.world.warm()
      this.escort?.sync(this.state)
      this.captives?.sync(this.state)
      const supply = this.world.stations.find(s => s.kind === 'supply')
      if (supply) {
        const point = supply.point.clone().add(new THREE.Vector3(0.7, 0, 0.65))
        const floor = this.player.world.floor(point, 0.1, 2)
        this.weapons.addPickup({ id: 'maintenance-smg', name: 'smg', magazine: 24, reserve: 48,
          position: [point.x, Number.isFinite(floor) ? floor : 0.12, point.z] })
        this.weapons.addPickup({ id: 'maintenance-sniper', name: 'sniper', magazine: 5, reserve: 15,
          position: [point.x - 1.4, Number.isFinite(floor) ? floor : 0.12, point.z + 0.6] })
      }
      // Weapons the buildings stand up in a corner (userData.weaponSpot), facing the way the spot faces.
      this.scene.traverse(object => {
        const spot = object.userData.weaponSpot as Omit<WeaponItem, 'position' | 'stand'> | undefined
        if (!spot) return
        const facing = new THREE.Vector3(0, 0, 1).transformDirection(object.matrixWorld)
        this.weapons.addPickup({ ...spot, position: object.getWorldPosition(new THREE.Vector3()).toArray() as Vec3,
          stand: Math.atan2(facing.x, facing.z) })
      })
      this.placeAtInsertion()
      // Missions start with a full grenade belt; training hands it out in its grenade lesson.
      if (!this.world.tutorial) this.grenades.give()
      this.initial = this.snapshot()
      this.checkpoint = structuredClone(this.initial)
      this.ready = true; this.hud.ready(); this.invalidate()
      // Entered from the campaign or the free missions: open on the briefing.
      this.run = takeRun(this.world.level)
      if (this.run) this.hud.setRun(this.run)
      // Arriving from another level's Load game: load this level's save now.
      let pending: string | null = null
      try { pending = sessionStorage.getItem(PENDING_LOAD); sessionStorage.removeItem(PENDING_LOAD) } catch { /* no storage */ }
      if (pending === this.world.level) this.loadSaved(pending)
      // An invite link (?join=ROOM) connects straight away and shows the room on the Co-op page.
      const room = new URLSearchParams(location.search).get('join')
      if (room) { this.hud.showCoop(); void this.coop.join(room) }

    } catch (error) {
      if (this.disposed) return
      console.error('Mission loading failed', error)
      this.hud.error(`Could not load the mission: ${error instanceof Error ? error.message : String(error)}. Reload this page to retry.`)
      this.invalidate()
    }
  }

  private placeAtInsertion() {
    this.player.resetStance()
    this.player.actions.reset()
    this.player.body.teleport(new THREE.Vector3(...this.world.spawn))
    this.player.world.refresh()
    this.player.body.update(1/60,new THREE.Vector3(),false)
    this.player.actions.syncCamera(this.camera.perspective)
    this.camera.perspective.lookAt(new THREE.Vector3(...this.world.lookAt))
    this.safePosition.copy(this.player.body.position); this.safeQuaternion.copy(this.camera.perspective.quaternion)
  }

  private isActive() { return this.ready && this.state.phase === 'active' && !this.escape.active && this.player.enabled && this.player.playing && !this.player.immersive }
  private cancelInput() { this.aiming = false; this.rightHeld = false; this.weapons.cancel(); this.grenades?.cancel(); this.leanKeys.clear() }
  private keyDown = (event: KeyboardEvent) => {
    if (this.escape.active) return
    const leanKey = event.code === 'KeyQ' || event.code === 'KeyE'
    if (event.ctrlKey || event.metaKey || event.altKey || (event.repeat && !leanKey) || !this.player.enabled || this.player.immersive) return
    if (event.target instanceof HTMLElement && event.target.closest('button,input,select,textarea,summary,[contenteditable="true"]')) return
    if (event.code === 'KeyM') {
      event.preventDefault()
      if (this.state.phase !== 'active') return
      if (this.player.playing) { this.player.pause(); this.hud.showMap() }
      else this.player.requestControl()
      this.cancelInput(); this.invalidate(); return
    }
    if (!this.isActive()) return
    // Hold Q / E to lean left / right, PUBG-style. (The sniper scope zooms with the mouse wheel.)
    if (leanKey) { event.preventDefault(); this.leanKeys.add(event.code); this.invalidate(); return }
    const held = this.weapons.current?.name
    switch (event.code) {
      case 'KeyR': if (this.weapons.reload()) this.aiming = false; break
      case 'Digit1': case 'Digit2': case 'Digit3':
        // Any gun slot puts the grenade away (not mid-throw, with the pin out).
        if (this.grenades.busy) return
        this.grenades.holster(); this.weapons.switchSlot(Number(event.code.slice(5)) - 1); break
      case 'Digit4':
        if (this.grenades.equip()) { this.weapons.cancel(); this.aiming = false }
        else if (!this.grenades.equipped) this.hud.notify('No grenades left.', 2, true)
        break
      case 'KeyG': if (!this.grenades.equipped) this.weapons.drop(this.player.body.position); break
      default: return
    }
    // A new weapon in hand is aimed only while right click is held, and never a toggled scope carried over.
    if (this.weapons.current?.name !== held) this.aiming = this.rightHeld && !aimToggles(this.weapons.current?.name)
    if (!this.weapons.canAim) this.aiming = false
    event.preventDefault(); this.invalidate()
  }

  /**
   * A level's goal station's prompt, or none: a charge is planted only while you carry it; anything else once the
   * goal it serves is unlocked.
   */
  private objectiveLabel(station: Station) {
    const charge = this.charges?.plantStation(station.id)
    if (charge) return this.charges!.carried(this.state, charge) ? station.label : null
    const goals = this.world.goals ?? []
    const goal = goals.find(candidate => candidate.kind === 'interact' && candidate.station === station.id
      || candidate.kind === 'collect' && candidate.stations.includes(station.id))
    return goal && !goalUnlocked(this.state, goals, goal) ? null : station.label
  }

  private targets(): ActionTarget[] {
    if (!this.isActive() || this.state.jeep === 'escaping' || this.charges?.busy) return []
    const targets: ActionTarget[] = []
    for (const station of this.world.stations) {
      let label = stationLabel(this.state,station.kind,station.id)
      // A level's own goal station shows its own prompt, once its goal is unlocked.
      if (station.kind === 'objective' && label) label = this.objectiveLabel(station)
      if (station.kind === 'jeep' && label === 'Board jeep' && this.gateOpening()) label = 'Gate opening'
      if (label) targets.push({ object: station.object, point: station.point, kind: 'mission', label,
        descending: false, use: () => this.use(station) })
    }
    for (const item of this.weapons.pickupTargets()) targets.push({ ...item, kind: 'pickup', descending: false, use: () => this.weapons.pickup(item.id) })
    // Supply crates: take ammunition (F) while they last.
    for (const crate of this.crates.standing()) targets.push({ object: crate.object, point: crate.position.clone().add(new THREE.Vector3(0, 0.75, 0)), kind: 'pickup',
      label: 'Take ammo', descending: false, use: () => {
        if (this.weapons.resupply()) { this.hud.notify('Ammunition restocked.', 2); return true }
        this.hud.notify('You are full on ammunition.', 2, true); return false
      } })
    return targets
  }

  private use(station: Station) {
    if (!this.isActive()) return false
    const eye = this.camera.perspective.position
    if (eye.distanceTo(station.point) > 2.65 || !this.player.world.visible(eye, station.point, station.object)) return false
    if (station.kind === 'jeep' && this.gateOpening()) {
      this.hud.notify('Wait for the exit gate to finish opening.', 3)
      return false
    }
    // Planting a charge: hold still for its plant time; then the station counts as used (finishUse).
    const charge = this.charges?.plantStation(station.id)
    if (charge) {
      if (!this.charges!.carried(this.state, charge)) { this.hud.notify(`You need the ${charge.name}.`, 3); return false }
      this.weapons.cancel(); this.aiming = false
      this.charges!.beginPlant(charge, this.player.body.position)
      return true
    }
    return this.finishUse(station)
  }

  /** Use a station for real (after any planting): a guest asks the host; the host and solo change the mission. */
  private finishUse(station: Station) {
    // The host's compound owns shared objectives, so a guest asks for them. Supplies heal only this player.
    if (this.role === 'guest' && station.kind !== 'supply') {
      this.coop.send({ t: 'use', id: this.coop.hub.selfId, kind: station.kind, station: station.id })
      this.weapons.cancel()
      return true
    }
    const result = useStation(this.state,station.kind,station.id)
    if (result.message) this.hud.notify(result.message,7)
    if (!result.changed) return false
    this.weapons.cancel()
    this.stationUsed(station)
    return true
  }

  private stationUsed(station: Station) {
    // A charge's pickup and plant, and a file picked up: say so, and start a planted charge's fuse.
    const charge = this.charges?.specs.find(spec => spec.plant === station.id || spec.pickup === station.id)
    if (charge?.plant === station.id && !(charge.id in this.state.chargesPlanted)) {
      this.state.chargesPlanted[charge.id] = this.state.elapsed
      this.hud.notify(`${charge.name} planted. ${charge.fuse} seconds. Get clear!`, 4)
    } else if (charge?.pickup === station.id) this.hud.notify(`You have the ${charge.name}. Plant it at the target.`, 5)
    const collect = this.world.goals?.find(goal => goal.kind === 'collect' && goal.stations.includes(station.id))
    if (collect?.kind === 'collect') this.hud.notify(`${collect.label}: ${collect.stations.filter(id => this.state.usedStations.includes(id)).length}/${collect.stations.length}`, 3)
    this.emit({ kind: station.kind === 'distraction' ? 'bell' : 'objective',
      position: station.point.clone(), radius: station.kind === 'distraction' ? 27 : 6 }, station.kind === 'distraction')
    if (station.kind === 'rally') this.escort?.rally(this.state)
    if (station.kind === 'jeep') {
      this.beginEscape()
    }
    if (this.state.phase === 'complete') { this.player.pause(); this.cancelInput() }
    this.syncWorld(); this.invalidate()
  }

  private gateOpening() {
    return this.state.gateOpen && this.world.rescue && !isDoorFullyOpen(this.world.rescue.gate)
  }

  private emit(event: SoundEvent, audible: boolean) {
    // The host shares its compound's sounds (guards, alarms, impacts). Each player hears their own near misses.
    if (!audible && this.role === 'host' && event.kind !== 'enemy-bullet-whiz') this.coop.send({ t: 'sound', e: netSound(event) })
    if (this.death.active) return
    if ((event.kind.startsWith('shot-') || event.kind.startsWith('enemy-shot')) && event.position) {
      // The muzzle flash lights the room for a blink: walls, floor, the shooter's hands. A silencer hides most of it.
      lightBurst(event.position, event.kind.endsWith('silenced') ? MUZZLE_SILENCED : MUZZLE_FLASH)
      if (this.state.hostages.some(h => h.status === 'following' && event.position!.distanceTo(new THREE.Vector3(...h.position)) < 15)) this.gunfireUntil = this.state.elapsed + 1.1
    }
    const eye = this.camera.perspective.position
    const distance = event.position ? eye.distanceTo(event.position) : 0
    const inRange = !event.position || distance <= (event.radius ?? 38)
    if (inRange) this.audio.play(event)
    if (audible && event.radius && event.position) {
      if (this.role === 'guest') this.coop.send({ t: 'noise', id: this.coop.hub.selfId, kind: event.kind, position: event.position.toArray() as Vec3, radius: event.radius })
      else this.ai.hear(event)
    }
    if (event.text && inRange && !event.kind.startsWith('shot-') && !event.kind.startsWith('enemy-shot')) {
      const text = event.kind === 'callout' && event.position ? `${this.soundDirection(event.position)} · “${event.text}”` : event.text
      if (text !== this.lastCaption || this.state.elapsed-this.lastCaptionAt>3) {
        this.hud.notify(text,3.5); this.lastCaption=text; this.lastCaptionAt=this.state.elapsed
      }
    }
  }

  private soundDirection(point: THREE.Vector3) {
    const relative = point.clone().sub(this.camera.perspective.position).applyQuaternion(this.camera.perspective.quaternion.clone().invert())
    return Math.abs(relative.x)>Math.abs(relative.z)*0.65 ? relative.x>0?'Right':'Left' : relative.z>0?'Behind':'Ahead'
  }

  private shot(shot: Shot) {
    if (!this.isActive()) return
    if (this.coop.active) shot.by = this.coop.hub.selfId
    if (!shot.pelletIndex) { this.state.shots++; this.steadiness.onShot(this.aiming && this.weapons.canAim) }
    let surface = this.player.world.raySurface(shot.origin, shot.direction, shot.range)
    let distance = surface?.distance ?? shot.range
    this.impactPoint = null
    let hit = false, hostageHit = false
    if (this.role === 'guest') {
      // A guest aims at the guards it sees; the host applies the damage and replies with the reaction.
      const found = this.ai.findHit(shot, distance)
      if (found) {
        hit = true
        this.impactPoint = found.point.clone()
        this.coop.send({ t: 'hit', id: this.coop.hub.selfId, hit: { i: found.index, zone: found.zone, point: found.point.toArray() as Vec3, bone: found.bone,
          distance: found.distance, direction: found.direction.toArray() as Vec3, origin: shot.origin.toArray() as Vec3, weapon: shot.weapon ?? 'ak', damage: shot.damage } })
      }
    } else {
      // A hostage in the way takes the round instead of whatever is behind him.
      const hostage = hostageAlong(this.hostageBodies(), shot.origin, shot.direction, distance)
      const reach = hostage?.distance ?? distance
      this.ai.nearMiss(shot,reach)
      hit=this.ai.hit(shot,reach)
      if (!hit && hostage) {
        this.harmHostage(hostage.body, shot.damage, hostage.head, hostage.point, shot.direction, shot.weapon)
        this.impactPoint = hostage.point
        hostageHit = true
      }
    }
    // A bullet that reaches a quest crate damages it; the host (or a solo player) decides when it breaks.
    const crate = !hit && !hostageHit && surface ? this.crates.at(surface.mesh) : null
    if (crate) {
      if (this.role === 'guest') this.coop.send({ t: 'crate', id: this.coop.hub.selfId, crate, damage: shot.damage })
      else this.hitCrate(crate, shot.damage)
    }
    // A bullet that passes a lit ceiling lamp breaks it, and its room goes darker. (The host's lamps are shared.)
    const lamp = this.role === 'guest' ? null : this.lamps?.hit(shot.origin, shot.direction, distance)
    if (lamp) {
      this.state.lampsOut = [...this.state.lampsOut ?? [], lamp.id]
      this.lamps.smash(lamp.id)
      this.lamps.apply(this.state.lampsOut)
      this.emit({ kind: 'impact', position: shot.origin.clone().addScaledVector(shot.direction, lamp.distance), radius: 9 }, true)
    }
    // One bullet wrecks a radio, switched off or not.
    const radio = !hit && !hostageHit && !crate && surface ? this.radios.at(surface.mesh) : null
    if (radio) {
      if (this.role === 'guest') this.coop.send({ t: 'radio', id: this.coop.hub.selfId, radio })
      else this.hitRadio(radio)
    }
    if (hit) this.hitFlash = 0.15
    const end=this.impactPoint ?? shot.origin.clone().addScaledVector(shot.direction,distance)
    const impact = !hit && !hostageHit && surface ? () => {
      this.audio.play({kind:'impact',position:end,radius:18})
      this.impacts.emit(end, shot.direction, surface, shot.weapon)
    } : undefined
    this.bulletTrails.emit(shot.origin, end, shot.weapon, undefined, impact)
    this.coop.send({ t: 'shot', id: this.coop.hub.selfId, origin: shot.origin.toArray() as Vec3, end: end.toArray() as Vec3, weapon: shot.weapon ?? 'ak' })
  }

  /** Knife: a short fan of rays forgives thin animated limbs at arm's length. Walls stop the blade. */
  private melee(attack: MeleeAttack) {
    if (!this.isActive()) return
    const by = this.coop.active ? this.coop.hub.selfId : undefined
    const sideways = new THREE.Vector3().crossVectors(attack.direction, new THREE.Vector3(0, 1, 0)).normalize()
    let found: ReturnType<EnemyDirector['findHit']> = null, shot: Shot | null = null, wall: number = KNIFE.range
    for (const [side, lift] of [[0, 0], [0.22, 0], [-0.22, 0], [0, -0.2], [0, 0.14], [0.42, -0.1], [-0.42, -0.1]]) {
      const direction = attack.direction.clone().addScaledVector(sideways, side).add(new THREE.Vector3(0, lift, 0)).normalize()
      const reach = this.player.world.raySurface(attack.origin, direction, KNIFE.range)?.distance ?? KNIFE.range
      if (!side && !lift) wall = reach
      shot = { origin: attack.origin.clone(), direction, range: KNIFE.range, damage: attack.damage, weapon: 'knife', by }
      found = this.ai.findHit(shot, reach)
      if (found) break
    }
    // Teammates see the swing; there is no tracer and no round for guards to react to.
    this.coop.send({ t: 'shot', id: this.coop.hub.selfId, origin: attack.origin.toArray() as Vec3,
      end: attack.origin.clone().addScaledVector(attack.direction, KNIFE.range).toArray() as Vec3, weapon: 'knife' })
    if (!found || !shot) {
      // The blade finds a hostage as easily as a guard.
      const hostage = this.role !== 'guest' ? hostageAlong(this.hostageBodies(), attack.origin, attack.direction, wall) : null
      if (hostage) { this.hitFlash = 0.15; this.harmHostage(hostage.body, attack.damage, hostage.head, hostage.point, attack.direction, 'knife'); return }
      if (wall < KNIFE.range) this.audio.play({ kind: 'knife-wall', position: attack.origin.clone().addScaledVector(attack.direction, wall), radius: 6 })
      return
    }
    this.hitFlash = 0.15
    if (this.role === 'guest') {
      this.coop.send({ t: 'hit', id: this.coop.hub.selfId, hit: { i: found.index, zone: found.zone, point: found.point.toArray() as Vec3, bone: found.bone,
        distance: found.distance, direction: found.direction.toArray() as Vec3, origin: attack.origin.toArray() as Vec3, weapon: 'knife', damage: attack.damage } })
    } else this.ai.applyHit(shot, found)
  }

  damage(amount: number, source?: THREE.Vector3, hit?: PlayerBulletHit) {
    // Bullets are fixed quarter-health hits with brief immunity; the weapon's own amount still scales the flinch and sound.
    if (this.invincible || !this.isActive()) return
    if (!(hit && amount > 0 ? shootMission(this.state, PLAYER_BULLET_DAMAGE) : damageMission(this.state, amount))) return
    if (this.state.phase !== 'dead' && !this.hud.reducedMotion) {
      const point = this.player.body.position.clone().add(new THREE.Vector3(0, 1.17, 0))
      this.playerHits.hit(hit ?? { region: source ? 'torso' : 'leg', side: 0, point,
        direction: source ? point.clone().sub(source) : new THREE.Vector3(0, 1, 0) },
        amount, this.player.body.grounded && !this.player.actions.traversing)
    }
    this.hud.hurt(); this.audio.play({kind:'damage'})
    // Share the local hurt recording, impact thump and shading for bullets and hard landings.
    this.audio.play({ kind: 'bullet-hit', intensity: Math.min(1, amount / 28) })
    this.hud.hitFrom(1, source ? this.soundDirection(source) : 'Below')
    this.hud.notify(source ? `Taking fire · ${this.soundDirection(source).toLowerCase()}. Break line of sight.` : 'You fell. Find a safer route.',2.5)
    if (this.state.phase==='dead') {
      this.playerHits.clear(); this.deaths++
      const bulletDirection = hit?.direction ?? (source ? this.camera.perspective.position.clone().sub(source) : undefined)
      this.death.begin(this.camera.perspective, this.player.body.position, this.player.world, this.hud.reducedMotion, bulletDirection)
      this.weapons.beginDeath(); this.grenades?.holster()
      this.player.pause(); this.player.actions.reset(); this.cancelInput()
      this.player.body.velocity.set(0, 0, 0)
      this.audio.beginDeath()
      this.hud.setScoped(false); this.hud.clearThreat(); this.hud.setDeath(this.death)
    }
    this.invalidate()
  }

  private snapshot(): Checkpoint {
    return { mission:structuredClone(this.state),weapons:this.weapons.snapshot(),enemies:this.ai.snapshot(),
      doors:this.player.actions.doors.map(door=>door.userData.open?(door.userData.openSide===-1?-1:1):0),position:this.player.body.position.toArray() as Vec3,
      quaternion:this.camera.perspective.quaternion.toArray() as [number,number,number,number], blood:this.blood.snapshot(), grenades:this.grenades?.snapshot() }
  }

  private restore(saved: Checkpoint) {
    this.won = false; this.nextLevel = null
    this.intro.clear(); this.introPending = true
    this.escape.reset(this.camera.perspective)
    this.escapeDust.clear()
    this.death.reset(); this.weapons.resetDeath()
    this.playerHits.clear()
    this.player.pause(); this.cancelInput(); this.audio.reset(); this.player.actions.reset(); this.player.resetStance(); this.lean.reset()
    this.state=structuredClone(saved.mission)
    this.player.movementLocked = false; this.gunfireUntil = 0
    this.player.actions.doors.forEach((door,i)=>{ const saved_=saved.doors[i]; setDoorOpen(door,Boolean(saved_),true,saved_===-1?-1:1) })
    this.player.world.refresh(); this.ai.restore(structuredClone(saved.enemies)); this.weapons.restore(structuredClone(saved.weapons)); this.blood.restore(saved.blood)
    this.grenades?.restore(saved.grenades)
    this.player.body.teleport(new THREE.Vector3(...saved.position)); this.player.actions.syncCamera(this.camera.perspective)
    this.camera.perspective.quaternion.fromArray(saved.quaternion)
    this.safePosition.copy(this.player.body.position); this.safeQuaternion.copy(this.camera.perspective.quaternion)
    this.stepTime=0; this.interactionTime=0; this.hitFlash=0; this.lastCaptionAt=-100
    this.bulletTrails.clear(); this.impacts.clear(); this.crates.reset(this.state); this.radios.reset(this.state); this.player.world.refresh(); this.hud.reset(); this.security.reset(); this.syncWorld(true); this.invalidate()
  }

  /** Host and solo: a hit on a quest crate, from this player or a guest. A crate that breaks is loud enough for nearby guards. */
  private hitCrate(id: string, damage: number) {
    if (this.state.phase !== 'active' || this.state.brokenCrates.includes(id) || !this.crates.damage(id, damage)) return
    this.state.brokenCrates.push(id)
    const position = this.crates.center(id)
    this.updateCrates(0)
    if (position) this.ai.hear({ kind: 'crate-explosion', position, radius: CRATE_RULES.noiseRadius })
  }

  /** Host and solo: a shot that wrecks a radio, from this player or a guest. Guards nearby hear it. */
  private hitRadio(id: string) {
    if (this.state.phase !== 'active' || this.state.destroyedRadios.includes(id) || !this.radios.radios.has(id)) return
    this.state.destroyedRadios.push(id)
    const position = this.radios.center(id)
    this.updateCrates(0)
    if (position) this.ai.hear({ kind: 'impact', position, radius: RADIO_RULES.noiseRadius })
  }

  /**
   * Shows the crates and radios as the (possibly host-shared) mission state has them, blowing up newly broken
   * ones, and moves the debris.
   */
  private updateCrates(dt: number) {
    this.crates.sync(this.state)
    this.crates.update(dt)
    this.radios.sync(this.state)
    this.radios.update(dt)
    this.lamps?.update(dt)
    this.beacons?.update(this.isActive() && this.state.alarm === 'active', performance.now() / 1000)
  }

  /**
   * Saves the mission in progress to this level's slot. Only a solo mission that is under way, alive and not
   * already driving out can be saved; co-op state belongs to the host's room.
   */
  saveProgress() {
    // Only campaign missions are saved: the tutorial and developer levels never save over a mission in progress.
    if (!this.saved || !this.ready || this.coop.active || this.state.phase !== 'active' || this.state.elapsed <= 0 || this.state.jeep === 'escaping' || this.death.active) return false
    return writeSave({ level: this.world.level, elapsed: this.state.elapsed, objective: this.objectiveHint() }, this.snapshot())
  }

  /** Things picked up at their stations (files, a charge) are gone once taken. */
  private syncCollectibles() {
    for (const station of this.world.stations ?? []) {
      if (station.object?.userData.collectible) station.object.visible = !this.state.usedStations.includes(station.id)
    }
  }

  /** A blast breaks the quest crates and wrecks the radios within `radius` of it. */
  /** Every hostage body on the level that can still be hurt: the compound's (not yet in the jeep) and the captives. */
  private hostageBodies(): HostageBody[] {
    const bodies: HostageBody[] = []
    ;(this.state?.hostages ?? []).forEach((hostage, index) => {
      const actor = this.escort?.actors[index]
      if (actor && hostage.status !== 'loaded') bodies.push({ id: hostage.id, name: 'The hostage', seated: hostage.status === 'captive', actor })
    })
    if (this.captives) bodies.push(...this.captives.bodies(this.state))
    return bodies
  }

  /**
   * A hostage is hit (host and solo decide; guests' rounds pass through): he bleeds and flinches, or falls and the
   * mission is lost. `amount` is the weapon's damage; a head hit counts HOSTAGE.head times.
   */
  private harmHostage(body: HostageBody, amount: number, head: boolean, point: THREE.Vector3, direction: THREE.Vector3, weapon?: WeaponName) {
    if (this.role === 'guest' || this.invincible) return
    const result = hurtHostage(this.state, body.id, head ? amount * HOSTAGE.head : amount, body.name)
    if (!result) return
    const actor = body.actor as HostageActor
    this.blood.emitHit({ zone: head ? 'head' : 'torso', point: point.clone(), direction: direction.clone(), lethal: result === 'killed', weapon })
    this.audio.play({ kind: 'enemy-hit', zone: head ? 'head' : 'torso', position: point.clone(), radius: 20 })
    if (result === 'hurt') {
      if (!body.seated) actor.hurt(head)
      this.hud.notify(`${body.name} is hit! Hold your fire.`, 2.5, true)
      return
    }
    actor.die(head, body.seated)
    this.failingUntil = performance.now() + 1700
    this.hud.notify(this.state.failure ?? 'A hostage was killed.', 5)
    this.cancelInput(); this.player.movementLocked = true
    if (this.role === 'host') this.sendWorld()
    // Let him fall, then the failure page with its retry.
    window.setTimeout(() => { if (this.state.phase === 'dead' && this.state.failure && !this.disposed) { this.player.movementLocked = false; this.player.pause(); this.invalidate() } }, 1600)
    this.invalidate()
  }

  /** A blast: hostages within `radius` take `damage(distance)` unless a wall shields them. */
  private blastHostages(center: THREE.Vector3, radius: number, damage: (distance: number) => number) {
    if (this.role === 'guest') return
    for (const { body, chest, distance } of hostagesNear(this.hostageBodies(), center, radius)) {
      if (!this.player.world.visible(center.clone().add(new THREE.Vector3(0, 0.3, 0)), chest, body.actor.root)) continue
      this.harmHostage(body, damage(distance), false, chest, chest.clone().sub(center).normalize())
    }
  }

  private blastQuestItems(origin: THREE.Vector3, radius: number) {
    for (const id of this.crates.crates.keys()) {
      const center = this.crates.center(id)
      if (center && center.distanceTo(origin) < radius) this.hitCrate(id, 999)
    }
    for (const id of this.radios.radios.keys()) {
      const center = this.radios.center(id)
      if (center && center.distanceTo(origin) < radius) this.hitRadio(id)
    }
  }

  /** A charge has gone off: hurt this player by how close they stood, and (host, solo) kill the guards in reach. */
  private chargeBlast(spec: import('./types').ChargeSpec, center: THREE.Vector3) {
    const distance = this.player.body.position.distanceTo(center)
    if (this.state.phase === 'active' && distance < spec.blast.radius) {
      const share = THREE.MathUtils.clamp((distance - spec.blast.lethal) / (spec.blast.radius - spec.blast.lethal), 0, 1)
      this.damage(distance < spec.blast.lethal ? 999 : THREE.MathUtils.lerp(70, 10, share), center)
    }
    if (this.role === 'guest') return
    this.ai.enemies.forEach((enemy, index) => {
      if (enemy.state === 'dead' || enemy.state === 'reserve' || enemy.position.distanceTo(center) > spec.blast.radius * 0.8) return
      const point = enemy.position.clone().add(new THREE.Vector3(0, 1.2, 0)), direction = point.clone().sub(center).normalize()
      this.ai.applyHit({ origin: center, direction, range: spec.blast.radius, damage: 3000, weapon: 'shotgun' },
        { index, zone: 'torso', point, bone: 'chest', distance: point.distanceTo(center), direction })
    })
    this.ai.hear({ kind: 'crate-explosion', position: center.clone(), radius: 150 })
    this.blastQuestItems(center, spec.blast.radius * 0.7)
    this.blastHostages(center, spec.blast.radius, distance => distance < spec.blast.lethal ? 999 : THREE.MathUtils.lerp(70, 10,
      THREE.MathUtils.clamp((distance - spec.blast.lethal) / (spec.blast.radius - spec.blast.lethal), 0, 1)))
  }

  /** Whether this level keeps saves: campaign missions do, training and developer levels don't. */
  private get saved() { return levelInfo(this.world.level)?.kind === 'campaign' && this.run !== 'free' }

  /** The objectives as the mission state stands (the briefing lists them). */
  private objectiveList() {
    const goals = this.world.goals
    return goals ? goalObjectives(this.state, goals, this.goalSense())
      : missionObjectives(this.state, { crates: this.crates.crates.size, radios: [...this.radios.radios.keys()] })
  }

  /**
   * Go into a mission from the menu, from the campaign or as a free mission: on its briefing, fresh. This level is
   * reset in place; another is switched to, told how it was entered.
   */
  private enterLevel(kind: RunKind, level: string) {
    if (level === this.world.level && !this.coop.active) {
      this.run = kind
      if (this.state.elapsed > 0 || this.state.phase !== 'active') this.restart()
      this.hud.setRun(kind)
      this.invalidate()
      return
    }
    if (this.run !== 'free') this.saveProgress()
    setNextRun(kind, level)
    goTo(level === FIRST_LEVEL ? 'mission' : `level:${level}`)
  }

  /** Load game: carry on the campaign at its mission, from that mission's checkpoint if it has one. */
  private continueCampaign() {
    const mission = readCampaign()?.mission
    if (!mission) return
    if (!readSave(mission)) { this.enterLevel('campaign', mission); return }
    if (mission !== this.world.level) setNextRun('campaign', mission)
    else { this.run = 'campaign'; this.hud.setRun('campaign') }
    this.loadSaved(mission)
  }

  /** Entered from the campaign or the free missions (and not loading a checkpoint): it opens on its briefing. */
  get opensOnBriefing() { return !!this.run && !this.player.playing }

  /** A mission won, however it was won (goals, the compound's escape): handled once. */
  private checkWon() {
    if (this.state.phase === 'complete' && !this.won) { this.won = true; this.missionWon() }
  }

  /**
   * A mission won: the next one is offered, and comes up by itself after the debrief. In the campaign (or a campaign
   * level opened without a menu entry) the campaign moves on too; a free mission leads to the next free mission.
   */
  private missionWon() {
    if (levelInfo(this.world.level)?.kind !== 'campaign' || this.world.tutorial) return
    if (this.run === 'free') {
      const order = campaignLevels().map(level => level.id)
      this.nextLevel = order[order.indexOf(this.world.level) + 1] ?? null
      // The last mission played free has nothing after it: just Play again.
      if (!this.nextLevel) return
    } else {
      this.run = 'campaign'
      this.nextLevel = finishCampaignMission(this.world.level)
      deleteSave(this.world.level)
    }
    this.hud.setComplete(this.nextLevel)
  }
  private objectiveHint() { return this.world.goals ? goalHint(this.state, this.world.goals) : missionObjective(this.state) }

  /** What the level's goals read from the world (see goals.ts). */
  private goalSense(players: readonly THREE.Vector3[] = []): GoalSense {
    return { players, enemies: this.ai.enemies, totals: { crates: this.crates.crates.size, radios: this.radios.radios.size }, captives: this.captives?.positions(this.state),
      chargePickups: Object.fromEntries((this.world.charges ?? []).map(spec => [spec.id, spec.pickup])),
      radiosOut: [...this.radios.radios.keys()].filter(id => this.state.disabledRadios.includes(id) || this.state.destroyedRadios.includes(id)).length }
  }

  /** Host and solo: tick off the level's goals as they are met, and win the mission once every main goal is done. */
  private checkGoals(players: readonly THREE.Vector3[]) {
    const goals = this.world.goals
    if (!goals || this.state.phase !== 'active') return
    for (const id of updateGoals(this.state, goals, this.goalSense(players))) {
      const goal = goals.find(candidate => candidate.id === id)!
      this.hud.notify(goal.done ?? `${goal.label}: done.`, 4)
      this.emit({ kind: 'objective', position: players[0]?.clone(), radius: 6 }, false)
    }
    if (goalsComplete(this.state, goals)) this.completeMission()
  }

  /** A goal-driven mission is won: the run ends on the pause page's debrief, and its save is spent. */
  private completeMission() {
    this.state.phase = 'complete'
    deleteSave(this.world.level)
    this.hud.notify(this.world.briefing?.won ?? 'Mission complete.', 6)
    this.cancelInput(); this.player.pause()
    if (this.role === 'host') this.sendWorld()
    this.invalidate()
  }

  /** Continue a saved mission: its checkpoint becomes the current one and play resumes from it. */
  loadSaved(level: string) {
    // Another mission's save: keep this one, switch to that level, and load it there once it's built.
    if (level !== this.world.level && levelInfo(level)?.kind === 'campaign' && !this.coop.active) {
      this.saveProgress()
      try { sessionStorage.setItem(PENDING_LOAD, level) } catch { /* the level opens without its save */ }
      goTo(`level:${level}`)
      return
    }
    const saved = level === this.world.level ? readSave<Checkpoint>(level) : null
    if (!saved || this.coop.active || !this.ready) { this.hud.notify('That saved mission could not be loaded.', 4); return }
    this.restore(saved)
    this.checkpoint = structuredClone(saved)
    this.hud.notify('Mission loaded.', 3)
    void this.audio.unlock(); this.player.requestControl()
  }

  /** Open the menu on the saved games (Load game from the tutorial). */
  showLoad() { this.continueCampaign() }

  retry() {
    if (!this.checkpoint) return
    this.restore(this.checkpoint)
    if (!this.tutorial) { this.hud.notify('Mission reset.', 3); return }
    // Training keeps its lessons, and you go back in at full health.
    this.state.health = PLAYER_HEALTH.max
    this.tutorial.retry()
    this.hud.notify(this.tutorial.atBoss ? 'Back at Bulky Boy. Full health.' : 'Back at the last checkpoint.', 3)
  }
  restart() {
    if(!this.initial) return
    this.checkpoint=structuredClone(this.initial); this.deaths=0; this.restore(this.initial)
    this.hud.briefObjectives()
    this.tutorial?.reset()
    this.hud.notify(this.tutorial ? 'Training restarted.' : 'Mission restarted.',3)
    this.doorHold.clear()
    if (this.role === 'host') { this.coop.send({ t: 'restart' }); this.sendWorld() }
  }

  private syncWorld(resetEscort = false) {
    this.lamps?.apply(this.state.lampsOut)
    const rescue = this.world.rescue
    if (rescue) {
      setDoorOpen(rescue.gate, this.state.gateOpen)
      rescue.cellDoors.forEach((door, index) => {
        const released = this.state.hostages[index].status !== 'captive'
        door.userData.missionLocked = !released
        setDoorOpen(door, released)
      })
      rescue.jeep.position.set(...RESCUE_LAYOUT.escapeRoute[0])
      if (resetEscort) {
        rescue.jeep.quaternion.identity()
        for (const wheel of rescue.jeep.userData.wheels as THREE.Group[] ?? []) wheel.rotation.set(0, 0, 0)
        const door = rescue.jeep.userData.passengerDoor as THREE.Group
        door.rotation.y = 0
      }
      this.player.world.refresh()
    }
    if (resetEscort) {
      this.escort?.sync(this.state); this.captives?.sync(this.state)
      this.charges?.clearEffects(); this.charges?.sync(this.state, true)
    }
    this.syncCollectibles()
    this.security.sync(this.state)
    if (this.state.alarm !== 'active') this.audio.setAlarm(false)
  }

  private beginEscape() {
    // A co-op extraction takes the whole team, including a player who is down.
    if (this.coop.active && this.state.phase === 'dead') {
      this.death.reset(); this.weapons.resetDeath(); this.hud.clearDeath()
      this.state.phase = 'active'; this.state.health = PLAYER_HEALTH.max
    }
    this.cancelInput(); this.playerHits.clear()
    this.player.actions.reset(); this.player.movementLocked = true
    this.player.body.velocity.set(0, 0, 0)
    this.weapons.update(0, { active: false, climbing: false, moving: 0, aiming: false,
      reducedMotion: this.hud.reducedMotion, feet: this.player.body.position })
    this.hud.setScoped(false); this.hud.clearThreat()
    this.bulletTrails.clear(); this.ai.bulletTrails.clear()
    this.escape.begin(this.camera.perspective)
    this.escapeDust.clear()
    this.player.pause()
    this.hud.setEscape(this.escape)
    this.audio.setAlarm(false)
    if (this.role === 'host') this.sendWorld()
  }

  private updateEscape(dt: number, elapsed: number) {
    const visible = this.player.enabled && !this.player.immersive
    const playing = visible && !document.hidden && this.escape.running
    const step = playing ? dt : 0
    const cinematicStep = playing ? elapsed : 0
    if (!visible) { this.hud.clearEscape(); this.audio.setActive(false); return false }
    this.escape.update(cinematicStep)
    const position = this.escape.position
    this.state.escapeProgress = this.escape.progress
    this.escort?.jeepOffset.copy(position).sub(new THREE.Vector3(...RESCUE_LAYOUT.escapeRoute[0]))
    this.escort?.jeepRotation.copy(this.escape.rotation)
    this.world.rescue?.jeep.position.copy(position)
    const jeep = this.world.rescue?.jeep
    if (jeep) {
      jeep.quaternion.copy(this.escape.rotation)
      for (const wheel of jeep.userData.wheels as THREE.Group[] ?? []) {
        wheel.rotation.y = wheel.position.x > 0 ? this.escape.steering : 0
        wheel.rotation.z = -this.state.escapeProgress / jeep.userData.wheelRadius
      }
    }
    this.escapeDust.update(cinematicStep, position, this.escape.rotation, this.escape.speed)
    // Keep the player aboard for world state, while the camera stays outside.
    this.player.body.teleport(new THREE.Vector3(-0.35, -0.12, -0.46).applyQuaternion(this.escape.rotation).add(position))
    if (playing) {
      advanceMission(this.state, step)
      this.player.world.refresh()
      if (this.role === 'guest') this.ai.follow(step, null)
      else this.ai.update(step, { feet: this.player.body.position, eye: this.camera.perspective.position,
        velocity: this.player.body.velocity, alive: false, radioEnabled: false })
      this.escort?.update(step, this.state, this.player.body.position, false)
      if (jeep) updateRescueJeepDoor(jeep, this.state.hostages[0].position, true, step)
      this.blood.update(step); this.impacts.update(step); this.updateCrates(step); this.bulletTrails.update(step)
      this.security.sync(this.state, this.state.elapsed)
    }
    if (completeEscape(this.state, this.escape.crossedGate && loadedCount(this.state) === this.state.hostages.length)) {
      this.hud.notify('Hostage safely extracted.', 8)
      deleteSave(this.world.level)
    }
    // The compound is won out here, during the drive: the campaign moves on just the same.
    this.checkWon()
    this.escape.applyCamera(this.camera.perspective)
    this.audio.setActive(playing && !this.escape.menuVisible)
    this.audio.setAlarm(false); this.audio.update(this.camera.perspective)
    this.hud.update(step, this.state, { playing: false, enabled: true, weapon: this.weapons.current, reloading: false,
      position: this.player.body.position, yaw: 0, deaths: this.deaths, ready: this.ready })
    this.hud.setEscape(this.escape)
    return playing && this.escape.running
  }

  update(dt:number, elapsed = dt) {
    this.finishFrame()
    const landingSpeed = this.player.body.landingSpeed
    this.player.body.landingSpeed = 0
    // Teammates keep moving while this player pauses, dies or rides out; keep rendering while in a room.
    const coop = this.syncCoop(dt)
    if (this.escape.active) return this.updateEscape(dt, elapsed) || coop
    const active=this.isActive()
    if (this.player.immersive || !this.player.enabled || this.state.phase !== 'active') {
      this.playerHits.clear(); this.hud.clearThreat()
      if (this.player.immersive || !this.player.enabled || !this.death.active) {
        this.bulletTrails.clear(); this.ai.bulletTrails.clear()
      }
    }
    if(this.player.immersive && !this.wasVR) {
      this.cancelInput()
      // Entering VR resets transit to a tower landing. Preserve that safe
      // location, rather than the previous frame's position halfway along a cable.
      this.safePosition.copy(this.player.body.position)
      this.safeQuaternion.copy(this.camera.perspective.quaternion)
    }
    if(!this.player.immersive && this.wasVR) {
      this.player.body.teleport(this.safePosition); this.player.actions.syncCamera(this.camera.perspective)
      this.camera.perspective.quaternion.copy(this.safeQuaternion)
    }
    this.wasVR=this.player.immersive
    // Lean for this frame only: guards see, shots leave from, and the renderer draws the leaned head.
    const canLean = this.isActive() && this.player.body.stance !== 'prone' && !this.player.actions.traversing
    this.lean.update(dt, canLean ? Number(this.leanKeys.has('KeyE')) - Number(this.leanKeys.has('KeyQ')) : 0)
    this.lean.apply(this.camera.perspective, this.player.world, this.hud.reducedMotion)
    let deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    const deathPlaying = deathVisible && !this.death.menuVisible && !document.hidden
    if(active!==this.active) { this.cancelInput(); this.active=active }
    this.audio.setActive(active || deathPlaying)
    const role = this.role
    if(active) {
      if (role === 'solo') advanceMission(this.state,dt)
      const body=this.player.body
      const bounds=this.world.bounds
      if(body.position.y < -12 || body.position.x<bounds.minX || body.position.x>bounds.maxX || body.position.z<bounds.minZ || body.position.z>bounds.maxZ) {
        body.teleport(this.safePosition); this.player.actions.syncCamera(this.camera.perspective)
        this.hud.notify('The perimeter is closed. Follow the marked routes.',3)
      } else if (!this.player.actions.traversing) this.damage(fallDamage(landingSpeed))
      if (Math.abs(body.position.x - 117) < 10 && body.position.z > -31 && body.position.z < -2) this.state.detentionFound = true
      if (this.state.detentionFound && body.position.y < -2.8) this.state.cellsReached = true
      // In co-op the host steps the compound for everyone below, and guests mirror it.
      if (role === 'solo') {
        this.security.update(dt, this.state, this.camera.perspective.position)
        this.ai.update(dt,{feet:body.position,eye:this.camera.perspective.position,velocity:body.velocity,alive:this.state.phase==='active',radioEnabled:true,
          yaw:new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion,'YXZ').y})
        const danger = this.gunfireUntil > this.state.elapsed
        this.escort?.update(dt, this.state, body.position, danger)
        this.captives?.update(dt, this.state, danger, body.position)
        this.checkGoals([body.position])
        this.updateJeepDoor(dt)
        this.blood.update(dt)
        this.impacts.update(dt)
        this.updateCrates(dt)
        this.tutorial?.update(dt, { position: body.position, speed: Math.hypot(body.velocity.x, body.velocity.z), grounded: body.grounded,
          traversing: this.player.actions.traversing, stance: body.stance, lean: this.lean.amount, aiming: this.aiming,
          weapon: this.weapons.current?.name ?? null, slot: this.weapons.selected, slots: this.weapons.slots, reloading: this.weapons.reloading,
          grenade: this.grenades?.equipped ? this.grenades.selected : null })
      }
      const speed=Math.hypot(body.velocity.x,body.velocity.z)
      if(speed>0.5 && body.grounded || this.player.actions.climbing) {
        this.stepTime+=dt
        // Guards only hear sprinting feet, and only up close; walking is silent to them but the player hears it.
        // Crouched and prone movement makes no footstep sound at all.
        // Sprinting is relative to what you carry: a sniper's sprint is slower than a knife's walk is fast.
        const climbing = this.player.actions.climbing, sprinting = !climbing && speed > 5 * body.speedScale, lowered = !climbing && body.stance !== 'stand'
        if(this.stepTime>(climbing?0.5:sprinting?0.3:0.48)) {
          this.stepTime=0
          if (!lowered) this.emit({kind:climbing?'ladder':'footstep',position:body.position.clone(),radius:climbing?5:sprinting?SPRINT_FOOTSTEP_RADIUS:6},!!climbing||sprinting)
        }
      } else this.stepTime=0
      this.safePosition.copy(body.position); this.safeQuaternion.copy(this.camera.perspective.quaternion)
      this.interactionTime=Math.max(0,this.interactionTime-dt)
    } else if (deathPlaying && role === 'solo') {
      // Losing player control does not pause the world. Finish blood flight,
      // corpse animations and NPC movement until the actual menu opens.
      this.player.world.refresh()
      this.ai.update(dt, { feet: this.player.body.position, eye: this.camera.perspective.position,
        velocity: this.player.body.velocity, alive: false, radioEnabled: false,
        yaw: new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y })
      this.escort?.update(dt, this.state, this.player.body.position, true)
      this.blood.update(dt); this.impacts.update(dt); this.updateCrates(dt)
      this.security.sync(this.state, this.state.elapsed + this.death.elapsed)
      this.updateJeepDoor(dt)
    }
    if (role === 'host') this.hostStep(dt)
    else if (role === 'guest') this.guestStep(dt)
    const reactionActive = this.isActive() && this.state.jeep !== 'escaping'
    const hitPose = this.playerHits.update(reactionActive ? dt : 0,
      new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion,'YXZ').y, this.hud.reducedMotion)
    if (reactionActive) {
      this.playerHits.applyCamera(this.camera.perspective, this.player.world, 1 / this.weapons.magnification)
    }
    // A lethal AI hit can start the sequence inside this very update.
    deathVisible = this.death.active && this.player.enabled && !this.player.immersive
    if (deathVisible) {
      if (this.death.update(document.hidden ? 0 : dt, this.camera.perspective, this.player.world)) this.audio.play({ kind: 'player-fall' })
      this.weapons.updateDeath(this.death.elapsed, this.death.reducedMotion, this.death.hitKick, this.death.hitSide)
      this.hud.setDeath(this.death)
    } else {
      if (this.death.active) { this.death.reset(); this.weapons.resetDeath(); this.hud.clearDeath() }
      const body = this.player.body
      this.steadiness.update(reactionActive ? dt : 0, { speed: Math.hypot(body.velocity.x, body.velocity.z), airborne: !body.grounded && !this.player.actions.traversing,
        stance: body.stance, aiming: this.aiming && this.weapons.canAim, scoped: this.weapons.scoped, weapon: this.weapons.current?.name ?? null, reducedMotion: this.hud.reducedMotion })
      const handsFree = reactionActive && this.interactionTime === 0 && !this.player.actions.traversing
      const eye = this.camera.perspective.getWorldPosition(new THREE.Vector3())
      if (this.grenades?.update(dt, { active: handsFree, eye, forward: this.camera.perspective.getWorldDirection(new THREE.Vector3()),
        velocity: this.player.body.velocity, reducedMotion: this.hud.reducedMotion })) this.invalidate()
      // With a grenade out the guns are put away.
      this.weapons.update(dt,{active:reactionActive&&this.interactionTime===0&&!this.grenades?.equipped,climbing:this.player.actions.traversing,
        moving:this.player.body.velocity.length(),aiming:this.aiming,reducedMotion:this.hud.reducedMotion,feet:this.player.body.position,hitPose,
        aimOffset:this.steadiness.sway,spread:this.steadiness.spread})
      this.showAimOffset()
    }
    this.audio.update(this.camera.perspective)
    this.audio.setAlarm(this.isActive() && this.state.alarm === 'active',
      this.state.alarmPosition ? new THREE.Vector3(...this.state.alarmPosition) : undefined)
    this.hud.setScoped(this.weapons.scoped, this.weapons.scopeMagnification)
    if(active || deathPlaying) {
      this.bulletTrails.update(dt)
      this.hitFlash-=dt
    }
    this.tutorial?.frame(dt, this.player.playing && this.player.enabled && !this.player.immersive)
    this.checkWon()
    const tagsShown = this.player.playing && this.player.enabled && !this.player.immersive
    const seen = (point: THREE.Vector3, target: THREE.Object3D) => this.player.world.visible(this.camera.perspective.position, point, target)
    this.bossTags?.update(dt, this.camera.perspective, this.ai.enemies as never, tagsShown, seen)
    this.statusTags?.update(dt, this.camera.perspective, this.ai.enemies as never, tagsShown, seen)
    this.charges?.update(this.player.playing ? dt : 0, this.state, this.player.body.position, this.role !== 'guest',
      this.player.playing && this.player.enabled && !this.player.immersive, this.hud.reducedMotion)
    if (this.charges) this.syncCollectibles()
    const crosshair=document.querySelector<HTMLElement>('.crosshair')!
    crosshair.classList.toggle('confirmed-hit', this.hitFlash > 0)
    this.hud.update(dt,this.state,{playing:this.player.playing,enabled:this.player.enabled&&!this.player.immersive,
      weapon:this.grenades?.equipped ? null : this.weapons.current,reloading:this.weapons.reloading,
      position:this.player.body.position,yaw:new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion,'YXZ').y,deaths:this.deaths,ready:this.ready,
      phase:this.ai.phaseStatus?.()})
    // A hostage just killed: keep drawing while he falls (and his blood spreads), until the failure page.
    const failing = performance.now() < this.failingUntil
    if (failing && !active) {
      this.captives?.update(dt, this.state)
      this.escort?.follow(dt, this.state, false)
      this.blood.update(dt)
    }
    return active || this.death.running || coop || failing
  }

  /** 'solo' until a co-op room is open; then the host runs the compound and guests mirror it. */
  get role(): 'solo' | 'host' | 'guest' { return this.coop?.active ? this.coop.hub.role : 'solo' }

  /** Move the crosshair (and a sniper scope) to where the drifting aim will actually send a shot. */
  private showAimOffset() {
    const camera = this.camera.perspective, forward = camera.getWorldDirection(new THREE.Vector3())
    const point = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(offsetDirection(forward, this.steadiness.sway), 10).project(camera)
    this.hud.setAimOffset(point.x, point.y)
  }

  private updateJeepDoor(dt: number) {
    if (!this.world.rescue) return
    const hostage = this.state.hostages[0]
    updateRescueJeepDoor(this.world.rescue.jeep, hostage.position, hostage.status === 'loaded', dt)
  }

  private coopMessage(message: CoopMessage) {
    const role = this.role, self = this.coop.hub.selfId
    switch (message.t) {
      case 'pose': this.teammates.pose(message.id, message.pose); this.remote.set(message.id, message.pose); break
      case 'shot':
        this.teammates.shot(message.id, message.origin, message.end, message.weapon)
        if (role === 'host') this.guestShot(new THREE.Vector3(...message.origin), new THREE.Vector3(...message.end), message.weapon)
        break
      case 'leave': this.teammates.remove(message.id); this.remote.delete(message.id); break
      case 'hit': if (role === 'host') this.guestHit(message.id, message.hit); break
      case 'crate': if (role === 'host') this.hitCrate(message.crate, message.damage); break
      case 'radio': if (role === 'host') this.hitRadio(message.radio); break
      case 'noise': if (role === 'host') this.ai.hear({ kind: message.kind, position: new THREE.Vector3(...message.position), radius: message.radius }); break
      case 'door': {
        const door = this.player.actions.doors[message.i]
        if (role === 'host' && door && !door.userData.missionLocked) {
          const feet = this.remote.get(message.id)?.feet
          setDoorOpen(door, message.open, false, feet ? new THREE.Vector3(...feet) : undefined)
        }
        break
      }
      case 'use': if (role === 'host') this.guestUse(message.id, message.kind, message.station); break
      case 'world': if (role === 'guest') this.applyWorld(message); break
      case 'efire': if (role === 'guest') this.guestFire(message.i, new THREE.Vector3(...message.end)); break
      case 'ereact': {
        const reaction = role === 'guest' ? this.ai.replayReaction(message.r) : null
        if (reaction) { this.blood.emitHit(reaction); if (reaction.by === self) this.audio.confirmHit(reaction) }
        break
      }
      case 'sound': if (role === 'guest') this.emit(soundEvent(message.e), false); break
      case 'drop': if (role === 'guest') this.weapons.addPickup(message.item); break
      case 'restart': if (role === 'guest') this.restart(); break
      case 'damage':
        if (role === 'guest' && message.to === self) this.damage(message.amount, new THREE.Vector3(...message.source), { region: message.hit.region, side: message.hit.side,
          point: new THREE.Vector3(...message.hit.point), direction: new THREE.Vector3(...message.hit.direction), weapon: message.hit.weapon })
        break
      case 'notice': if (message.to === self) this.hud.notify(message.text, 7); break
    }
    this.invalidate()
  }

  /** A guard's round reaches this player, or is passed to the guest it was fired at. */
  private damageFromGuard(amount: number, source: THREE.Vector3, hit?: PlayerBulletHit, playerId?: number) {
    if (playerId === undefined || this.role !== 'host' || playerId === this.coop.hub.selfId) return this.damage(amount, source, hit)
    if (hit) this.coop.hub.sendTo(playerId, { t: 'damage', to: playerId, amount, source: source.toArray() as Vec3, hit: { region: hit.region, side: hit.side,
      point: hit.point.toArray() as Vec3, direction: hit.direction.toArray() as Vec3, weapon: hit.weapon } })
  }

  /** Every player the host's guards and cameras can notice. Paused or fallen players are left alone. */
  private coopPlayers(): PlayerSense[] {
    const local: PlayerSense = { id: this.coop.hub.selfId, feet: this.player.body.position, eye: this.camera.perspective.position, velocity: this.player.body.velocity,
      alive: this.isActive(), radioEnabled: true, yaw: new THREE.Euler().setFromQuaternion(this.camera.perspective.quaternion, 'YXZ').y }
    return [local, ...[...this.remote].map(([id, pose]) => ({ id, feet: new THREE.Vector3(...pose.feet), eye: new THREE.Vector3(...pose.eye),
      velocity: new THREE.Vector3(...pose.vel), alive: pose.alive && pose.active, radioEnabled: true, yaw: pose.yaw }))]
  }

  /** Hostages follow whichever player is closest to them. */
  private escortLeader(players: PlayerSense[]) {
    const hostage = this.state.hostages.find(candidate => candidate.status === 'following') ?? this.state.hostages[0]
    const position = new THREE.Vector3(...hostage.position)
    let leader = this.player.body.position, distance = Infinity
    for (const player of players) {
      const candidate = player.feet.distanceTo(position)
      if (player.alive && candidate < distance) { leader = player.feet; distance = candidate }
    }
    return leader
  }

  /** Host: run the shared compound for every player, even while this player is paused or down. */
  private hostStep(dt: number) {
    if (!this.ready || !this.player.enabled || this.player.immersive || this.state.phase === 'complete' || dt <= 0) return
    advanceMission(this.state, dt, true)
    const players = this.coopPlayers()
    if (!this.isActive()) this.player.world.refresh()
    this.security.update(dt, this.state, players.filter(player => player.alive).map(player => player.eye), true)
    this.ai.update(dt, players)
    this.escort?.update(dt, this.state, this.escortLeader(players), this.gunfireUntil > this.state.elapsed)
    this.captives?.update(dt, this.state, this.gunfireUntil > this.state.elapsed, players.find(player => player.alive)?.feet)
    this.checkGoals(players.filter(player => player.alive).map(player => player.feet))
    this.updateJeepDoor(dt)
    this.blood.update(dt); this.impacts.update(dt); this.updateCrates(dt)
    this.worldTimer -= dt
    if (this.worldTimer <= 0) this.sendWorld()
  }

  private sendWorld() {
    this.worldTimer = 0.1
    this.coop.send({ t: 'world', mission: sharedMission(this.state), enemies: this.ai.puppets(),
      // 0 closed, 1 open to the door's +Z side, 2 open to its -Z side.
      doors: this.player.actions.doors.map(door => !door.userData.open ? '0' : door.userData.openSide === -1 ? '2' : '1').join(''), cower: this.escort?.cowering ?? false })
  }

  /** Guest: draw the host's compound. Guards and hostages ease between the host's updates. */
  private guestStep(dt: number) {
    if (!this.ready) return
    if (this.state.phase === 'active') advanceMission(this.state, dt)
    this.ai.follow(dt, this.hostEnemies)
    this.escort?.follow(dt, this.state, this.hostCower)
    this.captives?.update(dt, this.state, this.hostCower)
    this.updateJeepDoor(dt)
    this.blood.update(dt); this.impacts.update(dt); this.updateCrates(dt)
    this.security.sync(this.state)
    const now = performance.now()
    if (this.lastWorldAt && now - this.lastWorldAt > 3000 && now - this.waitingNotice > 6000) {
      this.waitingNotice = now
      this.hud.notify('Waiting for the host. Their game tab may be hidden.', 4)
    }
  }

  /** Guest: adopt the host's compound. Doors this player just used keep their state briefly. */
  private applyWorld(message: Extract<CoopMessage, { t: 'world' }>) {
    if (this.escape.active) return
    const shape = () => JSON.stringify([this.state.gateOpen, this.state.camerasOff, this.state.alarm, this.state.hostages.map(hostage => hostage.status), this.state.lampsOut])
    const before = shape(), wasEscaping = this.state.jeep === 'escaping'
    applySharedMission(this.state, message.mission)
    this.hostEnemies = message.enemies; this.hostCower = message.cower
    const now = this.lastWorldAt = performance.now()
    this.player.actions.doors.forEach((door, index) => {
      const open = message.doors[index] !== '0' && message.doors[index] !== undefined, side = message.doors[index] === '2' ? -1 : 1
      const changed = Boolean(door.userData.open) !== open || (open && (door.userData.openSide === -1 ? -1 : 1) !== side)
      if (changed && now - (this.doorHold.get(index) ?? -Infinity) > 1500) setDoorOpen(door, open, false, side)
    })
    if (shape() !== before) this.syncWorld()
    if (!wasEscaping && this.state.jeep === 'escaping') this.beginEscape()
  }

  /** Host: a guest's round passes guards (they react to it) and may frighten a nearby hostage. */
  private guestShot(origin: THREE.Vector3, end: THREE.Vector3, weapon: Shot['weapon']) {
    if (weapon === 'knife') return
    const distance = origin.distanceTo(end)
    if (distance > 0.01) this.ai.nearMiss({ origin, direction: end.clone().sub(origin).normalize(), range: distance, damage: 0, weapon }, distance)
    if (this.state.hostages.some(hostage => hostage.status === 'following' && origin.distanceTo(new THREE.Vector3(...hostage.position)) < 15)) this.gunfireUntil = this.state.elapsed + 1.1
  }

  /** Host: apply a hit a guest saw on its own screen. */
  private guestHit(id: number, hit: Extract<CoopMessage, { t: 'hit' }>['hit']) {
    const direction = new THREE.Vector3(...hit.direction).normalize()
    this.ai.applyHit({ origin: new THREE.Vector3(...hit.origin), direction, range: hit.distance, damage: hit.damage, weapon: hit.weapon, by: id },
      { index: hit.i, zone: hit.zone, point: new THREE.Vector3(...hit.point), bone: hit.bone as never, distance: hit.distance, direction })
  }

  /** Host: a guest used a shared objective. It works even while the host's own player is down. */
  private guestUse(id: number, kind: StationKind, stationId: string) {
    const station = this.world.stations.find(candidate => candidate.kind === kind && candidate.id === stationId)
    if (!station || kind === 'supply') return
    if (kind === 'jeep' && this.gateOpening()) { this.coop.hub.sendTo(id, { t: 'notice', to: id, text: 'Wait for the exit gate to finish opening.' }); return }
    const phase = this.state.phase
    if (phase === 'dead') this.state.phase = 'active'
    const result = useStation(this.state, kind, stationId)
    if (phase === 'dead') this.state.phase = phase
    if (result.message) this.coop.hub.sendTo(id, { t: 'notice', to: id, text: result.message })
    if (result.changed) this.stationUsed(station)
  }

  /** Guest: replay a guard's shot, with a near-miss crack when it passes close to this player. */
  private guestFire(index: number, end: THREE.Vector3) {
    const muzzle = this.ai.replayFire(index, end)
    if (!muzzle || !this.isActive()) return
    const eye = this.camera.perspective.position
    if (end.distanceTo(eye) < 1.8) return
    const pass = bulletNearMiss(muzzle, end, eye)
    if (pass && this.player.world.visible(pass.point, eye, this.camera.perspective)) this.emit({ kind: 'enemy-bullet-whiz', position: pass.point, source: muzzle, intensity: pass.intensity, radius: 5 }, false)
  }

  /** Co-op: a fallen player returns to the insertion point while the shared compound carries on. */
  private respawn() {
    if (this.escape.active || this.state.phase === 'complete') return
    this.death.reset(); this.weapons.resetDeath(); this.playerHits.clear()
    this.player.pause(); this.cancelInput(); this.audio.reset()
    this.state.phase = 'active'; this.state.health = PLAYER_HEALTH.max; this.state.lastBulletAt = null
    this.player.movementLocked = false
    this.placeAtInsertion()
    this.hud.reset(); this.syncWorld()
    this.hud.notify('Back at the insertion point. Your team is still out there.', 4)
    this.invalidate()
  }

  /** Draw teammates, and share this player's pose about 15 times a second. */
  private syncCoop(dt: number) {
    this.teammates.update(dt)
    if (!this.coop.active) return this.teammates.count > 0
    this.poseTimer -= dt
    if (this.poseTimer <= 0) {
      this.poseTimer = 1 / 15
      const body = this.player.body, direction = this.camera.perspective.getWorldDirection(new THREE.Vector3())
      this.coop.send({ t: 'pose', id: this.coop.hub.selfId, pose: {
        feet: body.position.toArray() as Vec3, yaw: Math.atan2(direction.x, direction.z), pitch: Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)),
        speed: Math.hypot(body.velocity.x, body.velocity.z), weapon: this.weapons.current?.name ?? null,
        aiming: this.aiming, alive: this.state.phase !== 'dead', active: this.isActive(),
        eye: this.camera.perspective.position.toArray() as Vec3, vel: body.velocity.toArray() as Vec3 } })
    }
    return true
  }

  finishFrame() { this.playerHits.removeCamera(); this.lean.remove() }
  dispose() { this.tutorial?.dispose();this.grenades.dispose();this.coopPanel.dispose();this.coop.dispose();this.teammates.dispose();this.escape.reset(this.camera.perspective);this.escapeDust.dispose();this.playerHits.clear();this.disposed=true;this.abort.abort();this.bulletTrails.dispose();this.escort?.dispose();this.captives?.dispose();this.bossTags?.dispose();this.statusTags?.dispose();this.charges?.dispose();this.weapons.dispose();this.ai.dispose();this.blood.dispose();this.impacts.dispose();this.crates.dispose();this.lamps.dispose();this.beacons.dispose();this.intro.clear();this.radios.dispose();this.audio.dispose();this.hud.dispose();this.player.movementLocked=false;this.player.onPlayingChange=()=>{};this.player.lookSensitivity=()=>1;this.player.speedScale=()=>1;this.player.actions.extraTargets=()=>[];this.player.actions.onAction=()=>{} }
}

const netSound = (event: SoundEvent): NetSound => ({ kind: event.kind, position: event.position?.toArray() as Vec3 | undefined, radius: event.radius, text: event.text,
  voice: event.voice, speaker: event.speaker, zone: event.zone, weapon: event.weapon, intensity: event.intensity })
const soundEvent = (sound: NetSound): SoundEvent => ({ ...sound, position: sound.position ? new THREE.Vector3(...sound.position) : undefined })
