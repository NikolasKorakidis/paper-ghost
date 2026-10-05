import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { DETECTION, ZONES } from '../src/game/balance'
import { district } from '../src/game/zones'
import { buildLevel } from '../src/levels'
import { CollisionWorld } from '../src/player/collision'
import type { EnemySpec, PlayerSense, Vec3 } from '../src/game/types'

/*
 * Districts: the first two maps are split into a few districts (the compound: yard, warehouses, detention; the town:
 * five). Trouble in one puts the others on caution, looking that way, but nobody leaves his own district, and guards
 * fight you only while you are in theirs (or shoot at them). Each district's radioman carries its radio on his back:
 * shoot it and the district can call no one.
 */
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
/** A stand-in actor; its radio pack is a 0.3 × 0.38 × 0.15 m box 0.2 m behind his chest, as the real one is. */
const actor = async () => {
  const root = new THREE.Group()
  let pack: 'none' | 'live' | 'broken' = 'none'
  return { root, reactionRemaining: 0, animationTime: 0, update() {}, shoot() {}, restore() {}, react() {}, dispose() {},
    muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)),
    wearRadioPack() { pack = 'live' }, breakRadioPack() { pack = 'broken' }, restoreRadioPack(state: typeof pack) { pack = state },
    radioPackHit(origin: THREE.Vector3, direction: THREE.Vector3, far: number) {
      if (pack !== 'live') return null
      const back = v(-Math.sin(root.rotation.y), 0, -Math.cos(root.rotation.y))
      const center = root.position.clone().add(v(0, 1.2, 0)).addScaledVector(back, 0.2)
      const box = new THREE.Box3().setFromCenterAndSize(center, v(0.3, 0.38, 0.3))
      const hit = new THREE.Ray(origin, direction).intersectBox(box, new THREE.Vector3())
      return hit && hit.distanceTo(origin) <= far ? hit.distanceTo(origin) : null
    },
  } as unknown as EnemyActor
}

{
  // Both maps: every guard in a district, the right one.
  for (const [id, expected] of [['compound', ['Yard', 'Warehouses', 'Detention']], ['town', ['North road', 'Church quarter', 'Town centre', 'Farm', 'Hotel hill']]] as const) {
    const { ground, world } = buildLevel(id)
    const scene = new THREE.Scene(); scene.add(ground); if (world) scene.add(world.root); scene.updateMatrixWorld(true)
    const collision = new CollisionWorld(scene)
    const ai = new EnemyDirector({ scene, world: collision, doors: [], specs: world!.enemies, zones: world!.zones, emit() {}, damagePlayer() {}, dropWeapon() {} }, actor)
    await ai.init()
    assert.deepEqual(ai.zones.zones.map(zone => zone.name), [...expected], `${id}: its districts`)
    const of = (guard: string) => ai.zones.zones[ai.enemies.find(enemy => enemy.spec.id === guard)!.zone]?.name
    if (id === 'compound') {
      assert.equal(of('mess-kitchen'), 'Yard'); assert.equal(of('warehouse-west-aisle'), 'Warehouses'); assert.equal(of('crew-north-room'), 'Detention')
    } else {
      assert.equal(of('checkpoint-gate'), 'North road'); assert.equal(of('church-door'), 'Church quarter'); assert.equal(of('bulky-boy'), 'Town centre')
      assert.equal(of('barn-inside'), 'Farm'); assert.equal(of('hotel-lobby'), 'Hotel hill')
    }
    assert(ai.enemies.every(enemy => enemy.spec.dummy || enemy.zone >= 0), `${id}: every guard has a district`)
    // One radioman per district, carrying its radio.
    for (let i = 0; i < ai.zones.zones.length; i++) {
      const carriers = ai.enemies.filter(enemy => enemy.zone === i && enemy.radioPack === 'live')
      assert.equal(carriers.length, 1, `${id} · ${ai.zones.zones[i].name}: one radioman`)
    }
    // No squad spans two districts.
    for (const enemy of ai.enemies) for (const other of ai.enemies) {
      if (enemy.squad >= 0 && enemy.squad === other.squad && !enemy.spec.squad) assert.equal(enemy.zone, other.zone, `${enemy.spec.id} and ${other.spec.id} share a squad across a district line`)
    }
    console.log(`  ${id}: ${ai.zones.zones.map(zone => `${zone.name} ${ai.enemies.filter(enemy => enemy.zone === ai.zones.zones.indexOf(zone)).length}`).join(', ')}`)
    ai.dispose(); collision.dispose()
  }
}
console.log('PASS The compound and the town are split into districts; each has one radioman; no squad crosses a line')

