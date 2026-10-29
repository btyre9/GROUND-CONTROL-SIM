# OpenATC Tower (ground and local control)

A 3D tower view where you work departures from the gate to the sky: approve pushback, issue taxi
clearances along the real taxiway network, clear runway crossings, line up and wait, and clear for takeoff.

## Running it

From this folder run `python3 serve.py 8000` and open <http://127.0.0.1:8000/>. It loads
`KBOS_Scenery_Pack.zip` (Boston Logan) by default. The pack comes from the X-Plane Scenery Gateway and is
GPL-licensed (see `COPYING` inside the zip).

Without the private `3d-aircraft/` and `sound/` folders the sim still runs, with placeholder airliners and
no sound. `voice-commands.js`, `pilot-radio.js` and `radio-effect.js` are shared with the approach sim
(<https://github.com/btyre9/ATC-SIM>); copy any changes across by hand.

## Airports

Every airport comes straight from an **X-Plane Scenery Gateway** pack (<https://gateway.x-plane.com>).
Download an airport's pack and either drop the .zip onto the view or use **Open airport…**. You can also
put the zip in this folder and open `?airport=NAME.zip`.

From the pack's `apt.dat` file the sim builds:

- runways with FAA markings (threshold bars, designations, aiming point, touchdown zone, centerline)
- pavement outlines and the painted taxiway lines, hold-short lines and edge lines
- the taxi route network with real taxiway names, used for routes like "taxi via E, A, N"
- runway safety areas, which set where aircraft hold short
- gates with their size class and airlines, jetways, and the tower position for the cab view

From the pack's `.dsf` tiles it reads where the terminals, garages and hangars stand (outline and height)
and where ramp equipment is parked. The detailed 3D art those tiles name belongs to X-Plane's library
and is not in the pack, so buildings are drawn as plain shapes and equipment as boxes.

The ground under and around the airport is aerial imagery: USGS National Map imagery (public domain,
US only), with Esri World Imagery for any tile USGS can't supply. The credit line in the corner shows which
was used. Without a connection it falls back to plain grass and water. Pavement, walls and roofs use
textures drawn in code (`textures.js`), so every airport gets them.

Scenery Gateway packs are GPL v2 (see `COPYING` inside each zip).

## Aircraft models

Parked and departing jets use real 3D models where we have them, painted in the airline's livery, and a
simple placeholder airliner otherwise. Models and liveries are listed in `3d-aircraft/aircraft.json`. The
whole `3d-aircraft/` folder stays out of git, because each model and livery has its own license, so the
online version shows placeholders.

**Converting an X-Plane aircraft** (exterior only: list the objects to keep, leaving out cockpit and cabin):

```
python3 tools/xplane_obj_to_glb.py "path/to/737NG Series" 3d-aircraft/models/B739.glb --acf 737_9ENG.acf \
  --objects 737_9ENG/737_9ENG_fuselage.obj,737_wing.obj,737_wltail.obj,737_cfm56.obj,737_lg.obj,737_glass.obj,cabin/737_9ENG_glass_exterior.obj,737_lights.obj,737_lights2.obj \
  --windows cabin/737_9ENG_glass_exterior.obj --set b737_variant=4 --set wings_variant=1
```

It poses the model with the gear down (`acf_gear_deploy` or `gear/deploy_ratio` at 1; `--set` picks other variants; LevelUp's `b737_variant` is
0 = -800, 1 = -900, 2 = -700, 3 = -600, 4 = -900ER), keeps the aircraft's light positions, gives each cabin
window a random number so some light up at night, and shrinks textures to 2048 pixels.

**Doors that open** (for the ramp): `--animate DATAREF=NODE,...` keeps the listed doors movable instead of
baking them shut. Whatever each dataref moves (the door skin, its window, its inside lining) becomes a child
node with that name, drawn closed, with a morph target for each sampled value up to 1 (keyframes plus enough
in between to stay within 1 cm of X-Plane's motion) and an animation of the same name: set the clip's time to
the door's 0..1 ratio. Materials keep their names, so liveries still paint the doors. The file's
`asset.extras.doors` lists each door's node, dataref, sample values, side, hinge, sill point, size and bounds
closed and open. `B739-doors.glb` adds the cargo holds and door vestibules (`cabin/737_9ENG_cabin_underfloor.obj`)
so open doors show an inside:

```
python3 tools/xplane_obj_to_glb.py "path/to/737NG Series" 3d-aircraft/models/B739-doors.glb --acf 737_9ENG.acf \
  --objects 737_9ENG/737_9ENG_fuselage.obj,cabin/737_9ENG_glass_exterior.obj,737_9ENG/737_9ENG_fuselage2.obj,737_wing.obj,737_wltail.obj,737_cfm56.obj,737_lg.obj,737_glass.obj,737_alpha.obj,cabin/737_9ENG_cabin_underfloor.obj,737_lights.obj,737_lights2.obj \
  --windows cabin/737_9ENG_glass_exterior.obj --set b737_variant=4 --set wings_variant=1 --set led_lights=1 \
  --animate 737u/doors/Fwd_Cargo=fwd_cargo,737u/doors/aft_Cargo=aft_cargo,737u/doors/L1=door_L1,737u/doors/L2=door_L2,737u/doors/R1=door_R1,737u/doors/R2=door_R2
```

**Registering it and adding liveries** (any livery folder painted for that model):

```
python3 tools/add_livery.py model 3d-aircraft B739 models/B739.glb --sizes C
python3 tools/add_livery.py livery 3d-aircraft B739 DAL N814DN "path/to/(9ENG) Delta N814DN"
```

Each gate lists its airlines, so a Delta gate gets a Delta jet. Airlines without a livery get the model in
plain white. A livery pack alone has no 3D model: it needs the aircraft it was painted for.

## Night

**Time** sets the sim clock:
- **Options:** Now (the real time), or Sunrise, Morning, Noon, Afternoon, Sunset, Dusk or Night, worked out from
  that day's sunrise and sunset at the airport (`astro.js`).
- **The clock runs with the sim**, so the sun moves, and the time shows in Zulu beside the menu.
- **The sky** (`sky.js`) scatters sunlight: blue by day, gold and red at sunrise and sunset, with the sun's disk.
  After dark come stars and the moon in its real phase, which gives a little moonlight.

At night:
- **Airfield lights:** taxiway edge and centerline lights, hold-short lights, and runway edge, threshold and
  end lights, all taken from the airport data.
- **Floodlights:** apron floodlights glow and light the ramp from high above, and terminal windows light up
  with some rooms dark.
- **Aircraft lighting:** jets are lit by their surroundings (image-based lighting): the sky by day, the floodlit
  airport at night, so white fuselages and liveries stay readable after dark and the paint has a sheen.
  Buildings keep their own lighting.
- **Aircraft:** cabin windows light up at random, red and green wingtip lights and white tail lights are on,
  and logo lights wash the airline's tail. Following FAA AC 120-74, the red beacons on the roof and belly
  start flashing at pushback, the bright nose gear taxi light (lighting the taxiway ahead) is on while
  taxiing, strobes flash on entering the runway, and landing lights come on with the takeoff clearance.
  Models exported without lights, and the placeholder airliner, get the same set placed from their shape.

**Glow:**
- **Rendering:** the scene renders in HDR with ACES tone mapping, then a bloom pass.
- **Bright light sources:** lights are drawn brighter than white so they bloom. They also fade in fog
  and spread into halos in fog, mist and rain.
- **Bloom strength:** a faint sheen by day, a strong glow at night.
- **Night fog:** it glows faintly with the airport's lights.
- **Graphics resets:** if Chrome resets the graphics, the sim rebuilds its rendering instead of going black.

## Ground map

The small window shows the airport from above, like the FAA airport diagram, or switch to **ASDE-X**
for a dark radar-screen look. It shows:
- every aircraft to scale, with moving ones tagged: callsign, size class, ground speed and status
- the selected aircraft's remaining route and hold points

Drag to pan, scroll to zoom, click an aircraft to select it. **Swap** puts the map in the main view and
the 3D view in the small window. Taxiway names also float over the taxiways in 3D (**Taxiways**).

## Clearances

Type in the command box, or click **MIC** and speak (Chrome). Start with the callsign, or select a strip
and leave it out. Pilots read back over the radio, or say why they can't. **COMMANDS** shows this list.

| Typed | Spoken example | Meaning |
|---|---|---|
| `PB` | "Delta four ninety seven, push back approved" | Pushback |
| `TX 22R E A N` | "Runway two two right, taxi via echo, alpha, november" | Taxi along those taxiways in order; leave them out for the usual route |
| `HS 4L` | "Hold short runway four left" | Hold short |
| `X 4L` | "Cross runway four left" | Cross a runway on the route |
| `HP` / `CT` | "Hold position" / "Continue taxi" | Stop where you are / carry on |
| `LUAW` | "Runway two two right, line up and wait" | Line up and wait |
| `CTO` | "Runway two two right, cleared for takeoff" | Takeoff |

- **Combining instructions:** one transmission can hold several, for example `DAL497 PB TX 22R E A N HS 4L`.
- **Taxi routes:** a taxi clearance can come with the pushback, during it, or while taxiing (to change the
  route). Pilots follow the taxiways you name and say "unable" if those don't connect to the runway.
- **Crossings:** every runway on the way needs its own crossing clearance.
- **Pilot calls:** pilots call ready to push, ready to taxi, holding short, and ready for departure.
- **Strip buttons** give the same clearances.

## Buildings made in Blender

Landmarks that the scenery data can't describe are modeled in Blender:
- **The Logan tower:** `blender/kbos-tower.blend`, modeled from photos. It has twin 9 m concrete pylons with
  formwork joints, a six-story banded glass block over an open gap, the bronze hipped roof, the octagonal
  cab and the radome, 287 ft to the top (the real one is 285 ft).
- **Exported for the sim** as `models/kbos-tower.glb`. Any airport with a `models/<icao>-tower.glb` uses it in
  place of the plain tower, turned to face the airfield.
- **To touch it up:** open the .blend, edit, then export with **File → Export → glTF 2.0 (.glb)**, Y up,
  meters, to `models/kbos-tower.glb`. Keep the base at the origin and the front facing −Y. The camera's eye
  is at 84 m, inside the cab glass (80.3–85.5 m).

## Weather

**Weather** chooses **Live** or a preset (clear, scattered, overcast, rain, thunderstorms, fog, snow).
- **Live data:** US airports get the latest National Weather Service observation. When a report has no
  METAR text, its separate values are written as one. Other airports get Open-Meteo's current conditions.
  Both are free, need no key, and refresh every 10 minutes.
- **One reader for everything:** presets are written as METARs, so all weather is read the same way
  (`metar.js`).
- **The weather bar** at the top of the view shows the METAR and what it means.

What you see:
- **Visibility:** sets how far you can see.
- **Clouds:** gray the sky and dim the sun.
  - **Cumulus** (`cumulus.js`): FEW, SCT and BKN layers are heaps of soft puffs at the reported base. Their tops are lit
    by the sun (golden at sunset) and their undersides shaded. They tower in thunderstorms and drift with the wind.
  - **Overcast** is a solid deck of rolling stratocumulus: dark masses with lighter seams, brighter toward the horizon.
- **Rain or snow:** falls around the camera and blows with the wind. The pavement looks wet in rain.
- **Thunderstorms:** lightning flashes, followed by thunder.
- **Low visibility:** airfield lights come on below 3 miles or under a 1,000 ft ceiling.
- **Windsocks** from the airport data swing downwind. They droop in light wind, stand straight out at 15 knots and flutter in gusts.
- **Runway:** departures switch to the runway most into the wind. Under 5 knots counts as calm, and the
  current runway stays.

## Ground vehicles

The vehicles (`vehicles.js`) drive Logan's service roads, which come from the airport data.
- **Pushback tugs** wait at their parking spots. When a departure calls ready to push, a tug with a yellow tow
  bar hooks onto its nose gear and pushes it back. Then the tug unhooks, swings clear and drives to a free spot.
- **Baggage trains** shuttle between the gates and the bag rooms: a tractor towing three or four covered carts
  that follow its track around corners.
- **At night,** every vehicle flashes an amber beacon.
- **Models** were made in Blender (`blender/ground-vehicles.blend`) and are exported to `models/vehicles/`.

## Sound

The sound files are in `sound/web/`, which is kept out of git because the sounds are licensed:
- **Ambience:** airport exterior by day, distant airport at night, crossfading with the time of day. Rain adds
  a hiss and thunderstorms rumble (both made in code).
- **Gate noise:** the gate recording rises as the camera gets near parked jets.
- **Takeoffs:** each takeoff plays one of three runway recordings from the aircraft itself, so it fades
  with distance.
- **The tower cab** muffles everything, as if behind the glass.
- **Turning it off:** use **Sound**. Without the files the sim is silent.

To prepare new recordings, make loops with `tools/make_loop.py` (it trims the ends and blends the end into
the start), then encode with `afconvert -f m4af -d aac -b 128000 in.wav out.m4a`.

## Controls

- **Pause** (or P / space bar): traffic, timers, lights and sound stop; you can still look around.
- **Tower:** drag to look around, scroll to zoom like binoculars.
- **Orbit:** drag to rotate, right-drag to pan, scroll to zoom.
- **Follow:** chase the aircraft selected in the flight strips.
- **🎯 on a strip:** fly the orbit camera to that aircraft; it stays with the jet as it moves. Drag to circle it.
- **Flight strips:** each departure shows its state and the clearances you can give right now.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `main.js` | Page, cameras, flight strips, loading airports |
| `apt-parser.js` | Reads apt.dat; taxi routes and route names |
| `dsf-parser.js` | Reads DSF tiles: object placements and facade outlines |
| `airport-scene.js` | Builds the ground, runway paint, lines, tower, jetways and buildings |
| `imagery.js` | Aerial photo tiles draped on the ground, sharp near the airport |
| `textures.js` | Asphalt, concrete, wall and roof textures drawn in code |
| `aircraft-model.js` | Real .glb models by size class, else a placeholder airliner with airline tail colors |
| `lights.js` | Glowing point lights: aircraft beacons, strobes, nav and landing lights, airfield lights |
| `ground-radar.js` | The top-down ground map with live traffic |
| `ground-commands.js` | Reads typed and spoken ground and tower clearances; readback wording |
| `sounds.js` | Airport ambience, gate noise and takeoff roars |
| `metar.js` | Reads METARs (live or preset) and picks the into-wind runway |
| `weather.js` | Clouds, rain, snow, lightning and windsocks |
| `ramp-logic.js` | Which gates have an airliner, different each load |
| `astro.js` | Sun and moon position, moon phase, sunrise and sunset |
| `sky.js` | Sky, sun, stars, moon and the light they give |
| `cumulus.js` | Puffy, sunlit, drifting cumulus clouds |
| `vehicles.js` | Pushback tugs and baggage trains |
| `ground-traffic.js` | Departures: pushback, taxi, hold short, crossings, line-up, takeoff |
| `tools/xplane_obj_to_glb.py` | Converts an X-Plane aircraft's exterior to a .glb model |
| `tools/make_loop.py` | Turns a recording into a seamless loop |
| `tools/rocketbox_to_glb.py` | Dresses Rocketbox avatars as ramp agents and builds their animations |
| `tools/add_livery.py` | Registers models and builds web-size liveries in `3d-aircraft/aircraft.json` |

Run the tests from the project folder with `node --test`.

## Ramp operations simulator (`ramp.html`)

A training sim for ramp agents at one gate: open <http://127.0.0.1:8000/ramp.html>. An aircraft arrives,
and the crew prepare the stand, park it, make it safe, dock the bridge and service it. You play one
role and the sim does the others, so each role can be practised on its own.

- **Roles:** marshaller, wing walkers, lead ramp agent, bridge operator, or observer (watch a clean turn).
- **Moving and acting:** **WASD** to walk, **Shift** to hurry, drag to look, wheel to zoom. **E** does
  the task at the yellow marker. Marshallers and wing walkers signal with the number keys or the
  buttons. **V** changes the view (follow, orbit, flight deck, bridge cab); **H** shows the engine
  intake and exhaust hazard zones.
- **Guided:** shows your next step and where to go. Untick it to assess someone without hints.
- **Scoring:** every action is checked against the safety rules (nobody approaches before the beacon is
  off, chocks before equipment, no equipment in the ERA during arrival, keep out of engine zones, stop
  on the bar). Breaking one is logged with the reason; the debrief lists them and gives pass or fail.
- **Scenarios** are JSON files in `ramp/scenarios/`, listed in `ramp/scenario-list.json`. Each gives
  the aircraft, time of day, guidance (`marshaller` or `vdgs`) and the steps in order: who does each
  (`role`), what (`action`, from `ACTIONS` in `ramp/procedures.js`), what it follows (`after`) and the
  pause before the sim does it (`delay`). `node --test ramp/` checks every scenario is a clean turn.
- **On the stand:**
  - FAA-style markings: lead-in line, 737 stop bar, red ERA line, service road, bridge parking box,
    GSE boxes and hydrant pits.
  - An apron-drive jet bridge (`ramp/jetway.js`) carrying its point-of-use equipment: a PCA unit
    with its yellow hose in a basket, a 400 Hz converter with a cable hoist, and a potable water
    cabinet. The hose and cable run out to the aircraft's connectors.
  - A belt loader, chocks and cones (`ramp/gse.js`), and the tug and baggage train from the tower sim.
- **Crew** are Microsoft Rocketbox avatars (`models/crew/`, MIT license in `LICENSE-Rocketbox.txt`) dressed
  for the ramp by `tools/rocketbox_to_glb.py`. It takes off the hard hats and tool belts, repaints the
  workwear, fits a hi-vis vest cut from each body's own torso (so it bends with it), and adds caps or
  beanies, earmuffs or a headset, a speaker-mic and lighted wands. `--uniform delta` gives a red shirt,
  dark gray trousers, black boots, a gray cap and an orange vest with lime bands, a black hem, a flag
  patch and the name. They walk, crouch and knock with Rocketbox's recorded animations
  (`models/crew/animations.glb`), and the marshalling signals move their arm bones. To rebuild them
  (Blender 4.2 or later; avatars from `Assets/Avatars/Professions/` in the Rocketbox repository):

  ```
  blender -b --python tools/rocketbox_to_glb.py -- avatar Construction_Male_05 models/crew/marshaller.glb --uniform delta --headwear cap --ears muffs
  blender -b --python tools/rocketbox_to_glb.py -- animations --rig Construction_Male_05/Export/Construction_Male_05.fbx models/crew/animations.glb m_idle_neutral_01.fbx m_walk_neutral_01.fbx m_run_slow_01.fbx m_idle_look_around_01.fbx m_crouch_in.fbx m_crouch_idle.fbx m_crouch_out.fbx m_knock_door.fbx
  ```

  The crew files are marshaller (Construction_Male_05), wingwalker-1 (Male_02, beanie), wingwalker-2
  (Female_01, beanie), lead (Male_08, headset) and agent (Male_06, headset). Without them the sim
  draws simple people instead, who wear the same ramp PPE:
  - ANSI Class 2/3 vests with reflective bands
  - earmuffs, or a headset with a boom mic and a radio on the vest
  - safety glasses, gloves and boots
  - lighted wands for marshallers and wing walkers

  Signals follow FAA AC 00-34.
- **Weather** (`ramp/atmosphere.js`): clear, scattered clouds, overcast, rain, snow or fog, from the
  scenario's `weather` or the **Weather** menu. It follows how the browser game Slow Roads does it:
  - **Sky and fog are one function:** the horizon-to-zenith color, the glow toward the sun and the
    noisy ground haze are worked out per pixel for both the ground and the sky, so they meet with no seam.
  - **Look table:** a hand-tuned table of colors and visibility for each weather.
  - **Clouds:** a deck at the ceiling height that drifts with the wind.
  - **Rain and snow** fall entirely on the GPU.
  - **Wet pavement:** it darkens and turns glossy, with puddles that reflect the floodlights and ring in the rain.
  - **Snow:** it settles on the bridge and equipment and lies in drifts on the plowed ramp, but not on
    the aircraft or crew.
- **Doors:** with `3d-aircraft/models/B739-doors.glb` (see "Doors that open" above) the cargo and
  passenger doors open, so unloading shows bags coming out of the forward hold.
