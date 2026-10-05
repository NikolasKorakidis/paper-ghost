import * as THREE from 'three'
import { Draft, SIGN_BLUE, wallText } from '../render/ink'
import { crates, steps, groundOutline, WALL_THICKNESS, interiorRoomOutline, piercedWall } from '../world/architecture'
import { createDoor } from '../world/doors'
import { createFenceGate } from '../world/fenceGate'
import { fence, gate, OBSERVATION_TOWER_POSITION, type PlanPoint } from '../world/industrial'
import { pipeLadder } from '../world/ladders'
import type { EnemySpec, MissionWorld, Station, Vec3 } from './types'
import { DETENTION_STAIR_HOLE, RESCUE_LAYOUT } from './rescue-layout'
import { createRescueJeep } from './rescue-jeep'
import { createCellLock } from './cell-lock'
import { SIGNALS_COMPUTER_ID } from './mission'
import { CAMERA_LIGHTS } from './security'
import { createMissionControl as control } from './mission-controls'
import { cageLamp, darkRoom, daylightOpening, doorwayLight, LAMP_AMBER, windowRow } from '../world/lights'
import { Furnishing } from '../world/interiors'
import { compoundMap } from './compound-map'
import { district } from './zones'

/**
 * The compound's districts (game/zones.ts): the yard where you come in (the mess hall, the sheds, the west wing and
 * the inner gate), the warehouses and barracks in the middle, and the detention block with the hostages, the crew
 * house and the security cabin in the east. Trouble in one puts the others on caution; nobody leaves his own.
 */
export const COMPOUND_DISTRICTS = [
  district('yard', 'Yard', -110, 3, -78, 80),
  district('warehouses', 'Warehouses', 3, 98, -78, 80),
  district('detention', 'Detention', 98, 185, -78, 80),
]

const FLOOR = 0.12
const DOOR_WIDTH = 2.1
const DOOR_HEIGHT = 2.65
const ROOF = 4.2

type HouseSpec = { name: string; x: number; z: number; width: number; depth: number; role: 'relay' | 'dispatch' | 'crew' | 'maintenance' }

