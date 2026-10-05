import * as THREE from 'three'
import { applyPenMaterial, penPalette } from '../render/ballpoint'
import { loadStickman, BONE_NAMES, type Rig } from '../lab/rig'
import { Player } from '../lab/player'
import { makeClip, poseQuat, type Pose } from '../lab/clip'
import type { Posture } from '../lab/postures'
import { GAIT_SPEED } from '../lab/gait'
import { builders, disposeGun, type Gun, type GunName } from '../lab/weapons/models'
import { createMissionGun } from './weapon-models'
import { supportHand } from '../lab/weapons/support'
import { AnimatedHitVolumes, mirrorReactionClip } from './hit-reactions'
import { bloodPalette } from '../lab/fx/blood-stamps'
import { createPenLines, createPenSilhouette } from '../render/ballpoint'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { BOSS_RULES } from './balance'
import { BOSS_LOOKS, wearBossLook, wearRiggedBody, type BossLook, type RiggedBody } from './boss-models'
import type { EnemyState, WeaponName } from './types'

type Library = {
  clips: Record<string, THREE.AnimationClip>
  poses: typeof import('../lab/weapons/poses')
  postures: typeof import('../lab/postures')
  hang: import('../lab/clip').Pose
}
export type ActorPostureSnapshot = {
  posture: Posture
  transition?: ReturnType<typeof THREE.AnimationClip.toJSON>
  transitionTime?: number
  deathDirection?: [number, number, number]
  deathTravelScale?: number
  deathClip?: ReturnType<typeof THREE.AnimationClip.toJSON>
}
let library: Promise<Library> | undefined

/** The lab builds clips from the loaded rest skeleton, so imports intentionally follow loadStickman. */
async function animations(rig: Rig): Promise<Library> {
  return library ??= Promise.all([
    import('../lab/clips/idle'), import('../lab/clips/locomotion'),
    import('../lab/clips/behavior'), import('../lab/clips/damage'), import('../lab/weapons/poses'), import('../lab/postures'),
  ]).then(([idle, motion, behavior, damage, poses, postures]) => {
    const clips: Record<string, THREE.AnimationClip> = { ...idle.clips, ...motion.clips, ...behavior.clips, ...damage.clips }
    for (const name of ['flinchArm', 'flinchLeg', 'dieArm', 'dieLeg']) clips[`${name}Left`] = mirrorReactionClip(clips[name], rig)
    // The lab turns the root by 60 degrees at once and cancels that with a hips twist.
    // Mission steering rotates continuously: retain its planted foot steps without that cancellation.
    for (const name of ['turnL', 'turnR']) {
      const clip = clips[name].clone()
      const track = clip.tracks.find(track => track.name === `${rig.bones.hips.name}.quaternion`)
      const rest = poseQuat('hips', [0, 0, 0]), inverse = rest.clone().invert()
      if (track) for (let i = 0; i < track.values.length; i += 4) {
        const rotation = new THREE.Quaternion().fromArray(track.values, i).premultiply(inverse)
        const euler = new THREE.Euler().setFromQuaternion(rotation, 'ZYX')
        euler.y = 0
        rest.clone().multiply(rotation.setFromEuler(euler)).toArray(track.values, i)
      }
      clips[name] = clip
    }
    return { clips, poses, postures, hang: idle.hang }
  })
}

/** Ink-grey gear: his helmet, vest and pouches. Ignores light, like his body. */
/** The radio pack on a radioman's back: its size (m, width × height × depth), how high its middle sits and how far behind his chest. */
export const RADIO_PACK = { size: [0.3, 0.38, 0.15] as const, height: 1.2, behind: 0.2 }
const packInverse = new THREE.Matrix4(), packOrigin = new THREE.Vector3(), packEnd = new THREE.Vector3()
/** How long a guard's knife stab takes (s): the draw back, the thrust and the recovery. */
export const STAB_TIME = 0.5
const bossGrey = () => Object.assign(new THREE.MeshBasicMaterial({ color: penPalette.light, toneMapped: false }), { defines: { NEON_UNLIT: '' } })

/** A real independently loaded lab skeleton, with isolated solid black materials. */
export class EnemyActor {
  readonly root: THREE.Group
  readonly player: Player
  /** A boss body rigged in Blender, following his skeleton (see wearLook). */
  private body: RiggedBody | null = null
  /** Bring a Blender-rigged body into his current pose; public for the lab, which drives no update. */
  followLook() { this.body?.follow() }
  /** The gun in his right hand; a boss may swap it for his own (see carry). */
  gun: Gun
  private material: THREE.MeshBasicMaterial
  private outlineMaterials: THREE.Material[] = []
  private mode = ''
  private dead = false
  private kick = 0
  private flash: THREE.Mesh
  private armPose = new Map<string, THREE.Quaternion>()
  private displayedArmPose = new Map<string, THREE.Quaternion>()
  private lastPitch = Infinity
  private lastAim = false
  private lastReady = false
  private scanBlend = 0
  private scanProgress = 0
  private idlePhase = 0
  private reacting = 0
  private previousYaw = 0
  private bodyPosture: Posture = 'stand'
  private postureTransition: THREE.AnimationClip | null = null
  private deathAnimation: THREE.AnimationClip | null = null
  private deathDirection?: [number, number, number]
  private deathTravelScale = 1
  private transientClips = new Set<THREE.AnimationClip>()
  readonly hitVolumes: AnimatedHitVolumes
  private readonly upperBody: THREE.Bone[]
  private readonly arms: THREE.Bone[]
  deathClip = 'dieBody'
  /** The head was blown off by a gunshot: it is not drawn, and a stump shows on the neck. */
  headless = false
  private stump: THREE.Mesh | null = null
  /** The knife is out (drawKnife), and how far through a stab he is (s; -1 when not stabbing). */
  private knifeDrawn = false
  private stabTime = -1
  /** The radio set on his back, if he carries his district's radio (wearRadioPack), and its whip antenna. */
  private radioPack: THREE.Mesh | null = null
  private radioAntenna: THREE.Object3D | null = null
  /** The combat helmet an adapted garrison wears (wearHelmet), made on first use. */
  private guardHelmet: THREE.Group | null = null
  private readonly headUniforms = { headGone: { value: 0 }, headBone: { value: 0 } }
  /**
   * The boss's armour plates: where each one is worn, how it flies once knocked off, and `at`, the fraction of his
   * armour left when it comes off (0: only when the armour breaks).
   */
  private plates: { object: THREE.Object3D; parent: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; at: number; off: boolean }[] = []
  private falling: { object: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; floor: number }[] = []
  armorBroken = false

