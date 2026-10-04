import * as THREE from 'three'
import { createPenLines, createPenSilhouette, penPalette, type PenDistanceProfile } from '../render/ballpoint'
import type { CollisionWorld } from '../player/collision'
import { lightBurst, transientLights, type NeonLightSpec } from '../render/neon'
import { GRENADE_RULES, flashStrength, fragDamage, type GrenadeKind } from './balance'
import type { SoundEvent } from './types'
import './grenades.css'

export type { GrenadeKind } from './balance'
const RULES = GRENADE_RULES
const KINDS = RULES.order
type Strength = 'full' | 'medium' | 'lob'
/** What the hand is doing: taking a grenade out, holding it, pulling the pin, holding it back to throw, or throwing. */
type HandState = 'none' | 'draw' | 'ready' | 'pin' | 'cocked' | 'swing'
type Thrown = { kind: GrenadeKind; root: THREE.Group; velocity: THREE.Vector3; age: number; rolling: boolean; still: number; spin: THREE.Vector3; by?: number }
type Puff = { mesh: THREE.Mesh; home: THREE.Vector3; size: number; phase: number }
type Cloud = { root: THREE.Group; center: THREE.Vector3; age: number; puffs: Puff[]; outlines: THREE.Object3D[] }
type Burst = { root: THREE.Group; age: number; life: number; kind: 'frag' | 'flash'; core: THREE.Mesh; glow: THREE.Mesh; rays: THREE.Object3D; puffs: THREE.Mesh[] }
export type GrenadeSnapshot = { counts: Record<GrenadeKind, number>; selected: GrenadeKind }
/** What the player's eyes and body are doing this frame. */
export type GrenadeFrame = { active: boolean; eye: THREE.Vector3; forward: THREE.Vector3; velocity: THREE.Vector3; reducedMotion: boolean }
export type GrenadeHooks = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  world: CollisionWorld
  /** Sounds, which guards also hear. */
  emit: (event: SoundEvent) => void
  /** A frag went off: hurt the guards (EnemyDirector.blast). */
  blast?: (origin: THREE.Vector3) => void
  /** A flashbang went off: blind the guards (EnemyDirector.flash). */
  flash?: (origin: THREE.Vector3) => void
  /** The frag hurt the player. */
  damagePlayer?: (amount: number, origin: THREE.Vector3) => void
  /** A flashbang whited the player out for this many seconds (the ringing in the ears). */
  onFlashed?: (seconds: number) => void
  /** The last grenade left the hand: go back to a weapon. */
  onEmpty?: () => void
  /** Any grenade went off (the tutorial watches these). */
  onDetonate?: (kind: GrenadeKind, origin: THREE.Vector3) => void
}

const up = new THREE.Vector3(0, 1, 0)
const ignore = new THREE.Object3D()
const sphere = new THREE.SphereGeometry(1, 20, 14)
const smooth = THREE.MathUtils.smoothstep
// Flash, fire and smoke glow on their own; neon light and dark rooms must not tint them.
const unlit = (color: number, opacity = 1) => Object.assign(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity,
  depthWrite: opacity >= 1, toneMapped: false }), { defines: { NEON_UNLIT: '' } })
const paper = () => new THREE.MeshBasicMaterial({ color: penPalette.paper, toneMapped: false })
const grey = () => new THREE.MeshBasicMaterial({ color: 0xbdbdbd, toneMapped: false })
const circle = (radius: number, y: number, segments = 20) =>
  Array.from({ length: segments + 1 }, (_, i) => new THREE.Vector3(Math.cos(i / segments * Math.PI * 2) * radius, y, Math.sin(i / segments * Math.PI * 2) * radius))

/**
 * A grenade in the paper-and-ink style, about life size, standing on +Y: the frag is a ridged egg, the flashbang a
 * slim can pierced with holes, the smoke a fat can with a grey band. All three share the fuse, the spoon along the
 * side and the pin ring (`userData.ring`). `profile` is the pen's distance profile: 'weapon' in the hand.
 */
export function grenadeModel(kind: GrenadeKind, profile: PenDistanceProfile = 'world') {
  const root = new THREE.Group()
  root.name = `${RULES.label[kind]} model`
  root.userData.noCollision = true
  const shape = (geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], scale?: [number, number, number]) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...position)
    if (scale) mesh.scale.set(...scale)
    mesh.add(createPenSilhouette(geometry, profile === 'weapon' ? 2 : 1.6, penPalette.ink, profile))
    root.add(mesh)
    return mesh
  }
  const lines = (points: THREE.Vector3[], seed: number) => root.add(createPenLines(points, seed, 'detail', profile === 'weapon' ? 1.3 : 1, profile))
  let top: number
  if (kind === 'frag') {
    shape(sphere, paper(), [0, 0.04, 0], [0.034, 0.042, 0.034])
    // The ridges of the old pineapple pattern.
    for (const y of [0.022, 0.04, 0.058]) lines(circle(Math.sqrt(1 - ((y - 0.04) / 0.042) ** 2) * 0.0345, y), 300 + y * 1000)
    for (let i = 0; i < 4; i++) {
      const angle = i / 4 * Math.PI
      lines(Array.from({ length: 13 }, (_, k) => {
        const t = -Math.PI / 2 + k / 12 * Math.PI
        return new THREE.Vector3(Math.cos(angle) * Math.cos(t) * 0.0345, 0.04 + Math.sin(t) * 0.0425, Math.sin(angle) * Math.cos(t) * 0.0345)
      }), 340 + i)
    }
    top = 0.08
  } else {
    const radius = kind === 'flash' ? 0.022 : 0.028, height = kind === 'flash' ? 0.095 : 0.1
    shape(new THREE.CylinderGeometry(radius, radius, height, 24), paper(), [0, height / 2, 0])
    if (kind === 'smoke') shape(new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, 0.03, 24), grey(), [0, height * 0.55, 0])
    else for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) {
      // The flashbang's vent holes.
      const angle = (i + row * 0.5) / 6 * Math.PI * 2, y = 0.03 + row * 0.022
      const centre = new THREE.Vector3(Math.cos(angle) * radius * 1.01, y, Math.sin(angle) * radius * 1.01)
      lines(Array.from({ length: 7 }, (_, k) => centre.clone().add(new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(Math.cos(k / 6 * Math.PI * 2) * 0.004))
        .add(new THREE.Vector3(0, Math.sin(k / 6 * Math.PI * 2) * 0.004, 0))), 500 + row * 10 + i)
    }
    for (const y of [0.006, height - 0.006]) lines(circle(radius * 1.01, y), 400 + y * 1000)
    top = height
  }
  // Fuse head, the spoon down one side, and the pin's ring.
  shape(new THREE.CylinderGeometry(0.011, 0.013, 0.02, 14), paper(), [0, top + 0.008, 0])
  const spoon = shape(new THREE.BoxGeometry(0.012, 0.075, 0.005), paper(), [0, top - 0.025, kind === 'frag' ? 0.036 : 0.03])
  spoon.rotation.x = kind === 'frag' ? -0.2 : 0
  const ring = shape(new THREE.TorusGeometry(0.011, 0.0022, 6, 18), paper(), [0.016, top + 0.012, 0])
  ring.rotation.y = Math.PI / 2
  root.userData.ring = ring
  root.userData.top = top
  return root
}

