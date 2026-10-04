import * as THREE from 'three'
import { dqUniforms, dualQuaternionSkinning, type BoneName, type Rig } from '../lab/rig'
import type { GunName } from '../lab/weapons/models'

/**
 * Boss bodies modelled with Hyper3D Rodin (public/models/bosses), worn on the one stickman skeleton so every lab clip,
 * hit volume and game behaviour works on them unchanged. Rodin gives a textured statue standing arms-down; at load it
 * is fitted to the skeleton's rest T-pose (scaled to its height, hips and shoulders lined up, each arm swung up and
 * stretched onto the skeleton's arm), every vertex is bound to the nearest bones, and its colours are redrawn in the
 * game's ink: black, the two pencil greys and paper white, flat per face, with the stickman's black outline.
 */
export const BOSS_LOOKS = {
  bulky: { label: 'Bulky Boy (Rodin)', file: 'bulky.glb', note: 'Tutorial boss, remodelled with Rodin: a giant armoured riot breacher', weapon: 'breaker', rigged: 'bulky-rigged.glb' },
  warden: { label: 'The Warden', file: 'warden.glb', note: 'Boss: the prison warden in his long leather coat and peaked cap', weapon: undefined, rigged: undefined },
  sapper: { label: 'The Sapper', file: 'sapper.glb', note: 'Boss: a demolition man in a padded bomb-disposal suit', weapon: undefined, rigged: undefined },
} as const satisfies Record<string, { label: string; file: string; note: string; weapon: GunName | undefined; rigged: string | undefined }>
export type BossLook = keyof typeof BOSS_LOOKS

/** The stickman's rest pose this is fitted to (root space, metres): see lab/rig.ts. */
export const SKELETON = {
  height: 1.737, hips: 0.82, thigh: 0.79, shoulder: 1.2, armRoot: 0.155, armTip: 0.76,
  joints: {
    hips: [0, 0.82], spine: [0, 0.95], chest: [0, 1.08], neck: [0, 1.2], head: [0, 1.33],
    shoulder: [0.04, 1.2], upper_arm: [0.155, 1.2], forearm: [0.413, 1.2], hand: [0.652, 1.2],
    thigh: [0.08, 0.79], shin: [0.1, 0.42],
  } as Record<string, [number, number]>,
}

/** The ink colours a face can take, darkest first, and the luminance below which each is used. */
const INK = [[0, 0.2], [0x808080, 0.42], [0xbdbdbd, 0.68], [0xffffff, Infinity]] as const

type Segment = { bone: BoneName; a: THREE.Vector3; b: THREE.Vector3; side: -1 | 0 | 1; kind: 'body' | 'arm' | 'leg' }
const v3 = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)

/** The skeleton's bones as line segments in its rest pose, for binding vertices to the nearest. */
function segments(): Segment[] {
  const j = SKELETON.joints, list: Segment[] = [
    { bone: 'hips', a: v3(0, j.hips[1]), b: v3(0, j.spine[1]), side: 0, kind: 'body' },
    { bone: 'spine', a: v3(0, j.spine[1]), b: v3(0, j.chest[1]), side: 0, kind: 'body' },
    { bone: 'chest', a: v3(0, j.chest[1]), b: v3(0, j.neck[1]), side: 0, kind: 'body' },
    { bone: 'neck', a: v3(0, j.neck[1]), b: v3(0, j.head[1]), side: 0, kind: 'body' },
    { bone: 'head', a: v3(0, j.head[1]), b: v3(0, SKELETON.height), side: 0, kind: 'body' },
  ]
  for (const side of [-1, 1] as const) {
    // The rig's .L bones are on +X.
    const s = side === 1 ? 'L' : 'R'
    list.push(
      { bone: `shoulder.${s}`, a: v3(side * j.shoulder[0], j.shoulder[1]), b: v3(side * j.upper_arm[0], j.upper_arm[1]), side, kind: 'arm' },
      { bone: `upper_arm.${s}`, a: v3(side * j.upper_arm[0], j.upper_arm[1]), b: v3(side * j.forearm[0], j.forearm[1]), side, kind: 'arm' },
      { bone: `forearm.${s}`, a: v3(side * j.forearm[0], j.forearm[1]), b: v3(side * j.hand[0], j.hand[1]), side, kind: 'arm' },
      { bone: `hand.${s}`, a: v3(side * j.hand[0], j.hand[1]), b: v3(side * SKELETON.armTip, j.hand[1]), side, kind: 'arm' },
      { bone: `thigh.${s}`, a: v3(side * j.thigh[0], j.thigh[1]), b: v3(side * j.shin[0], j.shin[1]), side, kind: 'leg' },
      { bone: `shin.${s}`, a: v3(side * j.shin[0], j.shin[1]), b: v3(side * j.shin[0], 0), side, kind: 'leg' },
    )
  }
  return list as Segment[]
}

