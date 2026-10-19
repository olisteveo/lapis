# Lapis -- Music Brief and Suno Prompts

## Musical identity

The soundtrack is **a bedtime story played on a lighthouse keeper's things**. Every cue draws from the same small instrument set, so the whole score sounds like one world:

- **Music box** (slightly detuned, worn): the bedtime story, Mara's childhood.
- **Felt piano** (close-miked, soft hammers): the Keeper's presence.
- **Concertina / squeezebox** (breathy, distant): the sea, the boat, the island life.
- **Glass harmonica / bowed vibraphone / celesta**: the stars, fallen and in the sky.
- **Warm tape-saturated pads, low strings**: the night and the dream.
- **Wordless female/child hum**: Mara. Only appears in memories and the ending.

Rules that keep it cohesive:
- Slow: 56 to 76 BPM. No drums except the softest pulse in the jungle.
- Keys around **D major / B minor**, with lydian brightness (raised 4th) for wonder.
- Everything slightly imperfect: tape warble, room noise, worn felt. Never glossy.
- One recurring **lullaby melody** ("Find the Bright One"). Generate it first, then reuse it.

## How to work in Suno

1. Use **Custom** mode. Put the style text in **Style**, the bracketed structure in **Lyrics**.
2. Tick **Instrumental** for everything except the two lullaby tracks.
3. Put the exclude list in **Exclude styles** if your version has it.
4. Generate 4 to 8 takes per cue; keep the ones whose melody echoes the lullaby.
5. When you find a take you love, use **Extend** or **Cover** from it for the other cues so they share its melody and sound. This is the most important step for a cohesive soundtrack.
6. For loops, ask for "seamless loop, no fade out" and trim the loop point in Audacity at a bar line.
7. Export as WAV. Drop files into `public/audio/music/` and tell Claude which is which; the game will crossfade them by area.

Licensing: Suno grants commercial use only for songs generated on a paid plan. Check the current terms before shipping.

**Exclude (use on every instrumental cue):** drums, trap, EDM, dubstep, rock, electric guitar, autotune, rap, cinematic trailer, epic, brass fanfare

---

## 1. "Find the Bright One" -- the lullaby (generate this first)

The melodic seed for the whole score. Sung by a tender, low adult voice, almost spoken, as if at a bedside.

**Style:**
```
gentle lullaby, solo felt piano and worn music box, intimate low warm voice singing softly at a bedside, close mic, tape warble, D major, 66 bpm, sparse, tender, nocturnal, folk lullaby, maritime, hushed
```

**Lyrics:**
```
[Intro: music box alone]

[Verse 1]
Hush now, the sea has gone quiet and blue
The stars are all falling, and some fall for you
They sink in the water, they sleep in the sand
And the palms drink their light like a lamp in your hand

[Chorus]
So if you are lost, love, and the dark comes in deep
Find the bright one, find the bright one
Keep it over your shoulder and row until sleep
Find the bright one, and you'll find your way home

[Verse 2]
The islands are dreaming, the lighthouse is low
I'll leave the lamp burning wherever you go

[Chorus]
So if you are lost, love, and the dark comes in deep
Find the bright one, find the bright one
Keep it over your shoulder and row until sleep
Find the bright one, and you'll find your way home

[Outro: hummed melody, music box winds down]
```

## 2. Title screen -- "Beyond the Sea"

**Style:**
```
instrumental, dreamy nocturne, worn music box melody over felt piano and soft tape pads, distant concertina, glass harmonica shimmer, D lydian, 64 bpm, starlit, melancholy and hopeful, intimate, analog warmth, seamless loop
```
**Lyrics:**
```
[Intro: music box plays the lullaby melody alone]
[Theme: felt piano joins, low strings swell softly]
[Bridge: glass harmonica, concertina breathes in the distance]
[Theme: music box returns, slower]
[Loop point, no fade out]
```

## 3. The storybook opening (30 to 40 seconds)

**Style:**
```
instrumental, solo antique music box, very slow, slightly detuned, tape hiss and room tone, lullaby fragment, D major, 58 bpm, fragile, bedtime story, intimate, short piece
```
**Lyrics:**
```
[Music box plays the lullaby melody once, very slowly]
[Final note rings and the mechanism winds down]
[End]
```

## 4. Coral Shore -- exploration loop

**Style:**
```
instrumental ambient, warm felt piano phrases with long space between, soft concertina drones like a breathing tide, celesta glints like stars on water, gentle tape pads, D major, 70 bpm, calm, wondrous, nocturnal beach, seamless loop
```
**Lyrics:**
```
[Intro: tide-like concertina swell]
[Piano: sparse fragments of the lullaby melody]
[Celesta sparkles drift in]
[Breakdown: pads and distant hum of the sea]
[Piano returns]
[Loop point, no fade out]
```

