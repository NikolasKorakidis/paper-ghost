import assert from 'node:assert/strict'
import * as THREE from 'three'
import { NEON_FAR, NEON_MAX, NeonLights, neonUniforms, SUN_DIRECTION } from '../src/render/neon'
import { NEON_GREEN } from '../src/render/neon-sign'
import { createCompound } from '../src/world/compound'
import { createMissionWorld, prepareCompound } from '../src/game/world'
import { addExitSigns } from '../src/world/exitSigns'
import { CollisionWorld } from '../src/player/collision'

const basic = THREE.ShaderLib.basic
assert(basic.vertexShader.includes('#include <neon_vertex>') && basic.fragmentShader.includes('#include <neon_fragment>\n#include <opaque_fragment>'),
  'Every basic material is shaded by neon light, just before its colour is written')
// Three clones a built-in material's uniforms; the light values must survive that as shared references.
const copy = THREE.UniformsUtils.clone(basic.uniforms)
for (const name of ['neonStart', 'neonEnd', 'neonFacing', 'neonColor', 'neonParams', 'neonShadow'] as const) {
  assert.equal(copy[name].value, neonUniforms[name].value, `${name} is shared by every material, not copied`)
}
assert.equal(neonUniforms.neonShadow.value.length, NEON_MAX)
console.log('PASS Neon lighting is patched into the shared basic shader, and every material reads the same light values')

const compound = createCompound()
const mission = createMissionWorld(compound)
prepareCompound(compound)
const scene = new THREE.Scene()
scene.add(compound, mission.root)
const exits = addExitSigns(scene)
scene.updateMatrixWorld(true)
const exitDoors: THREE.Object3D[] = []
scene.traverse(object => { if (object.userData.kind === 'door' && object.userData.exit) exitDoors.push(object) })
assert(exitDoors.length >= 20, 'Every building entrance, cabin door, the detention entrance and the gate are exits')
const buildingOf = (door: THREE.Object3D) => { let node = door.parent; while (node && !node.userData.footprint) node = node.parent; return node }
const signedDoors = exitDoors.filter(door => exits.some(sign => sign.name === `${door.name} · EXIT sign`))
for (const door of exitDoors) {
  const building = buildingOf(door)
  const ways = exitDoors.filter(other => buildingOf(other) === building).length
  const expected = !!(door.userData.exit.always || building?.userData.missionSite || (building && ways > 1))
  assert.equal(signedDoors.includes(door), expected, `${door.name}: ${expected ? 'signed' : 'no sign'} (${ways} way${ways > 1 ? 's' : ''} out)`)
}
for (const name of ['South barracks A · entry 1', 'Inner gatehouse · entry 1']) assert(!signedDoors.some(door => door.name === name), `${name}: a single-exit building has no EXIT sign`)
for (const name of ['Detention entrance', 'Secure compound exit gate', 'Security cabin · north door', 'Central long warehouse · entry 2'])
  assert(signedDoors.some(door => door.name === name), `${name} is signed`)
for (const door of signedDoors) {
  const sign = exits.find(candidate => candidate.name === `${door.name} · EXIT sign`)!
  assert(sign, `${door.name} has its EXIT sign`)
  assert.equal(sign.userData.neonLight.color, NEON_GREEN, 'Exit signs are green')
  const local = door.worldToLocal(sign.getWorldPosition(new THREE.Vector3()))
  assert(Math.abs(local.x) < 0.01 && local.y > door.userData.height && local.z < 0, `${door.name}: the sign is centred above the door, on its inside`)
  const out = new THREE.Vector3(0, 0, 1).transformDirection(sign.matrixWorld)
  const inward = new THREE.Vector3(0, 0, -1).transformDirection(door.matrixWorld)
  assert(out.dot(inward) > 0.99, `${door.name}: the sign faces into the room`)
}
console.log(`PASS ${exits.length} green neon EXIT signs: buildings with more than one way out, the hostage and camera sites, and the gate`)

