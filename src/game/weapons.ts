import * as THREE from 'three'
import { applyPenMaterial, createPenSilhouette, penPalette } from '../render/ballpoint'
import { disposeGun, type Gun } from '../lab/weapons/models'
import { buildKnifeHand, KNIFE_HAND } from './knife-hand'
import { offsetDirection } from './aim'
import type { WeaponContext, WeaponFrame, WeaponItem, WeaponName, WeaponSnapshot } from './types'
import { AIM_ZOOM, AMMO, GUNSHOT_HEARING, KNIFE, SILENCED_REPORT_RADIUS, STARTING_SLOT, WEAPON_RULES, WEAPON_SLOT, WEAPON_SLOTS, SHOTGUN_PELLETS, SHOTGUN_BALLISTICS, SNIPER_ZOOM, startingLoadout, type KnifeAttack } from './balance'
import { createMissionGun } from './weapon-models'
export { WEAPON_RULES } from './balance'

const up = new THREE.Vector3(0, 1, 0)
const right = new THREE.Vector3(1, 0, 0)
const AIM_PITCH = THREE.MathUtils.degToRad(-5)
const AIM_LOWER_TIME = 0.18
const copyItem = (item: WeaponItem): WeaponItem => ({ ...item, ...(item.position ? { position: [...item.position] } : {}) })
const smooth = (value: number, a: number, b: number) => THREE.MathUtils.smoothstep(value, a, b)
type KnifeKey = { position: THREE.Vector3; turn: THREE.Quaternion }
type V3 = [number, number, number]
/**
 * A knife pose in camera space: where the grip sits, where the blade points, and which way its flat
 * (the side with the curled fingers, the knife's +X) faces. The spine is whatever is left, so the
 * edge follows from those two.
 */
function knifeKey(position: V3, blade: V3, face: V3): KnifeKey {
  const z = new THREE.Vector3(...blade).normalize(), x = new THREE.Vector3(...face)
  x.addScaledVector(z, -x.dot(z)).normalize()
  const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x), z))
  return { position: new THREE.Vector3(...position), turn }
}
/**
 * Counter-Strike style. Rest: big and close at the lower right, blade up and leaning in, the flat and the
 * back of the hand turned to the player, edge toward the crosshair and saw-back outward. A slash cocks
 * right, then sweeps edge-first across the crosshair to the left; a stab draws back, then drives in with
 * the tip on the crosshair.
 */
const KNIFE_KEYS = {
  hold: knifeKey([0.16, -0.22, -0.36], [-0.25, 0.93, -0.27], [0.1, 0.1, 1]),
  wind: knifeKey([0.24, -0.17, -0.34], [0.2, 0.95, -0.2], [0.1, 0.05, 1]),
  cut: knifeKey([0.02, -0.1, -0.46], [-0.6, 0.7, -0.4], [0.2, 0.1, 1]),
  follow: knifeKey([-0.12, -0.17, -0.42], [-0.8, 0.45, -0.3], [0.3, 0.1, 1]),
  pull: knifeKey([0.2, -0.26, -0.3], [-0.1, 0.9, -0.4], [0.1, 0.1, 1]),
  thrust: knifeKey([0.08, -0.1, -0.56], [-0.3, 0.3, -0.9], [0.3, 0.3, 1]),
}
/**
 * Drawing the knife sometimes shows off: a toss that flips it end over end and catches it, or a spin
 * round the index finger. Times in seconds; the fingers let go of the handle in between.
 */
type KnifeTrick = 'toss' | 'spin'
const KNIFE_TRICKS: Record<KnifeTrick, number> = { toss: 0.95, spin: 0.8 }
const knifeSpin = new THREE.Quaternion()
const knifeAxis = new THREE.Vector3(1, 0, 0)
const knifePosition = new THREE.Vector3()
const knifeTurn = new THREE.Quaternion()
/** Held in the firing hand alone; the support hand only appears to reload. */
const ONE_HANDED = new Set<WeaponName>(['pistol', 'silenced', 'knife'])
/**
 * Inspecting the weapon (F with nothing to use), after Counter-Strike: it is brought in towards the middle, turned to
 * show its flank and rolled to show its top, held there while it turns a little, then rolled right over to show its
 * underside and the magazine, held, and lowered back into the hold. Keys are [seconds, x, y, z (metres, in the camera's frame), pitch, yaw, roll
 * (radians, about the grip)], eased between.
 */
type InspectKey = [number, number, number, number, number, number, number]
const INSPECT_GUN: InspectKey[] = [
  [0, 0, 0, 0, 0, 0, 0],
  [0.45, -0.1, 0.06, -0.05, 0.08, 0.42, 0.5],
  [1.25, -0.105, 0.065, -0.05, 0.12, 0.5, 0.58],
  [1.75, -0.1, 0.05, -0.1, -0.18, 0.5, -0.7],
  [2.45, -0.1, 0.055, -0.1, -0.22, 0.56, -0.8],
  [3, 0, 0, 0, 0, 0, 0],
]
/** The knife: the blade's face turned to you, a spin round the finger, its back, and away. */
const INSPECT_KNIFE: InspectKey[] = [
  [0, 0, 0, 0, 0, 0, 0],
  [0.4, -0.08, 0.06, 0.06, 0.2, -0.9, 0.3],
  [1.1, -0.085, 0.065, 0.06, 0.25, -1.05, 0.35],
  [1.5, -0.06, 0.08, 0.05, -0.15, 0.9, -0.3],
  [2.2, -0.06, 0.08, 0.05, -0.2, 1.05, -0.35],
  [2.7, 0, 0, 0, 0, 0, 0],
]
type LooseWeapon = { item: WeaponItem; model: Gun }
type Arm = { shoulder: THREE.Vector3; pole: THREE.Vector3; upper: THREE.Mesh; fore: THREE.Mesh; elbow: THREE.Mesh }

