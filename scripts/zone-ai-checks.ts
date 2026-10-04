import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { DETECTION, ZONES } from '../src/game/balance'
import { ZoneNetwork, zonesFromBuildings } from '../src/game/zones'
import { buildLevel } from '../src/levels'
import { CollisionWorld } from '../src/player/collision'
import type { EnemySpec, PlayerSense, Vec3 } from '../src/game/types'

/*
 * Zones, after Metal Gear Solid V's outposts: each building and its yard is an area with its own alert phase. An alert
 * in one puts the others on caution, looking toward it, with two men covering that side and the nearest sending help;
 * a body found sends search teams out by direction; the phases run down on their clocks; a checkpoint keeps them.
 */
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const actor = async () => {
  const root = new THREE.Group()
  return { root, reactionRemaining: 0, animationTime: 0, update() {}, shoot() {}, restore() {}, react() {}, dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as EnemyActor
}
/** A building marker as the world builders make them: a named group with a footprint. */
const building = (name: string, x: number, z: number, w = 12, d = 10) => {
  const group = new THREE.Group()
  group.name = name; group.position.set(x, 0, z); group.userData.footprint = [w, d]
  return group
}
const facing = (from: THREE.Vector3, yaw: number, to: THREE.Vector3) => {
  const want = Math.atan2(to.x - from.x, to.z - from.z)
  return Math.abs(Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)))
}

{
  // From the buildings: buildings (nearly) touching are one zone; a building on its own is its own.
  const root = new THREE.Group()
  root.add(building('Barracks · long wing', 0, 0), building('Barracks · west wing', 11, 0, 8, 8), building('Depot', 90, 0))
  const zones = zonesFromBuildings(root)
  assert.equal(zones.length, 2, 'The barracks and its wing are one zone, the depot another')
  assert.deepEqual(zones.map(zone => zone.name).sort(), ['Barracks', 'Depot'])
  const network = new ZoneNetwork(zones)
  assert.equal(network.zones[network.zoneAt(v(2, 0, 3))].name, 'Barracks', 'A point by the barracks is in its zone')
  assert.equal(network.zoneAt(v(60, 0, 0)), -1, 'Out in the open between them is in neither')
  assert.equal(network.zones[network.zoneAt(v(60, 0, 0), ZONES.reach)].name, 'Depot', 'but nearest the depot, within reach')
}
console.log('PASS Zones come from the buildings: a building and its yard, joined where buildings touch')

{
  // Both campaign maps: every guard belongs to a zone, and there are many (one per main building, at least).
  for (const id of ['compound', 'town'] as const) {
    const { ground, world } = buildLevel(id)
    const scene = new THREE.Scene(); scene.add(ground); if (world) scene.add(world.root); scene.updateMatrixWorld(true)
    const collision = new CollisionWorld(scene)
    const ai = new EnemyDirector({ scene, world: collision, doors: [], specs: world!.enemies, emit() {}, damagePlayer() {}, dropWeapon() {} }, actor)
    await ai.init()
    const zoned = ai.enemies.filter(enemy => !enemy.spec.dummy)
    assert(zoned.every(enemy => enemy.zone >= 0), `${id}: every guard has a zone (${zoned.filter(enemy => enemy.zone < 0).map(enemy => enemy.spec.id).join(', ')})`)
    assert(ai.zones.zones.length >= 8, `${id}: the level is split into areas (${ai.zones.zones.length})`)
    const used = new Set(zoned.map(enemy => enemy.zone))
    assert(used.size >= 6, `${id}: the guards are spread over many zones (${used.size})`)
    console.log(`  ${id}: ${ai.zones.zones.length} zones, guards in ${used.size}: ${[...used].map(i => ai.zones.zones[i].name).join(', ')}`)
    ai.dispose(); collision.dispose()
  }
}
console.log('PASS Both campaign maps are split into zones and every guard belongs to one')

