import * as THREE from 'three'
import { Draft, type Point } from '../render/ink'
import type { DarkRoomSpec, NeonLightSpec } from '../render/neon'
import { doorOpenness } from './doors'

/**
 * Scene markers for the lighting in render/neon.ts. Each is an empty object placed in the world; the renderer
 * finds them by their userData. Put them where the light or room really is, as children of what they belong to.
 */

/**
 * A room with no daylight of its own, `half` metres each way from `center`. Put the box's faces on the middle of
 * its walls. `ambient` and `pitch` are as in DarkRoomSpec.
 */
export function darkRoom(name: string, center: Point, half: Point, options: Omit<DarkRoomSpec, 'half'> = {}) {
  const room = new THREE.Object3D()
  room.name = `${name} · darkness`
  room.position.set(...center)
  room.userData.darkRoom = { half, ...options } satisfies DarkRoomSpec
  return room
}

/** A glowing screen `width` metres wide at `center`, shining along its local +Z while `userData.powered`. */
export function screenLight(name: string, center: Point, width: number, color: number, light: { intensity?: number; range?: number } = {}) {
  const screen = new THREE.Object3D()
  screen.name = `${name} · screen light`
  screen.position.set(...center)
  const reach = width * 0.45
  // Set `powered` false to switch the screen's light off.
  screen.userData.powered = true
  screen.userData.neonLight = { start: [-reach, 0, 0.01], end: [reach, 0, 0.01], color, standoff: 0.01, radius: width * 0.25,
    intensity: 2.4, range: 4.5, ...light, dimmer: () => screen.userData.powered ? 1 : 0 } satisfies NeonLightSpec
  return screen
}

/**
 * Daylight falling through a doorway into the room on the door's local -Z side (or +Z with `into = 1`). It is
 * as bright as the door is open, and off while it is shut. Add it to the door.
 */
export function doorwayLight(door: THREE.Group, into: 1 | -1 = -1, light: { intensity?: number; range?: number; bounce?: number } = {}) {
  const opening = new THREE.Object3D()
  opening.name = `${door.name} · daylight`
  const height = door.userData.height as number
  opening.position.set(0, height / 2, 0)
  opening.rotation.y = into < 0 ? Math.PI : 0
  // It is as big as the doorway, and its shadows are seen from a little way into the room.
  const width = (door.userData.width as number | undefined) ?? 1
  opening.userData.neonLight = { start: [0, -height / 2 + 0.15, 0.02], end: [0, height / 2 - 0.15, 0.02], color: 0xffffff,
    standoff: 0.02, radius: width * 0.4, shadowFrom: [0, 0, 0.35],
    intensity: 4.5, range: 9, ...light, dimmer: () => doorOpenness(door) } satisfies NeonLightSpec
  door.add(opening)
  return opening
}

/** Soft, neutral daylight. */
export const DAYLIGHT = 0xf2f5ff

/**
 * Daylight, and sunbeams, through the windows in one wall (up to four). `windows` are the panes' centres along the
 * wall, in metres from `center` (on the wall, at the panes' mid-height), all `width` × `height`; the light shines
 * into the room on its local +Z side (turn it with `angle`). One light serves the whole wall.
 */
export function windowRow(name: string, center: Point, angle: number, windows: number[], width: number, height: number,
  light: { intensity?: number; range?: number; sun?: number } = {}) {
  if (windows.length > 4) throw new Error(`${name}: a window row takes up to four windows`)
  const row = new THREE.Object3D()
  row.name = `${name} · daylight`
  row.position.set(...center)
  row.rotation.y = angle
  const first = Math.min(...windows), last = Math.max(...windows), middle = (first + last) / 2
  // The light's line runs along the panes; its middle is the row's middle.
  row.position.x += Math.cos(angle) * middle
  row.position.z -= Math.sin(angle) * middle
  const reach = (last - first) / 2 + width * 0.4
  // Skylight scales with how much glass there is.
  const area = windows.length * width * height
  // The line sits just inside the room, in front of the wall's inner face (7 cm from its middle). It is as big as
  // a pane is tall, so nothing beside it gets a hot spot. Its shadows are seen from open space in front of the pane
  // nearest the middle; once the room is furnished, placeWindowShadows moves that spot to wherever it sees every
  // open pane (never from inside a shelf, or behind a staircase).
  const offsets = windows.map(offset => offset - middle)
  const nearest = offsets.reduce((best, offset) => Math.abs(offset) < Math.abs(best) ? offset : best)
  row.userData.neonLight = { start: [-reach, 0, 0.1], end: [reach, 0, 0.1], color: DAYLIGHT, standoff: 0.15,
    radius: height / 2, shadowFrom: [nearest, 0, 0.6],
    intensity: 1.1 * area, range: 11, bounce: 0.14, ...light,
    window: { width, height, offsets, sun: light.sun ?? 1.8 } } satisfies NeonLightSpec
  return row
}