/** Where a segment from `a` to `b` passes closest to `c`. */
function closestOnSegment(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out = new THREE.Vector3()) {
  const ab = out.copy(b).sub(a), length = ab.lengthSq()
  const t = length > 1e-9 ? THREE.MathUtils.clamp(c.clone().sub(a).dot(ab) / length, 0, 1) : 0
  return ab.multiplyScalar(t).add(a)
}

/** A smoke cloud is a dome: as wide as `radius`, a little flatter than tall. True when it hides `b` from `a`. */
export function smokeHides(center: THREE.Vector3, radius: number, a: THREE.Vector3, b: THREE.Vector3) {
  if (radius <= 0) return false
  const squash = 1 / 0.7
  const scale = (point: THREE.Vector3) => new THREE.Vector3(point.x - center.x, (point.y - center.y) * squash, point.z - center.z)
  const near = closestOnSegment(scale(a), scale(b), new THREE.Vector3())
  return near.length() < radius * 0.9
}

/** How long a flashbang's light lasts (s), and how bright it is `age` seconds in: full for a blink, then dying fast. */
const FLASH_LIGHT_LIFE = 0.9
export function flashEnvelope(age: number) {
  if (age < 0 || age >= FLASH_LIGHT_LIFE) return 0
  return age < 0.05 ? 1 : Math.exp(-(age - 0.05) * 7)
}

/**
 * The player's grenades, Counter-Strike style: 4 takes one out (again to cycle frag → flash → smoke), left click
 * pulls the pin and throws on release, right click lobs. Thrown grenades bounce and roll with real physics and go off
 * on their fuse: the frag hurts everyone near it (you too), the flashbang blinds whoever sees it (you too, see the
 * whiteout), and the smoke grows into a cloud that hides everything behind it, from guards and player alike.
 */
