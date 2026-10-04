import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildLevel } from '../src/levels'
import { CollisionWorld } from '../src/player/collision'
import { addExitSigns } from '../src/world/exitSigns'
import { placeWindowShadows, windowPanes, type ClearPath } from '../src/world/lights'
import type { DarkRoomSpec, NeonLightSpec } from '../src/render/neon'

/*
 * Every light in both campaign maps sits where it can work: lighting goes wrong when a light's line runs through a
 * wall or a shelf (a hot spot where it passes, and light on the far side), when its shadows are seen from inside
 * something, or when one light spans two rooms (the camera room lit from behind its walls by the hall's windows).
 */
for (const id of ['compound', 'town', 'light-room'] as const) {
  const { ground, world } = buildLevel(id)
  const scene = new THREE.Scene()
  scene.add(ground)
  if (world) scene.add(world.root)
  addExitSigns(scene)
  scene.updateMatrixWorld(true)
  const collision = new CollisionWorld(scene)
  const clear: ClearPath = (from, to) => { const d = from.distanceTo(to); return d < 0.01 || collision.rayDistance(from, to.clone().sub(from).normalize(), d) >= d - 0.02 }
  placeWindowShadows(scene, clear)
  const lights: THREE.Object3D[] = [], rooms: THREE.Object3D[] = []
  scene.traverse(object => { if (object.userData.neonLight) lights.push(object); if (object.userData.darkRoom) rooms.push(object) })
  const roomsAt = (point: THREE.Vector3) => rooms.filter(room => {
    const local = room.worldToLocal(point.clone()), [x, y, z] = (room.userData.darkRoom as DarkRoomSpec).half
    return Math.abs(local.x) <= x + 0.03 && Math.abs(local.y) <= y + 0.03 && Math.abs(local.z) <= z + 0.03
  }).map(room => room.name).sort().join(' + ')
  let windows = 0
  for (const light of lights) {
    const spec = light.userData.neonLight as NeonLightSpec
    const at = (point: THREE.Vector3Tuple) => new THREE.Vector3(...point).applyMatrix4(light.matrixWorld)
    const name = `${id}: ${light.name}`
    const origin = spec.shadowFrom ? at(spec.shadowFrom) : at(spec.start).lerp(at(spec.end), 0.5)
    const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    assert(!around.every(([x, y, z]) => !clear(origin, origin.clone().add(new THREE.Vector3(x, y, z).multiplyScalar(0.05)))), `${name}: its shadows are seen from inside something`)
    if (spec.window) {
      windows++
      const hidden = windowPanes(light, clear).hidden
      assert.equal(hidden.length, 0, `${name}: its shadow point cannot see the open panes at ${hidden.join(', ')}`)
      // One room's windows: the row's ends are in the same room as its middle.
      const middle = (spec.start[0] + spec.end[0]) / 2, offsets = spec.window.offsets
      const ends = [Math.min(...offsets), 0, Math.max(...offsets)].map(x => roomsAt(at([middle + x, 0, 0.3])))
      assert(ends.every(rooms => rooms === ends[0]), `${name}: the row spans more than one room (${[...new Set(ends)].join(' | ')})`)
    } else if ((spec.radius ?? 0.05) < 0.2) {
      // A tube or bulb: its glowing line is in open air.
      const a = at(spec.start), b = at(spec.end)
      assert(a.distanceTo(b) < 0.3 || clear(a, b), `${name}: its line runs through something solid`)
    }
  }
  assert(windows >= (id === 'light-room' ? 1 : 20), `${id}: the check saw the windows (${windows})`)
}
console.log('PASS Every light in both maps and the light room is placed to work: no line through a wall, no window row across two rooms, shadows seen from open space that sees every open pane')
