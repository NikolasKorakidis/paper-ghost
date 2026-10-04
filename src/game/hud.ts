import * as THREE from 'three'
import type { MissionState } from './mission'
import { fieldMap, readProjection, type MapProjection } from './field-map'
import { WEAPON_RULES } from './balance'
import type { MissionWorld, WeaponItem } from './types'
import './game.css'
import { IncomingFire } from './incoming-fire'
import { MissionMenu } from './menu'
import type { PlayerDeathSequence } from './player-death'
import type { EscapeCinematic } from './escape-cinematic'
import { ObjectivesPanel, type ObjectiveSource } from './objectives'

const icons: Record<string, string> = {
  door: '<path d="M5 21V3h14v18M9 21V5l8 2v14M13 13h1"/>',
  ladder: '<path d="M7 2v20M17 2v20M7 5h10M7 10h10M7 15h10M7 20h10"/>',
  zipline: '<path d="M2 3l20 7M8 5l-1 4 5 2 1-4M10 10l-1 6 5 2m-5-2-4 5m9-3 3 3"/>',
  pickup: '<path d="M4 13v7h16v-7M12 2v13m-5-5 5 5 5-5"/>',
  mission: '<path d="M5 20V4h14v16ZM8 8h8M8 12h3m4 0h1M8 16h8"/>',
}