/**
 * Two buildings 80 m apart (A west, B east) on open ground; two guards at A, five at B facing away east, and the player
 * in front of A's first guard. `far` puts B 140 m off instead.
 */
async function outposts(radio: boolean, far = false, sets: { id: string; position: THREE.Vector3; live: boolean }[] = []) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  const bx = far ? 140 : 80
  scene.add(building('Armoury', 0, 0), building('Motor pool', bx, 0, 16, 14))
  scene.updateMatrixWorld(true)
  const world = new CollisionWorld(scene)
  const guard = (id: string, position: Vec3, facing = Math.PI / 2, patrol: Vec3[] = []): EnemySpec => ({ id, name: id, position, patrol, weapon: 'ak', facing })
  const specs = [guard('a1', [0, 0, 0], 0), guard('a2', [3, 0, -3], 0),
    guard('b1', [bx, 0, -3]), guard('b2', [bx + 3, 0, 0]), guard('b3', [bx, 0, 4]), guard('b4', [bx - 4, 0, 2], Math.PI / 2, [[bx - 4, 0, 2], [bx - 4, 0, -4]]), guard('b5', [bx + 5, 0, 5])]
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer() {}, dropWeapon() {}, specs, radioSets: () => sets }, actor)
  await ai.init()
  const at = v(0, 0, 10)
  const player: PlayerSense = { feet: at.clone(), eye: at.clone().add(v(0, 1.65)), velocity: v(), alive: true, radioEnabled: radio }
  const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) ai.update(1 / 60, player) }
  const move = (to: THREE.Vector3) => { player.feet.copy(to); player.eye.copy(to).add(v(0, 1.65)) }
  const zone = (name: string) => ai.zones.zones.findIndex(z => z.name === name)
  return { ai, player, step, move, zone, bx, B: ai.enemies.slice(2), dispose() { ai.dispose(); world.dispose() } }
}

{
  // Seen at the armoury: the armoury is on alert; the motor pool, by radio, on caution, looking toward it. Its two men
  // nearest that side go and cover it, and it sends two more to help.
  const f = await outposts(true)
  const armoury = f.zone('Armoury'), motorPool = f.zone('Motor pool')
  f.step(DETECTION.notice + 1)
  assert.equal(f.ai.enemies[0].state, 'combat', 'The armoury guard sees the player')
  assert.equal(f.ai.zones.zones[armoury].phase, 'alert', 'The armoury is on alert')
  assert.equal(f.ai.zones.zones[motorPool].phase, 'caution', 'The motor pool, by radio, is on caution')
  assert(f.B.every(enemy => enemy.caution > 0), 'Its guards are all quicker to spot you')
  const screens = f.B.filter(enemy => enemy.screen), helpers = f.B.filter(enemy => enemy.state === 'investigate')
  assert.equal(screens.length, ZONES.screen.guards, `${ZONES.screen.guards} cover the side the trouble is on`)
  assert.equal(helpers.length, ZONES.reinforce, `${ZONES.reinforce} go to help`)
  assert(helpers.every(enemy => enemy.lastKnown && enemy.lastKnown.distanceTo(v(0, 0, 10)) < 3), 'to where the player was seen')
  f.step(6)
  const watchers = f.B.filter(enemy => !enemy.screen && enemy.state !== 'investigate')
  for (const enemy of [...screens, ...watchers]) {
    if (enemy.screen || enemy.watchTimer > 0) assert(facing(enemy.position, enemy.yaw, v(0, 0, 10)) < 0.35, `${enemy.spec.id} looks toward the armoury (${facing(enemy.position, enemy.yaw, v(0, 0, 10)).toFixed(2)} rad off)`)
  }
  for (const enemy of screens) assert(enemy.position.x < f.bx - 3, `${enemy.spec.id} covers the motor pool's west side (x ${enemy.position.x.toFixed(1)})`)
  f.dispose()
}
console.log('PASS An alert at one building puts the next on caution by radio: they look that way, two cover that side, two come to help')

