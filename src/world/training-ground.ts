import * as THREE from 'three'
import { Draft, wallText, type Point } from '../render/ink'
import { fence } from './industrial'
import { drawPine } from './vegetation'

/**
 * The tutorial's training ground: one long fenced field, walked north (−Z) through five areas.
 *   1 Movement yard   z  +8 … −30   sandbag walls to crouch behind, and a corner wall to lean around
 *     Crawl wall      z −30.4 … −33.6  a wall across the field; the only way through is a low tunnel, crawled prone
 *   2 Armory          z −34 … −42   a table of rifles to pick up
 *   3 Firing range    z −42 … −104  booths, practice soldiers at three distances, one turned away for the knife
 *     Grenade yard    x −27 … −15   left of the range: a throwing line, a frag pit, a wall to flash over, and a
 *                     spotter's tower to smoke out
 *   4 Live fire       z −108 … −152 a walled yard with cover, where soldiers shoot back
 *   5 Boss field      z −156 … −230 open ground with broken blocks, where Bulky Boy waits
 * Everything is built in code in the game's paper-and-ink style, like the compound.
 */
export const TRAINING = {
  spawn: [0, 0, 5] as Point,
  lookAt: [0, 1.5, -10] as Point,
  bounds: { minX: -34, maxX: 34, minZ: -236, maxZ: 16 },
  /** Where each lesson points the player. */
  marks: {
    yard: [0, 0, -12] as Point, sandbags: [-5, 0, -18] as Point, corner: [6, 0, -27] as Point, crawl: [0, 0, -29.6] as Point, armory: [0, 0, -36.6] as Point,
    range: [0, 0, -45] as Point, knife: [10.5, 0, -49] as Point,
    grenades: [-21, 0, -48] as Point, fragPit: [-21, 0, -60] as Point, flashWall: [-21, 0, -72] as Point, smokeTower: [-21, 0, -94] as Point,
    liveGate: [0, 0, -106] as Point, bossGate: [0, 0, -154] as Point, boss: [0, 0, -200] as Point,
  },
  /** The crawl tunnel through the wall before the armory: its span in x and z, and its clearance (m). */
  crawl: { x: 1.4, z0: -30.4, z1: -33.6, clearance: 0.72 },
  /** The grenade yard's spotter stands on his tower's platform, this high (m). */
  spotterHeight: 3.2,
  /** Crossing this line (z) into the field wakes Bulky Boy. */
  bossLine: -158,
} as const

/** A standing signboard: two posts, a board and a hand-lettered sign facing +Z. */
function signpost(g: THREE.Group, text: string, x: number, z: number, angle = 0, height = 0.42) {
  const sign = new Draft(`Training sign · ${text}`, x, z, angle)
  for (const sx of [-1.1, 1.1]) sign.beam([sx, 0, 0], [sx, 2.1, 0], 0.09, 'paper', 'detail')
  sign.box(2.6, 0.7, 0.06, 0, 1.75, 0, 'paper', 'detail')
  sign.add(wallText(text, [0, 1.75, 0.04], height))
  g.add(sign.finish())
}

/** A low wall of stacked sandbags along X, `length` long, centred on (x, z). */
function sandbags(g: Draft, x: number, z: number, length: number, rows = 3, angle = 0) {
  const count = Math.round(length / 0.62)
  for (let row = 0; row < rows; row++) for (let i = 0; i < count - (row % 2); i++) {
    const u = -length / 2 + 0.31 + i * 0.62 + (row % 2) * 0.31
    const [px, pz] = [x + Math.cos(angle) * u, z - Math.sin(angle) * u]
    g.box(0.6, 0.26, 0.4, px, 0.13 + row * 0.25, pz, 'concrete', 'detail', [0, angle, 0])
  }
}

