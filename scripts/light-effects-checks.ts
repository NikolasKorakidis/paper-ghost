import assert from 'node:assert/strict'
import * as THREE from 'three'
import { lightBurst, NeonLights, transientLights, type NeonLightSpec } from '../src/render/neon'
import { cageLamp, darkRoom } from '../src/world/lights'
import { Lamps } from '../src/game/lamps'
import { AlarmBeacons } from '../src/game/beacons'
import { initialMission } from '../src/game/mission'
import { buildLevel } from '../src/levels'

// Just enough renderer for the lighting's shadow pass.
const renderer = {
  initRenderTarget() {}, getClearAlpha: () => 1, getClearColor: (color: THREE.Color) => color, setClearColor() {},
  coordinateSystem: THREE.WebGLCoordinateSystem, xr: { enabled: false },
  getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {}, render() {},
} as unknown as THREE.WebGLRenderer

{
  // Bursts flare and burn out by themselves, at any frame rate; a muzzle flash never takes a shadowed slot, an
  // explosion takes one at once.
  for (const fps of [30, 60, 144]) {
    transientLights.clear()
    const scene = new THREE.Scene()
    scene.add(darkRoom('test room', [0, 1.5, 0], [6, 1.5, 6]))
    scene.updateMatrixWorld(true)
    const lights = new NeonLights(scene)
    const muzzle = lightBurst(new THREE.Vector3(0, 1.4, 0), { color: 0xffc77a, intensity: 16, range: 6, life: 0.07 }, 10)
    const blast = lightBurst(new THREE.Vector3(2, 0.5, 0), { color: 0xffa04a, intensity: 85, range: 14, life: 0.8, shadows: true }, 10)
    lights.update(renderer, new THREE.Vector3(0, 1.6, 2), 10)
    assert(lights.active.includes(blast), `${fps}fps: an explosion lights with shadows from its first frame`)
    assert(!lights.active.includes(muzzle) && lights.distant.includes(muzzle), `${fps}fps: a muzzle flash shines without shadows, first among the distant lights`)
    assert.equal((muzzle.userData.neonLight as NeonLightSpec).dimmer!(), 1, 'Both are at full strength as they go off')
    for (let t = 10; t < 10.12; t += 1 / fps) lights.update(renderer, new THREE.Vector3(0, 1.6, 2), t)
    assert(!transientLights.has(muzzle), `${fps}fps: the muzzle flash is gone within a tenth of a second`)
    assert(transientLights.has(blast) && (blast.userData.neonLight as NeonLightSpec).dimmer!() < 0.75, `${fps}fps: the explosion is still dying away`)
    for (let t = 10.12; t < 11; t += 1 / fps) lights.update(renderer, new THREE.Vector3(0, 1.6, 2), t)
    assert(!transientLights.has(blast) && !lights.active.includes(blast), `${fps}fps: and gone within its life`)
  }
}
console.log('PASS Bursts of light flare and burn out by themselves: explosions with shadows at once, muzzle flashes without')

{
  // A bullet past a lit ceiling lamp breaks it: its light goes out. The state brings it back.
  const scene = new THREE.Scene()
  const lamp = cageLamp('Test lamp', [0, 3, 0])
  scene.add(lamp)
  const lamps = new Lamps(scene, () => 0)
  assert.equal(lamps.count, 1, 'The lamp is found')
  const glow = lamp.children.find(child => child.userData.neonLight)!
  const brightness = () => (glow.userData.neonLight as NeonLightSpec).dimmer?.() ?? 1
  assert.equal(brightness(), 1, 'Lit to begin with')
  const bulb = new THREE.Vector3(0, 3 - 0.45, 0)
  assert.equal(lamps.hit(new THREE.Vector3(0, 1.6, 5), bulb.clone().add(new THREE.Vector3(0.4, 0, 0)).sub(new THREE.Vector3(0, 1.6, 5)).normalize(), 20), null, 'A shot 40 cm wide misses it')
  const aim = bulb.clone().sub(new THREE.Vector3(0, 1.6, 5)).normalize()
  assert.equal(lamps.hit(new THREE.Vector3(0, 1.6, 5), aim, 3), null, 'A shot stopped by a wall before it misses it')
  const hit = lamps.hit(new THREE.Vector3(0, 1.6, 5), aim, 20)
  assert(hit, 'A shot at the bulb breaks it')
  const state = initialMission([])
  state.lampsOut = [hit.id]
  lamps.smash(hit.id); lamps.apply(state.lampsOut)
  assert.equal(brightness(), 0, 'Its light goes out')
  assert.equal(lamps.hit(new THREE.Vector3(0, 1.6, 5), aim, 20), null, 'A broken lamp cannot be broken again')
  for (let i = 0; i < 200; i++) lamps.update(1 / 60)
  lamps.apply(initialMission([]).lampsOut)
  assert.equal(brightness(), 1, 'A restart (or a checkpoint from before) lights it again')
  lamps.dispose()
}
console.log('PASS A bullet breaks a ceiling lamp and its light goes out; a retry lights it again')

{
  // The compound's alarm beacons: on the roofs round the alarm, dark until it sounds.
  transientLights.clear()
  const { ground, world } = buildLevel('compound')
  const scene = new THREE.Scene()
  scene.add(ground, world!.root)
  const alarm = world!.stations.find(station => station.kind === 'alarm')!
  const beacons = new AlarmBeacons(scene, alarm.point)
  assert.equal(beacons.count, 3, 'Three beacons')
  const beaconLights = [...transientLights]
  const level = () => Math.max(...beaconLights.map(light => (light.userData.neonLight as NeonLightSpec).dimmer!()))
  beacons.update(false, 1)
  assert.equal(level(), 0, 'Dark while the alarm is quiet')
  const seen: number[] = []
  for (let t = 0; t < 1; t += 0.05) { beacons.update(true, t); seen.push(level()) }
  assert(Math.max(...seen) > 0.9 && Math.min(...seen) < 0.5, 'Sounding, they sweep: bright once a turn, dimmer between')
  for (const light of beaconLights) {
    const at = light.getWorldPosition(new THREE.Vector3())
    assert(at.distanceTo(alarm.point) < 80 && at.y > 2, `${light.name}: on a roof near the alarm`)
  }
  beacons.dispose()
  assert.equal(transientLights.size, 0, 'Leaving the level takes them away')
  const none = new AlarmBeacons(new THREE.Scene(), null)
  assert.equal(none.count, 0, 'A level without an alarm has none')
}
console.log('PASS Alarm beacons sit on the roofs round the alarm and sweep red only while it sounds')