{
  // Without the radio, a building 140 m off never hears of it; 80 m off with no radio is beyond shouting range too.
  for (const far of [false, true]) {
    const f = await outposts(false, far)
    f.step(DETECTION.notice + 1)
    assert.equal(f.ai.zones.zones[f.zone('Armoury')].phase, 'alert')
    assert.equal(f.ai.zones.zones[f.zone('Motor pool')].phase, 'normal', `No radio: the motor pool ${f.bx} m off stays calm`)
    assert(f.B.every(enemy => !enemy.screen && enemy.state !== 'investigate'))
    f.dispose()
  }
}
console.log('PASS Without the radio, only zones within shouting range hear of trouble')

{
  // The alert runs down: contact lost → search (teams out by direction) → caution → normal, and the screens go back.
  const f = await outposts(true)
  const armoury = f.zone('Armoury'), motorPool = f.zone('Motor pool')
  f.player.velocity.set(-3, 0, 0)
  f.step(DETECTION.notice + 1)
  f.move(v(-200, 0, 200))
  f.step(ZONES.lost + 3)
  assert.equal(f.ai.zones.zones[armoury].phase, 'search', `No one has seen him for ${ZONES.lost} s: the armoury searches`)
  const saved = f.ai.snapshot()
  f.step(ZONES.time.search)
  assert.equal(f.ai.zones.zones[armoury].phase, 'caution', 'The search runs out into caution')
  f.step(ZONES.time.caution + 1)
  assert.equal(f.ai.zones.zones[armoury].phase, 'normal', 'and caution into calm')
  assert.equal(f.ai.zones.zones[motorPool].phase, 'normal', 'The motor pool calms down too')
  assert(f.B.every(enemy => !enemy.screen && !enemy.watch), 'Its screens go back to their rounds')
  f.ai.restore(saved)
  assert.equal(f.ai.zones.zones[armoury].phase, 'search', 'A checkpoint keeps the zones\' phases')
  assert.equal(f.ai.zones.zones[motorPool].phase, 'caution')
  assert(f.B.some(enemy => enemy.screen), 'and who is screening')
  f.dispose()
}
console.log('PASS Alert → search → caution → normal on the clocks; screens stand down; checkpoints keep it all')

{
  // A body at the motor pool: "Man down!" Its zone searches in teams of ZONES.team, each team out along its own slice
  // of the compass from the body; one man stays at his post; the armoury goes on caution.
  const f = await outposts(true)
  f.move(v(-300, 0, -300))
  const motorPool = f.zone('Motor pool'), armoury = f.zone('Armoury')
  const victim = f.B[4]
  victim.health = 0; victim.state = 'dead'
  f.step(1)
  assert.equal(f.ai.zones.zones[motorPool].phase, 'search', 'A body found: the motor pool searches')
  assert.equal(f.ai.zones.zones[armoury].phase, 'caution', 'and the armoury is put on caution')
  f.step(12)
  const teams = new Map<number, typeof f.B>()
  for (const enemy of f.B) if (enemy.team >= 0) teams.set(enemy.team, [...teams.get(enemy.team) ?? [], enemy])
  assert(teams.size >= 2, `They split into teams (${teams.size})`)
  const directions = [...teams.values()].map(members => members[0].sector!)
  for (let i = 0; i < directions.length; i++) for (let j = i + 1; j < directions.length; j++) {
    assert(directions[i].angleTo(directions[j]) > Math.PI / 2 - 0.01, 'Each team takes its own direction')
  }
  for (const members of teams.values()) {
    assert(members.every(member => member.sector!.equals(members[0].sector!)), 'A team sweeps one way together')
    for (const member of members) for (const point of member.searchPoints) {
      const out = point.clone().sub(victim.position).setY(0)
      assert(out.length() > DETECTION.search.sweep.reach[0] - 4 && out.normalize().dot(member.sector!) > 0.35, `${member.spec.id} searches out along the team's way`)
    }
  }
  f.dispose()
}
console.log('PASS A body sends the zone out in search teams, each its own way, and puts the next zone on caution')

