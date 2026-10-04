import { render } from 'preact'
import { useState } from 'preact/hooks'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { poseQuat, type Pose, type BoneVal, type Vec3 } from './clip'
import { actions, updaters, type Ctx } from './registry'
import { CHARACTERS, COLORS, BULKY_MOVES, characterOf, colorOf, exportModel, exportSheet, frame, setColor, switchCharacter, type CharacterId } from './characters'
import type * as THREE from 'three'
import { BONE_NAMES, type BoneName } from './rig'

export const views: Record<string, Vec3> = { front: [0, 1.1, 4], side: [4, 1.1, 0], '3/4': [2.8, 1.5, 2.8], top: [0, 5, 0.01] }

/** Inspector pose: rest * euler, written over the animation each frame for the bones it mentions. */
const inspector: Pose = {}

function Panel({ ctx, controls, renderer }: { ctx: Ctx; controls: OrbitControls; renderer: THREE.WebGLRenderer }) {
  const [, bump] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [fade, setFade] = useState(ctx.player.fade)
  const [loading, setLoading] = useState<CharacterId | null>(null)
  const character = characterOf(ctx), color = colorOf(ctx)
  const [exporting, setExporting] = useState(false)
  const paint = (value: number) => { setColor(ctx, value); bump(n => n + 1) }
  const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`
  const groups = new Map<string, typeof actions>()
  for (const a of actions) groups.set(a.group, [...(groups.get(a.group) ?? []), a])

  const setView = (name: string) => frame(ctx, controls, views[name])
  const pick = async (id: CharacterId) => {
    setLoading(id)
    try { await switchCharacter(ctx, id, controls) } finally { setLoading(null) }
  }
  const setAxis = (bone: BoneName, axis: number, deg: number) => {
    const v = [...(inspector[bone] ?? [0, 0, 0])] as BoneVal
    v[axis] = deg
    if (v.some(Boolean)) inspector[bone] = v
    else delete inspector[bone]
    bump(n => n + 1)
  }
  const reset = () => {
    ctx.player.stop(0)
    ctx.rig.resetPose()
    for (const b of Object.keys(inspector) as BoneName[]) delete inspector[b]
    bump(n => n + 1)
  }
  const copyPose = () => {
    const json = JSON.stringify(inspector)
    console.log('pose', json)
    navigator.clipboard?.writeText(json)
  }
  const blur = (e: Event) => (e.currentTarget as HTMLElement).blur()

  return <>
    <h3>Character</h3>
    <div class="characters">{CHARACTERS.map(c => <button key={c.id} class={c.id === character ? 'active' : ''} aria-pressed={c.id === character}
      disabled={!!loading} title={c.note} onClick={e => { blur(e); void pick(c.id) }}>
      <i class={`swatch ${c.id}`} />{loading === c.id ? 'Loading…' : c.label}</button>)}</div>
    <div class="colors" role="group" aria-label="Body colour">
      {COLORS.map(entry => <button key={entry.color} class={entry.color === color ? 'active' : ''} aria-pressed={entry.color === color} title={entry.label}
        aria-label={entry.label} style={{ background: hex(entry.color) }} onClick={e => { blur(e); paint(entry.color) }} />)}
      <label class="custom-color" title="Any other colour"><input type="color" value={hex(color)} onInput={e => paint(parseInt(e.currentTarget.value.slice(1), 16))} /></label>
    </div>
    <p class="color-name">{COLORS.find(entry => entry.color === color)?.label ?? `Custom ${hex(color)}`}</p>
    <div class="exports">
      <button disabled={exporting} title="A 3D model with its skeleton (.glb), for Blender and 3D or AI model tools"
        onClick={e => { blur(e); setExporting(true); void exportModel(ctx).finally(() => setExporting(false)) }}>{exporting ? 'Exporting…' : 'Export 3D model (.glb)'}</button>
      <button title="Front, three-quarter, side and back views in one picture (.png), to give an image AI like Grok"
        onClick={e => { blur(e); exportSheet(ctx, renderer) }}>Export model sheet (.png)</button>
    </div>

    {character !== 'guard' && <div class="moves">
      <h4>His moves</h4>
      {BULKY_MOVES.map(move => <button key={move.label} title={move.note} onClick={e => { blur(e); move.run(ctx) }}>
        <strong>{move.label}</strong><span>{move.note}</span></button>)}
    </div>}

    <h3>Camera</h3>
    {Object.keys(views).map(name => <button key={name} onClick={e => { blur(e); setView(name) }}>{name}</button>)}

    <h3>Playback</h3>
    <label><span>speed</span><input type="range" min="0" max="2" step="0.05" value={speed}
      onInput={e => { const s = +e.currentTarget.value; setSpeed(s); ctx.player.setSpeed(s) }} /><output>{speed.toFixed(2)}</output></label>
    <label><span>crossfade</span><input type="range" min="0" max="1" step="0.05" value={fade}
      onInput={e => { const f = +e.currentTarget.value; setFade(f); ctx.player.fade = f }} /><output>{fade.toFixed(2)}</output></label>
    <button onClick={e => { blur(e); ctx.player.stop() }}>stop</button>
    <button onClick={e => { blur(e); reset() }}>reset pose</button>

    {[...groups].map(([group, list]) => <div key={group}>
      <h3>{group}</h3>
      {list.map(a => <button key={a.label} onClick={e => { blur(e); void a.run(ctx) }}>{a.label}{a.hotkey && <kbd>{a.hotkey === ' ' ? 'space' : a.hotkey}</kbd>}</button>)}
    </div>)}

    <h3>Bone inspector</h3>
    <button onClick={e => { blur(e); copyPose() }}>copy pose JSON</button>
    {BONE_NAMES.map(bone => <details key={bone}>
      <summary class={inspector[bone] ? 'active' : ''}>{bone}{inspector[bone] && ` [${inspector[bone].join(', ')}]`}</summary>
      {(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}><span>{axis}</span>
        <input type="range" min="-180" max="180" step="1" value={inspector[bone]?.[i] ?? 0}
          onInput={e => setAxis(bone, i, +e.currentTarget.value)} />
        <output>{inspector[bone]?.[i] ?? 0}</output></label>)}
    </details>)}
  </>
}

export function mountPanel(el: HTMLElement, ctx: Ctx, controls: OrbitControls, renderer: THREE.WebGLRenderer) {
  updaters.push((_, { rig }) => {
    for (const [bone, v] of Object.entries(inspector) as [BoneName, Vec3][]) poseQuat(bone, v, rig.bones[bone].quaternion)
  })
  render(<Panel ctx={ctx} controls={controls} renderer={renderer} />, el)
}
