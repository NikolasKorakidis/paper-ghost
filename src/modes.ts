import { views, type ViewName } from './camera'
import { FIRST_LEVEL, TRAINING_LEVEL, isLevelId, type LevelId } from './levels/catalog'

/**
 * What the page is running. The address never changes: the menu switches modes in place. 'mission' is the first
 * campaign level and 'tutorial' the training ground; `level:<id>` is any level in levels/catalog.ts.
 */
export type Mode = 'mission' | 'tutorial' | 'explore' | 'load' | `view:${string}` | `level:${string}`

/** The level a mode plays: free roam, Load game and the map views are on the first campaign level, unless a view names another. */
export function levelOf(mode: Mode): LevelId {
  if (mode === 'tutorial') return TRAINING_LEVEL
  if (mode.startsWith('level:')) { const id = mode.slice(6); return isLevelId(id) ? id : FIRST_LEVEL }
  // A map view of another level: `view:<view>@<level>`.
  if (mode.startsWith('view:') && mode.includes('@')) { const id = mode.split('@')[1]; return isLevelId(id) ? id : FIRST_LEVEL }
  return FIRST_LEVEL
}
/** The camera bookmark a map-view mode shows (without its level). */
export const viewOf = (mode: Mode): ViewName | null => mode.startsWith('view:') ? mode.slice(5).split('@')[0] as ViewName : null
/** Modes that play a level with its mission, and can switch into each other in place. */
export const playsLevel = (mode: Mode) => mode === 'mission' || mode === 'tutorial' || mode.startsWith('level:')

const KEY = 'stickman-next-mode'
const MODE_PARAMS = ['tutorial', 'explore', 'view', 'load', 'level']

/**
 * The mode to start in. Old links and developer bookmarks (?tutorial=1, ?explore=1, ?view=yard, ?load=1, and
 * ?level=<id> for any level, developer levels included) still work, and are then cleared from the address bar; otherwise a mode the menu asked for before reloading the page;
 * otherwise the game. A refresh always comes back to the game's menu.
 */
export function startMode(): Mode {
  const params = new URLSearchParams(location.search)
  const view = params.get('view')
  const level = params.get('level')
  const fromUrl: Mode | null = level && isLevelId(level) ? `level:${level}` : params.get('tutorial') === '1' ? 'tutorial' : params.get('explore') === '1' ? 'explore'
    : view && view in views ? `view:${view as ViewName}` : params.get('load') === '1' ? 'load' : null
  if (fromUrl) {
    for (const name of MODE_PARAMS) params.delete(name)
    const search = params.toString()
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`)
    return fromUrl
  }
  try {
    const next = sessionStorage.getItem(KEY) as Mode | null
    sessionStorage.removeItem(KEY)
    if (next) return next
  } catch { /* storage blocked: start the game */ }
  return 'mission'
}

/** Set by main.ts: switch to `mode` without leaving the page, returning false when it needs a fresh page. */
let switchInPlace: ((mode: Mode) => boolean) | null = null
export function onModeSwitch(handler: (mode: Mode) => boolean) { switchInPlace = handler }

/** Go to another mode, staying on this address: in place when possible, otherwise by reloading it. */
export function goTo(mode: Mode) {
  if (switchInPlace?.(mode)) return
  try { sessionStorage.setItem(KEY, mode) } catch { /* the reload then starts the game */ }
  location.replace(location.pathname)
}
