import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Player } from './player'
import { loadStickman, setOutlineResolution } from './rig'
import type { Ctx } from './registry'
import { api as guns } from './weapons/guns'
import { BOSS_LOOKS, type BossLook } from '../game/boss-models'
import type { GunName } from './weapons/models'

/**
 * The characters the game builds, all on the one stickman skeleton, so every lab clip plays on each. The hostage
 * and the co-op teammates are the guard in another colour: pick them with the colour option instead.
 */
export const CHARACTERS = [
  { id: 'guard', label: 'Guard', note: 'The stickman soldier (also the hostage and teammates, in their colours)', file: 'stickman-guard' },
  { id: 'bulky', label: 'Bulky Boy', note: 'Tutorial boss: a giant armoured riot breacher with an AK', file: 'bulky-boy' },
  // Boss bodies modelled with Hyper3D Rodin, worn on the same skeleton (game/boss-models.ts).
  { id: 'bulky-rodin', label: 'Bulky Boy (Rodin)', note: 'Bulky Boy remodelled with Rodin 3D', file: 'bulky-boy-rodin' },
  { id: 'warden', label: 'The Warden', note: 'Boss (Rodin): the prison warden in his long leather coat and peaked cap', file: 'the-warden' },
  { id: 'sapper', label: 'The Sapper', note: 'Boss (Rodin): a demolition man in a padded bomb-disposal suit', file: 'the-sapper' },
] as const
/** The Rodin body each boss character wears (none: the stickman with Bulky Boy's fitted armour). */
const LOOKS: Partial<Record<CharacterId, BossLook>> = { 'bulky-rodin': 'bulky', warden: 'warden', sapper: 'sapper' }
/** The gun a boss character carries in the lab: his own (the Breaker for Bulky Boy), else the AK. */
const weaponOf = (id: CharacterId): GunName => { const look = LOOKS[id]; return (look && BOSS_LOOKS[look].weapon) || 'ak' }
export type CharacterId = typeof CHARACTERS[number]['id']

/** Body colours: the game's own, and any other from the colour picker. */
export const COLORS = [
  { label: 'Black (guard)', color: 0x000000 },
  { label: 'Blue (hostage)', color: 0x2878d0 },
  { label: 'Green (teammate)', color: 0x2f9e44 },
  { label: 'Orange (teammate)', color: 0xf08c00 },
  { label: 'Violet (teammate)', color: 0x7048e8 },
  { label: 'Brown (teammate)', color: 0x8d5524 },
] as const

type Actor = { root: THREE.Group; player: Player; gun?: THREE.Object3D; makeBoss?: () => void; dispose?: () => void; breakArmor?: (instant?: boolean) => void; armorLeft?: (left: number) => void
  dropPlates?: (dt: number) => void }
/** What the lab is showing: which character in which colour, and the game actor behind it (none for the plain guard). */
type Current = { id: CharacterId; color: number; actor: Actor | null; loading: boolean; armor: number; down?: boolean }

const current = (ctx: Ctx): Current => ctx.fx.character ??= { id: 'guard', color: 0x000000, actor: null, loading: false, armor: 1 }
export const characterOf = (ctx: Ctx) => current(ctx).id
export const colorOf = (ctx: Ctx) => current(ctx).color

/**
 * Show another character in place of the one on screen. Guns and blood are cleared, the new character plays
 * the idle loop in the chosen colour, and the camera reframes to its size (Bulky Boy stands twice as tall).
 */
export async function switchCharacter(ctx: Ctx, id: CharacterId, controls?: OrbitControls) {
  const state = current(ctx)
  if (state.loading || state.id === id) return
  state.loading = true
  try {
    let actor: Actor | null = null, root: THREE.Group, player: Player, rig = ctx.rig
    if (id === 'guard') {
      rig = await loadStickman()
      root = rig.root
      player = new Player(root)
    } else {
      // The game's own actor, so Bulky Boy's armour is exactly what the game shows.
      const { EnemyActor } = await import('../game/actors')
      // His AK is the lab's own (equipped below), so every lab gun tool works on him; the actor's copy stays hidden.
      const enemy = await EnemyActor.create('ak')
      enemy.gun.visible = false
      enemy.makeBoss()
      const look = LOOKS[id]
      if (look) await enemy.wearLook(look)
      actor = enemy as unknown as Actor
      rig = enemy.rig
      root = enemy.root
      player = enemy.player
    }
    ctx.weapons.guns?.unequip()
    ctx.fx.blood?.clear()
    ctx.player.stop(0)
    ctx.scene.remove(ctx.rig.root)
    state.actor?.dispose?.()
    const { fade } = ctx.player
    ctx.rig = rig
    ctx.player = player
    player.fade = fade
    root.position.set(0, 0, 0)
    root.rotation.set(0, 0, 0)
    ctx.scene.add(root)
    player.play(ctx.clips.idle, { loop: true, fade: 0 })
    Object.assign(state, { id, actor, armor: 1, down: false })
    // His AK in hand, as in the fight.
    if (id !== 'guard') guns(ctx).equip(weaponOf(id))
    setColor(ctx, state.color)
    if (controls) frame(ctx, controls)
  } finally { state.loading = false }
}