{
  // The radio: the armoury's operator is the guard nearest its radio set. Kill him (or smash the set) and the armoury
  // can no longer call: an alert there stays there, and no help comes.
  const set = { id: 'armoury radio', position: v(3.5, 1, -3.5), live: true }
  for (const cut of ['operator', 'set'] as const) {
    const f = await outposts(true, false, [set])
    set.live = true
    const armoury = f.zone('Armoury'), motorPool = f.zone('Motor pool')
    assert.equal(f.ai.operator(armoury)?.spec.id, 'a2', 'The guard by the radio set works it')
    assert(f.ai.zoneRadio(armoury) && f.ai.zoneRadio(motorPool), 'Both zones have their radio')
    if (cut === 'operator') { const operator = f.ai.enemies[1]; operator.health = 0; operator.state = 'dead' }
    else set.live = false
    // (The sets are looked at every quarter second.)
    f.move(v(-300, 0, -300)); f.step(0.3); f.move(v(0, 0, 10))
    assert(!f.ai.zoneRadio(armoury), `With the ${cut === 'operator' ? 'operator dead' : 'set smashed'}, the armoury has no radio`)
    f.step(DETECTION.notice + 1)
    assert.equal(f.ai.zones.zones[armoury].phase, 'alert', 'The armoury still fights')
    assert.equal(f.ai.zones.zones[motorPool].phase, 'normal', 'but the motor pool never hears of it')
    assert(f.B.every(enemy => enemy.state !== 'investigate'), 'and sends no help')
    f.dispose()
  }
}
console.log('PASS A zone without its radio (operator dead or sets smashed) cannot warn the others or call for help')

{
  // Check-ins: a motor pool guard killed quietly where no one sees him. At the next radio check he does not answer:
  // the motor pool goes on caution and someone goes to his post. He is reported only once.
  const f = await outposts(true)
  f.move(v(-300, 0, -300))
  const motorPool = f.zone('Motor pool')
  const lost = f.B[4]
  lost.health = 0; lost.state = 'dead'; lost.position.set(f.bx + 40, 0, 40)
  for (let t = 0; t < ZONES.radio.interval[1] + 2 && !f.ai.zones.zones[motorPool].reported.length; t += 0.5) f.step(0.5)
  assert(f.ai.zones.zones[motorPool].reported.includes(lost.spec.id), 'He missed the check-in')
  f.step(0.5)
  assert.notEqual(f.ai.zones.zones[motorPool].phase, 'normal', 'The motor pool is on its guard')
  const checker = f.B.find(enemy => enemy !== lost && (enemy.state === 'investigate' || enemy.state === 'search'))
  assert(checker, 'Someone goes to look')
  assert(checker!.lastKnown!.distanceTo(v(...lost.spec.position)) < 2, 'at his post')
  f.dispose()
}
console.log('PASS A guard who misses a radio check-in is reported, his zone goes on caution and someone checks his post')