export class MissionHUD {
  private root = document.createElement('div')
  private abort = new AbortController()
  private health: HTMLElement
  private scope = document.createElement('div')
  private scopeLabel: HTMLSpanElement
  private ammo: HTMLElement
  private ammoFill: SVGRectElement
  private magazineCount: HTMLElement
  private reloadIcon: SVGElement
  private caption: HTMLElement
  private menu: MissionMenu
  private mapDot: SVGElement
  private mapProjection: MapProjection | null = null
  private icon: HTMLElement
  private captionTimer = 0
  private start: HTMLButtonElement
  private damageTimer = 0
  private death = document.createElement('div')
  private pause = document.querySelector<HTMLElement>('#walk-pause')!
  private deathMenuShown = false
  private escape = document.createElement('div')
  private escapeMenuShown = false
  readonly incoming = new IncomingFire()
  private threat: HTMLElement
  private threatLabel: HTMLElement
  /** The alert phase plate (after Metal Gear Solid V): ALERT, SEARCH or CAUTION, where, and how long it has left. */
  private phase = document.createElement('div')
  private phaseKey = ''
  private objectives = new ObjectivesPanel()
  private briefingDue = true
  /** The tutorial level: its own lesson list replaces the mission objectives. */
  private tutorial = false
  /** Set once the level is built (see setObjectiveTotals). */
  private objectiveSource: ObjectiveSource = { list: () => [], hint: () => '' }
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(world: MissionWorld, callbacks: ConstructorParameters<typeof MissionMenu>[3] & { volume: (value: number) => void; mute: (value: boolean) => void }) {
    document.body.dataset.mission = 'true'
    document.body.dataset.reducedMotion = String(this.reducedMotion)
    document.title = 'Stickman: Ghost Ink'
    const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    this.start = $<HTMLButtonElement>('#walk-start')
    this.start.textContent = 'Loading the compound…'; this.start.disabled = true
    // Gone once a previous mode's menu has taken the card over (a mode switch in place).
    const eyebrow = document.querySelector('.walk-heading .walk-eyebrow')
    if (eyebrow) eyebrow.textContent = 'Stickman: Ghost Ink'
    $('#world').setAttribute('aria-label', 'Stickman: Ghost Ink tactical mission. Mouse to look, WASD move, left click fire, right click toggle aim, F interact, R reload, M field map, Escape pause.')
    const briefing = world.briefing ?? { title: 'The mission', premise: '', won: 'Mission complete.', outro: 'You made it out.', tips: [] }
    this.menu = new MissionMenu(this.start, { ...briefing, map: briefing.map ?? fieldMap(world.root, world) }, this.reducedMotion, callbacks)
    this.menu.setLevel(world.level)
    this.mapDot = document.querySelector('#field-player')!
    this.mapProjection = readProjection(this.mapDot.closest('svg'))
    this.root.id = 'mission-hud'
    this.root.innerHTML = `
      <div class="mission-wounds" id="mission-health" role="meter" aria-label="Health" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"></div>
      <div id="mission-caption" role="status"></div>
      <div class="mission-weapon" id="mission-ammo" role="meter" aria-label="Magazine" aria-valuemin="0" aria-valuemax="30" aria-valuenow="30">
        <span class="magazine-count" aria-hidden="true">4 ×</span>
        <svg class="magazine-icon" viewBox="0 0 64 76" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round">
          <defs><path id="hud-magazine" d="M14 10L35 10L35 27C35 43 41 53 50 61L33 71C19 58 13 44 13 27Z"/><clipPath id="hud-magazine-clip"><use href="#hud-magazine"/></clipPath></defs>
          <use href="#hud-magazine" fill="var(--paper)"/>
          <g clip-path="url(#hud-magazine-clip)">
            <rect class="magazine-fill" x="10" y="10" width="44" height="61" fill="currentColor"/>
            <path d="M20 20V28C20 44 25 54 35 64M28 20V28C28 43 33 53 42 60" fill="none" stroke="var(--paper)" stroke-width="1.5"/>
          </g>
          <use href="#hud-magazine" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M12 5L37 5L37 11L12 11ZM30 70L50 58L53 62L33 74Z" fill="var(--paper)" stroke="currentColor" stroke-width="1.7"/>
        </svg>
        <svg class="magazine-reload" viewBox="0 0 24 24" aria-hidden="true" hidden fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 10A8 8 0 0 0 6 6L3 9M3 4V9H8M4 14A8 8 0 0 0 18 18L21 15M16 15H21V20"/>
        </svg>
      </div>
      <div class="mission-damage" aria-hidden="true"></div>`
    document.body.append(this.root)
    this.death.className = 'mission-death'
    this.death.hidden = true
    this.death.setAttribute('aria-hidden', 'true')
    this.death.innerHTML = '<div class="death-blur"></div><div class="death-dim"></div>'
    document.body.append(this.death)
    this.escape.className = 'mission-escape'
    this.escape.hidden = true
    this.escape.setAttribute('aria-hidden', 'true')
    document.body.append(this.escape)
    this.threat = document.createElement('div')
    this.threat.className = 'mission-threat'
    this.threat.setAttribute('aria-hidden', 'true')
    this.threat.innerHTML = '<i></i><span></span>'
    this.threatLabel = this.threat.querySelector('span')!
    this.phase.className = 'mission-phase'
    this.phase.hidden = true
    this.phase.setAttribute('role', 'status')
    this.phase.innerHTML = '<b></b><span></span><i><u></u></i>'
    this.root.append(this.threat, this.phase, this.objectives.root)
    this.clearThreat()
    this.health = $('#mission-health')
    this.scope.className = 'mission-scope'
    this.scope.hidden = true
    this.scope.setAttribute('aria-hidden', 'true')
    this.scope.innerHTML = '<div class="scope-lens"><i></i><b></b><span>4×</span><small>Mouse wheel to zoom</small></div>'
    this.scopeLabel = this.scope.querySelector('span')!
    document.body.append(this.scope)
    this.ammo = $('#mission-ammo')
    this.ammoFill = this.ammo.querySelector('.magazine-fill')!
    this.magazineCount = this.ammo.querySelector('.magazine-count')!
    this.reloadIcon = this.ammo.querySelector('.magazine-reload')!
    this.caption = $('#mission-caption')
    this.icon = document.createElement('span'); this.icon.className = 'action-icon'; this.icon.setAttribute('aria-hidden', 'true')
    $('#action-prompt').insertBefore(this.icon, $('#action-prompt').children[1])
    const opts = { signal: this.abort.signal }
    $('#mission-volume').addEventListener('input', e => callbacks.volume(Number((e.target as HTMLInputElement).value) / 100), opts)
    $('#mission-mute').addEventListener('change', e => callbacks.mute((e.target as HTMLInputElement).checked), opts)
    // I opens and folds the mission list while playing.
    window.addEventListener('keydown', event => {
      if (this.tutorial || event.code !== 'KeyI' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || this.root.hidden) return
      if (event.target instanceof HTMLElement && event.target.closest('button, input, textarea, select')) return
      event.preventDefault()
      this.objectives.toggle()
    }, opts)
    $('#mission-motion').addEventListener('change', e => { this.reducedMotion = (e.target as HTMLInputElement).checked; document.body.dataset.reducedMotion = String(this.reducedMotion) }, opts)
  }

