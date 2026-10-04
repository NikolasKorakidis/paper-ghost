import type * as THREE from 'three'
import type { MissionWorld } from '../game/types'
import { createCompound } from '../world/compound'
import { createMissionWorld, prepareCompound } from '../game/world'
import { createTrainingGround } from '../world/training-ground'
import { createTutorialWorld } from '../game/tutorial-world'
import { createProvingGround } from './proving-ground'
import { createLightRoom } from './light-room'
import { createTown } from './town'
import type { LevelId } from './catalog'
import { fieldMap } from '../game/field-map'

export * from './catalog'

/**
 * A built level: `ground` is the static world (terrain, buildings, lights; what the player collides with), `world`
 * the mission on it (spawn, enemies, stations, goals). Free roam builds the ground only.
 */
export type BuiltLevel = { ground: THREE.Group; world: MissionWorld | null }
type Builder = (options: { explore: boolean }) => BuiltLevel

const BUILDERS: Record<LevelId, Builder> = {
  compound: ({ explore }) => {
    const ground = createCompound()
    if (explore) return { ground, world: null }
    // The mission world reads the plain compound (building positions, doors) before prepareCompound dresses it.
    const world = createMissionWorld(ground)
    prepareCompound(ground)
    return { ground, world }
  },
  town: ({ explore }) => {
    const level = createTown()
    return { ground: level.ground, world: explore ? null : level.world }
  },
  training: ({ explore }) => ({ ground: createTrainingGround(), world: explore ? null : createTutorialWorld() }),
  'proving-ground': ({ explore }) => {
    const level = createProvingGround()
    return { ground: level.ground, world: explore ? null : level.world }
  },
  'light-room': ({ explore }) => {
    const level = createLightRoom()
    return { ground: level.ground, world: explore ? null : level.world }
  },
}

/** Build a level by id. Every level in the catalog has a builder here. */
export function buildLevel(id: LevelId, options: { explore?: boolean } = {}): BuiltLevel {
  const level = BUILDERS[id]({ explore: !!options.explore })
  // A mission without a map of its own gets one drawn from its buildings, stations and goal areas.
  if (level.world?.briefing && !level.world.briefing.map) level.world.briefing.map = fieldMap(level.ground, level.world)
  return level
}