/**
 * Daylight falling through any opening, such as a stairwell from the lit floor above: `length` metres of opening
 * centred on `center` and running along `along`, shining toward `facing`. Nothing behind the opening is lit.
 */
export function daylightOpening(name: string, center: Point, facing: Point, along: Point, length: number,
  light: { intensity?: number; range?: number } = {}) {
  const opening = new THREE.Object3D()
  opening.name = `${name} · daylight`
  opening.position.set(...center)
  const z = new THREE.Vector3(...facing).normalize(), x = new THREE.Vector3(...along).normalize()
  opening.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, z.clone().cross(x), z))
  const reach = length * 0.45
  opening.userData.neonLight = { start: [-reach, 0, 0], end: [reach, 0, 0], color: DAYLIGHT, standoff: 0.1, radius: 0.4,
    intensity: 3, range: 8, ...light } satisfies NeonLightSpec
  return opening
}

/** Warm tungsten, for work lamps: the yellow of the prison cell lamps. */
export const LAMP_AMBER = 0xffb24a

/**
 * A caged work lamp hanging `drop` metres on its cord below `position` (on the ceiling): a glowing bulb inside
 * a wire guard, lighting all round it.
 */
export function cageLamp(name: string, position: Point, color = LAMP_AMBER, drop = 0.45,
  light: { intensity?: number; range?: number; bounce?: number; above?: number } = {}) {
  const lamp = new THREE.Group()
  lamp.name = `${name} · lamp`
  lamp.position.set(position[0], position[1] - drop, position[2])
  lamp.userData.noCollision = true
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12),
    Object.assign(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.6) }), { defines: { NEON_UNLIT: '' } }))
  bulb.name = `${name} · bulb`
  const guard = new Draft(`${name} · wire guard`)
  guard.userData.noCollision = true
  guard.box(0.07, 0.05, 0.07, 0, 0.075, 0, 'concrete', 'detail')
  guard.line([[0, 0.1, 0], [0, drop, 0]], 'detail')
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2, x = Math.cos(a) * 0.075, z = Math.sin(a) * 0.075
    guard.line([[x * 0.8, 0.05, z * 0.8], [x, -0.02, z], [x * 0.4, -0.1, z * 0.4], [0, -0.11, 0]], 'detail')
  }
  guard.line(Array.from({ length: 13 }, (_, i): Point => [Math.cos(i / 12 * Math.PI * 2) * 0.075, -0.02, Math.sin(i / 12 * Math.PI * 2) * 0.075]), 'detail')
  // The light points down (its local +Z turned to -Y), with its cut-off plane `above` metres over the bulb (by
  // default 8 cm above where the cord hangs): it lights the ceiling's underside and all round the room below, but
  // nothing on the floor above. Under a pitched roof, pass the height to the ridge so the whole roof is lit.
  const glow = new THREE.Object3D()
  glow.name = `${name} · lamp light`
  glow.rotation.x = Math.PI / 2
  const { above = drop + 0.08, ...rest } = light
  glow.userData.neonLight = { start: [-0.02, 0, 0], end: [0.02, 0, 0], color, standoff: above,
    intensity: 10, range: 7, bounce: 0.05, ...rest } satisfies NeonLightSpec
  lamp.userData.neonFixture = true
  lamp.add(bulb, guard.finish(), glow)
  return lamp
}

/** Is the way from one point to another open? (A ray test against the collision world.) */
export type ClearPath = (from: THREE.Vector3, to: THREE.Vector3) => boolean

/** How deep into the room (m from the middle of the wall) a window's shadows may be seen from: nearest first. */
const SHADOW_DEPTHS = [0.6, 1.1, 1.7]

/**
 * A window row's panes, as seen from its shadow point: those with open space in front of them (`open`, by their
 * offset along the row), and which of those the shadow point cannot see (`hidden`). A pane with something standing
 * right in front of it (a locker against the glass) is dark for a real reason, and is neither.
 */
