import * as THREE from 'three'
import { Draft } from '../render/ink'
import { transientLights, type NeonLightSpec } from '../render/neon'

/** The beacons' red, and how fast each one turns (turns a second). */
const BEACON_RED = 0xff2a1f
const TURNS = 1.1

/**
 * Alarm beacons: a red rotating light on the roof of each of the buildings nearest the alarm. Dark until the alarm
 * goes off; then each one sweeps red light over the roofs and walls round it (real light, with shadows), until it is
 * silenced. Only levels with an alarm station get them.
 */
export class AlarmBeacons {
  private beacons: { root: THREE.Object3D; dome: THREE.Mesh; light: THREE.Object3D; phase: number }[] = []
  private on = false
  private time = 0
  private readonly lit = Object.assign(new THREE.MeshBasicMaterial({ color: 0xff5a40 }), { defines: { NEON_UNLIT: '' } })
  private readonly dark = new THREE.MeshBasicMaterial({ color: 0x5a1410 })

  constructor(scene: THREE.Object3D, alarm: THREE.Vector3 | null, count = 3) {
    if (!alarm) return
    scene.updateMatrixWorld(true)
    const buildings: { object: THREE.Object3D; distance: number }[] = []
    scene.traverse(object => {
      if (!object.userData.footprint || object.userData.kind === 'light-room-building') return
      buildings.push({ object, distance: object.getWorldPosition(new THREE.Vector3()).distanceTo(alarm) })
    })
    buildings.sort((a, b) => a.distance - b.distance)
    for (const [index, { object }] of buildings.slice(0, count).entries()) {
      const box = new THREE.Box3().setFromObject(object)
      if (!Number.isFinite(box.max.y) || box.max.y - box.min.y > 30) continue
      const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2)
      const root = new Draft(`${object.name} · alarm beacon`)
      root.position.copy(top)
      root.userData.noCollision = true
      // A short mast, so the beacon shows over a parapet, and a big red dome on it.
      root.box(0.4, 0.08, 0.4, 0, 0.04, 0, 'concrete', 'detail')
      root.beam([0, 0.08, 0], [0, 0.75, 0], 0.07, 'concrete', 'detail')
      root.box(0.42, 0.06, 0.42, 0, 0.78, 0, 'concrete', 'detail')
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.dark)
      dome.name = `${object.name} · alarm beacon dome`
      dome.position.y = 0.81
      root.add(dome)
      const light = new THREE.Object3D()
      light.name = `${object.name} · alarm beacon light`
      light.position.y = 0.95
      light.rotation.x = Math.PI / 2
      const beacon = { root: root.finish(), dome, light, phase: index * 0.37 }
      // A turning lamp seen from anywhere: a bright pulse once a turn, never quite dark while it runs.
      light.userData.neonLight = { start: [-0.05, 0, 0], end: [0.05, 0, 0], color: BEACON_RED, intensity: 30, range: 18, standoff: 4, radius: 0.2, bounce: 0.1,
        dimmer: () => this.on ? 0.15 + 0.85 * Math.pow(0.5 + 0.5 * Math.cos((this.time * TURNS + beacon.phase) * Math.PI * 2), 3) : 0 } satisfies NeonLightSpec
      root.add(light)
      scene.add(beacon.root)
      transientLights.add(light)
      this.beacons.push(beacon)
    }
  }

  get count() { return this.beacons.length }

  /** Every frame: whether the alarm is sounding, and real time (s) for the turning. Returns whether it needs frames. */
  update(sounding: boolean, time: number) {
    this.on = sounding
    this.time = time
    for (const beacon of this.beacons) beacon.dome.material = sounding ? this.lit : this.dark
    return sounding && this.beacons.length > 0
  }

  dispose() {
    for (const beacon of this.beacons) { transientLights.delete(beacon.light); beacon.root.removeFromParent() }
    this.beacons = []
    this.lit.dispose(); this.dark.dispose()
  }
}
