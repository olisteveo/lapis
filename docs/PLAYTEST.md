# Lapis -- Simulated playtests

`lapis.playtest(runs)` in the browser console (with `?debug`) plays every puzzle with four skill profiles and prints a table. Source: `src/debug/playtest.ts`.

## What the bots are

| Profile | Spots clues | Reasons | Runs when they shouldn't | Reaction | Gives up after |
|---|---|---|---|---|---|
| novice | 35% | 20% | often | 1.2 s | 10 min |
| casual | 60% | 45% | sometimes | 0.8 s | 15 min |
| skilled | 80% | 75% | rarely | 0.5 s | 25 min |
| expert | 95% | 95% | almost never | 0.3 s | 40 min |

They play the **real puzzle logic**: firefly herding runs the actual swarm simulation; glowcap, mirror cap, stone dial and bell presses go through the real puzzles. What a human would **perceive** is modelled as a chance: noticing the reflection, reading a constellation correctly, telling her footprints from yours, understanding a riddle. Those chances are assumptions, so the numbers show how puzzles compare and where players get stuck. They are not a substitute for a real person playing.

## Results (50 runs each)

| Puzzle | Novice | Casual | Skilled | Expert | Where they get stuck |
|---|---|---|---|---|---|
| Meadows: firefly jar | 88%, 5.1 min | 100%, 2.7 | 100%, 1.3 | 100%, 1.2 | novices crowd or chase the swarm |
| Meadows: dew footprints | 64%, 4.9 | 94%, 3.0 | 96%, 2.2 | 100%, 1.8 | following your prints into a dead end |
| Lantern Wood: glowcaps | 48%, 1.8 | 80%, 1.5 | 100%, 1.1 | 100%, 0.9 | going round in circles |
| Lantern Wood: mirror caps | 66%, 2.3 | 80%, 1.6 | 88%, 1.2 | 100%, 1.0 | not grasping "touch every cap" |
| Dunes: sky stones 1 | 56%, 2.6 | 84%, 1.5 | 100%, 1.1 | 100%, 1.0 | not realising the stones show the sky |
| Dunes: sky stones 2 | 54%, 3.5 | 82%, 2.8 | 100%, 1.6 | 100%, 1.6 | as above, plus misreading shapes |
| Drowned Town: bells 1 | 86%, 5.3 | 100%, 2.2 | 100%, 0.9 | 100%, 0.6 | miscounting marks |
| Drowned Town: bells 2 | 76%, 5.6 | 96%, 4.1 | 100%, 1.7 | 100%, 1.1 | miscounting; never looking at the water |

Minutes are median time to solve for those who did.

## What the first run showed, and what changed

The first pass had the firefly jar and both bell pools at 100% for every profile, and random pressing solving glowcaps and mirror caps.

- **Fireflies** dart away at a changing slant and drift on their own; the jar's mouth is tighter and crowding scatters them sooner.
- **Glowcaps** grew from 6 to 8 mushrooms with more roots and a deeper scramble; lit caps gutter out after 45 s, so flailing undoes itself.
- **Mirror caps** grew from 5 to 7 caps with longer reach, so there are many more wrong routes.
- **Bells**: the reflection only shows in still water (wading makes ripples); the last pool's tune is 8 rings over 6 bells, with two bells rung twice; the little light's hint became a riddle ("the sea remembers things the sky forgets... when it is calm").

## Still to judge by hand

- Whether the firefly herding feels good with a real mouse and camera, not a bot steering perfectly.
- Whether the bell riddle is readable to someone who hasn't seen the code.
- The meadows are meant to be the gentle first region; the drowned town should end up hardest for casual players, which the bell numbers do not quite show yet.
