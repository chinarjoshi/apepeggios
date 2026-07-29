// ===== Audio =====
// Tuner: fixed 120x140 viewBox; the letter sits in a masked circle at (cx, baselineY).
// prettier-ignore
const TUNER = {
  width: 120, height: 140,
  cx: 60, baselineY: 70, maskRadius: 22, arcLeft: 12, arcRight: 108,
  maxCents: 40,          // arc saturates here
  bendPerCent: 2.0,      // control-point rise per cent sharp
  smoothing: 0.28,       // EMA weight on each new reading
  redAtCents: 30,        // |cents| where the color reaches full red
  inTune: [141, 216, 141],      // keep in sync with --good
  outOfTune: [255, 107, 107],   // keep in sync with --bad
};
const FLAT_ARC = `M ${TUNER.arcLeft} ${TUNER.baselineY} Q ${TUNER.cx} ${TUNER.baselineY} ${TUNER.arcRight} ${TUNER.baselineY}`;

function tuningArcPath(cents) {
  const c = Math.max(-TUNER.maxCents, Math.min(TUNER.maxCents, cents));
  const controlY = TUNER.baselineY - c * TUNER.bendPerCent;
  return `M ${TUNER.arcLeft} ${TUNER.baselineY} Q ${TUNER.cx} ${controlY.toFixed(1)} ${TUNER.arcRight} ${TUNER.baselineY}`;
}
function centsToColor(cents) {
  const t = Math.min(Math.abs(cents), TUNER.redAtCents) / TUNER.redAtCents;
  const rgb = TUNER.inTune.map((from, i) => Math.round(from + (TUNER.outOfTune[i] - from) * t));
  return `rgb(${rgb.join(",")})`;
}

let micError = "";

let audioCtx = null,
  analyser = null,
  mediaStream = null,
  audioBuf = null;
let noteTracker = null;
let smoothedCents = 0;
const HOLD_MS = 500;
function holdTimer(ms, onFire) {
  let timer = null;
  return {
    arm(data) {
      this.cancel();
      timer = setTimeout(() => {
        timer = null;
        onFire(data);
      }, ms);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get active() {
      return timer !== null;
    },
  };
}
// Populated once state/matcher globals are defined below.
let pendingStart, pendingRewind;

// Processing only hurts pitch detection, so raw audio is a hard requirement:
// a browser that won't give it gets no mic.
const RAW_AUDIO = {
  echoCancellation: { exact: false },
  noiseSuppression: { exact: false },
  autoGainControl: { exact: false },
};

let micPending = false;

// The stream is safe to request anywhere; the AudioContext is not — iOS
// returns a silent graph unless it is built inside a user gesture.
async function requestMic() {
  if (mediaStream || micPending) return !!mediaStream;
  micPending = true;
  try {
    if (!window.isSecureContext) throw new Error("needs https");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no getUserMedia");
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO });
    micError = "";
    return true;
  } catch (e) {
    micError = e.name === "OverconstrainedError" ? "raw audio refused" : e.message || e.name;
    setMicStatus(false);
    return false;
  } finally {
    micPending = false;
  }
}

function startAudioGraph() {
  if (audioCtx || !mediaStream) return false;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  audioBuf = new Float32Array(analyser.fftSize);
  audioCtx.resume?.();
  setMicStatus(true);
  detectLoop();
  return true;
}

async function initMic() {
  if (!(await requestMic())) return false;
  return audioCtx ? true : startAudioGraph();
}

async function resumeAudioIfNeeded() {
  if (audioCtx && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {}
  }
}
function setMicStatus(on) {
  const el = document.getElementById("mic-warn");
  if (!el) return;
  el.classList.toggle("hidden", on);
  el.textContent = micError ? "mic off" : "unmute mic";
  el.title = micError ? `mic: ${micError}` : "";
}
function detectLoop() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(audioBuf);
  const { freq, rms } = autoCorrelate(audioBuf, audioCtx.sampleRate);
  const active = state === "playing" || state === "ready";
  if (noteTracker && active) noteTracker.process(rms, freq);
  if (micDebug && noteTracker) {
    // Same width as a reading, so dropping in and out doesn't resize the line.
    const hz = (freq > 0 ? freq.toFixed(0) + "hz" : "-----").padStart(6);
    micDebug.textContent =
      `rms ${rms.toFixed(4)} gate ${noteTracker.rmsOn.toFixed(4)}` +
      ` floor ${(noteTracker.noiseFloor ?? 0).toFixed(4)} ${hz}`;
  }
  if (active) renderTuner(freq, rms);
  requestAnimationFrame(detectLoop);
}