/** Purpose-built through rooms. A two-metre central aisle stays clear at both doors. */
function house({ name, x, z, width: w, depth: d, role }: HouseSpec) {
  const root = new THREE.Group()
  root.name = name
  root.position.set(x, 0, z)
  root.userData = {
    environment: true, kind: 'mission-house', role, enterable: true, floor: FLOOR, missionSite: role === 'dispatch',
    footprint: [w, d], roofHeight: ROOF, roofWalkable: role === 'maintenance',
    entrances: [{ x: 0, z: d / 2 + 0.05, width: DOOR_WIDTH, floor: FLOOR },
      { x: 0, z: -d / 2 - 0.05, width: DOOR_WIDTH, floor: FLOOR }],
    route: [[0, FLOOR, d / 2 + 1], [0, FLOOR, 0], [0, FLOOR, -d / 2 - 1]],
  }
  const floor = new Draft(`${name} · floor`)
  floor.box(w + 0.25, FLOOR, d + 0.25, 0, FLOOR / 2, 0, 'concrete', 'detail')
  root.add(floor.finish())
  const walls = new Draft(`${name} · walls`)
  walls.userData.cutaway = true
  const height = ROOF - FLOOR - 0.2
  const wallFace = WALL_THICKNESS / 2
  for (const side of [-1, 1]) {
    piercedWall(walls, w, height, FLOOR, side * d / 2,
      [{ centre: 0, width: DOOR_WIDTH, bottom: 0, height: DOOR_HEIGHT }])
    const door = createDoor({ name: `${name} · ${side > 0 ? 'south' : 'north'} door`,
      x: 0, z: side * (d / 2 + 0.035), floor: FLOOR, width: DOOR_WIDTH,
      height: DOOR_HEIGHT, angle: side > 0 ? 0 : Math.PI, open: false, exit: true })
    root.add(door)
    // Every house is dark inside, lit by daylight through an open door. The security cabin has nothing else but its
    // camera monitor; the others also take daylight through their windows and have lamps (below).
    doorwayLight(door, -1, role === 'dispatch' ? {} : { bounce: 0.12 })
    if (role !== 'dispatch') root.add(windowRow(`${name} · ${side > 0 ? 'south' : 'north'} windows`, [0, 2.1, side * d / 2],
      side > 0 ? Math.PI : 0, [-(w / 2 - 1.65), w / 2 - 1.65], 1.6, 1.0))
    // Small windows beside the doors are indicated as filled glazing, so sight
    // and bullets follow the same solid wall geometry they visibly belong to.
    for (const direction of [-1, 1]) {
      const wx = direction * (w / 2 - 1.65)
      walls.box(1.6, 1.0, 0.035, wx, 2.1, side * (d / 2 + wallFace + 0.02), 'glass', 'detail')
      walls.line([[wx, 1.6, side * (d / 2 + wallFace + 0.043)], [wx, 2.6, side * (d / 2 + wallFace + 0.043)]], 'mesh')
      walls.hatch([wx - 0.67, 1.7, side * (d / 2 + wallFace + 0.05)], [0.48, 0, 0], [0, 0.6, 0],
        { spacing: 0.12, inset: 0.03 })
    }
    walls.hatch([-w / 2 + 0.2, ROOF - 0.48, side * (d / 2 + wallFace + 0.022)], [Math.min(w * 0.32, 3.2), 0, 0],
      [0, 0.23, 0], { spacing: 0.2, inset: 0.025 })
  }
  for (const side of [-1, 1]) {
    piercedWall(walls, d, height, FLOOR, side * w / 2, [], true)
  }
  interiorRoomOutline(walls, w - WALL_THICKNESS, d - WALL_THICKNESS, FLOOR, ROOF - 0.2)
  root.add(walls.finish())
  // Walls on the box's faces; its top halfway through the roof slab.
  root.add(darkRoom(name, [0, (FLOOR - 0.3 + ROOF - 0.1) / 2, 0], [w / 2, (ROOF - 0.1 - FLOOR + 0.3) / 2, d / 2], role === 'dispatch' ? {} : { ambient: 0.035 }))
  // Caged amber lamps under the ceiling, as in the other buildings: one over each half of the crew house's bunk
  // rooms, and two down the maintenance shelter.
  const lamps: [number, number][] = role === 'crew' ? [[0, -d / 4], [0, d / 4]] : role === 'maintenance' ? [[-w / 4, 0], [w / 4, 0]] : []
  for (const [i, [x, z]] of lamps.entries()) root.add(cageLamp(`${name} · lamp ${i + 1}`, [x, ROOF - 0.2, z], LAMP_AMBER, 0.45, { bounce: 0.12 }))
  const roof = new Draft(`${name} · flat roof`)
  roof.userData.cutaway = true
  roof.box(w + 0.45, 0.2, d + 0.45, 0, ROOF - 0.1, 0, 'roof')
  roof.hatch([-w / 2 + 0.1, ROOF + 0.016, -d / 2 + 0.2], [Math.min(w * 0.3, 3.4), 0, 0],
    [0, 0, 1.15], { spacing: 0.23, inset: 0.04 })
  // Maintenance roof has a safe observation edge and a real ladder gap.
  if (role === 'maintenance') {
    for (const side of [-1, 1]) roof.box(w + 0.2, 0.72, 0.16, 0, ROOF + 0.36, side * (d / 2 + 0.05), 'paper', 'detail')
    roof.box(0.16, 0.72, d, w / 2 + 0.05, ROOF + 0.36, 0, 'paper', 'detail')
    for (const side of [-1, 1]) roof.box(0.16, 0.72, (d - 1.6) / 2,
      -w / 2 - 0.05, ROOF + 0.36, side * (d + 1.6) / 4, 'paper', 'detail')
    const ladder = pipeLadder({ name: `${name} · west roof ladder`, x: -w / 2 - 0.59,
      z: 0, bottom: 0.03, landingHeight: ROOF, angle: -Math.PI / 2, landingDepth: 1.1 })
    root.add(ladder.finish())
  }
  root.add(roof.finish())
  const interior = new Draft(`${name} · furnishings`)
  if (role === 'crew') {
    // Wall-side bunks leave both the central aisle and the reserve muster areas free.
    for (const side of [-1, 1]) for (const bz of [-2.2, 2.2]) {
      const bx = side * (w / 2 - 1.1)
      interior.box(1.5, 0.18, 2.4, bx, FLOOR + 0.48, bz, 'concrete', 'detail')
      interior.box(1.38, 0.15, 2.26, bx, FLOOR + 0.64, bz, 'roof', 'detail')
      interior.box(1.22, 0.12, 0.45, bx, FLOOR + 0.76, bz - 0.74, 'paper', 'detail')
      for (const dx of [-0.58, 0.58]) for (const dz of [-1.0, 1.0]) interior.box(0.075, 0.45, 0.075,
        bx + dx, FLOOR + 0.225, bz + dz, 'roof', 'detail')
    }
    // A partial partition suggests two rooms while retaining a broad interior passage.
    for (const side of [-1, 1]) interior.box(w / 2 - 2.1, 2.6, 0.12,
      side * (w / 4 + 1.05), FLOOR + 1.3, 0, 'paper', 'detail')
  } else {
    const bx = -w / 2 + 1.05
    interior.box(1.3, 0.14, 3, bx, FLOOR + 0.91, -0.4, 'roof', 'detail')
    for (const dx of [-0.5, 0.5]) for (const dz of [-1.2, 1.2]) interior.box(0.075, 0.84, 0.075,
      bx + dx, FLOOR + 0.42, -0.4 + dz, 'paper', 'detail')
    interior.box(1.3, 1.5, 0.65, w / 2 - 1.15, FLOOR + 0.75, d / 2 - 1.25, 'concrete', 'detail')
    if (role === 'maintenance') crates(interior, -w / 2 + 0.8, -d / 2 + 1.1, 2, 'paper', FLOOR)
  }
  root.add(interior.finish())
  const names = { relay: 'DETENTION', dispatch: 'SECURITY', crew: 'CREW', maintenance: 'MAINTENANCE' }
  const letteringFace = d / 2 + WALL_THICKNESS / 2 + 0.006
  // The camera-control cabin's SECURITY label is blue so it can be spotted; the other houses stay ink black.
  const color = role === 'dispatch' ? SIGN_BLUE : undefined
  root.add(wallText(names[role], [0, 3.38, letteringFace], 0.6, 0, color))
  root.add(wallText(names[role], [0, 3.38, -letteringFace], 0.6, Math.PI, color))
  return root
}

