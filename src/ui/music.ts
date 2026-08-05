// Generative music: a quiet, melancholy space score synthesized entirely in
// WebAudio — no audio assets, so it ships everywhere the game runs (desktop
// and mobile browsers alike).
//
// Construction: at startup a seeded pool of HUNDREDS of small parts is
// composed — melodic phrases, pad progressions, bass figures, and interlude
// ornaments (see PART_COUNTS). A lookahead scheduler then remixes them
// endlessly: phrases are picked, transposed, re-registered and re-voiced to
// the current MOOD, with long rests between them so the score stays subtle.
//
// Moods: 'ambient' is the resting state (aeolian, slow, sparse). Situations
// cue temporary moods that color the mix and then decay back to ambient:
//   research  — dorian, brighter bell voices        (breakthroughs)
//   discovery — major-pentatonic wonder, harp runs  (new systems/planets)
//   contact   — phrygian tension, low drones        (meeting an empire)
//
// OFF by default. The toggle is the user gesture that creates/resumes the
// AudioContext, which is exactly what mobile autoplay policies require. A
// saved-on preference re-arms on the first gesture of the next session.

type Mood = 'ambient' | 'research' | 'discovery' | 'contact';

const PREF_KEY = 'moo2.music';
const BASE_HZ = 110; // A2
const LOOKAHEAD = 0.9; // seconds scheduled ahead
const TICK_MS = 300;

// scale semitones per mood
const MODES: Record<Mood, number[]> = {
  ambient: [0, 2, 3, 5, 7, 8, 10], // aeolian — the melancholy home
  research: [0, 2, 3, 5, 7, 9, 10], // dorian — a hopeful shade of minor
  discovery: [0, 2, 4, 7, 9], // major pentatonic — open wonder
  contact: [0, 1, 3, 5, 7, 8, 10], // phrygian — held breath
};

/** per-mood pacing: how dense the melody is and how long the mood lingers */
const MOOD_TUNE: Record<Mood, { restMin: number; restMax: number; holdMs: number; padDur: [number, number] }> = {
  ambient: { restMin: 4, restMax: 11, holdMs: 0, padDur: [9, 15] },
  research: { restMin: 2.5, restMax: 6, holdMs: 35000, padDur: [7, 11] },
  discovery: { restMin: 1.5, restMax: 5, holdMs: 25000, padDur: [6, 10] },
  contact: { restMin: 3, restMax: 8, holdMs: 40000, padDur: [8, 13] },
};

// ---------------------------------------------------------------- parts ----

interface PhraseStep {
  deg: number; // scale degree (mapped into the active mode at play time)
  oct: number; // octave offset
  dur: number; // beats
  gap: number; // beats of silence after the note
}
export interface Phrase {
  steps: PhraseStep[];
  /** contour tag — moods prefer different shapes */
  shape: 'fall' | 'rise' | 'arch' | 'drift';
}
export interface PadChord {
  degs: number[]; // chord tones as scale degrees (with octave folds at play)
}
export interface Parts {
  phrases: Phrase[];
  pads: PadChord[][]; // progressions of 4 chords
  basses: PhraseStep[][];
  ornaments: PhraseStep[][]; // fast interlude runs
}