export class Grenades {
  counts: Record<GrenadeKind, number> = { frag: 0, flash: 0, smoke: 0 }
  selected: GrenadeKind = 'frag'
  /** Training: throwing never uses up a grenade. */
  endless = false
  private state: HandState = 'none'
  private stateTime = 0
  private strength: Strength = 'full'
  private buttons = new Set<number>()
  private releaseQueued: Strength | null = null
  private thrown: Thrown[] = []
  private clouds: Cloud[] = []
  private bursts: Burst[] = []
  private scorches: THREE.Object3D[] = []
  /** The light of each flashbang going off, and how long ago it did (s). */
  private flashLights: { light: THREE.Object3D; age: number }[] = []
  private effects = new THREE.Group()
  private hand: GrenadeHand
  private belt = document.createElement('div')
  private whiteout = document.createElement('div')
  private smokeVeil = document.createElement('div')
  /** The player's whiteout: seconds of full white, seconds of fade, and how white it gets (`peak`, 0 to 1). */
  private blind = { hold: 0, fade: 0, total: 0, peak: 0 }
  private frame: GrenadeFrame = { active: false, eye: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), velocity: new THREE.Vector3(), reducedMotion: false }
  private disposed = false

  constructor(private hooks: GrenadeHooks) {
    this.effects.name = 'Grenades and their effects'
    this.effects.userData.noCollision = true
    hooks.scene.add(this.effects)
    this.rehearse()
    this.hand = new GrenadeHand(hooks.camera)
    this.belt.className = 'grenade-belt'
    this.belt.setAttribute('aria-label', 'Grenades')
    this.whiteout.className = 'flash-whiteout'
    this.smokeVeil.className = 'smoke-veil'
    const canvas = document.querySelector('#world')
    for (const element of [this.smokeVeil, this.whiteout]) { element.hidden = true; element.setAttribute('aria-hidden', 'true') }
    if (canvas) canvas.after(this.smokeVeil, this.whiteout)
    else document.body.append(this.smokeVeil, this.whiteout)
    ;(document.querySelector('#mission-hud') ?? document.body).append(this.belt)
    this.drawBelt()
  }

  /** A grenade is in the hand (the guns are put away). */
  get equipped() { return this.state !== 'none' }
  get carrying() { return KINDS.some(kind => this.counts[kind] > 0) }
  /** The pin is out or the arm is swinging: switching away now would waste the throw. */
  get busy() { return this.state === 'pin' || this.state === 'cocked' || this.state === 'swing' }
  /** Seconds of full whiteout left for the player, and how strong what is left of the flash is (0 to 1). */
  get blinded() { return { seconds: this.blind.hold, amount: this.whiteAmount() } }
  get airborne() { return this.thrown.length }
  get smokes() { return this.clouds.length }

  /** Fill the belt: one frag, two flashbangs, one smoke. */
  give(counts: Partial<Record<GrenadeKind, number>> = RULES.carry) {
    for (const kind of KINDS) this.counts[kind] = Math.min(RULES.carry[kind], this.counts[kind] + (counts[kind] ?? 0))
    this.drawBelt()
  }

  /** Key 4: take a grenade out, or with one already in hand, the next kind you carry. */
  equip() {
    if (this.busy) return false
    const available = KINDS.filter(kind => this.counts[kind] > 0)
    if (!available.length) return false
    const next = this.equipped ? available[(available.indexOf(this.selected) + 1) % available.length] : available.includes(this.selected) ? this.selected : available[0]
    if (this.equipped && next === this.selected) return false
    this.selected = next
    this.draw()
    this.hooks.emit({ kind: 'switch', position: this.frame.eye.clone(), radius: 1, text: RULES.label[next] })
    return true
  }

  /** Put the grenade away (another weapon was chosen). A pulled pin goes back in. */
  holster() {
    if (!this.equipped) return
    this.state = 'none'; this.stateTime = 0; this.releaseQueued = null; this.buttons.clear()
    this.hand.show(null)
    this.drawBelt()
  }

  /** Let go of everything: a pulled pin goes back in, and the grenade stays in hand. */
  cancel() {
    this.buttons.clear(); this.releaseQueued = null
    if (this.busy && this.state !== 'swing') { this.state = 'ready'; this.stateTime = 0 }
  }

  /** Mouse buttons while a grenade is out: 0 is left (full throw), 2 is right (lob). */
  press(button: number) {
    if (!this.equipped || (button !== 0 && button !== 2)) return
    this.buttons.add(button)
    if (this.state === 'ready') { this.state = 'pin'; this.stateTime = 0; this.hooks.emit({ kind: 'grenade-pin', position: this.frame.eye.clone(), radius: 2 }) }
  }
  release(button: number) {
    if (!this.buttons.has(button)) return
    const both = this.buttons.has(0) && this.buttons.has(2)
    this.buttons.delete(button)
    if (this.state !== 'pin' && this.state !== 'cocked') return
    const strength: Strength = both ? 'medium' : button === 0 ? 'full' : 'lob'
    // The pin has to be out before it can be thrown; an early release throws the moment it is.
    if (this.state === 'pin') this.releaseQueued = strength
    else this.swing(strength)
  }

  private draw() {
    this.state = 'draw'; this.stateTime = 0; this.releaseQueued = null
    this.hand.show(this.selected)
    this.drawBelt()
  }

  private swing(strength: Strength) {
    this.strength = strength
    this.state = 'swing'; this.stateTime = 0; this.releaseQueued = null
  }

  /** Where a throw starts: just in front of the right shoulder, pulled back if a wall is closer than that. */
  private throwOrigin() {
    const { eye, forward } = this.frame
    const right = new THREE.Vector3().crossVectors(forward, up).normalize()
    const point = eye.clone().addScaledVector(forward, 0.3).addScaledVector(right, 0.12).addScaledVector(up, this.strength === 'lob' ? -0.3 : -0.05)
    const toward = point.clone().sub(eye), length = toward.length()
    const clear = this.hooks.world.rayDistance(eye, toward.normalize(), length + RULES.throw.radius)
    return clear < length + RULES.throw.radius ? eye.clone().addScaledVector(toward, Math.max(0, clear - RULES.throw.radius * 1.5)) : point
  }

  /** Launch the grenade in hand. */
  private launch() {
    const kind = this.selected, { forward, velocity } = this.frame
    // A little loft over the crosshair, more for the underhand lob, as in Counter-Strike.
    const direction = forward.clone().addScaledVector(up, this.strength === 'lob' ? 0.32 : 0.12).normalize()
    const speed = RULES.throw[this.strength]
    const root = grenadeModel(kind)
    root.position.copy(this.throwOrigin())
    root.userData.ring.visible = false
    this.effects.add(root)
    this.thrown.push({ kind, root, age: 0, rolling: false, still: 0,
      velocity: direction.multiplyScalar(speed).addScaledVector(velocity, RULES.throw.inherit),
      spin: new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 6 - 3, Math.random() * 14 - 7) })
    if (!this.endless) this.counts[kind] = Math.max(0, this.counts[kind] - 1)
    this.hooks.emit({ kind: 'grenade-throw', position: this.frame.eye.clone(), radius: 1.5 })
    this.drawBelt()
  }

  /**
   * A grenade thrown by someone else (a guard): from `origin` at `velocity`, bouncing and going off like the player's
   * own, hurting whoever is near when it does (the player too). It costs the belt nothing.
   */
  throwFrom(kind: GrenadeKind, origin: THREE.Vector3, velocity: THREE.Vector3) {
    if (this.disposed) return
    const root = grenadeModel(kind)
    root.position.copy(origin)
    root.userData.ring.visible = false
    this.effects.add(root)
    this.thrown.push({ kind, root, age: 0, rolling: false, still: 0, velocity: velocity.clone(),
      spin: new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 6 - 3, Math.random() * 14 - 7), by: -1 })
    this.hooks.emit({ kind: 'grenade-throw', position: origin.clone(), radius: 1.5 })
  }

  update(dt: number, frame: GrenadeFrame) {
    if (this.disposed) return false
    const delta = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.05))
    this.frame = frame
    if (!frame.active && this.busy) { this.state = 'ready'; this.releaseQueued = null; this.buttons.clear() }
    this.updateHand(delta)
    this.hand.root.visible = frame.active && this.equipped
    let moving = this.updateThrown(delta)
    moving = this.updateBursts(delta) || moving
    moving = this.updateFlashLights(delta) || moving
    moving = this.updateClouds(delta) || moving
    this.updateVeils(delta)
    return moving || this.equipped
  }

  private updateHand(delta: number) {
    if (!this.equipped) return
    const { timing } = RULES
    this.stateTime += delta
    if (this.state === 'draw' && this.stateTime >= timing.draw) { this.state = 'ready'; this.stateTime = 0 }
    if (this.state === 'pin' && this.stateTime >= timing.pin) {
      this.state = 'cocked'; this.stateTime = 0
      if (this.releaseQueued) this.swing(this.releaseQueued)
    }
    if (this.state === 'swing') {
      const before = this.stateTime - delta
      if (before < timing.release && this.stateTime >= timing.release) this.launch()
      if (this.stateTime >= timing.swing) {
        if (this.counts[this.selected] > 0) this.draw()
        else {
          const next = KINDS.find(kind => this.counts[kind] > 0)
          if (next) { this.selected = next; this.draw() }
          else { this.holster(); this.hooks.onEmpty?.() }
        }
      }
    }
    if (this.equipped) this.hand.pose(this.state, this.stateTime, this.strength, this.frame.reducedMotion)
  }

  /** Flight with bounces off walls and floors, rolling to a stop, and each fuse. Physics substeps of at most 1/120 s. */
  private updateThrown(delta: number) {
    const { gravity, radius, bounce, friction, roll } = RULES.throw
    const steps = Math.max(1, Math.ceil(delta * 120)), h = delta / steps
    for (const grenade of [...this.thrown]) {
      const position = grenade.root.position, velocity = grenade.velocity
      for (let step = 0; step < steps; step++) {
        grenade.age += h
        if (grenade.rolling) {
          // Rolling: friction slows it; it falls again if it rolls off an edge.
          const speed = Math.hypot(velocity.x, velocity.z), slowed = Math.max(0, speed - roll * h)
          if (speed > 1e-6) { velocity.x *= slowed / speed; velocity.z *= slowed / speed }
          velocity.y = 0
          const below = this.hooks.world.rayDistance(position, new THREE.Vector3(0, -1, 0), radius + 0.06)
          if (below > radius + 0.05) grenade.rolling = false
        } else velocity.y -= gravity * h
        const travel = velocity.length() * h
        if (travel > 1e-7) {
          const direction = velocity.clone().normalize()
          const hit = this.hooks.world.raySurface(position, direction, travel + radius)
          if (hit && hit.distance - radius < travel) {
            const normal = hit.normal.clone()
            if (normal.dot(direction) > 0) normal.negate()
            position.copy(hit.point).addScaledVector(normal, radius)
            const into = velocity.dot(normal)
            const along = velocity.clone().addScaledVector(normal, -into)
            velocity.copy(along.multiplyScalar(friction)).addScaledVector(normal, -into * bounce)
            if (-into > 1.6) this.hooks.emit({ kind: 'grenade-bounce', position: position.clone(), radius: 7, intensity: Math.min(1, -into / 10) })
            // Landing softly on a floor: it rolls from here on.
            if (normal.y > 0.7 && -into < 2.2) { grenade.rolling = true; velocity.y = 0; grenade.spin.multiplyScalar(0.5) }
          } else position.addScaledVector(velocity, h)
        }
      }
      const speed = velocity.length()
      grenade.still = speed < 0.12 && grenade.rolling ? grenade.still + delta : 0
      if (speed < 0.12 && grenade.rolling) velocity.set(0, 0, 0)
      const spin = grenade.rolling ? speed / radius * 0.3 : 1
      grenade.root.rotation.x += grenade.spin.x * delta * spin
      grenade.root.rotation.y += grenade.spin.y * delta * spin
      grenade.root.rotation.z += grenade.spin.z * delta * spin
      const due = grenade.kind === 'smoke' ? grenade.still >= RULES.smoke.settle || grenade.age >= RULES.fuse.smoke : grenade.age >= RULES.fuse[grenade.kind]
      if (due) this.detonate(grenade)
    }
    return this.thrown.length > 0
  }

  private detonate(grenade: Thrown) {
    this.thrown.splice(this.thrown.indexOf(grenade), 1)
    const origin = grenade.root.position.clone()
    grenade.root.removeFromParent()
    disposeObject(grenade.root)
    if (grenade.kind === 'frag') this.frag(origin)
    else if (grenade.kind === 'flash') this.flashbang(origin)
    else this.smoke(origin)
    this.hooks.onDetonate?.(grenade.kind, origin)
  }

  private frag(origin: THREE.Vector3) {
    this.hooks.emit({ kind: 'frag-explosion', position: origin.clone(), radius: RULES.frag.hearing })
    this.burst(origin, 'frag')
    // A fireball's light: orange, with real shadows, gone in under a second.
    lightBurst(origin.clone().setY(origin.y + 0.7), { color: 0xffa04a, intensity: 85, range: 14, life: 0.8, hold: 0.06, shadows: true, radius: 0.35 })
    this.scorch(origin)
    this.hooks.blast?.(origin)
    // It hurts the thrower too, unless a wall is in the way.
    const { eye } = this.frame
    if (!this.frame.active) return
    const feet = eye.clone().setY(eye.y - 1.2)
    const distance = Math.min(eye.distanceTo(origin), feet.distanceTo(origin))
    const damage = fragDamage(distance)
    const from = origin.clone().add(new THREE.Vector3(0, 0.25, 0))
    if (damage > 0 && (this.hooks.world.visible(from, eye, ignore) || this.hooks.world.visible(from, feet, ignore))) this.hooks.damagePlayer?.(damage, origin)
  }

  private flashbang(origin: THREE.Vector3) {
    this.hooks.emit({ kind: 'flashbang', position: origin.clone(), radius: RULES.flash.hearing })
    this.burst(origin, 'flash')
    this.flashLight(origin)
    this.hooks.flash?.(origin)
    const { eye, forward } = this.frame
    if (!this.frame.active || !this.hooks.world.visible(eye, origin, ignore) || this.smokeBlocks(eye, origin)) return
    const strength = flashStrength(forward.angleTo(origin.clone().sub(eye)), eye.distanceTo(origin))
    if (strength > 0.02) this.flashPlayer(strength)
  }

  /**
   * The flash lights up everything round it: a burst of hard white light, real light with real shadows, that whites
   * the walls, floor, furniture and anyone near for a moment and dies away in half a second. It spills out of the
   * room's doorway and windows, so from outside you see the room flare up. It points down with its cut-off plane far
   * above, so it lights every way but up through the floor above.
   */
  private flashLight(origin: THREE.Vector3) {
    const light = new THREE.Object3D()
    light.name = 'Flashbang · burst of light'
    light.position.copy(origin).y += 0.35
    light.rotation.x = Math.PI / 2
    const entry = { light, age: 0 }
    light.userData.neonLight = { start: [-0.05, 0, 0], end: [0.05, 0, 0], color: 0xf4f7ff, intensity: 70, range: 15, standoff: 6,
      bounce: 0.22, instant: true, dimmer: () => flashEnvelope(entry.age) } satisfies NeonLightSpec
    this.effects.add(light)
    transientLights.add(light)
    this.flashLights.push(entry)
  }

  private updateFlashLights(delta: number) {
    for (const entry of [...this.flashLights]) {
      entry.age += delta
      if (entry.age < FLASH_LIGHT_LIFE) continue
      this.removeFlashLight(entry)
    }
    return this.flashLights.length > 0
  }

  private removeFlashLight(entry: { light: THREE.Object3D; age: number }) {
    transientLights.delete(entry.light)
    entry.light.removeFromParent()
    this.flashLights.splice(this.flashLights.indexOf(entry), 1)
  }

  /**
   * Whites the player out for a flash of `strength` (0 to 1). Facing it squarely is seconds of solid white; a glance
   * or a flash behind you is a short, pale flicker of white that fades at once. A stronger flash already running is kept.
   */
  flashPlayer(strength: number) {
    const hold = RULES.flash.blind * Math.max(0, strength - 0.3) / 0.7, fade = RULES.flash.fade * Math.max(0.35, strength)
    const peak = Math.min(1, 0.3 + strength)
    if (hold + fade * peak <= this.blind.hold + this.blind.fade * this.blind.peak) return
    this.blind = { hold, fade, total: fade, peak }
    this.hooks.onFlashed?.(hold + fade * peak)
  }

  private smoke(origin: THREE.Vector3) {
    this.hooks.emit({ kind: 'smoke-hiss', position: origin.clone(), radius: RULES.smoke.hearing })
    const { radius, rise } = RULES.smoke
    const root = new THREE.Group()
    root.name = 'Smoke cloud'
    root.position.copy(origin)
    const puffs: Puff[] = [], outlines: THREE.Object3D[] = []
    const count = 26
    for (let i = 0; i < count; i++) {
      // Puffs spread evenly through the dome that hides things (smokeHides), so what you see is what blocks sight:
      // a spiral over the sphere, at depths that fill it, squashed to the dome's height. A few in pencil grey for depth.
      const y = 1 - 2 * (i + 0.5) / count, ring = Math.sqrt(1 - y * y), angle = i * 2.399963, depth = 0.35 + 0.65 * Math.cbrt(((i * 7) % count + 0.5) / count)
      const home = new THREE.Vector3(Math.cos(angle) * ring, y * 0.7, Math.sin(angle) * ring).multiplyScalar(radius * 0.62 * depth).add(new THREE.Vector3(0, rise, 0))
      const size = radius * (0.46 - depth * 0.1) * (0.9 + ((i * 3) % 4) * 0.06)
      const mesh = new THREE.Mesh(sphere, i % 5 === 3 ? unlit(0xbdbdbd) : unlit(0xffffff))
      ;(mesh.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide
      const outline = createPenSilhouette(sphere, 2.2)
      mesh.add(outline)
      outlines.push(outline)
      mesh.position.copy(home)
      mesh.scale.setScalar(0.001)
      root.add(mesh)
      puffs.push({ mesh, home, size, phase: i * 1.7 })
    }
    this.effects.add(root)
    this.clouds.push({ root, center: origin.clone().add(new THREE.Vector3(0, rise, 0)), age: 0, puffs, outlines })
  }

  /** How big a cloud is now, as a fraction of full size: growing, holding, then thinning away. */
  private cloudSize(cloud: Cloud) {
    const { grow, last, fade } = RULES.smoke
    return smooth(cloud.age, 0, grow) * (1 - smooth(cloud.age, last, last + fade))
  }

  /** True when smoke hides `to` from `from` (for guards' eyes and the player's). */
  smokeBlocks(from: THREE.Vector3, to: THREE.Vector3) {
    return this.clouds.some(cloud => {
      const size = this.cloudSize(cloud)
      return size > 0.45 && smokeHides(cloud.center, RULES.smoke.radius * size, from, to)
    })
  }

  private updateClouds(delta: number) {
    for (const cloud of [...this.clouds]) {
      cloud.age += delta
      const size = this.cloudSize(cloud)
      const inside = this.frame.eye.distanceTo(cloud.center) < RULES.smoke.radius * Math.max(0.3, size)
      for (const puff of cloud.puffs) {
        // A slow churn, so the cloud looks alive without drifting off its spot.
        const t = cloud.age * 0.35 + puff.phase
        puff.mesh.position.set(puff.home.x + Math.sin(t) * 0.18, puff.home.y + Math.sin(t * 1.3) * 0.1 + cloud.age * 0.008, puff.home.z + Math.cos(t * 0.9) * 0.18)
        puff.mesh.scale.setScalar(Math.max(0.001, puff.size * size * (1 + Math.sin(t * 0.7) * 0.04)))
      }
      // From inside, the pen outlines would turn the view black: inside it is all white.
      for (const outline of cloud.outlines) outline.visible = !inside
      if (cloud.age >= RULES.smoke.last + RULES.smoke.fade) {
        cloud.root.removeFromParent()
        disposeObject(cloud.root)
        this.clouds.splice(this.clouds.indexOf(cloud), 1)
      }
    }
    return this.clouds.length > 0
  }

  /** The explosion: a frag is an orange flash and ink rays with grey smoke; a flashbang a white star of rays. */
  private burst(origin: THREE.Vector3, kind: 'frag' | 'flash') {
    const burst = this.makeBurst(origin, kind)
    this.effects.add(burst.root)
    this.bursts.push(burst)
  }

  private makeBurst(origin: THREE.Vector3, kind: 'frag' | 'flash'): Burst {
    const root = new THREE.Group()
    root.position.copy(origin).add(new THREE.Vector3(0, 0.3, 0))
    const frag = kind === 'frag'
    const glow = new THREE.Mesh(sphere, unlit(frag ? 0xffc24a : 0xffffff, 0.95))
    const core = new THREE.Mesh(sphere, unlit(frag ? 0xff6a1a : 0xffffff, 0.95))
    if (!frag) core.add(createPenSilhouette(sphere, 2.4))
    const rays = new THREE.Group()
    for (let i = 0; i < (frag ? 22 : 16); i++) {
      const direction = new THREE.Vector3().randomDirection()
      if (frag) direction.y = Math.abs(direction.y) * 0.9
      direction.normalize()
      rays.add(createPenLines([direction.clone().multiplyScalar(frag ? 0.7 : 0.35), direction.clone().multiplyScalar((frag ? 2.6 : 1.2) + Math.random() * (frag ? 2 : 1.2))], 1700 + i, 'edge', frag ? 2.8 : 2.2))
    }
    const puffs = frag ? Array.from({ length: 14 }, (_, i) => {
      const puff = new THREE.Mesh(sphere, unlit(i % 3 ? 0xbdbdbd : 0x808080))
      puff.add(createPenSilhouette(sphere, 2.2))
      const angle = i / 14 * Math.PI * 2
      puff.position.set(Math.cos(angle) * 0.5, 0.1 + (i % 3) * 0.25, Math.sin(angle) * 0.5)
      puff.userData.drift = new THREE.Vector3(Math.cos(angle) * 1.4, 1 + (i % 3) * 0.45, Math.sin(angle) * 1.4)
      puff.userData.size = 0.75 + (i % 3) * 0.22
      puff.scale.setScalar(0.001)
      return puff
    }) : []
    root.add(glow, core, rays, ...puffs)
    return { root, age: 0, life: frag ? 2.2 : 0.5, kind, core, glow, rays, puffs }
  }

  /**
   * One of everything a grenade shows (each kind in flight, both bursts, a smoke puff), hidden, so the loading
   * screen's shader warm-up (render/warm-up.ts) compiles them: the first grenade of a mission, a guard's included, no
   * longer stalls a frame (it cost 70-90 ms) while its shaders compile.
   */
  private rehearse() {
    const rehearsal = new THREE.Group()
    rehearsal.name = 'Grenade effects (for the shader warm-up)'
    rehearsal.visible = false
    for (const kind of KINDS) rehearsal.add(grenadeModel(kind))
    rehearsal.add(this.makeBurst(new THREE.Vector3(), 'frag').root, this.makeBurst(new THREE.Vector3(), 'flash').root)
    for (const color of [0xffffff, 0xbdbdbd]) {
      const puff = new THREE.Mesh(sphere, unlit(color))
      ;(puff.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide
      puff.add(createPenSilhouette(sphere, 2.2))
      rehearsal.add(puff)
    }
    this.effects.add(rehearsal)
  }

  private updateBursts(delta: number) {
    for (const burst of [...this.bursts]) {
      burst.age += delta
      const t = burst.age, frag = burst.kind === 'frag'
      const flash = Math.max(0, 1 - t / (frag ? 0.28 : 0.18))
      burst.glow.scale.setScalar((frag ? 3.8 : 1.6) * (0.3 + 0.7 * Math.min(1, t / 0.1)))
      burst.core.scale.setScalar((frag ? 1.9 : 0.5) * (0.2 + 0.8 * Math.min(1, t / 0.08)))
      ;(burst.glow.material as THREE.MeshBasicMaterial).opacity = 0.95 * flash
      ;(burst.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * flash
      burst.glow.visible = burst.core.visible = flash > 0
      burst.rays.scale.setScalar(0.5 + 1.5 * Math.min(1, t / 0.16))
      burst.rays.visible = t < (frag ? 0.35 : 0.3)
      for (const puff of burst.puffs) {
        puff.position.addScaledVector(puff.userData.drift as THREE.Vector3, delta * Math.max(0.15, 1 - t / 1.4))
        const swell = Math.min(1, t / 0.3), shrink = Math.max(0, 1 - Math.max(0, t - 0.9) / (burst.life - 0.9))
        puff.scale.setScalar(Math.max(0.001, (puff.userData.size as number) * swell * shrink))
      }
      if (t >= burst.life) {
        burst.root.removeFromParent()
        disposeObject(burst.root)
        this.bursts.splice(this.bursts.indexOf(burst), 1)
      }
    }
    return this.bursts.length > 0
  }

  /** A frag leaves an inked scorch on the floor it went off over, which stays like the blood does. */
  private scorch(origin: THREE.Vector3) {
    const floor = this.hooks.world.raySurface(origin.clone().add(new THREE.Vector3(0, 0.3, 0)), new THREE.Vector3(0, -1, 0), 2)
    if (!floor || floor.normal.y < 0.7) return
    const root = new THREE.Group()
    root.name = 'Frag scorch'
    root.position.copy(floor.point).add(new THREE.Vector3(0, 0.015, 0))
    for (let i = 0; i < 26; i++) {
      const angle = i / 26 * Math.PI * 2 + Math.random() * 0.2, start = 0.15 + Math.random() * 0.25, end = 0.7 + Math.random() * 0.9
      root.add(createPenLines([new THREE.Vector3(Math.cos(angle) * start, 0, Math.sin(angle) * start), new THREE.Vector3(Math.cos(angle) * end, 0, Math.sin(angle) * end)], 2100 + i, 'detail', 1.6))
    }
    root.add(createPenLines(circle(0.45, 0, 28), 2190, 'detail', 1.4))
    this.effects.add(root)
    this.scorches.push(root)
    if (this.scorches.length > 24) { const old = this.scorches.shift()!; old.removeFromParent(); disposeObject(old) }
  }

  private whiteAmount() {
    if (this.blind.hold > 0) return this.blind.peak
    return this.blind.total > 0 ? Math.max(0, this.blind.fade / this.blind.total) * this.blind.peak : 0
  }

  private updateVeils(delta: number) {
    if (this.blind.hold > 0) this.blind.hold = Math.max(0, this.blind.hold - delta)
    else if (this.blind.fade > 0) this.blind.fade = Math.max(0, this.blind.fade - delta)
    const white = this.frame.active ? this.whiteAmount() : 0
    this.whiteout.hidden = white <= 0.002
    // The white thins slowly at first and then quickly, as eyes recover.
    if (!this.whiteout.hidden) this.whiteout.style.opacity = (white ** 0.6).toFixed(3)
    // Inside a smoke cloud you see nothing but white.
    let veil = 0
    for (const cloud of this.clouds) {
      const reach = RULES.smoke.radius * this.cloudSize(cloud)
      if (reach <= 0.1) continue
      const depth = 1 - this.frame.eye.distanceTo(cloud.center) / reach
      veil = Math.max(veil, THREE.MathUtils.clamp(depth / 0.35, 0, 1))
    }
    if (!this.frame.active) veil = 0
    this.smokeVeil.hidden = veil <= 0.002
    if (!this.smokeVeil.hidden) this.smokeVeil.style.opacity = veil.toFixed(3)
  }

  private drawBelt() {
    const html = KINDS.map(kind => `<span class="grenade-slot${this.equipped && this.selected === kind ? ' is-selected' : ''}${this.counts[kind] ? '' : ' is-empty'}" title="${RULES.label[kind]}">
      ${ICONS[kind]}<b>${this.endless ? '∞' : this.counts[kind]}</b></span>`).join('')
    const key = `${html}|${this.carrying}`
    if (this.belt.dataset.key === key) return
    this.belt.dataset.key = key
    this.belt.hidden = !this.carrying && !this.equipped
    this.belt.innerHTML = `<kbd>4</kbd>${html}`
  }

  snapshot(): GrenadeSnapshot { return { counts: { ...this.counts }, selected: this.selected } }

  /** Back to a saved belt, with nothing in the air, no smoke, no scorches and clear eyes. */
  restore(saved?: GrenadeSnapshot) {
    this.clear()
    this.counts = { frag: 0, flash: 0, smoke: 0, ...saved?.counts }
    this.selected = saved?.selected ?? 'frag'
    this.holster()
    this.drawBelt()
  }

  /** Everything thrown, burning or drifting is gone. */
  clear() {
    for (const grenade of this.thrown) { grenade.root.removeFromParent(); disposeObject(grenade.root) }
    this.thrown = []
    for (const cloud of this.clouds) { cloud.root.removeFromParent(); disposeObject(cloud.root) }
    this.clouds = []
    for (const burst of this.bursts) { burst.root.removeFromParent(); disposeObject(burst.root) }
    this.bursts = []
    for (const entry of [...this.flashLights]) this.removeFlashLight(entry)
    for (const scorch of this.scorches) { scorch.removeFromParent(); disposeObject(scorch) }
    this.scorches = []
    this.blind = { hold: 0, fade: 0, total: 0, peak: 0 }
    this.whiteout.hidden = this.smokeVeil.hidden = true
  }

  dispose() {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.effects.removeFromParent()
    this.hand.dispose()
    this.belt.remove(); this.whiteout.remove(); this.smokeVeil.remove()
  }
}

/** Little line drawings of each grenade for the belt. */
const ICONS: Record<GrenadeKind, string> = {
  frag: '<svg viewBox="0 0 20 28" aria-hidden="true"><ellipse cx="10" cy="17" rx="7.5" ry="9" /><path d="M3 14h15M3 20h15M10 8v18M8 4h4v4H8zM12 6c3 0 4 2 3 4" /></svg>',
  flash: '<svg viewBox="0 0 20 28" aria-hidden="true"><rect x="5" y="7" width="10" height="20" rx="1" /><path d="M8 3h4v4H8zM12 5c3 0 4 2 3 4" /><circle cx="8" cy="13" r="1" /><circle cx="12" cy="13" r="1" /><circle cx="8" cy="18" r="1" /><circle cx="12" cy="18" r="1" /><circle cx="8" cy="23" r="1" /><circle cx="12" cy="23" r="1" /></svg>',
  smoke: '<svg viewBox="0 0 20 28" aria-hidden="true"><rect x="4" y="7" width="12" height="20" rx="1" /><path d="M8 3h4v4H8zM12 5c3 0 4 2 3 4" /><rect class="band" x="4" y="14" width="12" height="5" /></svg>',
}

function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    // Spheres are shared, and so are the pen's silhouette and stroke materials (shaders); the fills are each mesh's own.
    if (mesh.geometry !== sphere) mesh.geometry.dispose()
    if (!Array.isArray(mesh.material) && !(mesh.material instanceof THREE.ShaderMaterial)) mesh.material.dispose()
  })
}

