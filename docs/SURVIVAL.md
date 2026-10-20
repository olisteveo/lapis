# Survival: warmth, light and the night

Lapis is an exploration game about a memory keeping a drowning girl alive. This document adds survival to it without
turning it into a survival game: no health bars, no crafting, no combat, no death. Everything here is decided; the
open questions at the end are the only things still to settle.

## The idea in one line

Light keeps her alive. You carry it, you gather it from the glowing world, you spend it to survive the dark, and the
cold tells you, on screen, how long you have left.

## Principles

- **Threat, never death.** Nightmares and the cold can beat you, but failure always costs something you carry, never
  your life. You wake on the beach (or at your last lighthouse) and the stars you were carrying scatter.
- **Calm early, tense late.** The young night is for exploring. Danger rises as the night wears on.
- **Warmth has no HUD.** It is shown on the picture itself, the way the night already is. The light you carry has a
  small gauge above the keepsakes: one pip per flare's worth.
- **The glow is the resource.** The light we added to every region (mushrooms, glow-worms, surf, moonflowers,
  crystals, sea light) is what you gather. Beauty and survival are the same thing.
- **Story mode exists.** Anyone who wants the story can turn survival down.

## The night

- A full night lasts about **20 minutes** (the current `NightClock(20 * 60)`).
- It is a **soft limit**: when it runs out you wake at your last lighthouse and lose what you carry. Resting buys time.
- Cues stay as now (late, cold, eyes, wake), and the threat curve follows `night.progress`.

## Resting at lighthouses

Today resting works in code (it banks stars, resets the night, clears nightmares) but happens in a single frame with a
line of text, so it feels like nothing happened. It becomes:

- **A short sleep scene**, a few seconds and skippable. The view settles on the lamp's glow, the screen warms, frost
  melts off the edges, carried stars rise into her sky one by one, the nightmares sink away, and the night phrase
  resets. Mara's breathing under it.
- **Diminishing returns.** The first rest at a lighthouse gives a full new night. Each further rest at the *same*
  lighthouse in a row gives less (for example 100%, 60%, 35%, then a floor of 20%). Resting at a different lighthouse
  restores the full amount. This pushes you outward instead of camping one tower.
- Resting also **refills warmth** completely.

## Warmth

- A hidden value from 0 (frozen) to 1 (warm).
- **Drains** in darkness, faster in water, in wind, on the open dunes, during squalls, and as the night grows late.
- **Refills** near light: lighthouses, lit beacons, glowing flora, your own raised lantern (slowly).
- **Shown on screen only**: frost creeping in from the edges (the existing frost pass), colour draining, visible
  breath, the held keepsake's hand trembling. Audio: the wind gets closer.
- **At zero** you collapse: same as being caught. Carried stars fall back to where they lay (recoverable), the night
  moves on a little, and you wake at your last lighthouse, warm.

## Light

- A carried store of light, from empty to full, shown as a row of pips above the keepsakes (one per flare). The wisp
  holds one flare's worth from the start; the Paper Lantern raises it to three.
- **Gathering, two ways:**
  - Drifting motes (spores, pollen, glitter, sea light) trickle in as you walk through them.
  - Hold the raised lantern to a big source (a glowing mushroom, the surf, a moonflower patch) and the light streams
    into it fast. The source dims and regrows over a few minutes, so you can't farm one spot.
- **Spending: the flare.** The wisp's flare (Q) costs light instead of running on its 20 s cooldown. It bursts every
  nightmare in reach. With no light, no flare.

## Nightmares

The existing wraiths and crawlers (`src/core/nightmareBrain.ts`) gain:

- **Stealth.** They hunt by sight and sound. Running is loud and carries far; walking is quieter; creeping through dark
  grass, bushes and shadow hides you. Standing in light makes you visible but safe.
- **Packs late at night.** In the last part of the night they come in groups and try to cut you off from the nearest
  light, instead of approaching one by one.