export const PART_COUNTS = { phrases: 168, pads: 36, basses: 24, ornaments: 40 } as const;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** compose the whole part pool from one seed (pure — unit tested) */
export function buildParts(seed: number): Parts {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(a: readonly T[]) => a[int(a.length)]!;

  const phrases: Phrase[] = [];
  const shapes = ['fall', 'rise', 'arch', 'drift'] as const;
  for (let i = 0; i < PART_COUNTS.phrases; i++) {
    const shape = shapes[i % shapes.length]!;
    const len = 3 + int(5); // 3..7 notes
    const steps: PhraseStep[] = [];
    let deg = int(7);
    for (let k = 0; k < len; k++) {
      const t = len < 2 ? 0 : k / (len - 1);
      // walk the contour: mostly stepwise, occasional leap
      const leap = rnd() < 0.18 ? 2 + int(3) : 1;
      if (shape === 'fall') deg -= rnd() < 0.75 ? leap : -1;
      else if (shape === 'rise') deg += rnd() < 0.75 ? leap : -1;
      else if (shape === 'arch') deg += (t < 0.5 ? 1 : -1) * (rnd() < 0.8 ? leap : 0);
      else deg += int(3) - 1;
      steps.push({
        deg,
        oct: 0,
        dur: pick([0.5, 1, 1, 1.5, 2, 3]),
        gap: rnd() < 0.3 ? pick([0.5, 1, 2]) : 0,
      });
    }
    // melancholy cadence: most phrases settle downward at the end
    if (shape !== 'rise' && steps.length > 1) steps[steps.length - 1]!.dur += 1.5;
    phrases.push({ steps, shape });
  }

  // pad progressions: 4 chords of stacked thirds-ish degrees, favoring the
  // open add9/sus colors that keep minor keys wistful instead of grim
  const pads: PadChord[][] = [];
  for (let i = 0; i < PART_COUNTS.pads; i++) {
    const prog: PadChord[] = [];
    let root = int(7);
    for (let c = 0; c < 4; c++) {
      const color = pick([
        [0, 2, 4],
        [0, 2, 4, 6],
        [0, 1, 4], // add9 flavor
        [0, 3, 4], // sus4
        [0, 2, 4, 8],
      ]);
      prog.push({ degs: color.map((d) => root + d) });
      root += pick([-4, -2, 3, 4, 5, -3]);
    }
    // resolve home often enough that the loop feels intentional
    if (rnd() < 0.6) prog[3] = { degs: pick([[0, 2, 4], [0, 1, 4]]).map((d) => d) };
    pads.push(prog);
  }

  const basses: PhraseStep[][] = [];
  for (let i = 0; i < PART_COUNTS.basses; i++) {
    const len = 2 + int(3);
    const line: PhraseStep[] = [];
    for (let k = 0; k < len; k++) {
      line.push({ deg: pick([0, 0, 4, 3, -3]), oct: -1, dur: pick([2, 3, 4]), gap: pick([0, 1, 2]) });
    }
    basses.push(line);
  }

  // ornaments: quick harp-like runs used as interludes and stinger tails
  const ornaments: PhraseStep[][] = [];
  for (let i = 0; i < PART_COUNTS.ornaments; i++) {
    const len = 4 + int(6);
    const up = rnd() < 0.6;
    const run: PhraseStep[] = [];
    for (let k = 0; k < len; k++) {
      run.push({ deg: up ? k : len - k, oct: 1, dur: 0.25, gap: 0 });
    }
    ornaments.push(run);
  }

  return { phrases, pads, basses, ornaments };
}

// ------------------------------------------------------------- pref/state ----

let parts: Parts | null = null;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dry: GainNode | null = null;
let wet: GainNode | null = null;
let melodyBus: GainNode | null = null;
let padBus: GainNode | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let moodTimer: ReturnType<typeof setTimeout> | null = null;

let on = false;
let mood: Mood = 'ambient';
let bpm = 54;
let nextPadAt = 0;
let nextMelodyAt = 0;
let nextBassAt = 0;
let progression: PadChord[] = [];
let progIdx = 0;
let currentChord: PadChord = { degs: [0, 2, 4] };
const rand = mulberry32((Date.now() ^ 0x5f3759df) >>> 0); // remix source, UI-only

function beats(n: number): number {
  return (n * 60) / bpm;
}

function prefRead(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}
function prefWrite(v: boolean) {
  try {
    localStorage.setItem(PREF_KEY, v ? 'on' : 'off');
  } catch {
    /* private mode etc. — the toggle still works for this session */
  }
}

export function musicEnabled(): boolean {
  return on;
}

/** current mood — exposed for the toolbar tooltip/dev panel */
export function musicMood(): Mood {
  return mood;
}

// ------------------------------------------------------------ synthesis ----

function freqOf(deg: number, oct: number, mode: number[]): number {
  const n = mode.length;
  const idx = ((deg % n) + n) % n;
  const octaves = Math.floor(deg / n) + oct;
  return BASE_HZ * Math.pow(2, (mode[idx]! + 12 * octaves) / 12);
}

function makeImpulse(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // one-pole lowpassed noise with exponential decay: a soft dark hall
      const white = Math.random() * 2 - 1;
      last = last * 0.82 + white * 0.18;
      d[i] = last * Math.pow(1 - i / len, 2.4);
    }
  }
  return buf;
}

