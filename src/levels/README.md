# Levels

Every level is registered here and built from the shared world kit. The game, the menus, saves, modes and the checks all read the registry, so a new level needs no changes to the runtime.

## Files

| File | What it is |
| --- | --- |
| `catalog.ts` | Every level as plain data: id, name, kind (`campaign`, `training`, `dev`), one-line summary. No imports. |
| `index.ts` | `buildLevel(id)`: the builder for each id. It returns `ground` (static world) and `world` (the mission on it). |
| `proving-ground.ts` | The template level. Copy it to start a new one. |

The compound (`src/world/compound.ts` and `src/game/world.ts`) and the training ground (`src/world/training-ground.ts` and `src/game/tutorial-world.ts`) predate this folder; `index.ts` wraps them.

## Adding a level

1. Copy `proving-ground.ts` to `<id>.ts` and rename its export.
2. Add `{ id, name, kind, summary }` to `LEVEL_CATALOG` in `catalog.ts`, and a builder for it in `index.ts`.
3. Play it with `/?level=<id>` (dev server). A `dev` level is reached only that way; a `campaign` level is also saved, and listed in Load game.
4. Run `npm run test:levels`. It must pass before the level is played (see Checks).
5. Check it in the browser (`.agent/skills/browser-check/SKILL.md`). Look at the briefing map, the insertion, every building inside, and a full run.

## What a level is made of

**Ground** (`THREE.Group`). Everything static: terrain slab, fences, buildings, props and lights. In metres, with north at -Z and y up. The compound's plan coordinates are 0.15 m per reference pixel (`mapPoint` in `world/compound.ts`); a level drawn from a plan image can use the same scale.

| Builder | From | Gives you |
| --- | --- | --- |
| `building({ name, x, z, width, depth, height, type, angle, furnish })` | `world/architecture.ts` | A walkable building: walls, windows, roof, entry door, steps and furnished interior. Also its dark room, window daylight, door daylight and caged lamps. `type`: barracks, warehouse, utility, service. The name picks the interior: "administration" (desks with radios, briefing table), "gatehouse" (radio post), "hut B" (medical); a warehouse gets two quest crates. `furnish(g, room)` furnishes it yourself instead (see `wallGaps`). |
| `storeyed({ name, x, z, width, depth, floors, roof, door, stairs, balcony, roofLadder, base, furnish, sign, chimneys })` | `world/storeys.ts` | A building of several storeys: switchback stairs guards and players both climb, a gable or walkable flat roof (with `roofLadder`), a front balcony, furniture per floor through `furnish`, and every floor its own dark room with windows and lamps. `base` raises it onto a hill. |
| `terrain(name, bounds, step, height)`, `waterSurface`, `bankBarrier`, `groundLine` | `world/terrain.ts` | Ground shaped by a height function (river channels, hills), water drawn in pen, invisible banks so water is crossed only where `open(x, z)` (a bridge), and inked lines along the ground (road edges, banks). Anything standing on shaped ground sits at `height(x, z)`. |
| `container`, `truck`, `crates`, `platform` | `world/architecture.ts` | Cover and props. |
| `fence(name, points, height)` | `world/industrial.ts` | Wire fence along a polyline. Blocks walking, not sight or shots. |
| `pipeLadder({...}).finish()` | `world/ladders.ts` | A climbable ladder up to a landing. |
| `createDoor({...})` | `world/doors.ts` | A door the player and guards open. |
| `darkRoom`, `cageLamp`, `windowRow`, `doorwayLight`, `daylightOpening`, `screenLight` | `world/lights.ts` | Lighting for interiors built by hand. Every room you can walk into must be dark and lit by its own lights (the checks enforce this for `userData.enterable`). Give each wall's windows in one room their own `windowRow`: a row must not span a partition, and nothing may stand right in front of a pane. Try new lighting in the light room first (`/?level=light-room`). |
| `Furnishing` (`desk(…, radio)`, `crate`, `bunk`, `table`, `shelf`, …) | `world/interiors.ts` | Furniture. A desk with `radio = true` holds a quest radio; `crate` is a breakable quest crate. |
| `wallGaps(room, wall, width)` | `world/interiors.ts` | Where along a wall something `width` wide fits between the windows and doors. `storeyed`'s `furnish` and `building`'s `furnish` both get the room with its openings: hang pictures, blackboards, bookcases and wardrobes only in these gaps (anything lower than `room.sill` can stand under a window). |
| `drawPine`, `drawOak`, `Draft`, `wallText` | `world/vegetation.ts`, `render/ink.ts` | Pines and broadleaf trees (both take a ground height), any custom geometry in the paper-and-ink style, and hand-lettered signs. Always use `Draft` and the shared fills; never make ad-hoc materials. |