const security = scene.getObjectByName('Neon sign · SECURITY')!
const tubes = security.getObjectByName('SECURITY neon tubes') as THREE.Mesh
tubes.geometry.computeBoundingBox()
const box = tubes.geometry.boundingBox!
const spec = security.userData.neonLight
assert(box.min.z > 0.08 && spec.standoff >= 0.1, 'The tubes stand off the wall on supports, not flat against it')
assert(box.max.z - box.min.z > 0.015 && box.max.x - box.min.x > 1.5, 'They are round glass tubes spelling the whole word')
assert(security.getObjectByName('SECURITY neon supports') && security.getObjectByName('SECURITY neon raceway'), 'Supports and a raceway hold them')
// The physical world ignores signs: nothing about them blocks movement or shots.
const world = new CollisionWorld(scene)
const facing = new THREE.Vector3(0, 0, 1).transformDirection(security.matrixWorld)
const inFront = new THREE.Vector3(...spec.start).lerp(new THREE.Vector3(...spec.end), 0.5).applyMatrix4(security.matrixWorld).addScaledVector(facing, 0.6)
assert(world.rayDistance(inFront, facing.clone().negate(), 1) > 0.6 + spec.standoff - 0.02, 'A ray toward the sign passes through it to the wall')
world.dispose()
console.log('PASS The SECURITY sign is 3D neon tube on standoffs and a raceway, and never blocks movement')

const lights = new NeonLights(scene)
let sources = 0
scene.traverse(object => { if (object.userData.neonLight) sources++ })
assert.equal(lights.count, sources, 'Every light in the world is lit by the renderer: signs, screens, lamps, windows, doorways and stairwells')
assert(sources > exits.length + 100, `Every building brings its own windows, doorways and lamps: ${sources} lights`)
// Just enough renderer for the cube shadow pass; it counts the faces drawn.
let faces = 0
const renderer = {
  initRenderTarget() {}, getClearAlpha: () => 1, getClearColor: (color: THREE.Color) => color, setClearColor() {},
  coordinateSystem: THREE.WebGLCoordinateSystem, xr: { enabled: false },
  getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {},
  render() { faces++ },
} as unknown as THREE.WebGLRenderer
const nearSecurity = new THREE.Vector3(-36, 1.6, -46.65)
lights.update(renderer, nearSecurity, 100)
assert.equal(lights.active.length, NEON_MAX, 'Only the nearest signs are lit at once')
assert.equal(faces, 2, 'A new light draws its shadow two cube faces a frame, so lights coming on together never stall one frame')
assert.equal(neonUniforms.neonParams.value[2], 0, 'and casts no shadow until all six are drawn')
assert.equal(lights.active[0], security, 'The nearest one is lit first')
assert.equal(neonUniforms.neonParams.value[0], 0, 'A light that has just taken a slot starts dark and fades up')
lights.update(renderer, nearSecurity, 100.02)
lights.update(renderer, nearSecurity, 100.04)
assert.equal(faces, 6, 'Three frames draw all six faces')
assert.equal(neonUniforms.neonParams.value[2], 1, 'and its shadows switch on once they exist')
lights.update(renderer, nearSecurity, 101)
const [intensity, range, , standoff] = neonUniforms.neonParams.value
assert(intensity > 0 && range >= 5 && Math.abs(standoff - spec.standoff) < 1e-6, 'It is a switched-on light with a real reach')
const start = new THREE.Vector3().fromArray(neonUniforms.neonStart.value), end = new THREE.Vector3().fromArray(neonUniforms.neonEnd.value)
const lightFacing = new THREE.Vector3().fromArray(neonUniforms.neonFacing.value)
// The signals office door is at x -41.6 in the mess hall; the hall is the +X side of that wall.
assert(start.x > -41.4 && Math.abs(start.x - end.x) < 1e-6, 'The tube line runs along the hall side of the office wall, off the wall')
assert(lightFacing.x > 0.99, 'The light shines into the hall, away from the camera room')
assert(start.y > 2.9 && Math.abs(start.z - end.z) > 1.5 && Math.abs((start.z + end.z) / 2 + 46.65) < 0.05, 'It hangs centred above the door, as wide as the word')
const gate = exits.find(sign => sign.name.startsWith('Secure compound exit gate'))!
lights.update(renderer, new THREE.Vector3(158, 1.6, 11), 102)
assert(lights.active.includes(gate) && !lights.active.includes(security), 'Walking elsewhere hands the light slots to the signs nearby')
security.visible = false
lights.update(renderer, nearSecurity, 103)
assert(!lights.active.includes(security), 'A hidden sign gives no light')
security.visible = true
lights.shadows = false
lights.update(renderer, nearSecurity, 104)
assert(Array.from({ length: NEON_MAX }, (_, i) => neonUniforms.neonParams.value[i * 4 + 2]).every(value => value === 0), 'Shadows can be switched off')
console.log('PASS The nearest signs light the scene; SECURITY shines into the hall over the camera-room door')

