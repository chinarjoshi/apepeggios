// Regression tests for app.js.  Run: node test.mjs
//
// Every assertion covers something that actually broke. The whole of app.js
// runs in one vm against a stub DOM, so the suite survives reordering and
// "the app boots" is itself covered.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SRC = new URL("./app.js", import.meta.url);

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

function boot({ storage = {}, hover = true, width = 1440, clock = { t: 0 }, wakeLock } = {}) {
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
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error("no mic in tests")) },
      ...(wakeLock ? { wakeLock } : {}),
    },
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

  const script = readFileSync(SRC, "utf8");
  runInContext(script + `
    ;globalThis.__api = {
      MODES, MODE, keySharpsMajor, MAX_ACCIDENTALS, NOTATIONS,
      buildExpected, scaleSpelling, activePools, buildUnlimitedList,
      useFlats, chordName, scaleContext, patterns,
      intervalSeg, groupSeg, Matcher, NoteTracker, TRACKER, pendingRewind,
      autoCorrelate, PITCH, TUNER, weightsStore, defaultWeights,
      get matcher() { return currentMatcher; },
      get times() { return times; },
      get state() { return state; },
      completeCurrent,
    };`, ctx);
  return ctx.__api;
}

// Each check is the sole or near-sole detector of a real regression, chosen
// by mutation testing. A case that catches nothing is noise.

let api;
check("boots without throwing", () => { api = boot(); ok(api, "no api exported"); });
if (!api) { console.error("boot failed; aborting"); process.exit(1); }

// ------------------------------------------------------------------ theory

// Where this project started: D♭ minor would need 8 flats.
check("key signatures stay inside seven accidentals", () => {
  for (const m of api.MODES)
    for (const [key, sig] of Object.entries(api.keySharpsMajor)) {
      const name = `${key} ${m.id}`;
      if (!api.activePools({ [m.id]: 1 })[m.id].includes(name)) continue;
      ok(Math.abs(sig + m.offset) <= api.MAX_ACCIDENTALS,
         `${name} needs ${sig + m.offset}`);
    }
  const minor = api.activePools({ Minor: 1 }).Minor;
  for (const bad of ["D♭ Minor", "G♭ Minor", "C♭ Minor"])
    ok(!minor.includes(bad), `${bad} should not be offered`);
  eq(minor.length, 12, "minor key count");
});

check("scales are spelled diatonically", () => {
  eq(api.scaleSpelling("G♭ Major"), ["G♭","A♭","B♭","C♭","D♭","E♭","F"], "G♭ major");
  eq(api.scaleSpelling("C♭ Major"), ["C♭","D♭","E♭","F♭","G♭","A♭","B♭"], "C♭ major");
  eq(api.scaleSpelling("F♯ Major"), ["F♯","G♯","A♯","B","C♯","D♯","E♯"], "F♯ major");
  eq(api.scaleSpelling("C Blues"), ["C","E♭","F","G♭","G","B♭"], "C blues");
  for (const m of api.MODES) {
    if (api.MODE[m.id].scale.length !== 7) continue;
    for (const name of api.activePools({ [m.id]: 1 })[m.id]) {
      const letters = api.scaleSpelling(name).map(n => n[0]);
      eq(new Set(letters).size, 7, `${name}: ${letters.join("")}`);
    }
  }
});

check("chords and arpeggios match their mode", () => {
  eq(api.MODES.map(m => api.chordName("G " + m.id, "sym")).join(" "),
     "GΔ♯11 GΔ7 G7 G−Δ7 G−7 G−Δ7 G−7 G7", "jazz shorthand");
  eq(api.MODES.map(m => api.chordName("G " + m.id, "txt")).join(" "),
     "Gmaj7♯11 Gmaj7 G7 Gm(maj7) Gm7 Gm(maj7) Gm7 G7", "spelled out");
  eq(api.MODES.map(m => m.arp.join("-")).join("  "),
     "0-4-7-11  0-4-7-11  0-4-7-10  0-3-7-11  0-3-7-10  0-3-7-11  0-3-7-10  0-3-7-10",
     "arpeggio intervals");
  // A tone outside its own scale has no pill to light up. Blues shipped
  // broken this way, with a natural 3rd it does not contain.
  for (const m of api.MODES)
    for (const tone of m.arp)
      ok(m.scale.includes(tone), `${m.id} arpeggio tone ${tone} is not in the scale`);
});

// ---------------------------------------------------------------- patterns

const DEGREE = { 0:"1", 2:"2", 4:"3", 5:"4", 7:"5", 9:"6", 11:"7" };
const asDegrees = (ctx, path) =>
  path.slots.map(s => (s === 7 ? "8" : DEGREE[ctx.scale[s]])).join(" ");