const segmentDistance = (p: THREE.Vector3, segment: Segment) => {
  const ab = segment.b.clone().sub(segment.a), t = THREE.MathUtils.clamp(p.clone().sub(segment.a).dot(ab) / ab.lengthSq(), 0, 1)
  return p.distanceTo(segment.a.clone().addScaledVector(ab, t))
}

export type Fitted = { positions: Float32Array; skinIndex: Uint16Array; skinWeight: Float32Array }

/**
 * Fits a statue standing on +Y and facing +Z, arms hanging, to the skeleton's T-pose, and binds it. `bones` gives
 * each bone's index in the skeleton. Pure: positions in, fitted positions and skin attributes out.
 */
export function fitToSkeleton(source: ArrayLike<number>, bones: Record<BoneName, number>, index?: ArrayLike<number>): Fitted {
  const count = source.length / 3
  const box = new THREE.Box3()
  for (let i = 0; i < count; i++) box.expandByPoint(v3(source[i * 3], source[i * 3 + 1], source[i * 3 + 2]))
  // Feet on the ground, centred, scaled to the stickman's height.
  const scale = SKELETON.height / (box.max.y - box.min.y), cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
  const points = Array.from({ length: count }, (_, i) => v3((source[i * 3] - cx) * scale, (source[i * 3 + 1] - box.min.y) * scale, (source[i * 3 + 2] - cz) * scale))
  const H = SKELETON.height, slices = 80, slice = H / slices, gap = H * 0.018
  const at = (y: number) => Math.max(0, Math.min(slices, Math.floor(y / slice)))
  // Per height slice, the solid runs across x (front view): the body, or two legs, with arms apart at either side.
  const xs = Array.from({ length: slices + 1 }, () => [] as number[])
  for (const p of points) xs[at(p.y)].push(p.x)
  const runs = xs.map(values => {
    values.sort((a, b) => a - b)
    const out: [number, number][] = []
    for (const x of values) { const last = out[out.length - 1]; if (last && x - last[1] <= gap) last[1] = x; else out.push([x, x]) }
    return out
  })
  // The crotch: the highest slice in the lower body where nothing crosses the middle (two separate legs).
  let crotch = H * 0.45
  for (let s = 2; s < slices * 0.62; s++) if (runs[s].length && !runs[s].some(([a, b]) => a < 0 && b > 0)) crotch = (s + 1) * slice
  // The hips' half width, just above the crotch: anything wider than this further out is an arm, never body.
  const hipRun = runs[at(crotch + H * 0.04)].find(([a, b]) => a <= 0 && b >= 0) ?? [-H * 0.12, H * 0.12]
  const hip = Math.max(-hipRun[0], hipRun[1])
  // Each side's arm: in every slice from the knees up to the shoulders, the outermost run lying wholly outside the hips.
  const armRun = (s: number, side: -1 | 1) => {
    const outer = side > 0 ? runs[s][runs[s].length - 1] : runs[s][0]
    if (!outer || runs[s].length < 2) return null
    const inner = side > 0 ? outer[0] : -outer[1]
    return inner > hip * 0.9 ? outer : null
  }
  const isArm = points.map(p => {
    const s = at(p.y), side = p.x > 0 ? 1 : -1
    if (p.y < H * 0.25 || p.y > H * 0.88) return false
    const run = armRun(s, side)
    return !!run && p.x >= run[0] - 1e-6 && p.x <= run[1] + 1e-6
  })
  // Grow each arm over the surface to everything joined to it that is still clear of the hips and below the armpit:
  // the rest of a hand resting by the thigh, or anything held out in front of the body.
  if (index) {
    const armpit = [-1, 1].map(side => Math.max(-Infinity, ...points.filter((p, i) => isArm[i] && Math.sign(p.x) === side).map(p => p.y)))
    // Nor below the hand: a coat that flares wider than the hips must not be taken for a sleeve.
    const handBottom = [-1, 1].map(side => Math.min(Infinity, ...points.filter((p, i) => isArm[i] && Math.sign(p.x) === side).map(p => p.y)) - H * 0.015)
    // The mesh is split along its texture seams; vertices at the same spot are one point of the surface.
    const weld = new Map<string, number>(), same = Array.from({ length: count }, () => [] as number[])
    const welded = points.map(p => {
      const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`
      if (!weld.has(key)) weld.set(key, weld.size)
      return weld.get(key)!
    })
    welded.forEach((root, i) => same[root].push(i))
    const neighbours = Array.from({ length: weld.size }, () => [] as number[])
    for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = welded[index[t + k]], b = welded[index[t + (k + 1) % 3]]
      neighbours[a].push(b); neighbours[b].push(a)
    }
    // How far forward the body's own surface comes at each height.
    const front = Array.from({ length: slices + 1 }, () => -Infinity)
    for (const p of points) if (Math.abs(p.x) < hip * 0.6) front[at(p.y)] = Math.max(front[at(p.y)], p.z)
    const armSpot = new Array<boolean>(weld.size).fill(false)
    points.forEach((_, i) => { if (isArm[i]) armSpot[welded[i]] = true })
    const queue = armSpot.flatMap((arm, spot) => arm ? [spot] : [])
    while (queue.length) {
      const from = queue.pop()!, origin = points[same[from][0]]
      for (const next of neighbours[from]) {
        const p = points[same[next][0]], side = p.x > 0 ? 1 : 0
        const held = p.z > front[at(p.y)] + H * 0.03
        if (armSpot[next] || (!held && Math.sign(p.x) !== Math.sign(origin.x)) || (!held && Math.abs(p.x) < hip * 0.85) || p.y > armpit[side] || p.y < Math.max(H * 0.15, handBottom[side])) continue
        armSpot[next] = true
        queue.push(next)
      }
    }
    points.forEach((_, i) => { if (armSpot[welded[i]]) isArm[i] = true })
  }
  // The shoulders: going down from the neck (the narrowest slice of the upper body), the first slice more than
  // two and a half necks wide. The joint sits a little below that, in from the edge.
  const width = (s: number) => runs[s].length ? runs[s][runs[s].length - 1][1] - runs[s][0][0] : 0
  let neck = at(H * 0.86)
  for (let s = at(H * 0.76); s <= at(H * 0.95); s++) if (width(s) > 0 && width(s) < width(neck)) neck = s
  let shoulderTop = at(H * 0.8)
  for (let s = neck; s > at(H * 0.55); s--) if (width(s) > width(neck) * 2.6) { shoulderTop = s; break }
  const shoulderHalf = width(shoulderTop) / 2
  const arms = ([-1, 1] as const).map(side => {
    const own = points.filter((p, i) => isArm[i] && Math.sign(p.x) === side)
    if (own.length < 30) return null
    // The arm's axis, fitted through its points (front view), pointing down the arm.
    const mean = own.reduce((sum, p) => sum.add(v3(p.x, p.y, 0)), v3(0, 0)).divideScalar(own.length)
    let xx = 0, xy = 0, yy = 0
    for (const p of own) { const dx = p.x - mean.x, dy = p.y - mean.y; xx += dx * dx; xy += dx * dy; yy += dy * dy }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
    let axis = v3(Math.cos(angle), Math.sin(angle), 0)
    if (axis.y > 0) axis.negate()
    // The shoulder joint: on the axis a little above the armpit (the top of the separate arm); the tip: its far end.
    const armpit = own.reduce((top, p) => Math.max(top, p.y), -Infinity)
    let root = mean.clone().addScaledVector(axis, (armpit + H * 0.05 - mean.y) / axis.y)
    let length = Math.max(...own.map(p => v3(p.x, p.y, 0).sub(root).dot(axis)))
    // A sleeve flush against a coat shows only its hand apart from the body: then the shoulder comes from the
    // outline instead, and the arm runs from there to the hand.
    if (length < H * 0.25) {
      const tip = root.clone().addScaledVector(axis, length)
      root = v3(side * shoulderHalf * 0.72, (shoulderTop + 0.5) * slice - H * 0.035, 0)
      axis = tip.sub(root); length = axis.length(); axis.normalize()
    }
    const radius = own.map(p => { const d = v3(p.x, p.y, 0).sub(root); return d.sub(axis.clone().multiplyScalar(d.dot(axis))).length() }).sort((a, b) => a - b)[Math.floor(own.length * 0.9)]
    return { side, root, axis, length, radius }
  })
  const shoulderY = arms.filter(Boolean).reduce((sum, arm) => sum + arm!.root.y, 0) / Math.max(1, arms.filter(Boolean).length) || H * 0.8
  // Heights: ground, crotch, shoulders and crown land on the skeleton's.
  const knots = [[0, 0], [crotch, SKELETON.thigh], [shoulderY, SKELETON.shoulder], [H, H]]
  const warp = (y: number) => {
    for (let k = 1; k < knots.length; k++) if (y <= knots[k][0] || k === knots.length - 1) {
      const [y0, t0] = knots[k - 1], [y1, t1] = knots[k]
      return t0 + (y - y0) / Math.max(1e-6, y1 - y0) * (t1 - t0)
    }
    return y
  }
  const fitted = new Float32Array(count * 3)
  /** How much of each vertex is arm (0 to 1): binding keeps the body on body bones and the arms on arm bones. */
  const armness = new Float32Array(count)
  points.forEach((p, i) => {
    const body = v3(p.x, warp(p.y), p.z)
    const arm = arms.find(candidate => candidate && Math.sign(p.x) === candidate.side)
    let out = body
    if (arm) {
      // How much of this vertex is arm: all of it if found beyond the body, fading in round the shoulder.
      const d = p.clone().setZ(0).sub(arm.root), along = d.dot(arm.axis), off = d.clone().sub(arm.axis.clone().multiplyScalar(along))
      const near = off.length() < arm.radius * 1.4 && along < arm.length + H * 0.03
      // Round the shoulder (above the armpit, where arm and body are one surface) the arm fades in along its axis.
      const weight = isArm[i] ? 1 : near && p.y > crotch ? THREE.MathUtils.smoothstep(along, -H * 0.05, H * 0.04) * (Math.abs(p.x) > Math.abs(arm.root.x) - H * 0.04 ? 1 : 0) : 0
      armness[i] = weight
      if (weight > 0) {
        // Straight out along ±X at shoulder height, stretched so the hand ends at the skeleton's hand.
        const outward = v3(arm.side, 0, 0), up = v3(0, 1, 0)
        const across = off.dot(v3(-arm.axis.y, arm.axis.x, 0))
        const stretch = (SKELETON.armTip - SKELETON.armRoot) / arm.length
        const posed = v3(arm.side * SKELETON.armRoot, SKELETON.shoulder, p.z).addScaledVector(outward, along * stretch).addScaledVector(up, across * arm.side)
        out = body.lerp(posed, weight)
      }
    }
    fitted.set([out.x, out.y, out.z], i * 3)
  })
  // Bind each vertex to its two nearest bones (legs and arms only on their own side), weighted by closeness.
  const all = segments(), skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4)
  const point = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    point.fromArray(fitted, i * 3)
    const side = point.x > 0 ? 1 : -1
    // Body vertices bind to the body (and their leg), arm vertices to their arm; round the shoulder, to both.
    const arm = armness[i]
    const candidates = all.filter(segment => segment.kind === 'body' ? arm < 0.85
      : segment.side === side && (segment.kind === 'arm' ? arm > 0.15 : point.y < 0.9 && arm < 0.15))
    const nearest = candidates.map(segment => ({ segment, d: segmentDistance(point, segment) })).sort((a, b) => a.d - b.d).slice(0, 2)
    const w = nearest.map(({ d }) => 1 / Math.max(1e-4, d) ** 4), total = w.reduce((a, b) => a + b, 0)
    nearest.forEach(({ segment }, k) => { skinIndex[i * 4 + k] = bones[segment.bone]; skinWeight[i * 4 + k] = w[k] / total })
  }
  return { positions: fitted, skinIndex, skinWeight }
}

/** The ink colour for a texture colour (sRGB, 0 to 1). */
export function inkColor(r: number, g: number, b: number) {
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return INK.find(([, below]) => luminance < below)![0]
}

const cache = new Map<BossLook, Promise<{ fill: THREE.BufferGeometry; outline: THREE.BufferGeometry }>>()

/** Loads, fits, binds and inks a look, once per page; the geometry is shared and read-only. */
export function bossGeometry(look: BossLook, rig: Rig) {
  if (!cache.has(look)) cache.set(look, build(look, rig))
  return cache.get(look)!
}

async function build(look: BossLook, rig: Rig) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env?.BASE_URL ?? '/'}models/bosses/${BOSS_LOOKS[look].file}`)
  let mesh: THREE.Mesh | null = null
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse(object => { if (!mesh && (object as THREE.Mesh).isMesh) mesh = object as THREE.Mesh })
  if (!mesh) throw new Error(`${look}: no mesh`)
  const found = mesh as THREE.Mesh
  const geometry = found.geometry.clone().applyMatrix4(found.matrixWorld)
  const bones = Object.fromEntries((Object.keys(rig.bones) as BoneName[]).map(name => [name, rig.mesh.skeleton.bones.indexOf(rig.bones[name])])) as Record<BoneName, number>
  const fitted = fitToSkeleton(geometry.getAttribute('position').array, bones, geometry.getIndex()?.array)
  const outline = new THREE.BufferGeometry()
  outline.setIndex(geometry.getIndex())
  outline.setAttribute('position', new THREE.BufferAttribute(fitted.positions, 3))
  outline.setAttribute('skinIndex', new THREE.BufferAttribute(fitted.skinIndex, 4))
  outline.setAttribute('skinWeight', new THREE.BufferAttribute(fitted.skinWeight, 4))
  outline.computeVertexNormals()
  // Flat ink per face: each face takes the colour of the texture at its middle.
  const fill = outline.toNonIndexed()
  fill.deleteAttribute('normal')
  const uv = geometry.index ? geometry.toNonIndexed().getAttribute('uv') : geometry.getAttribute('uv')
  const material = found.material as THREE.MeshStandardMaterial
  const texture = material.emissiveMap ?? material.map
  const colors = new Float32Array(fill.getAttribute('position').count * 3)
  const sample = texture ? sampler(texture.image as CanvasImageSource & { width: number; height: number }, texture.flipY) : null
  const color = new THREE.Color()
  for (let face = 0; face < colors.length / 9; face++) {
    let u = 0, v = 0
    for (let k = 0; k < 3; k++) { u += uv.getX(face * 3 + k) / 3; v += uv.getY(face * 3 + k) / 3 }
    color.setHex(sample ? inkColor(...sample(u, v)) : 0)
    for (let k = 0; k < 3; k++) colors.set([color.r, color.g, color.b], face * 9 + k * 3)
  }
  fill.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  for (const g of [fill, outline]) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 3.2)
  geometry.dispose()
  return { fill, outline }
}

/** Reads a texture's pixels; returns its sRGB colour (0 to 1) at a UV. */
function sampler(image: CanvasImageSource & { width: number; height: number }, flipY: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  return (u: number, v: number): [number, number, number] => {
    const x = Math.min(canvas.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * canvas.width)))
    const yy = flipY ? 1 - (v - Math.floor(v)) : v - Math.floor(v)
    const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(yy * canvas.height)))
    const i = (y * canvas.width + x) * 4
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]
  }
}