{
  // The signals office is a dark room, lit only by its screen and by daylight through its door.
  const room = scene.getObjectByName('Signals office · darkness')!
  assert(room?.userData.darkRoom, 'The camera room is dark')
  const inside = (world: THREE.Vector3) => {
    const local = room.worldToLocal(world.clone())
    const half = room.userData.darkRoom.half as THREE.Vector3Tuple
    return Math.abs(local.x) < half[0] && Math.abs(local.y) < half[1] && Math.abs(local.z) < half[2]
  }
  const screen = scene.getObjectByName('Signals office · powered surveillance screen')!
  const door = scene.getObjectByName('Signals office door') as THREE.Group
  assert(inside(screen.getWorldPosition(new THREE.Vector3())), 'The screen is inside it')
  assert(inside(door.localToWorld(new THREE.Vector3(0, 1, -0.5))) && !inside(door.localToWorld(new THREE.Vector3(0, 1, 0.5))),
    'Its wall is the office partition: the office side is dark, the hall side is not')
  assert(!inside(security.getWorldPosition(new THREE.Vector3())), 'The SECURITY sign hangs outside it')
  const daylight = door.getObjectByName('Signals office door · daylight')!
  const doorLight = daylight.userData.neonLight
  const doors = await import('../src/world/doors')
  doors.setDoorOpen(door, false, true)
  assert.equal(doorLight.dimmer(), 0, 'No daylight comes in while the door is shut')
  doors.setDoorOpen(door, true, true, 1)
  assert.equal(doorLight.dimmer(), 1, 'It floods in with the door open')
  const daylightFacing = new THREE.Vector3(0, 0, 1).transformDirection(daylight.matrixWorld)
  assert(inside(daylight.getWorldPosition(new THREE.Vector3()).addScaledVector(daylightFacing, 1)), 'and shines into the office')
  doors.setDoorOpen(door, false, true)
  const office = new THREE.Vector3(-45.9, 1.6, -48)
  lights.shadows = true
  lights.update(renderer, office, 105)
  assert(lights.active.includes(scene.getObjectByName('Signals office · surveillance · screen light')!), 'In the office the screen is one of the lights')
  assert(!lights.active.includes(daylight), 'A shut door gives no light, so it takes no light slot')
  const [half] = [neonUniforms.neonDarkHalf.value]
  assert(half[0] > 0 && half[1] > 0 && half[2] > 0, 'The shader knows where the dark room is')
}
console.log('PASS The camera room is dark: only its screen, and daylight through the open door, light it')