function renderTuner(freq, rms) {
  const heardEl = document.getElementById("heard");
  if (!heardEl || !scales[index]) return;
  const textEl = heardEl.querySelector(".heard-text");
  const arcEl = heardEl.querySelector(".tuning-arc");
  // Follows the live signal, not the confirmed note: you should see the pitch
  // the instant you sound it, even though it takes a
  // full hold before it counts as played.
  const sounding = freq > 0 && rms >= (noteTracker?.rmsOn ?? Infinity) * TRACKER.offRatio;
  if (!sounding) {
    if (textEl) {
      textEl.textContent = "—";
      textEl.style.fill = "";
    }
    smoothedCents = 0;
    if (arcEl) {
      arcEl.setAttribute("d", FLAT_ARC);
      arcEl.style.stroke = "";
    }
    return;
  }
  const t = transpositions[transposition] || 0;
  const writtenPc = pcMod(freqToPC(freq) - t);
  const nameMap = currentMatcher?.expected.writtenByPc || {};
  textEl.textContent = nameMap[writtenPc] || noteName(writtenPc, useFlats(scales[index]));
  smoothedCents += (freqToCents(freq) - smoothedCents) * TUNER.smoothing;
  const color = centsToColor(smoothedCents);
  textEl.style.fill = color;
  if (arcEl) {
    arcEl.setAttribute("d", tuningArcPath(smoothedCents));
    arcEl.style.stroke = color;
  }
}

// ===== App state =====
// Everything skips by tap or click; touch just has no key to name in the hint.
const isTouch = () => !window.matchMedia("(hover: hover)").matches;
const restartHint = () => `<strong>${isTouch() ? "tap" : "click"}</strong> to restart`;

const DEBUG =
  location.hostname !== "apepeggios.com" || new URLSearchParams(location.search).has("debug");
const app = document.getElementById("app");
const micDebug = DEBUG ? document.getElementById("mic-debug") : null;
if (!DEBUG) document.getElementById("mic-debug")?.remove();
let scales, times, state, scaleStart, index;
let skipped = 0;
let lastSession = null; // the session just finished, or null if nothing counted
let currentMatcher = null;
let weights = weightsStore.load();
let transposition = transpositionStore.load();
let activePatterns = patternsStore.load();
let currentPattern = activePatterns[0];
let currentNotation = NOTATIONS[0];
function pickPattern() {
  if (!activePatterns.length) return null; // all off — same as all modes off
  return pick(activePatterns);
}
function pickNotation() {
  return pick(NOTATIONS);
}