function ensureGraph(): boolean {
  if (ctx) return true;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -28;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);

  dry = ctx.createGain();
  dry.gain.value = 0.55;
  wet = ctx.createGain();
  wet.gain.value = 0.75;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 4.5);
  wet.connect(conv);
  conv.connect(master);
  dry.connect(master);

  padBus = ctx.createGain();
  padBus.gain.value = 0.5;
  padBus.connect(dry);
  padBus.connect(wet);

  melodyBus = ctx.createGain();
  melodyBus.gain.value = 0.8;
  const echo = ctx.createDelay(2);
  echo.delayTime.value = beats(1.5);
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  echo.connect(fb);
  fb.connect(echo);
  melodyBus.connect(dry);
  melodyBus.connect(echo);
  echo.connect(wet);

  if (!parts) parts = buildParts(0x9e3779b9);
  return true;
}

interface Voice {
  type: OscillatorType;
  vol: number;
  attack: number;
  release: number;
  detune?: number;
  vibrato?: boolean;
}

function playNote(bus: GainNode, freq: number, t: number, dur: number, v: Voice) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = v.type;
  osc.frequency.value = freq;
  if (v.detune) osc.detune.value = v.detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v.vol, t + v.attack);
  g.gain.setValueAtTime(v.vol, Math.max(t + v.attack, t + dur - v.release));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
  osc.connect(g);
  g.connect(bus);
  if (v.vibrato) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.2;
    const lg = ctx.createGain();
    lg.gain.value = freq * 0.006;
    lfo.connect(lg);
    lg.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }
  osc.start(t);
  osc.stop(t + dur + 0.1);
}

function playChord(chord: PadChord, t: number, dur: number, mode: number[]) {
  if (!padBus) return;
  for (const deg of chord.degs) {
    const f = freqOf(deg, 0, mode);
    // two softly detuned voices per tone — the classic slow space pad
    playNote(padBus, f, t, dur, { type: 'triangle', vol: 0.05, attack: dur * 0.3, release: dur * 0.4, detune: -5 });
    playNote(padBus, f, t, dur, { type: 'sawtooth', vol: 0.014, attack: dur * 0.35, release: dur * 0.4, detune: 6 });
  }
  // sub root
  playNote(padBus, freqOf(chord.degs[0]!, -1, mode), t, dur, { type: 'sine', vol: 0.055, attack: dur * 0.25, release: dur * 0.4 });
}

const MEL_VOICES: Record<Mood, Voice> = {
  ambient: { type: 'sine', vol: 0.075, attack: 0.06, release: 0.5, vibrato: true },
  research: { type: 'triangle', vol: 0.08, attack: 0.01, release: 0.9 }, // bell-ish
  discovery: { type: 'triangle', vol: 0.085, attack: 0.02, release: 0.35 }, // harp-ish
  contact: { type: 'sine', vol: 0.065, attack: 0.25, release: 0.8, vibrato: true },
};

function schedulePhrase(t: number): number {
  if (!parts || !melodyBus) return t + 4;
  const mode = MODES[mood];
  const tune = MOOD_TUNE[mood];
  const prefer: Record<Mood, Phrase['shape']> = { ambient: 'fall', research: 'rise', discovery: 'rise', contact: 'drift' };
  // remix: filtered pick + random transpose + octave placement
  let phrase = parts.phrases[Math.floor(rand() * parts.phrases.length)]!;
  if (rand() < 0.55) {
    const wanted = parts.phrases.filter((p) => p.shape === prefer[mood]);
    phrase = wanted[Math.floor(rand() * wanted.length)] ?? phrase;
  }
  const transpose = Math.floor(rand() * 5) - 2;
  const oct = mood === 'discovery' ? 1 : rand() < 0.3 ? 1 : 0;
  const voice = MEL_VOICES[mood];
  let at = t;
  for (const s of phrase.steps) {
    playNote(melodyBus, freqOf(s.deg + transpose + (currentChord.degs[0] ?? 0), s.oct + oct, mode), at, beats(s.dur), voice);
    at += beats(s.dur + s.gap);
  }
  // occasional interlude ornament trailing the phrase
  if (rand() < (mood === 'discovery' ? 0.5 : 0.18)) {
    const run = parts.ornaments[Math.floor(rand() * parts.ornaments.length)]!;
    let ot = at + beats(1);
    for (const s of run) {
      playNote(melodyBus, freqOf(s.deg + (currentChord.degs[0] ?? 0), s.oct, mode), ot, beats(s.dur * 2), {
        type: 'triangle',
        vol: 0.035,
        attack: 0.005,
        release: 0.25,
      });
      ot += beats(s.dur);
    }
    at = ot;
  }
  return at + beats(tune.restMin + rand() * (tune.restMax - tune.restMin));
}

