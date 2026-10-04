import { buildPistol, buildRevolver, buildSilencedPistol } from './models/handguns'
import { buildKnife } from './models/blades'
import { buildSmg, buildAk, buildBreaker } from './models/automatics'
import { buildShotgun, buildSniper } from './models/long-guns'
import type { Gun, GunName } from './models/common'

export { disposeGun, type Gun, type GunName, type GunClass } from './models/common'

export const builders: Record<GunName, () => Gun> = {
  pistol: buildPistol, revolver: buildRevolver, smg: buildSmg,
  ak: buildAk, shotgun: buildShotgun, sniper: buildSniper, silenced: buildSilencedPistol, knife: buildKnife, breaker: buildBreaker,
}
