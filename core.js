// The DOM-free half. Loaded before app.js, which supplies pendingRewind.
// ===== Music theory =====
const MAX_ACCIDENTALS = 7; // key signatures beyond ±7 sharps/flats are unplayable
const SEMITONES = 12;
const pick = a => a[Math.floor(Math.random() * a.length)];
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pcMod = n => ((n % SEMITONES) + SEMITONES) % SEMITONES; // wrap into pitch class 0..11

// prettier-ignore
const keySharpsMajor = {
  "C♭": -7, "G♭": -6, "D♭": -5, "A♭": -4, "E♭": -3, "B♭": -2, "F": -1,
  "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F♯": 6, "C♯": 7,
};
// prettier-ignore
const rootPC = {
  "C": 0, "C♯": 1, "D♭": 1, "D": 2, "E♭": 3, "E": 4, "F": 5,
  "F♯": 6, "G♭": 6, "G": 7, "A♭": 8, "A": 9, "B♭": 10, "B": 11, "C♭": 11,
};
const sharpNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const flatNames = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

// Every mode in one row: display, key-signature offset from major, scale + arp intervals.
// Listed brightest → darkest; the mode-toggle row renders in this order.
// prettier-ignore
const MODES = [
  // Two chord spellings per mode, drilled 50-50: jazz shorthand (− = minor,
  // Δ = major 7th) and the spelled-out form.
  // id               short  sym      txt          off  scale             arp
  ["Lydian",         "lyd", "Δ♯11",  "maj7♯11",     1, [0,2,4,6,7,9,11], [0,4,7,11], false],
  ["Major",          "maj", "Δ7",    "maj7",        0, [0,2,4,5,7,9,11], [0,4,7,11], true ],
  ["Mixolydian",     "mix", "7",     "7",          -1, [0,2,4,5,7,9,10], [0,4,7,10], false],
  ["MelodicMinor",   "mel", "−Δ7",   "m(maj7)",    -3, [0,2,3,5,7,9,11], [0,3,7,11], false],
  ["Dorian",         "dor", "−7",    "m7",         -2, [0,2,3,5,7,9,10], [0,3,7,10], false],
  ["HarmonicMinor",  "har", "−Δ7",   "m(maj7)",    -3, [0,2,3,5,7,8,11], [0,3,7,11], false],
  ["Minor",          "min", "−7",    "m7",         -3, [0,2,3,5,7,8,10], [0,3,7,10], false],
  // Blues has no natural 3rd, so its arp is the in-scale m7.
  ["Blues",          "blu", "7",     "7",          -3, [0,3,5,6,7,10],   [0,3,7,10], false],
].map(([id, short, sym, txt, offset, scale, arp, on]) =>
  ({ id, short, chord: { sym, txt }, offset, scale, arp, on }));

const NOTATIONS = ["sym", "txt"];

const MODE = Object.fromEntries(MODES.map(m => [m.id, m]));
const defaultWeights = Object.fromEntries(MODES.map(m => [m.id, m.on ? 1 : 0]));

const transpositions = {
  C: 0, // concert
  "B♭": -2, // trumpet, tenor sax, clarinet
  "E♭": 3, // alto sax, bari sax
};
const patternLabels = { scale: "straight", thirds: "3rds", in3s: "in 3s" };
const patternOptions = Object.keys(patternLabels);

