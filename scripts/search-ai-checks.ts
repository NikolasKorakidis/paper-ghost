import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { DETECTION } from '../src/game/balance'
import { CollisionWorld } from '../src/player/collision'
import { transientLights } from '../src/render/neon'
import { darkRoom } from '../src/world/lights'
import type { EnemySpec, PlayerSense, Vec3 } from '../src/game/types'

/*
 * How guards search (after Metal Gear Solid V): hiding places they cannot see behind are checked first, and looked
 * into; a search team bounds, one man moving while the other covers; a lost contact is looked for along the way the
 * ground actually goes; and in a dark room the searchers switch on their torches.
 */
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const actor = async () => {
  const root = new THREE.Group()
  return { root, reactionRemaining: 0, animationTime: 0, update() {}, shoot() {}, restore() {}, react() {}, dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as EnemyActor
}
async function field(specs: Partial<EnemySpec>[], options: { walls?: [number, number, number, number][]; furniture?: [string, number, number][]; dark?: boolean } = {}) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  for (const [x, z, width, depth] of options.walls ?? []) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, 3, depth), new THREE.MeshBasicMaterial())
    wall.position.set(x, 1.5, z); scene.add(wall)
  }
  for (const [kind, x, z] of options.furniture ?? []) {
    const item = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.9, 0.55), new THREE.MeshBasicMaterial())
    item.position.set(x, 0.95, z); item.userData.furniture = kind; scene.add(item)
  }
  if (options.dark) scene.add(darkRoom('Test hall', [0, 1.5, 0], [30, 1.6, 30]))
  scene.updateMatrixWorld(true)
  const world = new CollisionWorld(scene)
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer() {}, dropWeapon() {},
    specs: specs.map((spec, i) => ({ id: `g${i}`, name: `G${i}`, position: [0, 0, 0] as Vec3, patrol: [], weapon: 'ak', facing: 0, ...spec }) as EnemySpec) }, actor)
  await ai.init()
  const player: PlayerSense = { feet: v(300, 0, 300), eye: v(300, 1.65, 300), velocity: v(), alive: true, radioEnabled: true }
  const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) ai.update(1 / 60, player) }
  return { ai, player, step, dispose() { ai.dispose(); world.dispose() } }
}

{
  // A shot 10 m off, with a locker bank beside it behind a wall from the guard: he checks the lockers, and looks into
  // them when he gets there.
  const f = await field([{ facing: Math.PI }], { walls: [[3, 8, 8, 0.4]], furniture: [['locker-bank', 3, 10.6]] })
  const guard = f.ai.enemies[0]
  f.ai.hear({ kind: 'shot-ak', position: v(2, 1.5, 11), radius: 75 })
  for (let t = 0; t < 40 && guard.state !== 'search'; t += 0.25) f.step(0.25)
  assert.equal(guard.state, 'search', 'He walks round to where the shot was and searches')
  const look = guard.searchLooks.find(Boolean)
  assert(look && look.distanceTo(v(3, 0.95 + 0.6, 10.6)) < 1, 'He checks the locker bank by the noise')
  const at = guard.searchLooks.indexOf(look!)
  for (let t = 0; t < 30 && guard.searchIndex <= at; t += 0.1) f.step(0.1)
  f.step(0.6)
  const facing = Math.atan2(look!.x - guard.position.x, look!.z - guard.position.z)
  assert(Math.abs(Math.atan2(Math.sin(facing - guard.yaw), Math.cos(facing - guard.yaw))) < 0.35, 'and looks into it there')
  f.dispose()
}
console.log('PASS Hiding places by the noise, out of sight, are checked first and looked into')

{
  // Lost going east down a corridor that ends in a wall at x 6.5 and opens north (−z) from x 3.2: the first place he
  // searches is up the turn, not in the end wall.
  const f = await field([{ position: [-6, 0, 0], facing: Math.PI / 2 }], { walls: [[6.5, 0, 0.4, 6], [-2.4, -1.6, 11.2, 0.4], [-1, 2.2, 14, 0.4]] })
  const guard = f.ai.enemies[0]
  guard.lastKnown = v(2, 0, 0.3); guard.lastHeading = v(1, 0, 0); guard.searchKind = 'lost'; guard.state = 'investigate'
  ;(f.ai as unknown as { enter: (e: unknown, s: string) => void }).enter(guard, 'search')
  const first = guard.searchPoints[0]
  assert(first, 'He has places to search')
  assert(first.x < 6.3, `Not through the end wall (x ${first.x.toFixed(1)})`)
  assert(f.ai.navigation.direct(v(2, 0, 0.3), first), 'The first place is where the passage goes from where he lost you')
  f.dispose()
}
console.log('PASS A lost contact is looked for along the way the ground goes, round a turn, not through a wall')

{
  // A body: the two guards make a search team; the second waits, covering, until the leader reaches each place.
  const f = await field([{ position: [0, 0, 0] }, { position: [2, 0, 0] }, { id: 'victim', position: [0, 0, 12] } as Partial<EnemySpec>])
  const [a, b, body] = f.ai.enemies
  body.health = 0; body.state = 'dead'
  f.step(0.5)
  f.step(4)
  const team = [a, b].filter(g => g.team >= 0)
  assert(team.length === 2 && team[0].team === team[1].team, 'The two of them search as one team')
  {
    const leader = team.find(g => g.teamSlot === 0)!, follower = team.find(g => g.teamSlot > 0)!
    let violations = 0
    for (let t = 0; t < 40; t += 0.1) {
      f.step(0.1)
      if (follower.state === 'search' && leader.state === 'search' && follower.searchIndex > leader.searchIndex) violations++
    }
    assert.equal(violations, 0, 'The second man never gets ahead of his leader')
    assert(leader.searchIndex >= 2 && follower.searchIndex >= 1, `and both get through their places (${leader.searchIndex}, ${follower.searchIndex})`)
  }
  f.dispose()
}
console.log('PASS A search team bounds: the man behind waits for his leader to reach each place')

{
  // In a dark hall a searching guard switches his torch on; at his post it is off.
  transientLights.clear()
  const f = await field([{ position: [0, 0, 0] }], { dark: true })
  const guard = f.ai.enemies[0]
  f.step(1)
  assert(![...transientLights].some(light => light.name.startsWith('Flashlight')), 'At his post, no torch')
  f.ai.hear({ kind: 'footstep', position: v(0, 1.5, 9), radius: 20 })
  f.step(1.5)
  assert.equal(guard.state, 'investigate')
  const torch = [...transientLights].find(light => light.name.startsWith('Flashlight'))
  assert(torch, 'Hunting in the dark, he switches his torch on')
  assert(torch!.position.distanceTo(guard.position) < 1.6, 'and carries it')
  f.dispose()
  assert(![...transientLights].some(light => light.name.startsWith('Flashlight')), 'Leaving the level takes the torches away')
  // Out in daylight he never needs one.
  const day = await field([{ position: [0, 0, 0] }])
  day.ai.hear({ kind: 'footstep', position: v(0, 1.5, 9), radius: 20 })
  day.step(1.5)
  assert(![...transientLights].some(light => light.name.startsWith('Flashlight')), 'In daylight, no torch')
  day.dispose()
}
console.log('PASS Guards hunting in a dark room carry torches; at their posts and in daylight they do not')
void DETECTION
