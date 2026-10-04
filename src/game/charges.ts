import * as THREE from 'three'
import { lightBurst } from '../render/neon'
import { Draft, type Point } from '../render/ink'
import { chargeStage } from './goals'
import type { MissionState } from './mission'
import type { ChargeSpec, EmitSound } from './types'
import './charges.css'

/**
 * A C4 charge, CS style: a brown block of four sticks taped together, a keypad and a small screen on top, a wire
 * loop and a red light. Built facing +Z, its base at the origin. `armed` adds the light that blinks while it ticks.
 */
export function c4Package(name: string) {
  const g = new Draft(name)
  g.userData.noCollision = true
  for (let i = 0; i < 4; i++) g.box(0.07, 0.07, 0.3, -0.105 + i * 0.07, 0.035, 0, 'timber', 'detail')
  // Black tape round the sticks, the keypad and its screen.
  for (const z of [-0.1, 0.1]) g.box(0.3, 0.075, 0.035, 0, 0.037, z, 'umber', 'detail')
  g.box(0.16, 0.025, 0.13, 0, 0.083, -0.02, 'paper', 'detail')
  g.box(0.12, 0.004, 0.035, 0, 0.097, -0.06, 'glass', false)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) g.box(0.025, 0.01, 0.018, -0.035 + c * 0.035, 0.1, -0.01 + r * 0.03, 'paper', false)
  g.line(Array.from({ length: 7 }, (_, i): Point => [0.08 + Math.sin(i / 6 * Math.PI) * 0.05, 0.08 + Math.sin(i / 6 * Math.PI * 2) * 0.01, -0.08 + i / 6 * 0.16]), 'detail')
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), Object.assign(new THREE.MeshBasicMaterial({ color: 0xd61f1f, toneMapped: false }), { defines: { NEON_UNLIT: '' } }))
  light.name = `${name} · light`
  light.position.set(0.06, 0.1, 0.05)
  light.userData.noCollision = true
  g.add(light)
  return g.finish()
}

/** How long each charge's beeps are apart (s) as its fuse runs down: slow at first, frantic at the end, like CS. */
export const beepInterval = (remaining: number, fuse: number) => THREE.MathUtils.lerp(0.09, 1, Math.pow(THREE.MathUtils.clamp(remaining / fuse, 0, 1), 1.6))

type Blast = { center: THREE.Vector3; age: number; group: THREE.Group; rings: THREE.Object3D[]; debris: { mesh: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3 }[]; smoke: THREE.Object3D[] }

/**
 * The level's timed charges (MissionWorld.charges): who carries one, planting it (hold still for its plant time),
 * the ticking fuse with its beeps and countdown, the blast and the wreck it leaves. Every step is in the mission
 * state (usedStations, chargesPlanted, chargesExploded), so a checkpoint, a save or a co-op guest sees the same.
 */
export class Charges {
  private ui = document.createElement('div')
  private armed = new Map<string, THREE.Object3D>()
  private nextBeep = new Map<string, number>()
  private planting: { spec: ChargeSpec; t: number; from: THREE.Vector3 } | null = null
  private seenExploded = new Set<string>()
  private blasts: Blast[] = []
  private flash = 0
  /** A charge has just gone off (host and solo: hurt and kill what is near it). */
  onExplode: (spec: ChargeSpec, center: THREE.Vector3) => void = () => {}
  /** Planting finished: the station is used and the fuse starts. */
  onPlanted: (spec: ChargeSpec) => void = () => {}

  constructor(private scene: THREE.Scene, private ground: THREE.Object3D, readonly specs: readonly ChargeSpec[], private emit: EmitSound) {
    this.ui.className = 'charge-hud'
    this.ui.hidden = true
    document.body.append(this.ui)
    for (const spec of specs) {
      const model = c4Package(`${spec.name} · armed`)
      model.position.set(...spec.blast.center)
      model.visible = false
      scene.add(model)
      this.armed.set(spec.id, model)
    }
  }

  /** The charge planted at this station, if it is one. */
  plantStation(stationId: string) { return this.specs.find(spec => spec.plant === stationId) }
  /** Whether the player has this charge on them, ready to plant. */
  carried(state: MissionState, spec: ChargeSpec) { return chargeStage(state, spec) === 'carried' }
  get busy() { return this.planting !== null }