  ready() { this.menu.ready() }
  showMap() { this.menu.showMap() }
  showCoop() { this.menu.showCoop() }
  /** How this level was entered, and a campaign mission won (see MissionMenu). */
  setRun(kind: import('./saves').RunKind | null) { this.menu.setRun(kind) }
  setComplete(next: string | null) { this.menu.setComplete(next) }
  /** Aim drift in normalized screen coordinates (as from Vector3.project), applied to the crosshair and scope reticle. */
  setAimOffset(ndcX: number, ndcY: number) {
    const x = ndcX * window.innerWidth / 2, y = -ndcY * window.innerHeight / 2
    const translate = Math.abs(x) + Math.abs(y) < 0.05 ? '' : `${x.toFixed(2)}px ${y.toFixed(2)}px`
    const crosshair = document.querySelector<HTMLElement>('.crosshair'), lens = this.scope.querySelector<HTMLElement>('.scope-lens')
    for (const element of [crosshair, lens]) if (element && element.style.translate !== translate) element.style.translate = translate
  }
  setPlaying(playing: boolean) {
    this.menu.setPlaying(playing)
    // The first time a run is played, the mission list is shown in the middle of the screen before it docks.
    if (playing && this.briefingDue) { this.briefingDue = false; this.objectives.brief() }
  }
  /** The tutorial level: no mission objectives, and the menu offers training instead of the mission. */
  setTutorial() {
    this.tutorial = true
    this.briefingDue = false
    this.objectives.root.hidden = true
    this.menu.setTutorial()
  }
  /** Brief the missions again when the next run starts (a full restart). */
  /** A level played on its own (see MissionMenu.setStandalone). */
  setStandalone() { this.menu.setStandalone() }
  briefObjectives() { this.briefingDue = !this.tutorial }
  error(message: string) { this.menu.error(message) }
  notify(message: string, duration = 5, visible = false) {
    this.caption.textContent = message
    this.captionTimer = duration
    this.caption.classList.toggle('visible-notice', visible)
  }
  hurt() { this.damageTimer = 0.32 }
  /** How many crates and which radios the level holds, for the side-mission counts. */
  /** The level's objectives (the runtime sets this once the level is built). */
  setObjectiveSource(source: ObjectiveSource) { this.objectiveSource = source }
  hitFrom(intensity: number, direction: string) { this.incoming.pulse(intensity, direction) }
  clearThreat() { this.incoming.clear(); this.threat.hidden = true }
  reset() { this.damageTimer = 0; this.captionTimer = 0; this.root.classList.remove('hurt'); this.setScoped(false); this.clearThreat(); this.clearDeath(); this.clearEscape(); this.menu.reset() }
  setEscape(sequence: EscapeCinematic) {
    document.body.dataset.escape = sequence.menuVisible ? 'menu' : 'driving'
    this.escape.hidden = false
    this.escape.style.opacity = String(sequence.fade)
    this.root.hidden = true
    this.pause.hidden = !sequence.menuVisible
    this.pause.inert = !sequence.menuVisible
    this.pause.style.opacity = String(sequence.menuOpacity)
    if (sequence.menuVisible && !this.escapeMenuShown) {
      this.escapeMenuShown = true
      this.menu.focusPrimary()
    }
  }
  clearEscape() {
    delete document.body.dataset.escape
    this.escape.hidden = true
    this.escapeMenuShown = false
    this.pause.inert = false
    this.pause.style.removeProperty('opacity')
  }
  setDeath(sequence: PlayerDeathSequence) {
    document.body.dataset.death = sequence.menuVisible ? 'menu' : 'falling'
    this.death.hidden = false
    this.death.classList.toggle('reduced-motion', sequence.reducedMotion)
    const loss = sequence.visionLoss
    // Uniform loss of focus and light, with no vignette or circular mask.
    this.death.style.setProperty('--death-blur', `${10 * loss}px`)
    this.death.style.setProperty('--death-loss', String(0.92 * loss))
    this.pause.hidden = !sequence.menuVisible
    this.pause.inert = !sequence.menuVisible
    this.pause.style.opacity = String(sequence.menuOpacity)
    if (sequence.menuVisible && !this.deathMenuShown) {
      this.deathMenuShown = true
      this.menu.focusPrimary()
    }
  }
  clearDeath() {
    delete document.body.dataset.death
    this.death.hidden = true
    this.deathMenuShown = false
    this.pause.inert = false
    this.pause.style.removeProperty('opacity')
  }
  setScoped(scoped: boolean, magnification = 4) {
    this.scope.hidden = !scoped
    document.body.classList.toggle('mission-scoped', scoped)
    const label = `${magnification}×`
    if (this.scopeLabel.textContent !== label) this.scopeLabel.textContent = label
  }