## 5. Night jungle -- exploration loop

**Style:**
```
instrumental, mysterious night jungle ambient, soft marimba and kalimba patterns, muted pizzicato strings like insects, deep warm sub pad, bowed vibraphone, faint heartbeat-slow pulse, B minor, 72 bpm, lush, curious, dreamlike, slightly uneasy, seamless loop
```
**Lyrics:**
```
[Intro: kalimba and insect-like pizzicato]
[Main: marimba ostinato, bowed vibraphone holds long notes]
[Glints: music box plays three notes of the lullaby, far away]
[Deepen: sub pad swells, pulse grows]
[Loop point, no fade out]
```

## 6. Rowing / the Sparkling Lake

A barcarolle: a 6/8 boat song that rocks like the stroke of oars.

**Style:**
```
instrumental barcarolle in 6/8, gentle rocking rhythm like rowing, concertina melody, felt piano arpeggios, glass harmonica and celesta like starlight on water, soft low strings, D major, 60 bpm, serene, open, wondrous, seamless loop
```
**Lyrics:**
```
[Intro: piano arpeggios rocking in 6/8]
[Theme: concertina carries the lullaby melody]
[Shimmer: celesta and glass harmonica]
[Swell: low strings, then settle]
[Loop point, no fade out]
```

## 7. Memory stinger (10 to 15 seconds, several takes)

Plays when a fallen star is gathered and her voice speaks. Pairs with the indigo duotone wash.

**Style:**
```
instrumental, short cue, glass harmonica and reversed music box, soft wordless child hum, tape warble, memory flashback, D lydian, ethereal, tender, 12 seconds
```
**Lyrics:**
```
[Reversed music box swell]
[Glass harmonica plays four notes of the lullaby, child hums along softly]
[Fade into tape hiss]
```

## 8. Constellation complete (20 to 30 seconds)

**Style:**
```
instrumental, short triumphant but gentle swell, celesta and glass harmonica cascade, felt piano chords, low strings bloom, music box plays the lullaby phrase, D major to G lydian, radiant, emotional, 25 seconds, no drums
```
**Lyrics:**
```
[Celesta cascade like stars igniting]
[Strings bloom under the lullaby phrase]
[Resolve on a long major chord, shimmer fades]
```

## 9. Dark Water -- tension (for Act 3 and the encroaching despair)

**Style:**
```
instrumental dark ambient, low cello drones, detuned music box slowing down, distant concertina breathing out of tune, subtle tape degradation, B minor, 56 bpm, cold, lonely, grief, unsettling but beautiful, no percussion, seamless loop
```
**Lyrics:**
```
[Drone: low cello, cold air]
[Music box plays the lullaby, detuned and slowing]
[Silence and tape hiss]
[Drone returns, deeper]
[Loop point, no fade out]
```

## 10. Ending -- "Let Go" (vocal reprise)

The lullaby again, now sung by Mara, older, alone, as the boat carries on into the light. Use **Cover** from track 1 so the melody matches.

**Style:**
```
emotional lullaby reprise, young woman's soft trembling voice, felt piano and music box, low strings rising slowly, glass harmonica, D major, 64 bpm, bittersweet, cathartic, intimate then swelling, maritime folk, tape warmth
```
**Lyrics:**
```
[Intro: music box, slower than before]

[Verse]
The sea has gone quiet, the lamp is still lit
You told me the story, I remember it
The stars were all falling, and one fell for me
Now I'll keep the light on, wherever you'll be

[Chorus]
And if I am lost, and the dark comes in deep
I'll find the bright one, I'll find the bright one
Keep it over my shoulder and row, and not sleep
I'll find the bright one, and I'll find my way home

[Bridge: strings swell, piano alone]

[Final Chorus: soft, almost whispered]
I'll find the bright one
I'll find my way home

[Outro: music box plays the last phrase and stops]
```

---

## Wiring into the game

Planned mix (Claude can implement once files exist):

| Area / moment | File | Behaviour |
|---|---|---|
| Storybook, wake, first ~35s of play | `storybook.mp3` (The Storybook) | Starts on the first click |
| Beaches, open ground | `coral_shore.mp3` (Coral Shore) | Area track |
| Jungle (grove density > 0.45) | `jungle.mp3` (Jungle Night) | Area track |
| In the boat | `beyond_the_sea.mp3` (Beyond the Sea) | Area track |
| Boat, far out over deep water | `dark_water.mp3` (Dark Waters) | Area track |
| Gathering a star, meeting an echo | `memory.mp3` (Glass Memory) | First ~14s as a sting; score ducks |
| Ending | `let_go.mp3` (Let Go) | Reserved for the ending |

Area tracks crossfade over ~5s once the player has stayed in a new area for 5s (8s for deep water). When a track ends, 30-70s of ambience-only silence passes before it plays again. No vocals anywhere in the game.