// ===== Persistence =====
// store(key, fallback, revive?) → { load, save }. `revive` returns undefined
// to reject a stored value and fall back.
function store(key, fallback, revive) {
  return {
    load() {
      const raw = localStorage.getItem(key);
      if (raw === null) return structuredClone(fallback);
      try {
        const parsed = typeof fallback === "string" ? raw : JSON.parse(raw);
        const value = revive ? revive(parsed) : parsed;
        return value === undefined ? structuredClone(fallback) : value;
      } catch {
        return structuredClone(fallback);
      }
    },
    save(value) {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

const historyStore = store("scales-history-v1", [], v => (Array.isArray(v) ? v : undefined));
// Filter to known ids: an unrecognised mode throws in activePools and blanks
// the page, which would make renaming or removing a mode a breaking change.
const weightsStore = store("scales-weights-v1", defaultWeights, v => ({
  ...defaultWeights,
  ...Object.fromEntries(Object.entries(v || {}).filter(([m]) => m in MODE)),
}));
const transpositionStore = store("scales-transposition-v1", "C");
// An empty array is a valid saved state (all patterns off), so only a
// non-array falls back to the default.
const patternsStore = store("scales-patterns-v2", ["scale"], v =>
  Array.isArray(v) ? v.filter(p => patternOptions.includes(p)) : undefined,
);

function activePools(w) {
  const pools = {};
  for (const [mode, wt] of Object.entries(w)) {
    if (wt <= 0) continue;
    pools[mode] = [];
    for (const [key, sig] of Object.entries(keySharpsMajor)) {
      if (Math.abs(sig + MODE[mode].offset) <= MAX_ACCIDENTALS) pools[mode].push(`${key} ${mode}`);
    }
  }
  return pools;
}

function buildUnlimitedList(w) {
  const pools = activePools(w);
  const out = [];
  for (const mode of Object.keys(pools)) out.push(...pools[mode]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Flats when this mode's key signature is on the flat side of the circle.
function useFlats(name) {
  const [key, mode] = name.split(" ");
  return keySharpsMajor[key] + MODE[mode].offset < 0;
}
function noteName(pc, flats) {
  return (flats ? flatNames : sharpNames)[pcMod(pc)];
}

const letterPCs = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const letters = ["C", "D", "E", "F", "G", "A", "B"];
function spelledName(letter, targetPc) {
  const base = letterPCs[letter];
  let diff = pcMod(targetPc - base);
  if (diff > 6) diff -= 12;
  if (diff === 0) return letter;
  if (diff === 1) return letter + "♯";
  if (diff === 2) return letter + "♯♯";
  if (diff === -1) return letter + "♭";
  if (diff === -2) return letter + "♭♭";
  return noteName(targetPc, false);
}
function scaleSpelling(scaleName) {
  const [key, mode] = scaleName.split(" ");
  const intervals = MODE[mode].scale;
  const root = rootPC[key];
  if (intervals.length !== 7) {
    const flats = useFlats(scaleName);
    return intervals.map(iv => noteName(pcMod(root + iv), flats));
  }
  const rootLetter = key[0];
  const rootIdx = letters.indexOf(rootLetter);
  return intervals.map((iv, i) => {
    const targetPc = pcMod(root + iv);
    const letter = letters[(rootIdx + i) % 7];
    return spelledName(letter, targetPc);
  });
}
function chordName(scaleName, notation = "sym") {
  const [key, mode] = scaleName.split(" ");
  return key + MODE[mode].chord[notation];
}
function modeOf(scaleName) {
  return scaleName.split(" ")[1];
}
function displayMode(mode) {
  return mode.replace(/([a-z])([A-Z])/g, "$1 $2");
}
// ===== Sequence: context, segments, patterns =====
// A path = { pcs, slots, phases } (parallel arrays).
// A pattern is a function of `ctx` returning { single, double?, branchIdx? }.

function scaleContext(scaleName, transposeSemi = 0) {
  const [key, mode] = scaleName.split(" ");
  const root = rootPC[key];
  const scale = MODE[mode].scale.map(i => pcMod(i + root));
  const arp = MODE[mode].arp.map(i => pcMod(i + root));
  const names = scaleSpelling(scaleName);
  const slotOfPc = {};
  scale.forEach((pc, i) => {
    slotOfPc[pc] = i;
  });
  const writtenByPc = {};
  scale.forEach((pc, i) => {
    writtenByPc[pc] = names[i];
  });
  return {
    scale,
    arp,
    // Semitones above the root, unwrapped — `scale` and `arp` are pitch
    // classes, so they cannot tell the root from the octave above it.
    steps: MODE[mode].scale,
    arpSteps: MODE[mode].arp,
    slotOfPc,
    octaveSlot: scale.length,
    toConcert: pc => pcMod(pc + transposeSemi),
    displayNames: [...names, names[0]],
    writtenByPc,
  };
}

function segment(ctx, phase, entries) {
  return {
    pcs: entries.map(e => ctx.toConcert(e.pc)),
    slots: entries.map(e => e.slot),
    steps: entries.map(e => e.step),
    phases: entries.map(() => phase),
  };
}
function compose(segments) {
  const pcs = [],
    slots = [],
    steps = [],
    phases = [];
  for (const seg of segments) {
    // An ascent ending on the octave meets a descent starting there; the
    // turnaround note is played once, not struck twice. A doubled pitch is
    // invisible to a tracker that fires on pitch change.
    const from = pcs.length && seg.pcs[0] === pcs[pcs.length - 1] ? 1 : 0;
    for (let i = from; i < seg.pcs.length; i++) {
      pcs.push(seg.pcs[i]);
      slots.push(seg.slots[i]);
      steps.push(seg.steps[i]);
      phases.push(seg.phases[i]);
    }
  }
  return { pcs, slots, steps, phases };
}

// ----- Scale segments -----
function scaleUpSeg(ctx, phase = "up") {
  const e = ctx.scale.map((pc, d) => ({ pc, slot: d, step: ctx.steps[d] }));
  e.push({ pc: ctx.scale[0], slot: ctx.octaveSlot, step: 12 }); // top octave
  return segment(ctx, phase, e);
}
function scaleDownSeg(ctx, phase = "down") {
  const e = [];
  for (let d = ctx.scale.length - 1; d >= 0; d--)
    e.push({ pc: ctx.scale[d], slot: d, step: ctx.steps[d] });
  return segment(ctx, phase, e);
}
function scaleUp2Seg(ctx) {
  const e = ctx.scale.slice(1).map((pc, i) => ({ pc, slot: i + 1, step: ctx.steps[i + 1] + 12 }));
  e.push({ pc: ctx.scale[0], slot: ctx.octaveSlot, step: 24 }); // 15th (top of 2nd)
  return segment(ctx, "up2", e);
}
function scaleDown2Seg(ctx) {
  const e = [];
  for (let d = ctx.scale.length - 1; d >= 1; d--)
    e.push({ pc: ctx.scale[d], slot: d, step: ctx.steps[d] + 12 });
  e.push({ pc: ctx.scale[0], slot: ctx.octaveSlot, step: 12 }); // octave point (halfway)
  return segment(ctx, "down", e);
}

// ----- Arpeggio segments (chord tones from ctx.arp = [root, 3, 5, 7]) -----
// tone(i, oct) is the i-th chord tone, oct octaves up.
const tone = (ctx, i, oct = 0) => ({
  pc: ctx.arp[i],
  slot: ctx.slotOfPc[ctx.arp[i]],
  step: ctx.arpSteps[i] + 12 * oct,
});

function arp1Seg(ctx) {
  const t = i => tone(ctx, i);
  return segment(ctx, "arp", [t(1), t(2), t(3), t(2), t(1), t(0)]);
}
// Triads up, the 7th only at the top. C major: C E G C E G B G E C G E C.
function arp2Seg(ctx) {
  // The root an octave up lights the top pill, not the one it started on.
  const t = (i, o) =>
    i === 0 && o ? { pc: ctx.arp[0], slot: ctx.octaveSlot, step: 12 * o } : tone(ctx, i, o);
  const up = o => [t(0, o), t(1, o), t(2, o)];
  const dn = o => [t(2, o), t(1, o), t(0, o)];
  // The scale descent already struck the leading root; compose drops it.
  return segment(ctx, "arp", [...up(0), ...up(1), tone(ctx, 3, 1), ...dn(1), ...dn(0)]);
}

// Resolve a scale degree to a note, allowing it to run past either end of
// the octave (8 is the root above, -1 the leading tone below).
function degNote(ctx, deg) {
  const n = ctx.scale.length;
  const idx = ((deg % n) + n) % n;
  return {
    pc: ctx.scale[idx],
    slot: idx === 0 && deg > 0 ? ctx.octaveSlot : idx,
    step: ctx.steps[idx] + 12 * Math.floor(deg / n),
  };
}

// One walk per degree; `emit` decides what each step plays. `dir` is +1 up /
// -1 down, so a descent mirrors the exercise instead of replaying it backwards.
function walkSeg(ctx, phase, direction, emit) {
  const top = ctx.scale.length;
  const up = direction === "up";
  const e = [];
  for (let d = up ? 0 : top; up ? d < top : d > 0; up ? d++ : d--) emit(e, d, up ? 1 : -1);
  e.push(degNote(ctx, up ? top : 0));
  return segment(ctx, phase, e);
}

const intervalSeg = (ctx, step, phase = "up", direction = "up") =>
  walkSeg(ctx, phase, direction, (e, d, dir) =>
    e.push(degNote(ctx, d), degNote(ctx, d + dir * step)),
  );

const groupSeg = (ctx, size, phase = "up", direction = "up") =>
  walkSeg(ctx, phase, direction, (e, d, dir) => {
    for (let k = 0; k < size; k++) e.push(degNote(ctx, d + dir * k));
  });

// ----- Patterns -----
const patterns = {
  scale: {
    single: ctx => compose([scaleUpSeg(ctx), scaleDownSeg(ctx), arp1Seg(ctx)]),
    double: ctx => {
      const p = compose([
        scaleUpSeg(ctx),
        scaleUp2Seg(ctx),
        scaleDown2Seg(ctx),
        scaleDownSeg(ctx),
        arp2Seg(ctx),
      ]);
      // Root and octave belong to the two-octave ascent too.
      p.phases[0] = "up2";
      p.phases[ctx.scale.length] = "up2";
      return p;
    },
    branchIdx: ctx => ctx.scale.length + 1,
  },
  thirds: {
    single: ctx => compose([intervalSeg(ctx, 2, "up"), intervalSeg(ctx, 2, "down", "down")]),
  },
  in3s: { single: ctx => compose([groupSeg(ctx, 3, "up"), groupSeg(ctx, 3, "down", "down")]) },
};

function buildExpected(scaleName, transposeSemi = 0, patternKey = "scale") {
  const ctx = scaleContext(scaleName, transposeSemi);
  const pat = patterns[patternKey] || patterns.scale;
  const single = pat.single(ctx);
  const double = pat.double ? pat.double(ctx) : null;
  const branchIdx = double && pat.branchIdx ? pat.branchIdx(ctx) : null;
  return {
    single,
    double,
    branchIdx,
    displayNames: ctx.displayNames,
    writtenByPc: ctx.writtenByPc,
  };
}

function getPhaseAt(i, matchIdx, path) {
  const p = path.phases[i];
  // Peak of an "up" phase becomes "down" once the note AFTER it has been played (turnaround confirmed).
  if ((p === "up" || p === "up2") && matchIdx > i + 1 && path.phases[i + 1] === "down")
    return "down";
  return p;
}

// ===== Pitch detection (autocorrelation) =====
// prettier-ignore
const PITCH = {
  minFreq: 41, maxFreq: 1400,    // E1 up; low end verified against synthetic tones
  minRms: 0.0015,                // hard floor only; the tracker's adaptive gate does the real work
  trimThreshold: 0.2,            // edge-trim amplitude for the correlation window
  minWindow: 64,                 // samples needed for a usable correlation
  a4: 440, a4Midi: 69,
};

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let sumSq = 0;
  for (let i = 0; i < SIZE; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / SIZE);
  if (rms < PITCH.minRms) return { freq: -1, rms };

  let r1 = 0,
    r2 = SIZE - 1;
  const thres = PITCH.trimThreshold;
  for (let i = 0; i < SIZE / 2; i++)
    if (Math.abs(buf[i]) < thres) {
      r1 = i;
      break;
    }
  for (let i = 1; i < SIZE / 2; i++)
    if (Math.abs(buf[SIZE - i]) < thres) {
      r2 = SIZE - i;
      break;
    }
  const trimmed = buf.slice(r1, r2);
  const N = trimmed.length;
  if (N < PITCH.minWindow) return { freq: -1, rms };

  const c = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = 0; j < N - i; j++) s += trimmed[j] * trimmed[j + i];
    c[i] = s;
  }

  let d = 0;
  while (d + 1 < N && c[d] > c[d + 1]) d++;
  let maxv = -Infinity,
    maxi = -1;
  for (let i = d; i < N; i++)
    if (c[i] > maxv) {
      maxv = c[i];
      maxi = i;
    }
  if (maxi < 1 || maxi >= N - 1) return { freq: -1, rms };

  const x1 = c[maxi - 1],
    x2 = c[maxi],
    x3 = c[maxi + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  const T0 = maxi - (a ? b / (2 * a) : 0);
  const freq = sampleRate / T0;
  if (freq < PITCH.minFreq || freq > PITCH.maxFreq) return { freq: -1, rms };
  return { freq, rms };
}

function freqToMidi(freq) {
  return PITCH.a4Midi + SEMITONES * Math.log2(freq / PITCH.a4);
}
function freqToPC(freq) {
  const midi = Math.round(freqToMidi(freq));
  return pcMod(midi);
}
function freqToCents(freq) {
  const midi = freqToMidi(freq);
  return (midi - Math.round(midi)) * 100; // in [-50, 50)
}

// ===== Note tracker: emits a note event on each stable pitch onset =====
// Relative to the measured floor, not absolute: input level varies wildly
// between a phone held close and a laptop across the room.
// prettier-ignore
const TRACKER = {
  stability: 2,      // consecutive frames on the same pitch before it counts as a note
  onRatio: 10,       // attack when RMS exceeds this multiple of the floor
  offRatio: 0.4,     // release when RMS drops below this fraction of the attack gate
  minOn: 0.006,      // absolute floor so a silent room doesn't trigger on nothing
  maxOn: 0.03,       // hard ceiling: a bad floor estimate must never deafen us
  floorFall: 0.1,    // floor tracks downward fast...
  floorRise: 0.002,  // ...and upward slowly, so it converges on true ambient
};

// A laptop mic hears more of the room than a phone held close.
const GATE_BOOST = window.matchMedia("(hover: hover)").matches ? 1.8 : 1;

class NoteTracker {
  constructor(onNote, onSilence) {
    this.onNote = onNote;
    this.onSilence = onSilence || (() => {});
    this.reset();
    this.STABILITY = TRACKER.stability;
    this.noiseFloor = null;
  }
  reset() {
    this.state = "silent";
    this.currentPC = -1;
    this.candPC = -1;
    this.candCount = 0;
  }
  get rmsOn() {
    const scaled = (this.noiseFloor ?? 0) * TRACKER.onRatio * GATE_BOOST;
    return Math.min(TRACKER.maxOn * GATE_BOOST, Math.max(TRACKER.minOn * GATE_BOOST, scaled));
  }
  process(rms, freq) {
    // Only sample the ambient floor between notes; fall fast, rise slow.
    if (this.state === "silent") {
      if (this.noiseFloor === null) this.noiseFloor = rms;
      const a = rms < this.noiseFloor ? TRACKER.floorFall : TRACKER.floorRise;
      this.noiseFloor += (rms - this.noiseFloor) * a;
      // Sustained sound must not be mistaken for room noise, or the gate
      // chases the signal upward and can never be crossed.
      this.noiseFloor = Math.min(this.noiseFloor, TRACKER.maxOn / TRACKER.onRatio);
    }
    const onGate = this.rmsOn;
    if (this.state === "playing" && rms < onGate * TRACKER.offRatio) {
      this.state = "silent";
      this.currentPC = -1;
      this.candPC = -1;
      this.candCount = 0;
      this.onSilence();
      return;
    }
    if (this.state === "silent" && rms < onGate) return;
    // Carries the register, so the matcher can tell the octave from the root.
    const midi = freq > 0 ? Math.round(freqToMidi(freq)) : -1;
    if (midi < 0) return;
    const pc = pcMod(midi);
    const cents = freqToCents(freq);

    if (this.state === "silent") {
      if (this.candPC === pc) this.candCount++;
      else {
        this.candPC = pc;
        this.candCount = 1;
      }
      if (this.candCount >= this.STABILITY) {
        this.state = "playing";
        this.currentPC = pc;
        this.candPC = -1;
        this.candCount = 0;
        this.onNote(pc, cents, midi);
      }
    } else {
      if (pc === this.currentPC) {
        this.candPC = -1;
        this.candCount = 0;
      } else if (pc === this.candPC) {
        this.candCount++;
        if (this.candCount >= this.STABILITY) {
          this.currentPC = pc;
          this.candPC = -1;
          this.candCount = 0;
          this.onNote(pc, cents, midi);
        }
      } else {
        this.candPC = pc;
        this.candCount = 1;
      }
    }
  }
}

// ===== Matcher =====
class Matcher {
  constructor(expected, { onProgress, onSuccess }) {
    this.expected = expected;
    this.matchIdx = 0;
    this.cents = [];
    this.path = null; // "single" or "double"; decided at branchIdx
    this.baseMidi = null; // register of the first note, so steps are relative
    this.onProgress = onProgress;
    this.onSuccess = onSuccess;
  }
  currentPath() {
    return this.expected[this.path || "single"];
  }
  // `midi` places the note in a register; without it only the pitch class is
  // known, and the root is indistinguishable from the octave above it.
  input(pc, cents = 0, midi = null) {
    pendingRewind.cancel();
    if (this.matchIdx === 0 && midi !== null) this.baseMidi = midi;
    const step = midi !== null && this.baseMidi !== null ? midi - this.baseMidi : null;
    if (this.path === null && this.matchIdx === this.expected.branchIdx) {
      if (pc === this.expected.single.pcs[this.matchIdx]) this.path = "single";
      else if (pc === this.expected.double.pcs[this.matchIdx]) this.path = "double";
    }
    const path = this.currentPath();
    if (pc === path.pcs[this.matchIdx]) {
      this.cents.push(cents);
      this.matchIdx++;
      this.onProgress();
      if (this.matchIdx === path.pcs.length) {
        this.onSuccess();
      }
      return;
    }
    // Backward search on the committed (or default single) path. Register
    // matters here: the octave above the root is not the root.
    for (let k = this.matchIdx - 1; k >= 0; k--) {
      if (path.pcs[k] === pc && (step === null || path.steps[k] === step)) {
        pendingRewind.arm({ pc, rewindTo: k + 1, cents });
        return;
      }
    }
  }
}

// Nobody plays a full scale + arpeggio faster than this, so anything quicker
// is a manual skip (or a spurious detection) and is left out of the stats.
const MIN_SCALE_MS = 10_000;
const SUCCESS_HOLD_MS = 600;