/** Change only named fence runs; visual mesh and collision proxy share every cut. */
function fenceOpening(compound: THREE.Group, name: string, axis: 0 | 1, fixed: number,
  start: number, end: number, title: string) {
  const original = compound.getObjectByName(name)
  if (!original || original.userData.missionOpening) return
  const replacement = new THREE.Group()
  replacement.name = name
  replacement.userData = { environment: true, kind: 'fence', missionOpening: true }
  const panels = original.userData.collisionPanels as { a: PlanPoint; b: PlanPoint; height: number }[]
  if (!panels) return
  let index = 0
  for (const { a, b, height } of panels) {
    const cross = 1 - axis
    const cut = Math.abs(a[cross] - fixed) < 0.001 && Math.abs(b[cross] - fixed) < 0.001 &&
      Math.min(a[axis], b[axis]) < start && Math.max(a[axis], b[axis]) > end
    if (!cut) {
      replacement.add(fence(`${name} · run ${++index}`, [a, b], height))
      continue
    }
    const first = a[axis] < b[axis] ? start : end
    const second = a[axis] < b[axis] ? end : start
    const p: PlanPoint = [0, 0], q: PlanPoint = [0, 0]
    p[axis] = first; q[axis] = second; p[cross] = fixed; q[cross] = fixed
    replacement.add(fence(`${name} · run ${++index}`, [a, p], height),
      fence(`${name} · run ${++index}`, [q, b], height))
  }
  const centre = (start + end) / 2
  replacement.add(gate(title, axis === 0 ? centre : fixed, axis === 0 ? fixed : centre,
    end - start, axis === 0 ? 0 : Math.PI / 2, true))
  original.parent?.add(replacement)
  original.removeFromParent()
  original.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
}

/** Call after createCompound(), before constructing CollisionWorld/interactions. */
export function prepareCompound(compound: THREE.Group) {
  const ground = compound.getObjectByName('Unlit paper ground')
  if (ground instanceof THREE.Mesh && !ground.userData.detentionOpening) {
    const shape = new THREE.Shape()
    shape.moveTo(-1200, -1200); shape.lineTo(1200, -1200)
    shape.lineTo(1200, 1200); shape.lineTo(-1200, 1200); shape.closePath()
    const hole = new THREE.Path(), h = DETENTION_STAIR_HOLE
    hole.moveTo(h.minX, -h.minZ); hole.lineTo(h.maxX, -h.minZ)
    hole.lineTo(h.maxX, -h.maxZ); hole.lineTo(h.minX, -h.maxZ); hole.closePath()
    shape.holes.push(hole)
    ground.geometry.dispose()
    ground.geometry = new THREE.ShapeGeometry(shape)
    ground.userData.detentionOpening = true
  }
  fenceOpening(compound, 'Inner yard · railway separation and west return', 0, -18.75, 54, 60,
    'Rail maintenance gate · open')
  fenceOpening(compound, 'Perimeter · east, south and west', 1, 99, 8, 14,
    'East annex service gate · open')
  compound.updateMatrixWorld(true)
}

function enemy(id: string, name: string, patrol: Vec3[], weapon: EnemySpec['weapon'] = 'ak', reserve = false): EnemySpec {
  return { id, name, position: [...patrol[0]], patrol, weapon, reserve }
}