function fmt(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(2) + "s";
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}m ${rem}s`;
}

function resetSession() {
  times = [];
  skipped = 0;
  index = 0;
  repick();
  scales = buildUnlimitedList(weights);
  fitChordSize();
}

// Size to the widest name the app can ever produce, not just the ones in this
// session, so toggling a mode never resizes the display mid-use.
const CHORD_MAX_PX = 88; // phones
const CHORD_MAX_PX_WIDE = 124; // roomier screens
// Canvas needs the stack as a string; must match --mono.
const CHORD_FONT = '700 %dpx ui-monospace, "SF Mono", Menlo, monospace';
const LONGEST_CHORD = Object.keys(keySharpsMajor)
  .flatMap(key => MODES.flatMap(m => NOTATIONS.map(n => key + m.chord[n])))
  .reduce((a, b) => (b.length > a.length ? b : a), "");
let measureCtx = null;

function fitChordSize() {
  const longest = LONGEST_CHORD;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const avail = document.documentElement.clientWidth - 24;
  const cap = avail > 620 ? CHORD_MAX_PX_WIDE : CHORD_MAX_PX;
  measureCtx.font = CHORD_FONT.replace("%d", cap);
  const needed = measureCtx.measureText(longest).width;
  const px = needed > avail ? Math.floor((cap * avail) / needed) : cap;
  document.documentElement.style.setProperty("--scale-size", px + "px");
}

function start() {
  resetSession();
  state = "ready";
  render();
}

// Only while a run is under way; one chain so overlapping calls cannot double-request.
let wakeLock = null;
let wakeQueue = Promise.resolve();
function updateWakeLock() {
  if (!navigator.wakeLock) return;
  wakeQueue = wakeQueue
    .then(async () => {
      const want = state === "playing" && document.visibilityState !== "hidden";
      if (want === !!wakeLock) return;
      if (want) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      } else {
        const held = wakeLock;
        wakeLock = null;
        await held.release();
      }
    })
    .catch(() => {
      wakeLock = null;
    }); // refused, or released underneath us
}

function render() {
  updateWakeLock();
  if (state === "done") return renderResults();
  renderStage(); // handles both "ready" and "playing"
}

// True when there's nothing to practice because a whole toggle row is off.
function nothingSelected() {
  return !scales[index] || !currentPattern;
}
function emptyStateLabel() {
  const missing = [];
  if (!scales[index]) missing.push("modes");
  if (!currentPattern) missing.push("patterns");
  return `no ${missing.join(" or ")} on`;
}

// Returns { html, exp } — exp is null when there is nothing to practise.
function playAreaHTML(scaleName) {
  // Mirror the real layout's structure so toggling the last one off doesn't resize the page.
  if (nothingSelected())
    return {
      exp: null,
      html: `
    <div class="scale-title">
      <div class="scale">&nbsp;</div>
      <div class="mode-label">${emptyStateLabel()}</div>
      <div class="mode-label">&nbsp;</div>
    </div>
    <div class="sequence"><span class="note placeholder"></span></div>
    <div class="heard"></div>
  `,
    };
  const exp = buildExpected(scaleName, transpositions[transposition] || 0, currentPattern);
  const seq = exp.displayNames
    .map((name, i) => `<span class="note" data-slot="${i}" data-full="${name}"></span>`)
    .join("");
  // Always rendered, mic or not, so enabling the mic doesn't reflow the page.
  const heardHTML = `
    <div class="heard" id="heard">
      <svg viewBox="0 0 ${TUNER.width} ${TUNER.height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <mask id="letter-mask">
            <rect fill="white" width="${TUNER.width}" height="${TUNER.height}"/>
            <circle fill="black" cx="${TUNER.cx}" cy="${TUNER.baselineY}" r="${TUNER.maskRadius}"/>
          </mask>
        </defs>
        <path class="tuning-arc" d="${FLAT_ARC}" mask="url(#letter-mask)"/>
        <text class="heard-text" x="${TUNER.cx}" y="${TUNER.baselineY + 8}" text-anchor="middle">—</text>
      </svg>
    </div>
  `;
  return {
    exp,
    html: `
    <div class="scale-title">
      <div class="scale">${chordName(scaleName, currentNotation)}</div>
      <div class="mode-label">${displayMode(modeOf(scaleName))}</div>
      <div class="mode-label">${patternLabels[currentPattern]}</div>
    </div>
    <div class="sequence" id="sequence">${seq}</div>
    ${heardHTML}
  `,
  };
}

function renderStage() {
  const play = playAreaHTML(scales[index]);
  const transposeButtons = Object.keys(transpositions)
    .map(
      t =>
        `<button class="${t === transposition ? "selected" : ""}" data-trans="${t}">${t}</button>`,
    )
    .join("");
  const patternButtons = patternOptions
    .map(
      p =>
        `<button class="${activePatterns.includes(p) ? "selected" : ""}" data-pattern="${p}">${patternLabels[p]}</button>`,
    )
    .join("");
  const modeButtons = MODES.map(
    m =>
      `<button class="${weights[m.id] > 0 ? "selected" : ""}" data-mode-toggle="${m.id}">${m.short}</button>`,
  ).join("");

  const playing = state === "playing";
  app.innerHTML = `
    <div class="stage">
      <div class="play-area">${play.html}</div>
      <div class="swap widgets-bottom">
        <div class="layer ${playing ? "faded" : ""}">
          <div class="option-bar mode-toggles" id="mode-toggles">
            <span class="option-icon icon-sun" aria-hidden="true" title="brightest">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>
            </span>
            ${modeButtons}
            <span class="option-icon icon-moon" aria-hidden="true" title="darkest">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 15.5A8 8 0 0 1 9 5a7 7 0 1 0 11 10.5z"/></svg>
            </span>
          </div>
          <div class="widget-row">
            <div class="option-bar" id="pattern-radio"><span class="option-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="currentColor"><ellipse cx="5" cy="15" rx="2.5" ry="1.8"/><ellipse cx="14" cy="13" rx="2.5" ry="1.8"/><rect x="7" y="4" width="1.2" height="11"/><rect x="16" y="2" width="1.2" height="11"/><path d="M8 4.5 L17 2.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
            </span>${patternButtons}</div>
            <div class="option-bar" id="transpose-radio"><span class="option-icon icon-clef" aria-hidden="true">𝄞</span>${transposeButtons}</div>
          </div>
        </div>
        <div class="layer ${playing ? "" : "faded"}">
          <div class="stats" style="--count-w: ${String(scales.length).length}ch">
            <span class="stat-count"><strong>${index + 1}</strong> / ${scales.length}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  setupMatcher(play.exp);
  updateSequenceUI();
  attachReadyHandlers();
}

