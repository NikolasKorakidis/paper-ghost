import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { DETECTION, GUNSHOT_HEARING } from '../src/game/balance'
import { CollisionWorld } from '../src/player/collision'
import type { EnemySpec, PlayerSense } from '../src/game/types'

/*
 * What a guard sees and hears, and what he does about it: a 120° field of view whose ? fills fastest straight ahead
 * and close; unsilenced gunshots heard out to GUNSHOT_HEARING (less through walls), the silenced pistol never; a
 * comrade's gunfire brings others running; a body on the ground starts a body search with his squad; a lost contact
 * is searched for first where you were heading; and caution afterwards makes him quicker to spot you.
 */
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const actor = async () => {
  const root = new THREE.Group()
  return { root, reactionRemaining: 0, animationTime: 0, update() {}, shoot() {}, restore() {}, react() {}, dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as EnemyActor
}
async function field(specs: Partial<EnemySpec>[], at: THREE.Vector3, walls: [number, number, number, number][] = []) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  for (const [x, z, width, depth] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, 6, depth), new THREE.MeshBasicMaterial())
    wall.position.set(x, 3, z); scene.add(wall)
  }
  const world = new CollisionWorld(scene)
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer() {}, dropWeapon() {},
    specs: specs.map((spec, i) => ({ id: `g${i}`, name: `G${i}`, position: [0, 0, 0], patrol: [], weapon: 'ak', facing: 0, ...spec }) as EnemySpec) }, actor)
  await ai.init()
  const player: PlayerSense = { feet: at.clone(), eye: at.clone().add(v(0, 1.65)), velocity: v(), alive: true, radioEnabled: false }
  const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) ai.update(1 / 60, player) }
  const move = (to: THREE.Vector3) => { player.feet.copy(to); player.eye.copy(to).add(v(0, 1.65)) }
  return { ai, player, step, move, dispose() { ai.dispose(); world.dispose() } }
}
/** Where a player at `distance` m and `degrees` off straight ahead stands, for a guard at the origin facing +Z. */
const off = (degrees: number, distance: number) => v(Math.sin(degrees * Math.PI / 180) * distance, 0, Math.cos(degrees * Math.PI / 180) * distance)

{
  // The field of view is 120°: a little inside its edge he sees you, a little outside he does not.
  for (const [degrees, seen] of [[DETECTION.fov / 2 - 4, true], [DETECTION.fov / 2 + 5, false], [-(DETECTION.fov / 2 - 4), true]] as [number, boolean][]) {
    const f = await field([{}], off(degrees, 15))
    f.step(0.3)
    assert.equal(f.ai.enemies[0].canSee, seen, `${degrees}° off straight ahead: ${seen ? 'seen' : 'not seen'}`)
    f.dispose()
  }
}
console.log('PASS Guards see 120° in front of them')

{
  // The ? fills fastest straight ahead and close; slower at the edge of his view and far off.
  const fill = async (at: THREE.Vector3) => { const f = await field([{}], at); f.step(0.8); const notice = f.ai.enemies[0].notice; f.dispose(); return notice }
  const ahead = await fill(off(0, 15)), edge = await fill(off(DETECTION.fov / 2 - 3, 15)), far = await fill(off(0, 40))
  assert(edge < ahead * 0.75, `At the edge of his view the ? fills slower (${(edge / ahead).toFixed(2)} as fast)`)
  assert(far < ahead * 0.75, `Far off it fills slower (${(far / ahead).toFixed(2)} as fast)`)
  // A cautious guard (after a body, gunshots, losing you) is quicker.
  const f = await field([{}], off(0, 30))
  f.ai.enemies[0].caution = 60
  f.step(0.8)
  const cautious = f.ai.enemies[0].notice
  f.dispose()
  const calm = await fill(off(0, 30))
  assert(Math.abs(cautious / calm - DETECTION.caution.rate) < 0.15, `Cautious, it fills ${DETECTION.caution.rate}× as fast (${(cautious / calm).toFixed(2)})`)
}
console.log('PASS The ? fills fastest straight ahead and close, slower at the edge and far off, faster when cautious')

