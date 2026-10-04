import * as THREE from 'three'
import { Draft } from '../render/ink'
import { lightBurst, type NeonLightSpec } from '../render/neon'

type Lamp = { id: string; group: THREE.Object3D; bulb: THREE.Object3D; centre: THREE.Vector3 }
type Shard = { mesh: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; age: number }

/** How close (m) a bullet must pass a bulb to break it: the bulb and its wire cage. */
const HIT_RADIUS = 0.13

/**
 * The caged ceiling lamps (cageLamp in world/lights.ts), which a bullet can break: the bulb bursts in a blue-white
 * spark and a shower of glass, and its light goes out, so the room it lit goes dark around it. Which lamps are out is
 * mission state (MissionState.lampsOut), so a checkpoint retry or a restart lights them again.
 */
export class Lamps {
  private lamps: Lamp[] = []
  private shards: Shard[] = []
  private effects = new THREE.Group()

  /** `floorBelow` is the height of the floor under a point (where the glass lands). */
  constructor(scene: THREE.Object3D, private floorBelow: (point: THREE.Vector3) => number) {
    scene.updateMatrixWorld(true)
    scene.traverse(group => {
      if (!group.userData.neonFixture || !group.name.endsWith(' · lamp')) return
      const base = group.name.slice(0, -' · lamp'.length)
      const bulb = group.children.find(child => child.name === `${base} · bulb`)
      const glow = group.children.find(child => child.userData.neonLight)
      if (!bulb || !glow) return
      const spec = glow.userData.neonLight as NeonLightSpec, own = spec.dimmer
      spec.dimmer = () => group.userData.out ? 0 : own?.() ?? 1
      this.lamps.push({ id: group.name, group, bulb, centre: bulb.getWorldPosition(new THREE.Vector3()) })
    })
    this.effects.name = 'Broken lamp glass'
    this.effects.userData.noCollision = true
    scene.add(this.effects)
  }

  get count() { return this.lamps.length }

  /** The nearest lit lamp a bullet from `origin` along `direction` breaks before `range` metres, if any. */
  hit(origin: THREE.Vector3, direction: THREE.Vector3, range: number) {
    let best: Lamp | null = null, bestAlong = range
    const toward = new THREE.Vector3()
    for (const lamp of this.lamps) {
      if (lamp.group.userData.out || !lamp.group.visible) continue
      const along = toward.copy(lamp.centre).sub(origin).dot(direction)
      if (along < 0 || along > bestAlong) continue
      if (toward.copy(origin).addScaledVector(direction, along).distanceTo(lamp.centre) > HIT_RADIUS) continue
      best = lamp; bestAlong = along
    }
    return best ? { id: best.id, distance: bestAlong } : null
  }

  /** Show the lamps as the state has them: out or lit. */
  apply(out: readonly string[] = []) {
    for (const lamp of this.lamps) {
      const broken = out.includes(lamp.id)
      lamp.group.userData.out = broken
      lamp.bulb.visible = !broken
    }
    if (!out.length) this.clearShards()
  }

  /** A lamp breaks now: a spark of light and its glass falling. (Its light goes out through apply.) */
  smash(id: string) {
    const lamp = this.lamps.find(candidate => candidate.id === id)
    if (!lamp) return
    lightBurst(lamp.centre, { color: 0xdde9ff, intensity: 10, range: 4.5, life: 0.18, hold: 0.03 })
    const floor = this.floorBelow(lamp.centre) + 0.01
    for (let i = 0; i < 9; i++) {
      const piece = new Draft(`${id} · glass ${i}`)
      const size = 0.012 + Math.random() * 0.02
      piece.box(size * 2, 0.003, size, 0, 0, 0, 'paper', 'detail')
      piece.position.copy(lamp.centre)
      piece.userData.noCollision = true
      piece.userData.floor = floor
      this.effects.add(piece.finish())
      const a = Math.random() * Math.PI * 2
      this.shards.push({ mesh: piece, age: 0, velocity: new THREE.Vector3(Math.cos(a) * (0.6 + Math.random()), 0.6 + Math.random(), Math.sin(a) * (0.6 + Math.random())),
        spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12) })
    }
  }

  /** The glass falls and settles; returns whether any is still moving. */
  update(dt: number) {
    for (const shard of [...this.shards]) {
      shard.age += dt
      if (shard.age > 2.5) { shard.mesh.removeFromParent(); this.shards.splice(this.shards.indexOf(shard), 1); continue }
      if (shard.mesh.position.y <= shard.mesh.userData.floor) continue
      shard.velocity.y -= 9.8 * dt
      shard.mesh.position.addScaledVector(shard.velocity, dt)
      shard.mesh.rotation.x += shard.spin.x * dt; shard.mesh.rotation.y += shard.spin.y * dt; shard.mesh.rotation.z += shard.spin.z * dt
    }
    return this.shards.length > 0
  }

  private clearShards() {
    for (const shard of this.shards) shard.mesh.removeFromParent()
    this.shards = []
  }

  dispose() {
    this.clearShards()
    this.effects.removeFromParent()
  }
}
