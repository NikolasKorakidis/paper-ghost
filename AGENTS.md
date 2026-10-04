# Stickman: Ghost Ink

A browser-based first-person hostage-rescue game, "Stickman: Ghost Ink", with a paper-and-ink look. TypeScript, Three.js (WebGL, unlit surfaces + screen-space outlines), Vite, Preact. No backend.

## Commands

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc --noEmit && vite build — this is the typecheck; run it after every change
npm test             # every scripts/*-checks.ts in Node (~45 s), prints ok/FAIL per file; rerun a FAIL with node scripts/check-player.mjs <file>
npm run test:<area>  # focused suite, see table
```

## Agent resources

- `AGENTS.md` is the canonical repository-wide guidance for coding agents.
- `.agent/` contains repository-owned workflow notes. Before verifying visible changes, read the [browser-check workflow](.agent/skills/browser-check/SKILL.md); do not rely on automatic directory discovery.
- `CLAUDE.md` is a compatibility pointer to this file; keep shared guidance here instead of duplicating it.
- Generated screenshots, recordings, and browser evidence belong in `artifacts/`, never in source or documentation directories.

| You touched                                                 | Run                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/player/` movement, collision, ladders                  | `test:player`, `test:traversal-audio`, `test:fall-damage`                    |
| `src/game/ai.ts`, `navigation.ts`                           | `test:ai`, `test:tower-patrol`                                               |
| `src/game/weapons.ts`, `weapon-models.ts`, bullets, impacts | `test:weapons`, `test:bullets`, `test:polish`                                |
| mission flow, hostage, jeep, security, gate                 | `test:rescue`, `test:escape`, `test:mission`                                 |
| player damage / death                                       | `test:player-hits`, `test:player-death`                                      |
| `src/lab/` rig, clips, gait, deaths                         | `test:gait`, `test:deaths`, `test:combat-animations`, `test:npc-transitions` |
| `src/world/` geometry                                       | `test:map`, `test:trees`, `test:player`, `test:expansion`                    |
| `src/vr/`                                                   | `test:vr`                                                                    |
| `src/levels/`, a level's world or mission, `game/goals.ts`  | `test:levels`, plus `test:map` for the compound                              |

## Layout

- `index.html` → `src/main.ts`: the game. `/?explore=1` is free exploration + experimental Quest WebXR. `/?view=overview` (also `yard`, `rail`, `tanks`, `plan`, `roof`, `mess`, `office`, `water`, `watch`) are inspection camera bookmarks, and `/?tutorial=1` is the training level. The player never sees these: the menu switches modes on the same address (`src/modes.ts`; game ↔ tutorial in place without a reload), and a bookmark's parameter is cleared from the address bar once read. A refresh returns to the game.
- `lab.html` → `src/lab/main.ts`: character/animation lab. **The lab rig, clips and postures are shared with the game's enemies and hostage — an animation change affects both.** Read `src/lab/README.md` first.
- `src/levels/`: the level registry. `catalog.ts` lists every level (campaign, training, dev); `index.ts` builds one by id; `proving-ground.ts` is the template. **Read `src/levels/README.md` before building a level.** `/?level=<id>` plays any level in dev; a level's goals (`game/goals.ts`) drive its objectives, saves, co-op and the win.
- `src/game/`: mission runtime (`runtime.ts`, `mission.ts`), AI, weapons, HUD/menu, audio, effects. Tunables live in `balance.ts`.
- `src/world/`: compound geometry built in code from plan coordinates (0.15 m per reference pixel, north = −Z).
- `src/player/`: capsule controller, collision trees, ladders. Physics substeps are ≤ 1/120 s.
- `src/render/ink.ts`: the shared paper/ink materials. Use these; don't create ad-hoc materials.
- `src/render/neon.ts` is the lighting (lamps, windows, doorways, signs, screens; shadows; dark rooms) and `src/world/lights.ts` its builders. A light must not run through a wall or furniture, and a window row must stay in one room; `placeWindowShadows` picks each window's shadow point once the world is built, and `scripts/light-placement-checks.ts` enforces all of this. Gallery → Dev mode → Light room (`/?level=light-room`) is the test room: 7 8 9 0 switch its lights, − shows each light's line and shadow point.
- `public/`: `models/stickman.glb` (the one skinned character), `OST/` (every sound and music track, by category: see `public/OST/README.md` and `CREDITS.md`).
- `scripts/*-checks.ts`: Node logic checks. `scripts/check-*.js`, `capture-*.js`, route scripts: browser checks (see below). `scripts/agent-browser.mjs` provides the portable browser CLI launcher used by runtime checks.
- `localonly/` and `artifacts/` are git-ignored scratch space. Put screenshots and evidence there, never in the repo.

## Conventions and gotchas

- **Style:** pure white paper `#ffffff`, ink `#000000` / `#808080` / `#bdbdbd`. NPCs are solid black, the hostage is blue `#2878d0`, blood is solid red. Quest items are the one painted exception: radios (olive and brown), breakable crates (wood brown), C4 charges (brown) and intel files (blue folders), from the `QUEST_COLORS` fills in `src/render/ink.ts`. Structural strokes are 2.2 CSS px and taper with distance. Never render mesh tessellation as wireframe.
- **Menus and HUD** follow a manga-noir theme after killer7, with neon (`src/game/theme-k7.css`): black panels ruled in bone `#f3efe6` with a red `#e3261d` off-register print, condensed poster capitals, a kanji per page, screentone and speed lines, red neon only after resting on a button. Markers over enemies are manga burst balloons (yellow ?, red !). Menus never animate on their own.
- The stickman must read as one continuous body — no visible joints or separate limb meshes.
- Collision extraction skips `ShaderMaterial` meshes. Keep solid material types on anything that must block movement.
- Physics `dt` is capped at 50 ms; cinematics and door/gate timing use real elapsed time. Test timing-sensitive work at 30/60/144 fps like the existing checks do.
- Respect the Reduced Motion setting for any new camera or screen effect.
- Mission state must restore on checkpoint retry and full restart — add new state to both paths.
- A logic check is a plain `.ts` file that imports from `src/` and throws on failure. `scripts/check-player.mjs <file>` bundles it with rolldown and runs it in Node (CSS imports are stubbed). Add new ones as `scripts/<topic>-checks.ts`; `npm test` picks them up automatically.

## Browser verification

Always use `npx agent-browser` (not Playwright/Puppeteer). Dev builds expose `window.__environment` (game: `.mission`, `.player`) and `window.__lab` (lab `Ctx`). Browser scripts are run with `npx agent-browser eval --stdin < scripts/check-menus.js` against a freshly loaded dev page; each script's header comment says which page it needs. Reload afterwards — several scripts stub AI or enable invincibility.

Visual changes need a screenshot you have actually looked at, not just passing asserts.
