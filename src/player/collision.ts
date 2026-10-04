import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { Octree } from 'three/addons/math/Octree.js'

type Collider = {
  mesh: THREE.Mesh
  bounds: THREE.Box3
  inverse: THREE.Matrix4
  tree?: Octree
  dynamic: boolean
  /** Last capsule query that tested this collider. */
  query?: number
  blocksSight: boolean
  blocksShots: boolean
}

export type SurfaceHit = {
  distance: number; point: THREE.Vector3; normal: THREE.Vector3; mesh: THREE.Mesh; backFace: boolean
  localPoint: THREE.Vector3; localNormal: THREE.Vector3
}

/** Retain the same contact when a hinge moves during the cosmetic bullet flight. */
export function followSurface(hit: SurfaceHit): SurfaceHit {
  hit.mesh.updateWorldMatrix(true, false)
  return { ...hit, point: hit.localPoint.clone().applyMatrix4(hit.mesh.matrixWorld),
    normal: hit.localNormal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.mesh.matrixWorld)) }
}

const up = new THREE.Vector3(0, 1, 0)
const none: never[] = []
// Shared by every world and region view, because views share collider records.
let queries = 0

/**
 * Does a ray from `o` (with `inv`, the reciprocal of its direction, no component infinite) pass through `box` within
 * `far`? The slab test on plain numbers: Ray.intersectsBox makes garbage on this hot path, and does not stop at `far`.
 */
function rayHitsBox(o: THREE.Vector3, inv: THREE.Vector3, box: THREE.Box3, far: number) {
  let t1 = (box.min.x - o.x) * inv.x, t2 = (box.max.x - o.x) * inv.x
  let near = Math.min(t1, t2), farthest = Math.max(t1, t2)
  t1 = (box.min.y - o.y) * inv.y; t2 = (box.max.y - o.y) * inv.y
  near = Math.max(near, Math.min(t1, t2)); farthest = Math.min(farthest, Math.max(t1, t2))
  t1 = (box.min.z - o.z) * inv.z; t2 = (box.max.z - o.z) * inv.z
  near = Math.max(near, Math.min(t1, t2)); farthest = Math.min(farthest, Math.max(t1, t2))
  return farthest >= Math.max(near, 0) && near <= far
}

const plane = new THREE.Plane(), crossing = new THREE.Vector3(), push = new THREE.Vector3()
const closest1 = new THREE.Vector3(), closest2 = new THREE.Vector3(), lineR = new THREE.Vector3(), lineS = new THREE.Vector3(), lineW = new THREE.Vector3()

/** Octree's lineToLineClosestPoints, the same arithmetic in the same order, into closest1 / closest2. */
function closestPoints(start1: THREE.Vector3, end1: THREE.Vector3, start2: THREE.Vector3, end2: THREE.Vector3) {
  const r = lineR.copy(end1).sub(start1), s = lineS.copy(end2).sub(start2), w = lineW.copy(start2).sub(start1)
  const a = r.dot(s), b = r.dot(r), c = s.dot(s), d = s.dot(w), e = r.dot(w)
  let t1: number, t2: number
  const divisor = b * c - a * a
  if (Math.abs(divisor) < 1e-10) {
    const d1 = -d / c, d2 = (a - d) / c
    if (Math.abs(d1 - 0.5) < Math.abs(d2 - 0.5)) { t1 = 0; t2 = d1 } else { t1 = 1; t2 = d2 }
  } else {
    t1 = (d * a + e * c) / divisor
    t2 = (t1 * a - d) / c
  }
  t2 = Math.max(0, Math.min(1, t2))
  t1 = Math.max(0, Math.min(1, t1))
  closest1.copy(r).multiplyScalar(t1).add(start1)
  closest2.copy(s).multiplyScalar(t2).add(start2)
}

/**
 * Octree.triangleCapsuleIntersect without its allocations: how far the face pushes the capsule out, along `push`
 * (0 when it does not touch it). The same tests in the same order, so its answers are Octree's to the last bit.
 */