// Ink fills keep their own colour under any light, like the stickman (render/neon.ts NEON_UNLIT), with the rig's skinning.
const fillMaterial = Object.assign(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), { defines: { NEON_UNLIT: '' } })
fillMaterial.onBeforeCompile = shader => { shader.vertexShader = dualQuaternionSkinning(shader.vertexShader); Object.assign(shader.uniforms, dqUniforms) }
/** The stickman's inverted-hull outline (lab/rig.ts), in black and a touch heavier for a boss. */
const outlineMaterial = new THREE.ShaderMaterial({
  uniforms: { ink: { value: new THREE.Color(0x000000) }, resolution: { value: new THREE.Vector2(1, 1) }, width: { value: 1.5 }, ...dqUniforms },
  vertexShader: dualQuaternionSkinning(`
    #include <common>
    #include <skinning_pars_vertex>
    uniform vec2 resolution;
    uniform float width;
    void main() {
      #include <beginnormal_vertex>
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      vec4 view = modelViewMatrix * vec4(transformed, 1.0);
      vec4 clip = projectionMatrix * view;
      vec3 n = normalize(normalMatrix * objectNormal);
      vec4 tip = projectionMatrix * vec4(view.xyz + n, 1.0);
      vec2 direction = (tip.xy * clip.w - clip.xy * tip.w) * resolution;
      direction /= max(length(direction), 0.0001);
      clip.xy += direction * width * 2.0 / resolution * clip.w;
      gl_Position = clip;
    }
  `),
  fragmentShader: `
    uniform vec3 ink;
    void main() {
      gl_FragColor = vec4(ink, 1.0);
      #include <colorspace_fragment>
    }
  `,
  side: THREE.BackSide, depthWrite: false,
})
const viewport = new THREE.Vector4()

