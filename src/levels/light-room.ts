import * as THREE from 'three'
import { Draft, wallText } from '../render/ink'
import { neonSign } from '../render/neon-sign'
import { WALL_THICKNESS } from '../world/architecture'
import { createDoor } from '../world/doors'
import { Furnishing } from '../world/interiors'
import { cageLamp, darkRoom, doorwayLight, LAMP_AMBER, screenLight, windowRow } from '../world/lights'
import { wall } from '../world/messHall'
import { enemy } from '../game/enemy-types'
import type { MissionWorld, Vec3 } from '../game/types'

/**
 * The light room: a developer level for working on the lighting (Gallery → Dev mode). One dark room with four kinds of
 * light, each one switchable (game/light-lab.ts: keys 7, 8, 9, 0), and things to light and shadow:
 *
 *   7  the lamp      a caged ceiling lamp in the middle
 *   8  the windows   two panes in the north wall, a bookcase between them (light must come only through the glass)
 *   9  the neon      a blue TEST sign on the west wall
 *   0  the screen    a monitor on the south desk, green
 *
 * Plus the daylight through the east door while it is open. Inside: a table and chairs, a pillar, crates, lockers,
 * a bookcase and a practice dummy, to cast shadows of every size. No guards, and nothing to win.
 *
 * In metres: the room is 12 × 9, 3.4 m high, its middle at the origin; north is -Z; the door is in the east wall.
 */
export const LIGHT_ROOM = { width: 12, depth: 9, height: 3.4, floor: 0.2, door: 1.5 }
/** The names the light lab switches by (each light's object name starts with one). */
export const LIGHT_ROOM_SOURCES = [
  { key: '7', id: 'lamp', label: 'Lamp', name: 'Light room · ceiling lamp' },
  { key: '8', id: 'windows', label: 'Windows', name: 'Light room · north windows' },
  { key: '9', id: 'neon', label: 'Neon', name: 'Neon sign · TEST' },
  { key: '0', id: 'screen', label: 'Screen', name: 'Light room · monitor' },
] as const