  private constructor(readonly rig: Rig, private lib: Library, readonly weapon: WeaponName, color: number) {
    this.root = rig.root
    this.root.name = 'Black stickman guard'
    this.root.userData.actor = true
    this.root.userData.noCollision = true
    // Each independently loaded guard starts its idle cycle at a different phase.
    this.idlePhase = (this.root.id * 0.61803398875 % 1) * 6.4
    this.player = new Player(this.root)
    this.hitVolumes = new AnimatedHitVolumes(rig)
    this.upperBody = [rig.bones.head, rig.bones.chest, rig.bones.spine]
    this.arms = lib.poses.armBones.map(name => rig.bones[name])
    const original = rig.mesh.material as THREE.MeshBasicMaterial
    this.material = original.clone()
    // Material.clone does not preserve callbacks. Keep the original dual-quaternion shader setup.
    // A blown-off head is cut away in the shader: every pixel of skin bound mostly to the head bone is dropped,
    // and the stump (see burstHead) caps the neck. Nothing moves, so nothing stretches.
    const skinned = original.onBeforeCompile
    this.material.onBeforeCompile = (shader, renderer) => {
      skinned.call(this.material, shader, renderer)
      Object.assign(shader.uniforms, this.headUniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float headBone;\nvarying float vHeadWeight;')
        .replace('#include <project_vertex>', `#ifdef USE_SKINNING
          vHeadWeight = dot( vec4( lessThan( abs( skinIndex - headBone ), vec4( 0.5 ) ) ), skinWeight );
        #else
          vHeadWeight = 0.0;
        #endif
        #include <project_vertex>`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float headGone;\nvarying float vHeadWeight;')
        .replace('#include <clipping_planes_fragment>', 'if ( headGone > 0.5 && vHeadWeight > 0.4 ) discard;\n#include <clipping_planes_fragment>')
    }
    this.material.customProgramCacheKey = () => `${original.customProgramCacheKey()}|head-burst-v2`
    // Nor does it copy defines: characters stay solid black under any light.
    this.material.defines = { ...original.defines }
    this.material.color.setHex(color)
    this.material.toneMapped = false
    this.material.depthTest = this.material.depthWrite = true
    rig.mesh.material = this.material
    this.root.traverse(object => {
      if (object instanceof THREE.SkinnedMesh && object !== rig.mesh) {
        // The opaque black body already supplies a clean silhouette.
        object.visible = false
      }
    })
    this.gun = createMissionGun(weapon)
    this.gun.position.copy(lib.poses.mountPosition)
    this.gun.quaternion.copy(lib.poses.mountQuaternion)
    rig.bones['hand.R'].add(this.gun)
    const flashMaterial = applyPenMaterial(new THREE.MeshBasicMaterial({ color: penPalette.ink, toneMapped: false }), { density: 0.5, scale: 90, seed: 617 })
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 4), flashMaterial)
    this.flash.position.copy(this.gun.userData.muzzle)
    this.flash.scale.set(0.65, 0.65, 1.7)
    this.flash.visible = false
    this.gun.add(this.flash)
    this.outlineMaterials.push(flashMaterial)
    this.update(0, 'guard', false)
  }

  /** Guards are solid black; co-op teammates reuse the same rig in their team colour. */
  static async create(weapon: WeaponName, color: number = penPalette.character) {
    const rig = await loadStickman()
    return new EnemyActor(rig, await animations(rig), weapon, color)
  }

