// Regression tests for index.html.  Run: node test.mjs
//
// Every assertion covers something that actually broke. The whole <script>
// runs in one vm against a stub DOM, so the suite survives reordering and
// "the app boots" is itself covered.

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
      useFlats, chordName, scaleContext, patterns,
      intervalSeg, groupSeg, Matcher, NoteTracker, TRACKER, hearsNext,
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
  // A doubled pitch is invisible to the tracker unless it is released and
  // struck again, so every repeat has to be skippable or the run stalls.
  for (const pat of ["scale", "thirds", "in3s"])
    for (const which of ["single", "double"]) {
      const p = api.buildExpected("C Major", 0, pat)[which];
      const at = p.pcs.findIndex((v, i) => i > 0 && v === p.pcs[i - 1] && !p.optional[i]);
      ok(at < 0, `${pat}/${which} repeats a pitch at ${at} with no way through`);
    }
});

check("the turnaround may be restruck or slurred through", () => {
  const e = api.buildExpected("C Major", 0, "thirds");
  const at = e.single.optional.findIndex(Boolean);
  eq(e.single.pcs[at], e.single.pcs[at - 1], "the turnaround is not a repeated pitch");
  const run = slur => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < at; i++) m.input(e.single.pcs[i], 5);
    if (!slur) m.input(e.single.pcs[at], 5);   // strike the top note again...
    m.input(e.single.pcs[at + 1], 5);          // ...or carry straight on down
    return m;
  };
  eq(run(false).matchIdx, at + 2, "restriking the turnaround did not advance");
  eq(run(true).matchIdx, at + 2, "slurring through the turnaround did not advance");
  // A note nobody played scores no intonation and owes no hold time.
  eq(run(true).cents[at], "null", "a slurred note was scored");
  eq(run(false).cents[at], 5, "a restruck note was not scored");
});

check("single and double paths diverge only at the branch", () => {
  for (const [pat, single, double] of [["scale",21,45], ["thirds",30,58], ["in3s",44,86]]) {
    const e = api.buildExpected("C Major", 0, pat), b = e.branchIdx;
    eq(e.single.pcs.length, single, `${pat} single length`);
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
    // Steps carry the register the pitch classes throw away. They must agree
    // with the pitches, start on the root, and the two-octave form has to
    // reach exactly one octave higher than the one-octave form.
    for (const w of ["single", "double"]) {
      const p = e[w];
      p.pcs.forEach((pc, i) => eq((p.steps[i] % 12 + 12) % 12, pc,
        `${pat}/${w} step ${p.steps[i]} at ${i} is not the pitch played`));
      eq(p.steps[0], 0, `${pat}/${w} does not start on the root`);
      // Nothing here leaps further than a fifth; a jump past an octave means
      // some entry lost the register it was built in.
      p.steps.forEach((s, i) => ok(i === 0 || Math.abs(s - p.steps[i - 1]) <= 12,
        `${pat}/${w} leaps ${Math.abs(s - p.steps[i - 1])} semitones at ${i}`));
    }
    const top = p => Math.max(...p.steps.filter((_, i) => p.phases[i].startsWith("up")));
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

await checkAsync("a backward note rewinds, unless you play on", async () => {
  const e = api.buildExpected("D Major", 0, "scale");
  const settle = () => new Promise(r => setTimeout(r, api.TRACKER.holdMs + 80));

  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 4; i++) m.input(e.single.pcs[i], 0);
  m.input(e.single.pcs[1], 0);                  // back to the second note
  eq(m.matchIdx, 4, "rewound before the hold elapsed");
  await settle();
  eq(m.matchIdx, 2, "did not rewind once the hold elapsed");
  eq(m.cents.length, 2, "cents not truncated with the rewind");

  // Carrying on cancels it, so a stray played through never costs progress.
  const m2 = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  for (let i = 0; i < 4; i++) m2.input(e.single.pcs[i], 0);
  m2.input(e.single.pcs[1], 0);                 // arms a rewind
  m2.input(e.single.pcs[4], 0);                 // ...which this supersedes
  await settle();
  eq(m2.matchIdx, 5, "a pending rewind was not cancelled");
});

await checkAsync("the second octave is chosen at the branch, and rechosen", async () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const upTo = next => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < e.branchIdx; i++) m.input(e.single.pcs[i], 0);
    m.input(next, 0);
    return m;
  };
  eq(upTo(e.single.pcs[e.branchIdx]).path, "single", "single path");
  const m = upTo(e.double.pcs[e.branchIdx]);
  eq(m.path, "double", "double path");
  // Rewinding behind the fork reopens it, or a flub locks in the octave count.
  m.input(e.double.pcs[0], 0);
  await new Promise(r => setTimeout(r, api.TRACKER.holdMs + 80));
  eq(m.matchIdx, e.branchIdx, "rewound to the wrong place");
  ok(m.path === null, "the committed path outlived the rewind");
});