{
  // The central warehouse has no fittings: it is a dim hall lit by daylight through its windows and open doors.
  const warehouse = scene.getObjectByName('Central long warehouse')!
  const room = warehouse.getObjectByName('Central long warehouse · darkness')!
  const spec = room.userData.darkRoom
  assert(spec.ambient > 0.05 && spec.ambient < 0.3, 'Dim but readable, not black')
  assert(spec.pitch.slope > 0 && spec.pitch.ridge > spec.half[1], 'Its top follows the pitched roof up to the ridge')
  const windows: THREE.Object3D[] = [], doorways: THREE.Object3D[] = []
  warehouse.traverse(object => {
    if (/windows · daylight$/.test(object.name)) windows.push(object)
    if (/entry \d · daylight$/.test(object.name)) doorways.push(object)
  })
  const panes = (row: THREE.Object3D) => row.userData.neonLight.window.offsets.length
  assert.deepEqual(windows.map(row => row.name.replace('Central long warehouse · ', '')).sort(), ['back windows · daylight', 'east windows · daylight', 'west windows · daylight'])
  assert.deepEqual(windows.map(panes).sort(), [1, 1, 3], 'Three high back windows and one in each end wall, one light per wall')
  assert.equal(doorways.length, 3, 'and its three big doors')
  for (const window of windows) {
    const facing = new THREE.Vector3(0, 0, 1).transformDirection(window.matrixWorld)
    const ahead = room.worldToLocal(window.getWorldPosition(new THREE.Vector3()).addScaledVector(facing, 1))
    assert(Math.abs(ahead.x) < spec.half[0] - 0.5 && Math.abs(ahead.z) < spec.half[2] - 0.5, `${window.name} shines into the hall`)
  }
  for (const doorway of doorways) assert.equal(doorway.userData.neonLight.dimmer(), 0, 'No daylight through a shut door')
  let fittings = 0
  warehouse.traverse(object => { if (object.userData.neonLight && !/daylight|EXIT/.test(object.name)) fittings++ })
  warehouse.traverse(object => { if (/lamp/.test(object.name)) fittings++ })
  assert.equal(fittings, 0, 'No light fittings inside')
}
console.log('PASS The central warehouse is lit only by daylight: its five windows (one light per wall) and its doors when open')

{
  // The cell block and the security cabin are dark rooms too.
  const insideRoom = (room: THREE.Object3D, world: THREE.Vector3) => {
    const local = room.worldToLocal(world.clone()), spec = room.userData.darkRoom
    const top = (spec.pitch?.ridge ?? spec.half[1]) - (spec.pitch?.slope ?? 0) * Math.abs(local.z)
    return Math.abs(local.x) < spec.half[0] && local.y > -spec.half[1] && local.y < top && Math.abs(local.z) < spec.half[2]
  }
  const cells = scene.getObjectByName('Detention cell block · darkness')!
  assert(cells && (cells.userData.darkRoom.ambient ?? 0.003) < 0.01, 'The cell block is dark')
  assert(insideRoom(cells, new THREE.Vector3(110.5, -3, -21)), 'The hostage cell is inside it')
  assert(!insideRoom(cells, new THREE.Vector3(117, 1.5, -12)), 'The guardroom upstairs is not')
  const cabin = scene.getObjectByName('Security cabin · darkness')!
  assert(cabin && insideRoom(cabin, scene.getObjectByName('Security cabin · surveillance screen')!.getWorldPosition(new THREE.Vector3())), 'The security cabin is dark around its monitor')
  for (const side of ['north', 'south']) assert(scene.getObjectByName(`Security cabin · ${side} door · daylight`), `Daylight comes through its ${side} door when open`)
  // The shader's cut-off: a surface is lit only while dot(p - start, facing) + standoff + 0.02 is not negative.
  const lit = (light: THREE.Object3D, world: THREE.Vector3) => {
    const spec = light.userData.neonLight
    const start = new THREE.Vector3(...spec.start).applyMatrix4(light.matrixWorld)
    const facing = new THREE.Vector3(0, 0, 1).transformDirection(light.matrixWorld)
    return world.clone().sub(start).dot(facing) + spec.standoff + 0.02 > 0
  }
  for (const name of ['Cell corridor north', 'Cell corridor south', 'Hostage cell']) {
    const lamp = scene.getObjectByName(`${name} · lamp light`)!
    const at = lamp.getWorldPosition(new THREE.Vector3())
    assert(lit(lamp, new THREE.Vector3(at.x, -4.2, at.z)) && lit(lamp, new THREE.Vector3(at.x, 0, at.z)), `${name}: lights the floor and the ceiling above it`)
    assert(!lit(lamp, new THREE.Vector3(at.x, 0.12, at.z)) && !lit(lamp, new THREE.Vector3(117, 0.12, -14)), `${name}: never the floor upstairs, even through the stairwell`)
  }
  assert(scene.getObjectByName('Detention stairwell · daylight'), 'Daylight falls down the stairwell')
}
console.log('PASS The cell block and security cabin are dark; the lamps stop at the ceiling and never light the floor above')

