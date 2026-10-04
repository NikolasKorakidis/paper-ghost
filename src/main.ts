import * as THREE from 'three'
import { warmUp } from './render/warm-up'
import { EnvironmentCamera, type ViewName } from './camera'
import { levelOf, onModeSwitch, playsLevel, startMode, viewOf, type Mode } from './modes'
import { palette, resizeInk } from './render/ink'
import { EnvironmentInteractions } from './interactions'
import { FirstPersonController } from './player/controller'
import { VRWalkthrough } from './vr/walkthrough'
import { buildLevel, levelInfo } from './levels'
import { MissionRuntime } from './game/runtime'
import { BuildingLabels } from './world/labels'
import { NeonLights } from './render/neon'
import { addExitSigns } from './world/exitSigns'
import { placeWindowShadows } from './world/lights'
import { startLightLab } from './game/light-lab'
import './style.css'
import './game/theme-k7.css'

// Menus show their keyboard outline only once the keyboard is used to move around; the mouse hides it again.
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
addEventListener('keydown', event => { if (NAVIGATION_KEYS.has(event.key)) document.documentElement.dataset.input = 'keys' }, true)
addEventListener('pointermove', () => { delete document.documentElement.dataset.input }, true)

const canvas = document.querySelector<HTMLCanvasElement>('#world')!
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
// A small supersampling floor keeps sub-pixel details clean on non-Retina displays.
// 1.25 is indistinguishable from 1.5 at 100% zoom and shades 31% fewer pixels; 1.0 visibly hardens far strokes.
let resolutionScale = 1
const pixelRatio = () => Math.max(1, Math.min(Math.max(window.devicePixelRatio, 1.25), 2) * resolutionScale)
renderer.setPixelRatio(pixelRatio())
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.NoToneMapping
renderer.setClearColor(palette.paper)
renderer.shadowMap.enabled = false

/**
 * Everything one mode runs on: its world, camera, player and (for the game and the tutorial) its mission. The
 * renderer and the render loop stay; a mode switch disposes the session and boots the next one on the same page.
 */
type Session = {
  mode: Mode; scene: THREE.Scene; camera: EnvironmentCamera; interactions: EnvironmentInteractions; player: FirstPersonController
  vr: VRWalkthrough; mission: MissionRuntime | null; buildingLabels: BuildingLabels; neonLights: NeonLights; startupReady: boolean
  /** The light room's tools, taken away with the session. */
  lab?: () => void
}
const viewer = new THREE.Vector3()

function boot(mode: Mode): Session {
  const scene = new THREE.Scene()
  scene.name = 'Black ballpoint compound'
  scene.background = new THREE.Color(palette.paper)
  const level = levelOf(mode)
  const { ground, world: missionWorld } = buildLevel(level, { explore: mode === 'explore' })
  scene.add(ground)
  if (missionWorld) scene.add(missionWorld.root)
  // Every way out gets a lit EXIT sign; they are real lights like every neon sign.
  addExitSigns(scene)
  // Name tags over each building for the map views; CSS hides them while walking.
  const buildingLabels = new BuildingLabels(scene)
  const camera = new EnvironmentCamera(canvas, invalidate)
  const interactions = new EnvironmentInteractions(canvas, scene, () => camera.active, invalidate, () => camera.walking)
  const player = new FirstPersonController(canvas, scene, camera, interactions, invalidate)
  // With the world built and furnished, each window's shadows are seen from where they can see all its glass.
  placeWindowShadows(scene, (from, to) => { const d = from.distanceTo(to); return d < 0.01 || player.world.rayDistance(from, to.clone().sub(from).normalize(), d) >= d - 0.02 })
  // Neon signs, lamps, windows and doorways are the only real lights; they shade everything around them.
  const neonLights = new NeonLights(scene)
  const vr = new VRWalkthrough(renderer, scene, camera, player, invalidate)
  const mission = missionWorld ? new MissionRuntime(scene, camera, player, missionWorld, invalidate) : null
  const session: Session = { mode, scene, camera, interactions, player, vr, mission, buildingLabels, neonLights, startupReady: !mission,
    lab: level === 'light-room' ? startLightLab(scene, neonLights, invalidate) : undefined }
  // Initialization positions the mission camera and settles the menu (including
  // load errors). Reveal only after that state has actually been rendered.
  void mission?.initialized.then(() => {
    warmUp(renderer, scene, camera.active)
    neonLights.warmUp(renderer, scene, camera.active)
    session.startupReady = true
    invalidate()
  })
  if (mode === 'load') void mission?.initialized.then(() => mission.showLoad())
  // The overview and the plan show the whole level.
  if (missionWorld) camera.frameLevel(missionWorld.bounds)
  const view = viewOf(mode)
  if (view) {
    camera.setView(view)
    // The mission's player shares the perspective camera and is placed at the insertion once loaded; restore the view after that.
    void mission?.initialized.then(() => { if (!player.enabled) camera.setView(view) })
  } else player.enable()
  // Free roam, the map views, training and developer levels get a way back to the game's main menu.
  document.querySelector<HTMLElement>('#home-link')!.hidden = !(!missionWorld || view || levelInfo(level)?.kind !== 'campaign')
  return session
}