/** Gameplay weapons deliberately have no lab action timers or animation-mixer dependencies. */
export class FirstPersonWeapons {
  private inventory: (WeaponItem | null)[] = startingLoadout()
  private slot = STARTING_SLOT
  private nextId = 1
  private loose = new Map<string, LooseWeapon>()
  private root = new THREE.Group()
  private mount = new THREE.Group()
  private rightHand = new THREE.Group()
  private leftHand = new THREE.Group()
  private supportFingers = new THREE.Group()
  // Sleeves and skin: a soft, broad sheen under lamps and sunbeams, not a metal glint.
  private armMaterial = Object.assign(new THREE.MeshBasicMaterial({
    color: penPalette.paper, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }), { defines: { NEON_SHINE: '0.18', NEON_GLOSS: '10.0' } })
  // Full upper arms taper through the elbow to a narrower wrist; IK still owns length.
  private upperArmGeometry = new THREE.CylinderGeometry(0.055, 0.075, 1, 24)
  private forearmGeometry = new THREE.CylinderGeometry(0.035, 0.057, 1, 24)
  private jointGeometry = new THREE.SphereGeometry(0.057, 20, 16)
  private palmGeometry = new THREE.SphereGeometry(1, 20, 16)
  private knifeGrip = new THREE.Group()
  private knifeHand = buildKnifeHand(geometry => this.armShape(geometry))
  // A glove cuff hides where the forearm meets the knife hand.
  private cuffGeometry = new THREE.CylinderGeometry(KNIFE_HAND.cuff.radius * 0.96, KNIFE_HAND.cuff.radius, KNIFE_HAND.cuff.length, 24)
  private cuff = this.armShape(this.cuffGeometry)
  private trick: { kind: KnifeTrick; elapsed: number } | null = null
  private flashGeometry = this.makeFlashGeometry()
  private flashMaterial = applyPenMaterial(new THREE.MeshBasicMaterial({ color: penPalette.ink, transparent: true, opacity: 0.95, side: THREE.DoubleSide, toneMapped: false }), { density: 0.47, scale: 90, seed: 829 })
  private flash = new THREE.Mesh(this.flashGeometry, this.flashMaterial)
  private arms: [Arm, Arm]
  private model: Gun | null = null
  private partRest = new Map<THREE.Object3D, THREE.Vector3>()
  private partRotation = new Map<THREE.Object3D, THREE.Euler>()
  private held = false
  private pendingShot = false
  private enabled = false
  private reloadElapsed: number | null = null
  private reloadAim = 0
  private cooldown = 0
  private switchTime = 0
  private recoil = 0
  private settle = { pitch: 0, yaw: 0 }
  private reducedMotion = false
  private flashTime = 0
  private time = 0
  private aim = 0
  private aimedGripY = 0
  private lower = 0
  private obstructed = false
  private disposed = false
  private scopeActive = false
  private deathVisible = false
  private scopeZoom: number = SNIPER_ZOOM.initial
  private baseFov: number | null = null
  private zoom = 1
  private pendingStab = false
  /** Seconds into an inspection, or null when not inspecting. */
  private inspecting: number | null = null
  private swing: { kind: KnifeAttack; elapsed: number; struck: boolean } | null = null
  private feet = new THREE.Vector3()
  private frame: WeaponFrame = { active: false, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: this.feet }

  constructor(private context: WeaponContext) {
    this.root.name = 'First-person stickman arms'
    this.root.userData.noCollision = true
    this.mount.name = 'Firing hand grip mount'
    this.root.add(this.mount, this.leftHand)
    this.mount.add(this.rightHand, this.flash)
    this.flash.visible = false
    this.makeHand(this.rightHand, true)
    this.makeKnifeGrip()
    this.mount.add(this.knifeGrip)
    this.leftHand.name = 'Left reload and support hand'
    this.leftHand.add(this.supportFingers)
    this.makeHand(this.supportFingers, false)
    this.arms = [
      this.makeArm(new THREE.Vector3(0.24, -0.34, -0.1), new THREE.Vector3(0.75, -1, 0.4)),
      this.makeArm(new THREE.Vector3(-0.2, -0.34, -0.16), new THREE.Vector3(-0.7, -1, 0.3)),
    ]
    this.context.camera.add(this.root)
    this.setHeldModel()
  }

  get label() { return this.current ? WEAPON_RULES[this.current.name].label : 'Empty hands' }
  get ammo() { return this.current && this.current.name !== 'knife' ? `${this.current.magazine} / ${this.current.reserve}` : '—' }
  get reloading() { return this.reloadElapsed !== null }
  get inspectingWeapon() { return this.inspecting !== null }

  /** Look the weapon over (F with nothing to use), as in Counter-Strike. Pressing again starts it over. Anything the
   * weapon does (firing, aiming, reloading, switching) puts it straight back in the hold. */
  inspect() {
    if (!this.enabled || !this.current || this.reloading || this.switchTime > 0 || this.swing || this.scopeActive || this.aim > 0.05) return false
    this.inspecting = 0
    // The knife spins round the finger halfway through.
    if (this.current.name === 'knife' && !this.reducedMotion) this.trick = null
    this.context.emit({ kind: 'inspect', weapon: this.current.name, position: this.feet.clone(), radius: 1 })
    return true
  }
  get blocked() { return this.obstructed }
  get selected() { return this.slot }
  get scoped() { return this.scopeActive }
  get canAim() { return !!this.current && (this.current.name === 'sniper' || AIM_ZOOM[this.current.name] !== undefined) }
  get scopeMagnification() { return this.scopeZoom }
  /** The view's current magnification: the sniper scope, or sight zoom that follows the aim blend. */
  get magnification() { return this.zoom }
  get lookSensitivity() { return 1 / this.zoom }
  get knifeSwing() { return this.swing ? { ...this.swing } : null }
  get knifeTrick() { return this.trick ? { ...this.trick } : null }
  get current(): WeaponItem | null { return this.inventory[this.slot] }
  get slots(): readonly (WeaponItem | null)[] { return this.inventory }

  private makeArm(shoulder: THREE.Vector3, pole: THREE.Vector3): Arm {
    const upper = this.armShape(this.upperArmGeometry)
    const fore = this.armShape(this.forearmGeometry)
    const elbow = this.armShape(this.jointGeometry)
    this.root.add(upper, fore, elbow)
    return { shoulder, pole, upper, fore, elbow }
  }

  private armShape(geometry: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(geometry, this.armMaterial)
    const contour = createPenSilhouette(geometry, 2.4)
    contour.name = 'First-person arm contour'
    mesh.add(contour)
    return mesh
  }

  private makeFlashGeometry() {
    const star = new THREE.Shape()
    for (let index = 0; index < 10; index++) {
      const angle = index * Math.PI / 5
      const radius = index % 2 ? 0.018 : 0.065
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius
      if (index) star.lineTo(x, y); else star.moveTo(x, y)
    }
    star.closePath()
    return new THREE.ShapeGeometry(star)
  }

