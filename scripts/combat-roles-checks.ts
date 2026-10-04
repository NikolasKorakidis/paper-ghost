import assert from 'node:assert/strict'
import * as THREE from 'three'
import { EnemyDirector } from '../src/game/ai'
import type { EnemyActor } from '../src/game/actors'
import { COMBAT_ROLES, DETECTION, GRENADE_RULES } from '../src/game/balance'
import { CollisionWorld } from '../src/player/collision'
import type { EnemySpec, PlayerSense, Vec3 } from '../src/game/types'

/*
 * Squad roles in a fight (after Metal Gear Solid V): a suppressor keeps your head down with blind fire while you hide;
 * stay down and a frag comes over your cover (never onto a comrade); grenades by a guard's feet send him running;
 * a squad cut in half falls back and calls for help; a sniper radios where you are to the men hunting you.
 */
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const actor = async () => {
  const root = new THREE.Group()
  return { root, reactionRemaining: 0, animationTime: 0, update() {}, shoot() {}, restore() {}, react() {}, dispose() {}, muzzle: () => root.position.clone().add(v(0, 1.4, 0.3)) } as unknown as EnemyActor
}
async function field(specs: Partial<EnemySpec>[], at = v(0, 0, 15)) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  floor.rotation.x = -Math.PI / 2; scene.add(floor)
  scene.updateMatrixWorld(true)
  const world = new CollisionWorld(scene)
  const throws: { origin: THREE.Vector3; velocity: THREE.Vector3 }[] = []
  let damage = 0
  const ai = new EnemyDirector({ scene, world, doors: [], emit() {}, damagePlayer: amount => { damage += amount }, dropWeapon() {},
    throwGrenade: (_kind, origin, velocity) => { throws.push({ origin: origin.clone(), velocity: velocity.clone() }) },
    specs: specs.map((spec, i) => ({ id: `g${i}`, name: `G${i}`, position: [0, 0, 0] as Vec3, patrol: [], weapon: 'ak', facing: 0, squad: 'one', ...spec }) as EnemySpec) }, actor)
  await ai.init()
  const player: PlayerSense = { feet: at.clone(), eye: at.clone().add(v(0, 1.65)), velocity: v(), alive: true, radioEnabled: true }
  const step = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) ai.update(1 / 60, player) }
  const move = (to: THREE.Vector3) => { player.feet.copy(to); player.eye.copy(to).add(v(0, 1.65)) }
  return { ai, player, step, move, throws, damage: () => damage, dispose() { ai.dispose(); world.dispose() } }
}
/** Where a grenade thrown from `origin` at `velocity` comes down to the floor (y 0). */
const landing = (origin: THREE.Vector3, velocity: THREE.Vector3) => {
  const g = GRENADE_RULES.throw.gravity, t = (velocity.y + Math.sqrt(velocity.y ** 2 + 2 * g * origin.y)) / g
  return v(origin.x + velocity.x * t, 0, origin.z + velocity.z * t)
}

{
  // Seen, then gone (out of sight): one man of the squad keeps firing at where the player was; blind rounds never hurt.
  const f = await field([{ position: [0, 0, 0], grenades: 0 }, { position: [3, 0, 0], grenades: 0 }])
  f.step(DETECTION.notice + 1.5)
  assert(f.ai.enemies.every(enemy => enemy.state === 'combat'), 'Both fight')
  const hurt = f.damage()
  f.move(v(-200, 0, 300))
  const before = f.ai.enemies.map(enemy => enemy.shots)
  f.step(COMBAT_ROLES.suppress.after + COMBAT_ROLES.suppress.time - 0.5)
  const fired = f.ai.enemies.map((enemy, i) => enemy.shots - before[i])
  assert(fired.some(count => count >= 3), `One keeps firing at where he was (${fired.join(', ')} rounds)`)
  assert(fired.filter(count => count > 0).length === 1, `Only one of them: the suppressor (${fired.join(", ")})`)
  assert.equal(f.damage(), hurt, 'Blind rounds do no harm')
  f.dispose()
}
console.log('PASS The squad\'s suppressor keeps firing at where you went to ground; blind rounds are pressure, not damage')