/** Paint the character's body. The lab guard shares its material with every rig, so it gets its own copy first. */
export function setColor(ctx: Ctx, color: number) {
  const state = current(ctx)
  state.color = color
  const mesh = ctx.rig.mesh
  let material = mesh.material as THREE.MeshBasicMaterial
  if (!state.actor && !material.userData.labOwn) {
    const original = material
    material = original.clone()
    // Material.clone keeps neither the skinning shader hook nor the defines.
    material.onBeforeCompile = original.onBeforeCompile
    material.defines = { ...original.defines }
    material.userData.labOwn = true
    mesh.material = material
  }
  material.color.setHex(color)
}

/** Point the camera at the character, from the front, at a distance that fits its height. */
export function frame(ctx: Ctx, controls: OrbitControls, view: THREE.Vector3Tuple = [0, 1.1, 4]) {
  const scale = ctx.rig.root.scale.y
  ctx.camera.position.set(view[0] * scale, view[1] * scale, view[2] * scale)
  controls.target.set(0, 0.9 * scale, 0)
  controls.update()
}

/** The file name a character exports under: its name, plus its colour when that is not the game's black. */
function fileName(ctx: Ctx) {
  const state = current(ctx)
  const base = CHARACTERS.find(character => character.id === state.id)!.file
  const named = COLORS.find(entry => entry.color === state.color)?.label.split(' ')[0].toLowerCase()
  return state.color === 0 ? base : `${base}-${named ?? state.color.toString(16).padStart(6, '0')}`
}

function download(blob: Blob, name: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

/** Ink outlines and pen strokes are screen-space shader effects, not geometry: they stay out of an exported model. */
const shaderOnly = (object: THREE.Object3D) => {
  const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  const list = Array.isArray(material) ? material : material ? [material] : []
  return list.some(entry => (entry as THREE.ShaderMaterial).isShaderMaterial) || (object as { isLineSegments2?: boolean }).isLineSegments2 === true
}

/**
 * The character as a 3D model (.glb, binary glTF), in the pose on screen, with its skeleton, so it opens in Blender
 * and in 3D or AI model tools. Surfaces export as flat, unlit colours, the way the game draws them; the pen outlines
 * and hatching are drawn by shaders and are not part of the geometry.
 */
export async function exportModel(ctx: Ctx) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js')
  const root = ctx.rig.root
  const hidden: THREE.Object3D[] = []
  root.traverse(object => { if (object.visible && shaderOnly(object)) { object.visible = false; hidden.push(object) } })
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true })
    download(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), `${fileName(ctx)}.glb`)
  } finally { for (const object of hidden) object.visible = true }
}

/**
 * A model sheet: the character from the front, three-quarter, side and back on white paper, with its name. This is
 * the one to give an image AI (Grok and the like) as a reference for new designs.
 */
export function exportSheet(ctx: Ctx, renderer: THREE.WebGLRenderer) {
  const width = 640, height = 900, label = 70
  const views: [string, number][] = [['Front', 0], ['Three-quarter', -40], ['Side', -90], ['Back', 180]]
  const sheet = document.createElement('canvas')
  sheet.width = width * views.length; sheet.height = height + label
  const draw = sheet.getContext('2d')!
  draw.fillStyle = '#ffffff'
  draw.fillRect(0, 0, sheet.width, sheet.height)
  const camera = new THREE.PerspectiveCamera(24, width / height, 0.05, 100)
  // Fit every view to the character's real extent, turning about its middle.
  const box = new THREE.Box3(), part = new THREE.Box3()
  ctx.rig.root.updateMatrixWorld(true)
  ctx.rig.root.traverseVisible(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || shaderOnly(mesh)) return
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) box.union(part.setFromObject(mesh, true))
    else { mesh.geometry.computeBoundingBox(); box.union(part.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)) }
  })
  const extent = box.getSize(new THREE.Vector3())
  const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z))
  const target = new THREE.Vector3(0, (box.min.y + box.max.y) / 2, 0)
  const half = THREE.MathUtils.degToRad(camera.fov / 2)
  const fit = Math.max(extent.y / 2 / Math.tan(half), reach / (Math.tan(half) * camera.aspect)) * 1.12 + reach
  const helpers = ctx.scene.children.filter(child => (child as THREE.GridHelper).isLineSegments && child.type === 'GridHelper')
  const size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio()
  for (const helper of helpers) helper.visible = false
  try {
    renderer.setPixelRatio(1)
    renderer.setSize(width, height, false)
    setOutlineResolution(width, height)
    views.forEach(([, degrees], index) => {
      const angle = THREE.MathUtils.degToRad(degrees)
      camera.position.set(Math.sin(angle) * fit, target.y, Math.cos(angle) * fit)
      camera.lookAt(target)
      renderer.render(ctx.scene, camera)
      draw.drawImage(renderer.domElement, index * width, 0, width, height)
    })
  } finally {
    for (const helper of helpers) helper.visible = true
    renderer.setPixelRatio(ratio)
    renderer.setSize(size.x, size.y, false)
    setOutlineResolution(size.x, size.y)
  }
  draw.fillStyle = '#000000'
  draw.font = '600 30px "Chalkboard SE", "Comic Sans MS", sans-serif'
  draw.textAlign = 'center'
  views.forEach(([name], index) => draw.fillText(name, index * width + width / 2, height + 44))
  draw.textAlign = 'left'
  draw.font = '700 34px "Chalkboard SE", "Comic Sans MS", sans-serif'
  draw.fillText(CHARACTERS.find(character => character.id === current(ctx).id)!.label, 24, 48)
  sheet.toBlob(blob => { if (blob) download(blob, `${fileName(ctx)}-model-sheet.png`) }, 'image/png')
}

