// Run against a freshly loaded dev game via agent-browser eval --stdin.
// Uses real menu events/runtime callbacks, with guards disabled and pointer-lock
// fallback enabled only to make the lifecycle checks deterministic in automation.
(async () => {
  const env = window.__environment, m = env.mission, p = env.player
  if (!m?.ready) throw new Error('Wait for mission.ready')
  const $ = selector => document.querySelector(selector)
  const visible = selector => $(selector).getClientRects().length > 0
  const results = []
  const check = (ok, label) => {
    results.push({ passed: !!ok, label })
    if (!ok) throw new Error(label)
  }
  const key = (code, options = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: code === 'KeyM' ? 'm' : code, code, bubbles: true, cancelable: true, ...options,
  }))
  const click = selector => $(selector).click()
  const draw = () => { m.update(0); m.finishFrame() }
  const page = () => $('.walk-card').dataset.page
  const singlePage = () => [...document.querySelectorAll('[data-menu-page]')].filter(el => el.getClientRects().length).length === 1
  const entries = name => [...document.querySelectorAll(`[data-menu-page="${name}"] .main-entry`)].map(entry => entry.dataset.menuOpen ?? entry.dataset.menuGo)
  const HOME = '[data-menu-page="home"]', CAMPAIGN = '[data-menu-page="campaign"]', PAUSE = '[data-menu-page="pause"]', OPTIONS = '[data-menu-page="options"]', GALLERY = '[data-menu-page="gallery"]'
  const shown = list => list.filter(entry => entry.getClientRects().length)
  // Start with no saved campaign or missions so the Load button's appearance is predictable.
  const clearSaves = () => { for (const key of Object.keys(localStorage)) if (key.startsWith('stickman-ghost-ink.save') || key === 'stickman-ghost-ink.campaign') localStorage.removeItem(key) }
  clearSaves()
  const originalAI = m.ai.update, originalFallback = p.fallback, originalInvincible = m.invincible
  m.ai.update = () => {}
  p.fallback = true
  m.invincible = false
  try {
    // The main menu: four choices and nothing else.
    check(page() === 'home' && !visible('.field-map') && !visible('.mission-settings'), 'Opening menu contains no map or settings clutter')
    check(JSON.stringify(entries('home')) === JSON.stringify(['campaign', 'coop', 'gallery', 'options']), `Main menu offers exactly Campaign, Multiplayer, Gallery and Options: ${entries('home')}`)
    check(!visible('#walk-start') && !visible('#mission-retry') && !visible('#mission-restart') && !visible(`${HOME} [data-menu-back]`), 'The first main menu has no mission buttons and no Back')
    const initialWords = $(`${HOME}`).innerText.trim().split(/\s+/).length
    check(initialWords <= 40, `Opening screen stays brief: ${initialWords} words`)
    check(!$('[data-menu-open="vr"]') && !visible('#vr-panel'), 'Unfinished VR is not offered in the menu')
    const animated = [...document.querySelectorAll('#walk-pause, #walk-pause *')].filter(el => getComputedStyle(el).animationName !== 'none' || getComputedStyle(el, '::before').animationName !== 'none' || getComputedStyle(el, '::after').animationName !== 'none')
    check(animated.length === 0, `Nothing in the menus blinks or flickers: ${animated.map(el => el.id || el.className).join(', ')}`)
    const hoverRule = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules] } catch { return [] } })
      .find(rule => rule.selectorText?.includes(':hover:not(:disabled)') && rule.selectorText.includes('.main-entry') && !rule.selectorText.includes('::'))
    check(hoverRule && /var\(--glow-delay\)/.test(hoverRule.style.transition) && getComputedStyle(document.documentElement).getPropertyValue('--glow-delay').trim() === '2s', 'Hover neon only comes on after resting on a button for 2 s')

    // Campaign: a new game, a saved game (once there is one), the free missions, or training. Nothing else, nothing twice.
    click(`${HOME} [data-menu-open="campaign"]`)
    const campaign = () => shown([...document.querySelectorAll(`${CAMPAIGN} .main-entry`)]).map(entry => entry.querySelector('strong').textContent)
    check(page() === 'campaign' && singlePage() && document.activeElement.id === 'campaign-play' && JSON.stringify(campaign()) === '["New game","Free missions","Training"]', `With nothing saved, Campaign offers New game, Free missions and Training: ${campaign()}`)
    check(!visible('#walk-start') && !visible('#mission-briefing'), 'No mission buttons and no briefing before the mission')
    // Free missions: every campaign mission in order.
    click('#campaign-levels')
    const levels = [...document.querySelectorAll('.level-list [data-level]')]
    check(page() === 'levels' && singlePage() && $('#levels-page-title').textContent === 'Free missions' && levels.length >= 2 && levels[0].querySelector('strong').textContent === 'Mission 1 · The compound'
      && levels[1].querySelector('strong').textContent === 'Mission 2 · The town', `Free missions lists the missions in order: ${levels.map(level => level.querySelector('strong').textContent)}`)
    key('Escape')
    check(page() === 'campaign' && document.activeElement.id === 'campaign-levels', 'Escape from Free missions returns to the Campaign, on Free missions')
    key('Escape')
    check(page() === 'home' && document.activeElement === $(`${HOME} [data-menu-open="campaign"]`) && !p.playing, 'Escape from Campaign returns to the main menu, on Campaign')

    // Gallery: map views, free roam, the lab and dev mode.
    click(`${HOME} [data-menu-open="gallery"]`)
    check(page() === 'gallery' && singlePage() && JSON.stringify(entries('gallery')) === JSON.stringify(['views', 'explore', 'lab', 'dev']), `Gallery holds map views, free roam, the lab and dev mode: ${entries('gallery')}`)
    click(`${GALLERY} [data-menu-open="views"]`)
    const views = [...document.querySelectorAll('[data-menu-page="views"] [data-menu-go]')].map(entry => entry.dataset.menuGo)
    check(page() === 'views' && singlePage() && views.length === 12 && views.every(view => view.startsWith('view:')) && views.includes('view:overview@town') && views.includes('view:plan@town'),
      'Map views lists the ten compound cameras and the town overview and plan')
    key('Escape')
    check(page() === 'gallery' && document.activeElement === $(`${GALLERY} [data-menu-open="views"]`), 'Escape from Map views returns to the Gallery')
    click(`${GALLERY} [data-menu-open="dev"]`)
    const rooms = [...document.querySelectorAll('[data-menu-page="dev"] [data-menu-go]')].map(entry => entry.dataset.menuGo)
    check(page() === 'dev' && singlePage() && JSON.stringify(rooms) === JSON.stringify(['level:light-room', 'level:proving-ground', 'level:boss-arena']), `Dev mode lists the light room, the proving ground and the boss arena: ${rooms}`)
    key('Escape')
    check(page() === 'gallery' && document.activeElement === $(`${GALLERY} [data-menu-open="dev"]`), 'Escape from Dev mode returns to the Gallery, on Dev mode')
    key('Escape')
    check(page() === 'home' && document.activeElement === $(`${HOME} [data-menu-open="gallery"]`), 'Escape from the Gallery returns to the main menu')

    // Options: settings and controls.
    click(`${HOME} [data-menu-open="options"]`)
    check(page() === 'options' && singlePage() && JSON.stringify(entries('options')) === JSON.stringify(['settings', 'controls']), `Options holds settings and controls: ${entries('options')}`)
    for (const name of ['settings', 'controls']) {
      const selector = `${OPTIONS} [data-menu-open="${name}"]`
      click(selector)
      check(page() === name && singlePage() && document.activeElement.hasAttribute('data-menu-back'), `${name}: only its own page is visible, focus on Back`)
      key('Escape')
      check(page() === 'options' && document.activeElement === $(selector) && !p.playing, `${name}: Escape returns to Options without starting the game`)
    }
    key('Escape')
    check(page() === 'home' && document.activeElement === $(`${HOME} [data-menu-open="options"]`), 'Escape from Options returns to the main menu, on Options')

    // Multiplayer: host or join a room, and nothing else until you are in one.
    click(`${HOME} [data-menu-open="coop"]`)
    check(page() === 'coop' && $('#coop-page-title').textContent === 'Multiplayer' && visible('.coop-slot [data-coop-host]') && !visible('#coop-play') && entries('coop').length === 0, 'Multiplayer only hosts or joins a room')
    key('Escape')
    check(page() === 'home' && document.activeElement === $(`${HOME} [data-menu-open="coop"]`), 'Escape from Multiplayer returns to the main menu')

    // Keyboard navigation on the main menu.
    $(`${HOME} [data-menu-open="campaign"]`).focus(); key('ArrowDown')
    check(document.activeElement.dataset.menuOpen === 'coop', 'Arrow keys navigate the menu')
    $(`${HOME} [data-menu-open="options"]`).focus(); key('Tab')
    check(document.activeElement.dataset.menuOpen === 'campaign', 'Tab wraps inside the menu')
    key('Tab', { shiftKey: true })
    check(document.activeElement.dataset.menuOpen === 'options', 'Shift+Tab wraps backwards')

    // Settings really change the game and survive navigation.
    click(`${HOME} [data-menu-open="options"]`); click(`${OPTIONS} [data-menu-open="settings"]`)
    const volume = $('#mission-volume')
    volume.value = '31'; volume.dispatchEvent(new Event('input', { bubbles: true }))
    click('#mission-mute'); click('#mission-motion')
    check(m.audio.diagnostics.volume === 0.31 && m.audio.diagnostics.muted && m.hud.reducedMotion, 'Settings control actual audio and reduced motion')
    key('Escape'); key('Escape'); click(`${HOME} [data-menu-open="options"]`); click(`${OPTIONS} [data-menu-open="settings"]`)
    check(volume.value === '31' && $('#mission-volume-value').value === '31%' && $('#mission-motion').checked, 'Settings survive page navigation')
    volume.value = '55'; volume.dispatchEvent(new Event('input', { bubbles: true }))
    click('#mission-mute'); click('#mission-motion'); key('Escape'); key('Escape')

    // New game: the mission's briefing first (map, then the mission, objectives and intel), then Start mission plays it.
    click(`${HOME} [data-menu-open="campaign"]`); click('#campaign-play'); draw()
    check(!p.playing && page() === 'mission' && visible('.field-map') && document.activeElement.id === 'briefing-start' && $('#briefing-start').textContent === 'Start mission', 'New game opens the briefing, on Start mission')
    check($('#briefing-kicker').textContent === 'Mission 1 of 2 · Campaign' && document.querySelectorAll('.briefing-main li').length >= 1 && visible('.briefing-intel'), 'The briefing names the mission and lists its objectives and intel')
    check(JSON.parse(localStorage.getItem('stickman-ghost-ink.campaign')).mission === 'compound', 'New game saves a campaign on mission 1')
    click('#briefing-start'); draw()
    check(p.playing && $('#walk-pause').hidden, 'Start mission enters play')
    m.state.elapsed = 12; p.pause(); draw()
    const pauseEntries = () => shown([...document.querySelectorAll(`${PAUSE} button`)]).map(button => button.querySelector('strong')?.textContent ?? button.textContent)
    check(page() === 'pause' && document.activeElement.id === 'walk-start' && $('#pause-page-title').textContent === 'Paused.', 'Pausing lands on the pause page, on Resume mission')
    check(JSON.stringify(pauseEntries()) === '["Resume mission","Restart mission","Briefing","Options","Main menu"]', `The pause page offers Resume, Restart, Briefing, Options and Main menu: ${pauseEntries()}`)
    const saved = JSON.parse(localStorage.getItem('stickman-ghost-ink.saves') ?? 'null')?.saves?.[0]
    check(saved?.level === 'compound' && saved.elapsed === 12, 'Pausing saved the mission')
    click(`${PAUSE} [data-menu-open="options"]`); click(`${OPTIONS} [data-menu-open="controls"]`); key('Escape'); key('Escape')
    check(page() === 'pause' && document.activeElement === $(`${PAUSE} [data-menu-open="options"]`), 'Options from the pause page leads back to the pause page')
    click('#pause-home')
    check(page() === 'home' && visible(`${HOME} [data-menu-back]`), 'Main menu from the pause page has a Back to it')
    click(`${HOME} [data-menu-open="campaign"]`)
    check(JSON.stringify(campaign()) === '["Resume mission","New game","Free missions","Training"]' && $('#campaign-resume span').textContent.length > 0 && document.activeElement.id === 'campaign-resume', `A paused campaign mission's Campaign page leads with Resume, keeps New game, and has no Load: ${campaign()}`)
    key('Escape'); click(`${HOME} [data-menu-open="gallery"]`); click(`${GALLERY} [data-menu-go="explore"]`)
    check(page() === 'leave' && $('#leave-warning').textContent.includes('saved') && document.activeElement.id === 'mission-cancel-leave', 'Leaving mid-mission says the progress is saved and focuses Stay')
    click('#mission-cancel-leave')
    check(page() === 'gallery' && m.state.elapsed === 12 && location.search === '', 'Stay keeps the mission')
    key('Escape'); key('Escape')
    check(page() === 'pause', 'Back from the main menu returns to the pause page')
    key('Escape')
    check(p.playing, 'Escape on the pause page resumes')
    p.pause(); draw(); click('#pause-home'); click(`${HOME} [data-menu-open="campaign"]`); click('#campaign-resume'); draw()
    check(p.playing, 'Resume mission on the Campaign page resumes')
    key('KeyM'); draw()
    check(!p.playing && page() === 'mission' && visible('.field-map'), 'M opens the mission map directly from gameplay')
    key('KeyM')
    // Deliberately pause before a render frame: page state must not depend on RAF.
    p.pause(); draw()
    check(page() === 'pause' && visible('#mission-restart') && !visible('#mission-retry'), 'Rapid map/resume/pause returns to the pause page')
    click('#mission-briefing')
    check(page() === 'mission' && visible('.field-map'), 'Briefing opens the map')
    key('Escape')
    check(page() === 'pause' && document.activeElement.id === 'mission-briefing', 'Escape from the briefing returns to the pause page')

    m.state.health = 43; m.state.elapsed = 19
    click('#mission-restart')
    check(page() === 'restart' && m.state.health === 43, 'Restart waits for an explicit confirmation')
    key('Escape')
    check(page() === 'pause' && m.state.health === 43 && document.activeElement.id === 'mission-restart', 'Cancel restart preserves progress and focus')
    check(!$('.walk-card').innerText.toLowerCase().includes('checkpoint'), 'Menus do not refer to nonexistent checkpoints')
    click('#walk-start'); draw()

    m.damage(200)
    for (let i = 0; i < 260; i++) { m.update(1 / 60); m.finishFrame() }
    check(m.state.phase === 'dead' && m.death.menuVisible && page() === 'pause', 'Fatal damage reaches the death menu on the pause page')
    check(document.activeElement.id === 'mission-retry' && !visible('.field-map') && !visible('#mission-debrief') && !visible('#walk-start') && !visible('#mission-briefing'), 'Death focuses Try again and hides map, statistics, Resume and Briefing')
    check(!visible('#mission-restart') && $('#mission-retry').textContent === 'Try again' && !visible('#mission-premise'), 'Death has one recovery action and no redundant instructions')
    click('#pause-home'); click(`${HOME} [data-menu-open="options"]`); click(`${OPTIONS} [data-menu-open="settings"]`); key('Escape'); key('Escape'); key('Escape')
    check(m.state.phase === 'dead' && !p.playing && page() === 'pause', 'Death submenus return to the death page without reviving the player')
    click('#mission-retry'); draw()
    check(p.playing && m.state.phase === 'active' && m.deaths === 0 && m.state.health === 100 && m.state.elapsed === 0 && !document.body.dataset.death, 'Try again resets the mission and resumes immediately')

    p.pause(); draw(); m.state.health = 42; m.deaths = 3
    click('#mission-restart'); click('#mission-confirm-restart'); draw()
    check(p.playing && m.state.health === 100 && m.deaths === 0, 'Confirmed restart resets and enters a fresh mission')

    p.pause(); m.state.phase = 'complete'; m.state.elapsed = 87; m.state.kills = 9; m.state.health = 42.3; draw()
    check(page() === 'pause' && $('#pause-page-title').textContent === 'Hostage safe.' && visible('#mission-restart') && !visible('#mission-retry') && !visible('#walk-start') && !visible('#mission-briefing'), 'Completion offers Play again without invalid actions')
    check(document.activeElement.id === 'mission-next' && $('#mission-next').textContent.startsWith('Next mission · The town') && $('#mission-restart').textContent === 'Play again', `A campaign win leads on to the next mission (by itself after a countdown), with Play again too: ${$('#mission-next').textContent}`)
    check(JSON.parse(localStorage.getItem('stickman-ghost-ink.campaign')).mission === 'town', 'Winning moves the campaign on to mission 2')
    const recap = () => [...document.querySelectorAll('.mission-recap dd')].map(value => value.textContent).join('|')
    check(visible('#mission-debrief') && recap() === '1:27|9|43%', 'Completion recap uses actual mission time, kills and remaining health')
    m.state.elapsed = 0; m.state.kills = 0; m.state.health = 100; draw()
    check(recap() === '0:00|0|100%', 'Completion recap preserves zero kills and full health')
    click('#mission-restart'); draw()
    check(m.state.phase === 'active' && p.playing && m.state.kills === 0 && m.state.health === 100 && m.state.elapsed === 0, 'Play again starts a new mission directly with fresh recap values')
    p.pause(); draw()
    check(!visible('#mission-debrief'), 'Fresh mission hides the previous completion recap')

    // Loading: the saved campaign picks up exactly where it was saved. (The forced win above moved it on; put it back.)
    localStorage.setItem('stickman-ghost-ink.campaign', JSON.stringify({ version: 1, mission: 'compound', completed: [], startedAt: 1 }))
    click('#walk-start'); draw(); m.state.elapsed = 33.5; m.state.health = 61; p.pause(); draw()
    click('#walk-start'); draw(); m.damage(200)
    for (let i = 0; i < 260; i++) { m.update(1 / 60); m.finishFrame() }
    click('#pause-home'); click(`${HOME} [data-menu-open="campaign"]`)
    check(m.state.phase === 'dead' && JSON.stringify(campaign()) === '["New game","Load game","Free missions","Training"]' && $('#campaign-load span').textContent.startsWith('Mission 1 · The compound') && $('#campaign-load span').textContent.includes('saved'), `After dying, the Campaign page offers the saved campaign: ${campaign()} · ${$('#campaign-load span').textContent}`)
    click('#campaign-play')
    check(page() === 'newgame' && document.activeElement.id === 'newgame-cancel', 'New game over a saved campaign asks first, on Keep my campaign')
    key('Escape')
    check(page() === 'campaign' && document.activeElement.id === 'campaign-play', 'Keeping the campaign returns to the Campaign page')
    click('#campaign-load'); draw()
    check(p.playing && m.state.phase === 'active' && Math.abs(m.state.elapsed - 33.5) < 0.2 && m.state.health === 61, 'Loading resumes the saved mission exactly')
    p.pause(); draw()
    check(page() === 'pause', 'A loaded mission pauses to the pause page')
    clearSaves()
    return { passed: results.length, initialWords }
  } finally {
    m.ai.update = originalAI
    p.fallback = originalFallback
    m.invincible = originalInvincible
  }
})()