// Pitch classes alone cannot tell the root from the octave above it: playing
// the 8 after the 6 used to read as the 1 and rewind the run to the bottom.
await checkAsync("register decides what counts as going backward", async () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const settle = () => new Promise(r => setTimeout(r, api.TRACKER.holdMs + 80));
  const upToSixth = () => {
    const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
    for (let i = 0; i < 6; i++) m.input(e.single.pcs[i], 0, 60 + e.single.steps[i]);
    return m;
  };
  const up = upToSixth();
  eq(up.matchIdx, 6, "did not reach the sixth");
  up.input(e.single.pcs[0], 0, 72);      // the root, an octave above where it started
  await settle();
  eq(up.matchIdx, 6, "the octave above the root rewound the run to the bottom");

  const back = upToSixth();
  back.input(e.single.pcs[0], 0, 60);    // the root they actually played
  await settle();
  eq(back.matchIdx, 1, "a genuine return to the root no longer rewinds");
});

check("the second octave can be abandoned mid-climb", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  let done = false;
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() { done = true; } });
  const play = i => m.input(e.double.pcs[i], 0, 60 + e.double.steps[i]);
  for (let i = 0; i <= e.branchIdx + 2; i++) play(i);
  eq(m.path, "double", "did not commit to two octaves");
  ok(e.double.steps[m.matchIdx] > 12, "not actually up in the second octave");

  m.input(e.single.pcs[e.branchIdx - 1], 0, 72);   // back down to the octave
  eq(m.path, "single", "turning back did not drop to one octave");
  eq(m.matchIdx, e.branchIdx, "rejoined the one-octave path in the wrong place");
  eq(m.cents.length, e.branchIdx, "cents kept notes from the abandoned octave");

  for (let i = e.branchIdx; i < e.single.pcs.length; i++)
    m.input(e.single.pcs[i], 0, 60 + e.single.steps[i]);
  ok(done, "the abandoned run never completed as a one-octave run");
});

check("the expected note previews before it locks in", () => {
  const e = api.buildExpected("C Major", 0, "scale");
  const m = new api.Matcher(e, { onProgress() {}, onSuccess() {} });
  ok(api.hearsNext(m, 60), "the first note does not preview");
  ok(!api.hearsNext(m, 61), "a wrong pitch previews");
  eq(m.matchIdx, 0, "previewing advanced the run");
  m.input(e.single.pcs[0], 0, 60);
  ok(api.hearsNext(m, 62), "the second note does not preview");
  ok(!api.hearsNext(m, 74), "previewed a pitch an octave out of register");
  // At the top the octave and the root share a pitch class.
  for (let i = 1; i < 7; i++) m.input(e.single.pcs[i], 0, 60 + e.single.steps[i]);
  ok(api.hearsNext(m, 72), "the octave does not preview at the top");
  ok(!api.hearsNext(m, 60), "the root previewed as the octave");
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

check("only sustained pitches count", () => {
  const sweep = (fn, frames, midiAt) => {
    const heard = [];
    const t = new api.NoteTracker(pc => heard.push(pc));
    for (let i = 0; i < frames; i++)
      t.process(0.2, 440 * Math.pow(2, (midiAt(i) - 69) / 12), i * 16);
    fn(heard, t);
    return t;
  };
  // 80ms per semitone: a slow slide, and only just under the 100ms hold.
  sweep(h => eq(h.length, 0, `gliss produced ${h.length} notes: ${h}`),
        65, i => 60 + Math.floor(i / 5));
  sweep((h, t) => { eq(h, [9], "A should fire once"); eq(t.state, "playing", "never left silence"); },
        120, () => 69);
  sweep(h => eq(h, [0, 2, 4, 5, 7], "held notes out of order"),
        200, i => [60, 62, 64, 65, 67][Math.floor(i / 40)]);
  const t = new api.NoteTracker(() => {});
  for (let i = 0; i < 40; i++) t.process(0.2, 440, i * 16);
  eq(t.state, "playing", "note never registered");
  t.process(0.0001, 440, 700);
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
  m.input(pcs[0], 11);
  eq(a.state, "playing", "run did not start on the first note");
  // Just past the derived floor, so this fails if it drifts either way.
  clock.t = 21 * api.TRACKER.holdMs;
  for (let i = 1; i < pcs.length; i++) m.input(pcs[i], 11);
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
  // Faster than every note could have been held: a spurious match.
  const clock = { t: 0 };
  const a = boot({ clock });
  const pcs = a.matcher.expected.single.pcs;
  a.matcher.input(pcs[0], 5);
  clock.t = 10 * api.TRACKER.holdMs;          // half the notes' worth of time
  for (let i = 1; i < pcs.length; i++) a.matcher.input(pcs[i], 5);
  await new Promise(r => setTimeout(r, 700));
  eq(a.times.length, 0, "an impossibly fast run was recorded");

  // A skip however long it took: timing a keypress isn't timing the playing.
  const c2 = { t: 0 };
  const b = boot({ clock: c2 });
  b.matcher.input(b.matcher.expected.single.pcs[0], 0);
  c2.t = 60_000;
  b.completeCurrent();
  eq(b.times.length, 0, "a manual advance was counted as a result");
});
// ---------------------------------------------------------------- report

for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