/** A surface guardroom and a connected four-cell basement share a real stairwell. */
function detentionBlock() {
  const root = new THREE.Group()
  root.name = 'Detention block and underground cells'
  const shell = new Draft('Detention masonry and stairwell')
  const h = DETENTION_STAIR_HOLE
  // Four slabs leave the same opening as the compound ground and annex apron.
  for (const [x0, x1, z0, z1] of [[108, h.minX, -29, -5], [h.maxX, 126, -29, -5],
    [h.minX, h.maxX, -29, h.minZ], [h.minX, h.maxX, h.maxZ, -5]]) {
    shell.box(x1 - x0, FLOOR, z1 - z0, (x0 + x1) / 2, FLOOR / 2, (z0 + z1) / 2, 'concrete', 'detail')
  }
  shell.box(18.3, 0.2, 24.3, 117, -4.3, -17, 'concrete', 'detail')
  for (const x of [108, 126]) shell.box(WALL_THICKNESS, 8.2, 24, x, -0.1, -17, 'paper', 'detail')
  shell.box(18, 8.2, WALL_THICKNESS, 117, -0.1, -29, 'paper', 'detail')
  shell.box(18, 4.2, WALL_THICKNESS, 117, -2.1, -5, 'paper', 'detail')
  for (const x of [111.625, 122.375]) shell.box(7.25, 3.88, WALL_THICKNESS, x, 2.06, -5, 'paper', 'detail')
  shell.box(3.5, 1.05, WALL_THICKNESS, 117, 3.475, -5, 'paper', 'detail')
  shell.box(18.4, 0.2, 24.4, 117, 4.1, -17, 'roof', 'detail')
  // These walls continue below grade, so their geometric bottom edges are buried.
  // Draw the above-ground footprint on the visible wall faces as well.
  const outside = WALL_THICKNESS / 2 + 0.004
  for (const side of [-1, 1]) {
    const x = 117 + side * (9 + outside)
    shell.line([[x, FLOOR + 0.004, -29 - outside], [x, FLOOR + 0.004, -5 + outside]])
  }
  shell.line([[108 - outside, FLOOR + 0.004, -29 - outside], [126 + outside, FLOOR + 0.004, -29 - outside]])
  for (const [left, right] of [[108 - outside, 115.25], [118.75, 126 + outside]]) {
    shell.line([[left, FLOOR + 0.004, -5 + outside], [right, FLOOR + 0.004, -5 + outside]])
  }
  interiorRoomOutline(shell, 18 - WALL_THICKNESS, 24 - WALL_THICKNESS, FLOOR, 4, 117, -17)
  interiorRoomOutline(shell, 18 - WALL_THICKNESS, 24 - WALL_THICKNESS, -4.2, 0, 117, -17)
  // The basement-height walls have no geometric edge at the upper floor.
  // Trace the interior floor junction, inset to match the room's corner ink.
  const inside = WALL_THICKNESS / 2 + 0.006, floorInk = FLOOR + 0.006
  shell.line([[108 + inside, floorInk, -5 - inside], [108 + inside, floorInk, -29 + inside],
    [126 - inside, floorInk, -29 + inside], [126 - inside, floorInk, -5 - inside]])
  // Side walls keep the upper guardroom separate from the stair opening.
  for (const x of [115.3, 118.7]) shell.box(0.14, 1.05, 11.1, x, 0.645, -14.55, 'roof', 'detail')
  for (let i = 0; i < 18; i++) {
    const height = (i + 1) * 0.24
    shell.box(3.2, height, 0.6, 117, -4.2 + height / 2, -19.5 + i * 0.6, 'concrete', 'detail')
  }
  root.add(shell.finish())
  const entrance = createDoor({ name: 'Detention entrance', x: 117, z: -4.96,
    floor: FLOOR, width: 3.5, height: 2.8, open: true, exit: true })
  root.add(entrance)
  const cells = new Draft('Holding cells bars, partitions and bunks')
  for (const x of [110.5, 123.5]) {
    cells.box(5, 3.4, 0.16, x, -2.5, -23.5, 'paper', 'detail')
    cells.box(5, 3.4, 0.16, x, -2.5, -18.5, 'paper', 'detail')
    for (const z of [-21, -26]) {
      cells.box(1.05, 0.2, 2.2, x + (x < 117 ? -1.25 : 1.25), -3.6, z, 'roof', 'detail')
      cells.box(1, 0.12, 0.45, x + (x < 117 ? -1.25 : 1.25), -3.44, z - 0.65, 'paper', 'detail')
    }
  }
  const cellDoors: THREE.Group[] = []
  for (let index = 0; index < 4; index++) {
    const left = index % 2 === 0, x = left ? 113 : 121, z = index < 2 ? -21 : -26
    // Solid wall strips enclose each broad door opening; bars are visual accents.
    for (const dz of [-1.825, 1.825]) cells.box(0.16, 3.4, 1.35, x, -2.5, z + dz, 'paper', 'detail')
    cells.box(0.16, 0.7, 2.3, x, -1.15, z, 'concrete', 'detail')
    const door = createDoor({ name: `Cell ${index + 1} locked door`, x, z, floor: -4.2,
      width: 2.3, height: 2.7, angle: left ? Math.PI / 2 : -Math.PI / 2, industrial: true, barred: true })
    door.userData.missionLocked = true
    door.userData.hostageId = `hostage-${index + 1}`
    if (index === 0) cellDoors.push(door)
    root.add(door, wallText(`CELL 0${index + 1}`, [x + (left ? 0.086 : -0.086), -1.15, z], 0.4,
      left ? Math.PI / 2 : -Math.PI / 2))
  }
  root.add(cells.finish())
  const chair = new Draft('Hostage chair')
  chair.userData = { noCollision: true, kind: 'hostage-chair' }
  // The seated skin reaches 0.336 m, below the 0.449 m hip joint. Support the
  // visible body at 0.3325 m instead of letting the seat cut through the pelvis.
  chair.box(0.48, 0.065, 0.46, 0, 0.3, -0.371, 'concrete', 'detail')
  for (const x of [-0.205, 0.205]) for (const z of [-0.56, -0.18]) {
    chair.beam([x, 0.025, z], [x, 0.3, z], 0.045, 'roof', 'detail')
  }
  for (const x of [-0.205, 0.205]) chair.beam([x, 0.31, -0.56], [x, 0.92, -0.59], 0.04, 'roof', 'detail')
  chair.box(0.47, 0.25, 0.05, 0, 0.78, -0.58, 'concrete', 'detail')
  chair.rotation.y = Math.PI / 2
  chair.position.set(...RESCUE_LAYOUT.hostageSpawns[0])
  root.add(chair.finish())
  root.add(wallText('DETENTION', [117, 3.45, -5 + WALL_THICKNESS / 2 + 0.006]))
  const accents = new Draft('Stairwell guidance stripe')
  accents.userData.noCollision = true
  for (const x of [115.48, 118.52]) accents.beam([x, -3.05, -19.8], [x, 1.27, -9], 0.07, 'green', 'detail')
  root.add(accents.finish())
  // The guardroom above the cells is furnished around its walls, leaving the aisle from the stairs to the door,
  // the entrance guard's beat (x 117-121) and the watch post by the west window (x 111-112.5) clear.
  const guardroom = new Furnishing('Detention guardroom')
  // West: the duty desk facing the door, lockers and the supply shelf along the wall.
  guardroom.desk(110.3, -10.6, FLOOR, Math.PI)
  guardroom.chair(110.3, -11.55, FLOOR)
  guardroom.lockers(108.4, -14.6, FLOOR, 4, Math.PI / 2)
  guardroom.shelf(108.6, -19.2, FLOOR, Math.PI / 2)
  // Back: a briefing table with its chairs, under the operations map.
  guardroom.table(111.9, -24.4, FLOOR, 3)
  for (const x of [110.9, 112.9]) { guardroom.chair(x, -25.6, FLOOR); guardroom.chair(x, -23.2, FLOOR, Math.PI) }
  guardroom.wallMap(111.9, -28.88, FLOOR)
  // East: two bunks for the night shift, a records desk, stacked supplies and lockers by the door.
  guardroom.bunk(125.3, -26.7, FLOOR)
  guardroom.bunk(125.3, -24.0, FLOOR)
  guardroom.desk(124.9, -14.2, FLOOR, -Math.PI / 2)
  guardroom.chair(123.95, -14.2, FLOOR, Math.PI / 2)
  guardroom.pallet(124.8, -18.7, FLOOR, true)
  guardroom.pallet(123.2, -20.6, FLOOR)
  guardroom.lockers(125.62, -9.4, FLOOR, 3, -Math.PI / 2)
  root.add(guardroom.finish())
  // The cell block's front half, either side of the stairs, holds the jailers' kit: an interrogation table,
  // a filing desk and lockers to the west; stores, a workbench and stacked supplies to the east. The corridor
  // between the cells (x 113-121) and the foot of the stairs stay clear for the escort.
  const cellBlock = new Furnishing('Detention cell block')
  const low = -4.2
  cellBlock.table(111.4, -12.6, low, 2.2)
  cellBlock.chair(111.4, -13.9, low)
  cellBlock.chair(111.4, -11.3, low, Math.PI)
  cellBlock.lockers(108.4, -8.2, low, 3, Math.PI / 2)
  cellBlock.desk(110.6, -16.9, low, Math.PI)
  cellBlock.chair(110.6, -16.0, low, Math.PI)
  cellBlock.wallMap(111.4, -5.12, low)
  cellBlock.shelf(125.6, -8.3, low, -Math.PI / 2)
  cellBlock.shelf(125.6, -12.9, low, -Math.PI / 2)
  cellBlock.workbench(122.8, -16.9, low)
  cellBlock.pallet(121.4, -9.6, low, true)
  cellBlock.pallet(121.4, -12.8, low)
  root.add(cellBlock.finish())
  // Caged work lamps hang in the cell block: down the corridor, and one over the hostage's cell.
  root.add(cageLamp('Cell corridor north', [117, -0.05, -22.5]), cageLamp('Cell corridor south', [117, -0.05, -26.8]),
    cageLamp('Hostage cell', [RESCUE_LAYOUT.hostageSpawns[0][0], -0.05, RESCUE_LAYOUT.hostageSpawns[0][2]], LAMP_AMBER, 0.6),
    cageLamp('Interrogation table', [111.4, -0.05, -12.6], LAMP_AMBER, 0.9), cageLamp('Cell block stores', [122.6, -0.05, -12.4], LAMP_AMBER, 0.7))
  const stairMetadata = new THREE.Group()
  stairMetadata.name = 'Detention stairs camera support'
  stairMetadata.userData = { kind: 'stairs', bottom: [117, -4.2, -19.8], top: [117, 0.12, -9], width: 3.2 }
  root.add(stairMetadata)
  // The hostage is held here, so it keeps its EXIT sign and has its own lamps.
  root.userData = { kind: 'detention', footprint: [18, 24], floor: FLOOR, floors: [-4.2, FLOOR], enterable: true, missionSite: true }
  // The cell block is dark: the caged lamps light it, and daylight falls down the stairwell from the floor above.
  root.add(darkRoom('Detention cell block', [117, (-4.5 + 0.06) / 2, -17], [9, (0.06 + 4.5) / 2, 12]),
    daylightOpening('Detention stairwell', [117, 0.06, (h.minZ + h.maxZ) / 2], [0, -1, 0], [0, 0, 1], h.maxZ - h.minZ))
  // The guardroom above is dark too, like every building: daylight through the open entrance, and caged lamps over
  // the duty desk, the briefing table and the night-shift bunks. Its box takes in the walls, up to the roof slab.
  root.add(darkRoom('Detention guardroom', [117, (FLOOR - 0.3 + 4.1) / 2, -17], [9.02, (4.1 - FLOOR + 0.3) / 2, 12.02], { ambient: 0.035 }),
    cageLamp('Guardroom duty desk', [111, 4.0, -12], LAMP_AMBER, 0.6, { bounce: 0.12 }),
    cageLamp('Guardroom briefing table', [111.9, 4.0, -24.4], LAMP_AMBER, 0.6, { bounce: 0.12 }),
    cageLamp('Guardroom bunks', [122.8, 4.0, -22], LAMP_AMBER, 0.6, { bounce: 0.12 }))
  doorwayLight(entrance, -1, { bounce: 0.12 })
  for (const child of root.children) { child.position.x -= 117; child.position.z += 17 }
  root.position.set(117, 0, -17)
  return { root, cellDoors }
}


