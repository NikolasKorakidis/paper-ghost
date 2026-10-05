# The guards' brain

The standard is Metal Gear Solid V. Guards should feel like a garrison that talks to itself. One guard who sees
something makes his whole post nervous, a body raises the area, search parties fan out, and neighbouring posts hear
it over the radio and turn your way. Kill the radio operator first and nobody hears. Hit a post often and it adapts.
Nothing may cost a frame: every system below runs inside a fixed per-frame budget and makes no garbage on its hot
paths.

## Layers

| Layer | File | What it decides |
| --- | --- | --- |
| Senses | `ai.ts` (`sees`, `awareness`, `hear`, `hearGunfire`, `noticeBody`) | 120° view, the ? that fills by angle, distance, stance and caution; gunshots heard 75 m off (55% through walls); bodies seen 25 m off |
| Guard | `ai.ts` (`update`, `combat`, `search`, `move`) | patrol → suspicious → investigate → combat → search; cover, peek, flank, charge, retreat; resupply |
| Squad | `ai.ts` (`formSquads`, `alertSquad`, `suppressor`, `tryGrenade`, `losingFight`) | squadmates are alerted together; in a fight one suppresses while the others move, frags go over cover, a squad cut in half falls back |
| Zone | `zones.ts` + `ai.ts` (`formZones`, `updateZones`, `zoneChanged`) | each building's area has an alert phase (normal, caution, search, alert) and a memory of you |
| Radio | `ai.ts` (`assignRadios`, `zoneRadio`, `checkIn`, `overwatch`) | each zone's operator and its radio sets; check-ins; snipers calling out your position |
| Torches | `flashlights.ts` | guards hunting through dark rooms carry a light |
| Routes | `navigation.ts` | grid A* (0.8 m cells) with cached floor samples and steps, resumable within the planning budget |

Tunables live in `balance.ts`: `DETECTION`, `GUNSHOT_HEARING`, `ENEMY_COMBAT`, `ZONES` and `COMBAT_ROLES`.

## Districts

The campaign maps are split into a few authored districts (`MissionWorld.zones` with `district: true`). The compound
has three: Yard, Warehouses and Detention. The town has five: North road, Church quarter, Town centre, Farm and Hotel
hill. Districts keep a fight from pulling in half the map:

- **Movement:** an alerted guard never leaves his district. `tether` brings any destination outside it back just
  inside. Calm patrols keep their authored routes.
- **Fighting:** he fights you only while you are in his district or within `ZONES.district.engage` m of it, or when
  you shoot at him (`provoked`). Seen across the line, you are watched, not engaged.
- **Trouble elsewhere:** a sound, a sighting, a comrade's gunfire, a radio call, an alarm or a sniper's callout from
  another district only puts him on caution and turns him to watch (`watchFrom`).
- **Bodies:** a body seen over the line is radioed in, and that district searches.
- **Help:** squads never form across a line, and help comes only from the same district.
- **Radio:** districts warn each other only by radio, never by shouting.

Each district's radioman wears its radio on his back: a grey pack, the zone's operator. A shot that meets the pack
before any body smashes it (`EnemyHit.pack`) and leaves him unhurt. His district then has no radio: no warnings, no
help and no check-ins.

## Zones

A zone is a building and its yard (`ZONES.yard` m), made from every object with `userData.footprint`. Buildings within
`ZONES.join` m of each other count as one, such as a barracks and its wing. Squads posted in the open get a zone round
them. A level can author its own with `MissionWorld.zones`, and a guard can name his with `EnemySpec.zone`. The
compound has 17 zones and the town 11.

| Phase | Starts when | Guards do | Ends |
| --- | --- | --- | --- |
| alert | a guard of the zone sees you | fight with squad roles (below) | no one sees you for `ZONES.lost` s → search |
| search | contact lost, or a body found | teams of `ZONES.team` sweep out along their own compass slices, the first team the way you were heading, checking hiding places and bounding; `ZONES.keep` stay at post | `ZONES.time.search` s → caution, and the zone adapts |
| caution | trouble elsewhere (by radio), a gunshot heard here, a missed check-in | everyone spots faster; calm guards turn toward it; nearby zones send two screens to cover that side | `ZONES.time.caution` s → normal |

An alert or search puts every other zone on caution, and the nearest cautious zone sends `ZONES.reinforce` men. Both
go over the zone's radio.

## Radio