function tick() {
  if (!ctx || !parts) return;
  const now = ctx.currentTime;
  const mode = MODES[mood];
  const tune = MOOD_TUNE[mood];

  while (nextPadAt < now + LOOKAHEAD) {
    const t = Math.max(nextPadAt, now + 0.05);
    if (progIdx % 4 === 0) progression = parts.pads[Math.floor(rand() * parts.pads.length)]!;
    currentChord = progression[progIdx % 4]!;
    const dur = tune.padDur[0] + rand() * (tune.padDur[1] - tune.padDur[0]);
    playChord(currentChord, t, dur, mode);
    progIdx++;
    nextPadAt = t + dur * 0.82; // chords overlap into a continuous bed
  }

  while (nextBassAt < now + LOOKAHEAD) {
    const t = Math.max(nextBassAt, now + 0.05);
    const line = parts.basses[Math.floor(rand() * parts.basses.length)]!;
    let at = t;
    for (const s of line) {
      playNote(padBus!, freqOf(s.deg + (currentChord.degs[0] ?? 0), s.oct, mode), at, beats(s.dur), {
        type: 'sine',
        vol: 0.04,
        attack: 0.4,
        release: 0.6,
      });
      at += beats(s.dur + s.gap);
    }
    nextBassAt = at + beats(6 + rand() * 10);
  }

  while (nextMelodyAt < now + LOOKAHEAD) {
    nextMelodyAt = schedulePhrase(Math.max(nextMelodyAt, now + 0.05));
  }
}

// --------------------------------------------------------------- control ----

function startEngine() {
  if (!ensureGraph() || !ctx || !master) return;
  void ctx.resume();
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
  master.gain.exponentialRampToValueAtTime(0.24, now + 3);
  nextPadAt = now + 0.1;
  nextMelodyAt = now + beats(2);
  nextBassAt = now + beats(4);
  progIdx = 0;
  if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
}

function stopEngine() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (ctx && master) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    const c = ctx;
    setTimeout(() => {
      if (!on) void c.suspend();
    }, 1500);
  }
}

export function setMusicEnabled(v: boolean) {
  on = v;
  prefWrite(v);
  if (v) startEngine();
  else stopEngine();
}

export function toggleMusic(): boolean {
  setMusicEnabled(!on);
  return on;
}

/** situational cue: switch mood (with a stinger) and decay back to ambient */
export function musicCue(kind: Exclude<Mood, 'ambient'>) {
  if (!on || !ctx || !melodyBus) return;
  mood = kind;
  bpm = kind === 'discovery' ? 60 : kind === 'contact' ? 48 : 56;
  const t = ctx.currentTime + 0.05;
  const mode = MODES[kind];
  // short recognizable stingers per situation
  if (kind === 'discovery') {
    [0, 2, 4, 7].forEach((deg, i) =>
      playNote(melodyBus!, freqOf(deg, 1, mode), t + i * 0.14, 1.6, { type: 'triangle', vol: 0.075, attack: 0.01, release: 0.9 }),
    );
  } else if (kind === 'research') {
    [4, 2, 0].forEach((deg, i) =>
      playNote(melodyBus!, freqOf(deg, 1, mode), t + i * 0.22, 2.2, { type: 'triangle', vol: 0.07, attack: 0.01, release: 1.2 }),
    );
  } else {
    // contact: a bare low fifth swelling out of the dark
    playNote(padBus!, freqOf(0, -1, mode), t, 6, { type: 'sine', vol: 0.09, attack: 1.2, release: 2.5 });
    playNote(padBus!, freqOf(4, -1, mode), t + 0.8, 5.2, { type: 'sine', vol: 0.07, attack: 1.2, release: 2.5 });
  }
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    mood = 'ambient';
    bpm = 54;
  }, MOOD_TUNE[kind].holdMs);
}

/** called once from main.ts — never starts audio by itself */
export function initMusic() {
  // battery + politeness: hard-pause while the tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else if (on) void ctx.resume();
  });
  if (!prefRead()) return;
  // saved-on preference: honor it at the first user gesture (autoplay policy)
  const arm = () => {
    window.removeEventListener('pointerdown', arm);
    window.removeEventListener('keydown', arm);
    setMusicEnabled(true);
  };
  window.addEventListener('pointerdown', arm, { once: true });
  window.addEventListener('keydown', arm, { once: true });
}