  private mitten(parent: THREE.Group, position: [number, number, number], scale: [number, number, number]) {
    const shape = this.armShape(this.palmGeometry)
    shape.position.set(...position)
    shape.scale.set(scale[0] * 1.12, scale[1] * 1.06, scale[2] * 1.08)
    parent.add(shape)
  }

  /** The knife's right fist, drawn in the knife's frame like the arms (see knife-hand.ts). */
  private makeKnifeGrip() {
    this.knifeGrip.add(this.knifeHand.root)
    this.knifeGrip.visible = false
    this.cuff.name = 'Knife glove cuff'
    this.root.add(this.cuff)
  }

  private makeHand(hand: THREE.Group, firing: boolean) {
    hand.name = firing ? 'Right connected mitten grip' : 'Left connected support mitten'
    if (firing) {
      this.mitten(hand, [-0.023, -0.012, -0.010], [0.033, 0.043, 0.036])
      this.mitten(hand, [-0.002, 0.012, 0.018], [0.020, 0.022, 0.034])
    } else {
      this.mitten(hand, [0, -0.022, 0], [0.042, 0.025, 0.045])
      this.mitten(hand, [-0.030, -0.001, 0.010], [0.017, 0.029, 0.031])
    }
  }

  private segment(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3) {
    const direction = end.clone().sub(start)
    mesh.position.copy(start).add(end).multiplyScalar(0.5)
    mesh.scale.y = direction.length()
    mesh.quaternion.setFromUnitVectors(up, direction.normalize())
  }