{
  // Gunshots: an unsilenced rifle is heard out to GUNSHOT_HEARING.ak in the open, less through a wall; the silenced
  // pistol never. A heard shot sends him to check where it was, and leaves him cautious.
  const shot = async (at: THREE.Vector3, kind: string, radius: number, walls: [number, number, number, number][] = []) => {
    const f = await field([{ facing: Math.PI }], v(500, 0, 500), walls)
    f.ai.hear({ kind, position: at.clone().add(v(0, 1.5)), radius })
    const guard = f.ai.enemies[0]
    const result = { state: guard.state, caution: guard.caution, lastKnown: guard.lastKnown?.clone() }
    f.dispose()
    return result
  }
  const near = await shot(v(0, 0, GUNSHOT_HEARING.ak - 8), 'shot-ak', GUNSHOT_HEARING.ak)
  assert.equal(near.state, 'investigate', `A rifle shot ${GUNSHOT_HEARING.ak - 8} m off is heard`)
  assert(near.lastKnown && near.lastKnown.distanceTo(v(0, 0, GUNSHOT_HEARING.ak - 8)) < 0.5, 'and he goes to where it was')
  assert(near.caution >= DETECTION.caution.gunshot - 0.01, 'and stays cautious')
  assert.equal((await shot(v(0, 0, GUNSHOT_HEARING.ak + 6), 'shot-ak', GUNSHOT_HEARING.ak)).state, 'guard', `${GUNSHOT_HEARING.ak + 6} m off it is not`)
  const wall: [number, number, number, number] = [0, 3, 30, 0.5]
  const muffled = GUNSHOT_HEARING.ak * GUNSHOT_HEARING.muffled
  assert.equal((await shot(v(0, 0, muffled - 5), 'shot-ak', GUNSHOT_HEARING.ak, [wall])).state, 'investigate', `Through a wall it carries ${muffled.toFixed(0)} m`)
  assert.equal((await shot(v(0, 0, muffled + 6), 'shot-ak', GUNSHOT_HEARING.ak, [wall])).state, 'guard', 'and no further')
  assert.equal((await shot(v(0, 0, 4), 'shot-silenced', 6)).state, 'guard', 'The silenced pistol is not heard, even 4 m off')
}
console.log(`PASS Unsilenced gunshots are heard ${GUNSHOT_HEARING.ak} m off in the open, ${(GUNSHOT_HEARING.ak * GUNSHOT_HEARING.muffled).toFixed(0)} through walls; the silenced pistol never`)

{
  // A comrade firing brings a guard within earshot running to back him up.
  const f = await field([{ facing: Math.PI }], v(500, 0, 500))
  f.ai.hear({ kind: 'enemy-shot-ak', position: v(0, 1.4, 60), radius: 90 })
  const guard = f.ai.enemies[0]
  assert.equal(guard.state, 'investigate', 'He heads for the gunfire')
  assert(guard.suspicion >= 0.5, 'at a run, ready to fight')
  f.dispose()
}
console.log('PASS Guards hear their comrades firing and come to back them up')

{
  // A body on the ground 20 m ahead: "Man down!", he goes to it, his squadmate comes too, and they search the ground
  // round it (a body search, hiding places first), cautious for a long while.
  const f = await field([{}, { position: [3, 0, -4], facing: Math.PI }, { id: 'victim', position: [0, 0, 20] } as Partial<EnemySpec>], v(500, 0, 500))
  const [guard, mate, body] = f.ai.enemies
  body.health = 0; body.state = 'dead'
  f.step(0.3)
  assert.equal(guard.state, 'investigate', 'He sees the body 20 m off and goes to it')
  assert.equal(guard.searchKind, 'body')
  assert(guard.caution > DETECTION.caution.body - 1, 'and is cautious')
  assert.equal(mate.state, 'investigate', 'His squadmate, who never saw it, comes too')
  f.step(40)
  const searched = [guard, mate].filter(g => g.searchPoints.length)
  assert(searched.length, 'They search')
  for (const g of searched) for (const point of g.searchPoints) {
    const reach = point.distanceTo(body.position)
    assert(reach >= DETECTION.search.body.reach[0] - 1 && reach <= DETECTION.search.body.reach[1] + 1, `Searching round the body (${reach.toFixed(1)} m out)`)
  }
  f.dispose()
}
console.log('PASS A body is seen 25 m off, and starts a body search round it with the squad')

{
  // Losing a moving player: he goes to where he last saw you, then first searches where you were heading.
  const f = await field([{}], v(0, 0, 14))
  const guard = f.ai.enemies[0]
  f.player.velocity.set(4, 0, 0)
  f.step(DETECTION.notice + 1.5)
  assert.equal(guard.state, 'combat')
  assert(guard.lastHeading && guard.lastHeading.x > 0.9, 'He saw which way you were going')
  f.move(v(80, 0, 200))
  f.step(40)
  const first = guard.searchKind === 'lost' && guard.searchPoints[0]
  assert(first, 'He searches for the lost contact')
  assert(first.x > 14 * 0.1 + 2, `First where you were heading (${first.x.toFixed(1)} m east of where he lost you)`)
  // A checkpoint keeps what he knows.
  const saved = f.ai.snapshot()
  guard.caution = 0; guard.lastHeading = null; guard.searchKind = 'noise'
  f.ai.restore(saved)
  assert(guard.caution > 0 && guard.searchKind === 'lost', 'A checkpoint keeps his caution and his search')
  f.dispose()
}
console.log('PASS A lost contact is searched for first where you were heading; checkpoints keep it')
