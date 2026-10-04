import * as THREE from 'three'
import { Draft, wallText } from '../render/ink'
import { fence } from '../world/industrial'
import { enemy } from '../game/enemy-types'
import type { GoalSpec } from '../game/goals'
import type { MissionWorld, Vec3 } from '../game/types'

/**
 * The boss arena: a developer level (Gallery → Dev mode) to fight the bosses modelled with Hyper3D Rodin
 * (game/boss-models.ts). One walled yard, 56 × 44 m, its middle at the origin, north = −Z: you come in at the south
 * end by a weapons table behind a screen wall, broken concrete for cover across the middle, and the three bosses at the north end:
 * the Warden (west), Bulky Boy (middle) and the Sapper (east). Defeat all three.
 */
export const BOSS_ARENA = { width: 56, depth: 44, spawn: [0, 0, 18] as Vec3, lookAt: [0, 1.6, 0] as Vec3 }

export function createBossArena(): { ground: THREE.Group; world: MissionWorld } {
  const { width, depth } = BOSS_ARENA
  const hx = width / 2, hz = depth / 2
  const ground = new THREE.Group()
  ground.name = 'Boss arena'
  ground.userData = { kind: 'boss-arena' }
  const field = new Draft('Boss arena · field')
  field.box(width + 40, 0.1, depth + 40, 0, -0.05, 0, 'paper', false)
  ground.add(field.finish())
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  paper.rotation.x = -Math.PI / 2
  paper.position.y = -0.06
  paper.name = 'Unlit paper ground'
  paper.userData.noCollision = true
  ground.add(paper)

  const props = new Draft('Boss arena · walls and cover')
  // A high concrete wall all round.
  for (const [x, z, w, d] of [[0, -hz, width, 0.5], [0, hz, width, 0.5], [-hx, 0, 0.5, depth], [hx, 0, 0.5, depth]] as [number, number, number, number][]) {
    props.box(w, 3.6, d, x, 1.8, z, 'concrete', 'detail')
  }
  // Cover across the middle: blocks and low walls, staggered so there is always somewhere to duck.
  for (const [x, z, w, h, d, turn] of [[-14, 6, 3, 1.3, 1, 0], [-5, 9, 1.4, 1.6, 1.4, 20], [6, 7, 3.4, 1.2, 0.8, -10], [15, 10, 1.6, 2.4, 1.6, 0],
    [-18, -4, 1.6, 2.6, 1.6, 0], [-9, -2, 3, 1.3, 0.9, 35], [0, 0, 2.2, 1.5, 2.2, 45], [10, -3, 3.2, 1.3, 0.9, -25], [19, -6, 1.6, 2.6, 1.6, 0],
    [-6, -11, 2.4, 1.2, 0.9, 0], [7, -12, 2.4, 1.2, 0.9, 0]] as [number, number, number, number, number, number][]) {
    props.box(w, h, d, x, h / 2, z, 'concrete', 'detail', [0, THREE.MathUtils.degToRad(turn), 0])
  }
  // A plinth for each boss, ringed in ink.
  for (const x of [-14, 0, 14]) {
    props.box(4, 0.3, 4, x, 0.15, -16, 'concrete', 'detail')
    props.ring(2.6, 0.012, x, -16, 'detail', 40)
  }
  // A screen wall in front of the way in: the bosses never see you arrive, and you step out round either end.
  props.box(10, 3.2, 0.5, 0, 1.6, 12.5, 'concrete', 'detail')
  // The weapons table by the way in.
  props.box(4.2, 0.1, 1.1, 0, 0.88, 15.4, 'roof', 'detail')
  for (const sx of [-1.9, 1.9]) for (const sz of [-0.42, 0.42]) props.beam([sx, 0, 15.4 + sz], [sx, 0.84, 15.4 + sz], 0.08, 'paper', 'detail')
  ground.add(props.finish())
  ground.add(fence('Boss arena · outer fence', [[-hx - 6, -hz - 6], [hx + 6, -hz - 6], [hx + 6, hz + 6], [-hx - 6, hz + 6], [-hx - 6, -hz - 6]], 2.6))
  for (const [text, x] of [['THE WARDEN', -14], ['BULKY BOY', 0], ['THE SAPPER', 14]] as [string, number][]) {
    ground.add(wallText(text, [x, 2.6, -hz + 0.27], 0.5))
  }
  ground.add(wallText('BOSS ARENA', [0, 2.7, hz - 0.27], 0.45, Math.PI))
  // Rifles on the table, as weapon spots the game turns into pickups.
  for (const [name, x, magazine, reserve] of [['ak', -1.4, 30, 150], ['shotgun', 0, 6, 36], ['sniper', 1.4, 5, 30]] as const) {
    const spot = new THREE.Object3D()
    spot.name = `Boss arena table · ${name}`
    spot.position.set(x, 0.94, 15.4)
    spot.userData.weaponSpot = { id: `arena-${name}`, name, magazine, reserve }
    ground.add(spot)
  }
  ground.updateMatrixWorld(true)

  const root = new THREE.Group()
  root.name = 'Boss arena mission'
  const enemies = [
    enemy('warden', 'warden', [-14, 0.3, -16], { name: 'The Warden', facing: 0 }),
    enemy('bulky', 'bulky-boy', [0, 0.3, -16], { name: 'Bulky Boy', facing: 0 }),
    enemy('sapper', 'sapper', [14, 0.3, -16], { name: 'The Sapper', facing: 0 }),
  ]
  const goals: GoalSpec[] = [
    { id: 'warden', kind: 'eliminate', enemies: ['warden'], label: 'Defeat the Warden', detail: 'West plinth', done: 'The Warden is down.' },
    { id: 'bulky', kind: 'eliminate', enemies: ['bulky-boy'], label: 'Defeat Bulky Boy', detail: 'Middle plinth', done: 'Bulky Boy is down.' },
    { id: 'sapper', kind: 'eliminate', enemies: ['sapper'], label: 'Defeat the Sapper', detail: 'East plinth', done: 'The Sapper is down.' },
  ]
  return {
    ground,
    world: {
      level: 'boss-arena', root, stations: [], enemies, goals, spawn: BOSS_ARENA.spawn, lookAt: BOSS_ARENA.lookAt,
      bounds: { minX: -hx - 8, maxX: hx + 8, minZ: -hz - 8, maxZ: hz + 8 },
      briefing: {
        title: 'Boss arena', premise: 'Three bosses, modelled with Rodin 3D. Take them down.', won: 'Arena cleared.', outro: 'All three bosses are down.',
        tips: ['Rifles wait on the table by the way in: an AK, a shotgun and a sniper rifle.',
          'Their armour soaks body hits until it breaks; head shots go straight through.',
          'The Warden fires an SMG, Bulky Boy an AK, the Sapper a shotgun from inside his bomb suit, the heaviest armour of the three.'],
      },
    },
  }
}