  /**
   * Turn this guard into the boss, Bulky Boy: a riot breacher, the same solid-black stickman as every guard at twice
   * the size, with his own hands and feet, in ink-grey gear fitted to his body: a combat helmet, a plate vest and a row
   * of pouches. He carries an AK like his guards. His gear
   * is his armour: the pouches are shot off first, then the helmet, and the vest when it breaks (see armorLeft). Every part is built in the root's units and handed
   * to its bone so it moves with him; all of it ignores light, like his body.
   */
  makeBoss() {
    this.root.scale.setScalar(BOSS_RULES.scale)
    this.hitVolumes.girth = 1.35
    this.root.updateMatrixWorld(true)
    const grey = bossGrey()
    /** Hand a part built in the root's units to a bone, so it moves with him; `drops` makes it an armour plate. */
    const wear = (bone: keyof Rig['bones'], object: THREE.Object3D, name: string, drops?: number) => {
      object.name = `Boss ${name}`
      object.userData.noCollision = true
      this.root.add(object)
      this.rig.bones[bone].attach(object)
      if (drops !== undefined) this.plates.push({ object, parent: object.parent!, position: object.position.clone(), quaternion: object.quaternion.clone(),
        scale: object.scale.clone(), at: drops, off: false })
      return object
    }
    const outlined = (geometry: THREE.BufferGeometry, width = 2.2) => {
      const part = new THREE.Mesh(geometry, grey)
      part.add(createPenSilhouette(geometry, width))
      return part
    }
    // A combat helmet fitted close over the top of his head (a ball about 0.24 round, centred 1.505 up), with a lip
    // round its rim and a strap line down to the jaw. His black face shows below it.
    const helmet = new THREE.Group()
    helmet.position.set(0, 1.505, this.root.worldToLocal(this.rig.bones.head.getWorldPosition(new THREE.Vector3())).z)
    const shell = outlined(new THREE.SphereGeometry(0.262, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), 2.3)
    shell.position.y = 0.01
    shell.scale.set(1, 0.92, 1.06)
    const lip = outlined(new THREE.TorusGeometry(0.268, 0.014, 8, 36).rotateX(Math.PI / 2), 1.6)
    lip.position.y = 0.0
    lip.scale.set(1, 1, 1.06)
    helmet.add(shell, lip)
    for (const side of [-1, 1]) helmet.add(createPenLines([new THREE.Vector3(side * 0.25, 0, 0.06), new THREE.Vector3(side * 0.2, -0.12, 0.1), new THREE.Vector3(side * 0.12, -0.2, 0.13)], 4450 + side, 'detail', 1.3))
    wear('head', helmet, 'helmet', 1 / 3)
    // A plate vest fitted round his chest (his torso is about 0.25 wide and 0.23 deep), seamed down the sides.
    const vest = new THREE.Group()
    vest.position.set(0, 1.01, 0)
    vest.add(outlined(new RoundedBoxGeometry(0.31, 0.37, 0.29, 4, 0.07), 2.4))
    for (const side of [-1, 1]) vest.add(createPenLines([new THREE.Vector3(side * 0.156, 0.16, 0), new THREE.Vector3(side * 0.156, -0.16, 0)], 4460 + side, 'detail', 1.2))
    vest.add(createPenLines([new THREE.Vector3(-0.1, 0.12, 0.147), new THREE.Vector3(0.1, 0.12, 0.147)], 4463, 'detail', 1.2))
    wear('chest', vest, 'vest', 0)
    // Three pouches across the front of the vest, the first gear to be shot off him.
    const pouches = new THREE.Group()
    pouches.position.set(0, 0.92, 0.158)
    for (const x of [-0.088, 0, 0.088]) {
      const pouch = outlined(new RoundedBoxGeometry(0.075, 0.09, 0.05, 2, 0.012), 1.6)
      pouch.position.x = x
      pouches.add(pouch, createPenLines([new THREE.Vector3(x - 0.036, 0.025, 0.026), new THREE.Vector3(x + 0.036, 0.025, 0.026)], 4470 + Math.round(x * 100), 'detail', 1))
    }
    wear('chest', pouches, 'pouches', 2 / 3)
  }

  /**
   * Wears a boss body modelled with Rodin (boss-models.ts) in place of the stickman, on the same skeleton, so every
   * clip and hit volume works as before. Call after makeBoss: the armour mechanics stay, but the worn gear is hidden
   * under the new body.
   */
  async wearLook(look: BossLook) {
    // Rigged in Blender: his own skeleton follows the stickman's. Otherwise the model is fitted to the stickman here.
    const rigged = BOSS_LOOKS[look].rigged
    if (rigged) this.body = await wearRiggedBody(this.rig, rigged)
    else await wearBossLook(this.rig, look)
    for (const plate of this.plates) plate.object.visible = false
    const weapon = BOSS_LOOKS[look].weapon
    if (weapon) this.carry(weapon)
  }

  /**
   * Swaps the gun in his hand for another model (a boss's own weapon): same grip, the muzzle flash moved to its
   * muzzle. Only the look changes; how he fights is still his spec's weapon.
   */
  carry(name: GunName) {
    const old = this.gun, hand = old.parent!, visible = old.visible
    const gun = builders[name]()
    gun.position.copy(old.position); gun.quaternion.copy(old.quaternion); gun.visible = visible
    old.remove(this.flash)
    hand.remove(old)
    disposeGun(old)
    this.flash.position.copy(gun.userData.muzzle)
    gun.add(this.flash)
    hand.add(gun)
    this.gun = gun
  }

