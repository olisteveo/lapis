// Narrative content. Lines come from docs/STORY.md; keep the two in sync.

export interface Fragment {
  id: string;
  line: string;
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

// Told on black before you wake: the bedtime story this world is built from.
export const STORYBOOK = [
  'Every night, she asked for the same story.',
  'The one about the islands where the stars fall into the sea,',
  'and the palms glow pink from drinking their light.',
  'It always ended the same way.',
  "If you're ever lost, find the bright one.",
];

export const LINES = {
  wake: '...find the bright one...',
  stakes: 'The stars are falling. Gather them before the sky goes dark.',
  warm: 'A fallen star. It is still warm.',
  atSea: 'Some have fallen out at sea. The boat is waiting.',
  footprints: "Small footprints. They walk into the sea, and they don't come back.",
  note: "Don't lose the bright one.",
  seat: 'Two sets of initials are carved into the seat. One of them was cut by a child.',
  figure: 'There was someone there.',
  firstStar: 'Six stars have fallen along this shore. Their light still rises.',
  skyFalls: 'Another star falls. The sky is a little darker.',
  boatDone: 'The palms burn a little brighter.',
  next: 'The bright one hangs in the north, past the lake.',
};