export function windowPanes(row: THREE.Object3D, clear: ClearPath, from = (row.userData.neonLight as NeonLightSpec).shadowFrom) {
  const spec = row.userData.neonLight as NeonLightSpec
  const middle = (spec.start[0] + spec.end[0]) / 2
  const at = (x: number, z: number) => new THREE.Vector3(middle + x, 0, z).applyMatrix4(row.matrixWorld)
  const origin = from ? new THREE.Vector3(...from).applyMatrix4(row.matrixWorld) : at(0, 0.6)
  const open = spec.window!.offsets.filter(offset => clear(at(offset, 0.12), at(offset, 0.6)))
  return { open, hidden: open.filter(offset => !clear(origin, at(offset, 0.6))) }
}

/**
 * Once the world is built and furnished, put each window row's shadow point where it sees every open pane: in front
 * of one of the panes (or the row's middle), as near the wall as will do. Lighting is seen from that point, so from
 * inside a shelf, or behind a staircase, it would be wrong for every pane it cannot see. Where no one point sees them
 * all (a staircase between two panes), the row is split into rows that each have one: the first keeps the light,
 * the others are added to it as lights of their own, sharing out its brightness by their glass.
 */
export function placeWindowShadows(scene: THREE.Object3D, clear: ClearPath) {
  scene.updateMatrixWorld(true)
  const rows: THREE.Object3D[] = []
  scene.traverse(row => { if ((row.userData.neonLight as NeonLightSpec | undefined)?.window) rows.push(row) })
  for (const row of rows) {
    const spec = row.userData.neonLight as NeonLightSpec
    const window = spec.window!
    const middle = (spec.start[0] + spec.end[0]) / 2
    const at = (x: number, z: number) => new THREE.Vector3(middle + x, 0, z).applyMatrix4(row.matrixWorld)
    const open = new Set(windowPanes(row, clear).open)
    // Each candidate spot, and the open panes it sees.
    const candidates = [0, ...window.offsets].flatMap(x => SHADOW_DEPTHS.map(z => ({ x, z, point: at(x, z) })))
      .filter(({ point }) => !AROUND.every(direction => !clear(point, point.clone().addScaledVector(direction, 0.05))))
      .map(candidate => ({ ...candidate, sees: window.offsets.filter(offset => !open.has(offset) || clear(candidate.point, at(offset, 0.6))) }))
    if (!candidates.length) continue
    // Cover the panes with as few spots as will do, each as near the wall as it can be.
    let left = [...window.offsets]
    const groups: { x: number; z: number; panes: number[] }[] = []
    while (left.length) {
      const pick = candidates.map(candidate => ({ ...candidate, covers: candidate.sees.filter(offset => left.includes(offset)) }))
        .reduce((best, candidate) => candidate.covers.length > best.covers.length ? candidate : best)
      if (!pick.covers.length) { groups.push({ x: left[0], z: SHADOW_DEPTHS[0], panes: left }); break }
      groups.push({ x: pick.x, z: pick.z, panes: pick.covers })
      left = left.filter(offset => !pick.covers.includes(offset))
    }
    const share = (panes: number[]) => panes.length / window.offsets.length
    const [first, ...rest] = groups
    for (const group of rest) {
      // A row of its own, centred on its panes, in the same frame as the row it came from.
      const centre = (Math.min(...group.panes) + Math.max(...group.panes)) / 2
      const reach = (Math.max(...group.panes) - Math.min(...group.panes)) / 2 + window.width * 0.4
      const part = new THREE.Object3D()
      part.name = `${row.name} · panes ${group.panes.map(offset => offset.toFixed(1)).join(' ')}`
      part.position.x = middle + centre
      part.userData.neonLight = { ...spec, intensity: spec.intensity * share(group.panes),
        start: [-reach, spec.start[1], spec.start[2]], end: [reach, spec.end[1], spec.end[2]],
        shadowFrom: [group.x - centre, 0, group.z], window: { ...window, offsets: group.panes.map(offset => offset - centre) } } satisfies NeonLightSpec
      row.add(part)
      part.updateMatrixWorld(true)
    }
    if (rest.length) {
      const centre = (Math.min(...first.panes) + Math.max(...first.panes)) / 2
      const reach = (Math.max(...first.panes) - Math.min(...first.panes)) / 2 + window.width * 0.4
      Object.assign(spec, { intensity: spec.intensity * share(first.panes), start: [middle + centre - reach, spec.start[1], spec.start[2]],
        end: [middle + centre + reach, spec.end[1], spec.end[2]], window: { ...window, offsets: first.panes.map(offset => offset - centre) } })
    }
    // In the row's own frame (the offsets are from its middle).
    spec.shadowFrom = [middle + first.x, 0, first.z]
  }
}

const AROUND = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => new THREE.Vector3(x, y, z))
