# Lapis on s&box: pilot

A first step toward porting Lapis to s&box (Facepunch, Source 2, C# components) before anyone has
SDK access. It answers one question: can the game's logic move to C# *exactly*, so the s&box build
plays the same as the browser build?

The pilot ports two systems, with no engine code in them:

- `src/core/player.ts` -> `Lapis.Core.PlayerController`: walking, sprinting, jumping (with the instant
  push), gravity, falling into deep water and respawning on the last safe ground, wading, step-up and
  max climb, circle colliders, stacked platforms (`Top(x, z, y)`) and `Blocked`, gliding, and the boat
  (rowing, stroke pulses, the power-stroke timing window, currents, bumping, stepping ashore, calling
  the boat).
- `src/core/night.ts` -> `Lapis.Core.NightClock` with its cues and phrase.

A parity test runs the TypeScript originals and the C# port on the same inputs and compares every
step.

## Layout

```
sbox/
  Lapis.Core/        engine-free class library (netstandard2.1), namespace Lapis.Core
  Lapis.Parity/      console app: replays the reference traces against the C# port
  parity/            reference traces (JSON) recorded from the TypeScript
  Sandbox/           s&box components (NOT compiled, untested against the SDK)
tools/parity/
  ts/player.ts, ts/night.ts   verbatim copies of the git HEAD sources
  world.ts                    the test world (heightfield, colliders, spiral stair, ledge, pillar, rock, current)
  trace.ts                    runs the scenarios and writes sbox/parity/*.json
```

`sbox/Lapis.Parity/TestWorld.cs` mirrors `tools/parity/world.ts` line for line. If you change one,
change the other.

## Running it

You need the .NET SDK (`brew install dotnet`, .NET 10 used here) and Node 24.

```sh
# Run the parity test against the committed traces
dotnet run --project sbox/Lapis.Parity

# Re-record the traces from the TypeScript (only needed after changing player.ts/night.ts or the scenarios)
cp src/core/player.ts tools/parity/ts/player.ts
cp src/core/night.ts tools/parity/ts/night.ts
cp src/core/survival.ts tools/parity/ts/survival.ts
node --experimental-transform-types --no-warnings tools/parity/trace.ts
```

`--experimental-transform-types` is needed, not just type stripping, because `player.ts` uses a
constructor parameter property (`constructor(private world: WorldQuery)`).

Each trace stores the inputs as well as the state, so scenarios that steer off the player's position
(the stair climb, the timed power strokes) replay exactly on the C# side. Every step checks
position, heading, speed, vertical velocity, falling timer, anim and anim rate, mode, airborne, prompt
text, the full boat state and the events fired, with an absolute tolerance of 1e-4. The C# port
actually matches to about 1e-15.

| Scenario       | What it covers |
|----------------|----------------|
| `walk_sprint`  | camera-relative walking, turning, sprint, strafing, the stick dead zone, sliding round a trunk |
| `jump_ledge`   | being refused by a ledge too tall to step onto, a running jump onto it, a standing hop, a sprint jump off the far side |
| `spiral_stair` | through a door in a wall (`Blocked`), up a spiral stair with treads every 0.25 m and stacked turns (`Top` with y), off the top onto a lower tread |
| `wading`       | wading to the deep-water limit, sprinting along it, coming back |
| `deep_water`   | jumping into deep water, falling, sinking, respawning on safe ground (twice) |
| `glide`        | moth wings: gliding off a 12 m pillar, a collider in mid-air, letting go of jump and gliding again |
| `boat_row`     | boarding, power strokes on and off the catch, sprint rowing, turning, a star current carrying the boat and swinging the bow, rowing home and stepping ashore |
| `boat_rock`    | the hull bumping off a rock (`BlocksBoat`), backing off and rowing round it |
| `call_boat`    | board, step ashore, walk 40 m+, hold E to call the boat, the boat drifting over, boarding again |
| `night`        | uneven frame times, a reset partway through, all four cues firing once each |

## How the core maps onto s&box

- **No engine types in the core.** `Vec2`/`Vec3` are minimal structs of its own. In s&box,
  `Sandbox/SceneWorld.cs` (`LapisSpace`) converts: Lapis is Y-up metres with heading 0 = +Z; s&box is
  Z-up inches, X forward, Y left. Both are right-handed, so lapis `(x, y, z)` becomes s&box
  `(z, x, y) * 39.37`, and a Lapis heading in radians is the s&box yaw in degrees.
- **Doubles, not floats.** The core uses `double` throughout to match JavaScript numbers bit-for-bit.
  The adapter casts at the boundary. `LapisMath.Hypot` reproduces V8's `Math.hypot`, which rounds
  differently from `Sqrt(x*x + y*y)`.
- **World queries become traces.** `IWorldQuery.Height` casts down onto anything tagged `terrain`,
  relative to a `WaterLevel` property. Lapis assumes the sea is at height 0. `IPlatforms.Top(x, z, y)`
  casts down from one step (0.55 m) above `y` onto anything tagged `platform`. That first hit *is* the
  "highest surface within a step", so stacked stairs work without the core knowing what a stair is.
  `Blocked` sweeps a body-radius sphere from knee to head against `solid`/`platform`. `IColliders`
  enumerates `LapisCircleCollider` components.
- **Fixed tick.** `LapisPlayer` drives the controller from `OnFixedUpdate` with `Time.Delta`. The TS
  smoothing (`min(1, dt * k)`) depends on frame rate, so a fixed tick makes behaviour consistent, and
  it is what the traces assume. Mouse look and the camera run in `OnUpdate`.
- **Input.** `Input.AnalogMove` (x forward, y left) becomes `MoveY = x, MoveX = -y`. `Run`, `use`
  and `Jump` are read with `Input.Down`, not `Pressed`, because the core does its own edge detection
  and also needs how long E has been held (to call the boat).
- **Events.** The core raises `event Action<PlayerEvent>`; `LapisPlayer` re-raises it for audio/UI.
  `LapisNight` wraps `NightClock` the same way.
- To use it in an s&box project, copy `Lapis.Core/*.cs` and `Sandbox/*.cs` into the game's `Code/`
  folder. s&box compiles source and doesn't load arbitrary DLLs. The core relies on default
  interface members (`Flow`, `Blocked`), which the s&box compiler supports.

## What remains

- Compile `Sandbox/` against the real SDK. It was written from the public API without access, so
  expect some renames (trace builder methods, `Angles` helpers, input action names in the project's
  input settings).
- Tag the scene geometry (`terrain`, `platform`, `solid`) and tune the trace-based adapters against
  the lighthouse model. The browser's `LighthouseClimb` computes the stair analytically. In s&box it
  should be real collision geometry plus the down-cast above.
- A currents source for `SceneWorld.Currents` (the browser's star currents), and the HUD for
  `Prompt` and `NightClock.Phrase`.
- Port the next systems the same way, each with a parity trace: the rest of `src/story`, then
  stones/climb as data-driven platforms.
- Animation (`Anim`, `AnimRate`), audio on events, and the respawn fade (`Falling`) all need
  presentation on the s&box side.