/**
 * Dresses a stickman rig in a Rodin boss body: the stickman's own mesh and outline are hidden and the fitted body,
 * bound to the same skeleton, takes their place. Returns a function that takes it off again.
 */
export async function wearBossLook(rig: Rig, look: BossLook) {
  const { fill, outline } = await bossGeometry(look, rig)
  const body = new THREE.SkinnedMesh(fill, fillMaterial), shell = new THREE.SkinnedMesh(outline, outlineMaterial)
  body.name = `Boss body · ${look}`; shell.name = `Boss outline · ${look}`
  shell.renderOrder = 1
  shell.onBeforeRender = renderer => {
    renderer.getViewport(viewport)
    outlineMaterial.uniforms.resolution.value.set(viewport.z, viewport.w)
    outlineMaterial.uniformsNeedUpdate = true
  }
  const stickman = rig.mesh, parent = stickman.parent!
  const hidden = parent.children.filter(child => child === stickman || child.name === 'Stickman outline')
  for (const mesh of [body, shell]) {
    mesh.position.copy(stickman.position); mesh.quaternion.copy(stickman.quaternion); mesh.scale.copy(stickman.scale)
    mesh.bind(stickman.skeleton, stickman.bindMatrix)
    mesh.frustumCulled = false
    mesh.userData.noCollision = true
    parent.add(mesh)
  }
  for (const object of hidden) object.visible = false
  return () => {
    body.removeFromParent(); shell.removeFromParent()
    for (const object of hidden) object.visible = true
  }
}