function trianglePush(capsule: Capsule, face: THREE.Triangle) {
  face.getPlane(plane)
  const d1 = plane.distanceToPoint(capsule.start) - capsule.radius, d2 = plane.distanceToPoint(capsule.end) - capsule.radius
  if ((d1 > 0 && d2 > 0) || (d1 < -capsule.radius && d2 < -capsule.radius)) return 0
  const delta = Math.abs(d1 / (Math.abs(d1) + Math.abs(d2)))
  if (face.containsPoint(crossing.copy(capsule.start).lerp(capsule.end, delta))) {
    push.copy(plane.normal)
    return Math.abs(Math.min(d1, d2))
  }
  const r2 = capsule.radius * capsule.radius
  for (let edge = 0; edge < 3; edge++) {
    closestPoints(capsule.start, capsule.end, edge === 0 ? face.a : edge === 1 ? face.b : face.c, edge === 0 ? face.b : edge === 1 ? face.c : face.a)
    if (closest1.distanceToSquared(closest2) < r2) {
      push.copy(closest1).sub(closest2).normalize()
      return capsule.radius - closest1.distanceTo(closest2)
    }
  }
  return 0
}

/** Partition triangles without duplicating large coplanar slabs into many octants. */
function collisionTree(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position'), index = geometry.index
  const triangles: THREE.Triangle[] = []
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i + offset) : i + offset))
    const triangle = new THREE.Triangle(vertices[0], vertices[1], vertices[2])
    if (triangle.getArea() > 1e-10) triangles.push(triangle)
  }
  const build = (faces: THREE.Triangle[]): Octree => {
    const box = new THREE.Box3()
    for (const face of faces) box.expandByPoint(face.a).expandByPoint(face.b).expandByPoint(face.c)
    box.expandByScalar(0.00001)
    const tree = new Octree(box)
    if (faces.length <= 24) tree.triangles = faces
    else {
      const size = box.getSize(new THREE.Vector3())
      const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
      faces.sort((a, b) => (a.a[axis] + a.b[axis] + a.c[axis]) - (b.a[axis] + b.b[axis] + b.c[axis]))
      const middle = Math.floor(faces.length / 2)
      tree.subTrees = [build(faces.slice(0, middle)), build(faces.slice(middle))]
    }
    return tree
  }
  const root = new Octree()
  root.subTrees = [build(triangles)]
  return root
}

/** Local-space trees are built only for nearby meshes; moving objects retain their trees. */
export class CollisionWorld {
  private colliders: Collider[] = []
  private proxies: THREE.Mesh[] = []
  private capsule = new Capsule()
  private bounds = new THREE.Box3()
  private movedCapsule = new Capsule()
  private capsuleHit = false
  private movedCenter = new THREE.Vector3()
  private capsuleCenter = new THREE.Vector3()
  private offset = new THREE.Vector3()
  private ray = new THREE.Raycaster()
  private groundRay = new THREE.Ray()
  private normal = new THREE.Vector3()
  private spatialRays = false
  // Faces of the last tree query. Never shortened: `length = 0` frees the backing store and every ray would regrow it.
  private faces: THREE.Triangle[] = []
  private faceCount = 0
  private rayPoint = new THREE.Vector3()
  private nearestPoint = new THREE.Vector3()
  /** The reciprocal of the current local ray's direction, and how far along it a query reaches (local units). */
  private inverseDirection = new THREE.Vector3()
  private localFar = Infinity
  private farPoint = new THREE.Vector3()
  // Static colliders by 8 m XZ cell, so NPC floor probes skip the other ~850 meshes.
  // `wide` holds moving colliders and slabs spanning many cells; both lists are scanned.
  private cells: Map<number, Collider[]> | null = null
  private wide: Collider[] = []
  /** The colliders along the current ray (rayColliders), and how many of the list are in use. */
  private rayList: Collider[] = []
  private rayCount = 0