check("runs ascend and descend exactly", () => {
  const c = api.scaleContext("C Major", 0);
  eq(asDegrees(c, api.intervalSeg(c, 2, "up")),
     "1 3 2 4 3 5 4 6 5 7 6 8 7 2 8", "3rds up");
  // Mirrors the exercise, not the ascent reversed: opens 8-6, ends 2-7, 1.
  eq(asDegrees(c, api.intervalSeg(c, 2, "down", "down")),
     "8 6 7 5 6 4 5 3 4 2 3 1 2 7 1", "3rds down");
  eq(asDegrees(c, api.groupSeg(c, 3, "up")),
     "1 2 3 2 3 4 3 4 5 4 5 6 5 6 7 6 7 8 7 8 2 8", "in3s up");
  eq(asDegrees(c, api.groupSeg(c, 3, "down", "down")),
     "8 7 6 7 6 5 6 5 4 5 4 3 4 3 2 3 2 1 2 1 7 1", "in3s down");
  // Struck once: a doubled pitch is invisible to the tracker and would stall.
  for (const pat of ["scale", "thirds", "in3s"])
    for (const which of ["single", "double"]) {
      const p = api.buildExpected("C Major", 0, pat)[which];
      if (!p) continue;
      const at = p.pcs.findIndex((v, i) => i > 0 && v === p.pcs[i - 1]);
      ok(at < 0, `${pat}/${which} repeats a pitch at ${at}`);
    }
});

check("single and double paths diverge only at the branch", () => {
  for (const [pat, single, double] of [["scale",21,45], ["thirds",29,null], ["in3s",43,null]]) {
    const e = api.buildExpected("C Major", 0, pat), b = e.branchIdx;
    eq(e.single.pcs.length, single, `${pat} single length`);
    // Steps carry the register the pitch classes throw away: they must agree
    // with the pitches and start on the root.
    e.single.pcs.forEach((pc, i) => eq((e.single.steps[i] % 12 + 12) % 12, pc,
      `${pat} step ${e.single.steps[i]} at ${i} is not the pitch played`));
    eq(e.single.steps[0], 0, `${pat} does not start on the root`);
    // Nothing leaps further than a fifth; a jump past an octave means some
    // entry lost the register it was built in.
    const leapOk = p => p.steps.forEach((st, i) => ok(i === 0 || Math.abs(st - p.steps[i - 1]) <= 12,
      `${pat} leaps ${Math.abs(st - p.steps[i - 1])} semitones at ${i}`));
    // Every ascent finishes on the octave, whatever route it took there.
    const top = p => Math.max(...p.steps.filter((_, i) => p.phases[i].startsWith("up")));
    leapOk(e.single);
    ok(top(e.single) >= 12, `${pat} ascent never reaches the octave`);
    if (double === null) { ok(!e.double, `${pat} should have no second octave`); continue; }
    eq(e.double.pcs.length, double, `${pat} double length`);
    for (let i = 0; i < b; i++)
      eq(e.single.pcs[i], e.double.pcs[i], `${pat} prefix differs at ${i}`);
    ok(e.single.pcs[b] !== e.double.pcs[b], `${pat} does not diverge at ${b}`);
    // Colour is how you know which octave you committed to; thirds and in3s
    // shipped a 57-note run that looked exactly like the 29-note one. The
    // second octave starts one index before the fork, since the octave note
    // is the last one both paths share.
    ok(e.double.phases[0] === "up2", `${pat} root pill is not part of the ascent`);
    eq(e.double.phases.indexOf("up2", 1), b - 1, `${pat} second octave starts late`);
    ok(!e.single.phases.includes("up2"), `${pat} one-octave run claims a second octave`);
    e.double.pcs.forEach((pc, i) => eq((e.double.steps[i] % 12 + 12) % 12, pc,
      `${pat} double step ${e.double.steps[i]} at ${i} is not the pitch played`));
    leapOk(e.double);
    eq(top(e.double) - top(e.single), 12, `${pat} two-octave ascent tops out wrong`);
    const arp = e.double.steps.filter((_, i) => e.double.phases[i] === "arp");
    if (arp.length) eq(Math.max(...arp), top(e.double), `${pat} two-octave arpeggio stops short`);
  }
});

