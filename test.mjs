// Regression tests for index.html.  Run: node test.mjs
//
// Every assertion here corresponds to something that actually broke during
// development, so a failure means a real behaviour has regressed rather than
// a style preference has been violated.
//
// The whole <script> is evaluated in one vm context against a stub DOM. That
// makes the suite indifferent to how the file is ordered internally, and it
// means "the app boots" is itself covered — two past regressions were
// ReferenceErrors thrown during init.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SRC = new URL("./index.html", import.meta.url);

// ---------------------------------------------------------------- harness

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
function eq(actual, expected, what = "value") {
  const a = Array.isArray(actual) ? actual.join(" ") : String(actual);
  const b = Array.isArray(expected) ? expected.join(" ") : String(expected);
  if (a !== b) throw new Error(`${what}\n      got: ${a}\n      want: ${b}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

// ------------------------------------------------------------- stub DOM

function boot({ storage = {}, hover = true, width = 1440, clock = { t: 0 } } = {}) {
  const node = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, style: {}, textContent: "", innerHTML: "",
    addEventListener() {}, remove() {}, insertAdjacentHTML() {},
    setAttribute() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
  });
  const canvas2d = { font: "", measureText: t => ({ width: t.length * 0.6 * 88 }) };

  const ctx = createContext({
    console, Math, Object, Array, JSON, Set, Map, String, Number, parseInt, parseFloat,
    Float32Array, isNaN, structuredClone: v => JSON.parse(JSON.stringify(v)),
    setTimeout, clearTimeout, requestAnimationFrame: () => 0,
    performance: { now: () => clock.t },
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; },
    },
    location: { hostname: "localhost", search: "" },
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error("no mic in tests")) } },
    getComputedStyle: () => ({
      getPropertyValue: n => ({ "--good": "#8dd88d", "--bad": "#ff6b6b",
                                "--mono": "monospace" }[n] ?? "#000000"),
    }),
    document: {
      documentElement: { style: { setProperty() {} }, clientWidth: width },
      getElementById: () => node(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ ...node(), getContext: () => canvas2d }),
      addEventListener() {},
    },
    window: { matchMedia: () => ({ matches: hover }), addEventListener() {} },
  });
  ctx.globalThis = ctx;

  const html = readFileSync(SRC, "utf8");
  const script = html.split("<script>")[1].split("</script>")[0];
  runInContext(script + `
    ;globalThis.__api = {
      MODES, MODE, keySharpsMajor, MAX_ACCIDENTALS, NOTATIONS,
      buildExpected, scaleSpelling, activePools, buildUnlimitedList,
      useFlats, signatureOf, chordName, scaleContext, patterns,
      intervalSeg, groupSeg, Matcher, NoteTracker, TRACKER,
      autoCorrelate, PITCH, TUNER, weightsStore, defaultWeights,
      get matcher() { return currentMatcher; },
      get times() { return times; },
      get state() { return state; },
      completeCurrent,
    };`, ctx);
  return ctx.__api;
}

// The app must initialise cleanly — this alone has caught two regressions
// (a ReferenceError after a partial feature removal, and a null deref).
let api;
check("boots without throwing", () => { api = boot(); ok(api, "no api exported"); });
if (!api) { console.error("boot failed; aborting"); process.exit(1); }

// ------------------------------------------------------------------ theory

check("no key signature exceeds 7 accidentals", () => {
  for (const m of api.MODES)
    for (const name of api.activePools({ [m.id]: 1 })[m.id])
      ok(Math.abs(api.signatureOf(name)) <= api.MAX_ACCIDENTALS,
         `${name} needs ${api.signatureOf(name)}`);
});

// The bug the whole project started from: D♭ minor would need 8 flats.
check("over-accidental scales are excluded", () => {
  const minor = api.activePools({ Minor: 1 }).Minor;
  for (const bad of ["D♭ Minor", "G♭ Minor", "C♭ Minor"])
    ok(!minor.includes(bad), `${bad} should not be offered`);
  eq(minor.length, 12, "minor key count");
});

check("scale spelling uses each letter once", () => {
  for (const m of api.MODES) {
    if (api.MODE[m.id].scale.length !== 7) continue;   // blues repeats a letter
    for (const name of api.activePools({ [m.id]: 1 })[m.id]) {
      const letters = api.scaleSpelling(name).map(n => n[0]);
      eq(new Set(letters).size, 7, `${name} letters: ${letters.join("")}`);
    }
  }
});

check("enharmonic spellings are diatonic", () => {
  eq(api.scaleSpelling("G♭ Major"), ["G♭","A♭","B♭","C♭","D♭","E♭","F"], "G♭ major");
  eq(api.scaleSpelling("C♭ Major"), ["C♭","D♭","E♭","F♭","G♭","A♭","B♭"], "C♭ major");
  eq(api.scaleSpelling("F♯ Major"), ["F♯","G♯","A♯","B","C♯","D♯","E♯"], "F♯ major");
});

// Blues is the only mode that repeats a letter (G♭ then G♮) and the only
// six-note one, so it misses the letter-uniqueness check above.
check("blues spells its flat and natural fifth", () => {
  eq(api.scaleSpelling("C Blues"), ["C","E♭","F","G♭","G","B♭"], "C blues");
  eq(api.buildExpected("C Blues", 0, "scale").displayNames.length, 7, "six notes plus the octave");
});

check("chord names cover both notations", () => {
  eq(api.chordName("G Dorian", "sym"), "G−7");
  eq(api.chordName("G Dorian", "txt"), "Gm7");
  eq(api.chordName("G MelodicMinor", "sym"), "G−Δ7");
  eq(api.chordName("G Lydian", "txt"), "Gmaj7♯11");
});

// ---------------------------------------------------------------- patterns

const DEGREE = { 0:"1", 2:"2", 4:"3", 5:"4", 7:"5", 9:"6", 11:"7" };
const asDegrees = (ctx, path) =>
  path.slots.map(s => (s === 7 ? "8" : DEGREE[ctx.scale[s]])).join(" ");

check("ascending and descending runs are exact", () => {
  const c = api.scaleContext("C Major", 0);
  eq(asDegrees(c, api.intervalSeg(c, 2, "up")),
     "1 3 2 4 3 5 4 6 5 7 6 8 7 2 8", "3rds up");
  // Descending must mirror the exercise, not replay the ascent backwards:
  // it opens 8-6 (not a leap up to the 9th) and ends 3-1, 2-7, 1.
  eq(asDegrees(c, api.intervalSeg(c, 2, "down", "down")),
     "8 6 7 5 6 4 5 3 4 2 3 1 2 7 1", "3rds down");
  eq(asDegrees(c, api.groupSeg(c, 3, "up")),
     "1 2 3 2 3 4 3 4 5 4 5 6 5 6 7 6 7 8 7 8 2 8", "in3s up");
  eq(asDegrees(c, api.groupSeg(c, 3, "down", "down")),
     "8 7 6 7 6 5 6 5 4 5 4 3 4 3 2 3 2 1 2 1 7 1", "in3s down");
});

check("sequence lengths are stable", () => {
  for (const [pat, single, double] of [["scale",21,45], ["thirds",29,57], ["in3s",43,85]]) {
    const e = api.buildExpected("C Major", 0, pat);
    eq(e.single.pcs.length, single, `${pat} single`);
    eq(e.double.pcs.length, double, `${pat} double`);
  }
});

check("paths are identical up to the branch and diverge there", () => {
  for (const pat of ["scale", "thirds", "in3s"]) {
    const e = api.buildExpected("C Major", 0, pat), b = e.branchIdx;
    for (let i = 0; i < b; i++)
      eq(e.single.pcs[i], e.double.pcs[i], `${pat} prefix differs at ${i}`);
    ok(e.single.pcs[b] !== e.double.pcs[b], `${pat} does not diverge at ${b}`);
  }
});

// The turnaround note is struck once. NoteTracker fires on pitch change, so a
// doubled pitch would be undetectable and would stall the run.
check("no pitch repeats back to back", () => {
  for (const pat of ["scale", "thirds", "in3s"])
    for (const which of ["single", "double"]) {
      const pcs = api.buildExpected("C Major", 0, pat)[which].pcs;
      const at = pcs.findIndex((v, i) => i > 0 && v === pcs[i - 1]);
      ok(at < 0, `${pat}/${which} repeats at index ${at}`);
    }
});

// ----------------------------------------------------------------- matcher

check("a correct run completes and keeps its cents", () => {
  const e = api.buildExpected("D Major", 0, "scale");
  let done = false;
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() { done = true; } });
  for (const pc of e.single.pcs) m.input(pc, 7);
  ok(done, "onSuccess never fired");
  // Cents must survive to the end — they were silently lost once, which made
  // the intonation summary permanently null.
  eq(m.cents.length, e.single.pcs.length, "cents recorded");
  eq(m.cents.every(c => c === 7), true, "cents preserved");
});

await checkAsync("a backward note rewinds once it survives the hold", async () => {
  const e = api.buildExpected("D Major", 0, "scale");
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 4; i++) m.input(e.single.pcs[i], 0);
  m.input(e.single.pcs[1], 0);                       // back to the second note
  eq(m.matchIdx, 4, "rewound before the hold elapsed");
  await new Promise(r => setTimeout(r, 400));
  eq(m.matchIdx, 2, "did not rewind to just past that note");
  eq(m.cents.length, 2, "cents not truncated with the rewind");
});

// Playing straight through a stray backward detection must cost nothing.
await checkAsync("a following note cancels a pending rewind", async () => {
  const e = api.buildExpected("D Major", 0, "scale");
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 4; i++) m.input(e.single.pcs[i], 0);
  m.input(e.single.pcs[1], 0);                       // stray backward blip
  m.input(e.single.pcs[4], 0);                       // carry on regardless
  await new Promise(r => setTimeout(r, 400));
  eq(m.matchIdx, 5, "the stray rewind was not cancelled");
});

check("an unknown note leaves progress alone", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 3; i++) m.input(e.single.pcs[i], 0);
  m.input((e.single.pcs[0] + 1) % 12, 0);   // chromatic neighbour, not in the run
  eq(m.matchIdx, 3, "progress lost on a wrong note");
});

check("the second octave is chosen at the branch", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const play = (upTo, nextPc) => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < upTo; i++) m.input(e.single.pcs[i], 0);
    m.input(nextPc, 0);
    return m.path;
  };
  eq(play(e.branchIdx, e.single.pcs[e.branchIdx]), "single", "single path");
  eq(play(e.branchIdx, e.double.pcs[e.branchIdx]), "double", "double path");
});

// ----------------------------------------------------------------- tracker

check("the note gate settles above a quiet room", () => {
  const t = new api.NoteTracker(() => {});
  for (let i = 0; i < 400; i++) t.process(0.0012, -1, i * 16);
  ok(t.rmsOn > 0.0012 && t.rmsOn < 0.05, `gate ${t.rmsOn} out of range`);
});

// The gate once tracked whatever it heard while still "silent", so sound
// present when the mic opened pushed it out of reach and playing louder
// raised the bar. It must never lock out.
check("loud input from the first frame still registers", () => {
  let fired = 0;
  const t = new api.NoteTracker(() => fired++);
  for (let i = 0; i < 60; i++) t.process(0.25, 440, i * 16);   // ~1s held
  eq(t.state, "playing", "tracker never left silence");
  ok(fired > 0, "no note fired");
});

// The reason the hold exists: sliding through pitches must not count them.
check("a gliss registers nothing", () => {
  const heard = [];
  const t = new api.NoteTracker(pc => heard.push(pc));
  // A deliberate slide: an octave over a second, so each semitone lingers
  // ~80ms. Fast enough to be a gliss, slow enough that a short hold would
  // wrongly count all twelve.
  let clock = 0;
  for (let semi = 0; semi <= 12; semi++)
    for (let f = 0; f < 5; f++) {
      t.process(0.2, 440 * Math.pow(2, (60 + semi - 69) / 12), clock);
      clock += 16;
    }
  eq(heard.length, 0, `gliss produced ${heard.length} notes: ${heard}`);
});

check("a sustained note registers exactly once", () => {
  const heard = [];
  const t = new api.NoteTracker(pc => heard.push(pc));
  for (let i = 0; i < 120; i++) t.process(0.2, 440, i * 16);   // ~2s on one pitch
  eq(heard, [9], "A should fire once and only once");
});

check("a held scale registers every note in order", () => {
  const heard = [];
  const t = new api.NoteTracker(pc => heard.push(pc));
  let clock = 0;
  for (const midi of [60, 62, 64, 65, 67]) {                    // C D E F G
    for (let i = 0; i < 40; i++) {                              // 640ms each
      t.process(0.2, 440 * Math.pow(2, (midi - 69) / 12), clock);
      clock += 16;
    }
  }
  eq(heard, [0, 2, 4, 5, 7], "held notes not reported in order");
});

// The floor seeds from the first frame at any level. If it only sampled
// below the gate it could never bootstrap in a room louder than the minimum,
// leaving the bar pinned low and room noise firing notes all session.
check("a room louder than the minimum gate stays silent", () => {
  let fired = 0;
  const t = new api.NoteTracker(() => fired++);
  for (let i = 0; i < 600; i++) t.process(0.015, 440, i * 16);   // fan / air-con
  ok(t.noiseFloor !== null, "floor never bootstrapped");
  ok(t.rmsOn > 0.015, `gate ${t.rmsOn} sits below the room`);
  eq(t.state, "silent", "room noise was treated as playing");
  eq(fired, 0, `room noise produced ${fired} notes`);
});

check("desktop demands more signal than touch", () => {
  const gate = hover => {
    const a = boot({ hover });
    const t = new a.NoteTracker(() => {});
    for (let i = 0; i < 400; i++) t.process(0.0012, -1, i * 16);
    return t.rmsOn;
  };
  ok(gate(true) > gate(false), "desktop gate should be higher");
});

// --------------------------------------------------------- pitch detection

function tone(freq, rate, n) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    buf[i] = 0.5 * Math.sin(2 * Math.PI * freq * t)
           + 0.3 * Math.sin(4 * Math.PI * freq * t)
           + 0.15 * Math.sin(6 * Math.PI * freq * t);
  }
  return buf;
}

check("pitch detection spans the advertised range", () => {
  for (const rate of [44100, 48000])
    for (const f of [41, 55, 82, 110, 165, 262, 440, 880, 1319]) {
      const { freq } = api.autoCorrelate(tone(f, rate, 2048), rate);
      ok(freq > 0, `${f}Hz @${rate} not detected`);
      const cents = Math.abs(1200 * Math.log2(freq / f));
      ok(cents < 50, `${f}Hz @${rate} off by ${cents.toFixed(0)} cents`);
    }
});

check("out-of-range pitches are rejected", () => {
  const { freq } = api.autoCorrelate(tone(30, 48000, 2048), 48000);
  ok(freq < 0, "sub-range tone accepted");
});

// ------------------------------------------------------------- persistence

// An unrecognised mode id used to throw during init and render a blank page,
// which meant no mode could ever be renamed or removed.
check("unknown stored mode ids are ignored, not fatal", () => {
  const a = boot({ storage: { "scales-weights-v1": JSON.stringify({ Major: 1, Aeolian: 1 }) } });
  const w = a.weightsStore.load();
  ok(!("Aeolian" in w), "unknown mode survived the load");
  eq(a.buildUnlimitedList(w).length, 15, "major-only session");
});

check("corrupt storage falls back to defaults", () => {
  for (const bad of ["not json", "[1,2,3]", "null"])
    boot({ storage: { "scales-weights-v1": bad, "scales-patterns-v2": bad } });
});

// ------------------------------------------------------- end-to-end timing

// The intonation figure once vanished between onSequenceComplete and the
// deferred completeCurrent: the matcher was cleared before its cents were
// read, so every auto-advanced scale recorded null. Testing the Matcher in
// isolation does not catch that — the loop has to actually run.
await checkAsync("a completed scale records its intonation", async () => {
  const clock = { t: 0 };
  const a = boot({ clock });
  const m = a.matcher;
  ok(m, "no matcher after boot");
  const pcs = m.expected.single.pcs;

  m.input(pcs[0], 11);            // first note arms the start hold
  m.input(pcs[1], 11);            // second commits: beginPlaying stamps scaleStart
  eq(a.state, "playing", "run did not start");

  // Just past the derived floor for 21 notes (20 holds x 250ms = 5.0s), so
  // this fails if the floor drifts in either direction.
  clock.t = 5_200;
  for (let i = 2; i < pcs.length; i++) m.input(pcs[i], 11);

  await new Promise(r => setTimeout(r, 700));   // wait out the success hold

  const rec = a.times[0];
  ok(rec, "nothing was recorded");
  ok(typeof rec.cents === "number", `cents recorded as ${rec.cents}`);
  eq(Math.round(rec.cents), 11, "cents value");
});

// A run quicker than every note could have been held is a spurious match.
await checkAsync("a run faster than the hold allows is discarded", async () => {
  const clock = { t: 0 };
  const a = boot({ clock });
  const m = a.matcher;
  const pcs = m.expected.single.pcs;
  m.input(pcs[0], 5);
  clock.t = 4_000;                       // just under the 5.0s floor for 21 notes
  for (let i = 1; i < pcs.length; i++) m.input(pcs[i], 5);
  await new Promise(r => setTimeout(r, 700));
  eq(a.times.length, 0, "an impossibly fast run was recorded");
});

// Advancing during the green hold must keep the run — the scale was already
// played correctly, and on touch tapping onward is the natural gesture.
await checkAsync("advancing during the success hold still records", async () => {
  const clock = { t: 0 };
  const a = boot({ clock });
  const pcs = a.matcher.expected.single.pcs;
  a.matcher.input(pcs[0], 4);
  clock.t = 8_000;
  for (let i = 1; i < pcs.length; i++) a.matcher.input(pcs[i], 4);
  a.completeCurrent();                    // tapped before the hold elapsed
  await new Promise(r => setTimeout(r, 800));
  eq(a.times.length, 1, "a correctly played run was discarded");
  eq(typeof a.times[0].cents, "number", "cents lost when advancing early");
});

// Advancing by hand is a skip regardless of elapsed time: nothing confirmed
// the scale was played, so timing it would just be timing a keypress.
check("a manual advance is not recorded", () => {
  const clock = { t: 0 };
  const a = boot({ clock });
  a.matcher.input(a.matcher.expected.single.pcs[0], 0);   // starts the run
  clock.t = 60_000;                                       // clear of any floor
  a.completeCurrent();                                    // advanced by hand
  eq(a.times.length, 0, "a manual advance was counted as a result");
});

// ---------------------------------------------------------------- report

for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
