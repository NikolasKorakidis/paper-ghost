import * as THREE from 'three'
import { transientLights, type DarkRoomSpec, type NeonLightSpec } from '../render/neon'

/**
 * Guards' flashlights. A guard hunting through a dark room (a body search, a sweep, investigating a noise) switches on
 * his torch: a warm light carried at chest height a little in front of him, shining forward and never behind him. It
 * joins the lighting as a light without shadows (render/neon.ts), so it costs no shadow pass, and it fades in and out.
 * Plain on/off per guard each frame; the lights are made on first use and kept.
 */
export const FLASHLIGHT = { color: 0xfff1cf, intensity: 5.5, range: 9, fade: 4 } as const

type Torch = { light: THREE.Object3D; level: number; on: boolean }
type Room = { inverse: THREE.Matrix4; half: THREE.Vector3 }

export class GuardFlashlights {
  private torches = new Map<string, Torch>()
  private rooms: Room[] = []
  private local = new THREE.Vector3()

  constructor(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true)
    scene.traverse(object => {
      const spec = object.userData.darkRoom as DarkRoomSpec | undefined
      if (!spec) return
      this.rooms.push({ inverse: object.matrixWorld.clone().invert(), half: new THREE.Vector3(...spec.half) })
    })
  }

  /** Whether `point` is inside one of the level's dark rooms. */
  dark(point: THREE.Vector3) {
    for (const room of this.rooms) {
      const p = this.local.copy(point).applyMatrix4(room.inverse)
      if (Math.abs(p.x) <= room.half.x && Math.abs(p.y) <= room.half.y && Math.abs(p.z) <= room.half.z) return true
    }
    return false
  }

  /** This guard's torch this frame: `on` or off, at his feet `position` facing `yaw`. */
  set(id: string, on: boolean, position: THREE.Vector3, yaw: number, dt: number) {
    let torch = this.torches.get(id)
    if (!torch) {
      if (!on) return
      torch = this.make(id)
    }
    torch.on = on
    torch.level = THREE.MathUtils.clamp(torch.level + (on ? 1 : -1) * dt * FLASHLIGHT.fade, 0, 1)
    const { light } = torch
    if (torch.level <= 0) { transientLights.delete(light); return }
    transientLights.add(light)
    light.position.set(position.x + Math.sin(yaw) * 0.45, position.y + 1.3, position.z + Math.cos(yaw) * 0.45)
    light.rotation.set(0, yaw, 0)
    light.updateMatrixWorld()
  }

  /** How bright each lit torch is (for checks). */
  get lit() { return [...this.torches.values()].filter(torch => torch.level > 0).length }

  private make(id: string): Torch {
    const light = new THREE.Object3D()
    light.name = `Flashlight · ${id}`
    const torch: Torch = { light, level: 0, on: false }
    // A short bright line across his chest; it shines toward its local +Z (his front) and lights nothing behind him.
    light.userData.neonLight = { start: [-0.04, 0, 0], end: [0.04, 0, 0], color: FLASHLIGHT.color, intensity: FLASHLIGHT.intensity, range: FLASHLIGHT.range,
      standoff: 0.25, radius: 0.08, bounce: 0.12, shadowless: true, dimmer: () => torch.level } satisfies NeonLightSpec
    this.torches.set(id, torch)
    return torch
  }

  clear() {
    for (const torch of this.torches.values()) { transientLights.delete(torch.light); torch.level = 0; torch.on = false }
  }

  dispose() {
    this.clear()
    this.torches.clear()
  }
}