/** Three districts side by side along x (west −60..−20, middle −20..20, east 20..60), two or three guards in each. */
async function districts(at = v(-40, 0, 12)) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  scene.updateMatrixWorld(true)
  const world = new CollisionWorld(scene)
  const guard = (id: string, position: Vec3, facing = 0, patrol: Vec3[] = []): EnemySpec => ({ id, name: id, position, patrol, weapon: 'ak', facing })
  const specs = [guard('w1', [-40, 0, 0]), guard('w2', [-36, 0, -2]),
    guard('m1', [-8, 0, 0], -Math.PI / 2, [[-8, 0, 0], [-8, 0, 8]]), guard('m2', [0, 0, 4], Math.PI / 2), guard('m3', [6, 0, -4], Math.PI / 2),
    guard('e1', [40, 0, 0], -Math.PI / 2), guard('e2', [44, 0, 4], -Math.PI / 2)]
  const zones = [district('west', 'West', -60, -20, -40, 40), district('middle', 'Middle', -20, 20, -40, 40), district('east', 'East', 20, 60, -40, 40)]
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer() {}, dropWeapon() {}, specs, zones }, actor)
  await ai.init()
  const player: PlayerSense = { feet: at.clone(), eye: at.clone().add(v(0, 1.65)), velocity: v(), alive: true, radioEnabled: true }
  const step = (seconds: number, each?: () => void) => { for (let i = 0; i < Math.round(seconds * 60); i++) { ai.update(1 / 60, player); each?.() } }
  const move = (to: THREE.Vector3) => { player.feet.copy(to); player.eye.copy(to).add(v(0, 1.65)) }
  const named = (id: string) => ai.enemies.find(enemy => enemy.spec.id === id)!
  return { ai, player, step, move, named, dispose() { ai.dispose(); world.dispose() } }
}

{
  // A fight in the west: the west is on alert; the middle and the east on caution, looking west, and none of them leaves
  // his district or fights; the radio and the shots carry, but not the guards.
  const f = await districts()
  const left: string[] = []
  f.step(DETECTION.notice + 2)
  // The player opens fire at the west guards as well.
  for (let i = 0; i < 4; i++) f.ai.hear({ kind: 'shot-ak', position: f.player.eye.clone(), radius: 75 })
  f.step(20, () => {
    for (const enemy of f.ai.enemies) if (enemy.zone > 0 && f.ai.zones.distanceTo(enemy.zone, enemy.position) > ZONES.district.margin + 0.5 && !left.includes(enemy.spec.id)) left.push(enemy.spec.id)
  })
  assert.equal(f.ai.zones.zones[0].phase !== 'normal', true, 'The west is up')
  assert.deepEqual(f.ai.zones.zones.slice(1).map(zone => zone.phase), ['caution', 'caution'], 'The middle and the east are on caution')
  assert.deepEqual(left, [], 'Nobody from the other districts left his own')
  for (const id of ['m1', 'm2', 'm3', 'e1', 'e2']) assert.notEqual(f.named(id).state, 'combat', `${id} does not fight`)
  assert(['m2', 'm3'].some(id => f.named(id).watch && f.named(id).watch!.x < -20), 'The middle looks toward the west')
  f.dispose()
}
console.log('PASS Trouble in one district puts the others on caution, looking that way; nobody leaves his own or joins the fight')

{
  // The player walks into the middle district, into a guard's view: the middle fights him. Seen from the east across
  // the line, the east only watches.
  const f = await districts(v(4, 0, 18))
  f.step(DETECTION.notice + 2)
  assert(['m2', 'm3'].some(id => f.named(id).state === 'combat'), 'The middle fights him in its own district')
  assert(['e1', 'e2'].every(id => f.named(id).state !== 'combat'), 'The east, seeing him over the line, does not')
  f.dispose()
}
console.log('PASS Guards fight you only in their own district')

{
  // A gunshot in the middle, heard by the west: the west looks, but does not go.
  const f = await districts(v(200, 0, 200))
  f.ai.hear({ kind: 'shot-ak', position: v(0, 1.5, 10), radius: 75 })
  f.step(6)
  for (const id of ['w1', 'w2']) {
    const enemy = f.named(id)
    assert(enemy.state !== 'investigate' && enemy.state !== 'search', `${id} stays at his post`)
    assert(enemy.position.x < -20 + ZONES.district.margin, `${id} is still in the west`)
  }
  assert(f.named('m2').state === 'investigate' || f.named('m3').state === 'investigate', 'The middle goes to look')
  f.dispose()
}
console.log('PASS A shot heard from another district is watched, not chased')

{
  // The middle's radioman: shot in the radio on his back, the set is smashed, he is unhurt, and his district has no
  // radio: a fight there no longer puts the others on caution.
  const f = await districts(v(200, 0, 200))
  const radioman = f.ai.enemies.find(enemy => enemy.zone === 1 && enemy.radioPack === 'live')!
  assert(radioman, 'The middle has a radioman')
  const behind = radioman.position.clone().add(v(-Math.sin(radioman.yaw) * 6, 1.3, -Math.cos(radioman.yaw) * 6))
  const chest = radioman.position.clone().add(v(0, 1.2, 0))
  const shot = { origin: behind, direction: chest.clone().sub(behind).normalize(), range: 50, damage: 30, weapon: 'silenced' as const }
  const found = f.ai.findHit(shot, 50)
  assert(found?.pack, 'A shot at his back meets the radio first')
  f.ai.applyHit(shot, found!)
  assert.equal(radioman.radioPack, 'broken', 'The set is smashed')
  assert.equal(radioman.health, 100, 'and he is unhurt')
  assert(!f.ai.zoneRadio(1), 'The middle has no radio now')
  const saved = f.ai.snapshot()
  f.move(v(2, 0, 16))
  f.step(DETECTION.notice + 2)
  assert.equal(f.ai.zones.zones[1].phase, 'alert', 'A fight in the middle')
  assert.deepEqual([f.ai.zones.zones[0].phase, f.ai.zones.zones[2].phase], ['normal', 'normal'], 'and nobody else hears of it')
  f.ai.restore(saved)
  assert.equal(radioman.radioPack, 'broken', 'A checkpoint keeps the radio smashed')
  f.dispose()
}
console.log('PASS Shooting a radioman\'s pack smashes his district\'s radio: it can no longer warn anyone')