{
  // The Southwest stores, the other two-door warehouse, is daylight-only too.
  const stores = scene.getObjectByName('Southwest stores')!
  assert(stores.getObjectByName('Southwest stores · darkness')?.userData.darkRoom, 'The Southwest stores are dark inside')
  let windows = 0, doors = 0, lamps = 0
  stores.traverse(object => {
    if (/windows · daylight$/.test(object.name)) windows += object.userData.neonLight.window.offsets.length
    if (/entry \d · daylight$/.test(object.name)) doors++
    if (/lamp/.test(object.name)) lamps++
  })
  assert.equal(windows, 4, 'Two high back windows and one in each end wall'); assert.equal(doors, 2, 'and its two doors'); assert.equal(lamps, 0, 'and no lamps')
  // The detention block is furnished, with an amber lamp over each side of the cell block.
  const detention = scene.getObjectByName('Detention block and underground cells')!
  const furniture = (name: string) => { let n = 0; detention.getObjectByName(name)!.traverse(object => { if (object.userData.furniture) n++ }); return n }
  assert(furniture('Detention guardroom') >= 12 && furniture('Detention cell block') >= 10, 'The guardroom and the cell block are furnished')
  for (const name of ['Interrogation table · lamp light', 'Cell block stores · lamp light']) assert(scene.getObjectByName(name), `${name} lights the new furniture`)
}
console.log('PASS The Southwest stores are daylight-only; the detention guardroom and cell block are furnished and lit')


{
  // Every other building, and the mess hall, is dark inside and lit like a real building: daylight and sunbeams
  // through each wall's windows, daylight through the open entrance, and yellow caged ceiling lamps.
  const buildings = compound.children.filter(object => object.userData.enterable || object.userData.kind === 'mess-hall')
  const lit = buildings.filter(building => building.userData.kind !== 'warehouse')
  assert(lit.length >= 12, `Every barracks, office, hut, shed and the mess hall: ${lit.length}`)
  const world = new CollisionWorld(scene)
  let sunny = 0, shaded = 0
  for (const building of lit) {
    const room = building.children.find(child => child.userData.darkRoom && !/Signals office/.test(child.name))
    assert(room, `${building.name} is dark inside`)
    assert(room.userData.darkRoom.ambient < 0.06, `${building.name}: dark between its lights`)
    const rows: THREE.Object3D[] = [], lamps: THREE.Object3D[] = []
    building.traverse(object => {
      if (/windows · daylight$/.test(object.name)) rows.push(object)
      if (/lamp light$/.test(object.name)) lamps.push(object)
    })
    assert(lamps.length >= 1, `${building.name} has ceiling lamps`)
    for (const lamp of lamps) assert.equal(lamp.userData.neonLight.color, 0xffb24a, `${lamp.name} is the yellow cell-block lamp`)
    assert(rows.length >= 2, `${building.name}: daylight through its windows`)
    for (const row of rows) {
      const spec = row.userData.neonLight, window = spec.window
      assert(window.offsets.length >= 1 && window.offsets.length <= 4, `${row.name}: one light serves the wall's 1 to 4 panes`)
      const middle = new THREE.Vector3(...spec.start).lerp(new THREE.Vector3(...spec.end), 0.5).applyMatrix4(row.matrixWorld)
      const axis = new THREE.Vector3(...spec.end).sub(new THREE.Vector3(...spec.start)).normalize().transformDirection(row.matrixWorld)
      const facing = new THREE.Vector3(0, 0, 1).transformDirection(row.matrixWorld)
      for (const offset of window.offsets) for (const edge of [-1, 0, 1]) {
        // From the light's line (just inside the wall), straight out through each pane, near both its edges and in
        // its middle: glass or open air, never the wall itself. A light lined up with the wrong opening fails.
        const pane = middle.clone().addScaledVector(axis, offset + edge * (window.width / 2 - 0.15))
        const hit = world.raySurface(pane, facing.clone().negate(), 0.5)
        assert(!hit || !/wall/i.test(hit.mesh.name) || /glass surfaces$|· window -?[\d.]+:/.test(hit.mesh.name),
          `${row.name}: a pane ${offset.toFixed(2)} m along really is a window, not wall (hit ${hit?.mesh.name} at ${hit?.distance.toFixed(2)} m)`)
      }
      // The shader lets the sun in only where it shines toward the room (sun direction against the facing).
      if (SUN_DIRECTION.dot(facing) < -0.03) sunny++; else shaded++
      assert(window.sun > 0)
    }
  }
  assert(sunny > 10 && shaded > 10, `Sunbeams fall through the sunny-side windows only: ${sunny} sunny walls, ${shaded} in shade`)
  world.dispose()
}
console.log('PASS Every building but the two warehouses is dark, lit through its windows (panes line up with the holes) and by yellow ceiling lamps')