{
  // The garrison adapts. The motor pool, hit three times, stands down from a search each time: first a sentry is
  // posted where the player was first seen, watching the way he came; then its patrols walk in twos; then helmets,
  // which stop one head shot each (a sniper's round goes through).
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  scene.add(building('Motor pool', 0, 0, 16, 14))
  scene.updateMatrixWorld(true)
  const world = new CollisionWorld(scene)
  const specs: EnemySpec[] = [
    { id: 'm1', name: 'M1', position: [0, 0, 0], patrol: [], weapon: 'ak', facing: 0 },
    { id: 'm2', name: 'M2', position: [4, 0, 2], patrol: [], weapon: 'ak', facing: 0 },
    { id: 'm3', name: 'M3', position: [-6, 0, -4], patrol: [[-6, 0, -4], [6, 0, -4]], weapon: 'ak', facing: 0 },
    { id: 'm4', name: 'M4', position: [-6, 0, 5], patrol: [[-6, 0, 5], [6, 0, 5]], weapon: 'ak', facing: 0 },
  ]
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer() {}, dropWeapon() {}, specs }, actor)
  await ai.init()
  const player: PlayerSense = { feet: v(-300, 0, -300), eye: v(-300, 1.65, -300), velocity: v(), alive: true, radioEnabled: true }
  const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) ai.update(1 / 60, player) }
  const zone = ai.zones.zones[0]
  const raise = ai as unknown as { raiseZone: (index: number, phase: string, focus: THREE.Vector3) => void }
  const entry = v(0, 0, 14)
  const standDown = () => { raise.raiseZone(0, 'search', entry); step(ZONES.time.search + 1) }
  standDown()
  assert.equal(zone.heat, 1)
  const sentry = ai.enemies.find(enemy => enemy.sentry)
  assert(sentry, 'After the first time, a sentry is posted')
  step(20)
  assert(sentry!.position.distanceTo(entry) < 10, `where the player came in (${sentry!.position.distanceTo(entry).toFixed(1)} m off)`)
  assert(sentry!.watch && sentry!.watch.z > sentry!.position.z + 5, 'watching the way he came')
  assert(!ai.enemies.some(enemy => enemy.buddy) && !ai.enemies.some(enemy => enemy.helmet), 'Nothing more yet')
  standDown()
  const pair = ai.enemies.find(enemy => enemy.buddy)
  assert(pair && pair.buddy!.spec.patrol.length > 1, 'After the second, two patrols walk as one')
  step(12)
  assert(pair!.position.distanceTo(pair!.buddy!.position) < 4, `the second keeping close behind his leader (${pair!.position.distanceTo(pair!.buddy!.position).toFixed(1)} m)`)
  standDown()
  assert(ai.enemies.every(enemy => enemy.helmet), 'After the third, helmets')
  // A rifle round to the head: the helmet takes it.
  const target = ai.enemies[0], index = 0
  const hit = (weapon: 'ak' | 'sniper') => ai.applyHit({ origin: v(0, 1.6, -10), direction: v(0, 0, 1), range: 50, damage: 34, weapon },
    { index, distance: 10, point: target.position.clone().add(v(0, 1.6, 0)), zone: 'head', direction: v(0, 0, 1) } as Parameters<EnemyDirector['applyHit']>[1])
  hit('ak')
  assert(target.health >= 100 - ZONES.adapt.helmetDamage && !target.helmet, `A head shot knocks the helmet off and only stuns him (${target.health} left)`)
  const saved = ai.snapshot()
  const before = target.health
  hit('ak')
  assert(before - target.health > 50, 'The next head shot lands in full')
  ai.restore(saved)
  assert(ai.enemies[1].helmet && !ai.enemies[0].helmet && ai.enemies.some(enemy => enemy.sentry) && ai.enemies.some(enemy => enemy.buddy), 'A checkpoint keeps sentries, pairs and helmets')
  assert.equal(ai.zones.zones[0].heat, 3, 'and the zone\'s memory')
  const other = ai.enemies[1]
  ai.applyHit({ origin: v(0, 1.6, -10), direction: v(0, 0, 1), range: 50, damage: 90, weapon: 'sniper' },
    { index: 1, distance: 10, point: other.position.clone().add(v(0, 1.6, 0)), zone: 'head', direction: v(0, 0, 1) } as Parameters<EnemyDirector['applyHit']>[1])
  assert.equal(other.health, 0, 'A sniper\'s round goes through a helmet')
  ai.dispose(); world.dispose()
}
console.log('PASS The garrison adapts: a sentry where you came in, patrols in pairs, then helmets that stop one head shot')