  /** Start planting: the player must hold still for the charge's plant time. */
  beginPlant(spec: ChargeSpec, at: THREE.Vector3) {
    this.planting = { spec, t: 0, from: at.clone() }
    this.emit({ kind: 'c4-arm', position: at.clone(), radius: 8 })
  }
  cancelPlant() { this.planting = null }

  /**
   * Show the world as the state has it: the charges, the wrecks, and any blast that has just happened. `instant`
   * (a checkpoint or a load) lays everything out without effects.
   */
  sync(state: MissionState, instant = false) {
    for (const spec of this.specs) {
      const stage = chargeStage(state, spec)
      this.armed.get(spec.id)!.visible = stage === 'armed'
      const exploded = stage === 'exploded'
      for (const name of spec.destroys) { const object = this.ground.getObjectByName(name); if (object) object.visible = !exploded }
      const wreck = spec.wreck ? this.ground.getObjectByName(spec.wreck) : null
      if (wreck) wreck.visible = exploded
      if (exploded && !this.seenExploded.has(spec.id) && !instant) this.blast(spec)
      if (exploded) this.seenExploded.add(spec.id); else this.seenExploded.delete(spec.id)
    }
    if (instant) { this.planting = null; this.nextBeep.clear() }
  }

  /** Every frame: planting progress, the fuse and its beeps, the countdown, and the blasts' effects. */
  update(dt: number, state: MissionState, player: THREE.Vector3, host: boolean, visible: boolean, reducedMotion: boolean) {
    // Planting: hold still; walking away cancels it.
    if (this.planting) {
      if (player.distanceTo(this.planting.from) > 0.8 || state.phase !== 'active') this.planting = null
      else if ((this.planting.t += dt) >= this.planting.spec.plantTime) {
        const spec = this.planting.spec
        this.planting = null
        this.onPlanted(spec)
      }
    }
    let ticking: { spec: ChargeSpec; remaining: number } | null = null
    for (const spec of this.specs) {
      const planted = state.chargesPlanted[spec.id]
      if (planted === undefined || state.chargesExploded.includes(spec.id)) { this.nextBeep.delete(spec.id); continue }
      const remaining = spec.fuse - (state.elapsed - planted)
      ticking = { spec, remaining }
      const model = this.armed.get(spec.id)!
      const beepAt = this.nextBeep.get(spec.id) ?? state.elapsed
      if (state.elapsed >= beepAt) {
        this.emit({ kind: 'c4-beep', position: model.position.clone(), radius: 40, intensity: 1 - remaining / spec.fuse })
        this.nextBeep.set(spec.id, state.elapsed + beepInterval(remaining, spec.fuse))
      }
      const light = model.getObjectByName(`${spec.name} · armed · light`)
      if (light) light.visible = state.elapsed - beepAt + beepInterval(remaining, spec.fuse) < 0.06 || remaining < 1.5
      if (remaining <= 0 && host) {
        state.chargesExploded.push(spec.id)
        this.sync(state)
      }
    }
    // A guest learns of the blast from the host's state.
    if (!host) this.sync(state)
    this.updateBlasts(dt, reducedMotion)
    this.draw(state, ticking, visible)
  }

  private draw(state: MissionState, ticking: { spec: ChargeSpec; remaining: number } | null, visible: boolean) {
    const carried = this.specs.find(spec => this.carried(state, spec))
    let html = ''
    if (this.planting) {
      const share = Math.min(1, this.planting.t / this.planting.spec.plantTime)
      html = `<b>PLANTING ${this.planting.spec.name}</b><div class="charge-progress"><i style="width:${(share * 100).toFixed(0)}%"></i></div><small>Hold still</small>`
    } else if (ticking && ticking.remaining > 0) {
      const tenths = Math.max(0, ticking.remaining)
      html = `<b>${ticking.spec.name} ARMED</b><span class="charge-clock">00:${String(Math.floor(tenths)).padStart(2, '0')}<em>.${Math.floor((tenths % 1) * 10)}</em></span><small>Get clear</small>`
    } else if (carried) {
      html = `<b>${carried.name}</b><small>Carried · plant it at the target (F)</small>`
    }
    this.ui.hidden = !visible || !html
    if (html && this.ui.innerHTML !== html) this.ui.innerHTML = html
    this.ui.classList.toggle('is-ticking', !!ticking && ticking.remaining > 0 && !this.planting)
    this.ui.classList.toggle('is-urgent', !!ticking && ticking.remaining < 3)
    document.body.classList.toggle('charge-flash', this.flash > 0)
  }