/** Bulky Boy in the lab: his shot-off gear falls and comes to rest on the ground. */
export function update(dt: number, ctx: Ctx) {
  const state = ctx.fx.character as Current | undefined
  if (!state?.actor || state.id === 'guard') return
  // Gear that has been shot off falls and comes to rest on the ground.
  state.actor.dropPlates?.(Math.min(dt, 0.05))
  // A body rigged in Blender takes the pose the lab gave his skeleton this frame.
  ;(state.actor as Actor & { followLook?: () => void }).followLook?.()
}

const bulky = (ctx: Ctx) => {
  const state = current(ctx)
  return state.id !== 'guard' && state.actor ? state as Current & { actor: Actor } : null
}
/** Play one of his body clips; `once` returns to the idle afterwards. The lab's gun tools take his arms back after. */
const play = (ctx: Ctx, clip: string, once = false) => {
  const state = bulky(ctx)
  if (!state) return
  if (state.down) getUp(ctx)
  if (once) void ctx.player.play(ctx.clips[clip], { once: true }).then(done => { if (done) ctx.player.play(ctx.clips.idle, { loop: true }) })
  else ctx.player.play(ctx.clips[clip], { loop: true })
}
/** Run one of the lab's gun tools on him, his AK back in hand first. */
const gun = (ctx: Ctx, use: (api: ReturnType<typeof guns>) => void) => {
  const state = bulky(ctx)
  if (!state) return
  if (state.down) getUp(ctx)
  const api = guns(ctx)
  const weapon = weaponOf(state.id)
  if (api.current?.userData.name !== weapon) api.equip(weapon)
  use(api)
}
/** Every plate back on, standing, AK in hand. */
const getUp = (ctx: Ctx) => {
  const state = bulky(ctx)
  if (!state) return
  ;(state.actor as unknown as { refitArmor(): void }).refitArmor()
  Object.assign(state, { armor: 1, down: false })
  guns(ctx).equip(weaponOf(state.id))
}

/** Bulky Boy's moves, listed under his character in the lab panel. */
export const BULKY_MOVES: { label: string; note: string; run: (ctx: Ctx) => void }[] = [
  { label: 'Stand · AK lowered', note: 'His idle, AK at the low ready', run: ctx => gun(ctx, api => api.lower()) },
  { label: 'Aim the AK', note: 'Shouldered, as he does when he sees you', run: ctx => gun(ctx, api => api.aim()) },
  { label: 'Fire one shot', note: 'One round; in the fight his rounds hit harder than a guard\'s', run: ctx => gun(ctx, api => api.fire()) },
  { label: 'Full auto (on/off)', note: 'Bursts of AK fire', run: ctx => gun(ctx, api => api.toggleAuto()) },
  { label: 'Reload', note: 'Magazine change', run: ctx => gun(ctx, api => api.reload()) },
  { label: 'Walk', note: 'Patrolling', run: ctx => play(ctx, 'walk') },
  { label: 'Run · charge', note: 'How he closes in on you', run: ctx => play(ctx, 'run') },
  { label: 'Flinch', note: 'His stagger when a critical hit lands or his armour breaks', run: ctx => play(ctx, 'flinchBody', true) },
  { label: 'Shoot armour off (next piece)', note: 'Pouches, then helmet, then vest, as in the fight', run: ctx => {
    const state = bulky(ctx); if (!state || state.armor <= 0) return
    state.armor = Math.max(0, state.armor - 1 / 3 - 1e-6)
    state.actor.armorLeft?.(state.armor)
    if (state.armor <= 0) state.actor.breakArmor?.()
  } },
  { label: 'Fall', note: 'His death: the AK drops', run: ctx => {
    const state = bulky(ctx); if (!state) return
    state.down = true
    guns(ctx).release()
    void ctx.player.play(ctx.clips.dieBody, { once: true, fade: 0.1 })
  } },
  { label: 'Get back up · armour on', note: 'Reset him: every piece back on, AK in hand', run: getUp },
]
export const actions: { group: string; label: string; run: (ctx: Ctx) => void }[] = []