function disposeSession({ scene, vr, buildingLabels, mission, player, camera, interactions, lab }: Session) {
  lab?.()
  vr.dispose()
  buildingLabels.dispose()
  mission?.dispose()
  player.dispose()
  camera.dispose()
  interactions.dispose()
  const materials = new Set<THREE.Material>()
  scene.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      object.geometry.dispose()
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
    }
  })
  materials.forEach(material => material.dispose())
}

let frame = 0
let lastTime = performance.now()
let rendering = false
let contextLost = false
let disposed = false
const invalidate = () => {
  if (!frame && !renderer.xr.isPresenting && !contextLost && !disposed) {
    if (!rendering) lastTime = performance.now()
    frame = requestAnimationFrame(render)
  }
}
const frameTimes: number[] = []
let session = boot(startMode())

/**
 * The game and the tutorial switch into each other in place, with no reload. The menu click that asks for it still
 * counts as the player's own gesture, so the mouse is captured right then; play starts as soon as the level loads.
 * Other modes need a fresh page (modes.ts reloads the same address).
 */
onModeSwitch(next => {
  if (!session.mission || !playsLevel(next)) return false
  try { (canvas.requestPointerLock() as Promise<void> | undefined)?.catch(() => {}) } catch { /* drag-to-look takes over */ }
  disposeSession(session)
  document.documentElement.setAttribute('data-loading', '')
  canvas.dataset.ready = 'false'
  session = boot(next)
  const { mission, player } = session
  // Straight into play, unless the mission was entered from the campaign or the free missions: then its briefing first.
  void mission?.initialized.then(() => {
    if (session.player !== player) return
    if (mission.opensOnBriefing) { try { document.exitPointerLock() } catch { /* not locked */ } } else player.begin()
  })
  resize()
  exposeForDevelopment()
  return true
})

renderer.xr.addEventListener('sessionstart', () => {
  cancelAnimationFrame(frame)
  frame = 0
  lastTime = performance.now()
  renderer.setAnimationLoop(render)
})
renderer.xr.addEventListener('sessionend', () => {
  renderer.setAnimationLoop(null)
  if (!disposed) resize()
})