{
  // Shadow maps cost nothing while nothing moves, and only the faces that see a mover update when one does.
  const room = new THREE.Scene()
  const lamp = new THREE.Object3D(); lamp.position.set(0, 2.5, 0)
  lamp.userData.neonLight = { start: [-0.02, 0, 0], end: [0.02, 0, 0], color: 0xffb24a, standoff: 3, intensity: 3, range: 8 }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10), new THREE.MeshBasicMaterial())
  const door = new THREE.Group(); door.userData.doorHinge = true; door.position.set(3, 1, 0)
  door.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.05), new THREE.MeshBasicMaterial()))
  room.add(lamp, floor, door); room.updateMatrixWorld(true)
  const lit = new NeonLights(room)
  let drawn = 0
  const counting = { ...renderer, render() { drawn++ } } as unknown as THREE.WebGLRenderer
  for (const t of [0, 0.02, 0.04]) lit.update(counting, new THREE.Vector3(0, 1.6, 2), t)
  assert.equal(drawn, 6, 'A new light draws all six shadow faces once, over three frames')
  for (let t = 1; t < 4; t++) lit.update(counting, new THREE.Vector3(0, 1.6, 2), t)
  assert.equal(drawn, 6, 'and nothing more while nothing moves')
  door.position.x += 0.02; room.updateMatrixWorld(true)
  lit.update(counting, new THREE.Vector3(0, 1.6, 2), 5)
  assert.equal(drawn, 6, 'Two centimetres of movement (a guard breathing) leaves the shadow as it is')
  door.position.x += 0.3; room.updateMatrixWorld(true)
  lit.update(counting, new THREE.Vector3(0, 1.6, 2), 6)
  assert(drawn > 6 && drawn < 12, `A door swinging redraws only the faces that see it: ${drawn - 6}`)
  lit.update(counting, new THREE.Vector3(0, 1.6, 2), 7)
  const settled = drawn
  lit.update(counting, new THREE.Vector3(0, 1.6, 2), 8)
  assert.equal(drawn, settled, 'and stops once it has stopped')
}
console.log('PASS Shadows cost nothing in a still room; a moving door redraws only the shadow faces that see it')