export function createLightRoom(): { ground: THREE.Group; world: MissionWorld } {
  const { width, depth, height, floor, door } = LIGHT_ROOM
  const halfW = width / 2, halfD = depth / 2
  const ground = new THREE.Group()
  ground.name = 'Light room'
  ground.userData = { kind: 'light-room' }

  // Outside: a field to stand on, and paper to the horizon.
  const field = new Draft('Light room · field')
  field.box(48, 0.1, 48, 0, -0.05, 0, 'paper', false)
  ground.add(field.finish())
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  paper.rotation.x = -Math.PI / 2
  paper.position.y = -0.06
  paper.name = 'Unlit paper ground'
  paper.userData.noCollision = true
  ground.add(paper)

  // The room: a building the field map and the checks know, with its floor, walls and ceiling.
  const room = new THREE.Group()
  room.name = 'Light room · building'
  room.userData = { footprint: [width, depth], enterable: true, kind: 'light-room-building', floor }
  const shell = new Draft('Light room · floor and ceiling')
  shell.box(width + WALL_THICKNESS, floor, depth + WALL_THICKNESS, 0, floor / 2, 0, 'concrete', 'detail')
  shell.box(width + 0.3, 0.2, depth + 0.3, 0, floor + height + 0.1, 0, 'roof', 'detail')
  room.add(shell.finish())
  const paneBottom = 1, paneHeight = 1.4, windows = [-3, 1.5], paneWidth = 1.6
  room.add(
    wall('Light room · north wall', width, height, 0, -halfD, floor, 0, windows.map(center => ({ center, width: paneWidth, bottom: paneBottom, height: paneHeight, window: true }))),
    wall('Light room · south wall', width, height, 0, halfD, floor),
    wall('Light room · west wall', depth, height, -halfW, 0, floor, Math.PI / 2),
    wall('Light room · east wall', depth, height, halfW, 0, floor, Math.PI / 2, [{ center: door, width: 1.4, bottom: 0, height: 2.4 }]),
  )
  const entrance = createDoor({ name: 'Light room door', x: halfW, z: door, floor, width: 1.4, height: 2.4, angle: Math.PI / 2 })
  doorwayLight(entrance, -1)
  room.add(entrance)
  room.add(darkRoom('Light room', [0, floor + (height - 0.15) / 2, 0], [halfW + 0.02, (height + 0.15) / 2, halfD + 0.02], { ambient: 0.02 }))

  // The four lights.
  room.add(cageLamp(LIGHT_ROOM_SOURCES[0].name, [0, floor + height, 0.6], LAMP_AMBER, 0.7, { intensity: 6, range: 9 }))
  room.add(windowRow(LIGHT_ROOM_SOURCES[1].name, [0, floor + paneBottom + paneHeight / 2, -halfD], 0, windows, paneWidth, paneHeight))
  // The neon alphabet has the letters of SECURITY and EXIT: TEST is made of them.
  room.add(neonSign('TEST', [-halfW + WALL_THICKNESS / 2, floor + 2.5, -0.8], Math.PI / 2, { capHeight: 0.4 }))
  const monitor = new Draft(LIGHT_ROOM_SOURCES[3].name, 2.6, halfD - 0.55, Math.PI)
  monitor.box(0.3, 0.035, 0.22, 0, floor + 0.89, 0, 'concrete', 'detail')
  monitor.box(0.055, 0.2, 0.06, 0, floor + 1, 0, 'paper', 'detail')
  monitor.box(0.94, 0.57, 0.075, 0, floor + 1.33, -0.03, 'paper', 'detail')
  monitor.add(screenLight(`${LIGHT_ROOM_SOURCES[3].name} · glow`, [0, floor + 1.33, 0.012], 0.82, 0x3dff8a, { intensity: 3, range: 5 }))
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.46),
    Object.assign(new THREE.MeshBasicMaterial({ color: 0x9dffc4 }), { defines: { NEON_UNLIT: '' } }))
  screen.name = 'Light room · monitor screen'
  screen.position.set(0, floor + 1.33, 0.011)
  screen.userData.noCollision = true
  monitor.add(screen)
  room.add(monitor.finish())

  // Things to light: furniture of every height, a pillar, and the bookcase between the windows.
  const furniture = new Furnishing('Light room · furniture')
  furniture.table(-1.6, 0.4, floor, 2.6)
  furniture.chair(-2.6, 1.3, floor, Math.PI)
  furniture.chair(-0.6, 1.3, floor, Math.PI)
  furniture.chair(-1.6, -0.6, floor)
  furniture.bookcase(-0.75, -halfD + 0.3, floor, 0, 1.6)
  furniture.lockers(-halfW + 0.35, 2.6, floor, 3, Math.PI / 2)
  furniture.desk(2.6, halfD - 0.55, floor, Math.PI)
  furniture.crate(3.6, -2.4, floor)
  furniture.crate(4.3, -2.6, floor, 0.4)
  furniture.plant(-halfW + 0.6, -halfD + 0.6, floor, 1.2)
  room.add(furniture.finish())
  const pillar = new Draft('Light room · pillar')
  pillar.box(0.5, height, 0.5, 2, floor + height / 2, 0.4, 'concrete', 'detail')
  room.add(pillar.finish())
  room.add(wallText('LIGHT ROOM', [halfW + WALL_THICKNESS / 2 + 0.01, floor + 2.75, door], 0.22, Math.PI / 2))
  ground.add(room)
  ground.updateMatrixWorld(true)

  const root = new THREE.Group()
  root.name = 'Light room mission'
  const spawn: Vec3 = [halfW - 1.4, floor + 0.05, door + 1.6]
  return {
    ground,
    world: {
      level: 'light-room', root, stations: [], goals: [], spawn, lookAt: [-1, 1.6, 0],
      // A practice dummy, for a person-sized shadow that moves when he is knocked down.
      enemies: [enemy('dummy', 'shadow-dummy', [0.6, floor, -1.6], { facing: Math.PI / 2 })],
      bounds: { minX: -22, maxX: 22, minZ: -22, maxZ: 22 },
      briefing: {
        title: 'Light room', premise: 'Four lights to switch on and off, and things to light.', won: 'Done.', outro: 'Back to the gallery.',
        tips: ['7 lamp · 8 windows · 9 neon · 0 screen: each switches that light on or off.',
          '− shows where each light is seen from and its glowing line; the panel lists which lights have shadows.',
          'The east door lets in daylight while it is open. The bookcase between the windows must stay dark.'],
      },
    },
  }
}
