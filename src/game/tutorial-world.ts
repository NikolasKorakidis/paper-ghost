import * as THREE from 'three'
import { BOSS_RULES } from './balance'
import type { EnemySpec, MissionWorld, Vec3 } from './types'
import { TRAINING } from '../world/training-ground'

/** Practice soldiers on the range: they stand at their posts facing the firing line and get back up 4 s after falling. */
const dummy = (id: string, position: Vec3, facing = 0): EnemySpec =>
  ({ id, name: `Practice soldier ${id.slice(6)}`, position, patrol: [position], weapon: 'pistol', facing, dummy: true, respawn: 4 })
/** Live-fire soldiers: held back until the live-fire lesson, then they hold the yard and shoot back. */
const soldier = (id: string, position: Vec3, weapon: EnemySpec['weapon']): EnemySpec =>
  ({ id, name: `Yard soldier ${id.slice(5)}`, position, patrol: [position], weapon, facing: 0, reserve: true, held: true })

export const TUTORIAL_ENEMIES = {
  dummies: ['dummy-1', 'dummy-2', 'dummy-3', 'dummy-4', 'dummy-5', 'dummy-6'],
  knife: 'dummy-knife',
  /** The grenade yard: three in the frag pit, two behind the flash wall, the spotter on his tower. */
  frag: ['pit-1', 'pit-2', 'pit-3'],
  flash: ['wall-1', 'wall-2'],
  spotter: 'spotter',
  soldiers: ['live-1', 'live-2', 'live-3'],
  boss: 'bulky',
} as const

/** The tutorial: the training ground, its practice soldiers, the live-fire squad and Bulky Boy. */
export function createTutorialWorld(): MissionWorld {
  const root = new THREE.Group()
  root.name = 'Tutorial'
  const enemies: EnemySpec[] = [
    dummy('dummy-1', [-6, 0, -55]), dummy('dummy-2', [0, 0, -58]), dummy('dummy-3', [6, 0, -55]),
    dummy('dummy-4', [-4, 0, -74]), dummy('dummy-5', [4, 0, -77]), dummy('dummy-6', [0, 0, -95]),
    // Standing in the knife booth, his back to the range.
    { ...dummy('dummy-knife', [10.5, 0, -50.4], Math.PI), name: 'Practice soldier (knife)' },
    // The grenade yard. They face the throwing line, so a flash in front of them catches their eyes.
    { ...dummy('pit-1', [-21, 0, -59.4]), name: 'Practice soldier (frag pit)' },
    { ...dummy('pit-2', [-22.7, 0, -61]), name: 'Practice soldier (frag pit)' },
    { ...dummy('pit-3', [-19.3, 0, -61]), name: 'Practice soldier (frag pit)' },
    { ...dummy('wall-1', [-22.6, 0, -73.4]), name: 'Practice soldier (flash wall)' },
    { ...dummy('wall-2', [-19.4, 0, -73.4]), name: 'Practice soldier (flash wall)' },
    { ...dummy('spotter', [-21, TRAINING.spotterHeight, -95]), name: 'Spotter', respawn: 3 },
    soldier('live-1', [-6, 0, -134], 'ak'), soldier('live-2', [5.5, 0, -138], 'smg'), soldier('live-3', [0, 0, -147], 'pistol'),
    { id: 'bulky', name: 'Bulky Boy', position: [0, 0, -205], patrol: [[0, 0, -205]], weapon: 'ak', facing: 0,
      reserve: true, held: true, boss: true, health: BOSS_RULES.health, armor: BOSS_RULES.armor, look: 'bulky' },
  ]
  return { level: 'training', root, stations: [], enemies, spawn: TRAINING.spawn, lookAt: TRAINING.lookAt, bounds: TRAINING.bounds, tutorial: true }
}