type Arm = { shoulder: THREE.Vector3; pole: THREE.Vector3; upper: THREE.Mesh; fore: THREE.Mesh; elbow: THREE.Mesh }
const key = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
/** The throwing hand's keys in camera space (x right, y up, −z ahead). */
const HAND = {
  hold: key(0.13, -0.18, -0.36), low: key(0.16, -0.55, -0.3),
  cocked: key(0.27, 0.0, -0.2), release: key(0.06, -0.03, -0.62), follow: key(-0.02, -0.4, -0.5),
  lobCocked: key(0.16, -0.4, -0.3), lobRelease: key(0.09, -0.2, -0.6), lobFollow: key(0.05, -0.1, -0.58),
}
const LEFT = { rest: key(-0.3, -0.75, -0.12), pull: key(-0.16, -0.16, -0.36) }

/**
 * The first-person throwing arm: the same white sleeve and mitten hands as the gun arms (weapons.ts), with the
 * grenade in the right fist. The left hand comes up to pull the pin, and the right arm winds back and throws:
 * overhand for a full throw, underhand for a lob.
 */
class GrenadeHand {
  readonly root = new THREE.Group()
  private mount = new THREE.Group()
  private left = new THREE.Group()
  private ring: THREE.Mesh
  private model: THREE.Group | null = null
  private kind: GrenadeKind | null = null
  private material = Object.assign(new THREE.MeshBasicMaterial({ color: penPalette.paper, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), { defines: { NEON_SHINE: '0.18', NEON_GLOSS: '10.0' } })
  private upperGeometry = new THREE.CylinderGeometry(0.055, 0.075, 1, 20)
  private foreGeometry = new THREE.CylinderGeometry(0.035, 0.057, 1, 20)
  private jointGeometry = new THREE.SphereGeometry(0.057, 16, 12)
  private palmGeometry = new THREE.SphereGeometry(1, 16, 12)
  private arms: [Arm, Arm]
  private time = 0

  constructor(camera: THREE.Camera) {
    this.root.name = 'First-person grenade arm'
    this.root.userData.noCollision = true
    this.root.visible = false
    this.root.add(this.mount, this.left)
    // Fingers curled round the back of the grenade and a thumb over its side, so the grenade faces you; and the
    // support hand's mitten.
    this.mitten(this.mount, [0.006, 0.022, -0.026], [0.034, 0.03, 0.026])
    this.mitten(this.mount, [-0.03, 0.03, -0.004], [0.012, 0.024, 0.014])
    this.mitten(this.left, [0, 0, 0], [0.038, 0.026, 0.044])
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0022, 6, 18), new THREE.MeshBasicMaterial({ color: penPalette.paper, toneMapped: false }))
    this.ring.add(createPenSilhouette(this.ring.geometry, 2, penPalette.ink, 'weapon'))
    this.ring.position.set(0.02, 0.01, -0.01)
    this.left.add(this.ring)
    this.arms = [this.arm(key(0.24, -0.34, -0.1), key(0.75, -1, 0.4)), this.arm(key(-0.2, -0.34, -0.16), key(-0.7, -1, 0.3))]
    camera.add(this.root)
  }

  private shape(geometry: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.add(createPenSilhouette(geometry, 2.4))
    return mesh
  }
  private mitten(parent: THREE.Group, position: [number, number, number], scale: [number, number, number]) {
    const mesh = this.shape(this.palmGeometry)
    mesh.position.set(...position); mesh.scale.set(...scale)
    parent.add(mesh)
  }
  private arm(shoulder: THREE.Vector3, pole: THREE.Vector3): Arm {
    const upper = this.shape(this.upperGeometry), fore = this.shape(this.foreGeometry), elbow = this.shape(this.jointGeometry)
    this.root.add(upper, fore, elbow)
    return { shoulder, pole, upper, fore, elbow }
  }
  /** The same two-bone reach as the gun arms: 34 cm upper arm, 36 cm forearm. */
  private place(arm: Arm, wrist: THREE.Vector3) {
    const direction = wrist.clone().sub(arm.shoulder), distance = direction.length()
    direction.normalize()
    const a = 0.34, b = 0.36, d = THREE.MathUtils.clamp(distance, Math.abs(a - b) + 0.001, a + b - 0.001)
    const along = (a * a - b * b + d * d) / (2 * d), height = Math.sqrt(Math.max(0, a * a - along * along))
    const bend = arm.pole.clone().addScaledVector(direction, -arm.pole.dot(direction)).normalize()
    const elbow = arm.shoulder.clone().addScaledVector(direction, along).addScaledVector(bend, height)
    for (const [mesh, from, to] of [[arm.upper, arm.shoulder, elbow], [arm.fore, elbow, wrist]] as const) {
      const span = to.clone().sub(from)
      mesh.position.copy(from).add(to).multiplyScalar(0.5)
      mesh.scale.y = span.length()
      mesh.quaternion.setFromUnitVectors(up, span.normalize())
    }
    arm.elbow.position.copy(elbow)
  }

  /** Put this grenade in the hand (null: an empty hand, hidden). */
  show(kind: GrenadeKind | null) {
    if (kind === this.kind) return
    if (this.model) { this.model.removeFromParent(); disposeObject(this.model); this.model = null }
    this.kind = kind
    if (!kind) return
    this.model = grenadeModel(kind, 'weapon')
    this.model.position.set(0, 0, 0.006)
    this.mount.add(this.model)
  }

  pose(state: HandState, time: number, strength: Strength, reducedMotion: boolean) {
    const { timing } = RULES
    this.time += 1 / 60
    const lob = strength === 'lob'
    const hand = HAND.hold.clone(), left = LEFT.rest.clone()
    let visible = true, pull = 0
    if (state === 'draw') hand.lerp(HAND.low, 1 - smooth(time, 0, timing.draw))
    else if (state === 'pin') {
      // The left hand comes to the ring, then pulls it away.
      const reach = smooth(time, 0, timing.pin * 0.55)
      left.lerp(HAND.hold.clone().add(key(-0.01, 0.07, 0)), reach)
      pull = smooth(time, timing.pin * 0.55, timing.pin)
      left.lerp(LEFT.pull, pull)
    } else if (state === 'cocked') {
      hand.lerp(lob ? HAND.lobCocked : HAND.cocked, smooth(time, 0, 0.12))
      left.copy(LEFT.pull).lerp(LEFT.rest, smooth(time, 0.1, 0.4)); pull = 1
    } else if (state === 'swing') {
      const p = time / timing.swing, at = timing.release / timing.swing
      hand.copy(lob ? HAND.lobCocked : HAND.cocked)
      hand.lerp(lob ? HAND.lobRelease : HAND.release, smooth(p, 0, at))
      hand.lerp(lob ? HAND.lobFollow : HAND.follow, smooth(p, at, 1))
      visible = time < timing.release
      pull = 1
    }
    if (!reducedMotion && state === 'ready') hand.y += Math.sin(this.time * 2.2) * 0.004
    this.mount.position.copy(hand)
    // The fist turns its knuckles forward as it throws.
    const swing = state === 'swing' ? smooth(time / timing.swing, 0, 1) : 0
    this.mount.rotation.set(0.15 - (lob ? -0.5 : 0.9) * swing, -0.4, 0.12)
    if (this.model) {
      this.model.visible = visible
      ;(this.model.userData.ring as THREE.Object3D).visible = pull < 0.5
    }
    this.ring.visible = pull >= 0.5 && state !== 'cocked' || state === 'cocked' && time < 0.3
    this.left.position.copy(left)
    this.left.rotation.set(0.3, 0.4, -0.2)
    const leftVisible = left.distanceTo(LEFT.rest) > 0.05
    this.left.visible = leftVisible
    const leftArm = this.arms[1]
    leftArm.upper.visible = leftArm.fore.visible = leftArm.elbow.visible = leftVisible
    this.root.updateMatrixWorld(true)
    const wrist = this.root.worldToLocal(this.mount.localToWorld(key(0.012, -0.01, -0.04)))
    this.place(this.arms[0], wrist)
    if (leftVisible) this.place(this.arms[1], this.root.worldToLocal(this.left.localToWorld(key(0.025, -0.01, 0.045))))
  }

  dispose() {
    this.show(null)
    this.root.removeFromParent()
    for (const geometry of [this.upperGeometry, this.foreGeometry, this.jointGeometry, this.palmGeometry, this.ring.geometry]) geometry.dispose()
    this.material.dispose()
  }
}