/*
 * Boss bodies rigged in Blender. The model is fitted and weighted there on a copy of the game skeleton (same bone
 * names, joints moved onto the body), exported as a skinned GLB, and here it follows the stickman's skeleton: each
 * frame every one of its bones turns the way the stickman's turned from its rest, and its hips move with his. The
 * stickman underneath stays the one the game reads (animation, hit volumes, eyes, muzzle); only the drawing changes.
 */
const linearFill = Object.assign(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), { defines: { NEON_UNLIT: '' } })
const linearOutline = new THREE.ShaderMaterial({
  uniforms: { ink: { value: new THREE.Color(0x000000) }, resolution: { value: new THREE.Vector2(1, 1) }, width: { value: 1.5 } },
  vertexShader: `
    #include <common>
    #include <skinning_pars_vertex>
    uniform vec2 resolution;
    uniform float width;
    void main() {
      #include <beginnormal_vertex>
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      vec4 view = modelViewMatrix * vec4(transformed, 1.0);
      vec4 clip = projectionMatrix * view;
      vec3 n = normalize(normalMatrix * objectNormal);
      vec4 tip = projectionMatrix * vec4(view.xyz + n, 1.0);
      vec2 direction = (tip.xy * clip.w - clip.xy * tip.w) * resolution;
      direction /= max(length(direction), 0.0001);
      clip.xy += direction * width * 2.0 / resolution * clip.w;
      gl_Position = clip;
    }
  `,
  fragmentShader: `
    uniform vec3 ink;
    void main() {
      gl_FragColor = vec4(ink, 1.0);
      #include <colorspace_fragment>
    }
  `,
  side: THREE.BackSide, depthWrite: false,
})

