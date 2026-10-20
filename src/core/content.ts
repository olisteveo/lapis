// Narrative content. Lines come from docs/STORY.md; keep the two in sync.

export interface Fragment {
  id: string;
  line: string;
  /** Where the star is found: lying in the open (default), inside the region's wonder, or behind a puzzle. */
  source?: 'open' | 'wonder' | 'puzzle';
}

export interface ConstellationDef {
  id: string;
  name: string;
  /** Sky position of the figure's centre, degrees. Azimuth 0 = north, clockwise. */
  azimuth: number;
  elevation: number;
  /** Angular size of one unit of the star layout, radians. */
  scale: number;
  stars: [number, number][];
  lines: [number, number][];
  fragments: Fragment[];
  /** The region whose stars these are (the Boat's are the opening shore). */
  region?: 'meadow' | 'lantern' | 'dunes' | 'drowned';
}

// Hangs over the sea behind you when you wake: turn toward the boat and it's there.
export const THE_BOAT: ConstellationDef = {
  id: 'boat',
  name: 'The Boat',
  azimuth: 168,
  elevation: 34,
  scale: 0.085,
  stars: [
    [-1.0, 0.15], // stern
    [-0.5, -0.35],
    [0.5, -0.35],
    [1.0, 0.25], // bow
    [0.05, 0.12], // thwart
    [0.35, 0.8], // oar
  ],
  lines: [
    [0, 1],
    [1, 2],
    [2, 3],
    [0, 4],
    [4, 3],
    [4, 5],
  ],
  fragments: [
    { id: 'boat-1', line: 'Tell me the one about the fallen stars.' },
    { id: 'boat-2', line: 'Why do they fall?' },
    { id: 'boat-3', line: 'Can we catch one?' },
    { id: 'boat-4', line: "It's wobbly. Don't let go." },
    { id: 'boat-5', line: 'I rowed! I rowed all by myself!' },
    { id: 'boat-6', line: 'Can I put my name on it too?' },
  ],
};

// One per region, hung in that region's part of the sky so the shape you are completing points the way.
// Memory ages climb region by region: the meadows are her at five, the drowned town at seventeen.
export const THE_HAND: ConstellationDef = {
  id: 'hand',
  name: 'The Hand',
  region: 'meadow',
  azimuth: 252,
  elevation: 42,
  scale: 0.07,
  stars: [[-0.3, -0.9], [0.3, -0.9], [0, -0.35], [-0.85, 0.1], [-0.45, 0.85], [0, 1.0], [0.42, 0.85], [0.8, 0.25]],
  lines: [[0, 2], [1, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7]],
  fragments: [
    { id: 'hand-1', line: 'Hold my hand. The grass is taller than me.' },
    { id: 'hand-2', line: 'Your hands are always cold. Mine are warm. Here.' },
    { id: 'hand-3', line: "I picked you one. It's the shiny kind." },
    { id: 'hand-4', line: 'Spin me! Spin me again!' },
    { id: 'hand-5', line: 'Can we lie here and count them? All of them?' },
    { id: 'hand-6', line: "When I'm big I'll be as tall as the moon tree.", source: 'wonder' },
    { id: 'hand-7', line: 'I drew round your hand and mine. Mine fits inside.', source: 'puzzle' },
    { id: 'hand-8', line: "Don't let go when we cross. Promise.", source: 'puzzle' },
  ],
};

export const THE_LANTERN: ConstellationDef = {
  id: 'lantern',
  name: 'The Lantern',
  region: 'lantern',
  azimuth: 84,
  elevation: 38,
  scale: 0.07,
  stars: [[0, 1.1], [-0.35, 0.65], [0.35, 0.65], [-0.55, 0], [0.55, 0], [-0.4, -0.75], [0.4, -0.75], [0, 0.05]],
  lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 6], [1, 2]],
  fragments: [
    { id: 'lantern-1', line: 'Leave the lamp on. Just a little bit.' },
    { id: 'lantern-2', line: 'What if the dark has teeth?' },
    { id: 'lantern-3', line: 'You said the light goes all the way to the mainland.' },
    { id: 'lantern-4', line: "I can carry it. I'm careful. See?" },
    { id: 'lantern-5', line: 'The moths love it more than I do.' },
    { id: 'lantern-6', line: 'If you stand in the ring and wish, does it count?', source: 'wonder' },
    { id: 'lantern-7', line: "I'm not scared. I'm just checking.", source: 'puzzle' },
    { id: 'lantern-8', line: 'Teach me to light it. Then you can sleep.', source: 'puzzle' },
  ],
};