  /** A two-bone solve keeps upper arms/forearms exactly 34/36 cm long throughout all poses. */
  private placeArm(arm: Arm, wrist: THREE.Vector3, shoulder = arm.shoulder) {
    const direction = wrist.clone().sub(shoulder)
    const distance = direction.length()
    direction.normalize()
    const upperLength = 0.34, foreLength = 0.36
    const d = THREE.MathUtils.clamp(distance, Math.abs(upperLength - foreLength) + 0.001, upperLength + foreLength - 0.001)
    const along = (upperLength ** 2 - foreLength ** 2 + d ** 2) / (2 * d)
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))
    const bend = arm.pole.clone().addScaledVector(direction, -arm.pole.dot(direction)).normalize()
    const elbow = shoulder.clone().addScaledVector(direction, along).addScaledVector(bend, height)
    this.segment(arm.upper, shoulder, elbow)
    this.segment(arm.fore, elbow, wrist)
    arm.elbow.position.copy(elbow)
  }

  private setHeldModel() {
    this.scopeZoom = SNIPER_ZOOM.initial
    // The knife gets a real closed fist; firearms keep the grip mitten.
    this.knifeGrip.visible = this.cuff.visible = this.current?.name === 'knife'
    this.rightHand.visible = !this.knifeGrip.visible
    if (this.model) disposeGun(this.model)
    this.model = null
    this.partRest.clear()
    this.partRotation.clear()
    if (this.current) {
      this.model = createMissionGun(this.current.name)
      // A slight muzzle-up tilt reveals the top of the barrel while aiming.
      // Measure that pose before parenting so its sights stay below the reticle.
      this.model.rotation.x = AIM_PITCH
      this.aimedGripY = -new THREE.Box3().setFromObject(this.model).max.y - 0.008
      this.model.rotation.x = 0
      this.mount.add(this.model)
      for (const part of Object.values(this.model.userData.parts)) {
        this.partRest.set(part, part.position.clone())
        this.partRotation.set(part, part.rotation.clone())
      }
      this.flash.position.copy(this.model.userData.muzzle).z += 0.035
    }
    this.root.visible = this.enabled && !!this.current
    this.pose(0)
  }

  trigger(pressed: boolean) {
    if (!pressed) { this.held = false; return }
    this.inspecting = null
    if (this.enabled && this.reloading && this.current?.name === 'shotgun' && this.current.magazine > 0) this.cancel()
    if (!this.enabled || this.reloading || this.switchTime > 0 || !this.current) return
    if (!this.held) this.pendingShot = true
    this.held = true
  }

  reload() {
    const item = this.current
    if (!this.enabled || !item || this.reloading || this.switchTime > 0 || item.reserve <= 0 || item.magazine >= WEAPON_RULES[item.name].capacity) return false
    this.held = false
    this.pendingShot = false
    this.inspecting = null
    this.reloadAim = this.aim
    // Negative time lowers from the current pose; magazine/bolt motion starts at zero.
    this.reloadElapsed = this.aim > 0.001 ? -AIM_LOWER_TIME : 0
    this.setScope(false)
    this.context.emit({ kind: 'reload', weapon: item.name, position: this.context.camera.getWorldPosition(new THREE.Vector3()), radius: 3, text: `Reloading ${this.label.toLowerCase()}` })
    return true
  }

  /** The mouse wheel: the next (+1) or previous (-1) occupied slot, wrapping around. */
  cycle(direction: number) {
    if (!this.enabled || !direction) return false
    const count = this.inventory.length
    for (let step = 1; step < count; step++) {
      const index = ((this.slot + Math.sign(direction) * step) % count + count) % count
      if (this.inventory[index]) return this.switchSlot(index)
    }
    return false
  }

  switchSlot(index: number) {
    if (!this.enabled || !Number.isInteger(index) || index < 0 || index >= this.inventory.length || index === this.slot || !this.inventory[index]) return false
    this.cancel()
    this.slot = index
    this.switchTime = 0.22
    this.setHeldModel()
    // Now and then the knife comes out with a trick; Reduced Motion always gets the plain draw.
    if (this.current?.name === 'knife' && !this.reducedMotion) {
      const roll = Math.random()
      this.trick = roll < 0.4 ? { kind: 'toss', elapsed: 0 } : roll < 0.75 ? { kind: 'spin', elapsed: 0 } : null
    }
    this.context.emit({ kind: 'switch', position: this.feet.clone(), radius: 1, text: this.label })
    return true
  }

  /** Interruption never moves ammunition. Ammo transfer is a single reload-completion event. */
  cancel() {
    this.held = false
    this.pendingShot = false
    this.pendingStab = false
    this.swing = null
    this.trick = null
    this.inspecting = null
    this.reloadElapsed = null
    this.reloadAim = 0
    this.switchTime = 0
    this.recoil = 0
    this.flashTime = 0
    this.flash.visible = false
    this.aim = 0
    this.lower = 0
    this.settle.pitch = this.settle.yaw = 0
    this.setScope(false)
    for (const [part, position] of this.partRest) part.position.copy(position)
    for (const [part, rotation] of this.partRotation) part.rotation.copy(rotation)
  }

  beginDeath() {
    this.deathVisible = this.root.visible
    this.cancel()
    this.enabled = false
  }

  updateDeath(elapsed: number, reducedMotion: boolean, hitKick = 0, hitSide = 0) {
    const drop = smooth(elapsed, 0, 0.62)
    const kick = reducedMotion ? 0 : hitKick
    this.root.visible = this.deathVisible && elapsed < 0.62 && !reducedMotion
    this.root.position.set(0.08 * drop - hitSide * 0.04 * kick, -0.85 * drop + 0.075 * kick, 0.2 * drop + 0.1 * kick)
    this.root.rotation.set(-0.65 * drop - 0.2 * kick, 0.06 * hitSide * kick, 0.16 * drop + 0.18 * hitSide * kick)
  }

  resetDeath() {
    this.deathVisible = false
    this.root.position.set(0, 0, 0)
    this.root.rotation.set(0, 0, 0)
  }

  private setScope(active: boolean) {
    this.scopeActive = active
    this.applyZoom(active ? this.scopeZoom : 1 + ((this.current && AIM_ZOOM[this.current.name] || 1) - 1) * this.aim)
  }

  /** The controller enters walk mode after construction and owns every unmagnified FOV.
   *  Capture it when zoom starts, then restore exactly that value when zoom ends. */
  private applyZoom(magnification: number) {
    const zoomed = magnification > 1.001
    if (!zoomed && this.baseFov === null) { this.zoom = 1; return }
    if (zoomed && this.baseFov === null) this.baseFov = this.context.camera.fov
    const baseline = this.baseFov!
    const fov = zoomed ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseline) / 2) / magnification)) : baseline
    this.zoom = zoomed ? magnification : 1
    if (this.context.camera.fov !== fov) {
      this.context.camera.fov = fov
      this.context.camera.updateProjectionMatrix()
    }
    if (!zoomed) this.baseFov = null
  }

  /** Right click with the knife: a slower, heavier stab. */
  stab() {
    if (this.enabled && this.current?.name === 'knife') this.pendingStab = true
  }

  /** Adjust only an active sniper scope; preserve the unscoped camera's FOV. */
  adjustScopeZoom(direction: number) {
    if (this.disposed || !this.enabled || !this.scopeActive || this.current?.name !== 'sniper' ||
        this.reloading || !Number.isFinite(direction) || direction === 0) return false
    this.scopeZoom = THREE.MathUtils.clamp(this.scopeZoom + Math.sign(direction), SNIPER_ZOOM.min, SNIPER_ZOOM.max)
    this.setScope(true)
    return true
  }

  update(dt: number, frame: WeaponFrame) {
    if (this.disposed) return
    this.feet.copy(frame.feet)
    this.frame = { ...frame, feet: this.feet }
    const enabled = frame.active && !frame.climbing
    if (!enabled) this.cancel()
    this.enabled = enabled
    this.root.visible = enabled && !!this.current
    if (!enabled) return
    const delta = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1))
    this.time += delta
    const previousCooldown = this.cooldown
    this.cooldown = Math.max(0, this.cooldown - delta)
    if (this.current?.name === 'shotgun' && previousCooldown > 0.72 && this.cooldown <= 0.72) this.context.emit({ kind: 'weapon-pump', position: this.feet.clone(), radius: 3 })
    this.switchTime = Math.max(0, this.switchTime - delta)
    if (this.trick && (this.trick.elapsed += delta) >= KNIFE_TRICKS[this.trick.kind]) this.trick = null
    if (this.inspecting !== null) {
      const keys = this.current?.name === 'knife' ? INSPECT_KNIFE : INSPECT_GUN, previous = this.inspecting
      this.inspecting += delta
      // The knife's spin round the finger, as it turns from one side to the other.
      if (this.current?.name === 'knife' && !frame.reducedMotion && previous < 1.15 && this.inspecting >= 1.15) this.trick = { kind: 'spin', elapsed: 0 }
      if (frame.aiming || this.inspecting >= keys[keys.length - 1][0]) this.inspecting = null
    }
    this.recoil = Math.max(0, this.recoil - delta * 7)
    this.flashTime = Math.max(0, this.flashTime - delta)
    this.reducedMotion = frame.reducedMotion
    if (this.reloadElapsed !== null && this.current) {
      this.reloadElapsed += delta
      if (this.reloadElapsed >= WEAPON_RULES[this.current.name].reload) {
        const shellReload = this.current.name === 'shotgun', capacity = WEAPON_RULES[this.current.name].capacity
        if (shellReload) {
          // A tube magazine is topped up one shell at a time.
          const amount = Math.min(capacity - this.current.magazine, this.current.reserve, 1)
          this.current.magazine += amount
          this.current.reserve -= amount
        } else {
          // Box magazines: the old magazine is thrown away with whatever rounds were left in it.
          const amount = Math.min(capacity, this.current.reserve)
          this.current.magazine = amount
          this.current.reserve -= amount
        }
        if (shellReload) this.context.emit({ kind: 'shell-load', radius: 2, position: this.feet.clone() })
        if (shellReload && this.current.magazine < WEAPON_RULES.shotgun.capacity && this.current.reserve > 0) this.reloadElapsed -= WEAPON_RULES.shotgun.reload
        else {
          this.reloadElapsed = null
          this.context.emit({ kind: 'reload-ready', weapon: this.current.name, radius: 2, position: this.feet.clone(), text: 'Weapon ready' })
        }
      }
    }
    if (this.reloadElapsed !== null) this.aim = this.reloadAim * (1 - smooth(this.reloadElapsed, -AIM_LOWER_TIME, 0))
    else this.aim += ((frame.aiming && this.canAim ? 1 : 0) - this.aim) * (1 - Math.exp(-delta * 12))
    this.checkObstruction()
    this.setScope(this.current?.name === 'sniper' && frame.aiming && !this.reloading && this.switchTime <= 0 && !this.obstructed)
    // A scoped rifle is represented by the scope overlay; hide the viewmodel to avoid near-plane clipping.
    this.root.visible = !!this.current && !this.scopeActive
    this.lower += ((this.obstructed ? 1 : 0) - this.lower) * Math.min(1, delta * 15)
    this.pose(delta)
    const item = this.current
    if (item?.name === 'knife') this.updateKnife(delta)
    else if (item && this.cooldown <= 0 && !this.reloading && this.switchTime <= 0 && !this.obstructed &&
        (this.pendingShot || (this.held && WEAPON_RULES[item.name].automatic))) this.shoot(item)
    else if (this.settle.pitch || this.settle.yaw) {
      // Resolve fire against the displayed sight before recovery moves it on this frame.
      // A shotgun blast has a heavier recovery than an automatic's short pulse.
      const recovery = this.current?.name === 'shotgun' ? 0.16 : 0.09
      const fraction = 1 - Math.exp(-delta / recovery)
      this.nudge(-this.settle.pitch * fraction, -this.settle.yaw * fraction)
      this.settle.pitch *= 1 - fraction; this.settle.yaw *= 1 - fraction
      if (Math.abs(this.settle.pitch) + Math.abs(this.settle.yaw) < 1e-6) this.settle.pitch = this.settle.yaw = 0
    }
    this.pendingShot = false
    this.pendingStab = false
    this.flash.visible = this.flashTime > 0
  }

  /** Swings start on click (held left click keeps slashing); the blade connects partway through the motion. */
  private updateKnife(delta: number) {
    if (this.swing) {
      this.swing.elapsed += delta
      const rules = KNIFE[this.swing.kind]
      if (!this.swing.struck && this.swing.elapsed >= rules.hitAt) {
        this.swing.struck = true
        const origin = this.context.camera.getWorldPosition(new THREE.Vector3())
        this.context.onMelee?.({ origin, direction: this.context.camera.getWorldDirection(new THREE.Vector3()), damage: rules.damage, kind: this.swing.kind })
      }
      if (this.swing.elapsed >= rules.duration) this.swing = null
    }
    if (this.swing || this.cooldown > 0 || this.switchTime > 0) return
    const kind: KnifeAttack | null = this.pendingStab ? 'stab' : this.pendingShot || this.held ? 'slash' : null
    if (!kind) return
    this.swing = { kind, elapsed: 0, struck: false }
    this.trick = null
    this.cooldown = KNIFE[kind].interval
    // Barely audible: a guard at arm's length does not hear the blade coming.
    this.context.emit({ kind: `knife-${kind}`, position: this.context.camera.getWorldPosition(new THREE.Vector3()), radius: 1.2 })
    this.pose(0)
  }

  private gripPosition() {
    if (this.current?.name === 'knife') return KNIFE_KEYS.hold.position.clone()
    const rifle = this.current?.name === 'ak' || this.current?.name === 'sniper' || this.current?.name === 'shotgun'
    return new THREE.Vector3(THREE.MathUtils.lerp(rifle ? 0.17 : 0.16, 0, this.aim),
      THREE.MathUtils.lerp(rifle ? -0.23 : -0.20, this.aimedGripY, this.aim), rifle ? -0.36 : -0.43)
  }

  private checkObstruction() {
    // A knife is never lowered: it is meant for walls' and guards' arm's length.
    if (!this.model || this.current?.name === 'knife') { this.obstructed = false; return }
    const camera = this.context.camera
    camera.updateWorldMatrix(true, false)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    // Test the intended unlowered muzzle so lowering cannot make a blocked barrel clear again.
    const point = this.model.userData.muzzle.clone().applyAxisAngle(right, AIM_PITCH * this.aim)
      .applyAxisAngle(up, Math.PI).add(this.gripPosition())
    const muzzle = camera.localToWorld(point)
    const toMuzzle = muzzle.clone().sub(eye)
    const direction = camera.getWorldDirection(new THREE.Vector3())
    this.obstructed = this.context.world.rayDistance(eye, toMuzzle.clone().normalize(), toMuzzle.length() + 0.08) < toMuzzle.length() + 0.07 ||
      this.context.world.rayDistance(muzzle, direction, 0.24) < 0.24
  }

  private pose(_dt: number) {
    if (!this.model || !this.current) return
    const motion = !this.frame.reducedMotion
    const progress = this.reloadElapsed === null ? 0 : Math.max(0, this.reloadElapsed) / WEAPON_RULES[this.current.name].reload
    const working = this.reloading ? Math.sin(Math.PI * progress) : 0
    const position = this.gripPosition()
    const bob = motion ? Math.min(1, this.frame.moving) * (1 - this.aim) : 0
    position.x += Math.sin(this.time * 7) * 0.004 * bob
    position.y += Math.cos(this.time * 14) * 0.003 * bob - this.lower * 0.20 - (motion ? this.switchTime * 0.7 : 0)
    position.z += (motion ? this.recoil * 0.028 : 0) + this.lower * 0.12
    position.x -= working * 0.025
    this.mount.position.copy(position)
    this.mount.rotation.set(AIM_PITCH * this.aim + (motion ? this.recoil * 0.035 : 0) + this.lower * 0.5,
      Math.PI + working * 0.18, -working * 0.23, 'YXZ')
    if (this.current.name === 'knife') this.knifePose()
    if (this.inspecting !== null) this.inspectPose(this.inspecting, motion)
    const hit = motion ? this.frame.hitPose : undefined
    if (hit) {
      this.mount.position.add(hit.weaponPosition)
      this.mount.rotation.x += hit.weaponRotation.x
      this.mount.rotation.y += hit.weaponRotation.y
      this.mount.rotation.z += hit.weaponRotation.z
    }
    for (const [part, rest] of this.partRest) part.position.copy(rest)
    for (const [part, rotation] of this.partRotation) part.rotation.copy(rotation)
    const magazine = this.model.userData.parts.magazine
    if (magazine && this.reloading) {
      const withdrawal = smooth(progress, 0.22, 0.40) * (1 - smooth(progress, 0.48, 0.67))
      magazine.position.y -= withdrawal * 0.13
      magazine.position.x -= withdrawal * 0.065
      magazine.position.z -= withdrawal * 0.045
      magazine.rotation.z += withdrawal * 0.28
      magazine.rotation.x -= withdrawal * 0.18
    }
    const action = this.model.userData.parts.slide ?? this.model.userData.parts.bolt
    if (action) action.position.z -= this.reloading
      ? 0.035 * smooth(progress, 0.76, 0.82) * (1 - smooth(progress, 0.86, 0.94))
      : (motion ? this.recoil * 0.026 : 0)
    const pump = this.model.userData.parts.pump
    if (pump && !this.reloading) {
      const cycle = WEAPON_RULES.shotgun.interval - this.cooldown
      pump.position.z -= 0.07 * smooth(cycle, 0.12, 0.3) * (1 - smooth(cycle, 0.35, 0.55))
    }
    this.root.updateWorldMatrix(true, true)
    const shoulders = this.arms.map((arm, index) => arm.shoulder.clone().add(hit?.shoulders[index] ?? new THREE.Vector3()))
    const wrist = this.root.worldToLocal(this.mount.localToWorld(this.current.name === 'knife' ? KNIFE_HAND.wrist.clone() : new THREE.Vector3(-0.029, -0.02, -0.033)))
    const reachableWrist = wrist.clone().sub(shoulders[0]).clampLength(0.021, 0.699).add(shoulders[0])
    // Move the whole grip if a combined reload/recoil/hit reaches the IK limit.
    // The firing hand stays attached and neither arm is stretched to fake impact.
    this.mount.position.add(reachableWrist.clone().sub(wrist))
    this.root.updateWorldMatrix(true, true)
    const pistol = ONE_HANDED.has(this.current.name)
    this.leftHand.visible = !pistol || this.reloadElapsed !== null && this.reloadElapsed >= 0
    const leftArm = this.arms[1]
    leftArm.upper.visible = leftArm.fore.visible = leftArm.elbow.visible = this.leftHand.visible
    const support = this.model.userData.support?.clone() ?? new THREE.Vector3(0, 0.035, 0.145)
    // Place the palm against the fore-end rather than intersecting the receiver.
    if (this.model.userData.support) support.y += 0.026
    if (pump) support.z += pump.position.z - this.partRest.get(pump)!.z
    // Pistols stay in the right hand; the reload hand enters and leaves below view.
    const left = pistol ? new THREE.Vector3(-0.28, -0.7, -0.12)
      : this.root.worldToLocal(this.mount.localToWorld(support))
    if (this.reloading && magazine) {
      const magGrip = magazine.userData.grip as THREE.Vector3 | undefined
      const contact = this.root.worldToLocal(magazine.localToWorld(magGrip?.clone() ?? new THREE.Vector3(0, -0.04, 0)))
      const reach = smooth(progress, 0.03, 0.20) * (1 - smooth(progress, 0.66, 0.77))
      left.lerp(contact, reach)
      if (action) {
        const actionGrip = action.userData.grip as THREE.Vector3 | undefined
        const target = this.root.worldToLocal(action.localToWorld(actionGrip?.clone() ?? new THREE.Vector3()))
        left.lerp(target, smooth(progress, 0.70, 0.79) * (1 - smooth(progress, 0.91, 0.99)))
      }
    }
    const loadingPort = this.model.userData.parts.loadingPort
    if (this.reloading && loadingPort) {
      const contact = this.root.worldToLocal(loadingPort.getWorldPosition(new THREE.Vector3()))
      left.lerp(contact, Math.sin(Math.PI * progress))
    }
    if (hit) left.add(hit.leftHand)
    left.sub(shoulders[1]).clampLength(0.021, 0.699).add(shoulders[1])
    this.leftHand.position.copy(left)
    this.leftHand.quaternion.copy(this.mount.quaternion)
    const reachTurn = smooth(progress, 0.03, 0.20) * (1 - smooth(progress, 0.66, 0.77))
    const boltTurn = smooth(progress, 0.70, 0.79) * (1 - smooth(progress, 0.91, 0.99))
    this.leftHand.rotateX(reachTurn * 0.42 - boltTurn * 0.2)
    this.leftHand.rotateZ(reachTurn * 0.38 + boltTurn * 0.35)
    this.placeArm(this.arms[0], reachableWrist, shoulders[0])
    this.placeArm(this.arms[1], left, shoulders[1])
    if (this.cuff.visible) {
      // Sit the cuff over the end of the forearm, along it, so the arm runs straight into the glove.
      const along = this.arms[0].elbow.position.clone().sub(reachableWrist).normalize()
      this.cuff.position.copy(reachableWrist).addScaledVector(along, KNIFE_HAND.cuff.length * 0.35)
      this.cuff.quaternion.setFromUnitVectors(up, along)
    }
  }

  /** The inspection's offset from the hold at `time`, eased key to key. Reduced Motion lifts it into view, no turning. */
  private inspectPose(time: number, motion: boolean) {
    const keys = this.current?.name === 'knife' ? INSPECT_KNIFE : INSPECT_GUN
    let i = 0
    while (i < keys.length - 2 && time > keys[i + 1][0]) i++
    const [t0, ...a] = keys[i], [t1, ...b] = keys[i + 1]
    const u = smooth(time, t0, t1)
    const at = (k: number) => THREE.MathUtils.lerp(a[k], b[k], u)
    this.mount.position.x += at(0); this.mount.position.y += at(1); this.mount.position.z += at(2)
    if (!motion) return
    this.mount.rotateY(at(4)); this.mount.rotateX(at(3)); this.mount.rotateZ(at(5))
  }

  /** The knife swaps the gun orientation for KNIFE_KEYS, blending key to key through a swing, then adds any draw trick. */
  private knifePose() {
    const { hold } = KNIFE_KEYS, swing = this.swing
    knifePosition.copy(hold.position); knifeTurn.copy(hold.turn)
    const to = (key: KnifeKey, weight: number) => { knifePosition.lerp(key.position, weight); knifeTurn.slerp(key.turn, weight) }
    if (swing) {
      const p = swing.elapsed / KNIFE[swing.kind].duration
      if (swing.kind === 'slash') {
        to(KNIFE_KEYS.wind, smooth(p, 0, 0.14)); to(KNIFE_KEYS.cut, smooth(p, 0.14, 0.34))
        to(KNIFE_KEYS.follow, smooth(p, 0.36, 0.55)); to(hold, smooth(p, 0.55, 1))
      } else {
        to(KNIFE_KEYS.pull, smooth(p, 0, 0.2)); to(KNIFE_KEYS.thrust, smooth(p, 0.2, 0.34)); to(hold, smooth(p, 0.5, 1))
      }
    }
    // gripPosition() already placed the hold (plus bob and the switch drop); add only the swing's travel.
    this.mount.position.add(knifePosition.sub(hold.position))
    this.mount.quaternion.copy(knifeTurn)
    this.poseKnifeTrick()
  }

  /**
   * The knife model moves inside the hand's frame (+Z up the blade, +X toward the player), so a turn
   * about +X spins it in the plane of the screen. Toss: dip, flick, one counter-clockwise flip in the air
   * above the open hand, catch. Spin: one clockwise turn round the curled index finger, the others open.
   */
  private poseKnifeTrick() {
    const model = this.model, trick = this.trick
    if (!model) return
    model.position.set(0, 0, 0); model.quaternion.identity()
    let open = 0, keepIndex = false
    if (trick) {
      const p = trick.elapsed / KNIFE_TRICKS[trick.kind], hand = this.mount.position
      if (trick.kind === 'toss') {
        const flight = THREE.MathUtils.clamp((p - 0.3) / 0.44, 0, 1)
        hand.y += 0.025 * smooth(p, 0.22, 0.3) * (1 - smooth(p, 0.3, 0.4)) - 0.035 * smooth(p, 0.72, 0.78) * (1 - smooth(p, 0.78, 1))
        hand.y -= 0.02 * smooth(p, 0.12, 0.22) * (1 - smooth(p, 0.22, 0.3))
        open = smooth(p, 0.26, 0.32) * (1 - smooth(p, 0.68, 0.76))
        this.spinKnife(flight * Math.PI * 2, 0.07)
        model.position.z += 0.5 * flight * (1 - flight)
      } else {
        const turn = smooth(p, 0.25, 0.7)
        hand.y += 0.02 * smooth(p, 0.15, 0.3) * (1 - smooth(p, 0.7, 1))
        open = smooth(p, 0.2, 0.3) * (1 - smooth(p, 0.66, 0.76)); keepIndex = true
        this.spinKnife(-turn * Math.PI * 2, 0.047)
      }
    }
    this.knifeHand.setOpen(open, keepIndex)
  }

  /** Turns the knife model about +X through a pivot `pivot` metres up the handle. */
  private spinKnife(angle: number, pivot: number) {
    const model = this.model!
    knifeSpin.setFromAxisAngle(knifeAxis, angle)
    model.quaternion.copy(knifeSpin)
    model.position.set(0, 0, pivot).sub(new THREE.Vector3(0, 0, pivot).applyQuaternion(knifeSpin))
  }

  private shoot(item: WeaponItem) {
    const rules = WEAPON_RULES[item.name]
    this.cooldown = rules.interval
    if (item.magazine === 0) {
      this.held = false
      this.context.emit({ kind: 'empty', text: item.reserve ? 'Empty — press R to reload' : 'No ammunition' })
      return
    }
    this.root.updateWorldMatrix(true, true)
    const origin = this.model!.localToWorld(this.model!.userData.muzzle.clone())
    const eye = this.context.camera.getWorldPosition(new THREE.Vector3())
    const forward = this.context.camera.getWorldDirection(new THREE.Vector3())
    // Shots follow the drifting crosshair, plus a random cone while moving or airborne (see AimSteadiness).
    const spread = this.frame.spread ?? 0, angle = Math.random() * Math.PI * 2, radius = spread * Math.sqrt(Math.random())
    const sway = this.frame.aimOffset ?? { yaw: 0, pitch: 0 }
    if (sway.yaw || sway.pitch || radius) offsetDirection(forward, { yaw: sway.yaw + Math.cos(angle) * radius, pitch: sway.pitch + Math.sin(angle) * radius }, forward)
    const worldDistance = this.context.world.rayDistance(eye, forward, rules.range)
    const aimDistance = this.context.aimDistance?.(eye, forward, worldDistance) ?? worldDistance
    // Converge on the enemy under the crosshair, not scenery behind its thin silhouette.
    const target = eye.clone().addScaledVector(forward, aimDistance)
    const direction = target.sub(origin).normalize()
    // Also test the animated muzzle; a reload/switch pose can differ from the stable wall probe.
    const bridge = origin.clone().sub(eye)
    if (this.context.world.rayDistance(eye, bridge.clone().normalize(), bridge.length() + 0.02) < bridge.length() ||
        this.context.world.rayDistance(origin, direction, 0.15) < 0.15) { this.obstructed = true; return }
    item.magazine--
    this.recoil = item.name === 'shotgun' ? 1.7 : 1
    // A suppressor hides the muzzle flash as well as most of the report.
    this.flashTime = item.name === 'silenced' ? 0 : 0.045
    if (item.name === 'shotgun') {
      const right = new THREE.Vector3().crossVectors(direction, Math.abs(direction.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : up).normalize()
      const vertical = new THREE.Vector3().crossVectors(right, direction).normalize()
      const spread = Math.tan(SHOTGUN_BALLISTICS.halfAngle)
      const rotation = Math.random() * Math.PI * 2
      for (let pellet = 0; pellet < SHOTGUN_PELLETS; pellet++) {
        const angle = rotation + pellet * 2.399963
        const radius = pellet === 0 ? 0 : spread * Math.sqrt(pellet / (SHOTGUN_PELLETS - 1))
        const ray = direction.clone().addScaledVector(right, Math.cos(angle) * radius).addScaledVector(vertical, Math.sin(angle) * radius).normalize()
        this.context.onShot({ origin: origin.clone(), direction: ray, range: rules.range, damage: rules.damage, weapon: item.name, pelletIndex: pellet })
      }
    } else this.context.onShot({ origin, direction, range: rules.range, damage: rules.damage, weapon: item.name })
    // Shotguns punch upward; limit their sideways pull so the bigger kick stays controllable.
    const pitch = rules.kick * (0.8 + Math.random() * 0.4)
    const yaw = (Math.random() - 0.5) * rules.kick * (item.name === 'shotgun' ? 0.55 : 1)
    this.nudge(pitch, yaw)
    this.settle.pitch += pitch * rules.settle; this.settle.yaw += yaw * 0.35
    this.context.emit({ kind: `shot-${item.name}`, position: origin.clone(),
      radius: item.name === 'silenced' ? SILENCED_REPORT_RADIUS : GUNSHOT_HEARING[item.name as keyof typeof GUNSHOT_HEARING] ?? GUNSHOT_HEARING.ak, text: `${rules.label} fired` })
    this.pose(0)
  }

  /** Rotates the real look direction, so the kick is visible and affects the next shot like it would for a player. */
  private nudge(pitch: number, yaw: number) {
    if (this.reducedMotion) return
    const rotation = new THREE.Euler().setFromQuaternion(this.context.camera.quaternion, 'YXZ')
    rotation.x = THREE.MathUtils.clamp(rotation.x + pitch, -1.5, 1.5)
    rotation.y += yaw
    this.context.camera.quaternion.setFromEuler(rotation)
  }

  private groundPosition(feet: THREE.Vector3) {
    const forward = this.context.camera.getWorldDirection(new THREE.Vector3())
    forward.y = 0
    const point = feet.clone().addScaledVector(forward.normalize(), 0.6)
    const height = this.context.world.floor(point, 1, 3)
    point.y = Number.isFinite(height) ? height : feet.y
    const start = feet.clone().add(new THREE.Vector3(0, 0.35, 0))
    const end = point.clone().add(new THREE.Vector3(0, 0.35, 0))
    if (!this.context.world.visible(start, end, this.root)) point.copy(feet)
    return point
  }

  drop(feet: THREE.Vector3) {
    if (!this.enabled || !this.current || this.current.name === 'knife') return false
    const item = copyItem(this.current)
    item.position = this.groundPosition(feet).toArray() as [number, number, number]
    this.inventory[this.slot] = null
    this.cancel()
    this.addPickup(item)
    this.setHeldModel()
    this.context.emit({ kind: 'drop', position: new THREE.Vector3(...item.position), radius: 3, text: `${WEAPON_RULES[item.name].label} dropped` })
    return true
  }

  /** Restock at a supply crate: each gun carried gets its spare ammunition back up to AMMO.player magazines. */
  resupply() {
    let changed = false
    for (const item of this.inventory) {
      if (!item || item.name === 'knife') continue
      const full = WEAPON_RULES[item.name].capacity * AMMO.player
      if (item.reserve < full) { item.reserve = full; changed = true }
    }
    if (changed) this.context.emit({ kind: 'pickup', position: this.feet.clone(), radius: 2, text: 'Ammunition restocked' })
    return changed
  }

  addPickup(source: WeaponItem) {
    if (this.disposed || this.loose.has(source.id) || this.inventory.some(item => item?.id === source.id)) return
    const item = copyItem(source)
    item.id ||= `loose-weapon-${this.nextId++}`
    item.magazine = Math.max(0, Math.min(WEAPON_RULES[item.name].capacity, Math.floor(item.magazine)))
    item.reserve = Math.max(0, Math.floor(item.reserve))
    item.position ??= this.feet.toArray() as [number, number, number]
    const model = createMissionGun(item.name)
    model.name = `Dropped ${WEAPON_RULES[item.name].label}: ${item.id}`
    model.userData.noCollision = true
    if (item.stand === undefined) model.rotation.set(0, 0.6, Math.PI / 2)
    else {
      // Standing on its butt, muzzle up, its side profile toward the room, leaning back a little against the wall.
      const lean = 0.12, facing = new THREE.Vector3(Math.sin(item.stand), 0, Math.cos(item.stand))
      const muzzle = up.clone().multiplyScalar(Math.cos(lean)).addScaledVector(facing, -Math.sin(lean))
      const side = facing.clone().multiplyScalar(Math.cos(lean)).addScaledVector(up, Math.sin(lean))
      model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, new THREE.Vector3().crossVectors(muzzle, side), muzzle))
    }
    model.position.set(...item.position)
    const bounds = new THREE.Box3().setFromObject(model)
    model.position.y += item.position[1] + 0.012 - bounds.min.y
    this.context.scene.add(model)
    this.loose.set(item.id, { item, model })
  }

  pickupTargets() {
    return [...this.loose.values()].map(({ item, model }) => ({
      object: model as THREE.Object3D, point: model.position.clone().add(new THREE.Vector3(0, 0.10, 0)),
      label: `${this.inventory[WEAPON_SLOT[item.name]] ? 'Swap for' : 'Take'} ${WEAPON_RULES[item.name].label}`, id: item.id,
    }))
  }

  pickup(id: string) {
    const found = this.loose.get(id)
    if (!this.enabled || !found) return false
    const eye = this.context.camera.getWorldPosition(new THREE.Vector3())
    const point = found.model.position.clone().add(new THREE.Vector3(0, 0.10, 0))
    if (eye.distanceTo(point) > 2.7 || point.clone().sub(eye).normalize().dot(this.context.camera.getWorldDirection(new THREE.Vector3())) < 0.25 ||
        !this.context.world.visible(eye, point, found.model)) return false
    // Every weapon has its category slot. An occupied slot swaps: the old weapon drops with its ammunition.
    const destination = WEAPON_SLOT[found.item.name]
    const occupant = this.inventory[destination]
    if (occupant?.name === 'knife') return false
    if (occupant) { this.slot = destination; this.drop(this.feet) }
    this.cancel()
    this.loose.delete(id)
    disposeGun(found.model)
    const item = copyItem(found.item)
    delete item.position
    delete item.stand
    this.inventory[destination] = item
    this.slot = destination
    this.switchTime = 0.22
    this.setHeldModel()
    this.context.emit({ kind: 'pickup', position: this.feet.clone(), radius: 2, text: `${this.label} picked up` })
    return true
  }

  snapshot(): WeaponSnapshot {
    return { slots: this.inventory.map(item => item ? copyItem(item) : null), selected: this.slot,
      pickups: [...this.loose.values()].map(({ item }) => copyItem(item)), nextId: this.nextId }
  }

  restore(snapshot: WeaponSnapshot) {
    this.cancel()
    this.cooldown = 0
    this.aim = 0
    this.lower = 0
    this.obstructed = false
    for (const { model } of this.loose.values()) disposeGun(model)
    this.loose.clear()
    this.inventory = snapshot.slots.slice(0, WEAPON_SLOTS).map(item => item ? copyItem(item) : null)
    while (this.inventory.length < WEAPON_SLOTS) this.inventory.push(null)
    this.slot = Number.isInteger(snapshot.selected) && snapshot.selected >= 0 && snapshot.selected < this.inventory.length ? snapshot.selected : 0
    this.nextId = snapshot.nextId
    for (const item of snapshot.pickups) this.addPickup(item)
    this.setHeldModel()
  }

  dispose() {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    if (this.model) disposeGun(this.model)
    for (const { model } of this.loose.values()) disposeGun(model)
    this.loose.clear()
    this.root.removeFromParent()
    for (const geometry of [this.upperArmGeometry, this.forearmGeometry, this.jointGeometry, this.palmGeometry, this.flashGeometry]) geometry.dispose()
    this.knifeHand.dispose()
    this.cuffGeometry.dispose()
    this.armMaterial.dispose()
    this.flashMaterial.dispose()
  }
}
