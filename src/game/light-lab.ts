import * as THREE from 'three'
import type { NeonLightSpec, NeonLights } from '../render/neon'
import { LIGHT_ROOM_SOURCES } from '../levels/light-room'
import './light-lab.css'

/**
 * The light room's tools (levels/light-room.ts): keys 7, 8, 9 and 0 switch its four lights, − shows where every light
 * is (its glowing line in its own colour and its shadow point as a red dot), and a panel lists what the lighting is
 * doing: each light on or off, which lights have shadows this frame, which shine from further off without, and the
 * frame rate. Returns a function that takes it all away.
 */
export function startLightLab(scene: THREE.Scene, lights: NeonLights, invalidate: () => void) {
  const switches = LIGHT_ROOM_SOURCES.map(source => {
    const signs: THREE.Object3D[] = []
    scene.traverse(object => { if (object.userData.neonLight && object.name.startsWith(source.name)) signs.push(object) })
    // The switch is kept on the light itself (`userData.labOff`), and its dimmer is wrapped only once, so starting the
    // tools again on the same scene never stacks a stale switch on top.
    for (const sign of signs) {
      sign.userData.labOff = false
      const spec = sign.userData.neonLight as NeonLightSpec
      if (sign.userData.labWrapped) continue
      sign.userData.labWrapped = true
      const own = spec.dimmer
      spec.dimmer = () => sign.userData.labOff ? 0 : own?.() ?? 1
    }
    return {
      ...source, signs,
      get on() { return !signs[0]?.userData.labOff },
      set on(on: boolean) { for (const sign of signs) sign.userData.labOff = !on },
    }
  })
  const panel = document.createElement('aside')
  panel.className = 'light-lab'
  panel.setAttribute('aria-label', 'Light room')
  document.body.append(panel)
  const markers = new THREE.Group()
  markers.name = 'Light lab markers'
  markers.userData.noCollision = true
  markers.visible = false
  scene.add(markers)
  const dot = new THREE.SphereGeometry(0.06, 12, 8)
  const red = Object.assign(new THREE.MeshBasicMaterial({ color: 0xff2a1f, depthTest: false }), { defines: { NEON_UNLIT: '' } })
  const drawMarkers = () => {
    markers.clear()
    for (const light of lights.all) {
      if (!light.visible || light.origin.distanceTo(scene.position) > 60) continue
      const point = new THREE.Mesh(dot, red)
      point.position.copy(light.origin); point.renderOrder = 10
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([light.start, light.end, light.origin]),
        new THREE.LineBasicMaterial({ color: (light.sign.userData.neonLight as NeonLightSpec).color, depthTest: false }))
      line.renderOrder = 10
      markers.add(point, line)
    }
  }
  const frames: number[] = []
  let last = performance.now(), raf = 0
  const tick = () => {
    const now = performance.now(); frames.push(now - last); last = now; if (frames.length > 60) frames.shift()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  const draw = () => {
    const fps = frames.length ? 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length) : 0
    const name = (sign: THREE.Object3D) => sign.name.replace(/ · (daylight|lamp light|screen light|glow)$/, '')
    const list = (signs: THREE.Object3D[]) => signs.map(sign => `<li>${name(sign)}</li>`).join('') || '<li>none</li>'
    panel.innerHTML = `<h2>Light room</h2>
      <ul class="light-lab-switches">${switches.map(s => `<li class="${s.on ? 'is-on' : ''}"><kbd>${s.key}</kbd>${s.label}<b>${s.on ? 'on' : 'off'}</b></li>`).join('')}
        <li class="${markers.visible ? 'is-on' : ''}"><kbd>−</kbd>Markers<b>${markers.visible ? 'on' : 'off'}</b></li></ul>
      <h3>With shadows · ${lights.active.length}</h3><ul>${list(lights.active)}</ul>
      <h3>Distant, no shadows · ${lights.distant.length}</h3><ul>${list(lights.distant.slice(0, 6))}</ul>
      <p>${fps.toFixed(0)} fps</p>`
  }
  const timer = window.setInterval(() => { draw(); if (markers.visible) { drawMarkers(); invalidate() } }, 250)
  const key = (event: KeyboardEvent) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    // By the key's place as well as its character, so other keyboard layouts work too.
    const light = switches.find(s => s.key === event.key || event.code === `Digit${s.key}`)
    if (light) light.on = !light.on
    else if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') { markers.visible = !markers.visible; if (markers.visible) drawMarkers() }
    else return
    draw(); invalidate()
  }
  addEventListener('keydown', key)
  draw()
  return () => {
    window.clearInterval(timer); cancelAnimationFrame(raf)
    removeEventListener('keydown', key)
    panel.remove(); markers.removeFromParent()
    for (const light of switches) light.on = true
  }
}