export const THE_WHALE: ConstellationDef = {
  id: 'whale',
  name: 'The Whale',
  region: 'dunes',
  azimuth: 38,
  elevation: 24,
  scale: 0.085,
  stars: [[-1.0, 0], [-0.45, 0.35], [0.25, 0.4], [0.85, 0.1], [0.4, -0.3], [-0.4, -0.25], [1.25, 0.45], [1.25, -0.25]],
  lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [3, 6], [3, 7]],
  fragments: [
    { id: 'whale-1', line: 'Do whales sleep? Where do they go?' },
    { id: 'whale-2', line: "There's a whale that sings so low nobody hears it." },
    { id: 'whale-3', line: "One day I'm going to see a real city." },
    { id: 'whale-4', line: "You don't have to come everywhere with me." },
    { id: 'whale-5', line: "The sea goes on forever. That's not scary. That's the point." },
    { id: 'whale-6', line: "It's so big. It must have been so lonely.", source: 'wonder' },
    { id: 'whale-7', line: 'Why do you always look at the water like that?', source: 'puzzle' },
    { id: 'whale-8', line: "I'm not a little kid any more.", source: 'puzzle' },
  ],
};

export const THE_BELL: ConstellationDef = {
  id: 'bell',
  name: 'The Bell',
  region: 'drowned',
  azimuth: 302,
  elevation: 30,
  scale: 0.07,
  stars: [[0, 1.05], [-0.3, 0.6], [0.3, 0.6], [-0.45, -0.1], [0.45, -0.1], [-0.8, -0.6], [0.8, -0.6], [0, -0.85]],
  lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 6]],
  fragments: [
    { id: 'bell-1', line: 'I got in. The college on the mainland. I got in.' },
    { id: 'bell-2', line: 'You could come too. You could just... come.' },
    { id: 'bell-3', line: 'Someone has to keep the light. I know. I know.' },
    { id: 'bell-4', line: "Ring the bell when you miss me. I'll hear it." },
    { id: 'bell-5', line: "I'll write. Every week. I promise." },
    { id: 'bell-6', line: "Listen. It's like the sea is ringing for someone.", source: 'wonder' },
    { id: 'bell-7', line: 'The sky looks wrong. The sky looks wrong.', source: 'puzzle' },
    { id: 'bell-8', line: "Don't let go. Don't let go. Don't—", source: 'puzzle' },
  ],
};

export const CONSTELLATIONS = [THE_BOAT, THE_HAND, THE_LANTERN, THE_WHALE, THE_BELL];
export const TOTAL_STARS = CONSTELLATIONS.reduce((n, c) => n + c.fragments.length, 0);

// Told on black before you wake: the bedtime story this world is built from, and why you are here.
export const STORYBOOK = [
  'Every night, she asked for the same story.',
  'The one about the islands where the stars fall into the sea,',
  'and the palms glow pink from drinking their light.',
  'Now she is the one lost at sea, and her stars are falling.',
  'Light her sky again, and she will find her way home.',
];

// When the last constellation is lit and you reach the brightest star.
export const ENDING = [
  'Every star is back where it belongs.',
  'Far away, a small boat drifts beneath the brightest star.',
  'The girl in it opens her eyes, and knows which way to row.',
  'She does not need you to hold on any more.',
  'Let go.',
];

export const LINES = {
  wake: '...find the brightest star...',
  stakes: 'The stars are falling. Gather them before the sky goes dark.',
  warm: 'A fallen star. It is still warm.',
  atSea: 'Some have fallen out at sea. The boat is waiting.',
  footprints: "Small footprints. They walk into the sea, and they don't come back.",
  note: "Don't lose the brightest star.",
  seat: 'Two sets of initials are carved into the seat. One of them was cut by a child.',
  figure: 'There was someone there.',
  firstStar: 'Six stars have fallen along this shore. Their light still rises.',
  skyFalls: 'Another star falls. The sky is a little darker.',
  boatDone: 'The palms burn a little brighter.',
  next: 'Four more of her constellations are still dark, out across the island.',
  constellationDone: 'Another part of her sky is lit. The dream holds a little tighter.',
  allDone: 'Her whole sky is burning. The brightest star is calling you north, down the River of Light.',
  lagoon: 'A hidden lagoon. The water here is full of light.',
  stonesHint: 'Stones lead through the rocks. Space to jump; run to jump further.',
  fell: 'The sea takes you, gently, and gives you back.',
  currentHint: 'A current of starlight. Let it carry you.',
  strokeHint: 'Space as the oars dip, for a long stroke.',
  carryHint: 'Carry it to a lighthouse before the night runs out.',
  lightHint: 'A lighthouse. Its lamp is cold.',
  lit: 'The lamp catches. The light goes out across the water.',
  rest: 'She sleeps more deeply. The night begins again.',
  restShallow: 'She sleeps, but only lightly here. Another light would hold her longer.',
  collapse: 'The cold closes over you, and the dream lets go.',
  late: 'The night grows late. Find a light.',
  cold: "I'm so cold.",
  eyes: "I'll just close my eyes for a bit.",
  waking: 'She surfaces, for a moment, and the dream lets go of you.',
  lost: 'The stars you carried have fallen back to where they lay.',
};
