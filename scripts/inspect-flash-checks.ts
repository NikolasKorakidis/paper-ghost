import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CollisionWorld } from '../src/player/collision'
import { FirstPersonWeapons } from '../src/game/weapons'
import { transientLights, type NeonLightSpec } from '../src/render/neon'
import type { WeaponFrame, WeaponName } from '../src/game/types'

// A minimal DOM for the grenade HUD (as in grenade-checks.ts).
const element = (): Record<string, unknown> => {
  const node: Record<string, unknown> = { hidden: false, style: {}, dataset: {}, className: '', innerHTML: '' }
  Object.assign(node, { setAttribute() {}, append() {}, after() {}, remove() {} })
  return node
}
;(globalThis as Record<string, unknown>).document ??= { createElement: element, querySelector: () => null, body: element() }
const { Grenades, flashEnvelope } = await import('../src/game/grenades')

// Inspecting a weapon (F with nothing to use): it leaves the hold, comes back to exactly the hold, and anything the
// weapon does puts it straight back.
for (const name of ['ak', 'pistol', 'knife'] as WeaponName[]) {
  for (const fps of [30, 60, 144]) {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 16 / 9, .06, 100)
    scene.add(camera)
    const world = new CollisionWorld(scene)
    const weapons = new FirstPersonWeapons({ scene, camera, world, onShot() {}, emit() {} })
    weapons.restore({ slots: [{ id: name, name, magazine: 10, reserve: 20 }], selected: 0, pickups: [], nextId: 1 })
    const frame: WeaponFrame = { active: true, climbing: false, moving: 0, aiming: false, reducedMotion: false, feet: new THREE.Vector3() }
    const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * fps); i++) weapons.update(1 / fps, frame) }
    step(1)
    const mount = scene.getObjectByName('Firing hand grip mount')!
    const hold = mount.position.clone(), turn = mount.quaternion.clone()
    assert(weapons.inspect(), `${name} ${fps}fps: F starts an inspection`)
    step(1.2)
    assert(weapons.inspectingWeapon, `${name} ${fps}fps: still inspecting partway through`)
    assert(mount.position.distanceTo(hold) > 0.03 && mount.quaternion.angleTo(turn) > 0.3, `${name} ${fps}fps: the weapon is brought in and turned to show it`)
    step(2.2)
    assert(!weapons.inspectingWeapon, `${name} ${fps}fps: the inspection ends by itself`)
    assert(mount.position.distanceTo(hold) < 1e-6 && mount.quaternion.angleTo(turn) < 1e-6, `${name} ${fps}fps: and the weapon is back in the hold exactly`)
    // Firing puts it straight back.
    assert(weapons.inspect()); step(0.5)
    weapons.trigger(true); weapons.trigger(false)
    assert(!weapons.inspectingWeapon, `${name}: firing ends the inspection`)
    step(1)
    // Aiming ends it, and it cannot start while aimed.
    if (name !== 'knife') {
      assert(weapons.inspect()); step(0.3)
      frame.aiming = true; step(0.1)
      assert(!weapons.inspectingWeapon, `${name}: aiming ends the inspection`)
      step(0.5)
      assert(!weapons.inspect(), `${name}: no inspection while aimed`)
      frame.aiming = false; step(1)
      // A reload ends it.
      assert(weapons.inspect()); step(0.3)
      assert(weapons.reload())
      assert(!weapons.inspectingWeapon, `${name}: reloading ends the inspection`)
    }
    weapons.dispose()
  }
}
console.log('PASS Weapons inspect on F, return exactly to the hold, and firing, aiming and reloading cut it short')

// A flashbang's light: full for a blink, then dying fast, gone by the end of its life.
assert.equal(flashEnvelope(0), 1)
assert.equal(flashEnvelope(0.04), 1)
assert(flashEnvelope(0.2) < 0.4 && flashEnvelope(0.2) > 0.2, 'A fifth of a second in it is a third as bright')
for (let t = 0.05; t < 0.9; t += 0.05) assert(flashEnvelope(t + 0.05) < flashEnvelope(t), 'It only ever dims')
assert.equal(flashEnvelope(0.9), 0)
console.log('PASS The flashbang light flares for a blink and dies away within a second')

// Going off puts a burst of real light at the grenade, lit at once, and takes it away again at any frame rate.
for (const fps of [30, 60, 144]) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera()
  scene.add(camera)
  const grenades = new Grenades({ scene, camera, world: new CollisionWorld(scene), emit() {} })
  const frame = { active: false, eye: new THREE.Vector3(0, 1.6, 0), forward: new THREE.Vector3(0, 0, -1), velocity: new THREE.Vector3(), reducedMotion: false }
  const origin = new THREE.Vector3(3, 0.1, -4)
  ;(grenades as unknown as { flashbang(origin: THREE.Vector3): void }).flashbang(origin)
  assert.equal(transientLights.size, 1, `${fps}fps: the flash adds one light`)
  const [light] = transientLights
  const spec = light.userData.neonLight as NeonLightSpec
  assert(spec.instant, 'It comes on at once, with its shadows drawn at once')
  assert(light.getWorldPosition(new THREE.Vector3()).distanceTo(origin) < 0.5, 'It is where the grenade went off')
  assert.equal(spec.dimmer!(), 1, 'At full strength the moment it goes off')
  for (let i = 0; i < Math.round(0.3 * fps); i++) grenades.update(1 / fps, frame)
  assert(spec.dimmer!() < 0.3, `${fps}fps: dying away a third of a second later`)
  for (let i = 0; i < Math.round(0.7 * fps); i++) grenades.update(1 / fps, frame)
  assert.equal(transientLights.size, 0, `${fps}fps: gone within a second`)
  assert(!light.parent, 'And out of the scene')
  // A checkpoint retry mid-flash takes the light away too.
  ;(grenades as unknown as { flashbang(origin: THREE.Vector3): void }).flashbang(origin)
  grenades.restore()
  assert.equal(transientLights.size, 0, 'Restoring a checkpoint clears a flash still burning')
  grenades.dispose()
}
console.log('PASS A flashbang lights its surroundings with an instant burst that is gone within a second, also on retry')