function securityCameras() {
  return RESCUE_LAYOUT.cameras.map(spec => {
    const root = new THREE.Group()
    root.name = spec.id
    root.position.set(...spec.position)
    root.userData.noCollision = true
    const mount = new Draft(`${spec.id} mount`)
    if (spec.wallMount) {
      const anchor = new THREE.Vector3(...spec.wallMount).sub(root.position)
      mount.box(0.15, 0.4, 0.24, anchor.x, anchor.y, anchor.z, 'roof', 'detail')
      mount.beam(anchor.toArray(), [0, -0.24, 0], 0.09, 'paper', 'detail')
      mount.box(0.09, 0.24, 0.09, 0, -0.12, 0, 'paper', 'detail')
    } else mount.box(0.12, spec.position[1], 0.12, 0, -spec.position[1] / 2, 0, 'roof', 'detail')
    const pivot = new THREE.Group()
    pivot.rotation.y = spec.yaw
    const casing = new Draft(`${spec.id} housing`)
    casing.box(0.4, 0.3, 0.7, 0, 0, 0.25, 'roof', 'detail')
    casing.box(0.24, 0.2, 0.04, 0, 0, 0.62, 'concrete', 'detail')
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: CAMERA_LIGHTS.watching, toneMapped: false }))
    lamp.name = `${spec.id} status light`
    lamp.position.set(0.15, -0.065, 0.65)
    pivot.add(casing.finish(), lamp)
    root.add(mount.finish(), pivot)
    return { id: spec.id, root, pivot, lamp }
  })
}