  /** The blast: a flash, a loud bang, shock rings racing out along the ground, debris thrown up and smoke rising. */
  private blast(spec: ChargeSpec) {
    const center = new THREE.Vector3(...spec.blast.center)
    this.emit({ kind: 'charge-explosion', position: center.clone(), radius: 160 })
    this.flash = 0.35
    // The blast lights everything round it, with real shadows, and dies away over a second and a half.
    lightBurst(center.clone().setY(center.y + 1), { color: 0xff8a38, intensity: 170, range: 26, life: 1.5, hold: 0.1, shadows: true, radius: 0.8 })
    const group = new THREE.Group()
    group.name = `${spec.name} · blast`
    group.userData.noCollision = true
    const rings: THREE.Object3D[] = []
    for (let i = 0; i < 3; i++) {
      const ring = new Draft(`${spec.name} · shock ring ${i}`, center.x, center.z)
      ring.position.y = center.y + 0.1 + i * 0.6
      ring.ring(1, 0, 0, 0, 'edge', 48)
      ring.userData.delay = i * 0.08
      rings.push(ring.finish()); group.add(ring)
    }
    const debris: Blast['debris'] = []
    for (let i = 0; i < 22; i++) {
      const piece = new Draft(`${spec.name} · debris ${i}`)
      const size = 0.15 + Math.random() * 0.45
      piece.box(size, size * 0.4, size * 0.8, 0, 0, 0, i % 3 ? 'paper' : 'concrete', 'detail')
      piece.position.copy(center).add(new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2))
      const a = Math.random() * Math.PI * 2, speed = 6 + Math.random() * 10
      debris.push({ mesh: piece.finish(), velocity: new THREE.Vector3(Math.cos(a) * speed * 0.6, 7 + Math.random() * 9, Math.sin(a) * speed * 0.6),
        spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8) })
      group.add(piece)
    }
    const smoke: THREE.Object3D[] = []
    for (let i = 0; i < 9; i++) {
      const puff = new Draft(`${spec.name} · smoke ${i}`)
      puff.solid(new THREE.IcosahedronGeometry(1, 1), [0, 0, 0], 'paper', false, [0, 0, 0], true)
      puff.position.copy(center).add(new THREE.Vector3((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6))
      puff.userData.rise = 1.5 + Math.random() * 2
      puff.scale.setScalar(0.5)
      smoke.push(puff.finish()); group.add(puff)
    }
    this.scene.add(group)
    this.blasts.push({ center, age: 0, group, rings, debris, smoke })
    this.onExplode(spec, center)
  }

  private updateBlasts(dt: number, reducedMotion: boolean) {
    this.flash = Math.max(0, this.flash - dt)
    if (reducedMotion) this.flash = 0
    for (const blast of [...this.blasts]) {
      blast.age += dt
      for (const ring of blast.rings) {
        const t = Math.max(0, blast.age - (ring.userData.delay as number))
        ring.scale.setScalar(1 + t * 34)
        ring.visible = t > 0 && t < 0.7
      }
      for (const piece of blast.debris) {
        if (piece.velocity.lengthSq() === 0) continue
        piece.velocity.y -= 22 * dt
        piece.mesh.position.addScaledVector(piece.velocity, dt)
        piece.mesh.rotation.x += piece.spin.x * dt; piece.mesh.rotation.y += piece.spin.y * dt
        if (piece.mesh.position.y <= 0.1) { piece.mesh.position.y = 0.1; piece.velocity.set(0, 0, 0) }
      }
      for (const puff of blast.smoke) {
        puff.position.y += (puff.userData.rise as number) * dt
        puff.scale.setScalar(Math.min(3.2, 0.5 + blast.age * 1.4))
        puff.visible = blast.age < 9
      }
    }
  }

  /** Remove the blasts' leftovers (a restart or a checkpoint). */
  clearEffects() {
    for (const blast of this.blasts) blast.group.removeFromParent()
    this.blasts = []
    this.flash = 0
    document.body.classList.remove('charge-flash')
  }

  dispose() {
    this.clearEffects()
    this.ui.remove()
    for (const model of this.armed.values()) model.removeFromParent()
  }
}