{
  // Past the shadowed lights, more lights keep shining (without shadows) from further away, each kept to its own rooms;
  // and window glass stays white daylight inside dark rooms.
  const far = new NeonLights(scene)
  const hall = new THREE.Vector3(-34, 1.6, -38)
  for (let t = 0; t < 3; t++) far.update(renderer, hall, 200 + t)
  const lit = Array.from({ length: NEON_FAR }, (_, i) => neonUniforms.neonFarParams.value[i * 4]).filter(value => value > 0)
  assert.equal(lit.length, NEON_FAR, `Beyond the ${NEON_MAX} nearest, ${NEON_FAR} more lights shine from further away`)
  const rooms = Array.from(neonUniforms.neonFarRooms.value)
  assert(rooms.some(bits => bits > 0) , 'Far lights inside a building are tagged with their rooms, so they only light those rooms')
  const glass = (await import('../src/render/ink')).Draft
  const pane = new glass('test pane'); pane.box(1, 1, 0.02, 0, 0, 0, 'glass'); pane.finish()
  const material = (pane.children.find(child => (child as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.Material & { defines?: Record<string, string> }
  assert('NEON_UNLIT' in (material.defines ?? {}), 'Window glass ignores the dark: from inside it reads as white daylight')
}
console.log('PASS Far lights keep glowing and blending from further away, each kept to its own rooms; windows stay white from inside')

{
  // Choosing the shadowed lights is steady and puts the room you are in first.
  // Two dark rooms side by side, each with lamps along it; more lamps than slots.
  const world = new THREE.Scene()
  const lamp = (name: string, x: number, z: number) => {
    const light = new THREE.Object3D()
    light.name = name; light.position.set(x, 2.5, z); light.rotation.x = Math.PI / 2
    light.userData.neonLight = { start: [-0.02, 0, 0], end: [0.02, 0, 0], color: 0xffb24a, intensity: 6, range: 8, standoff: 0.5 }
    world.add(light)
    return light
  }
  const room = (name: string, x: number) => {
    const box = new THREE.Object3D()
    box.name = name; box.position.set(x, 1.5, 0); box.userData.darkRoom = { half: [5, 1.5, 3] }
    world.add(box)
  }
  room('west room', -5); room('east room', 5)
  for (let i = 0; i < 7; i++) { lamp(`west lamp ${i}`, -9 + i * 1.3, 0); lamp(`east lamp ${i}`, 1 + i * 1.3, 0) }
  world.updateMatrixWorld(true)
  const lit = new NeonLights(world)
  const active = () => new Set(lit.active.map(sign => sign.name))
  // Standing in the west room, its own seven lamps all have slots, though some east lamps are nearer than some west ones.
  for (let t = 0; t < 1; t += 0.02) lit.update(renderer, new THREE.Vector3(-1.2, 1.6, 0), 300 + t)
  const west = [...active()].filter(name => name.startsWith('west')).length
  assert.equal(west, 7, `The room you are in comes first: ${west} of its 7 lamps are lit with shadows`)
  // Pacing a metre back and forth across the doorway between them swaps no lights.
  let before = active(), swaps = 0
  for (let step = 0; step < 120; step++) {
    const x = -0.6 + 1.2 * Math.abs(Math.sin(step * 0.15))
    lit.update(renderer, new THREE.Vector3(Math.min(x, -0.05), 1.6, 0), 301 + step / 60)
    const now = active()
    for (const name of now) if (!before.has(name)) swaps++
    before = now
  }
  assert.equal(swaps, 0, `Pacing at the edge of the choice swaps no lights (${swaps} swaps)`)
  // Once the fades and shadows are done, the lighting stops asking for frames.
  for (let t = 0; t < 1; t += 0.02) lit.update(renderer, new THREE.Vector3(-0.3, 1.6, 0), 304 + t)
  assert(!lit.busy, 'A settled scene needs no more frames')
  // Walking into the east room brings its lamps in: the lighting asks for frames while they fade up, then settles.
  lit.update(renderer, new THREE.Vector3(6, 1.6, 0), 306)
  assert(lit.busy, 'A light fading up asks for frames')
  for (let t = 0.02; t < 1; t += 0.02) lit.update(renderer, new THREE.Vector3(6, 1.6, 0), 306 + t)
  assert.equal([...active()].filter(name => name.startsWith('east')).length, 7, 'In the east room its own lamps take over')
  assert(!lit.busy, 'and the lighting settles again')
}
console.log('PASS The shadowed lights are chosen steadily, the room you are in first, and the lighting asks for frames only while it settles')

{
  // A change of lights re-sorts the last search for shadow casters instead of walking the whole scene again.
  const lit = new NeonLights(scene) as unknown as { update: NeonLights['update']; findCandidates(): void }
  let searches = 0
  const find = lit.findCandidates.bind(lit)
  lit.findCandidates = () => { searches++; find() }
  const route = [new THREE.Vector3(-34, 1.6, -38), new THREE.Vector3(-20, 1.6, -40), new THREE.Vector3(0, 1.6, -40), new THREE.Vector3(20, 1.6, -30)]
  for (let i = 0; i < 120; i++) {
    const at = route[Math.floor(i / 40)].clone().lerp(route[Math.floor(i / 40) + 1], (i % 40) / 40)
    lit.update(renderer, at, 400 + i / 60)
  }
  assert(searches <= 1, `Walking across the yard for two seconds searches the scene for casters once, not on every change of lights (${searches})`)
}
console.log('PASS Shadow casters are searched for every few seconds, not on every change of lights')