check("transposition moves the pitches, not the written names", () => {
  const plain = api.buildExpected("C Major", 0, "scale");
  const horn = api.buildExpected("C Major", -2, "scale");   // B♭ instrument
  eq(horn.displayNames, plain.displayNames, "written names should not shift");
  eq(horn.single.pcs, plain.single.pcs.map(pc => (pc + 10) % 12), "concert pitches");
  eq(horn.single.slots, plain.single.slots, "slots should not shift");
});

// ----------------------------------------------------------------- matcher

check("a correct run completes, keeps its cents, and ignores strays", () => {
  const e = api.buildExpected("D Major", 0, "scale");
  let done = false;
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() { done = true; } });
  for (const pc of e.single.pcs) m.input(pc, 7);
  ok(done, "onSuccess never fired");
  eq(m.cents.length, e.single.pcs.length, "cents recorded");
  ok(m.cents.every(c => c === 7), "cents preserved");
  const m2 = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 3; i++) m2.input(e.single.pcs[i], 0);
  m2.input((e.single.pcs[0] + 1) % 12, 0);
  eq(m2.matchIdx, 3, "a stray note disturbed progress");
});

check("a backward note arms a rewind, and playing on cancels it", () => {
  const e = api.buildExpected("D Major", 0, "scale");
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 4; i++) m.input(e.single.pcs[i], 0, 60 + e.single.steps[i]);
  ok(!api.pendingRewind.active, "a forward run armed a rewind");
  m.input(e.single.pcs[1], 0, 60 + e.single.steps[1]);   // back to the second note
  ok(api.pendingRewind.active, "going backward armed no rewind");
  m.input(e.single.pcs[4], 0, 60 + e.single.steps[4]);   // played through
  ok(!api.pendingRewind.active, "a pending rewind was not cancelled");
});

check("the second octave is chosen at the branch", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const play = next => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < e.branchIdx; i++) m.input(e.single.pcs[i], 0);
    m.input(next, 0);
    return m.path;
  };
  eq(play(e.single.pcs[e.branchIdx]), "single", "single path");
  eq(play(e.double.pcs[e.branchIdx]), "double", "double path");
});

// Pitch classes alone cannot tell the root from the octave above it: playing
// the 8 after the 6 read as the 1 and rewound the run to the bottom.
check("register decides what counts as going backward", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const upToSixth = () => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < 6; i++) m.input(e.single.pcs[i], 0, 60 + e.single.steps[i]);
    eq(m.matchIdx, 6, "did not reach the sixth");
    return m;
  };
  upToSixth().input(e.single.pcs[0], 0, 72);   // the root, an octave up
  ok(!api.pendingRewind.active, "the octave above the root armed a rewind to the bottom");
  upToSixth().input(e.single.pcs[0], 0, 60);   // the root they actually played
  ok(api.pendingRewind.active, "a genuine return to the root no longer rewinds");
  api.pendingRewind.cancel();
});

// ----------------------------------------------------------------- tracker

check("the gate adapts to the room", () => {
  const t = new api.NoteTracker(() => {});
  const floor = 0.0012;
  for (let i = 0; i < 400; i++) t.process(floor, -1, i * 16);
  eq(t.noiseFloor.toFixed(5), floor.toFixed(5), "floor did not converge on ambient");
  // Literal on purpose: deriving it would move with the constants it guards.
  eq(t.rmsOn.toFixed(4), "0.0216", "gate is not floor x onRatio x boost");
  // A laptop mic hears more of the room, so it must demand more signal.
  const quiet = boot({ hover: false });
  const q = new quiet.NoteTracker(() => {});
  for (let i = 0; i < 400; i++) q.process(floor, -1, i * 16);
  ok(t.rmsOn > q.rmsOn, "desktop gate should exceed touch");
});

check("a pitch counts only once it is stable", () => {
  const heard = [];
  const t = new api.NoteTracker(pc => heard.push(pc));
  const tone = midi => 440 * Math.pow(2, (midi - 69) / 12);
  t.process(0.2, tone(69));                    // one frame is not enough
  eq(heard.length, 0, "a single frame counted as a note");
  t.process(0.2, tone(69));
  eq(heard, [9], "a stable pitch did not register");
  t.process(0.2, tone(69));
  eq(heard, [9], "a held note fired twice");
  eq(t.state, "playing", "never left silence");
  t.process(0.0001, tone(69));
  eq(t.state, "silent", "release gate never fired");
});

