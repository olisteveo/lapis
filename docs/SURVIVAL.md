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
- **No HUD for survival.** Warmth is shown on the picture itself, the way the night already is.
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
- **At zero** you collapse: same as being caught. Carried stars scatter where you fell (recoverable), you wake at your
  last lighthouse, warm.

## Light

- A carried store of light, from empty to full.
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

## Open questions

- **Who holds the light before you find the Paper Lantern?** The lantern keepsake is found in the Lantern Wood, not at
  the start. Proposal: the wisp holds a small store from the beginning (enough for one flare), and the lantern raises
  the capacity and is what lets you harvest from big sources.
- **Numbers.** Drain and refill rates, light per flare, rest returns: first guesses go in config and get tuned in play.