type RiggedSource = { scene: THREE.Group; fill: THREE.BufferGeometry; outline: THREE.BufferGeometry; height: number }
const riggedCache = new Map<string, Promise<RiggedSource>>()

/** Loads a Blender-rigged boss once per page and inks it; copies are made per enemy. */
function riggedSource(file: string) {
  if (!riggedCache.has(file)) riggedCache.set(file, (async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const gltf = await new GLTFLoader().loadAsync(`${import.meta.env?.BASE_URL ?? '/'}models/bosses/${file}`)
    let mesh: THREE.SkinnedMesh | null = null
    gltf.scene.traverse(object => { if (!mesh && (object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh })
    if (!mesh) throw new Error(`${file}: no skinned mesh`)
    const skinned = mesh as THREE.SkinnedMesh
    const outline = skinned.geometry
    // Flat ink per face, from the texture at each face's middle, as for the fitted looks.
    const fill = outline.toNonIndexed()
    fill.deleteAttribute('normal')
    const uv = fill.getAttribute('uv')
    const material = skinned.material as THREE.MeshStandardMaterial
    const texture = material.emissiveMap ?? material.map
    const sample = texture ? sampler(texture.image as CanvasImageSource & { width: number; height: number }, texture.flipY) : null
    const colors = new Float32Array(fill.getAttribute('position').count * 3), color = new THREE.Color()
    for (let face = 0; face < colors.length / 9; face++) {
      let u = 0, v = 0
      for (let k = 0; k < 3; k++) { u += uv.getX(face * 3 + k) / 3; v += uv.getY(face * 3 + k) / 3 }
      color.setHex(sample ? inkColor(...sample(u, v)) : 0)
      for (let k = 0; k < 3; k++) colors.set([color.r, color.g, color.b], face * 9 + k * 3)
    }
    fill.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const box = new THREE.Box3().setFromObject(gltf.scene, true)
    return { scene: gltf.scene, fill, outline, height: box.max.y - box.min.y }
  })())
  return riggedCache.get(file)!
}

const sanitize = (name: string) => THREE.PropertyBinding.sanitizeNodeName(name)
const restRelative = new THREE.Quaternion(), rootInverse = new THREE.Quaternion(), worldQ = new THREE.Quaternion()

/** A Blender-rigged boss body following a stickman rig. Call `follow()` once his pose is final each frame. */
export type RiggedBody = { root: THREE.Object3D; follow: () => void; takeOff: () => void }

export async function wearRiggedBody(rig: Rig, file: string): Promise<RiggedBody> {
  const { scene, fill, outline, height } = await riggedSource(file)
  const { clone } = await import('three/addons/utils/SkeletonUtils.js')
  const root = clone(scene) as THREE.Group
  root.name = `Boss body · ${file}`
  // His feet on the stickman's ground, as tall as the stickman (the boss scale on the stickman root applies on top).
  const scale = SKELETON.height / height
  root.scale.setScalar(scale)
  let skinned: THREE.SkinnedMesh | null = null
  root.traverse(object => { if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh })
  const body = skinned as unknown as THREE.SkinnedMesh
  body.geometry = fill
  body.material = linearFill
  const shell = new THREE.SkinnedMesh(outline, linearOutline)
  shell.name = 'Boss outline'
  shell.renderOrder = 1
  shell.onBeforeRender = renderer => {
    renderer.getViewport(viewport)
    linearOutline.uniforms.resolution.value.set(viewport.z, viewport.w)
    linearOutline.uniformsNeedUpdate = true
  }
  body.parent!.add(shell)
  shell.bind(body.skeleton, body.bindMatrix)
  for (const mesh of [body, shell]) { mesh.frustumCulled = false; mesh.userData.noCollision = true }
  root.traverse(object => { object.userData.noCollision = true })
  const boneByName = new Map<string, THREE.Bone>()
  root.traverse(object => { if ((object as THREE.Bone).isBone) boneByName.set(object.name, object as THREE.Bone) })
  rig.root.add(root)
  // Rest orientations of both skeletons, relative to the stickman's root, taken from their rest poses.
  const saved = (Object.keys(rig.bones) as BoneName[]).map(name => [name, rig.bones[name].quaternion.clone(), rig.bones[name].position.clone()] as const)
  rig.resetPose()
  rig.root.updateMatrixWorld(true)
  const rootQ = rig.root.getWorldQuaternion(new THREE.Quaternion()), rootInv = rootQ.clone().invert()
  const relative = (object: THREE.Object3D) => rootInv.clone().multiply(object.getWorldQuaternion(new THREE.Quaternion()))
  const relativePosition = (object: THREE.Object3D) => rig.root.worldToLocal(object.getWorldPosition(new THREE.Vector3()))
  const pairs = (Object.keys(rig.bones) as BoneName[]).flatMap(name => {
    const own = boneByName.get(sanitize(name)) ?? boneByName.get(name)
    if (!own) return []
    return [{ name, from: rig.bones[name], to: own, fromRest: relative(rig.bones[name]), toRest: relative(own) }]
  })
  const hips = pairs.find(pair => pair.name === 'hips')!
  const hipsFromRest = relativePosition(hips.from), hipsToRest = relativePosition(hips.to)
  // How a hand's own frame turns from the stickman's to his, for what is held in it.
  const handTurn = Object.fromEntries((['hand.L', 'hand.R'] as const).map(name => {
    const pair = pairs.find(candidate => candidate.name === name)!
    return [name, pair.toRest.clone().invert().multiply(pair.fromRest)]
  })) as Record<'hand.L' | 'hand.R', THREE.Quaternion>
  for (const [name, quaternion, position] of saved) { rig.bones[name].quaternion.copy(quaternion); rig.bones[name].position.copy(position) }
  rig.root.updateMatrixWorld(true)
  // The order the skeleton is solved in: parents first.
  const ordered = [...pairs].sort((a, b) => depth(a.to) - depth(b.to))
  const solved = new Map<THREE.Object3D, THREE.Quaternion>()
  const hidden = rig.mesh.parent!.children.filter(child => child === rig.mesh || child.name === 'Stickman outline')
  for (const object of hidden) object.visible = false

  const follow = () => {
    rig.root.updateMatrixWorld(true)
    rig.root.getWorldQuaternion(worldQ); rootInverse.copy(worldQ).invert()
    solved.clear()
    for (const { from, to, fromRest, toRest } of ordered) {
      // His bone turns, relative to the root, the way the stickman's turned from its rest.
      from.getWorldQuaternion(worldQ)
      const target = rootInverse.clone().multiply(worldQ).multiply(restRelative.copy(fromRest).invert()).multiply(toRest)
      const parent = to.parent!
      const parentQ = solved.get(parent) ?? rootInverse.clone().multiply(parent.getWorldQuaternion(new THREE.Quaternion()))
      to.quaternion.copy(parentQ.clone().invert().multiply(target))
      solved.set(to, target)
    }
    // The hips carry his height changes (crouching, falling), scaled to his size.
    const moved = relativePosition(hips.from).sub(hipsFromRest).multiplyScalar(hipsToRest.y / Math.max(1e-6, hipsFromRest.y))
    const want = hipsToRest.clone().add(moved)
    hips.to.parent!.updateMatrixWorld(true)
    hips.to.position.copy(hips.to.parent!.worldToLocal(rig.root.localToWorld(want)))
    // Whatever the stickman holds goes into his hands, held the same way.
    for (const name of ['hand.L', 'hand.R'] as const) {
      const hand = rig.bones[name], own = pairs.find(pair => pair.name === name)!.to
      for (const held of [...hand.children]) {
        if (!held.name.startsWith('gun:')) continue
        own.add(held)
        held.position.applyQuaternion(handTurn[name]).divideScalar(scale)
        held.quaternion.premultiply(handTurn[name])
        held.scale.divideScalar(scale)
      }
    }
    root.updateMatrixWorld(true)
  }
  return {
    root, follow,
    takeOff: () => { root.removeFromParent(); for (const object of hidden) object.visible = true },
  }
}

function depth(object: THREE.Object3D) { let d = 0; for (let o = object.parent; o; o = o.parent) d++; return d }