- Light still burns them, and being touched still scatters your stars.

## Dark Water

From the original design (`docs/STORY.md`, Rules of the world): black, starless water spreads across the sea through
the night. Sparkles go out, palms grey, fog thickens, low islands submerge, and it chills you faster. Restoring a
constellation pushes it back for good in that region. This forces priorities: which region to save first.

## Squalls

Occasional squalls roll in over the sea: rain and wind drain warmth faster, dim the glow, make sea crossings risky,
and push the boat and your glide. They grow more frequent late in the game, building toward the storm in the story.

## Story mode

The existing "Night cycle" setting becomes three choices:

- **Wander**: no nights, stars kept as soon as they're gathered (today's setting off).
- **Story**: nights and resting, but warmth drains slowly, nightmares are rare and never in packs, flares are free.
- **Survival**: everything in this document.

## Build order

1. **Rest, warmth and light.** Sleep scene and diminishing rests; warmth with on-screen frost; light store, gathering
   (motes and lantern), flare costs light; story-mode setting.
2. **Nightmare stealth and packs.**
3. **Dark Water.**
4. **Squalls.**

Each phase is playable on its own and gets tuned in play before the next starts. Engine-agnostic rules (warmth, light,
rest returns) go in `src/core` like `night.ts` and `nightmareBrain.ts`, with C# parity in `sbox/Lapis.Core`.

## Not doing (for now)

Health bars, hunger, crafting, material inventories, combat, helpful creatures (moths, whale rides, star thieves),
beacons you light with your own light, and secrets revealed by light. Any of these can come back later if the core
loop wants them.

## Phase 1 status

Built: the sleep scene (a warm glow closing in, skippable with E or Space) and diminishing rests; warmth with frost
on screen and collapse; the light store and gauge; gathering from motes and by holding the lantern to glowing plants
or the surf, which run dry and regrow over three minutes; the flare costs light; Wander / Story / Survival in Play
settings. Rules in `src/core/survival.ts`, ported to `sbox/Lapis.Core/Survival.cs` with parity traces.

## Phase 2 status

Built: nightmares no longer know where you are. Each one prowls a ring around your part of the island and perceives
you through `Senses`: a noise radius (still 0, creeping 3 m, walking 11 m, sprinting 26 m, louder wading, jumps and
landings 16 m) and a visibility (light raises it; long grass, bushes, shadow, creeping and keeping still lower it),
seen only within its gaze. Noticed enough it hunts; out of touch for 4 s it searches where it last knew you were for
12 s, then gives up. Late in the night (threat above 0.65) they come in packs of two or three: when one finds you
they all hunt, and flankers aim for the point between you and the nearest light. Hold C to creep. Hunting eyes blaze,
prowling eyes smoulder; the view's edges close in while you're hidden; the wisp warns when you're found and when
you've lost them. Rules in `src/core/nightmareBrain.ts` (not yet ported to C#).

## Phase 3 status

Built: Dark Water (`src/core/darkWater.ts`, ported to `sbox/Lapis.Core/DarkWater.cs` with a parity trace) creeps in
from 6.2 km out toward the island's heart over the night, reaching 2.3 km by dawn in Survival and 3.3 km in Story.
Every region whose constellation is restored holds it back (clear to 1.2 times the region's radius), as does the
shore you woke on (wider once The Boat is restored). Where it reaches, the sea turns to starless ink with no
reflections, the sparkles (fallen stars) go out, shoreline palms grey, and the mist thickens and darkens with how
much of her sky is still dark. On or beside it warmth drains fast (1/40 per second in Survival). The wisp warns the
first time you meet it.

Not yet: low islands submerging (the terrain doesn't change).

Not yet (phase 1): drawn sources dimming visibly (they run dry, but don't look it), visible breath and trembling hands at low
warmth. All numbers are first guesses in `TUNING` and want tuning in play.