function repick() {
  currentPattern = pickPattern();
  currentNotation = pickNotation();
}

// Toggle any of N: `flip` mutates state and reports the button's new state.
function bindToggles(id, attr, flip) {
  document.querySelectorAll(`#${id} button`).forEach(btn =>
    btn.addEventListener("click", e => {
      e.currentTarget.classList.toggle("selected", flip(e.currentTarget.dataset[attr]));
      refreshPlayArea();
    }),
  );
}

function attachReadyHandlers() {
  const transposeButtons = document.querySelectorAll("#transpose-radio button");
  transposeButtons.forEach(btn =>
    btn.addEventListener("click", e => {
      transposition = e.currentTarget.dataset.trans;
      transpositionStore.save(transposition);
      transposeButtons.forEach(b => b.classList.toggle("selected", b === e.currentTarget));
      refreshPlayArea();
    }),
  );
  bindToggles("pattern-radio", "pattern", p => {
    const i = activePatterns.indexOf(p);
    if (i >= 0) activePatterns.splice(i, 1);
    else activePatterns.push(p);
    patternsStore.save(activePatterns);
    repick();
    return activePatterns.includes(p);
  });
  bindToggles("mode-toggles", "modeToggle", m => {
    weights[m] = weights[m] > 0 ? 0 : 1;
    weightsStore.save(weights);
    resetSession();
    return weights[m] > 0;
  });
}

function refreshPlayArea() {
  const playArea = document.querySelector(".play-area");
  if (!playArea) return;
  const play = playAreaHTML(scales[index]);
  playArea.innerHTML = play.html;
  setupMatcher(play.exp);
  updateSequenceUI();
}

function setupMatcher(exp) {
  noteTracker?.reset();
  pendingStart.cancel();
  if (!exp) {
    currentMatcher = null;
    return;
  }
  currentMatcher = new Matcher(exp, {
    onProgress() {
      updateSequenceUI();
      if (state !== "ready") return;
      // One note could be noise, so wait for a sustain; a second correct note
      // is proof enough on its own.
      if (currentMatcher.matchIdx === 1) pendingStart.arm(exp.single.pcs[0]);
      else {
        pendingStart.cancel();
        beginPlaying();
      }
    },
    onSuccess: onSequenceComplete,
  });
}

// Defined here so they close over updateSequenceUI / beginPlaying.
pendingStart = holdTimer(HOLD_MS, pc => {
  if (noteTracker?.state === "playing" && noteTracker.currentPC === pc) beginPlaying();
});
pendingRewind = holdTimer(HOLD_MS, ({ pc, rewindTo, cents }) => {
  if (!currentMatcher) return;
  if (noteTracker?.state === "playing" && noteTracker.currentPC === pc) {
    currentMatcher.cents.length = rewindTo;
    currentMatcher.cents[rewindTo - 1] = cents;
    currentMatcher.matchIdx = rewindTo;
    // Back before the fork, so the octave count is open again.
    if (rewindTo <= currentMatcher.expected.branchIdx) currentMatcher.path = null;
    updateSequenceUI();
  }
});

function beginPlaying() {
  if (state !== "ready" || nothingSelected()) return;
  resumeAudioIfNeeded();
  const now = performance.now();
  scaleStart = now;
  state = "playing";
  updateWakeLock(); // this transition never goes through render()
  // Cross-fade the option layers out and the play layers in; nothing moves.
  document.querySelectorAll(".swap").forEach(swap => {
    swap.querySelectorAll(".layer").forEach(l => l.classList.toggle("faded"));
  });
}