export function createTrainingGround() {
  const root = new THREE.Group()
  root.name = 'Training ground'
  root.userData = { kind: 'training-ground' }

  // Ground: one solid slab the whole length, with paper beyond the fence to the horizon.
  const ground = new Draft('Training ground · field')
  ground.box(90, 0.1, 280, 0, -0.05, -110, 'paper', false)
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  paper.rotation.x = -Math.PI / 2
  paper.position.y = -0.06
  paper.name = 'Unlit paper ground'
  paper.userData.noCollision = true
  root.add(paper)
  // Gravel path up the middle, edged in pen.
  for (const side of [-1, 1]) ground.line([[side * 2.2, 0.01, 10], [side * 2.2, 0.01, -228]], 'landscape')
  root.add(ground.finish())
  root.add(fence('Training ground · perimeter fence', [[-30, 14], [30, 14], [30, -232], [-30, -232], [-30, 14]], 2.6))

  const props = new Draft('Training ground · props')
  // 1 · Movement yard. Start pad, sandbag cover to crouch behind, and a corner wall to lean around.
  props.box(6, 0.04, 4, 0, 0.02, 5, 'concrete', 'detail')
  sandbags(props, -5, -18, 4.4)
  sandbags(props, 5, -15, 3.1, 2)
  sandbags(props, -1.5, -22, 2.5, 4)
  props.box(0.4, 2.6, 5, 4.3, 1.3, -27, 'concrete', 'detail')
  props.box(4, 2.6, 0.4, 6.1, 1.3, -24.7, 'concrete', 'detail')
  // A painted circle on each spot where a lesson happens.
  for (const [x, z] of [[-5, -16.6], [6, -27.6], [-1.5, -20.6]]) {
    props.line(Array.from({ length: 25 }, (_, i): Point => [x + Math.cos(i / 24 * Math.PI * 2) * 0.9, 0.012, z + Math.sin(i / 24 * Math.PI * 2) * 0.9]), 'detail')
  }
  // The crawl wall: a concrete wall right across the field, too high to jump, in front of the armory. Its one way
  // through is a low tunnel in the middle, roofed with a slab at knee height: standing or crouched you don't fit,
  // prone you crawl through. Barbed wire runs along the slab's top for the look of an obstacle course.
  const { x: cx, z0, z1, clearance } = TRAINING.crawl, wallZ = (z0 + z1) / 2
  for (const [x0, x1] of [[-30, -cx - 0.3], [cx + 0.3, 30]]) props.box(x1 - x0, 2.8, 0.5, (x0 + x1) / 2, 1.4, wallZ, 'concrete', 'detail')
  for (const side of [-1, 1]) props.box(0.3, clearance, z0 - z1, side * (cx + 0.15), clearance / 2, wallZ, 'concrete', 'detail')
  props.box(cx * 2 + 0.6, 0.18, z0 - z1, 0, clearance + 0.09, wallZ, 'concrete', 'detail')
  // Above the tunnel the wall carries on up to full height, so there is no climbing over it.
  props.box(cx * 2 + 0.6, 2.8 - clearance - 0.18, 0.5, 0, (2.8 + clearance + 0.18) / 2, wallZ, 'concrete', 'detail')
  for (const z of [z0 + 0.15, z1 - 0.15]) {
    props.line(Array.from({ length: 17 }, (_, i): Point => [-cx - 0.3 + i * (cx * 2 + 0.6) / 16, clearance + 0.26 + (i % 2) * 0.07, z]), 'detail')
  }
  // Arrows painted on the ground into the tunnel.
  for (const z of [z0 + 1.8, z0 + 1.1]) props.line([[-0.45, 0.012, z + 0.35], [0, 0.012, z - 0.1], [0.45, 0.012, z + 0.35]], 'detail')
  // 2 · Armory: a long table under an awning.
  props.box(4.2, 0.1, 1.1, 0, 0.88, -37, 'roof', 'detail')
  for (const sx of [-1.9, 1.9]) for (const sz of [-0.42, 0.42]) props.beam([sx, 0, -37 + sz], [sx, 0.84, -37 + sz], 0.08, 'paper', 'detail')
  for (const sx of [-2.6, 2.6]) for (const sz of [-38.4, -35.6]) props.beam([sx, 0, sz], [sx, 2.6, sz], 0.1, 'paper', 'detail')
  props.box(5.8, 0.12, 3.4, 0, 2.66, -37, 'roof', 'detail')
  // 3 · Firing range: a firing line with booths, distance boards, and an earth berm behind the targets.
  props.box(16, 0.05, 0.25, 0, 0.025, -43.6, 'roof', 'detail')
  for (const x of [-8, -4, 0, 4, 8]) props.box(0.12, 1.4, 1.8, x, 0.7, -44.4, 'paper', 'detail')
  props.box(16.2, 0.95, 0.4, 0, 0.475, -45.4, 'paper', 'detail')
  props.box(28, 3.4, 4, 0, 1.7, -103, 'concrete', 'detail')
  for (const z of [-58, -76, -96]) props.line([[-12, 0.012, z], [12, 0.012, z]], 'detail')
  // Knife corner: a booth off to the right with a soldier standing in it, his back to you.
  props.box(0.15, 2.2, 4, 8.6, 1.1, -49.5, 'concrete', 'detail')
  props.box(0.15, 2.2, 4, 12.4, 1.1, -49.5, 'concrete', 'detail')
  props.box(3.95, 2.2, 0.15, 10.5, 1.1, -51.5, 'concrete', 'detail')
  // Grenade yard, left of the range. A low sandbag wall to throw over, then three stations up the yard:
  // a painted pit with three soldiers for the frag, a chest-high wall with two soldiers behind it for the
  // flashbang, and a spotter's tower at the far end that sees the whole yard until a smoke goes up.
  sandbags(props, -21, -48.6, 9, 2)
  props.box(10, 0.05, 0.25, -21, 0.025, -47.9, 'roof', 'detail')
  props.ring(3.2, 0.012, -21, -60.2, 'detail', 40)
  props.ring(0.5, 0.012, -21, -60.2, 'detail', 16)
  sandbags(props, -21, -71.4, 6.2, 4)
  for (const [x, z] of [[-22, -94], [-20, -94], [-22, -96], [-20, -96]] as [number, number][]) props.beam([x, 0, z], [x, TRAINING.spotterHeight, z], 0.16, 'paper', 'detail')
  props.box(2.8, 0.2, 2.8, -21, TRAINING.spotterHeight - 0.1, -95, 'paper', 'detail')
  for (const [x0, z0, x1, z1] of [[-22.4, -93.6, -19.6, -93.6], [-22.4, -96.4, -19.6, -96.4], [-22.4, -93.6, -22.4, -96.4], [-19.6, -93.6, -19.6, -96.4]] as [number, number, number, number][]) {
    props.beam([x0, TRAINING.spotterHeight + 0.95, z0], [x1, TRAINING.spotterHeight + 0.95, z1], 0.06, 'paper', 'detail')
  }
  // Dashes across the open lane the spotter watches.
  for (let x = -26; x <= -16; x += 1.4) props.line([[x, 0.012, -84], [x + 0.7, 0.012, -84]], 'detail')
  // 4 · Live-fire yard: walled, with an opening, and crates and barriers to fight from.
  for (const [x0, x1] of [[-30, -1.4], [1.4, 30]]) props.box(x1 - x0, 3, 0.4, (x0 + x1) / 2, 1.5, -107, 'concrete', 'detail')
  for (const [x, z, w, d, h] of [[-5, -116, 2.4, 1.2, 1.1], [4.5, -119, 1.2, 2.6, 1.2], [-1, -125, 3.2, 0.5, 1.4], [-7, -131, 1.4, 1.4, 1.4],
    [6.5, -132, 2.8, 0.5, 1.4], [0, -137, 1.3, 1.3, 1.3], [-4.5, -142, 2.4, 0.5, 1.4], [5, -145, 1.4, 1.4, 1.4]] as [number, number, number, number, number][]) {
    props.box(w, h, d, x, h / 2, z, 'concrete', 'detail')
  }
  for (const [x, z] of [[-10, -122], [10, -128], [-11, -140]] as [number, number][]) sandbags(props, x, z, 3.2, 3)
  // 5 · Boss field: the wall with a gate gap, then broken concrete blocks and pillars across open ground.
  for (const [x0, x1] of [[-30, -2], [2, 30]]) props.box(x1 - x0, 3.4, 0.5, (x0 + x1) / 2, 1.7, -155, 'concrete', 'detail')
  for (const [x, z, w, h, d, turn] of [[-9, -172, 2.6, 1.5, 1.4, 12], [8, -178, 1.6, 2.6, 1.6, -8], [-3, -186, 3.4, 1.2, 1, 30], [11, -196, 2.2, 1.6, 2.2, 5],
    [-11, -199, 1.6, 2.9, 1.6, 0], [3, -212, 3, 1.4, 1.2, -20], [-7, -218, 2.2, 1.8, 1.6, 45]] as [number, number, number, number, number, number][]) {
    props.box(w, h, d, x, h / 2, z, 'concrete', 'detail', [0, THREE.MathUtils.degToRad(turn), 0])
  }
  for (let i = 0; i < 9; i++) {
    const angle = i / 9 * Math.PI * 2
    props.line([[Math.cos(angle) * 14, 0.012, -200 + Math.sin(angle) * 14], [Math.cos(angle + 0.5) * 14, 0.012, -200 + Math.sin(angle + 0.5) * 14]], 'landscape')
  }
  root.add(props.finish())

  // Rifles laid out on the armory table, as weapon spots the game turns into pickups.
  for (const [name, x, magazine, reserve] of [['ak', -1.4, 30, 90], ['shotgun', -0.25, 6, 18], ['sniper', 0.9, 5, 15]] as const) {
    const spot = new THREE.Object3D()
    spot.name = `Armory table · ${name}`
    spot.position.set(x, 0.94, -37)
    spot.userData.weaponSpot = { id: `armory-${name}`, name, magazine, reserve }
    root.add(spot)
  }
  const smg = new THREE.Object3D()
  smg.name = 'Armory table · smg'
  smg.position.set(1.85, 0.94, -37)
  smg.userData.weaponSpot = { id: 'armory-smg', name: 'smg', magazine: 24, reserve: 0 }
  root.add(smg)

  // Signs for each area.
  signpost(root, '1 · MOVE', -7, -4, 0)
  signpost(root, 'CRAWL UNDER · Z', -5, -29, 0, 0.3)
  signpost(root, '2 · ARMORY', -6, -34.4, 0)
  signpost(root, '3 · FIRING RANGE', -11, -42.5, 0, 0.32)
  signpost(root, 'KNIFE', 13.8, -46.5, 0)
  signpost(root, 'GRENADES · 4', -27.4, -46.2, 0, 0.3)
  signpost(root, '4 · LIVE FIRE', -5, -105.6, 0, 0.36)
  signpost(root, '5 · BULKY BOY', -5.5, -153.3, 0, 0.32)

  // Pines around the outside of the fence.
  const trees = new Draft('Training ground · pines')
  for (let i = 0; i < 46; i++) {
    const side = i % 2 ? 1 : -1, z = 10 - (i >> 1) * 10.5
    drawPine(trees, side * (34 + (i * 7) % 9), z + (i * 13) % 5, 7 + (i * 5) % 4, 900 + i)
  }
  root.add(trees.finish())
  return root
}