Marker conventions the game picks up anywhere in the scene:

- `userData.weaponSpot = { id, name, magazine, reserve }` places a weapon pickup.
- `userData.questCrate` marks a breakable crate.
- `userData.questItem = 'radio'` marks a radio.
- `userData.kind = 'door'` marks a door.
- `userData.footprint = [w, d]` puts a building on the generated field map.
- `userData.mapLines = [{ kind: 'road' | 'water', points }]` draws roads and water on it.

**World** (`MissionWorld`, in `game/types.ts`):

| Field | Meaning |
| --- | --- |
| `level` | The level's id. |
| `spawn`, `lookAt` | The insertion point, and where the player looks when the run starts. |
| `bounds` | The play area. Leaving it puts the player back. |
| `enemies` | Built with `enemy(type, id, position, options)` from `game/enemy-types.ts`. Types: `rifleman`, `gunner`, `breacher`, `sidearm`, `marksman`, `bulky` (Bulky Boy, the armoured boss), `dummy`. Give `patrol` (a loop of points, starting where he stands) to make him walk, `facing` to aim a post, and `reserve` (plus `alarmExit`) for alarm reinforcements. Guards near each other form a squad (alerted together; shotguns and SMGs rush, riflemen flank); name squads yourself with `squad`. Mix weapons in each squad. See `DETECTION` in `game/balance.ts` for sight ranges and the ? notice time. |
| `stations` | Things the player uses with F. For a goal, use kind `'objective'`; its `label` is the prompt. |
| `goals` | The mission: see below. |
| `captives` | Prisoners: `{ id, position, facing, station }`. The blue stickman sits tied to a chair (`captiveChair` in `world/captive-chair.ts`, at the same position and facing) until the station is used; then he stands and follows the nearest player, cowering in gunfire. Pair it with an `interact` goal on the same station. An `extract` goal with `captives: [ids]` is theirs to reach: it is done when every one of them is free and inside its area, and a captive who gets there stays. |
| `charges` | Timed charges, CS-style C4: `{ id, name, pickup, plant, fuse, plantTime, blast, destroys, wreck }`. Taken at the `pickup` station, planted at `plant` by holding still, then a beeping countdown and a blast that kills within `blast.lethal`, hides `destroys` and shows `wreck`. `c4Package` in `game/charges.ts` is the model. |
| `briefing` | The pause page: title, premise, `won`/`outro` (the end page), route tips. Leave `map` out and one is drawn from the level. |

## Goals (`game/goals.ts`)

| Kind | Done when |
| --- | --- |
| `reach` | A player is inside the area. |
| `eliminate` | The listed enemies are dead (`'all'` means every non-dummy enemy). |
| `destroy` | The level's quest crates or radios are out of action (all of them, or `count`). |
| `interact` | The `'objective'` station is used. |
| `collect` | Every one of these `'objective'` stations is used (picking up files); the count shows. Mark a station's object `userData.collectible` and it vanishes once taken (`intelFolder` in `levels/town/buildings.ts` makes a blue file). |
| `detonate` | A timed charge (`charges`) has gone off. `steps` give the line while it is to be found, carried and ticking. |
| `extract` | A player is inside the area once every other main goal is done. |

- `main: false` makes a side goal: it shows and counts, but never blocks the win.
- `after: [ids]` orders goals.
- `done` is the message shown when the goal completes.

The mission is won when every main goal is done. The run then ends on the pause page under `briefing.won`. Goal progress is part of the mission state, so it saves, restores on retry and is shared in co-op.

## Checks

`scripts/levels-checks.ts` builds every catalog level in Node and checks:

- The player lands and stands at the insertion.
- No guard can see the insertion: none within his sight range (a sniper's is half the map) with a clear line to it, at his post facing his way, or anywhere on his patrol.
- Every guard post and patrol point is floor a guard fits on.
- Every station can be reached and seen.
- Every goal points at something that exists.
- Every goal area can be walked to from the insertion.
- A run that does everything wins.
- The briefing has a usable map.
- Every enterable building is dark inside.

Each failure names the level and the thing at fault.

## Limits to know

- **Guard route length.** Guards plan routes on a 0.8 m grid within a window around the start and goal, and give up past about 2,200 cells. A guard asked to cross a very large level in one go may not find the way. Give long patrols intermediate points.
- **Single-floor goal areas.** Reach and extract areas are cylinders (3 m tall by default). For an upper floor or a roof, set `center[1]` to that height.
- **One body model.** Every character is the one stickman rig. New enemy looks are made by fitting gear to it, as Bulky Boy's armour does (`actors.makeBoss`), and are shared with the animation lab.
