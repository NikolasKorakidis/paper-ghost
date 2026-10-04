import * as THREE from 'three'

/**
 * Real coloured light from neon signs, in a world that is otherwise drawn unlit.
 *
 * Every MeshBasicMaterial (paper fills, furniture, guns, arms, characters) is shaded by the NEON_MAX lights
 * nearest the player; any number of signs can exist. Each light is a glowing line the length of its tubes and
 * is integrated along that line, so a wall right behind the tubes gets a bright band that fades smoothly, the
 * floor gets a broad pool, and surfaces facing away stay dark apart from a little bounced light. Shiny
 * surfaces catch a highlight that moves with the view, and a cube shadow map per light lets chairs, tables,
 * doors and guards block it. Ink strokes and outlines stay black.
 *
 * The lighting is patched into Three's shared "basic" shader once, on import, so it covers materials created
 * anywhere without touching them. Uniform values are typed arrays and an array-like of fixed textures: Three
 * clones a built-in material's uniforms but keeps those by reference, so one update reaches every material.
 * A material opts out with `defines.NEON_UNLIT` (it keeps its own colour under any light, in any room, but still
 * casts shadows) and sets its shine with `defines.NEON_SHINE` (default 0.3).
 * A light is any object with `userData.neonLight` (signs, screens, doorways: see neon-sign.ts, world/lights.ts).
 *
 * A dark room (`userData.darkRoom`, an oriented box) has no daylight at all: inside it, surfaces show only the
 * light that actually reaches them, so a screen or an open doorway is all you see by. A surface counts as inside
 * when the side you are looking at faces into the box, so a wall is dark inside and still lit outside.
 *
 * Windows: a light can be a row of windows (`window`). Besides its soft skylight it lets in the sun: for each
 * pixel the shader follows the ray toward the sun back to the wall, and where that ray passes through a pane the
 * pixel is in a sun patch. That gives exact, window-shaped sunbeams on floors, furniture and the player's hands,
 * with edges that soften with distance from the window like a real penumbra, and no extra shadow pass: the
 * window light's own cube shadow stands in for whatever blocks the beam. Only windows on the sunny side get them.
 * Every source also bounces a little of its light around the room (`bounce`), so between lamps a room is dim,
 * not black. Materials set their gloss with `defines.NEON_GLOSS` (highlight sharpness, default 28), and
 * `defines.NEON_METAL` adds edge reflections of the room's light, for guns and blades.
 */
export const NEON_MAX = 10
/**
 * Beyond the NEON_MAX shadowed lights, this many more outdoor lights shine with no shadows, out to FAR_LIMIT
 * metres: signs across the yard keep their glow and blend with the ones nearby instead of switching off with
 * distance. They never light inside a dark room (they have no shadows to stop them at its walls), and lights that
 * belong inside a building are never far lights.
 */
export const NEON_FAR = 16
const FAR_LIMIT = 220
/** Dark rooms that can be in effect at once. */
export const NEON_DARK_MAX = 5
const SHADOW_SIZE = 256
/**
 * A light near the player re-renders its shadows at most this often (s), one light per frame, and only when
 * something that moves (a guard, a door, a crate) has really moved within its reach, and then only the cube
 * faces that can see it. Lamps and windows never move, so a still room costs no shadow rendering at all.
 */
const SHADOW_INTERVAL = 0.1
/** A light taking a free slot as the player walks fades up over this long (s), so lights never pop on. */
const FADE_IN = 0.35
/** Movement smaller than this (m), such as a guard breathing, leaves a shadow as it is. */
const MOVER_STEP = 0.05
/** How far round a mover's middle its shadow can change (m): a person, a door leaf, a crate. */
const MOVER_RADIUS = 1.1
/** Cube faces in CubeCamera order: +x, -x, +y, -y, +z, -z. */
const ALL_FACES = [0, 1, 2, 3, 4, 5]
/** A new light's shadow is drawn this many cube faces a frame, so lights coming on together don't stall one frame. */
const NEW_FACES_PER_FRAME = 2
/** How often the meshes that can cast shadows are collected again (s). */
const CASTER_INTERVAL = 1
/** Signs further than this from the player are not lit at all (m). */
const VIEW_LIMIT = 90
/**
 * Choosing which lights get the shadowed slots. A light keeps its slot until another is clearly more important (by
 * HOLD metres of priority), so lights at the edge of the choice do not swap back and forth as you walk, losing and
 * redrawing their shadows and fading up again each time. Lights in a room other than the one you are in (or indoor
 * lights while you are outdoors) are seen only through doors and windows, so they count as ELSEWHERE metres further.
 */
const HOLD = 2
const ELSEWHERE = 6
/** A dark room in effect stays in effect until another is this much nearer (m), so interiors do not pop to daylight. */
const ROOM_HOLD = 1.5
/** A light this far from the player (m) redraws its shadows for movement less often, SLOW_SHADOW_INTERVAL (s). */
const NEAR_SHADOWS = 7
const SLOW_SHADOW_INTERVAL = 0.25
/** The whole scene is searched for new shadow casters this often (s); a change of lights only re-sorts the last search. */
const CANDIDATE_INTERVAL = 3

export type NeonLightSpec = {
  /** Tube line ends in the sign's local space. The light shines toward the sign's local +Z. */
  start: THREE.Vector3Tuple
  end: THREE.Vector3Tuple
  color: number
  /** Overall brightness; about 5 lights the floor three metres below well. */
  intensity: number
  /** Nothing is lit beyond this distance (m). */
  range: number
  /** How far the tubes stand off the wall they hang on (m); nothing behind that wall is lit. */
  standoff: number
  /** Scales the brightness each frame, 0 (off) to 1; a doorway's light follows how far its door is open. */
  dimmer?: () => number
  /** Light bounced around the room, as a fraction of the direct light (default 0.06). */
  bounce?: number
  /**
   * How big the glowing thing is across its line (m): a tube a few centimetres, a window half its height, a doorway
   * half its width. Light right beside it is capped by its size, as a real lamp or window is, instead of growing
   * without limit as a point would; without it, anything touching the line (a shelf between two windows, the wall at
   * a corner) gets a hot spot. Default 0.05.
   */
  radius?: number
  /**
   * Where its shadows are seen from, in the sign's local space (default: the middle of the line). Put it in open
   * space in the room the light shines into: a window's is in front of a pane, not inside the shelf between two.
   */
  shadowFrom?: THREE.Vector3Tuple
  /**
   * The light comes through a row of up to four equal windows along the light's line, each `width` × `height`,
   * centred `offsets` metres along the line from its middle (and on its height). `sun` is how strong the
   * sunbeams through them are. A window row gives its light only through the panes, not along the wall between.
   */
  window?: { width: number; height: number; offsets: number[]; sun: number }
  /**
   * A burst (a flashbang): it comes on at full strength at once, with all its shadows drawn that frame (so it never
   * shines through a wall), and it takes a slot before any other light.
   */
  instant?: boolean
  /**
   * Shines without shadows (a muzzle flash, too brief and too frequent to draw shadows for): it never takes a
   * shadowed slot, and comes first among the distant lights, which keep to their own rooms, so it still never shines
   * through a wall into the next room.
   */
  shadowless?: boolean
}

/**
 * Lights that come and go during play (a flashbang's burst). Add the object to the scene and to this set, and take it
 * out of both when it is done: every NeonLights picks the change up on its next update.
 */
export const transientLights = new Set<THREE.Object3D>()

/** A burst of light: its colour, brightness and reach, how long it lasts, and whether it casts shadows. */
export type BurstOptions = { color: number; intensity: number; range: number; life: number; shadows?: boolean; hold?: number; radius?: number }