{
  // Down behind cover 16 m off for a few seconds: a frag comes over, landing by where he was.
  const f = await field([{ position: [0, 0, 0] }], v(0, 0, 16))
  f.step(DETECTION.notice + 1.5)
  const known = f.ai.enemies[0].lastKnown!.clone()
  f.move(v(-200, 0, 300))
  f.step(COMBAT_ROLES.grenade.until)
  assert.equal(f.throws.length, 1, 'One frag, thrown once')
  const down = landing(f.throws[0].origin, f.throws[0].velocity)
  assert(down.distanceTo(known) < 2.5, `It comes down by where he was (${down.distanceTo(known).toFixed(1)} m off)`)
  assert.equal(f.ai.enemies[0].grenades, 0, 'He has used his grenade')
  f.dispose()
  // Never with a comrade by the target.
  // (A man standing 3.6 m from where the player went to ground, who stays there.)
  const g = await field([{ position: [0, 0, 0] }, { position: [2, 0, 13], facing: Math.PI, dummy: true, squad: undefined }], v(0, 0, 16))
  g.step(DETECTION.notice + 1.5)
  assert.equal(g.ai.enemies[0].state, 'combat')
  g.move(v(-200, 0, 300))
  g.step(COMBAT_ROLES.grenade.until)
  assert.equal(g.throws.length, 0, 'No frag lands by a comrade')
  g.dispose()
}
console.log('PASS Stay down and a frag comes over your cover, never onto a comrade')

{
  // A grenade lands by a guard: he runs from it.
  const f = await field([{ position: [0, 0, 0] }], v(200, 0, 200))
  const guard = f.ai.enemies[0]
  const at = v(1.5, 0.1, 1)
  f.ai.hear({ kind: 'grenade-bounce', position: at, radius: 7 })
  assert(guard.dodgePoint, 'He sees it and runs')
  f.step(COMBAT_ROLES.dodge.time)
  assert(guard.position.distanceTo(at) > COMBAT_ROLES.dodge.radius - 0.5, `He gets clear (${guard.position.distanceTo(at).toFixed(1)} m)`)
  f.dispose()
}
console.log('PASS A guard runs from a grenade that lands by him')

{
  // Two of a three-man squad down, the third hurt: he falls back to cover away from the player and calls for help.
  const f = await field([{ position: [0, 0, 0] }, { position: [3, 0, 0] }, { position: [-3, 0, 0] }], v(0, 0, 14))
  f.step(DETECTION.notice + 1.5)
  const [hurt, a, b] = f.ai.enemies
  for (const dead of [a, b]) { dead.health = 0; dead.state = 'dead' }
  hurt.health = 40; hurt.tacticTimer = 0
  const from = hurt.position.distanceTo(v(0, 0, 14))
  f.step(0.2)
  assert.equal(hurt.tactic, 'retreat', 'He falls back')
  assert(hurt.tacticPoint && hurt.tacticPoint.distanceTo(v(0, 0, 14)) > from - 1, 'away from the player')
  assert(f.ai.zones.zones[hurt.zone].help > 0, 'and his zone calls for help')
  f.dispose()
}
console.log('PASS A squad cut in half falls back and calls for help')

{
  // A sniper sees the player; a guard 60 m away, searching elsewhere, is told and comes for where the player is.
  const f = await field([{ position: [0, 0, 0], role: 'sniper', weapon: 'sniper', squad: 'tower' }, { position: [60, 0, 60], squad: 'yard' }], v(0, 0, 40))
  const [sniper, searcher] = f.ai.enemies
  searcher.lastKnown = v(90, 0, 90); searcher.searchKind = 'noise'
  ;(f.ai as unknown as { enter: (e: unknown, s: string) => void }).enter(searcher, 'search')
  f.step(DETECTION.notice + 2)
  assert(sniper.canSee, 'The sniper has the player in his scope')
  assert.equal(searcher.state, 'investigate', 'The searcher drops his search')
  assert(searcher.lastKnown!.distanceTo(v(0, 0, 40)) < 1.5, 'and comes for where the player is')
  f.dispose()
}
console.log('PASS A sniper radios the player\'s position to the men hunting him')
