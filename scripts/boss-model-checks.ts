import assert from 'node:assert/strict'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BOSS_LOOKS, SKELETON, fitToSkeleton, inkColor } from '../src/game/boss-models'
import { ENEMY_TYPES } from '../src/game/enemy-types'
import { BONE_NAMES, type BoneName } from '../src/lab/rig'
import { existsSync } from 'node:fs'

// A mannequin like Rodin's statues, as finely meshed (the fitting reads gaps in the outline): 1.9 units tall, centred on the origin, facing +Z, arms hanging apart from the body.
function mannequin() {
  const part = (geometry: THREE.BufferGeometry, x: number, y: number, z = 0, roll = 0) =>
    geometry.toNonIndexed().rotateZ(roll).translate(x, y, z)
  const parts = [
    part(new THREE.BoxGeometry(0.42, 0.62, 0.24, 30, 44, 16), 0, 0.2),           // torso, y −0.11 … 0.51
    part(new THREE.SphereGeometry(0.13, 32, 24), 0, 0.68),                       // head
    part(new THREE.BoxGeometry(0.12, 0.06, 0.12, 8, 4, 8), 0, 0.53),                      // neck
    ...[-1, 1].flatMap(side => [
      part(new THREE.CylinderGeometry(0.07, 0.07, 0.85, 24, 60), side * 0.11, -0.52), // leg, y −0.95 … −0.1
      part(new THREE.CylinderGeometry(0.055, 0.05, 0.72, 24, 50), side * 0.33, 0.12, 0, side * 0.12), // arm, hanging out a little
    ]),
  ]
  for (const geometry of parts) geometry.deleteAttribute('uv'), geometry.deleteAttribute('normal')
  return mergeGeometries(parts)!
}

{
  const geometry = mannequin(), positions = geometry.getAttribute('position').array
  const bones = Object.fromEntries(BONE_NAMES.map((name, i) => [name, i])) as Record<BoneName, number>
  const fitted = fitToSkeleton(positions, bones)
  const count = positions.length / 3
  const box = new THREE.Box3()
  for (let i = 0; i < count; i++) box.expandByPoint(new THREE.Vector3().fromArray(fitted.positions, i * 3))
  assert(Math.abs(box.min.y) < 0.02 && Math.abs(box.max.y - SKELETON.height) < 0.03, `Feet on the ground, as tall as the stickman: ${box.min.y.toFixed(3)} … ${box.max.y.toFixed(3)}`)
  assert(box.max.x > SKELETON.armTip - 0.06 && box.max.x < SKELETON.armTip + 0.12 && Math.abs(box.min.x + box.max.x) < 0.04,
    `The arms are swung out into the T-pose, both sides alike: ${box.min.x.toFixed(2)} … ${box.max.x.toFixed(2)}`)
  // Every vertex out along the arms sits at shoulder height and is bound to that side's arm.
  const sideBones = (side: 'L' | 'R') => new Set((['upper_arm', 'forearm', 'hand', 'shoulder'] as const).map(name => bones[`${name}.${side}` as BoneName]))
  let armVertices = 0
  for (let i = 0; i < count; i++) {
    const x = fitted.positions[i * 3], y = fitted.positions[i * 3 + 1]
    if (Math.abs(x) < 0.45) continue
    armVertices++
    assert(Math.abs(y - SKELETON.shoulder) < 0.12, `Arm vertex at shoulder height: ${y.toFixed(2)}`)
    assert(sideBones(x > 0 ? 'L' : 'R').has(fitted.skinIndex[i * 4]), 'Bound to its own arm')
  }
  assert(armVertices > 100, `The arms are there: ${armVertices}`)
  // The feet are bound to the shins, each to its own side; weights sum to one.
  for (let i = 0; i < count; i++) {
    const x = fitted.positions[i * 3], y = fitted.positions[i * 3 + 1]
    const total = fitted.skinWeight[i * 4] + fitted.skinWeight[i * 4 + 1] + fitted.skinWeight[i * 4 + 2] + fitted.skinWeight[i * 4 + 3]
    assert(Math.abs(total - 1) < 1e-4, 'Skin weights sum to one')
    if (y < 0.15) assert.equal(fitted.skinIndex[i * 4], bones[x > 0 ? 'shin.L' : 'shin.R'], 'Feet follow their own shin')
  }
}
console.log('PASS A Rodin statue standing arms-down is fitted to the stickman T-pose and bound to its own bones')

{
  // Ink: dark cloth goes black, mid tones to the two pencil greys, highlights to paper.
  assert.equal(inkColor(0.05, 0.05, 0.06), 0x000000)
  assert.equal(inkColor(0.3, 0.3, 0.3), 0x808080)
  assert.equal(inkColor(0.55, 0.55, 0.55), 0xbdbdbd)
  assert.equal(inkColor(0.9, 0.9, 0.88), 0xffffff)
  // Every look has its model, and the boss types wear them.
  for (const look of Object.values(BOSS_LOOKS)) assert(existsSync(`public/models/bosses/${look.file}`), `${look.file} is served`)
  assert.equal(ENEMY_TYPES.bulky.look, 'bulky')
  assert(ENEMY_TYPES.warden.boss && ENEMY_TYPES.warden.look === 'warden' && ENEMY_TYPES.sapper.boss && ENEMY_TYPES.sapper.look === 'sapper', 'The Warden and the Sapper are bosses in their Rodin bodies')
}
console.log('PASS Rodin colours are redrawn in ink, every boss look has its model, and the boss types wear them')

{
  // Bulky Boy's own gun: the Breaker, a two-handed heavy machine gun, longer than the AK, with its front grip.
  const { builders, disposeGun } = await import('../src/lab/weapons/models')
  const breaker = builders.breaker(), ak = builders.ak()
  assert(BOSS_LOOKS.bulky.weapon === 'breaker', 'Bulky Boy carries the Breaker')
  assert(breaker.userData.twoHanded && breaker.userData.support && breaker.userData.parts.magazine && breaker.userData.parts.bolt, 'Two-handed, with a support grip, an ammo box and a charging handle')
  assert(breaker.userData.muzzle.z > ak.userData.muzzle.z * 1.4, `Longer than the AK: muzzle at ${breaker.userData.muzzle.z} m`)
  disposeGun(breaker); disposeGun(ak)
}
console.log('PASS Bulky Boy carries the Breaker, his own heavy machine gun')