check("pitch detection spans the advertised range", () => {
  const tone = (freq, rate, n) => {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      buf[i] = 0.5 * Math.sin(2 * Math.PI * freq * t)
             + 0.3 * Math.sin(4 * Math.PI * freq * t)
             + 0.15 * Math.sin(6 * Math.PI * freq * t);
    }
    return buf;
  };
  for (const rate of [44100, 48000])
    for (const f of [41, 55, 82, 110, 165, 262, 440, 880, 1319]) {
      const { freq } = api.autoCorrelate(tone(f, rate, 2048), rate);
      ok(freq > 0, `${f}Hz @${rate} not detected`);
      const cents = Math.abs(1200 * Math.log2(freq / f));
      ok(cents < 50, `${f}Hz @${rate} off by ${cents.toFixed(0)} cents`);
    }
  ok(api.autoCorrelate(tone(30, 48000, 2048), 48000).freq < 0, "sub-range tone accepted");
});

// ------------------------------------------------------------- persistence

check("storage tolerates unknown and corrupt values", () => {
  // An unrecognised mode id used to throw during init and blank the page.
  const a = boot({ storage: { "scales-weights-v1": JSON.stringify({ Major: 1, Aeolian: 1 }) } });
  const w = a.weightsStore.load();
  ok(!("Aeolian" in w), "unknown mode survived the load");
  eq(a.buildUnlimitedList(w).length, 15, "major-only session");
  for (const bad of ["not json", "[1,2,3]", "null"])
    boot({ storage: { "scales-weights-v1": bad, "scales-patterns-v2": bad } });
});

// ----------------------------------------------------------------- session

await checkAsync("a completed scale records its intonation", async () => {
  const clock = { t: 0 };
  const a = boot({ clock });
  const m = a.matcher;
  ok(m, "no matcher after boot");
  const pcs = m.expected.single.pcs;
  // One note could be noise; the second correct one starts the clock.
  m.input(pcs[0], 11);
  m.input(pcs[1], 11);
  eq(a.state, "playing", "a second correct note did not start the run");
  clock.t = 11_000;   // past MIN_SCALE_MS
  for (let i = 2; i < pcs.length; i++) m.input(pcs[i], 11);
  await new Promise(r => setTimeout(r, 700));
  const rec = a.times[0];
  ok(rec, "nothing was recorded");
  ok(typeof rec.cents === "number", `cents recorded as ${rec.cents}`);
  eq(Math.round(rec.cents), 11, "cents value");
  // Patterns are drawn per scale and differ ~2x in length, so a time without
  // one is uncomparable. It went missing once already.
  ok(rec.pattern, "no pattern recorded alongside the time");
});

await checkAsync("runs that cannot have been played are not recorded", async () => {
  // Faster than anyone plays a scale and an arpeggio: a spurious match.
  const clock = { t: 0 };
  const a = boot({ clock });
  const pcs = a.matcher.expected.single.pcs;
  a.matcher.input(pcs[0], 5);
  a.matcher.input(pcs[1], 5);
  clock.t = 4_000;                            // well under MIN_SCALE_MS
  for (let i = 2; i < pcs.length; i++) a.matcher.input(pcs[i], 5);
  await new Promise(r => setTimeout(r, 700));
  eq(a.times.length, 0, "an impossibly fast run was recorded");

  // A skip however long it took: timing a keypress isn't timing the playing.
  const c2 = { t: 0 };
  const b = boot({ clock: c2 });
  b.matcher.input(b.matcher.expected.single.pcs[0], 0);
  b.matcher.input(b.matcher.expected.single.pcs[1], 0);
  c2.t = 60_000;
  b.completeCurrent();
  eq(b.times.length, 0, "a manual advance was counted as a result");
});
// --------------------------------------------------------------- wake lock

// The phone dims mid-run because nobody touches the screen while playing. The
// lock must span the whole run and no more: taken once at the downbeat (a
// second request leaks a lock nothing will ever release) and dropped at the end.
await checkAsync("the screen lock spans the run and nothing else", async () => {
  const log = [];
  const settle = () => new Promise(r => setTimeout(r, 20));
  const wakeLock = { request: async () => {
    log.push("acquire");
    return { release: async () => { log.push("release"); }, addEventListener() {} };
  } };

  const a = boot({ wakeLock });
  await settle();
  eq(log.join(","), "", "a lock was taken on the options screen");

  const pcs = a.matcher.expected.single.pcs;
  a.matcher.input(pcs[0], 0);
  a.matcher.input(pcs[1], 0);   // the second correct note starts the run
  await settle();
  eq(a.state, "playing", "the run did not start");
  eq(log.join(","), "acquire", "no lock was held for the run");

  // Auto-advance re-renders on every scale; none of those may re-request.
  while (a.state !== "done") { a.completeCurrent(); await settle(); }
  eq(log.join(","), "acquire,release", "lock not held exactly once across the run");
});

// ---------------------------------------------------------------- report

for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