/**
 * A light that flares and dies away by itself: a muzzle flash, an explosion. Full for \`hold\` seconds, then falling
 * away to nothing by the end of its \`life\`. It needs nothing from the caller after this: every NeonLights lights the
 * world with it while it lasts, and lets it go after.
 */
export function lightBurst(position: THREE.Vector3, options: BurstOptions, now = performance.now() / 1000) {
  const light = new THREE.Object3D()
  light.name = 'Burst of light'
  light.position.copy(position)
  // Pointing down with its cut-off plane well above: it lights every way but up through a floor.
  light.rotation.x = Math.PI / 2
  light.updateMatrixWorld()
  const { life, hold = Math.min(0.04, life * 0.3) } = options
  const burst = { born: now, life, age: 0 }
  light.userData.burst = burst
  light.userData.neonLight = { start: [-0.03, 0, 0], end: [0.03, 0, 0], color: options.color, intensity: options.intensity, range: options.range,
    standoff: Math.max(3, options.range * 0.4), radius: options.radius ?? 0.12, bounce: 0.18, instant: true, shadowless: !options.shadows,
    dimmer: () => burst.age < hold ? 1 : Math.exp(-(burst.age - hold) * 6 / Math.max(life - hold, 1e-3)) * (1 - THREE.MathUtils.smoothstep(burst.age, life * 0.8, life)) } satisfies NeonLightSpec
  transientLights.add(light)
  return light
}

/** Where the sun is (a direction toward it) and its warm colour. Low in the south-west: long afternoon beams. */
export const SUN_DIRECTION = new THREE.Vector3(-0.5, 0.58, 0.64).normalize()
export const SUN_COLOR = new THREE.Color(1, 0.86, 0.66)

/**
 * A dark room: a box of this half size around its object's origin, in the object's frame. `ambient` is how much
 * light is left with no source (0 is black; a daylit hall is dim, not black). `pitch` gives it a gabled top
 * instead of a flat one: `ridge` metres above the origin along the middle (local z = 0), falling `slope`
 * metres for every metre out along ±z, to follow a pitched roof.
 */
export type DarkRoomSpec = { half: THREE.Vector3Tuple; ambient?: number; pitch?: { ridge: number; slope: number } }

const shadowTargets = Array.from({ length: NEON_MAX }, () =>
  new THREE.WebGLCubeRenderTarget(SHADOW_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false }))
// Array-like, not an Array: Three clones arrays of textures per material, which would drop render targets.
const shadowTextures: ArrayLike<THREE.Texture> = Object.assign({ length: NEON_MAX }, shadowTargets.map(target => target.texture))

/** Exported for checks. */
export const neonUniforms = {
  neonStart: { value: new Float32Array(NEON_MAX * 3) },
  neonEnd: { value: new Float32Array(NEON_MAX * 3) },
  neonFacing: { value: new Float32Array(NEON_MAX * 3) },
  neonColor: { value: new Float32Array(NEON_MAX * 3) },
  // Where each light's shadows are seen from.
  neonOrigin: { value: new Float32Array(NEON_MAX * 3) },
  // intensity, range, shadows ready (0/1), standoff
  neonParams: { value: new Float32Array(NEON_MAX * 4) },
  neonShadow: { value: shadowTextures },
  // World to room-box space, and the box's half size (zero when the slot is unused).
  neonDarkMatrix: { value: new Float32Array(NEON_DARK_MAX * 16) },
  neonDarkHalf: { value: new Float32Array(NEON_DARK_MAX * 3) },
  // Top at the middle, its fall per metre along ±z, and the room's ambient light.
  neonDarkRoof: { value: new Float32Array(NEON_DARK_MAX * 4) },
  // Window rows: half width, half height, window count (0 when the light is no window), sun; the windows' centres
  // along the line; and each light's bounce and size.
  neonWindow: { value: new Float32Array(NEON_MAX * 4) },
  neonWindowOffsets: { value: new Float32Array(NEON_MAX * 4) },
  neonWindowExtra: { value: new Float32Array(NEON_MAX * 4) },
  // Far lights: line ends, facing, colour, and intensity, range, standoff, bounce (intensity 0 when unused).
  neonFarStart: { value: new Float32Array(NEON_FAR * 3) },
  neonFarEnd: { value: new Float32Array(NEON_FAR * 3) },
  neonFarFacing: { value: new Float32Array(NEON_FAR * 3) },
  neonFarColor: { value: new Float32Array(NEON_FAR * 3) },
  neonFarParams: { value: new Float32Array(NEON_FAR * 4) },
  neonFarRooms: { value: new Float32Array(NEON_FAR) },
  neonFarWindow: { value: new Float32Array(NEON_FAR) },
  neonFarBounds: { value: new Float32Array(NEON_FAR * 4) },
  neonFarRadius: { value: new Float32Array(NEON_FAR) },
  neonSun: { value: new Float32Array(SUN_DIRECTION.toArray()) },
  neonSunColor: { value: new Float32Array(SUN_COLOR.toArray()) },
}

const chunks = THREE.ShaderChunk as Record<string, string>
const neonCommon = /* glsl */`
varying vec3 vNeonWorld;
varying vec3 vNeonNormal;
`