export function createMissionWorld(compound?: THREE.Group): MissionWorld {
  const root = new THREE.Group()
  root.name = 'Hostage rescue · detention annex'
  root.userData.kind = 'mission-world'
  const bounds = { minX: -108, maxX: 183, minZ: -76, maxZ: 78 }
  // The landscape stays open; runtime bounds still recover a player who leaves the map.
  root.add(fence('East annex north perimeter', [[99, -37.5], [99, -57], [164, -57], [164, 7]], 3.1))
  root.add(fence('East annex south perimeter', [[164, 15], [164, 18], [99, 18]], 3.1))
  const exitGate = createFenceGate({ name: 'Secure compound exit gate', x: 164, z: 11,
    width: 8, height: 3.1, angle: Math.PI / 2 })
  exitGate.userData.missionLocked = true
  exitGate.userData.swingSeconds = 3
  root.add(exitGate)
  // A gantry over the way out carries its EXIT sign, high enough for the jeep to pass under.
  const gantry = new Draft('Secure compound exit gate · sign gantry', 164, 11, Math.PI / 2)
  for (const side of [-1, 1]) gantry.box(0.2, 1.5, 0.2, side * 4, 3.3 + 0.75, 0, 'paper', 'detail')
  gantry.box(8.4, 0.36, 0.22, 0, 4.4, 0, 'paper', 'detail')
  root.add(gantry.finish())
  exitGate.userData.exit = { capHeight: 0.6, lift: 4.4 - 3.1, always: true }

  const apron = new Draft('East rail annex · concrete aprons')
  const h = DETENTION_STAIR_HOLE
  for (const [x0, x1, z0, z1] of [[99.5, h.minX, -55, 17], [h.maxX, 163.5, -55, 17],
    [h.minX, h.maxX, -55, h.minZ], [h.minX, h.maxX, h.maxZ, 17]]) {
    apron.box(x1 - x0, 0.045, z1 - z0, (x0 + x1) / 2, 0.02, (z0 + z1) / 2, 'concrete', false)
  }
  for (const x of [102, 136, 160]) apron.line([[x, 0.05, -54], [x, 0.05, 15]], 'mesh')
  apron.box(19, 0.045, 8, 173, 0.02, 11, 'concrete', false)
  root.add(apron.finish())
  for (const spec of [
    { name: 'Security cabin', x: 146, z: -45, width: 10, depth: 9, role: 'dispatch' },
    { name: 'Crew house', x: 143, z: 3, width: 14, depth: 10, role: 'crew' },
    { name: 'Maintenance shelter', x: 111, z: -45, width: 12, depth: 10, role: 'maintenance' },
  ] satisfies HouseSpec[]) root.add(house(spec))
  const detention = detentionBlock(), jeep = createRescueJeep(), cameras = securityCameras()
  root.add(detention.root, jeep, ...cameras.map(camera => camera.root))

  // Continue the existing spur beyond X=117; no duplicate raised loading platform.
  const track = new Draft('Annex siding · track and buffer')
  track.box(42, 0.1, 4.6, 138, 0.08, -32.4, 'concrete', 'detail')
  for (let x = 117.4; x < 158; x += 0.92) track.box(0.24, 0.15, 2.6, x, 0.205, -32.4, 'paper', 'detail')
  for (const side of [-1, 1]) {
    const z = -32.4 + side * 1.435 / 2
    track.box(42, 0.045, 0.18, 138, 0.3, z, 'paper', 'detail')
    track.box(42, 0.15, 0.055, 138, 0.38, z, 'paper', false)
    track.box(42, 0.065, 0.09, 138, 0.47, z, 'paper', 'detail')
    track.beam([157.8, 0.3, z], [159, 1.6, z], 0.15)
  }
  track.box(0.28, 0.55, 3.2, 159, 1.6, -32.4, 'roof')
  root.add(track.finish())
  const wagon = new Draft('Secured munitions wagon')
  wagon.box(10.5, 0.35, 2.65, 130, 1.1, -32.4, 'concrete', 'detail')
  wagon.box(10.2, 1.5, 2.55, 130, 2.0, -32.4, 'roof')
  for (const x of [126.4, 133.6]) for (const z of [-33.48, -31.32]) {
    wagon.solid(new THREE.CylinderGeometry(0.48, 0.48, 0.18, 20), [x, 0.75, z], 'concrete', 'detail', [Math.PI / 2, 0, 0])
  }
  for (let x = 125.4; x < 135; x += 1.6) wagon.line([[x, 1.32, -31.1], [x, 2.73, -31.1]], 'mesh')
  root.add(wagon.finish())

  const cover = new Draft('Annex cover · freight and service baffles')
  crates(cover, 123, -38.3, 2)
  crates(cover, 129, 6, 3)
  cover.box(4, 1.4, 0.6, 158, 0.7, -12, 'concrete', 'detail')
  groundOutline(cover, 158, -12, 4, 0.6)
  // New gate connects to the original raised loading platform through real steps.
  steps(cover, 57, -23.99, 2.4, 1.05, 5)
  crates(cover, 52, -15, 3)
  root.add(cover.finish())

  const stations = [
    ...detention.cellDoors.map(createCellLock),
    control('cameras', 'security-computer', 'Disable cameras', [149, FLOOR, -45.8], -Math.PI / 2),
    control('alarm', 'detention-alarm', 'Turn off alarm', [125.4, 0, -4.5]),
    control('gate', 'exit-gate-control', 'Open gate', [160.5, 0, 6.3], -Math.PI / 2),
    { id: 'rescue-jeep', kind: 'jeep', object: jeep,
      point: new THREE.Vector3(154.65, 1.05, 9.95), label: 'Board jeep' } satisfies Station,
    control('supply', 'maintenance-supplies', 'Take field supplies', [114.7, FLOOR, -45.5], -Math.PI / 2),
    control('distraction', 'service-bell', 'Ring service bell', [-39, 0, 3]),
  ]
  stations.forEach(station => { if (!station.object.parent) root.add(station.object) })
  // Register the existing office monitor without moving it out of its workstation.
  compound?.updateMatrixWorld(true)
  compound?.traverse(object => {
    if (!object.userData.cameraTerminal) return
    const point = object.localToWorld(new THREE.Vector3(...object.userData.interactionPoint as Vec3))
    stations.push({ id: SIGNALS_COMPUTER_ID, kind: 'cameras', object, point, label: 'Disable cameras' })
  })
  // Every enemy field radio can be switched off at its front panel, or shot apart (game/radios.ts). It collides
  // dynamically so a destroyed one can leave the collision world.
  compound?.traverse(object => {
    if (object.userData.questItem !== 'radio') return
    object.userData.dynamicCollision = true
    stations.push({ id: object.name, kind: 'radio', object, point: object.localToWorld(new THREE.Vector3(0, 0.2, 0.3)), label: 'Switch off radio' })
  })

  // The mess hall is west of the tank, so this post must use the west catwalk
  // to watch the dining building without the tank blocking its own sightline.
  const waterSniperPost: Vec3 = [7.25, 12.615, -34.05]
  // Adjacent points follow the middle of the catwalk, clear of both tank and rail.
  const waterSniperPatrol: Vec3[] = Array.from({ length: 16 }, (_, i) => {
    const angle = Math.PI + i / 16 * Math.PI * 2
    return [10.95 + Math.cos(angle) * 3.7, waterSniperPost[1], -34.05 + Math.sin(angle) * 3.7]
  })
  const messHallCenter: PlanPoint = [-34.2, -46.65]
  const enemies = [
    enemy('yard-patrol', 'Mess-yard patrol', [[-34, 0, -29], [-23, 0, -29], [-23, 0, -21], [-42, 0, -21]]),
    enemy('west-patrol', 'Service-yard patrol', [[-50, 0, -17], [-40, 0, -17], [-40, 0, -4], [-50, 0, -4]], 'smg'),
    enemy('tower-patrol-a', 'Water-tower patrol', [[1, 0, -43], [21, 0, -43], [21, 0, -25], [1, 0, -25]]),
    enemy('tower-patrol-b', 'Water-tower rear guard', [[21, 0, -25], [1, 0, -25], [1, 0, -43], [21, 0, -43]]),
    enemy('inner-gate', 'Inner-gate sentry', [[-16, 0, 18], [-20, 0, 18], [-20, 0, 22], [-16, 0, 22]], 'smg'),
    enemy('loading-patrol', 'Loading-court patrol', [[20, 0, 8], [40, 0, 8], [40, 0, 16], [20, 0, 16]]),
    enemy('workshop-patrol', 'East-workshop guard', [[76, 0, 13], [89, 0, 13], [89, 0, 3], [76, 0, 3]], 'smg'),
    enemy('rail-patrol', 'Siding sentry', [[125, 0, -36.8], [138, 0, -36.8], [156, 0, -36.8], [156, 0, -53], [136, 0, -53]]),
    enemy('relay-patrol', 'Detention entrance guard', [[121, 0.12, -7], [121, 0.12, -9],
      [121, 0.12, -7], [117, 0.12, -7], [117, 0, -2], [117, 0.12, -7]], 'smg'),
    enemy('crew-patrol', 'Crew-house patrol', [[143, FLOOR, 3], [143, FLOOR, 7.5], [143, 0, 11],
      [132, 0, 11], [132, 0, -5], [143, 0, -5], [143, FLOOR, -1.5]], 'smg'),
    enemy('dispatch-guard', 'Dispatch watch', [[146, FLOOR, -45], [146, FLOOR, -41], [146, 0, -38],
      [146, FLOOR, -41]], 'pistol'),
    enemy('maintenance-guard', 'Maintenance watch', [[111, FLOOR, -45], [111, FLOOR, -41], [111, 0, -38],
      [111, FLOOR, -41]], 'pistol'),
    enemy('north-yard-relief', 'North-yard relief patrol', [[-20, 0, -29], [-10, 0, -29], [-10, 0, -28], [-20, 0, -28]], 'smg'),
    enemy('west-relief', 'West service relief', [[-50, 0, -28], [-50, 0, -20], [-45, 0, -20], [-45, 0, -28]], 'pistol'),
    enemy('loading-relief', 'Loading-lane relief', [[44, 0, 16], [54, 0, 16], [54, 0, 13], [44, 0, 13]]),
    enemy('annex-gate-patrol', 'Annex gate patrol', [[104, 0, 11], [110, 0, 5], [117, 0, -2], [110, 0, 5]], 'smg'),
    enemy('relay-perimeter', 'Detention perimeter patrol', [[128, 0, -9], [128, 0, -24], [136, 0, -24], [136, 0, -9]]),
    enemy('dispatch-perimeter', 'Dispatch perimeter patrol', [[156, 0, -53], [136, 0, -53]], 'ak'),
    // Occupied rooms reward checking corners. Short interior routes stay off the
    // entry aisles, roof stairs, office furniture and the reserve muster points.
    enemy('mess-kitchen', 'Mess kitchen watch', [[-34.2, 0.28, -56.4], [-32.9, 0.28, -56.4]], 'pistol'),
    // One AK lookout on the mess-hall roof faces out over the yard (south, +Z), his back to the
    // ladder and the stair door: the opening knife approach.
    { ...enemy('roof-lookout', 'Roof lookout', [[-34.2, 6.38, -38.6]]), facing: 0 },
    enemy('mess-east-aisle', 'Mess east-aisle guard', [[-29, 0.28, -42.15], [-29, 0.28, -39.65]], 'smg'),
    enemy('mess-vestibule', 'Vestibule duty guard', [[-22.6, 0.28, -54.95], [-21.4, 0.28, -54.95]], 'pistol'),
    enemy('relay-backroom', 'Detention corridor guard', [[117, -4.2, -26], [117, -4.2, -21]], 'pistol'),
    enemy('relay-equipment', 'Detention guardroom watch', [[111, FLOOR, -7], [112.5, FLOOR, -7]], 'smg'),
    enemy('crew-north-room', 'Crew north-room guard', [[140, FLOOR, -0.2], [141.1, FLOOR, -0.2]], 'pistol'),
    enemy('crew-south-room', 'Crew south-room guard', [[146, FLOOR, 7], [144.9, FLOOR, 7]], 'smg'),
    enemy('dispatch-records', 'Dispatch records guard', [[143.7, FLOOR, -47.6], [145, FLOOR, -47.6]], 'smg'),
    enemy('maintenance-stores', 'Maintenance stores guard', [[109, FLOOR, -48], [110.3, FLOOR, -48]], 'pistol'),
    enemy('barracks-a-room', 'Barracks A room patrol', [[11.6, 0.28, 36.75], [11.6, 0.28, 38.75]], 'smg'),
    enemy('barracks-b-room', 'Barracks B room patrol', [[55.9, 0.28, 38.95], [55.9, 0.28, 37.95]], 'pistol'),
    enemy('warehouse-west-aisle', 'Warehouse west-aisle guard', [[10.5, 0.65, -6.6], [13.5, 0.65, -6.6]]),
    enemy('warehouse-east-aisle', 'Warehouse east-aisle guard', [[40, 0.65, -6.6], [43, 0.65, -6.6]], 'smg'),
    enemy('administration-room', 'Administration records watch', [[-25.15, 0.28, 29.7], [-23.15, 0.28, 29.7]], 'pistol'),
    enemy('medical-room', 'Medical hut watch', [[86.25, 0.28, 39.15], [88.25, 0.28, 39.15]], 'pistol'),
    enemy('southwest-stores-room', 'Southwest stores guard', [[-58.05, 0.65, 64.5], [-55.55, 0.65, 64.5]], 'smg'),
    enemy('gatehouse-room', 'Gatehouse radio watch', [[-5.15, 0.28, 24.75], [-5.15, 0.28, 26.05]], 'pistol'),
    // The source map has one water tower and one observation tower. Use both
    // existing supported decks; marksmen never navigate to ground targets.
    { ...enemy('water-sniper', 'Water-tower marksman', waterSniperPatrol, 'sniper'), role: 'sniper' as const, patrolMode: 'perimeter' as const,
      facing: Math.atan2(messHallCenter[0] - waterSniperPost[0], messHallCenter[1] - waterSniperPost[2]) },
    { ...enemy('watch-sniper', 'Observation-tower marksman', [[OBSERVATION_TOWER_POSITION[0] + 2.2, 6.735,
      OBSERVATION_TOWER_POSITION[1] - 1.25]], 'sniper'), role: 'sniper' as const, facing: Math.PI * 0.75 },
    ...([[140, FLOOR, 1.3], [146, FLOOR, 1.3], [140, FLOOR, 5], [146, FLOOR, 5]] as Vec3[]).map((position, index) =>
      ({ ...enemy(`reserve-${index + 1}`, `Barracks response ${index + 1}`, [position, [143, FLOOR, 3],
        [143, FLOOR, -1.5], [143, 0, -5], [151, 0, -8], [151, 0, -22],
        [154, 0, -35], [146, 0, -37], [146, FLOOR, -42]], 'ak', true), alarmExit: [143, 0, -5] as Vec3 })),
  ]
  root.updateMatrixWorld(true)
  return { level: 'compound', root, stations, enemies, spawn: [-40, 0.15, -62.3], lookAt: [-49, 1.7, -61], bounds, zones: COMPOUND_DISTRICTS,
    briefing: {
      title: 'The rescue', premise: 'Find the hostage. Get out together.', won: 'Hostage safe.', outro: 'You both made it out.',
      map: compoundMap(stations), legend: ['— Rail route', '┄ Service route', '▲ You'],
      tips: [
        'Take the mess-hall roof to the rail line, or the west service gate to the covered lanes.',
        'Each camera terminal shuts down its own cameras for good: the office terminal the west camera, the security computer the east ones. Open the exit gate before the rescue.',
        'The jeep is southeast of detention. If the hostage falls behind, return to him and lead him onward. Alarms bring reinforcements; you don’t need to fight everyone.',
      ],
    },
    rescue: { gate: exitGate, jeep, cameras, cellDoors: detention.cellDoors } }
}
