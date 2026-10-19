# Lapis -- Voice Script (Mara)

Mara is the only voice in the game. Every line is a **memory**: something she said once, years ago, now drifting back. The Keeper never speaks.

## Delivery, for every line

- **Quiet and close.** Bedtime voice. Never projected, never "acted" big.
- **Real, not cute.** A child talking to a parent they adore, not a performance.
- **Room to breathe.** Leave half a second of silence before and after each line.
- **No music or effects** on the recording; the game adds the memory treatment.

## Voice

| Act | Age | Voice notes |
|---|---|---|
| The Boat, Coral Shore echoes | 5-7 | small, slightly breathy, curious, sleepy |
| Later acts (to come) | 9-17 | older versions of the same girl |

ElevenLabs Voice Design prompt (Act 1):
```
a gentle little girl, about six years old, soft and slightly breathy, quiet bedtime voice, British accent, intimate close microphone, warm and curious
```

## File format

- MP3 (or WAV), mono or stereo, any sample rate.
- Put files in `public/audio/voice/` named exactly as below. Missing files just fall back to text.

## Lines

### The Boat (fallen stars, Coral Shore), age 5

| File | Line | Direction |
|---|---|---|
| `boat-1.mp3` | Tell me the one about the fallen stars. | Tucked in, asking for her favourite story. Hopeful. |
| `boat-2.mp3` | Why do they fall? | Genuinely puzzled, a little worried. |
| `boat-3.mp3` | Can we catch one? | Sudden excitement, whispered so she doesn't wake anyone. |
| `boat-4.mp3` | It's wobbly. Don't let go. | First time in the boat. Nervous giggle, gripping on. |
| `boat-5.mp3` | I rowed! I rowed all by myself! | Breathless pride, the biggest moment of her life. |
| `boat-6.mp3` | Can I put my name on it too? | Shy, hopeful, asking to carve her initials next to yours. |

### Memory echoes (light figures), age 6-7

| File | Line | Direction |
|---|---|---|
| `echo-point.mp3` | Which one's the bright one? That one? That one? | Pointing at the sky, impatient, delighted. |
| `echo-jetty.mp3` | Can we stay out till the lamp comes on? | Legs dangling off the jetty, bargaining for more time. |
| `echo-cairn.mp3` | One more stone. For luck. For you. | Careful, serious, placing a stone; the last two words are a gift. |