chunks.neon_dark_pars = /* glsl */`
uniform mat4 neonDarkMatrix[ ${NEON_DARK_MAX} ];
uniform vec3 neonDarkHalf[ ${NEON_DARK_MAX} ];
uniform vec4 neonDarkRoof[ ${NEON_DARK_MAX} ];

// How far a point is inside each dark room in effect (0 outside, 1 inside, blended over a couple of centimetres at its
// walls), one value per room.
struct NeonRoomSet { float v[ ${NEON_DARK_MAX} ]; };
NeonRoomSet neonRooms( vec3 p ) {
  NeonRoomSet rooms;
  #pragma unroll_loop_start
  for ( int i = 0; i < ${NEON_DARK_MAX}; i ++ ) {
    rooms.v[ i ] = 0.0;
    if ( neonDarkHalf[ i ].x > 0.0 ) {
      vec3 local = ( neonDarkMatrix[ i ] * vec4( p, 1.0 ) ).xyz;
      float top = neonDarkRoof[ i ].x - neonDarkRoof[ i ].y * abs( local.z );
      vec3 room = vec3( neonDarkHalf[ i ].x - abs( local.x ), min( local.y + neonDarkHalf[ i ].y, top - local.y ), neonDarkHalf[ i ].z - abs( local.z ) );
      vec3 inside = smoothstep( vec3( -0.02 ), vec3( 0.02 ), room );
      rooms.v[ i ] = inside.x * inside.y * inside.z;
    }
  }
  #pragma unroll_loop_end
  return rooms;
}

// How dark it is at p: x is 1 inside a dark room and 0 outside; y is that room's ambient light.
vec2 neonDarknessIn( NeonRoomSet rooms ) {
  vec2 dark = vec2( 0.0 );
  #pragma unroll_loop_start
  for ( int i = 0; i < ${NEON_DARK_MAX}; i ++ ) {
    if ( rooms.v[ i ] > dark.x ) dark = vec2( rooms.v[ i ], neonDarkRoof[ i ].z );
  }
  #pragma unroll_loop_end
  return dark;
}
vec2 neonDarkness( vec3 p ) { return neonDarknessIn( neonRooms( p ) ); }
`
chunks.neon_pars_vertex = neonCommon
chunks.neon_vertex = /* glsl */`
  // World position and normal from the view-space ones, so instancing and skinning are already applied.
  mat3 neonViewToWorld = transpose( mat3( viewMatrix ) );
  vNeonWorld = neonViewToWorld * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
  #if defined( USE_ENVMAP ) || defined( USE_SKINNING )
    vNeonNormal = neonViewToWorld * transformedNormal;
  #else
    vec3 neonObjectNormal = normal;
    #ifdef USE_INSTANCING
      neonObjectNormal = mat3( instanceMatrix ) * neonObjectNormal;
    #endif
    vNeonNormal = neonViewToWorld * ( normalMatrix * neonObjectNormal );
  #endif
`
chunks.neon_pars_fragment = neonCommon + /* glsl */`
uniform vec3 neonStart[ ${NEON_MAX} ];
uniform vec3 neonEnd[ ${NEON_MAX} ];
uniform vec3 neonFacing[ ${NEON_MAX} ];
uniform vec3 neonColor[ ${NEON_MAX} ];
uniform vec3 neonOrigin[ ${NEON_MAX} ];
uniform vec4 neonParams[ ${NEON_MAX} ];
uniform samplerCube neonShadow[ ${NEON_MAX} ];
uniform vec4 neonWindow[ ${NEON_MAX} ];
uniform vec4 neonWindowOffsets[ ${NEON_MAX} ];
uniform vec4 neonWindowExtra[ ${NEON_MAX} ];
uniform vec3 neonFarStart[ ${NEON_FAR} ];
uniform vec3 neonFarEnd[ ${NEON_FAR} ];
uniform vec3 neonFarFacing[ ${NEON_FAR} ];
uniform vec3 neonFarColor[ ${NEON_FAR} ];
uniform vec4 neonFarParams[ ${NEON_FAR} ];
// Which dark rooms in effect each far light is inside, as bits (0 outdoors); and 1 for a window row, 0 otherwise.
uniform float neonFarRooms[ ${NEON_FAR} ];
uniform float neonFarWindow[ ${NEON_FAR} ];
// A sphere round each far light that holds everything it reaches: centre, and radius squared.
uniform vec4 neonFarBounds[ ${NEON_FAR} ];
uniform float neonFarRadius[ ${NEON_FAR} ];
uniform vec3 neonSun;
uniform vec3 neonSunColor;
#include <neon_dark_pars>
#ifndef NEON_SHINE
  #define NEON_SHINE 0.3
#endif
#ifndef NEON_GLOSS
  #define NEON_GLOSS 28.0
#endif
// How quickly a highlight reaches full strength as the light gets brighter: metal glints even in a weak light.
#ifndef NEON_GLINT
  #define NEON_GLINT 0.5
#endif

// How much of a pixel the sun reaches through a row of windows (0 to 1), before shadows: follow the ray toward
// the sun back to the window wall and see whether it passes through a pane. The edge softens with the distance
// travelled from the window, like the penumbra of the real sun.
float neonSunThrough( vec3 p, vec3 center, vec3 axis, vec3 facing, vec4 window, vec4 offsets ) {
  float sunIn = -dot( neonSun, facing );
  float depthIn = dot( p - center, facing );
  if ( sunIn < 0.03 || depthIn < 0.0 ) return 0.0;
  float travel = depthIn / sunIn;
  vec3 hit = p + neonSun * travel - center;
  float u = dot( hit, axis ), v = dot( hit, cross( facing, axis ) );
  // Distance across the row to the nearest pane's middle.
  float x = abs( u - offsets.x );
  if ( window.z > 1.5 ) x = min( x, abs( u - offsets.y ) );
  if ( window.z > 2.5 ) x = min( x, abs( u - offsets.z ) );
  if ( window.z > 3.5 ) x = min( x, abs( u - offsets.w ) );
  float soft = 0.012 + travel * 0.009;
  return ( 1.0 - smoothstep( window.x - soft, window.x + soft, x ) )
    * ( 1.0 - smoothstep( window.y - soft, window.y + soft, abs( v ) ) );
}

// Soft shadow from the cube map around the light's shadow point: up to eight taps on a disc, turned per pixel so the
// edge dithers smoothly instead of stepping. The first four (spread over the whole disc) settle most pixels, which
// are fully lit or fully shadowed; only near a shadow's edge are the other four taken, and only within 7 m of the
// light (further off, a shadow's edge is a few pixels wide and four taps draw it as well).
// The bias must stay thinner than a wall (14 cm), or light seeps through to the far side and along the foot of the
// wall. \`facing\` is signed: a surface turned away from the light can only be reached through its own wall, so it
// takes just a small bias; a surface facing it takes one that grows with distance and obliqueness (where a cube map's
// texels stretch), capped below a wall's thickness. The disc stops widening past 4 m (about 8 cm across), so far
// surfaces do not need a bigger bias to clear it.
float neonShadowAt( samplerCube map, vec3 fromCenter, float range, float facing ) {
  float dist = length( fromCenter );
  float bias = facing <= 0.0 ? 0.03 : min( ( 0.015 + 0.006 * dist ) * ( 1.0 + 2.0 * ( 1.0 - facing ) ), 0.11 );
  float depth = ( dist - bias ) / range;
  vec3 dir = fromCenter / max( dist, 1e-4 );
  vec3 side = normalize( cross( dir, abs( dir.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
  vec3 up = cross( dir, side );
  float turn = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float spread = 0.02 * min( 1.0, 4.0 / max( dist, 1e-3 ) );
  float lit = 0.0;
  // Taps 0, 2, 4, 6 first (inner to outer), then 1, 3, 5, 7.
  for ( int pass = 0; pass < 2; pass ++ ) {
    for ( int n = 0; n < 4; n ++ ) {
      float k = float( n * 2 + pass );
      float r = sqrt( ( k + 0.5 ) / 8.0 ) * spread;
      float a = k * 2.3999632 + turn;
      lit += step( depth, textureLod( map, dir + ( side * cos( a ) + up * sin( a ) ) * r, 0.0 ).r );
    }
    if ( pass == 0 && ( lit < 0.5 || lit > 3.5 || dist > 7.0 ) ) return lit / 4.0;
  }
  return lit / 8.0;
}

// Light from a uniformly glowing line, per unit of its total brightness: the integral of 1/d² along it.
// Far away this is the usual 1/d²; beside a long tube it falls off only as 1/h, which is what gives a wall
// behind a sign its smooth band instead of a hot spot. \`radius\` is how big the glowing thing is across the line:
// closer than that, the light stops growing, as beside a real window or lamp.
float neonLineFactor( vec3 p, vec3 start, vec3 end, float radius ) {
  vec3 segment = end - start;
  float len = length( segment );
  vec3 fromStart = start - p;
  float soft = max( radius * radius, 0.0025 );
  if ( len < 1e-3 ) return 1.0 / ( dot( fromStart, fromStart ) + soft );
  vec3 u = segment / len;
  float t0 = dot( fromStart, u );
  vec3 perpendicular = fromStart - u * t0;
  float h = sqrt( dot( perpendicular, perpendicular ) + soft );
  return ( atan( ( t0 + len ) / h ) - atan( t0 / h ) ) / ( h * len );
}

// A row of windows lets light in only through its panes: the line factor of each pane (\`window\`: half width, half
// height, count; \`offsets\`: the panes' middles along the row, from its middle), weighted by its share of the glass.
float neonPanesFactor( vec3 p, vec3 start, vec3 end, vec4 window, vec4 offsets, float radius ) {
  vec3 axis = end - start;
  vec3 u = axis / max( length( axis ), 1e-4 );
  vec3 middle = ( start + end ) * 0.5;
  float paneHalf = window.x * 0.9;
  float sum = neonLineFactor( p, middle + u * ( offsets.x - paneHalf ), middle + u * ( offsets.x + paneHalf ), radius );
  if ( window.z > 1.5 ) sum += neonLineFactor( p, middle + u * ( offsets.y - paneHalf ), middle + u * ( offsets.y + paneHalf ), radius );
  if ( window.z > 2.5 ) sum += neonLineFactor( p, middle + u * ( offsets.z - paneHalf ), middle + u * ( offsets.z + paneHalf ), radius );
  if ( window.z > 3.5 ) sum += neonLineFactor( p, middle + u * ( offsets.w - paneHalf ), middle + u * ( offsets.w + paneHalf ), radius );
  return sum / window.z;
}
`
chunks.neon_fragment = /* glsl */`
#ifndef NEON_UNLIT
{
  float neonNormalLength = length( vNeonNormal );
  vec3 neonView = normalize( cameraPosition - vNeonWorld );
  // Double-sided surfaces light the side you are looking at.
  vec3 neonN = neonNormalLength > 1e-4 ? vNeonNormal / neonNormalLength * ( gl_FrontFacing ? 1.0 : -1.0 ) : neonView;
  vec3 neonAlbedo = outgoingLight;
  vec3 neonTint = vec3( 0.0 );
  vec3 neonGloss = vec3( 0.0 );
  float neonTotal = 0.0;
  // Which dark rooms this surface is in, how dark it is here, and that room's ambient light.
  NeonRoomSet neonHere = neonRooms( vNeonWorld + neonN * 0.1 );
  vec2 neonDark = neonDarknessIn( neonHere );
  #pragma unroll_loop_start
  for ( int i = 0; i < ${NEON_MAX}; i ++ ) {
    if ( neonParams[ i ].x > 0.0 ) {
      vec3 segment = neonEnd[ i ] - neonStart[ i ];
      float along = clamp( dot( vNeonWorld - neonStart[ i ], segment ) / max( dot( segment, segment ), 1e-6 ), 0.0, 1.0 );
      vec3 toLight = neonStart[ i ] + segment * along - vNeonWorld;
      float dist = length( toLight );
      float range = neonParams[ i ].y;
      // Only the room in front of the sign: the wall it hangs on stops it lighting the other side.
      float front = smoothstep( -0.01, 0.02, dot( vNeonWorld - neonStart[ i ], neonFacing[ i ] ) + neonParams[ i ].w + 0.02 );
      if ( dist < range && front > 0.0 ) {
        vec3 L = toLight / max( dist, 1e-4 );
        float window = pow( clamp( 1.0 - pow( dist / range, 4.0 ), 0.0, 1.0 ), 2.0 );
        float reach = neonParams[ i ].x * window * front * ( neonWindow[ i ].z > 0.0
          ? neonPanesFactor( vNeonWorld, neonStart[ i ], neonEnd[ i ], neonWindow[ i ], neonWindowOffsets[ i ], neonWindowExtra[ i ].y )
          : neonLineFactor( vNeonWorld, neonStart[ i ], neonEnd[ i ], neonWindowExtra[ i ].y ) );
        float facing = max( dot( neonN, L ), 0.0 );
        float bounce = neonWindowExtra[ i ].x > 0.0 ? neonWindowExtra[ i ].x : 0.06;
        // Daylight comes in through the opening, so it only grazes the window's own wall: fade it out over the
        // first quarter metre in front of that wall instead of painting a bright band along it.
        if ( neonWindow[ i ].z > 0.0 ) reach *= smoothstep( 0.04, 0.25, dot( vNeonWorld - neonStart[ i ], neonFacing[ i ] ) );
        // Sunbeams through a row of windows do not fade with distance, so they are found first (cheaply).
        float beam = neonWindow[ i ].z > 0.0 ? neonSunThrough( vNeonWorld, ( neonStart[ i ] + neonEnd[ i ] ) * 0.5,
          segment / max( length( segment ), 1e-4 ), neonFacing[ i ], neonWindow[ i ], neonWindowOffsets[ i ] ) * neonWindow[ i ].w : 0.0;
        float potential = reach * ( facing + bounce );
        // A light too faint here to see skips its shadow lookup: most of a room is near only a few of its lights.
        if ( potential > 0.002 || beam > 0.0 ) {
          float shade = 1.0;
          if ( neonParams[ i ].z > 0.5 ) {
            // The point is nudged off its surface (further for far lights, whose texels are bigger) before the test.
            float signedFacing = dot( neonN, L );
            vec3 fromCenter = vNeonWorld + neonN * ( 0.03 + 0.004 * dist ) * step( 0.0, signedFacing ) - neonOrigin[ i ];
            shade = neonShadowAt( neonShadow[ i ], fromCenter, range, signedFacing );
          }
          // Direct light, plus some that has bounced off the room and reaches every side. The bounce is
          // shadowed too, so no light seeps through a floor or wall.
          float energy = potential * shade;
          neonTint += neonColor[ i ] * energy;
          neonTotal += energy;
          vec3 H = normalize( L + neonView );
          // A highlight saturates like any bright light: it never gets brighter than the tube itself.
          float highlight = pow( max( dot( neonN, H ), 0.0 ), NEON_GLOSS ) * ( 1.0 - exp( -reach * NEON_GLINT ) ) * shade * step( 0.0, dot( neonN, L ) );
          neonGloss += mix( neonColor[ i ], vec3( 1.0 ), 0.55 ) * highlight;
          // The sun patch, shadowed by whatever blocks the window, and the sun's own glint on glossy things in it.
          if ( beam > 0.0 ) {
            beam *= shade;
            float sun = beam * max( dot( neonN, neonSun ), 0.0 );
            neonTint += neonSunColor * sun;
            neonTotal += sun;
            neonGloss += neonSunColor * beam * pow( max( dot( neonN, normalize( neonSun + neonView ) ), 0.0 ), NEON_GLOSS ) * 1.6;
          }
        }
      }
    }
  }
  #pragma unroll_loop_end
  // Far lights: the same glow without shadows or sunbeams. Having no shadows, each lights only surfaces in the same
  // rooms as itself: an outdoor light only outdoors, a lamp only inside its own building (and room).
  {
    #pragma unroll_loop_start
    for ( int i = 0; i < ${NEON_FAR}; i ++ ) {
      {
      // Most far lights are nowhere near this surface: one distance test rules them out before any real work.
      vec3 neonToBounds = vNeonWorld - neonFarBounds[ i ].xyz;
      float same = dot( neonToBounds, neonToBounds ) < neonFarBounds[ i ].w ? 1.0 : 0.0;
      if ( same > 0.0 ) {
        if ( neonFarRooms[ i ] < 0.5 ) same = 1.0 - neonDark.x;
        else for ( int j = 0; j < ${NEON_DARK_MAX}; j ++ ) {
          float lightIn = mod( floor( neonFarRooms[ i ] / exp2( float( j ) ) ), 2.0 );
          same *= mix( 1.0 - neonHere.v[ j ], neonHere.v[ j ], lightIn );
        }
      }
      if ( neonFarParams[ i ].x > 0.0 && same > 0.0 ) {
        vec3 segment = neonFarEnd[ i ] - neonFarStart[ i ];
        float along = clamp( dot( vNeonWorld - neonFarStart[ i ], segment ) / max( dot( segment, segment ), 1e-6 ), 0.0, 1.0 );
        vec3 toLight = neonFarStart[ i ] + segment * along - vNeonWorld;
        float dist = length( toLight );
        float range = neonFarParams[ i ].y;
        float front = smoothstep( -0.01, 0.02, dot( vNeonWorld - neonFarStart[ i ], neonFarFacing[ i ] ) + neonFarParams[ i ].z + 0.02 );
        if ( dist < range && front > 0.0 ) {
          vec3 L = toLight / max( dist, 1e-4 );
          float window = pow( clamp( 1.0 - pow( dist / range, 4.0 ), 0.0, 1.0 ), 2.0 );
          float reach = neonFarParams[ i ].x * neonLineFactor( vNeonWorld, neonFarStart[ i ], neonFarEnd[ i ], neonFarRadius[ i ] ) * window * front;
          // Daylight only grazes its window's own wall, as for the shadowed lights.
          if ( neonFarWindow[ i ] > 0.5 ) reach *= smoothstep( 0.04, 0.25, dot( vNeonWorld - neonFarStart[ i ], neonFarFacing[ i ] ) );
          float energy = reach * ( max( dot( neonN, L ), 0.0 ) + neonFarParams[ i ].w ) * same;
          neonTint += neonFarColor[ i ] * energy;
          neonTotal += energy;
          float highlight = pow( max( dot( neonN, normalize( L + neonView ) ), 0.0 ), NEON_GLOSS ) * ( 1.0 - exp( -reach * NEON_GLINT ) ) * step( 0.0, dot( neonN, L ) );
          neonGloss += mix( neonFarColor[ i ], vec3( 1.0 ), 0.55 ) * highlight * same;
        }
      }
      }
    }
    #pragma unroll_loop_end
  }
  #ifdef NEON_METAL
    // Metal is a rough mirror of the room it is in: a face turned up reflects the lit ceiling, one turned down the
    // darker floor, and every edge reflects more at a grazing angle. Each face of a gun shades differently, as metal does.
    vec3 neonRoom = vec3( 1.0 ) - exp( -neonTint );
    vec3 neonR = reflect( -neonView, neonN );
    float neonRim = pow( 1.0 - max( dot( neonN, neonView ), 0.0 ), 4.0 );
    neonGloss += neonRoom * ( 0.15 + 0.85 * smoothstep( -0.5, 0.9, neonR.y ) ) * ( 0.35 + 0.65 * neonRim ) * 0.75;
  #endif
  if ( neonTotal > 0.0 ) {
    vec3 neonHue = neonTint / neonTotal;
    float neonAmount = 1.0 - exp( -neonTotal );
    // Paper takes the light's colour; dark surfaces pick up a faint cast. Right by the tubes it is bright
    // enough to wash toward white, as a camera would see it.
    outgoingLight = mix( outgoingLight, outgoingLight * neonHue, neonAmount * 0.88 ) + neonHue * neonAmount * 0.08;
    outgoingLight = mix( outgoingLight, mix( neonHue, vec3( 1.0 ), 0.5 ), smoothstep( 6.0, 30.0, neonTotal ) * 0.3 );
    outgoingLight += neonGloss * NEON_SHINE;
  }
  // In a dark room there is no daylight: only the light that reaches the surface, saturating softly.
  if ( neonDark.x > 0.0 ) {
    vec3 neonReceived = vec3( 1.0 ) - exp( -neonTint );
    // Metal's own colour is dark; what you see of it indoors is mostly what it reflects.
    #ifdef NEON_METAL
      neonAlbedo *= 0.5;
    #endif
    vec3 neonInDark = neonAlbedo * min( vec3( neonDark.y ) + neonReceived, vec3( 1.0 ) ) + neonGloss * NEON_SHINE;
    outgoingLight = mix( outgoingLight, neonInDark, neonDark.x );
  }
}
#endif
`

