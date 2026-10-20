import { getQualityName, setQuality, type QualityName } from './config';
import type { SurvivalMode } from './core/survival';

/** Player preferences, persisted locally. Quality itself lives in config (it drives rendering). */
export interface Settings {
  quality: QualityName;
  master: number;
  music: number;
  sfx: number;
  sensitivity: number;
  invertY: boolean;
  /** Wander (no nights), Story (gentle nights) or Survival (warmth, light and the dark: docs/SURVIVAL.md). */
  survival: SurvivalMode;
  /** Derived from survival: the night cycle runs unless you're wandering. */
  nights: boolean;
}

const KEY = 'lapis.settings';
const DEFAULTS: Omit<Settings, 'quality'> = { master: 0.9, music: 0.8, sfx: 0.9, sensitivity: 1, invertY: false, survival: 'survival', nights: true };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    // Saves from before the survival modes only had the night toggle: Story is the closest to how they
    // played, so returning players aren't dropped into Survival without choosing it.
    const survival = raw.survival ?? (raw.nights === false ? 'wander' : raw.nights === true ? 'story' : DEFAULTS.survival);
    return { ...DEFAULTS, ...raw, survival, nights: survival !== 'wander', quality: getQualityName() };
  } catch {
    return { ...DEFAULTS, quality: getQualityName() };
  }
}

export const settings: Settings = load();
const listeners: (() => void)[] = [];

export function onSettingsChange(fn: () => void) {
  listeners.push(fn);
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  settings.nights = settings.survival !== 'wander';
  if (patch.quality) setQuality(patch.quality);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: settings just won't persist.
  }
  for (const fn of listeners) fn();
}