function updateSequenceUI() {
  if (!currentMatcher) return;
  const matchIdx = currentMatcher.matchIdx;
  const path = currentMatcher.currentPath();
  document.querySelectorAll(".sequence .note").forEach(n => {
    n.classList.remove("phase-up", "phase-up2", "phase-down", "phase-arp", "current");
    // Rewinding must hide the names again, not just drop the colour.
    if (n.dataset.full) n.textContent = "";
  });
  for (let i = 0; i < matchIdx; i++) {
    const slot = path.slots[i];
    if (slot === undefined) continue;
    const el = document.querySelector(`.sequence .note[data-slot="${slot}"]`);
    if (!el) continue;
    const phase = getPhaseAt(i, matchIdx, path);
    el.classList.add(`phase-${phase}`);
    if (el.dataset.full) el.textContent = el.dataset.full;
  }
  if (matchIdx < path.pcs.length) {
    const slot = path.slots[matchIdx];
    if (slot !== undefined) {
      const el = document.querySelector(`.sequence .note[data-slot="${slot}"]`);
      if (el) el.classList.add("current");
    }
  }
}

// Held across the success hold so that advancing by hand during it still
// records the run — the playing already happened.
let pendingCents = null;

function onSequenceComplete() {
  pendingCents = currentMatcher?.cents ?? [];
  currentMatcher = null;
  const scaleEl = document.querySelector(".scale");
  if (scaleEl) scaleEl.classList.add("success");
  document.querySelectorAll(".sequence .note").forEach(n => n.classList.remove("current"));
  advanceTimer = setTimeout(completeCurrent, SUCCESS_HOLD_MS);
}

let advanceTimer = null;
// Pending cents mean the tracker matched the whole sequence. None means a
// manual advance: a skip however long it took, since nothing verified it.
function completeCurrent() {
  // A keypress during the success hold would otherwise advance twice.
  clearTimeout(advanceTimer);
  advanceTimer = null;
  const cents = pendingCents;
  pendingCents = null;
  const now = performance.now();
  const cList = cents ? cents.filter(c => typeof c === "number") : [];
  if (cents && now - scaleStart >= MIN_SCALE_MS) {
    times.push({
      scale: scales[index],
      ms: now - scaleStart,
      pattern: currentPattern, // randomised per scale, so times only compare within one
      cents: cList.length ? mean(cList.map(Math.abs)) : null,
    });
  } else {
    skipped++;
  }
  scaleStart = now;
  index++;
  repick();
  if (index >= scales.length) {
    state = "done";
    recordSession();
  }
  render();
}

function recordSession() {
  if (times.length === 0) {
    lastSession = null;
    return;
  } // all skipped — nothing to save
  const total = times.reduce((s, t) => s + t.ms, 0);
  const cList = times.map(t => t.cents).filter(c => typeof c === "number");
  const avgCents = cList.length ? mean(cList) : null;
  const session = {
    date: new Date().toISOString(),
    avg_ms: Math.round(total / times.length),
    avg_cents: avgCents !== null ? Math.round(avgCents * 10) / 10 : null,
    skipped,
    times: times.map(t => ({
      scale: t.scale,
      ms: Math.round(t.ms),
      cents: typeof t.cents === "number" ? Math.round(t.cents * 10) / 10 : null,
    })),
  };
  const h = historyStore.load();
  h.push(session);
  historyStore.save(h);
  lastSession = session;
}

function deltaHTML(cur, other, label) {
  const d = cur - other;
  if (d === 0) return `<span>= ${label}</span>`;
  const cls = d < 0 ? "better" : "worse";
  const arrow = d < 0 ? "▼" : "▲";
  return `<span class="${cls}">${arrow} ${fmt(Math.abs(d))} vs ${label}</span>`;
}