function render(now: number, xrFrame?: XRFrame) {
  if (disposed || contextLost) return
  frame = 0
  rendering = true
  const elapsed = (now - lastTime) / 1000
  const dt = Math.min(elapsed, 0.05)
  const { scene, camera, interactions, player, vr, mission, neonLights, buildingLabels } = session
  if (player.playing && elapsed < 1) {
    frameTimes.push(elapsed * 1000); if (frameTimes.length > 600) frameTimes.shift()
    if (!resolutionSettled && !renderer.xr.isPresenting && ++resolutionFrames >= 90) adaptResolution()
  }
  lastTime = now
  // Door travel uses real elapsed time even when low FPS caps the physics step.
  const doorsMoving = interactions.update(elapsed)
  let moving = false
  if (vr.active && xrFrame) vr.update(dt, xrFrame)
  else moving = player.update(dt) || camera.update(dt)
  let missionMoving = false
  try {
    // Cinematic travel follows real frame time; physics keeps its safe step cap.
    missionMoving = mission?.update(dt, elapsed) ?? false
    const eye = vr.active ? vr.rig.camera : camera.active
    neonLights.update(renderer, eye.getWorldPosition(viewer))
    renderer.render(scene, eye)
    if (!vr.active && document.body.dataset.mode !== 'walk') buildingLabels.update(camera.active)
  }
  finally { mission?.finishFrame() }
  if (session.startupReady) {
    canvas.dataset.ready = 'true'
    if (document.documentElement.hasAttribute('data-loading')) {
      document.documentElement.removeAttribute('data-loading')
      document.querySelector<HTMLButtonElement>('#walk-start:not(:disabled)')?.focus({ preventScroll: true })
    }
  }
  // The lighting asks for frames while a light fades up or its shadows are drawn, even with nothing else moving.
  if (moving || doorsMoving || missionMoving || neonLights.busy) invalidate()
  rendering = false
}

// Slow GPUs: when play stays under ~40 fps, shade fewer pixels (never below 1×). Stroke widths are in CSS px and keep their size.
// ponytail: one-way and frame-time based. Frame time cannot tell GPU- from CPU-bound, so a step that
// does not help is undone and adaptation stops; a reload restores full resolution. Add step-up if players ask.
let resolutionFrames = 0, resolutionTrial = 0, resolutionSettled = false
function adaptResolution() {
  const recent = frameTimes.slice(-90), average = recent.reduce((a, b) => a + b, 0) / recent.length
  resolutionFrames = 0
  if (resolutionTrial) {
    if (average > resolutionTrial * 0.9) { resolutionScale /= 0.8; resolutionSettled = true }
    resolutionTrial = 0
  } else if (average > 25 && pixelRatio() > 1) { resolutionTrial = average; resolutionScale *= 0.8 }
  else return
  resize()
}

function resize() {
  if (renderer.xr.isPresenting) return
  const width = window.innerWidth, height = window.innerHeight
  renderer.setPixelRatio(pixelRatio())
  renderer.setSize(width, height, false)
  session.camera.resize(width, height)
  resizeInk(width, height)
  invalidate()
}
window.addEventListener('resize', resize)
const visibilityChanged = () => {
  lastTime = performance.now()
  if (!document.hidden) invalidate()
}
document.addEventListener('visibilitychange', visibilityChanged)
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault()
  contextLost = true
  cancelAnimationFrame(frame)
  frame = 0
  renderer.setAnimationLoop(null)
  void session.vr.exit().catch(() => {})
  canvas.dataset.ready = 'false'
})
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false
  resize()
})
resize()

// Development inspection surface, intentionally absent from production builds and the page UI.
function exposeForDevelopment() {
  if (!import.meta.env.DEV) return
  const { scene, camera, interactions, player, vr, mission, neonLights } = session
  Object.assign(window, {
    __environment: {
      scene, renderer, camera,
      interactions, player, vr, mission, neonLights,
      setView: (name: ViewName) => camera.setView(name),
      invalidate,
      stats: () => ({
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        view: camera.view,
        fps: frameTimes.length ? 1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) : null,
        frameP95: frameTimes.length ? [...frameTimes].sort((a,b)=>a-b)[Math.floor(frameTimes.length*0.95)] : null,
        camera: camera.active.position.toArray(),
        objects: scene.children[0].children.map(object => ({ name: object.name, kind: object.userData.kind ?? 'environment' })),
      }),
    },
  })
}
exposeForDevelopment()

import.meta.hot?.dispose(() => {
  disposed = true
  cancelAnimationFrame(frame)
  renderer.setAnimationLoop(null)
  window.removeEventListener('resize', resize)
  document.removeEventListener('visibilitychange', visibilityChanged)
  disposeSession(session)
  renderer.dispose()
})