const basic = THREE.ShaderLib.basic
if (!basic.vertexShader.includes('neon_vertex')) {
  basic.vertexShader = basic.vertexShader
    .replace('void main() {', '#include <neon_pars_vertex>\nvoid main() {')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\n#include <neon_vertex>')
  basic.fragmentShader = basic.fragmentShader
    .replace('void main() {', '#include <neon_pars_fragment>\nvoid main() {')
    .replace('#include <opaque_fragment>', '#include <neon_fragment>\n#include <opaque_fragment>')
  Object.assign(basic.uniforms, neonUniforms)
}

/**
 * For LineMaterial ink (an onBeforeCompile step): strokes inside a dark room go black like everything else
 * there, instead of showing up as pale lines on a dark wall.
 */
export function darkenInkInDarkRooms(shader: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(shader.uniforms, { neonDarkMatrix: neonUniforms.neonDarkMatrix, neonDarkHalf: neonUniforms.neonDarkHalf, neonDarkRoof: neonUniforms.neonDarkRoof })
  shader.vertexShader = shader.vertexShader
    .replace('void main() {', 'varying vec3 vNeonInkWorld;\nvoid main() {')
    .replace('// ndc space', `vNeonInkWorld = transpose( mat3( viewMatrix ) ) * ( ( ( position.y < 0.5 ) ? start : end ).xyz - viewMatrix[ 3 ].xyz );
      // ndc space`)
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', 'varying vec3 vNeonInkWorld;\n#include <neon_dark_pars>\nvoid main() {')
    .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );', `gl_FragColor = vec4( diffuseColor.rgb, alpha );
      gl_FragColor.rgb *= 1.0 - neonDarkness( vNeonInkWorld ).x;`)
}

// Shadow maps store distance from the middle of the tubes, divided by the range; nothing in the way reads 1.
const distanceMaterial = new THREE.ShaderMaterial({
  uniforms: { origin: { value: new THREE.Vector3() }, range: { value: 1 } },
  vertexShader: /* glsl */`
    #include <common>
    #include <batching_pars_vertex>
    #include <skinning_pars_vertex>
    varying vec3 vWorld;
    void main() {
      #include <batching_vertex>
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 origin;
    uniform float range;
    varying vec3 vWorld;
    void main() { gl_FragColor = vec4( min( length( vWorld - origin ) / range, 1.0 ), 0.0, 0.0, 1.0 ); }
  `,
  side: THREE.DoubleSide,
})

const white = new THREE.Color(1, 1, 1)

type Light = {
  sign: THREE.Object3D; spec: NeonLightSpec; color: THREE.Color
  start: THREE.Vector3; end: THREE.Vector3; center: THREE.Vector3; facing: THREE.Vector3
  /** Where its shadows are seen from (see NeonLightSpec.shadowFrom). */
  origin: THREE.Vector3
  visible: boolean; distance: number; brightness: number
  /** The dark rooms it is inside (see roomsOf). */
  rooms?: THREE.Object3D[]
  /** When it last came on (in either set), for its fade-in, and whether it was on last frame. */
  litAt: number; lit: boolean
}
/** Where a mover is, and its transform rounded so that only real movement changes it. */
type MoverState = { key: Int32Array; position: THREE.Vector3 }
type Slot = { camera: THREE.CubeCamera; light: Light | null; ready: boolean; rendered: number; seen: Map<THREE.Object3D, MoverState>; pending: number[] }

/** Every neon light in one scene. Call `update` every frame before rendering. */
export class NeonLights {
  /** Whether solid things block the light. */
  shadows = true
  private readonly lights: Light[] = []
  private readonly slots: Slot[] = shadowTargets.map(target => {
    const camera = new THREE.CubeCamera(0.05, 1, target)
    return { camera, light: null, ready: false, rendered: -Infinity, seen: new Map(), pending: [] }
  })
  private readonly frustum = new THREE.Frustum()
  private readonly projection = new THREE.Matrix4()
  private readonly sphere = new THREE.Sphere()
  /** Casters that can move: characters (skinned), door leaves and anything with dynamic collision. */
  private movers: THREE.Object3D[] = []
  /**
   * Shadow maps are drawn from a scene of stand-ins for just the meshes that can cast, not the whole world: a
   * shadow face then touches a few dozen objects instead of thousands. Each stand-in shares its original's
   * geometry (and skeleton or instances) and takes its place just before the shadows render.
   */
  private readonly shadowScene = new THREE.Scene()
  private readonly standIns = new Map<THREE.Mesh, THREE.Mesh>()
  private initialized = false
  private castersCollected = -Infinity
  private castersStale = true
  private readonly clear = new THREE.Color()
  private readonly rooms: THREE.Object3D[] = []
  private readonly roomCenter = new THREE.Vector3()
  private readonly transient = new Set<THREE.Object3D>()
  private farLights: Light[] = []
  /** Each dark room's world-to-room matrix (rooms never move). */
  private readonly roomInverse = new Map<THREE.Object3D, THREE.Matrix4>()
  /** The dark rooms in effect last frame. */
  private roomsInEffect: THREE.Object3D[] = []
  /** Every mesh that could cast a shadow, from the last search of the scene, and whether it can move. */
  private candidates: { mesh: THREE.Mesh; moving: boolean }[] = []
  private candidatesFound = -Infinity
  /** This frame's place of every mover, worked out once and shared by all the lights. */
  private readonly moverStates = new Map<THREE.Object3D, MoverState>()
  private moverFrame = -1
  private frame = 0
  /** Whether the lighting is still settling (a light fading up, shadows being drawn): it wants another frame. */
  private settling = false

  constructor(private readonly scene: THREE.Scene) {
    scene.traverse(object => {
      if (object.userData.neonLight) this.add(object)
      if (object.userData.darkRoom) this.rooms.push(object)
    })
  }

  get count() { return this.lights.length }

  /** The lighting is mid-change (a light fading up, a shadow being drawn, a burst burning) and needs more frames. */
  get busy() { return this.settling || this.transient.size > 0 }

  /** Stop lighting from a light (a transient one, done). */
  remove(sign: THREE.Object3D) {
    const index = this.lights.findIndex(light => light.sign === sign)
    if (index < 0) return
    const [light] = this.lights.splice(index, 1)
    for (const slot of this.slots) if (slot.light === light) slot.light = null
  }

  /** Take in transient lights that have appeared, and let go of those that have gone (bursts, once burnt out). */
  private syncTransient(now: number) {
    for (const sign of transientLights) {
      const burst = sign.userData.burst as { born: number; life: number; age: number } | undefined
      if (!burst) continue
      burst.age = now - burst.born
      if (burst.age >= burst.life || burst.age < -1) transientLights.delete(sign)
    }
    for (const sign of transientLights) if (!this.transient.has(sign)) { this.transient.add(sign); this.add(sign) }
    for (const sign of this.transient) if (!transientLights.has(sign)) { this.transient.delete(sign); this.remove(sign) }
  }

  /** Signs lit this frame with shadows, in slot order. */
  get active() { return this.slots.flatMap(slot => slot.light ? [slot.light.sign] : []) }
  /** Signs lit this frame from further away, without shadows. */
  get distant() { return this.farLights.map(light => light.sign) }
  /** Every light, for tools: its sign, line ends and shadow point in the world as of the last update. */
  get all() { return this.lights.map(({ sign, start, end, origin, visible }) => ({ sign, start, end, origin, visible })) }

  add(sign: THREE.Object3D) {
    const spec = sign.userData.neonLight as NeonLightSpec
    this.lights.push({ sign, spec, color: new THREE.Color(spec.color), start: new THREE.Vector3(), end: new THREE.Vector3(),
      center: new THREE.Vector3(), facing: new THREE.Vector3(), origin: new THREE.Vector3(), visible: false, distance: Infinity, brightness: 0, litAt: -Infinity, lit: false })
  }

  /** Light the scene from the signs nearest `viewer`, and refresh at most one shadow map. */
  update(renderer: THREE.WebGLRenderer, viewer: THREE.Vector3, now = performance.now() / 1000) {
    if (!this.initialized) {
      // Every shadow texture is bound on every draw, so give each one real storage from the start.
      for (const target of shadowTargets) renderer.initRenderTarget(target)
      this.initialized = true
    }
    this.syncTransient(now)
    // The nearest dark rooms are in effect, measured to their walls (zero inside one); the rest are too far away
    // to see into.
    const measured = this.rooms.map(room => ({ room, distance: this.roomDistance(room, viewer) }))
    const viewerRooms = measured.filter(({ distance }) => distance <= 0).map(({ room }) => room)
    const rooms: THREE.Object3D[] = measured
      .sort((a, b) => (a.distance - (this.roomsInEffect.includes(a.room) ? ROOM_HOLD : 0)) - (b.distance - (this.roomsInEffect.includes(b.room) ? ROOM_HOLD : 0)))
      .slice(0, NEON_DARK_MAX).map(({ room }) => room)
    this.roomsInEffect = rooms
    this.frame++
    let settling = false
    neonUniforms.neonDarkHalf.value.fill(0)
    rooms.forEach((room, index) => {
      this.inverseOf(room).toArray(neonUniforms.neonDarkMatrix.value, index * 16)
      const spec = room.userData.darkRoom as DarkRoomSpec
      neonUniforms.neonDarkHalf.value.set(spec.half, index * 3)
      neonUniforms.neonDarkRoof.value.set([spec.pitch?.ridge ?? spec.half[1], spec.pitch?.slope ?? 0, spec.ambient ?? 0.003, 0], index * 4)
    })
    for (const light of this.lights) this.place(light, viewer)
    // Nearest first, measured to the edge of each light's reach: a big window a little further away matters
    // more than a small sign just beyond its own range. The room you are in comes first, and a light keeps its slot
    // until another is clearly more important (see HOLD, ELSEWHERE). A burst comes before everything.
    const held = new Set(this.slots.flatMap(slot => slot.light ? [slot.light] : []))
    const here = (light: Light) => {
      const own = this.roomsOf(light)
      return viewerRooms.length ? own.some(room => viewerRooms.includes(room)) : own.length === 0
    }
    const rank = new Map<Light, number>()
    for (const light of this.lights) {
      if (!light.visible || light.distance >= FAR_LIMIT) continue
      rank.set(light, light.spec.instant ? -Infinity
        : Math.max(0, light.distance - light.spec.range) * 4 + light.distance + (here(light) ? 0 : ELSEWHERE) - (held.has(light) ? HOLD : 0))
    }
    const priority = (light: Light) => rank.get(light)!
    const chosen = [...rank.keys()].filter(light => light.distance < VIEW_LIMIT && !light.spec.shadowless)
      .sort((a, b) => priority(a) - priority(b)).slice(0, NEON_MAX)
    // Lights keep their slot while they stay chosen, so their shadow maps stay valid.
    for (const slot of this.slots) if (slot.light && !chosen.includes(slot.light)) slot.light = null
    for (const light of chosen) {
      if (this.slots.some(slot => slot.light === light)) continue
      const slot = this.slots.find(candidate => !candidate.light)!
      Object.assign(slot, { light, ready: false, rendered: -Infinity, seen: new Map(), pending: [...ALL_FACES] })
      this.castersStale = true
    }
    const { neonStart, neonEnd, neonFacing, neonColor, neonOrigin, neonParams, neonWindow, neonWindowOffsets, neonWindowExtra } = neonUniforms
    this.slots.forEach((slot, index) => {
      const light = slot.light
      if (!light) { neonParams.value[index * 4] = 0; return }
      const window = light.spec.window
      neonWindow.value.set(window ? [window.width / 2, window.height / 2, Math.min(4, window.offsets.length), window.sun] : [0, 0, 0, 0], index * 4)
      neonWindowOffsets.value.set([0, 1, 2, 3].map(k => window?.offsets[k] ?? 0), index * 4)
      neonWindowExtra.value.set([light.spec.bounce ?? 0, light.spec.radius ?? 0.05, 0, 0], index * 4)
      light.origin.toArray(neonOrigin.value, index * 3)
      light.start.toArray(neonStart.value, index * 3)
      light.end.toArray(neonEnd.value, index * 3)
      light.facing.toArray(neonFacing.value, index * 3)
      light.color.toArray(neonColor.value, index * 3)
      const fade = this.fade(light, now)
      if (fade < 1 || (this.shadows && !slot.ready)) settling = true
      neonParams.value.set([light.brightness * fade, light.spec.range, Number(this.shadows && slot.ready), light.spec.standoff], index * 4)
    })
    // The next lights out to FAR_LIMIT shine too, without shadows: outdoor ones, and indoor ones whose rooms are all
    // in effect (so the shader can keep each to its own rooms).
    const roomBits = (light: Light) => this.roomsOf(light).reduce((bits, room) => bits < 0 || !rooms.includes(room) ? -1 : bits | 1 << rooms.indexOf(room), 0)
    const near = new Set(chosen)
    const far = [...rank.keys()].filter(light => !near.has(light) && roomBits(light) >= 0)
      .sort((a, b) => priority(a) - priority(b)).slice(0, NEON_FAR)
    this.farLights = far
    const { neonFarStart, neonFarEnd, neonFarFacing, neonFarColor, neonFarParams, neonFarRooms } = neonUniforms
    neonFarParams.value.fill(0)
    far.forEach((light, index) => {
      neonFarRooms.value[index] = roomBits(light)
      neonUniforms.neonFarWindow.value[index] = light.spec.window ? 1 : 0
      neonUniforms.neonFarRadius.value[index] = light.spec.radius ?? 0.05
      const reach = light.spec.range + light.start.distanceTo(light.end) / 2
      neonUniforms.neonFarBounds.value.set([light.center.x, light.center.y, light.center.z, reach * reach], index * 4)
      light.start.toArray(neonFarStart.value, index * 3)
      light.end.toArray(neonFarEnd.value, index * 3)
      light.facing.toArray(neonFarFacing.value, index * 3)
      light.color.toArray(neonFarColor.value, index * 3)
      const fade = this.fade(light, now)
      if (fade < 1) settling = true
      neonFarParams.value.set([light.brightness * fade, light.spec.range, light.spec.standoff, light.spec.bounce ?? 0.06], index * 4)
    })
    this.settling = settling
    // Whatever is not lit now fades up again next time it comes on; moving between the sets keeps it steady.
    const litNow = new Set([...chosen, ...far])
    for (const light of this.lights) {
      if (!litNow.has(light)) light.lit = false
    }
    if (!this.shadows) return
    if (now - this.candidatesFound > CANDIDATE_INTERVAL) { this.findCandidates(); this.candidatesFound = now; this.castersStale = true }
    if (this.castersStale || now - this.castersCollected > CASTER_INTERVAL) {
      this.collectCasters()
      this.castersCollected = now
      this.castersStale = false
    }
    // A new light renders its six faces a few a frame, and casts shadows once all are drawn; otherwise the light
    // that has waited longest, among those where something has moved, renders just the faces that see the movement.
    let next = this.slots.find(slot => slot.light && !slot.ready), faces = ALL_FACES
    if (next) {
      // A burst draws every face at once: it lasts a moment, and must not leak through walls while it starts.
      faces = next.pending.splice(0, next.light!.spec.instant ? ALL_FACES.length : NEW_FACES_PER_FRAME)
      if (next.pending.length) {
        if (faces.length) this.renderShadow(renderer, next, faces)
        return
      }
    } else {
      // Lights near the player keep up with movement every SHADOW_INTERVAL; further ones less often.
      const due = (slot: Slot) => now - slot.rendered > (slot.light!.distance < NEAR_SHADOWS ? SHADOW_INTERVAL : SLOW_SHADOW_INTERVAL)
      for (const slot of this.slots.filter(slot => slot.light && slot.light.distance < slot.light.spec.range + 3 && due(slot))
        .sort((a, b) => a.rendered - b.rendered)) {
        const moved = this.moved(slot)
        if (!moved.length) continue
        faces = this.facesSeeing(slot, moved)
        next = slot
        break
      }
    }
    if (!next?.light) return
    this.renderShadow(renderer, next, faces)
    next.ready = true
    next.rendered = now
    next.seen = this.snapshotNear(next.light)
    neonParams.value[this.slots.indexOf(next) * 4 + 2] = 1
  }

  private inverseOf(room: THREE.Object3D) {
    let inverse = this.roomInverse.get(room)
    if (!inverse) {
      room.updateWorldMatrix(true, false)
      inverse = room.matrixWorld.clone().invert()
      this.roomInverse.set(room, inverse)
    }
    return inverse
  }

  /** A light coming on fades up over FADE_IN instead of popping on; one that stays on, in either set, stays steady. */
  private fade(light: Light, now: number) {
    if (light.spec.instant) return 1
    if (!light.lit) { light.lit = true; light.litAt = now }
    return THREE.MathUtils.smoothstep(now - light.litAt, 0, FADE_IN)
  }

  /** The dark rooms the light is inside (none for an outdoor light). Lights stay put, so this is worked out once. */
  private roomsOf(light: Light) {
    light.rooms ??= this.rooms.filter(room => this.roomDistance(room, light.origin) <= 0.05)
    return light.rooms
  }

  private roomDistance(room: THREE.Object3D, viewer: THREE.Vector3) {
    const local = this.roomCenter.copy(viewer).applyMatrix4(this.inverseOf(room))
    const [x, y, z] = (room.userData.darkRoom as DarkRoomSpec).half
    return Math.hypot(Math.max(0, Math.abs(local.x) - x), Math.max(0, Math.abs(local.y) - y), Math.max(0, Math.abs(local.z) - z))
  }

  /**
   * Where every mover is this frame, rounded so that only real movement counts: worked out once a frame and shared by
   * all the lights, reusing the same objects, so a still scene costs a few comparisons and makes no garbage.
   */
  private moversNow() {
    if (this.moverFrame === this.frame) return this.moverStates
    this.moverFrame = this.frame
    const live = new Set(this.movers)
    for (const mover of this.moverStates.keys()) if (!live.has(mover)) this.moverStates.delete(mover)
    for (const mover of this.movers) {
      // A character is placed by its hips, which walk and turn with it; anything else by its own transform.
      const bone = (mover as THREE.SkinnedMesh).isSkinnedMesh ? (mover as THREE.SkinnedMesh).skeleton.bones[0] : null
      const e = (bone ?? mover).matrixWorld.elements
      let state = this.moverStates.get(mover)
      if (!state) { state = { key: new Int32Array(7), position: new THREE.Vector3() }; this.moverStates.set(mover, state) }
      state.position.set(e[12], e[13], e[14])
      const k = state.key
      k[0] = Math.round(e[12] / MOVER_STEP); k[1] = Math.round(e[13] / MOVER_STEP); k[2] = Math.round(e[14] / MOVER_STEP)
      k[3] = Math.round(e[0] / 0.08); k[4] = Math.round(e[2] / 0.08); k[5] = Math.round(e[8] / 0.08); k[6] = Math.round(e[10] / 0.08)
    }
    return this.moverStates
  }

  private within(light: Light, position: THREE.Vector3) {
    return position.distanceTo(light.origin) <= light.spec.range + MOVER_RADIUS
  }

  /** A copy of the movers within the light's reach, as its shadow now shows them. */
  private snapshotNear(light: Light) {
    const near = new Map<THREE.Object3D, MoverState>()
    for (const [mover, state] of this.moversNow()) {
      if (this.within(light, state.position)) near.set(mover, { key: state.key.slice(), position: state.position.clone() })
    }
    return near
  }

  /** The places (before and after) of every mover whose shadow on this light has changed since it rendered. */
  private moved(slot: Slot) {
    const light = slot.light!, changed: THREE.Vector3[] = []
    const same = (a: Int32Array, b: Int32Array) => { for (let i = 0; i < 7; i++) if (a[i] !== b[i]) return false; return true }
    const states = this.moversNow()
    for (const [mover, state] of states) {
      const inside = this.within(light, state.position), before = slot.seen.get(mover)
      if (!inside) { if (before) changed.push(before.position); continue }
      if (before && same(before.key, state.key)) continue
      changed.push(state.position)
      if (before) changed.push(before.position)
    }
    for (const [mover, before] of slot.seen) if (!states.has(mover)) changed.push(before.position)
    return changed
  }

  /** The cube faces whose view takes in any of these places. */
  private facesSeeing(slot: Slot, places: THREE.Vector3[]) {
    slot.camera.position.copy(slot.light!.origin)
    slot.camera.updateMatrixWorld()
    return ALL_FACES.filter(face => {
      const camera = slot.camera.children[face] as THREE.PerspectiveCamera
      this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
      return places.some(place => this.frustum.intersectsSphere(this.sphere.set(place, MOVER_RADIUS)))
    })
  }

  private place(light: Light, viewer: THREE.Vector3) {
    const { sign, spec } = light
    light.brightness = spec.intensity * THREE.MathUtils.clamp(spec.dimmer?.() ?? 1, 0, 1)
    let visible = sign.visible && light.brightness > 1e-3
    sign.traverseAncestors(parent => { visible &&= parent.visible })
    light.visible = visible
    if (!visible) return
    sign.updateWorldMatrix(true, false)
    light.start.set(...spec.start).applyMatrix4(sign.matrixWorld)
    light.end.set(...spec.end).applyMatrix4(sign.matrixWorld)
    light.center.copy(light.start).add(light.end).multiplyScalar(0.5)
    if (spec.shadowFrom) light.origin.set(...spec.shadowFrom).applyMatrix4(sign.matrixWorld)
    else light.origin.copy(light.center)
    light.facing.set(0, 0, 1).transformDirection(sign.matrixWorld)
    light.distance = light.center.distanceTo(viewer)
  }

  /**
   * Search the whole scene for meshes that could cast a shadow. Signs and lamps (`userData.neonFixture`) never shadow
   * themselves, and nothing the camera holds (the first-person gun and arms) casts either. This walks thousands of
   * objects, so it runs only every CANDIDATE_INTERVAL; a change of lights just re-sorts its result (collectCasters).
   */
  private findCandidates() {
    const candidates: { mesh: THREE.Mesh; moving: boolean }[] = []
    const visit = (object: THREE.Object3D, excluded: boolean, moving: boolean) => {
      excluded ||= !!(object as THREE.Camera).isCamera || !!object.userData.neonLight || !!object.userData.neonFixture
      moving ||= !!object.userData.doorHinge || !!object.userData.dynamicCollision
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && !excluded) {
        const material = mesh.material as THREE.Material
        // Unlit things (characters, screens) still block light.
        if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial && material.visible && !material.transparent) {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
          candidates.push({ mesh, moving: moving || !!(mesh as THREE.SkinnedMesh).isSkinnedMesh })
        }
      }
      for (const child of object.children) visit(child, excluded, moving)
    }
    visit(this.scene, false, false)
    this.candidates = candidates
  }

  /** Gather every candidate within reach of a lit light into the shadow scene. */
  private collectCasters() {
    const lit = this.slots.flatMap(slot => slot.light ? [slot.light] : [])
    const sphere = new THREE.Sphere()
    const casters = new Set<THREE.Mesh>()
    this.movers = []
    for (const { mesh, moving } of this.candidates) {
      if (!mesh.parent) continue
      if (!(mesh as THREE.InstancedMesh).isInstancedMesh) {
        sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld)
        if (!lit.some(light => sphere.center.distanceTo(light.center) < light.spec.range + sphere.radius)) continue
      }
      casters.add(mesh)
      if (moving) this.movers.push(mesh)
    }
    for (const [source, standIn] of this.standIns) if (!casters.has(source)) { standIn.removeFromParent(); this.standIns.delete(source) }
    for (const source of casters) if (!this.standIns.has(source)) {
      const standIn = this.standIn(source)
      this.standIns.set(source, standIn)
      this.shadowScene.add(standIn)
    }
  }

  /**
   * Compile the shadow pass's shaders now (behind the loading screen) rather than when the first guard, instanced
   * prop or plain mesh steps into a lamp's reach: one stand-in of each kind found in `scene`.
   */
  warmUp(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const kinds = new Map<string, THREE.Mesh>()
    scene.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const kind = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 'skinned' : (mesh as THREE.InstancedMesh).isInstancedMesh ? 'instanced' : 'mesh'
      if (!kinds.has(kind)) kinds.set(kind, mesh)
    })
    const warm = new THREE.Scene()
    for (const source of kinds.values()) warm.add(this.standIn(source))
    renderer.compile(warm, camera)
    warm.clear()
  }

  private standIn(source: THREE.Mesh) {
    let standIn: THREE.Mesh
    if ((source as THREE.SkinnedMesh).isSkinnedMesh) {
      const skinned = source as THREE.SkinnedMesh, copy = new THREE.SkinnedMesh(skinned.geometry, distanceMaterial)
      copy.bindMode = skinned.bindMode
      copy.bind(skinned.skeleton, skinned.bindMatrix)
      standIn = copy
    } else if ((source as THREE.InstancedMesh).isInstancedMesh) {
      const instanced = source as THREE.InstancedMesh, copy = new THREE.InstancedMesh(instanced.geometry, distanceMaterial, instanced.count)
      copy.instanceMatrix = instanced.instanceMatrix
      standIn = copy
    } else standIn = new THREE.Mesh(source.geometry, distanceMaterial)
    standIn.matrixAutoUpdate = false
    standIn.matrixWorldAutoUpdate = false
    standIn.frustumCulled = source.frustumCulled
    return standIn
  }

  /** Each stand-in takes its original's place, and is hidden wherever the original is. */
  private placeStandIns() {
    for (const [source, standIn] of this.standIns) {
      let visible = source.visible
      if (visible) source.traverseAncestors(parent => { visible &&= parent.visible })
      standIn.visible = visible
      if (!visible) continue
      standIn.matrixWorld.copy(source.matrixWorld)
      if ((source as THREE.InstancedMesh).isInstancedMesh) (standIn as THREE.InstancedMesh).count = (source as THREE.InstancedMesh).count
    }
  }

  private renderShadow(renderer: THREE.WebGLRenderer, slot: Slot, faces = ALL_FACES) {
    const scene = this.shadowScene
    const light = slot.light!
    this.placeStandIns()
    const alpha = renderer.getClearAlpha()
    renderer.getClearColor(this.clear)
    distanceMaterial.uniforms.origin.value.copy(light.origin)
    distanceMaterial.uniforms.range.value = light.spec.range
    for (const face of slot.camera.children as THREE.PerspectiveCamera[]) {
      if (face.far !== light.spec.range) { face.far = light.spec.range; face.updateProjectionMatrix() }
    }
    renderer.setClearColor(white, 1)
    // Point the six face cameras the renderer's way, as CubeCamera.update does on its first run: a new light's
    // faces are drawn a few at a time, without it.
    if (slot.camera.coordinateSystem !== renderer.coordinateSystem) {
      slot.camera.coordinateSystem = renderer.coordinateSystem
      slot.camera.updateCoordinateSystem()
    }
    slot.camera.position.copy(light.origin)
    slot.camera.updateMatrixWorld()
    try {
      if (faces.length === 6) slot.camera.update(renderer, scene)
      else {
        // Just these faces, the way CubeCamera.update renders each one.
        const target = slot.camera.renderTarget, current = renderer.getRenderTarget()
        const face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel(), xr = renderer.xr.enabled
        renderer.xr.enabled = false
        for (const index of faces) {
          renderer.setRenderTarget(target, index)
          renderer.render(scene, slot.camera.children[index] as THREE.PerspectiveCamera)
        }
        renderer.setRenderTarget(current, face, level)
        renderer.xr.enabled = xr
      }
    }
    finally {
      renderer.setClearColor(this.clear, alpha)
    }
  }
}