  constructor(scene: THREE.Object3D) {
    scene.updateWorldMatrix(true, true)
    scene.traverse(object => {
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
        if (parent.userData.noCollision) return
      }
      if (object instanceof THREE.Mesh && !(object.material instanceof THREE.ShaderMaterial)) {
        let dynamic = false
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
          if (parent.userData.doorHinge || parent.userData.dynamicCollision) dynamic = true
        }
        this.add(object, dynamic, object.userData.blocksSight !== false, object.userData.blocksShots !== false)
      }
      for (const panel of object.userData.collisionPanels ?? []) {
        const [ax, az] = panel.a, [bx, bz] = panel.b
        const geometry = new THREE.BoxGeometry(Math.hypot(bx - ax, bz - az), panel.height, 0.06)
        geometry.rotateY(-Math.atan2(bz - az, bx - ax))
        geometry.translate((ax + bx) / 2, panel.height / 2, (az + bz) / 2)
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
        mesh.matrixAutoUpdate = false
        mesh.matrixWorld.copy(object.matrixWorld)
        this.proxies.push(mesh)
        this.add(mesh, false, panel.blocksSight !== false, panel.blocksShots !== false)
      }
    })
  }

  private add(mesh: THREE.Mesh, dynamic: boolean, blocksSight = true, blocksShots = true) {
    mesh.geometry.computeBoundingBox()
    this.colliders.push({ mesh, dynamic, blocksSight, blocksShots,
      bounds: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      inverse: mesh.matrixWorld.clone().invert() })
  }

  private index() {
    if (this.cells) return this.cells
    this.cells = new Map(); this.wide = []
    for (const collider of this.colliders) {
      const { min, max } = collider.bounds
      const x0 = Math.floor(min.x / 8), x1 = Math.floor(max.x / 8), z0 = Math.floor(min.z / 8), z1 = Math.floor(max.z / 8)
      if (collider.dynamic || !((x1 - x0 + 1) * (z1 - z0 + 1) <= 64)) { this.wide.push(collider); continue }
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
        const key = (i + 32768) * 65536 + j + 32768, list = this.cells.get(key)
        if (list) list.push(collider); else this.cells.set(key, [collider])
      }
    }
    return this.cells
  }

  /**
   * The colliders a ray from `origin` along `direction` (unit length) can meet within `far`: the moving and wide ones,
   * and those of each 8 m cell the ray crosses, walked cell by cell (Amanatides and Woo). Rays used to test all of the
   * level's thousands of colliders; most of a long sight line crosses a few cells. Reuses one list.
   */
  private rayColliders(origin: THREE.Vector3, direction: THREE.Vector3, far: number) {
    const cells = this.index(), list = this.rayList, query = ++queries
    let count = 0
    for (let w = 0; w < this.wide.length; w++) { const collider = this.wide[w]; collider.query = query; list[count++] = collider }
    let x = Math.floor(origin.x / 8), z = Math.floor(origin.z / 8)
    const stepX = direction.x > 0 ? 1 : -1, stepZ = direction.z > 0 ? 1 : -1
    const deltaX = Math.abs(direction.x) > 1e-9 ? 8 / Math.abs(direction.x) : Infinity, deltaZ = Math.abs(direction.z) > 1e-9 ? 8 / Math.abs(direction.z) : Infinity
    let nextX = Math.abs(direction.x) > 1e-9 ? ((x + (stepX > 0 ? 1 : 0)) * 8 - origin.x) / direction.x : Infinity
    let nextZ = Math.abs(direction.z) > 1e-9 ? ((z + (stepZ > 0 ? 1 : 0)) * 8 - origin.z) / direction.z : Infinity
    for (let guard = 0; guard < 4096; guard++) {
      const cell = cells.get((x + 32768) * 65536 + z + 32768) ?? none
      for (let c = 0; c < cell.length; c++) {
        const collider = cell[c]
        if (collider.query === query) continue
        collider.query = query
        list[count++] = collider
      }
      if (Math.min(nextX, nextZ) > far) break
      if (nextX < nextZ) { x += stepX; nextX += deltaX } else { z += stepZ; nextZ += deltaZ }
    }
    this.rayCount = count
    return list
  }

  private cell(x: number, z: number) {
    return this.index().get((Math.floor(x / 8) + 32768) * 65536 + Math.floor(z / 8) + 32768) ?? none
  }

  refresh() {
    for (const collider of this.colliders) if (collider.dynamic) {
      collider.mesh.updateWorldMatrix(true, false)
      collider.bounds.copy(collider.mesh.geometry.boundingBox!).applyMatrix4(collider.mesh.matrixWorld)
      collider.inverse.copy(collider.mesh.matrixWorld).invert()
    }
  }

  /** Build, while loading, the few trees (ladder rails, vegetation) whose first sight-line use would cost a 5-25 ms frame. */
  warm() {
    for (const collider of this.colliders) {
      const geometry = collider.mesh.geometry
      if (!collider.dynamic && (geometry.index ?? geometry.getAttribute('position')).count > 9000) this.tree(collider)
    }
  }

  /**
   * Octree.getRayTriangles without its per-ray array and duplicate scan; these trees hold each face in one leaf. Only
   * boxes within the query's reach are visited (see localRay), with a slab test that makes no garbage.
   */
  private collect(tree: Octree, ray: THREE.Ray) {
    // Indexed loops: on this path (thousands of boxes a frame) for...of iterators were most of the game's garbage.
    const subTrees = tree.subTrees
    for (let i = 0; i < subTrees.length; i++) {
      const subTree = subTrees[i], triangles = subTree.triangles
      if (!rayHitsBox(ray.origin, this.inverseDirection, subTree.box!, this.localFar)) continue
      if (triangles.length > 0) for (let j = 0; j < triangles.length; j++) this.faces[this.faceCount++] = triangles[j]
      else this.collect(subTree, ray)
    }
  }

  /** Put the world ray (`this.ray.ray`, reaching `far`) into a collider's own space for collect. */
  private localRay(collider: Collider, far: number) {
    this.groundRay.copy(this.ray.ray).applyMatrix4(collider.inverse)
    const d = this.groundRay.direction
    this.inverseDirection.set(1 / (d.x || 1e-12), 1 / (d.y || 1e-12), 1 / (d.z || 1e-12))
    // Its reach in local units (the collider may be scaled).
    this.localFar = Number.isFinite(far) ? this.farPoint.copy(this.ray.ray.direction).multiplyScalar(far).add(this.ray.ray.origin).applyMatrix4(collider.inverse).distanceTo(this.groundRay.origin) + 1e-4 : Infinity
    this.faceCount = 0
  }

  /**
   * Octree.capsuleIntersect's depth without its allocations: the faces whose boxes the (local) capsule reaches, each
   * pushing it out in turn, and how far it moved in all. Identical to Octree (scripts/collision-index-checks.ts).
   */
  private capsuleDepth(tree: Octree, capsule: Capsule) {
    this.movedCapsule.copy(capsule)
    this.capsuleHit = false
    this.pushOut(tree, capsule)
    if (!this.capsuleHit) return 0
    return this.movedCapsule.getCenter(this.movedCenter).sub(capsule.getCenter(this.capsuleCenter)).length()
  }

  /** capsuleDepth's walk: boxes the unmoved capsule reaches, faces pushing movedCapsule out in turn. */
  private pushOut(node: Octree, capsule: Capsule) {
    const subTrees = node.subTrees
    for (let i = 0; i < subTrees.length; i++) {
      const subTree = subTrees[i], triangles = subTree.triangles
      if (!capsule.intersectsBox(subTree.box!)) continue
      if (triangles.length > 0) {
        for (let j = 0; j < triangles.length; j++) {
          const depth = trianglePush(this.movedCapsule, triangles[j])
          if (depth) { this.capsuleHit = true; this.movedCapsule.translate(push.multiplyScalar(depth)) }
        }
      } else this.pushOut(subTree, capsule)
    }
  }

  private tree(collider: Collider) {
    return collider.tree ??= collisionTree(collider.mesh.geometry)
  }

  private collision(collider: Collider, capsule: Capsule) {
    this.capsule.copy(capsule)
    this.capsule.start.applyMatrix4(collider.inverse)
    this.capsule.end.applyMatrix4(collider.inverse)
    const hit = this.tree(collider).capsuleIntersect(this.capsule)
    if (!hit || hit.depth < 0.00001) return null
    hit.normal.transformDirection(collider.mesh.matrixWorld)
    return hit
  }

  private capsuleBounds(capsule: Capsule) {
    this.bounds.set(capsule.start, capsule.end).expandByScalar(capsule.radius)
    return this.bounds
  }

  fits(capsule: Capsule, ignored: readonly THREE.Object3D[] = none) {
    const bounds = this.capsuleBounds(capsule), cells = this.index(), query = ++queries
    const wide = this.wide
    for (let w = 0; w < wide.length; w++) if (this.obstructs(wide[w], bounds, capsule, ignored)) return false
    for (let i = Math.floor(bounds.min.x / 8); i <= Math.floor(bounds.max.x / 8); i++) {
      for (let j = Math.floor(bounds.min.z / 8); j <= Math.floor(bounds.max.z / 8); j++) {
        const cell = cells.get((i + 32768) * 65536 + j + 32768) ?? none
        for (let c = 0; c < cell.length; c++) {
          const collider = cell[c]
          // A mesh can occupy several of the touched cells.
          if (collider.query === query) continue
          collider.query = query
          if (this.obstructs(collider, bounds, capsule, ignored)) return false
        }
      }
    }
    return true
  }

  private obstructs(collider: Collider, bounds: THREE.Box3, capsule: Capsule, ignored: readonly THREE.Object3D[]) {
    if (!bounds.intersectsBox(collider.bounds)) return false
    for (let object: THREE.Object3D | null = collider.mesh; object; object = object.parent) {
      if (ignored.includes(object)) return false
    }
    // The capsule in the collider's space, for Octree's overlap test minus its garbage (the player's own physics, in
    // resolve, still uses Octree.capsuleIntersect for the push-out).
    this.capsule.copy(capsule)
    this.capsule.start.applyMatrix4(collider.inverse)
    this.capsule.end.applyMatrix4(collider.inverse)
    return this.capsuleDepth(this.tree(collider), this.capsule) > 0.008
  }

  resolve(capsule: Capsule, velocity: THREE.Vector3) {
    let grounded = false
    for (let pass = 0; pass < 3; pass++) {
      let touched = false
      for (const collider of this.colliders) {
        if (!this.capsuleBounds(capsule).intersectsBox(collider.bounds)) continue
        const hit = this.collision(collider, capsule)
        if (!hit) continue
        touched = true
        if (hit.normal.y > 0.55) grounded = true
        capsule.translate(this.offset.copy(hit.normal).multiplyScalar(hit.depth + 0.00001))
        const intoSurface = velocity.dot(hit.normal)
        if (intoSurface < 0) velocity.addScaledVector(hit.normal, -intoSurface)
      }
      if (!touched) break
    }
    return grounded
  }

  /** Small support footprint handles stair treads and the edges of platforms. */
  floor(position: THREE.Vector3, above: number, below: number, radius = 0) {
    let height = -Infinity
    const top = position.y + above, bottom = top - (above + below), samples = radius ? 5 : 1
    for (let sample = 0; sample < samples; sample++) {
      // Centre, then ±X and ±Z of the support footprint.
      const x = position.x + (sample === 1 ? radius : sample === 2 ? -radius : 0)
      const z = position.z + (sample === 3 ? radius : sample === 4 ? -radius : 0)
      this.ray.ray.origin.set(x, top, z)
      this.ray.ray.direction.set(0, -1, 0)
      this.ray.near = 0
      this.ray.far = above + below
      const local = this.cell(x, z)
      for (let pass = 0; pass < 2; pass++) for (let c = 0, list = pass ? local : this.wide; c < list.length; c++) {
        const collider = list[c]
        // A vertical ray meets a box exactly when its column does.
        const { min, max } = collider.bounds
        if (max.y < bottom || min.y > top || x < min.x || x > max.x || z < min.z || z > max.z) continue
        this.localRay(collider, this.ray.far)
        this.collect(this.tree(collider), this.groundRay)
        // Octree.rayIntersect's nearest front face, with its arithmetic, minus its allocations.
        let nearest: THREE.Triangle | null = null, distance = 1e100
        for (let i = 0; i < this.faceCount; i++) {
          const face = this.faces[i]
          if (!this.groundRay.intersectTriangle(face.a, face.b, face.c, true, this.rayPoint)) continue
          const along = this.rayPoint.sub(this.groundRay.origin).length()
          if (distance > along) { distance = along; nearest = face; this.nearestPoint.copy(this.rayPoint).add(this.groundRay.origin) }
        }
        if (!nearest || distance > this.ray.far) continue
        nearest.getNormal(this.normal).transformDirection(collider.mesh.matrixWorld)
        if (this.normal.dot(up) > 0.55) height = Math.max(height, this.nearestPoint.applyMatrix4(collider.mesh.matrixWorld).y)
      }
    }
    return height
  }

  visible(from: THREE.Vector3, to: THREE.Vector3, target: THREE.Object3D) {
    this.ray.ray.origin.copy(from)
    this.ray.ray.direction.copy(to).sub(from).normalize()
    this.ray.near = 0.02
    this.ray.far = Math.max(0.02, from.distanceTo(to) - 0.06)
    const candidates = this.rayColliders(this.ray.ray.origin, this.ray.ray.direction, this.ray.far)
    for (let c = 0; c < this.rayCount; c++) {
      const collider = candidates[c]
      if (!collider.blocksSight) continue
      let ignored = false
      for (let object: THREE.Object3D | null = collider.mesh; object; object = object.parent) {
        if (object === target) { ignored = true; break }
      }
      if (!ignored && this.reaches(collider) && this.blocksRay(collider)) return false
    }
    return true
  }

  /** The ray is unbounded for Ray.intersectsBox; a 0.3 m muzzle probe must not visit everything along its line. */
  private reaches(collider: Collider) {
    return collider.bounds.distanceToPoint(this.ray.ray.origin) <= this.ray.far + 1e-4 && this.ray.ray.intersectsBox(collider.bounds)
  }

  /** Mesh.raycast visits every triangle, so large fixed meshes (ladders, vegetation, catwalks) use their triangle tree. */
  private large(collider: Collider) {
    const geometry = collider.mesh.geometry
    return !collider.dynamic && (geometry.index ?? geometry.getAttribute('position')).count > 768
  }

  /** Any face between the ray's near and far, with Mesh.raycast's per-face test. */
  private blocksRay(collider: Collider) {
    const { mesh } = collider, material = mesh.material
    if (Array.isArray(material) || !this.large(collider)) return this.ray.intersectObject(mesh, false).length > 0
    this.localRay(collider, this.ray.far)
    this.collect(this.tree(collider), this.groundRay)
    for (let i = 0; i < this.faceCount; i++) {
      const face = this.faces[i]
      const hit = material.side === THREE.BackSide ? this.groundRay.intersectTriangle(face.c, face.b, face.a, true, this.rayPoint) :
        this.groundRay.intersectTriangle(face.a, face.b, face.c, material.side === THREE.FrontSide, this.rayPoint)
      if (!hit) continue
      const along = hit.applyMatrix4(mesh.matrixWorld).distanceTo(this.ray.ray.origin)
      if (along >= this.ray.near && along <= this.ray.far) return true
    }
    return false
  }

  /** Nearest ballistic surface. Wire panels block bodies, but let shots pass. */
  rayDistance(origin: THREE.Vector3, direction: THREE.Vector3, range: number) {
    this.ray.set(origin, direction)
    this.ray.near = 0.01
    this.ray.far = range
    let distance = range
    const candidates = this.rayColliders(origin, this.ray.ray.direction, range)
    for (let c = 0; c < this.rayCount; c++) {
      const collider = candidates[c]
      if (!collider.blocksShots) continue
      if (!this.reaches(collider)) continue
      if ((this.spatialRays || this.large(collider)) && !Array.isArray(collider.mesh.material)) {
        this.localRay(collider, distance)
        this.collect(this.tree(collider), this.groundRay)
        const side = collider.mesh.material.side
        for (let i = 0; i < this.faceCount; i++) {
          const face = this.faces[i]
          const hit = side === THREE.BackSide ? this.groundRay.intersectTriangle(face.c, face.b, face.a, true, this.rayPoint) :
            this.groundRay.intersectTriangle(face.a, face.b, face.c, side !== THREE.DoubleSide, this.rayPoint)
          if (!hit) continue
          const along = hit.applyMatrix4(collider.mesh.matrixWorld).distanceTo(origin)
          if (along >= this.ray.near && along < distance) distance = along
        }
        continue
      }
      const hit = this.ray.intersectObject(collider.mesh, false)[0]
      if (hit && hit.distance < distance) distance = hit.distance
    }
    return distance
  }

  /** Ballistic contact with the actual face normal, including hinged objects. */
  raySurface(origin: THREE.Vector3, direction: THREE.Vector3, range: number): SurfaceHit | null {
    this.ray.set(origin, direction)
    this.ray.near = 0.01
    this.ray.far = range
    let closest: SurfaceHit | null = null
    const candidates = this.rayColliders(origin, this.ray.ray.direction, range)
    for (let c = 0; c < this.rayCount; c++) {
      const collider = candidates[c]
      if (!collider.blocksShots || !this.reaches(collider)) continue
      const hit = this.ray.intersectObject(collider.mesh, false)[0]
      if (!hit?.face || hit.distance >= (closest?.distance ?? range)) continue
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(collider.mesh.matrixWorld))
      const backFace = normal.dot(direction) > 0
      if (backFace) normal.negate()
      closest = { distance: hit.distance, point: hit.point, normal, mesh: collider.mesh, backFace,
        localPoint: hit.point.clone().applyMatrix4(collider.inverse),
        localNormal: hit.face.normal.clone().multiplyScalar(backFace ? -1 : 1) }
    }
    return closest
  }

  /** Local triangles for a small decal; never scan/project a whole batched building. */
  surfacePatch(hit: SurfaceHit, radius: number) {
    const collider = this.colliders.find(candidate => candidate.mesh === hit.mesh)
    const geometry = new THREE.BufferGeometry(), positions: number[] = [], normals: number[] = []
    if (collider) {
      const sphere = new THREE.Sphere(hit.point.clone(), radius).applyMatrix4(collider.inverse)
      const triangles: THREE.Triangle[] = []
      this.tree(collider).getSphereTriangles(sphere, triangles)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.mesh.matrixWorld)
      for (const triangle of triangles) {
        const normal = triangle.getNormal(new THREE.Vector3())
        const facing = normal.clone().applyNormalMatrix(normalMatrix).dot(hit.normal) * (hit.backFace ? -1 : 1)
        if (facing < 0.2 || triangle.closestPointToPoint(sphere.center, this.rayPoint).distanceToSquared(sphere.center) > sphere.radius ** 2) continue
        for (const point of [triangle.a, triangle.b, triangle.c]) {
          positions.push(point.x, point.y, point.z); normals.push(normal.x, normal.y, normal.z)
        }
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    return geometry
  }

  /** A local query view shares geometry/trees, but never owns their resources.
   * Dynamic leaves stay enrolled even outside the region because doors can swing in.
   * Callers must keep their entire query inside bounds; the main world's refresh
   * updates the shared dynamic matrices before any view is used. */
  region(bounds: THREE.Box3) {
    const view = new CollisionWorld(new THREE.Group())
    view.spatialRays = true
    view.colliders = this.colliders.filter(collider => collider.dynamic || bounds.intersectsBox(collider.bounds))
    view.cells = null
    return view
  }

  dispose() {
    for (const mesh of this.proxies) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.colliders = []
    this.cells = null
    this.proxies = []
  }
}