  /**
   * The armour wears away: with `left` of it remaining (0 to 1), every plate due to come off by then flies off and
   * clatters to the ground. `instant` lays them there at once (checkpoints).
   */
  armorLeft(left: number, instant = false) {
    const world = this.root.parent ?? this.root
    const floor = this.root.position.y + 0.04
    for (const plate of this.plates) {
      if (plate.off || left > plate.at) continue
      plate.off = true
      world.attach(plate.object)
      const velocity = new THREE.Vector3((Math.random() - 0.5) * 3, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 3)
      const spin = new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9)
      this.falling.push({ object: plate.object, velocity, spin, floor })
    }
    if (instant) for (let i = 0; i < 120; i++) this.dropPlates(1 / 30)
  }

  /** Knock the last of the armour off. `instant` lays the plates on the ground at once (checkpoints). */
  breakArmor(instant = false) {
    if (this.armorBroken || !this.plates.length) return
    this.armorBroken = true
    this.armorLeft(0, instant)
  }

  /** The knocked-off plates fall, spinning, and stay where they land. Public for the lab, which drives no update. */
  dropPlates(dt: number) {
    for (const plate of this.falling) {
      if (plate.velocity.lengthSq() === 0) continue
      plate.velocity.y -= 9.8 * dt
      plate.object.position.addScaledVector(plate.velocity, dt)
      plate.object.rotation.x += plate.spin.x * dt; plate.object.rotation.y += plate.spin.y * dt; plate.object.rotation.z += plate.spin.z * dt
      if (plate.object.position.y <= plate.floor) { plate.object.position.y = plate.floor; plate.velocity.set(0, 0, 0) }
    }
  }

  /** Every plate back on, as worn (checkpoint restore). */
  private refitArmor() {
    if (!this.plates.some(plate => plate.off)) return
    this.armorBroken = false
    this.falling = []
    for (const plate of this.plates) {
      plate.off = false
      plate.parent.add(plate.object)
      plate.object.position.copy(plate.position); plate.object.quaternion.copy(plate.quaternion); plate.object.scale.copy(plate.scale)
    }
  }

  update(dt: number, state: EnemyState, moving: boolean, aim?: THREE.Vector3, speed = moving ? 1.4 : 0) {
    if (this.falling.length) this.dropPlates(Math.max(0, Math.min(dt, 0.05)))
    const aimOrigin = aim && this.bodyPosture !== 'stand' ? this.muzzle() : null
    const yawDelta = Math.atan2(Math.sin(this.root.rotation.y - this.previousYaw), Math.cos(this.root.rotation.y - this.previousYaw))
    this.previousYaw = this.root.rotation.y
    if (state === 'dead') {
      if (!this.dead) {
        this.dead = true
        this.gun.visible = false
        this.mode = this.deathClip
        this.reacting = 0
        this.postureTransition = null
        void this.player.play(this.deathAnimation ?? this.lib.clips[this.deathClip] ?? this.lib.clips.dieBody, { once: true, fade: this.deathAnimation ? 0 : 0.06 })
      }
      this.player.update(dt)
      if (this.headless) this.collapseHead()
      return
    }
    if (this.dead) {
      this.dead = false
      this.mode = ''
      this.gun.visible = true
      this.rig.resetPose()
    }
    // Navigation requests an upright recovery before restarting the shared gait.
    if (moving && this.bodyPosture !== 'stand') this.setPosture('stand')
    if (this.postureTransition && this.postureTransitionRemaining <= 0) {
      this.postureTransition = null
      this.mode = ''
      this.lastPitch = Infinity
    }
    let transitioning = !!this.postureTransition
    const turning = !moving && dt > 0 && Math.abs(yawDelta) > 0.001
    const scan = this.root.userData.alertScan
    const scanning = state === 'suspicious' && typeof scan === 'number' && Number.isFinite(scan)
    if (scanning) this.scanProgress = THREE.MathUtils.clamp(scan, 0, 1)
    this.scanBlend = THREE.MathUtils.lerp(this.scanBlend, scanning ? 1 : 0, 1 - Math.exp(-Math.max(0, dt) / 0.1))
    // Tracking a target requires small turns; keep the gun raised through them.
    // Otherwise every steering correction toggles the arms between aim and carry.
    const aimed = !moving && (state === 'combat' || this.bodyPosture === 'prone' || state === 'suspicious' && !scanning)
    const ready = !aimed && (scanning || state === 'search' || state === 'investigate')
    const looking = !scanning && ['guard', 'idle', 'patrol', 'search', 'investigate'].includes(state)
    const mode = this.bodyPosture !== 'stand' ? `posture_${this.bodyPosture}` : moving ? (speed >= 1.8 ? 'run' : 'walk') : turning ? (yawDelta > 0 ? 'turnL' : 'turnR') : looking ? 'lookRelaxed' : 'idle'
    if (this.reacting > 0) {
      this.reacting -= dt
      if (this.reacting <= 0) {
        this.mode = ''
        if (this.bodyPosture !== 'stand') { this.setPosture(this.bodyPosture); transitioning = true }
      }
    } else if (!transitioning && mode !== this.mode) {
      this.mode = mode
      void this.player.play(this.bodyPosture !== 'stand' ? this.lib.postures.postureClips[this.bodyPosture] : this.lib.clips[mode],
        { fade: 0.22, poseFade: true })
      if (mode === 'lookRelaxed' && (state === 'guard' || state === 'patrol' || state === 'idle')) this.player.current!.time = this.idlePhase
    }
    if (this.reacting <= 0 && this.player.current) this.player.setActionSpeed(transitioning || this.bodyPosture !== 'stand' ? 1 : moving ? THREE.MathUtils.clamp(speed / GAIT_SPEED[mode === 'run' ? 'run' : 'walk'], 0.35, 1.8) : turning ? THREE.MathUtils.clamp(Math.abs(yawDelta) / dt / 2.1, 0.6, 1.8) : 1)
    this.player.update(dt)
    if (this.reacting <= 0 && !transitioning) {
      // Frame-local upper-body motion leaves authored feet and navigation untouched.
      // adjustBones restores the mixer pose before the next frame, preventing drift.
      const { head, chest, spine } = this.rig.bones
      this.player.adjustBones(this.upperBody, () => {
        const t = this.player.current?.time ?? 0
        if (moving && !aimed) {
          head.rotation.y += Math.sin(t * 1.3 + this.idlePhase) * (ready ? 0.12 : 0.055)
          head.rotation.z += Math.sin(t * 0.85 + this.idlePhase) * 0.02
        }
        if (this.scanBlend > 0.001) {
          const sweep = Math.sin(this.scanProgress * Math.PI * 2), weight = this.scanBlend
          const startle = Math.sin(Math.min(1, this.scanProgress / 0.22) * Math.PI)
          head.rotation.y += sweep * 0.48 * weight
          head.rotation.z += sweep * 0.07 * weight
          head.rotation.x += (0.06 + startle * 0.08) * weight
          chest.rotation.y += sweep * 0.16 * weight
          chest.rotation.x -= startle * 0.045 * weight
          spine.rotation.x += weight * 0.025
        }
      })
    }
    let pitch = 0
    if (aim && aimed) {
      const origin = aimOrigin ?? this.root.localToWorld(new THREE.Vector3(0, 1.22, 0))
      const delta = aim.clone().sub(origin)
      pitch = THREE.MathUtils.clamp(-Math.atan2(delta.y, Math.hypot(delta.x, delta.z)), -0.6, 0.6)
    }
    if (aimed !== this.lastAim || ready !== this.lastReady || Math.abs(pitch - this.lastPitch) > 0.03) {
      this.lastAim = aimed
      this.lastReady = ready
      this.lastPitch = pitch
      const long = this.weapon !== 'pistol' && this.weapon !== 'silenced' && this.weapon !== 'knife'
      // Keep lowered rifles within support-arm reach throughout the chest's scan turn.
      const hold = aimed ? { position: (long ? [-0.185, 1.22, 0.27] : [-0.13, 1.22, 0.55]) as [number, number, number], pitch: pitch * THREE.MathUtils.RAD2DEG } : ready ?
        { position: (long ? [-0.11, 1.10, 0.18] : [-0.16, 1.00, 0.32]) as [number, number, number], pitch: long ? 18 : 32 } :
        { position: (long ? [-0.11, 1.05, 0.18] : [-0.20, 0.705, 0.10]) as [number, number, number], pitch: long ? 24 : 65 }
      const pose = this.lib.poses.heldPose(this.lib.hang, hold, this.gun.userData.support?.toArray() as [number, number, number] | undefined)
      if (this.bodyPosture === 'stand') for (const name of this.lib.poses.armBones) this.armPose.set(name, poseQuat(name, pose[name] ?? [0, 0, 0]))
      else {
        const body = this.lib.postures.postureClips[this.bodyPosture]
        const fitted = this.lib.postures.weaponPosture(makeClip('mission_hold', [{ t: 0, pose }], { duration: 0.001 }), body, 0.001, this.gun.userData.twoHanded)
        for (const name of this.lib.poses.armBones) {
          const track = fitted.tracks.find(track => track.name === `${this.rig.bones[name].name}.quaternion`)!
          this.armPose.set(name, new THREE.Quaternion().fromArray(track.values))
        }
      }
    }
    // A flinch owns the arms for its duration; the held-weapon solve resumes afterwards.
    if (this.reacting <= 0 && !transitioning) this.player.adjustBones(this.arms, () => {
      const blend = 1 - Math.exp(-Math.max(0, dt) / 0.12)
      for (const name of this.lib.poses.armBones) {
        // A pistol occupies only the right hand. Keep the free arm's shared
        // walk/run swing, and remember it for a smooth return to a standing hold.
        if (moving && !this.gun.userData.twoHanded && name.endsWith('.L')) {
          const displayed = this.displayedArmPose.get(name), animated = this.rig.bones[name].quaternion
          if (displayed) displayed.copy(animated)
          else this.displayedArmPose.set(name, animated.clone())
          continue
        }
        const quaternion = this.armPose.get(name)
        if (!quaternion) continue
        let displayed = this.displayedArmPose.get(name)
        if (!displayed) {
          displayed = quaternion.clone()
          this.displayedArmPose.set(name, displayed)
        } else displayed.slerp(quaternion, blend)
        this.rig.bones[name].quaternion.copy(displayed)
      }
      supportHand(this.rig, this.gun)
    })
    else {
      if (transitioning) this.player.adjustBones(this.arms, () => supportHand(this.rig, this.gun))
      // Resume the hold from the flinch's actual arm pose instead of snapping back.
      for (const name of this.lib.poses.armBones) {
        this.displayedArmPose.set(name, this.rig.bones[name].quaternion.clone())
      }
    }
    this.kick = Math.max(0, this.kick - dt)
    this.flash.visible = this.kick > 0.065 && !this.knifeDrawn
    if (this.stabTime >= 0) this.stabPose(dt)
    if (this.kick > 0) this.player.adjustBones([this.rig.bones.chest], () => { this.rig.bones.chest.rotation.x -= this.kick * 0.17 })
    this.player.blendPose(this.bodyPosture === 'stand')
    this.body?.follow()
    // No world-matrix pass here: every reader (eye, muzzle, hit volumes, blood, the renderer) refreshes what it reads.
  }

  // localToWorld refreshes the ancestor chain itself; a whole-rig pass per query was 50 nodes instead of 8.
  muzzle(out = new THREE.Vector3()) {
    return this.gun.localToWorld(out.copy(this.gun.userData.muzzle))
  }

  /** Sight and hit tests use the rendered skeleton, including the whole prone drop. */
  eye(out = new THREE.Vector3()) {
    return this.rig.bones.head.localToWorld(out.set(0, 0.205, 0.10))
  }

  private visiblePose(): Pose {
    const pose: Pose = {}
    for (const name of BONE_NAMES) {
      const relative = this.rig.rest[name].quat.clone().invert().multiply(this.rig.bones[name].quaternion)
      const euler = new THREE.Euler().setFromQuaternion(relative, 'ZYX')
      pose[name] = [euler.x, euler.y, euler.z].map(value => value * THREE.MathUtils.RAD2DEG) as [number, number, number]
    }
    return pose
  }

  /** Bake the rendered start pose into an interruptible action instead of snapping to its authored first frame. */
  private fromVisiblePose(source: THREE.AnimationClip, duration: number) {
    const clip = source.clone()
    for (const track of clip.tracks) {
      const name = BONE_NAMES.find(name => track.name.startsWith(`${this.rig.bones[name].name}.`))
      if (!name) continue
      const quaternion = track instanceof THREE.QuaternionKeyframeTrack
      const start = quaternion ? this.rig.bones[name].quaternion : this.rig.bones[name].position
      if (track.times.length === 1) {
        track.times = new Float32Array([0, duration])
        track.values = new Float32Array([...start.toArray(), ...track.values])
      }
      for (let i = 0; i < track.times.length && track.times[i] < duration; i++) {
        const weight = THREE.MathUtils.smoothstep(track.times[i], 0, duration)
        if (quaternion) new THREE.Quaternion().fromArray(track.values, i * 4).slerp(start as THREE.Quaternion, 1 - weight).toArray(track.values, i * 4)
        else new THREE.Vector3().fromArray(track.values, i * 3).lerp(start as THREE.Vector3, 1 - weight).toArray(track.values, i * 3)
      }
    }
    this.transientClips.add(clip)
    return clip
  }

  setPosture(posture: Posture, scan = false) {
    if (this.dead || !(posture in this.lib.postures.postures)) return
    if (posture === this.bodyPosture && !scan && !this.postureTransition && this.reacting <= 0 && this.mode === `posture_${posture}`) return
    const transition = this.lib.postures.enterPosture(this.rig, posture, scan)
    const long = this.gun.userData.twoHanded
    const aim = this.lib.poses.heldPose(this.lib.hang, {
      position: long ? [-0.185, 1.22, 0.27] : [-0.13, 1.22, 0.55],
      pitch: Number.isFinite(this.lastPitch) ? this.lastPitch * THREE.MathUtils.RAD2DEG : 0,
    }, this.gun.userData.support?.toArray() as [number, number, number] | undefined)
    const source = makeClip('mission_posture_hold', [{ t: 0, pose: aim }], { duration: transition.duration })
    const fitted = this.lib.postures.weaponPosture(source, transition, transition.duration, long)
    fitted.name = transition.name
    this.postureTransition = this.fromVisiblePose(fitted, Math.min(0.12, fitted.duration))
    this.bodyPosture = posture
    this.reacting = 0
    this.mode = this.postureTransition.name
    this.lastPitch = Infinity
    void this.player.play(this.postureTransition, { once: true, fade: 0 })
    this.player.update(0)
    this.root.updateMatrixWorld(true)
    this.releaseTransientClips()
  }

  get posture() { return this.bodyPosture }
  get postureTransitionRemaining() {
    return this.postureTransition && this.player.current?.getClip() === this.postureTransition
      ? Math.max(0, this.postureTransition.duration - this.player.current.time) : 0
  }

  postureSnapshot(): ActorPostureSnapshot {
    return {
      posture: this.bodyPosture,
      ...(this.postureTransition ? { transition: THREE.AnimationClip.toJSON(this.postureTransition), transitionTime: this.player.current?.time ?? 0 } : {}),
      ...(this.deathDirection ? { deathDirection: [...this.deathDirection] as [number, number, number], deathTravelScale: this.deathTravelScale } : {}),
      ...(this.deathAnimation ? { deathClip: THREE.AnimationClip.toJSON(this.deathAnimation) } : {}),
    }
  }

  private releaseTransientClips() {
    for (const clip of this.transientClips) {
      if (clip === this.player.current?.getClip() || clip === this.deathAnimation || clip === this.postureTransition) continue
      this.player.mixer.uncacheClip(clip)
      this.transientClips.delete(clip)
    }
  }

  shoot() { this.kick = 0.11 }

  /**
   * Out of ammunition with no crate left (game/ai.ts): the knife comes out in his gun hand. holsterKnife puts his own
   * gun back (a checkpoint from before he ran dry).
   */
  drawKnife() {
    if (this.knifeDrawn) return
    this.knifeDrawn = true
    this.carry('knife')
  }

  holsterKnife() {
    if (!this.knifeDrawn) return
    this.knifeDrawn = false
    this.carry(this.weapon as GunName)
    this.stabTime = -1
  }

  /** A stab: the arm draws back, then drives the blade forward with the chest turning into it, then recovers. */
  stab() { if (this.knifeDrawn) this.stabTime = 0 }

  private stabPose(dt: number) {
    this.stabTime += dt
    const t = this.stabTime / STAB_TIME
    if (t >= 1) { this.stabTime = -1; return }
    // 0-35%: draw back; 35-55%: drive forward; then back to the hold.
    const back = t < 0.35 ? Math.sin(t / 0.35 * Math.PI / 2) : Math.max(0, 1 - (t - 0.35) / 0.12)
    const drive = t < 0.35 ? 0 : t < 0.55 ? Math.sin((t - 0.35) / 0.2 * Math.PI / 2) : Math.max(0, 1 - (t - 0.55) / 0.45)
    const { chest } = this.rig.bones, upper = this.rig.bones['upper_arm.R'], fore = this.rig.bones['forearm.R']
    this.player.adjustBones([chest, upper, fore], () => {
      chest.rotation.y += 0.28 * back - 0.4 * drive
      upper.rotation.x += 0.7 * back - 1.1 * drive
      fore.rotation.x += 0.9 * back - 0.6 * drive
    })
  }

  /** A non-lethal flinch interrupts locomotion for the clip's length; a lethal clip name is used by the next dead update. */
  react(clip: string, lethal: boolean, direction?: THREE.Vector3, travelScale = 1) {
    if (this.dead) return
    if (lethal) {
      this.deathClip = clip in this.lib.clips ? clip : 'dieBody'
      let animation = this.lib.clips[this.deathClip]
      if (this.deathClip === 'dieShotgun') {
        const travel = direction?.clone() ?? new THREE.Vector3(0, 0, -1).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()))
        travel.y = 0
        if (travel.lengthSq() < 1e-8) travel.set(0, 0, -1).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()))
        travel.normalize()
        this.deathDirection = travel.toArray() as [number, number, number]
        this.deathTravelScale = THREE.MathUtils.clamp(travelScale, 0, 1)
        travel.applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()).invert())
        const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-travel.x, -travel.z))
        animation = animation.clone()
        for (const track of animation.tracks) {
          if (track.name === `${this.rig.bones.hips.name}.position`) for (let i = 0; i < track.values.length; i += 3) {
            const offset = new THREE.Vector3().fromArray(track.values, i).sub(this.rig.rest.hips.pos).applyQuaternion(rotation)
            offset.x *= this.deathTravelScale; offset.z *= this.deathTravelScale
            offset.add(this.rig.rest.hips.pos).toArray(track.values, i)
          }
          // Preserve the authored tumble and grounded contact points. Rotating only
          // the hip's fall axis would drive side/rear-hit arms and legs through the floor.
        }
      } else {
        this.deathDirection = undefined
        this.deathTravelScale = 1
      }
      this.deathAnimation = this.fromVisiblePose(animation, this.deathClip === 'dieShotgun' ? 0.17 : 0.12)
      this.postureTransition = null
      return
    }
    let animation = this.lib.clips[clip]
    if (!animation || this.dead) return
    if (this.bodyPosture !== 'stand' || this.postureTransition) {
      const body = makeClip('mission_hit_posture', [{ t: 0, pose: this.visiblePose(),
        root: this.rig.bones.hips.position.clone().sub(this.rig.rest.hips.pos).toArray() }], { duration: animation.duration })
      const fitted = this.lib.postures.weaponPosture(animation, body, animation.duration, this.gun.userData.twoHanded)
      // Preserve the head/chest impact above the planted lower body, including headshots.
      for (const name of ['spine', 'chest', 'neck', 'head'] as const) {
        const path = `${this.rig.bones[name].name}.quaternion`
        const source = animation.tracks.find(track => track.name === path)!
        const track = source.clone(), first = new THREE.Quaternion().fromArray(source.values).invert()
        for (let i = 0; i < track.values.length; i += 4) {
          const impact = new THREE.Quaternion().fromArray(track.values, i).premultiply(first)
          const pose = this.rig.bones[name].quaternion.clone()
          pose.slerp(pose.clone().multiply(impact), this.bodyPosture === 'prone' ? 0.45 : 0.75).toArray(track.values, i)
        }
        fitted.tracks[fitted.tracks.findIndex(track => track.name === path)] = track
      }
      animation = this.fromVisiblePose(fitted, 0.06)
    }
    this.postureTransition = null
    this.reacting = animation.duration
    this.mode = clip
    void this.player.play(animation, { once: true, fade: 0.05 })
    // Advance into the impact immediately. Repeated same-region hits reset this cached action too.
    this.player.current!.time = Math.min(0.035, animation.duration * 0.1)
    this.player.update(0)
    this.root.updateMatrixWorld(true)
    this.releaseTransientClips()
  }

  /**
   * A combat helmet, once his zone has adapted to you (game/ai.ts, ZONES.adapt): black like him, a shell close over
   * the top of his head with a rim, outlined in ink. It stops one head shot and is knocked off by it (loseHelmet).
   */
  wearHelmet() {
    if (!this.guardHelmet) {
      this.root.updateMatrixWorld(true)
      const black = Object.assign(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }), { defines: { NEON_UNLIT: '' } })
      const helmet = new THREE.Group()
      helmet.name = 'Guard helmet'
      helmet.userData.noCollision = true
      helmet.position.set(0, 1.505, this.root.worldToLocal(this.rig.bones.head.getWorldPosition(new THREE.Vector3())).z)
      const shellGeometry = new THREE.SphereGeometry(0.262, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52)
      const shell = new THREE.Mesh(shellGeometry, black)
      shell.position.y = 0.01
      shell.scale.set(1, 0.92, 1.06)
      shell.add(createPenSilhouette(shellGeometry, 2.3))
      const rimGeometry = new THREE.TorusGeometry(0.27, 0.016, 8, 36).rotateX(Math.PI / 2)
      const rim = new THREE.Mesh(rimGeometry, black)
      rim.scale.set(1, 1, 1.06)
      helmet.add(shell, rim)
      this.root.add(helmet)
      this.rig.bones.head.attach(helmet)
      this.guardHelmet = helmet
    }
    this.guardHelmet.visible = true
  }

  /**
   * His district's radio, on his back (game/ai.ts: the zone's operator): a grey box strapped between his shoulders with
   * a whip antenna, outlined in ink. Shooting it breaks it (breakRadioPack) and his district can no longer call anyone.
   */
  wearRadioPack() {
    if (this.radioPack) { this.radioPack.visible = true; return }
    this.root.updateMatrixWorld(true)
    const grey = Object.assign(new THREE.MeshBasicMaterial({ color: penPalette.light, toneMapped: false }), { defines: { NEON_UNLIT: '' } })
    const geometry = new RoundedBoxGeometry(RADIO_PACK.size[0], RADIO_PACK.size[1], RADIO_PACK.size[2], 2, 0.02)
    const pack = new THREE.Mesh(geometry, grey)
    pack.name = 'Radio pack'
    pack.userData.noCollision = true
    pack.add(createPenSilhouette(geometry, 2.2))
    // Its lid seam and a dial, so it reads as a radio set from behind.
    const [w, h, d] = RADIO_PACK.size
    pack.add(createPenLines([new THREE.Vector3(-w / 2, h * 0.28, -d / 2 - 0.002), new THREE.Vector3(w / 2, h * 0.28, -d / 2 - 0.002)], 4480, 'detail', 1.2))
    pack.add(createPenLines([new THREE.Vector3(-w * 0.25, h * 0.05, -d / 2 - 0.002), new THREE.Vector3(-w * 0.05, h * 0.05, -d / 2 - 0.002)], 4481, 'detail', 1.2))
    const antenna = createPenLines([new THREE.Vector3(w * 0.32, h / 2, 0), new THREE.Vector3(w * 0.36, h / 2 + 0.55, 0.02)], 4482, 'detail', 1.4)
    pack.add(antenna)
    pack.position.set(0, RADIO_PACK.height, this.root.worldToLocal(this.rig.bones.chest.getWorldPosition(new THREE.Vector3())).z - RADIO_PACK.behind)
    this.root.add(pack)
    this.rig.bones.chest.attach(pack)
    this.radioPack = pack
    this.radioAntenna = antenna
  }

  /** Shot through: the antenna gone, the case cracked and hanging askew. */
  breakRadioPack() {
    if (!this.radioPack || this.radioPack.userData.broken) return
    this.radioPack.userData.broken = true
    if (this.radioAntenna) this.radioAntenna.visible = false
    const [w, h, d] = RADIO_PACK.size
    this.radioPack.add(createPenLines([new THREE.Vector3(-w * 0.4, h * 0.35, -d / 2 - 0.003), new THREE.Vector3(-w * 0.1, h * 0.05, -d / 2 - 0.003),
      new THREE.Vector3(-w * 0.2, -h * 0.1, -d / 2 - 0.003), new THREE.Vector3(w * 0.15, -h * 0.35, -d / 2 - 0.003)], 4483, 'detail', 1.6))
    this.radioPack.rotation.z += 0.18
  }

  /** A checkpoint from before the pack was broken (or before he had one). */
  restoreRadioPack(state: 'none' | 'live' | 'broken') {
    if (state === 'none') { if (this.radioPack) this.radioPack.visible = false; return }
    if (this.radioPack?.userData.broken && state === 'live') {
      this.radioPack.removeFromParent()
      this.radioPack = null
    }
    this.wearRadioPack()
    if (state === 'broken') this.breakRadioPack()
  }

  /** How far along a shot (`origin`, unit `direction`) it meets his radio pack, within `far`; null if it misses or he has none. */
  radioPackHit(origin: THREE.Vector3, direction: THREE.Vector3, far: number) {
    const pack = this.radioPack
    if (!pack?.visible || pack.userData.broken) return null
    pack.updateWorldMatrix(true, false)
    const inverse = packInverse.copy(pack.matrixWorld).invert()
    const o = packOrigin.copy(origin).applyMatrix4(inverse), end = packEnd.copy(direction).multiplyScalar(far).add(origin).applyMatrix4(inverse)
    const d = end.sub(o)
    const [w, h, depth] = RADIO_PACK.size
    let near = 0, farT = 1
    for (const [p, v, half] of [[o.x, d.x, w / 2], [o.y, d.y, h / 2], [o.z, d.z, depth / 2]] as const) {
      if (Math.abs(v) < 1e-9) { if (Math.abs(p) > half) return null; continue }
      let t1 = (-half - p) / v, t2 = (half - p) / v
      if (t1 > t2) [t1, t2] = [t2, t1]
      near = Math.max(near, t1); farT = Math.min(farT, t2)
      if (near > farT) return null
    }
    return near * far
  }

  /** The helmet knocked off by a head shot (or not worn after a checkpoint from before he had one). */
  loseHelmet() {
    if (this.guardHelmet) this.guardHelmet.visible = false
  }

  /** Blow the head off: the head disappears, leaving a bloody stump on the neck. */
  burstHead() {
    this.headless = true
    if (!this.stump) {
      const { head, neck } = this.rig.bones
      const scale = this.root.getWorldScale(new THREE.Vector3()).x || 1
      this.stump = new THREE.Mesh(new THREE.SphereGeometry(0.075 / scale, 14, 10),
        new THREE.MeshBasicMaterial({ color: bloodPalette.fresh, toneMapped: false }))
      this.stump.name = 'Neck stump'
      this.stump.scale.y = 0.7
      this.stump.position.copy(head.position)
      neck.add(this.stump)
    }
    this.stump.visible = true
    this.collapseHead()
  }

  private collapseHead() {
    this.headUniforms.headGone.value = 1
    this.headUniforms.headBone.value = this.rig.mesh.skeleton.bones.indexOf(this.rig.bones.head)
  }

  private restoreHead() {
    this.headless = false
    this.headUniforms.headGone.value = 0
    if (this.stump) this.stump.visible = false
  }

  /** Set a corpse immediately during a checkpoint restore, without creating a second dropped item. */
  restore(state: EnemyState, animationTime = 0, deathClip = 'dieBody', posture?: ActorPostureSnapshot) {
    this.restoreHead()
    this.refitArmor()
    // Parsed clips retain their UUIDs. Evict the previous actions before parsing a
    // checkpoint, or the mixer can return an old action for the new clip object.
    this.player.stop(0)
    this.player.mixer.stopAllAction()
    for (const clip of this.transientClips) this.player.mixer.uncacheClip(clip)
    this.transientClips.clear()
    this.dead = false
    this.gun.visible = state !== 'dead'
    this.mode = ''
    this.kick = 0
    this.reacting = 0
    this.previousYaw = this.root.rotation.y
    this.lastAim = false
    this.lastReady = false
    this.scanBlend = 0
    this.scanProgress = 0
    this.lastPitch = Infinity
    this.armPose.clear()
    this.displayedArmPose.clear()
    this.bodyPosture = posture && posture.posture in this.lib.postures.postures ? posture.posture : 'stand'
    this.postureTransition = null
    this.deathDirection = posture?.deathDirection
    this.deathTravelScale = posture?.deathTravelScale ?? 1
    this.deathAnimation = posture?.deathClip ? THREE.AnimationClip.parse(posture.deathClip) : null
    if (this.deathAnimation) this.transientClips.add(this.deathAnimation)
    this.deathClip = deathClip
    this.flash.visible = false
    this.rig.resetPose()
    this.update(0, state, false)
    if (state !== 'dead' && posture?.transition) {
      this.postureTransition = THREE.AnimationClip.parse(posture.transition)
      this.transientClips.add(this.postureTransition)
      this.mode = this.postureTransition.name
      void this.player.play(this.postureTransition, { once: true, fade: 0 })
      animationTime = posture.transitionTime ?? animationTime
    }
    if (this.player.current) this.player.current.time = animationTime
    this.update(0, state, false)
    this.root.updateMatrixWorld(true)
    this.releaseTransientClips()
  }

  get animationTime() { return this.player.current?.time ?? 0 }
  get reactionRemaining() { return Math.max(0, this.reacting) }

  dispose() {
    this.player.mixer.stopAllAction()
    this.player.mixer.uncacheRoot(this.root)
    disposeGun(this.gun)
    this.material.dispose()
    this.outlineMaterials.forEach(material => material.dispose())
    const geometries = new Set<THREE.BufferGeometry>()
    this.root.traverse(object => { if (object instanceof THREE.Mesh) geometries.add(object.geometry) })
    geometries.forEach(geometry => geometry.dispose())
    for (const name of BONE_NAMES) this.rig.bones[name].removeFromParent()
    this.root.removeFromParent()
  }
}