  update(dt: number, state: MissionState, data: { playing: boolean; enabled: boolean; weapon: WeaponItem | null; reloading: boolean; position: THREE.Vector3; yaw: number; deaths: number; ready: boolean
    /** The level's highest alert phase (game/zones.ts): which, in which zone, and how much of its time is left (0-1). */
    phase?: { phase: 'normal' | 'caution' | 'search' | 'alert'; zone: string; left: number } | null }) {
    this.root.hidden = !data.enabled || !data.playing
    this.updatePhase(state.phase === 'active' ? data.phase ?? null : null)
    const health = Math.max(0, Math.min(100, state.health))
    this.health.setAttribute('aria-valuenow', String(Math.ceil(health)))
    this.health.setAttribute('aria-valuetext', `${Math.ceil(health)} of 100`)
    // No health meter: the view darkens with each wound and clears as health refills.
    const wound = (1 - health / 100).toFixed(3)
    if (this.health.style.getPropertyValue('--wound') !== wound) this.health.style.setProperty('--wound', wound)
    this.ammo.hidden = !data.weapon || data.weapon.name === 'knife'
    this.reloadIcon.toggleAttribute('hidden', !data.reloading)
    if (data.weapon && data.weapon.name !== 'knife') {
      const rule = WEAPON_RULES[data.weapon.name]
      const rounds = Math.max(0, Math.min(rule.capacity, data.weapon.magazine))
      const magazines = (rounds > 0 ? 1 : 0) + Math.ceil(Math.max(0, data.weapon.reserve) / rule.capacity)
      this.magazineCount.textContent = `${magazines} ×`
      this.ammo.setAttribute('aria-label', `${rule.label} magazine`)
      this.ammo.setAttribute('aria-valuemax', String(rule.capacity))
      this.ammo.setAttribute('aria-valuenow', String(rounds))
      this.ammo.setAttribute('aria-valuetext', `${data.reloading ? 'Reloading. ' : ''}${rounds} of ${rule.capacity} rounds; ${data.weapon.reserve} in reserve; ${magazines} magazines including the loaded magazine when nonempty`)
      this.ammoFill.setAttribute('y', String(71 - 61 * rounds / rule.capacity))
      this.ammoFill.setAttribute('height', String(61 * rounds / rule.capacity))
    }
    if (data.playing) { this.captionTimer -= dt; this.damageTimer -= dt; this.incoming.update(dt) }
    this.threat.hidden = !this.incoming.visible || state.phase !== 'active'
    this.threat.dataset.direction = this.incoming.direction.toLowerCase()
    this.threat.style.setProperty('--pressure', String(this.reducedMotion ? 0 : this.incoming.strength * 0.18))
    this.threatLabel.textContent = this.incoming.direction === 'Below' ? 'Fall damage' : `Hit · ${this.incoming.direction.toLowerCase()}`
    this.caption.hidden = this.captionTimer <= 0
    this.root.classList.toggle('hurt', this.damageTimer > 0 && !this.reducedMotion)
    const kind = document.querySelector<HTMLElement>('#action-prompt')!.dataset.kind ?? 'mission'
    if (this.icon.dataset.kind !== kind) { this.icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${icons[kind] ?? icons.mission}</svg>`; this.icon.dataset.kind = kind }
    if (!data.playing) {
      const map = this.mapProjection
      if (map) this.mapDot.setAttribute('transform', `translate(${(data.position.x + map.originX) * map.scale + map.pad},${(data.position.z + map.originZ) * map.scale + map.pad}) rotate(${-data.yaw * 180 / Math.PI})`)
    }
    this.objectives.update(this.objectiveSource.list(state), data.playing ? dt : 0)
    this.menu.update(state, data, this.objectiveSource.hint(state))
  }
  private updatePhase(phase: { phase: 'normal' | 'caution' | 'search' | 'alert'; zone: string; left: number } | null) {
    const shown = !!phase && phase.phase !== 'normal'
    this.phase.hidden = !shown
    if (!shown) { this.phaseKey = ''; return }
    const key = `${phase.phase}:${phase.zone}`
    if (key !== this.phaseKey) {
      this.phaseKey = key
      this.phase.dataset.phase = phase.phase
      this.phase.querySelector('b')!.textContent = phase.phase.toUpperCase()
      this.phase.querySelector('span')!.textContent = phase.zone
    }
    // The bar drains as the phase runs down; on alert (someone sees you) it stays full.
    const left = (phase.phase === 'alert' ? 1 : Math.max(0, Math.min(1, phase.left))).toFixed(3)
    if (this.phase.style.getPropertyValue('--left') !== left) this.phase.style.setProperty('--left', left)
  }

  dispose() { this.menu.dispose(); this.abort.abort(); this.clearDeath(); this.clearEscape(); this.escape.remove(); this.death.remove(); this.setScoped(false); this.scope.remove(); this.root.remove(); this.icon.remove(); delete document.body.dataset.mission }
}