Each zone has an operator, who carries the radio pack: `EnemySpec.radio`, else (in a district) the patrolling guard
nearest its middle, else the guard posted nearest a radio set in the zone, else its middle guard. The zone's radio is up while the operator lives with his pack whole and, if the zone has field radio sets (`userData.questItem =
'radio'`), at least one still works. The sets are switched off or shot through the existing radio objectives.

- **Check-ins:** every `ZONES.radio.interval` s the operator calls round. A dead guard nobody has found misses it: the
  zone goes on caution and the nearest calm man goes to his post.
- **Radio down:** the zone cannot warn the other zones or call for help. The player sees "*Zone*: radio silent."
- **Overwatch:** a sniper with you in his scope radios your position every `COMBAT_ROLES.overwatch.every` s to every
  man hunting you within `reach`.

## Search quality

- **Hiding places** (lockers, wardrobes, shelves, crates, counters, beds: `HIDING_FURNITURE`, or `userData.hidingSpot`)
  near the search are checked first. The searcher stands beside each one and looks into it.
- **Bounding:** a team's second man waits, covering, until his leader reaches each place. The leader waits up to
  `BOUND_HOLD` s for him to catch up.
- **Lost contact:** the first place searched is where you were heading, along ground you could actually walk. If the
  way ahead is blocked, it follows the passage round the turn.
- **Torches:** a guard searching, investigating, or fighting someone he cannot see inside a dark room switches on a
  torch. It is a forward-only warm light without shadows, added to the existing lighting.

## Ammunition (`AMMO`)

- **Guards:** each carries four magazines. Run dry, he restocks at a supply crate in his own district. With none, he
  draws his knife and comes for you, stabbing within `COMBAT_ROLES.knife.reach`.
- **Player:** carries at most two magazines of any gun, from the start, at a crate, or picking a gun up off a body.
- **Guns placed in a level:** hold one magazine.

## Squad roles in a fight (`COMBAT_ROLES`)

- **Suppress:** once you are out of sight, the first squadmate holding his ground fires blind at where you were for
  `suppress.time` s. Blind rounds do no damage. A guard fighting alone has nobody to cover and does not suppress.
- **Grenade:** if you stay down for `after` to `until` s, a man with a frag lobs it over your cover. He only throws
  with a clear arc and no comrade within `clear` m of the landing spot, and his squad then waits `cooldown` s.
- **Dodge:** a guard within `dodge.radius` of a grenade landing runs from it.
- **Fall back:** once a squad has lost as many men as it has left, its wounded fall back (to cover, or simply away)
  and the zone calls for help again.

## The garrison adapts (`ZONES.adapt`)

Each alert or search adds to the zone's heat and records where it started. When a search stands down:

1. **From heat 1:** a sentry is posted just inside the zone where you were first seen, watching the way you came (up
   to two sentries).
2. **From heat 2:** patrols walk in twos, the second man a few steps behind the first.
3. **From heat 3:** guards wear helmets. A helmet stops one head shot and is knocked off by it; sniper rounds go
   through.

## Performance rules for AI code

- **Plans are budgeted.** Route searches are generators. They get 2 ms a frame, 3 ms when guards are queueing, and
  1 ms when the machine is already below 45 fps. Idle frames spend up to 1 ms warming the routes guards will need
  (patrol legs, ways between neighbouring zones). Never call `navigation.plan` per frame. Replays use `planningSteps`.
- **No garbage on hot paths.** Per-guard, per-frame code uses scratch vectors and indexed loops. In V8, `for…of`,
  closures, spread arguments, `Math.hypot` and default `[]` parameters each allocate.
- **Crowd grid.** `separated` looks only at guards in the 2 m cells around a step.
- **Animation level of detail.** Guards more than 55 m from every player animate every 2nd frame, and those more than
  110 m away every 4th, with the skipped time saved up. Turning, starting, stopping, fighting and hit reactions always
  animate every frame.
- **Caches are local.** Navigation caches use numeric keys, and a door change forgets only the cells near it.
  `looksOpen` (two rays) runs before a full walk check, but only on one floor.
- **Collision matches three's Octree exactly.** `scripts/collision-index-checks.ts` proves it.

## Tried and dropped

**Shared flow fields** (one search out from a destination for all the guards heading there) were built and measured:
they took about 8× more floor probes than separate searches. Separate searches already share the cached ground, while
a flow field floods every direction around the goal. **Hierarchical (zone-graph) routes** would hit the same limit:
the cost is sampling the world, not the search itself. Precomputing in idle time and the adaptive budget are what
help, and both are built.

## Tests

`npm run test:zones` runs zones, radio and garrison (`scripts/zone-ai-checks.ts`), senses
(`scripts/guard-senses-checks.ts`), search quality (`scripts/search-ai-checks.ts`) and squad roles
(`scripts/combat-roles-checks.ts`).

## Next ideas

- Interrogation: hold a guard to learn where the others are.
- Carrying and hiding bodies, so that check-ins become the real threat.
- Night versions of the levels, where torches matter everywhere.
- A per-zone reinforcement truck arriving at the gate.