function renderResults() {
  const cur = lastSession;
  if (!cur) {
    app.innerHTML = `
      <div class="results">
        <div class="session-num">every scale skipped — nothing recorded</div>
        <div class="hint">${restartHint()}</div>
      </div>
    `;
    return;
  }
  const h = historyStore.load();
  const prev = h.length > 1 ? h[h.length - 2] : null;
  // Compare per-scale pace, not session totals — the scale count varies with
  // which modes are toggled on, so totals aren't comparable across sessions.
  const best = h.reduce((b, s) => (s.avg_ms < b.avg_ms ? s : b));
  const isPB = cur.avg_ms === best.avg_ms && h.length > 1;
  const sorted = cur.times.slice().sort((a, b) => a.ms - b.ms);
  const fastest = sorted[0],
    slowest = sorted[sorted.length - 1];
  let deltas = "";
  if (prev) {
    deltas = `<div class="deltas">
      ${deltaHTML(cur.avg_ms, prev.avg_ms, "prev")}
      ${deltaHTML(cur.avg_ms, best.avg_ms, "best")}
      ${isPB ? '<span class="better">★ new best</span>' : ""}
    </div>`;
  }
  app.innerHTML = `
    <div class="results">
      <div class="session-num">session #${h.length}${cur.skipped ? ` · ${cur.skipped} skipped` : ""}</div>
      ${deltas}
      <div class="summary">
        <div><span>avg / scale</span><strong>${fmt(cur.avg_ms)}</strong><em>over ${cur.times.length} scale${cur.times.length === 1 ? "" : "s"}</em></div>
        <div><span>fastest scale</span><strong>${fmt(fastest.ms)}</strong><em>${chordName(fastest.scale)} · ${displayMode(modeOf(fastest.scale))}</em></div>
        <div><span>slowest scale</span><strong>${fmt(slowest.ms)}</strong><em>${chordName(slowest.scale)} · ${displayMode(modeOf(slowest.scale))}</em></div>
        ${cur.avg_cents !== null && cur.avg_cents !== undefined ? `<div><span>avg intonation</span><strong>±${cur.avg_cents}¢</strong>${prev?.avg_cents != null ? `<em>${cur.avg_cents < prev.avg_cents ? "▼" : cur.avg_cents > prev.avg_cents ? "▲" : "="} ${Math.abs(cur.avg_cents - prev.avg_cents).toFixed(1)}¢ vs prev</em>` : ""}</div>` : ""}
      </div>
      <div class="list">
        ${cur.times
          .map(t => {
            const c = t.ms === fastest.ms ? "fast" : t.ms === slowest.ms ? "slow" : "";
            return `<div class="${c}"><span>${chordName(t.scale)}</span><span class="row-mode">${displayMode(modeOf(t.scale))}</span><span>${fmt(t.ms)}</span></div>`;
          })
          .join("")}
      </div>
      <div class="hint">${restartHint()}</div>
    </div>
  `;
}

// ===== Events =====
// Keys that shouldn't count as "any key" — modifiers alone, and nav keys.
const INERT_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"]);

function advanceFromInput() {
  if (state === "ready") return beginPlaying();
  if (state === "playing") return completeCurrent();
  if (state === "done") return start();
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
  if (INERT_KEYS.has(e.key)) return;
  e.preventDefault();
  if (e.code === "Escape") return start();
  advanceFromInput();
});

document.addEventListener("click", e => {
  if (e.target.closest("button, a, input, select")) return;
  advanceFromInput();
});

window.addEventListener("resize", fitChordSize);

// The mic is requested on load, but iOS often refuses without a user gesture,
// so retry on the first one. iOS also parks the context in "suspended".
document.getElementById("mic-warn").addEventListener("click", () => initMic());

// A backgrounded tab can suspend the context, so resume on any gesture.
async function ensureAudio() {
  if (audioCtx) return resumeAudioIfNeeded();
  if ((await initMic()) && state === "ready") render();
}
["pointerdown", "keydown"].forEach(evt =>
  document.addEventListener(
    evt,
    () => {
      ensureAudio();
      updateWakeLock();
    },
    { passive: true },
  ),
);

// Hiding the page releases the lock, so take it back on return.
document.addEventListener("visibilitychange", updateWakeLock);

noteTracker = new NoteTracker(
  (pc, cents, midi) => currentMatcher?.input(pc, cents, midi),
  () => {
    pendingStart.cancel();
    pendingRewind.cancel();
  },
);

start();

// ensureAudio() rebuilds the graph on first gesture if this one comes back
// suspended.
requestMic().then(ok => {
  if (ok && startAudioGraph() && state === "ready") render();
});
