// The redaction project globe, in new-modality's window in the page (#new_modality, between Myngo
// and the autonomous flight project): a full-height gap that looks through the site to this.
//
// A port to three.js of new-modality's SceneKit globe (new-modality: Sources/Modality/GlobeScene.swift)
// as the phone draws it in its Vision look (new-modality-mobile: GlobeHub.swift, LensFringe.metal):
// the lit wireframe with the arrow wrapped over it and its cut through the struts, the wall of dots
// behind, blur toward the foot, the lens's colour fringes and the idle flicker. On top of that, the
// globe "hears" its own line being said: it swells with each syllable as the words are written in.
//
// The stage is position: fixed inside a section with clip-path: inset(0) (css/redaction-project-globe.css),
// so it is only ever seen through the section, as the page scrolls past it. It renders only while
// the section is on screen.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Lite: for the MDR kiosk iMac (a Raspberry Pi 5 driving a 1024×768 CRT), and anything else that
// can't hold a steady frame rate with the full look. Drawn straight to the screen: no blur, no
// lens fringes, no grain, the cut from one sample a pixel, and the globe 30% larger, since the
// tube is small and seen from across the room. On for Firefox on ARM Linux (the kiosk), or with
// ?lite; ?lite=0 turns it off.
//   ?fpslog   reports the frame rate to the server every 5s (GET /fps-log?...), to tune it by
const params = new URLSearchParams(location.search);
const LITE = params.has('lite')
  ? params.get('lite') !== '0'
  : /Firefox\//.test(navigator.userAgent) && /Linux (aarch64|arm)/.test(navigator.userAgent);
const LITE_SCALE = 1.3;
// Knobs for tuning lite, measured on the kiosk with ?fpslog (2026-11-14, a 75Hz CRT): as built it
// held 75fps with every frame 14ms. Antialiasing took it to 60-70 and uneven, so lite goes without;
// ?aa=1 brings it back. ?dots=0 drops the dot wall and ?cut=0 the arrow's cut, which cost little
// and nothing respectively once the cut's shader was unrolled.
const KNOB = (name, lite = true) => (params.has(name) ? params.get(name) !== '0' : lite);

// ---------- From GlobeScene.swift (numbers read out of assets/redaction-project.blend) ----------
const SEGMENTS = 18, RINGS = 13, FIRST_MERIDIAN = 70 * Math.PI / 180;
const END_THICKNESS = 0.038;
const START_TILT = 0.709;
const TILT_WINDOW = [0, 89 / 119];                    // of the two-second move
const DISTANCE = Math.hypot(6.66, 7.775);             // camera to centre once the move is done
const CAMERA = new THREE.Vector3(0, 7.775, 6.66);     // Blender (0, −6.66, 7.775), Y-up
const INTRO = 2, ARROW_OVERLAP = 0.2, ARROW_DURATION = 0.9, SHAFT_SHARE = 0.85;
const INTRO_LENGTH = INTRO - ARROW_OVERLAP + ARROW_DURATION;
const POWER_UP = 1.7;
const ARROW_PATH = [[1.194, 0.506], [0.394, -0.071], [0.404, 0.184], [-0.408, -0.412], [-0.396, -0.163], [-1.2, -0.751]];
const ARROW_HEAD = [[-1.153, -0.551], [-1.2, -0.751], [-1.008, -0.776]];
const ARROW_WIDTH = 0.034, GAP_HALF = 0.165;
const WAVE = { sweep: 1.1, rest: 0.25, lead: 0.22, tail: 0.9, depth: 0.95 };

// ---------- From the phone's Vision look ----------
const STROKE = 1.25;                  // the struts' weight at this size
const SPIN_PERIOD = 60;               // a turn a minute
const SPEECH_TEMPO = 1.4;             // the line said this much quicker than it was timed; the globe at its own pace
const ENTRANCE_PACE = 20;             // the entrance's turn, averaged
const LOUDNESS_GAIN = 0.15;           // how much bigger the loudest speech makes it
const WRAP_RADIUS = 1.3, WRAP_RATE = 10, WRAP_STEP = 0.02, WRAP_LIFT = 0.03;
const SPREAD = 0.01;                  // the lens: red drawn this much larger than green, blue smaller
const LAMP_DIP = 2.5;
const TRACE = { duration: 1.4, blank: 0.08, follower: 0.04, between: 0.05, bright: 0.5 };
const DOTS = { count: 24000, radius: 40, color: 0x636366, spacing: 0.11, size: 0.013 };
const RING = { run: 0.75, tail: 0.4, edge: 0.04, swellRise: 0.25, swellFall: 0.9 };
const TOUCH = { push: -1.3, stiffness: 180, damping: 10, ring: 0.45, swell: 0.6 };   // a tap on the globe
const BLUR = { above: (0.7 - 0.125) / 0.75, below: 0.125 / 0.75, globe: 1.5, dots: 1.5, dotsGain: 2 };

const STRUT_RADIUS = END_THICKNESS * STROKE / 2;
const ARROW_STANDOFF = STRUT_RADIUS + 0.005;
const WRAP_BEND = 1 + ARROW_STANDOFF + WRAP_LIFT;
const TAN_R = 1 / Math.sqrt(DISTANCE * DISTANCE - 1);   // the globe's radius on screen, in tangent units

// ---------- What it hears ----------
// Each word in syllables, written in as they are said. The space before a word goes with its first.
const LINES = [
  [['The'], ['mouse'], ['and'], ['key', 'board'], ['are'], ['dead.']],
  [['Long'], ['live'], ['new-', 'mo', 'dal', 'i', 'ty.']],
];
const STRESSED = new Set(['mouse', 'key', 'dead.', 'Long', 'live', 'mo']);
const SPEECH_LEAD = 0.45;             // from the microphone opening to the first word

// The app's text is shown as pictures of it, rendered in its own faces by
// tools/render_new_modality_text.swift: the public site can't serve Apple's SF font files.
const TEXT = (name) => new URL(`../assets/new_modality/text/${name}.png`, import.meta.url).href;

// The labels over the globe, as the app's HUD sets them (new-modality: RecordingHUD.swift): its
// globe is 330pt across, the labels 26pt above it, the big one 61pt tall and the small 29pt.
const HUD = {
  globe: 330, gap: 26, titleHeight: 61, detailHeight: 29, micStarts: 0.3,
  starting: ['hud-dictation', 'hud-starting'],          // DICTATION / STARTING MIC (amber)
  listening: ['hud-dictation', 'hud-listening'],        // DICTATION / LISTENING (no microphone named)
  transcribing: ['hud-transcribing', 'hud-dictation-small'],   // TRANSCRIBING / DICTATION
};

// The line at the foot, in SF Mono: an image a line, set 20pt in a 34pt line, every character an
// equal share of its width, so it is revealed a word at a time by clipping.
const LINE_IMAGES = [{ name: 'line-1', w: 396, h: 34 }, { name: 'line-2', w: 285, h: 34 }];

// Fills the caption with the lines, plain images as the HUD's labels are (the lens's fringes are
// drop-shadows: see the CSS), and returns how to reveal the first `counts[i]` characters of each.
function buildCaption(caption) {
  caption.innerHTML = LINE_IMAGES.map(({ name, w, h }) =>
    `<span class="redaction_line" style="width:calc(1.7em * ${w} / ${h})"><img src="${TEXT(name)}" alt=""></span>`).join('');
  const lines = [...caption.children];
  return (counts) => lines.forEach((line, i) => {
    const shown = counts[i] / SPEECH.text[i].length;
    line.style.clipPath = shown >= 1 ? 'none' : `inset(-4px ${(100 * (1 - shown)).toFixed(3)}% -4px 0)`;
  });
}

function buildSpeech() {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const syllables = [];
  const text = LINES.map((line) => line.map((w) => w.join('')).join(' '));
  let t = SPEECH_LEAD;
  LINES.forEach((line, li) => {
    let at = 0;
    line.forEach((word, wi) => {
      const wordTo = at + (wi > 0 ? 1 : 0) + word.join('').length;
      word.forEach((syl, si) => {
        const from = at;
        at += syl.length + (si === 0 && wi > 0 ? 1 : 0);
        const dur = 0.13 + 0.03 * syl.length + 0.04 * random();
        const amp = STRESSED.has(syl) ? 0.85 + 0.15 * random() : 0.5 + 0.2 * random();
        syllables.push({ line: li, start: t, dur, amp, from, to: at, wordTo });
        t += dur;
      });
      t += /[.]$/.test(word[word.length - 1]) ? 0 : 0.07;
    });
    t += 0.65;
  });
  return { syllables, text, end: t - 0.65 };
}
const SPEECH = buildSpeech();

// ---------- Small geometry helpers (GlobeScene.swift's, in JS) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const progress = (t, [a, b]) => ease((t - a) / (b - a));

const SHAFT_LENGTH = ARROW_PATH.slice(1).reduce((s, p, i) => s + len(sub(p, ARROW_PATH[i])), 0);
const HEAD_SHARE = Math.max(len(sub(ARROW_HEAD[0], ARROW_HEAD[1])), len(sub(ARROW_HEAD[2], ARROW_HEAD[1]))) / SHAFT_LENGTH;

// The first `fraction` of a polyline, every segment an equal share however long it is.
function prefix(points, fraction) {
  if (fraction <= 0) return [];
  const segments = points.length - 1, position = Math.min(1, fraction) * segments;
  const whole = Math.min(Math.floor(position), segments);
  const out = points.slice(0, whole + 1);
  const t = position - whole;
  if (whole < segments && t > 1e-9) out.push(add(points[whole], mul(sub(points[whole + 1], points[whole]), t)));
  return out;
}

function complement(ranges) {
  const gaps = [];
  let from = 0;
  for (const [lo0, hi0] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const lo = Math.max(0, lo0), hi = Math.min(1, hi0);
    if (hi <= lo) continue;
    if (lo > from) gaps.push([from, lo]);
    from = Math.max(from, hi);
  }
  if (from < 1) gaps.push([from, 1]);
  return gaps;
}

// A polyline with the stretches in `blanks` (shares of its length) taken out.
function pieces(points, blanks) {
  if (points.length < 2) return [points];
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + len(sub(points[i], points[i - 1])));
  const total = lengths[lengths.length - 1];
  if (total <= 0) return [points];
  const at = (share) => {
    const d = share * total;
    let i = 0;
    while (i < points.length - 2 && lengths[i + 1] <= d) i++;
    const span = lengths[i + 1] - lengths[i];
    return add(points[i], mul(sub(points[i + 1], points[i]), span > 0 ? (d - lengths[i]) / span : 0));
  };
  return complement(blanks).map(([lo, hi]) => {
    const piece = [at(lo)];
    points.forEach((p, i) => { if (lengths[i] > lo * total && lengths[i] < hi * total) piece.push(p); });
    piece.push(at(hi));
    return piece;
  });
}

// Blanks past the tip carried out along both barbs, as shares of the head's line.
function headBlanks(blanks, free0, free1, tip) {
  const first = len(sub(free0, tip)), second = len(sub(free1, tip)), total = first + second;
  if (total <= 0) return [];
  return blanks.flatMap(([lo, hi]) => {
    const near = (lo - 1) * SHAFT_LENGTH, far = (hi - 1) * SHAFT_LENGTH, out = [];
    if (far > 0 && near < first) out.push([(first - Math.min(far, first)) / total, (first - Math.max(near, 0)) / total]);
    if (far > 0 && near < second) out.push([(first + Math.max(near, 0)) / total, (first + Math.min(far, second)) / total]);
    return out;
  });
}

// Bends flat art over a sphere about the globe's centre, as a sticker: `curve` 0 is a flat card the
// size it is seen at on that shell, 1 wrapped. See `GlobeScene.Wrap`.
function makeWrap(radius, curve) {
  const flatScale = screenRadius(DISTANCE - radius) * WRAP_BEND / radius;
  return ([x, y]) => {
    const s = flatScale + (1 - flatScale) * curve;
    const qx = x * s, qy = y * s, d = Math.hypot(qx, qy);
    if (d < 1e-9) return [0, 0, radius];
    if (curve < 1e-6) return [qx * radius / WRAP_BEND, qy * radius / WRAP_BEND, radius];
    const sphere = radius / curve, angle = d / WRAP_BEND * curve, k = sphere * Math.sin(angle) / d;
    return [qx * k, qy * k, radius - sphere + sphere * Math.cos(angle)];
  };
}

function screenRadius(depth) {
  return depth / DISTANCE / Math.sqrt(1 - 1 / (DISTANCE * DISTANCE));
}

// Mitred ribbons along polylines (and the outer mitre of each join), bent by `wrap`.
function ribbons(lines, width, joins, wrap) {
  const pos = [], idx = [], half = width / 2;
  const normal = (d) => [-d[1], d[0]];
  const put = (p) => { const q = wrap(p); pos.push(q[0], q[1], q[2]); };
  for (let line of lines) {
    line = line.filter((p, i) => i === 0 || len(sub(p, line[i - 1])) > 1e-9);
    if (line.length < 2) continue;
    const dense = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], steps = Math.max(1, Math.ceil(len(sub(b, a)) / WRAP_STEP));
      for (let s = 1; s <= steps; s++) dense.push(add(a, mul(sub(b, a), s / steps)));
    }
    const base = pos.length / 3;
    dense.forEach((p, i) => {
      const inc = i > 0 ? norm(sub(p, dense[i - 1])) : null;
      const out = i < dense.length - 1 ? norm(sub(dense[i + 1], p)) : null;
      let off;
      if (inc && out) {
        const bis = add(normal(inc), normal(out));
        if (len(bis) < 1e-6) off = mul(normal(inc), half);
        else {
          const dir = norm(bis);
          off = mul(dir, Math.min(half / Math.max(dot(dir, normal(inc)), 1e-6), half * 6));
        }
      } else off = mul(normal(inc || out), half);
      put(add(p, off)); put(sub(p, off));
    });
    for (let s = 0; s < dense.length - 1; s++) {
      const l0 = base + 2 * s, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
      idx.push(l0, r0, l1, r0, r1, l1);
    }
  }
  for (const [a, c, b] of joins) {
    const inc = norm(sub(c, a)), out = norm(sub(b, c));
    const turn = inc[0] * out[1] - inc[1] * out[0];
    if (Math.abs(turn) < 1e-6) continue;
    const side = turn > 0 ? -1 : 1;
    const oi = mul(normal(inc), side), oo = mul(normal(out), side);
    const dir = norm(add(oi, oo));
    const reach = Math.min(half / Math.max(dot(dir, oi), 1e-6), half * 6);
    const base = pos.length / 3;
    [c, add(c, mul(oi, half)), add(c, mul(dir, reach)), add(c, mul(oo, half))].forEach(put);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// ---------- Flicker (GlobeHub.swift's `Flicker`): a tube catching, now and then, while idle ----------
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

function makeOutage(start) {
  const kind = ['surge', 'burst', 'sag'][randInt(0, 2)];
  const o = { kind, dips: [], outFrom: 0, rampFrom: 0, litAt: 0, flashAt: 0, end: 0 };
  let t = start;
  if (kind === 'surge') {
    for (let i = randInt(0, 2); i > 0; i--) {
      const end = t + rand(0.02, 0.04);
      o.dips.push([t, end, 0.4]);
      t = end + rand(0.03, 0.06);
    }
    o.outFrom = t;
    o.rampFrom = t + rand(0.18, 0.35);
    o.litAt = o.rampFrom + rand(0.07, 0.12);
    o.flashAt = o.litAt + rand(0.02, 0.05);
    o.end = o.flashAt + rand(0.03, 0.05);
  } else if (kind === 'burst') {
    for (let i = randInt(2, 6); i > 0; i--) {
      const end = t + (Math.random() < 0.2 ? rand(0.09, 0.22) : rand(0.025, 0.06));
      o.dips.push([t, end, 1 - rand(0.55, 0.92)]);
      t = end + rand(0.03, 0.18);
    }
    o.end = o.dips[o.dips.length - 1][1];
  } else {
    o.rampFrom = t + rand(0.1, 0.2);
    o.litAt = o.rampFrom + rand(0.45, 0.7);
    const count = randInt(2, 4), share = (o.litAt - o.rampFrom) / count;
    for (let i = 0; i < count; i++) {
      const l = rand(0.025, 0.05), from = o.rampFrom + share * i + rand(0, Math.max(0, share - l));
      o.dips.push([from, from + l, rand(0.12, 0.25)]);
    }
    o.end = o.litAt;
  }
  return o;
}

function outageLevel(o, t, peak) {
  const dip = o.dips.find(([a, b]) => t >= a && t < b)?.[2];
  if (o.kind === 'surge') {
    if (t < o.outFrom) return dip ?? 1;
    if (t < o.rampFrom) return 0.4;
    if (t < o.litAt) return 0.4 + 0.6 * ease((t - o.rampFrom) / (o.litAt - o.rampFrom));
    if (t < o.flashAt) return 1;
    return t < o.end ? peak : 1;
  }
  if (o.kind === 'burst') return dip ?? 1;
  const ramped = t < o.rampFrom ? 0.8 : 0.8 + 0.2 * ease((t - o.rampFrom) / (o.litAt - o.rampFrom));
  return Math.min(1, ramped - (dip ?? 0));
}

function createFlicker() {
  let outage = null, nextAt = null;
  return (now, running, peak) => {
    if (!running) { outage = null; nextAt = null; return 1; }
    if (nextAt == null) nextAt = now + rand(0.15, 0.5);
    if (!outage && now >= nextAt) { outage = makeOutage(now); nextAt = outage.end + rand(5, 14); }
    if (!outage) return 1;
    if (now >= outage.end) { outage = null; return 1; }
    return outageLevel(outage, now, peak);
  };
}

// The globe powering up as it arrives: warming from dark, sputtering, then steady. Not random.
function powerUp(t) {
  if (t >= POWER_UP) return 1;
  if (t <= 0) return 0;
  const warm = Math.min(1, t / 0.8), glow = warm * warm * (3 - 2 * warm);
  const unrest = Math.exp(-t / 0.45) * (1 - t / POWER_UP);
  const shiver = 0.5 * Math.sin(TAU * 7.3 * t) + 0.3 * Math.sin(TAU * 13.1 * t + 1.3) + 0.2 * Math.sin(TAU * 23.7 * t + 0.4);
  const wavering = 1 - unrest * Math.min(1, Math.max(0, 0.45 + 0.8 * shiver));
  const sputter = [[0.14, 0.19, 1], [0.27, 0.3, 0.9], [0.52, 0.56, 0.65], [0.98, 1.01, 0.35], [1.42, 1.44, 0.15]]
    .find(([a, b]) => t >= a && t < b);
  return glow * wavering * (sputter ? 1 - sputter[2] : 1);
}

// The intro's turn, landing gently on the spin's own speed (`introTurnProgress`, landing gently).
const INTRO_TURN = TAU * INTRO_LENGTH / ENTRANCE_PACE;
function introTurn(u) {
  u = Math.min(1, Math.max(0, u));
  const s = (TAU / SPIN_PERIOD) * INTRO_LENGTH / INTRO_TURN;
  return (3 - 2 * s) * u ** 4 + (5 * s - 8) * u ** 3 + (6 - 3 * s) * u ** 2;
}

// ---------- Shaders ----------
// The ink (struts, joints, arrow): flat, under a lamp hanging over the globe, with the dark wave
// running pole to pole while it works. Worked in the globe's own frame, as GlobeScene's waveShader.
const inkVertex = /* glsl */`
  uniform mat4 globeFromWorld;
  varying vec3 vP;
  varying vec3 vWorld;
  void main() {
    vec4 local = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif
    vec4 world = modelMatrix * local;
    vP = (globeFromWorld * world).xyz;
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

// The arrow's cut through the struts, worked out exactly per strut fragment rather than drawn as a
// depth-only ribbon. The ribbon, bent over its shell, is flat triangles under the curve, and its
// joins left notches and slivers wherever the arrow bent. Here the ray from the eye to the strut is
// met with the shell the cut lies on, that point unbent back onto the flat art, and the art tested
// against the same mitred band the ribbon was: a run per segment, a mitre per corner.
const gapChunk = /* glsl */`
  uniform mat4 overlayFromWorld;
  uniform vec3 eyeO;
  uniform vec4 gapSeg[5];      // each segment's start, and its direction
  uniform float gapLen[5];     // its length; 0 for none
  uniform vec4 gapCorner[4];   // each corner's incoming and outgoing directions
  uniform vec3 gapCornerAt[4]; // the corner, and 1 if there is one
  uniform int gapCount;
  uniform float gapRadius, gapCurve, gapScale, gapBend, gapHalf;
  varying vec3 vWorld;
  float crossz(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
  // Unrolled, with every index fixed and the segments' directions and lengths worked out once a
  // frame in JS: looping over a uniform array by a changing index cost the kiosk Pi's GPU half its
  // frame rate. A segment of length 0, or a corner whose flag is 0, is switched off.
  bool inBand(vec2 p) {
    vec2 w;
    float t;
    w = p - gapSeg[0].xy; t = dot(w, gapSeg[0].zw);
    if (gapLen[0] > 0.0 && t >= 0.0 && t <= gapLen[0] && abs(crossz(gapSeg[0].zw, w)) <= gapHalf) return true;
    w = p - gapSeg[1].xy; t = dot(w, gapSeg[1].zw);
    if (gapLen[1] > 0.0 && t >= 0.0 && t <= gapLen[1] && abs(crossz(gapSeg[1].zw, w)) <= gapHalf) return true;
    w = p - gapSeg[2].xy; t = dot(w, gapSeg[2].zw);
    if (gapLen[2] > 0.0 && t >= 0.0 && t <= gapLen[2] && abs(crossz(gapSeg[2].zw, w)) <= gapHalf) return true;
    w = p - gapSeg[3].xy; t = dot(w, gapSeg[3].zw);
    if (gapLen[3] > 0.0 && t >= 0.0 && t <= gapLen[3] && abs(crossz(gapSeg[3].zw, w)) <= gapHalf) return true;
    w = p - gapSeg[4].xy; t = dot(w, gapSeg[4].zw);
    if (gapLen[4] > 0.0 && t >= 0.0 && t <= gapLen[4] && abs(crossz(gapSeg[4].zw, w)) <= gapHalf) return true;
    w = p - gapCornerAt[0].xy;
    if (gapCornerAt[0].z > 0.0 && dot(w, gapCorner[0].xy) > 0.0 && dot(w, gapCorner[0].zw) < 0.0
        && abs(crossz(gapCorner[0].xy, w)) <= gapHalf && abs(crossz(gapCorner[0].zw, w)) <= gapHalf) return true;
    w = p - gapCornerAt[1].xy;
    if (gapCornerAt[1].z > 0.0 && dot(w, gapCorner[1].xy) > 0.0 && dot(w, gapCorner[1].zw) < 0.0
        && abs(crossz(gapCorner[1].xy, w)) <= gapHalf && abs(crossz(gapCorner[1].zw, w)) <= gapHalf) return true;
    w = p - gapCornerAt[2].xy;
    if (gapCornerAt[2].z > 0.0 && dot(w, gapCorner[2].xy) > 0.0 && dot(w, gapCorner[2].zw) < 0.0
        && abs(crossz(gapCorner[2].xy, w)) <= gapHalf && abs(crossz(gapCorner[2].zw, w)) <= gapHalf) return true;
    w = p - gapCornerAt[3].xy;
    if (gapCornerAt[3].z > 0.0 && dot(w, gapCorner[3].xy) > 0.0 && dot(w, gapCorner[3].zw) < 0.0
        && abs(crossz(gapCorner[3].xy, w)) <= gapHalf && abs(crossz(gapCorner[3].zw, w)) <= gapHalf) return true;
    return false;
  }
  // Where the line of sight to world point F crosses the cut's shell, as flat art; false if it
  // doesn't cross it in front of F.
  bool toArt(vec3 world, out vec2 art) {
    vec3 F = (overlayFromWorld * vec4(world, 1.0)).xyz;
    vec3 D = F - eyeO;
    vec2 q;
    float t;
    if (gapCurve < 0.02) {
      if (abs(D.z) < 1e-6) return false;
      t = (gapRadius - eyeO.z) / D.z;
      q = (eyeO + D * t).xy * gapBend / gapRadius;
    } else {
      float S = gapRadius / gapCurve;
      vec3 C = vec3(0.0, 0.0, gapRadius - S), oc = eyeO - C;
      float a = dot(D, D), b = dot(oc, D), c = dot(oc, oc) - S * S, disc = b * b - a * c;
      if (disc <= 0.0) return false;
      t = (-b - sqrt(disc)) / a;
      vec3 v = eyeO + D * t - C;
      float across = length(v.xy);
      float d = atan(across, v.z) * gapBend / gapCurve;
      q = across > 1e-6 ? v.xy / across * d : vec2(0.0);
    }
    art = q / gapScale;
    return t > 0.0 && t < 1.0;
  }
  // How much of this pixel the cut leaves, from four points across it.
  float gapCoverage() {
    if (gapCount < 2) return 1.0;
    #if GAP_SAMPLES == 1
      vec2 one;
      return toArt(vWorld, one) && inBand(one) ? 0.0 : 1.0;
    #endif
    vec3 dx = dFdx(vWorld) * 0.25, dy = dFdy(vWorld) * 0.25;
    float kept = 0.0;
    vec2 art;
    for (int i = 0; i < GAP_SAMPLES; i++) {
      vec3 o = GAP_SAMPLES == 1 ? vec3(0.0) : (i == 0 ? -dx - dy : i == 1 ? dx - dy : i == 2 ? -dx + dy : dx + dy);
      kept += toArt(vWorld + o, art) && inBand(art) ? 0.0 : 1.0;
    }
    return kept / float(GAP_SAMPLES);
  }`;

const inkFragment = /* glsl */`
  uniform float inkGain, waveFront, waveDepth;
  uniform vec3 eyeG, lampG;
  varying vec3 vP;
  #ifdef CUT
  ${gapChunk}
  #endif
  void main() {
    #ifdef CUT
      float kept = gapCoverage();
      if (kept <= 0.0) discard;
    #else
      float kept = 1.0;
    #endif
    vec3 p = vP;
    float r = length(p);
    float onSphere = 1.0 - smoothstep(0.1, 0.25, abs(r - 1.0));
    float theta = acos(clamp(p.y / max(r, 0.0001), -1.0, 1.0));
    float ahead = theta - waveFront;
    float d = ahead > 0.0 ? ahead / ${WAVE.lead.toFixed(3)} : -ahead / ${WAVE.tail.toFixed(3)};
    float k = waveDepth * onSphere * (1.0 - smoothstep(0.0, 1.0, d));
    vec3 c = vec3(1.0 - k);
    // Shaded as the sphere is at the point seen through this one, so a strut stays flat ink and the
    // arrow takes the light of the globe behind it.
    vec3 ray = normalize(p - eyeG);
    float b = dot(eyeG, ray);
    float h = b * b - (dot(eyeG, eyeG) - 1.0);
    vec3 n = normalize(h > 0.0 ? eyeG + ray * (-b - sqrt(h)) : eyeG - ray * b);
    vec3 toLight = lampG - n;
    float reach = length(toLight);
    vec3 L = toLight / reach;
    vec3 V = normalize(eyeG - n);
    float fall = 1.0 / (1.0 + 1.5 * reach * reach);
    float diffuse = max((dot(n, L) + 0.7) / 1.7, 0.0) * fall * 1.7;
    float glint = pow(max(dot(n, normalize(L + V)), 0.0), 10.0) * fall * 0.6;
    gl_FragColor = vec4(c * (0.5 * min(inkGain, 1.0) + 0.5 * (diffuse + glint) * inkGain), 1.0);
    #include <colorspace_fragment>
    gl_FragColor *= kept;
  }`;

const dotsVertex = /* glsl */`
  uniform float size;
  varying vec2 wallAt;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    wallAt = mv.xy / max(-mv.z, 0.001);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size;
  }`;
// The dots, and the white ring a success runs out across them from behind the globe.
const dotsFragment = /* glsl */`
  uniform vec3 dotColor;
  uniform float opacity;
  uniform vec4 ring;   // front, tail, edge, gain (0: none)
  varying vec2 wallAt;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float a = (1.0 - smoothstep(0.55, 1.0, r2)) * opacity;
    vec3 col = dotColor;
    if (ring.w > 0.0) {
      float behind = ring.x - length(wallAt);
      float k = behind >= 0.0 ? exp(-behind / ring.y) : 1.0 - smoothstep(0.0, ring.z, -behind);
      col = mix(col, vec3(ring.w), clamp(k, 0.0, 1.0));
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * a, a);
  }`;

const quadVertex = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// A blur that is nothing above `clear` (from the top, 0…1) and `sigma` pixels from `full` down,
// one axis per pass. `gain` lifts the opacity of what it spread (the dots'), stopped at opaque.
const blurFragment = /* glsl */`
  uniform sampler2D src;
  uniform vec2 axis;
  uniform float sigma, clear, full, gain;
  varying vec2 vUv;
  void main() {
    float share = clamp((1.0 - vUv.y - clear) / max(full - clear, 0.0001), 0.0, 1.0);
    float s = sigma * share;
    vec4 c = texture2D(src, vUv);
    if (s >= 0.25) {
      float stepPx = 3.0 * s / 10.0, weights = 1.0;
      for (int i = 1; i <= 10; i++) {
        float x = float(i) * stepPx, w = exp(-0.5 * x * x / (s * s));
        c += (texture2D(src, vUv + axis * x) + texture2D(src, vUv - axis * x)) * w;
        weights += 2.0 * w;
      }
      c /= weights;
    }
    float g = 1.0 + (gain - 1.0) * share;
    gl_FragColor = c * min(g, c.a > 0.0 ? 1.0 / c.a : g);
  }`;

// The lens (LensFringe.metal): red drawn a little larger and blue a little smaller about the
// centre, the scene over the dots; then the site's film grain over it all.
const finalFragment = /* glsl */`
  uniform sampler2D sceneTex, dotsTex;
  uniform vec2 centre;
  uniform float spread, seed;
  varying vec2 vUv;
  vec4 comp(vec2 uv) {
    vec4 f = texture2D(sceneTex, uv);
    return f + texture2D(dotsTex, uv) * (1.0 - f.a);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
  void main() {
    vec2 d = vUv - centre;
    vec4 r = comp(centre + d * (1.0 - spread));
    vec4 g = comp(vUv);
    vec4 b = comp(centre + d * (1.0 + spread));
    vec3 col = vec3(r.r, g.g, b.b);
    float n = hash(floor(gl_FragCoord.xy)) - 0.5;
    float speck = hash(floor(gl_FragCoord.xy) + 17.0);
    col *= 1.0 + n * 0.07;
    col += (1.0 - max(g.a, max(r.a, b.a))) * step(0.985, speck) * 0.006;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

// ---------- The globe ----------
function startGlobe(stage) {
  const canvas = stage.querySelector('.redaction_canvas');
  const caption = stage.querySelector('.redaction_caption');
  const section = stage.closest('.redaction_window');

  if (LITE) stage.dataset.lite = '';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: KNOB('aa', false), alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  let failed = false;
  renderer.debug.onShaderError = () => { failed = true; };

  const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 100);
  camera.position.copy(CAMERA);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // lean (the voice's swell) → globe (the intro's tilt and growth) → spinner (the turn)
  const scene = new THREE.Scene();
  const lean = new THREE.Group(), globe = new THREE.Group(), spinner = new THREE.Group();
  scene.add(lean); lean.add(globe); globe.add(spinner);

  const uniforms = {
    globeFromWorld: { value: new THREE.Matrix4() },
    inkGain: { value: 1 }, waveFront: { value: 0 }, waveDepth: { value: 0 },
    eyeG: { value: new THREE.Vector3() }, lampG: { value: new THREE.Vector3() },
    // the cut (gapChunk)
    overlayFromWorld: { value: new THREE.Matrix4() }, eyeO: { value: new THREE.Vector3() },
    gapSeg: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) }, gapLen: { value: new Array(5).fill(0) },
    gapCorner: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    gapCornerAt: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) }, gapCount: { value: 0 },
    gapRadius: { value: WRAP_RADIUS }, gapCurve: { value: 0 }, gapScale: { value: 1 }, gapBend: { value: WRAP_BEND }, gapHalf: { value: GAP_HALF },
  };
  const inkMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: inkVertex, fragmentShader: inkFragment, side: THREE.DoubleSide });
  // The struts and joints, cut by the arrow: premultiplied, so a pixel the cut's edge crosses keeps
  // only its share of the ink.
  const strutMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: inkVertex, fragmentShader: inkFragment, side: THREE.DoubleSide, defines: KNOB('cut') ? { CUT: '', GAP_SAMPLES: LITE ? 1 : 4 } : {},
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const depthOnly = () => new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

  // Struts: a cylinder per edge, a ball at each vertex so the joins don't notch.
  const vertex = (ring, seg) => {
    const polar = ring * Math.PI / RINGS, az = FIRST_MERIDIAN + seg * TAU / SEGMENTS;
    const x = Math.sin(polar) * Math.cos(az), y = Math.sin(polar) * Math.sin(az), z = Math.cos(polar);
    return new THREE.Vector3(x, z, -y);   // Blender Z-up → Y-up
  };
  const edges = [];
  for (let s = 0; s < SEGMENTS; s++) for (let r = 0; r < RINGS; r++) edges.push([vertex(r, s), vertex(r + 1, s)]);
  for (let r = 1; r < RINGS; r++) for (let s = 0; s < SEGMENTS; s++) edges.push([vertex(r, s), vertex(r, (s + 1) % SEGMENTS)]);
  const struts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true), strutMaterial, edges.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  edges.forEach(([a, b], i) => {
    dir.subVectors(b, a);
    const length = dir.length();
    q.setFromUnitVectors(up, dir.normalize());
    m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(2 * STRUT_RADIUS, length, 2 * STRUT_RADIUS));
    struts.setMatrixAt(i, m);
  });
  const verts = [vertex(0, 0), vertex(RINGS, 0)];
  for (let r = 1; r < RINGS; r++) for (let s = 0; s < SEGMENTS; s++) verts.push(vertex(r, s));
  const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 6), strutMaterial, verts.length);
  verts.forEach((v, i) => joints.setMatrixAt(i, m.compose(v, q.identity(), new THREE.Vector3().setScalar(2 * STRUT_RADIUS))));
  for (const mesh of [struts, joints]) { mesh.frustumCulled = false; spinner.add(mesh); }

  // The back half hidden by a depth-only sphere just inside the struts.
  const occluder = new THREE.Mesh(new THREE.SphereGeometry(1 - 2 * STRUT_RADIUS, 96, 48), depthOnly());
  occluder.renderOrder = -1;
  spinner.add(occluder);

  // The arrow and its bright marks, on shells round the globe facing the camera. Its cut through
  // the struts is theirs to draw — see gapChunk.
  const overlay = new THREE.Group();
  overlay.quaternion.copy(camera.quaternion);
  lean.add(overlay);
  const arrowMesh = new THREE.Mesh(undefined, inkMaterial); arrowMesh.renderOrder = 1;
  const glowMesh = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })); glowMesh.renderOrder = 2;
  for (const mesh of [arrowMesh, glowMesh]) { mesh.frustumCulled = false; mesh.visible = false; overlay.add(mesh); }

  let arrowKey = '';
  function setArrow(progressAmount, blanks, bright, wrapAmount) {
    const key = `${progressAmount.toFixed(4)}|${blanks.map((b) => b.map((x) => x.toFixed(4)).join(',')).join(';')}|${bright}|${wrapAmount.toFixed(4)}`;
    if (key === arrowKey) return;
    arrowKey = key;
    const shaft = Math.min(1, progressAmount / SHAFT_SHARE);
    const head = Math.max(0, (progressAmount - SHAFT_SHARE) / (1 - SHAFT_SHARE));
    const drawn = prefix(ARROW_PATH, shaft);
    const blanking = shaft >= 1 && blanks.length > 0, glowing = blanking && bright;
    const lines = [[drawn, blanks]];
    if (head > 0) {
      const tip = ARROW_HEAD[1];
      const f0 = add(tip, mul(sub(ARROW_HEAD[0], tip), head)), f1 = add(tip, mul(sub(ARROW_HEAD[2], tip), head));
      lines.push([[f0, tip, f1], headBlanks(blanks, f0, f1, tip)]);
    }
    const ink = [], glow = [];
    for (const [line, bl] of lines) {
      if (!blanking) ink.push(line);
      else if (glowing) { ink.push(line); glow.push(...pieces(line, complement(bl))); }
      else ink.push(...pieces(line, bl));
    }
    // the cut: the drawn shaft, on its shell, at this much bend
    uniforms.gapCount.value = drawn.length;
    const dirs = [];
    for (let i = 0; i < 5; i++) {
      const a = drawn[i], b = drawn[i + 1], L = a && b ? len(sub(b, a)) : 0;
      const u = L > 1e-6 ? mul(sub(b, a), 1 / L) : [1, 0];
      dirs.push(L > 1e-6 ? u : null);
      uniforms.gapSeg.value[i].set(a ? a[0] : 0, a ? a[1] : 0, u[0], u[1]);
      uniforms.gapLen.value[i] = L > 1e-6 ? L : 0;
    }
    for (let i = 0; i < 4; i++) {
      const u1 = dirs[i], u2 = dirs[i + 1], at = drawn[i + 1];
      const on = u1 && u2 && at;
      uniforms.gapCorner.value[i].set(on ? u1[0] : 1, on ? u1[1] : 0, on ? u2[0] : 1, on ? u2[1] : 0);
      uniforms.gapCornerAt.value[i].set(on ? at[0] : 0, on ? at[1] : 0, on ? 1 : 0);
    }
    const flatScale = screenRadius(DISTANCE - WRAP_RADIUS) * WRAP_BEND / WRAP_RADIUS;
    uniforms.gapCurve.value = wrapAmount;
    uniforms.gapScale.value = flatScale + (1 - flatScale) * wrapAmount;
    const width = ARROW_WIDTH * STROKE;
    const set = (mesh, geometry) => { mesh.geometry?.dispose(); mesh.geometry = geometry || new THREE.BufferGeometry(); mesh.visible = !!geometry; };
    set(arrowMesh, ribbons(ink, width, [], makeWrap(WRAP_RADIUS + 0.01, wrapAmount)));
    set(glowMesh, glowing ? ribbons(glow, width, [], makeWrap(WRAP_RADIUS + 0.02, wrapAmount)) : null);
  }

  // The wall of dots round the camera, in a scene of its own, with a depth-only stand-in for the
  // globe so no dot shows through it.
  const dotsScene = new THREE.Scene();
  const mask = new THREE.Mesh(new THREE.SphereGeometry(1.02, 48, 24), depthOnly());
  mask.renderOrder = -5;
  dotsScene.add(mask);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dotPositions = new Float32Array(DOTS.count * 3);
  for (let i = 0; i < DOTS.count; i++) {
    const y = 1 - 2 * (i + 0.5) / DOTS.count, ring = Math.sqrt(1 - y * y), a = golden * i;
    dotPositions.set([Math.cos(a) * ring * DOTS.radius, y * DOTS.radius, Math.sin(a) * ring * DOTS.radius], i * 3);
  }
  const dotGeometry = new THREE.BufferGeometry();
  dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
  const dotUniforms = {
    size: { value: 4 }, opacity: { value: 0 },
    dotColor: { value: new THREE.Color(DOTS.color) }, ring: { value: new THREE.Vector4(0, 1, 1, 0) },
  };
  const wall = new THREE.Points(dotGeometry, new THREE.ShaderMaterial({
    uniforms: dotUniforms, vertexShader: dotsVertex, fragmentShader: dotsFragment,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  wall.frustumCulled = false;
  wall.position.copy(CAMERA);
  dotsScene.add(wall);

  // Post: dots and scene drawn apart, each blurred toward the foot, then the lens over both.
  const rt = (samples = 0) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
  const targets = LITE ? {} : { dots: rt(), scene: rt(4), tmp: rt(), dotsBlur: rt(), sceneBlur: rt() };
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const blurMaterial = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, axis: { value: new THREE.Vector2() }, sigma: { value: 0 }, clear: { value: 0.5 }, full: { value: 1 }, gain: { value: 1 } },
    vertexShader: quadVertex, fragmentShader: blurFragment, depthTest: false, depthWrite: false,
  });
  const finalMaterial = new THREE.ShaderMaterial({
    uniforms: { sceneTex: { value: null }, dotsTex: { value: null }, centre: { value: new THREE.Vector2(0.5, 0.5) }, spread: { value: SPREAD }, seed: { value: 0 } },
    vertexShader: quadVertex, fragmentShader: finalFragment, depthTest: false, depthWrite: false,
  });
  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(quadScene, quadCamera);
  }
  function blur(src, out, { sigma, clear, full, gain = 1 }) {
    const u = blurMaterial.uniforms;
    u.sigma.value = sigma; u.clear.value = clear; u.full.value = full;
    u.src.value = src.texture; u.axis.value.set(1 / src.width, 0); u.gain.value = 1;
    pass(blurMaterial, targets.tmp);
    u.src.value = targets.tmp.texture; u.axis.value.set(0, 1 / src.height); u.gain.value = gain;
    pass(blurMaterial, out);
  }

  // ---------- Layout ----------
  let W = 1, H = 1, pr = 1, D = 1, vfov = 20, centreY = 0.44, cx = 0.5;
  function layout() {
    W = Math.max(1, stage.clientWidth); H = Math.max(1, stage.clientHeight);
    pr = Math.min(window.devicePixelRatio || 1, LITE ? 1 : 1.75);
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    for (const t of Object.values(targets)) t.setSize(Math.round(W * pr), Math.round(H * pr));
    placed = null;
    place();
  }

  // ---------- Where the globe sits: centred, or aside for the write-up ----------
  // After the line, the section's write-up (.redaction_story: icon, title, text, as the other
  // projects have) scrolls up over the globe. If the globe clears the text column where it is, it
  // stays in the middle; if not, it slides into the space right of the text, as the other projects'
  // pictures sit, and shrinks to fit it. Where the text takes the whole width (phones), it dims
  // behind it instead. The line and the labels go as the text comes.
  //
  // The scroll only says whether the write-up has come (its top past a quarter of the way up the
  // screen); the globe gets there on a critically damped spring of its own, about a second, so a
  // hard flick of the page doesn't throw it across.
  // (looked for until it arrives: it is an include of its own, so it can land after the globe starts)
  const story = section.querySelector('.redaction_story');
  let storyText = null, placed = null, aside = 0, asideV = 0, storyCame = false;
  const ASIDE_RATE = 6;   // the spring's ω: settles in about a second
  function place(dt = 0) {
    if (story && !storyText) storyText = story.querySelector('.container_one');
    const D0 = Math.min(W * 0.5, H * 0.34) * (LITE ? LITE_SCALE : 1);
    let arrived = 0, toX = W / 2, toD = D0, dim = 0;
    if (story && storyText) {
      const top = story.getBoundingClientRect().top - stage.getBoundingClientRect().top;
      const goal = top < H * 0.75 ? 1 : 0;
      storyCame = goal === 1;
      if (reduceMotion) { aside = goal; asideV = 0; }
      else if (dt > 0) {
        asideV += (ASIDE_RATE * ASIDE_RATE * (goal - aside) - 2 * ASIDE_RATE * asideV) * dt;
        aside += asideV * dt;
        if (Math.abs(goal - aside) < 1e-3 && Math.abs(asideV) < 1e-3) { aside = goal; asideV = 0; }
      }
      arrived = ease(aside);
      const textRight = storyText.getBoundingClientRect().right - stage.getBoundingClientRect().left;
      const room = W - textRight;
      if (textRight > W * 0.8) dim = 0.75;                       // the text has the whole width
      else if (W / 2 - D0 / 2 < textRight + 24) {                 // in the text's way: aside
        toX = textRight + room / 2;
        toD = Math.min(D0, room * 0.75, H * 0.5);
      }
    }
    const key = `${W}|${H}|${arrived.toFixed(4)}|${toX.toFixed(1)}|${toD.toFixed(1)}`;
    if (key === placed) return;
    placed = key;
    cx = W / 2 + (toX - W / 2) * arrived;
    D = D0 + (toD - D0) * arrived;
    canvas.style.opacity = dim ? (1 - dim * arrived).toFixed(3) : '';
    stage.style.setProperty('--told', (1 - arrived).toFixed(3));
    vfov = 2 * Math.atan(H * TAN_R / D) * 180 / Math.PI;
    camera.fov = vfov;
    camera.aspect = W / H;
    // the globe (on the view axis) drawn at `cx` across and `centreY` down rather than the middle
    camera.setViewOffset(W, H, W / 2 - cx, (0.5 - centreY) * H, W, H);
    camera.updateProjectionMatrix();
    finalMaterial.uniforms.centre.value.set(cx / W, 0.5);
    dotUniforms.size.value = Math.max(2.5, DOTS.size * D) * pr;
    const hud = D / HUD.globe;
    stateLabel.style.setProperty('--hud', hud.toFixed(4));
    stateLabel.style.bottom = `${(H - (centreY * H - D / 2) + HUD.gap * hud).toFixed(1)}px`;
    // the caption's own colour fringes, the lens's direction at its height but only a hint of its
    // size: at full size it splits small text apart
    const captionY = caption.getBoundingClientRect().top - stage.getBoundingClientRect().top + caption.offsetHeight / 2;
    caption.style.setProperty('--fringe', `${Math.min(0.8, (captionY - H / 2) * SPREAD * 0.25).toFixed(2)}px`);
    dirty = true;
  }

  // ---------- State: the app's HUD labels, above the globe (RecordingHUD.swift) ----------
  // While it hears: the gesture's name big, and what the microphone is doing and which one under it
  // ("STARTING MIC" in amber until audio arrives). While it works: "TRANSCRIBING" big, the gesture
  // under it. Sized to the globe as the app sizes them to its 330pt one.
  // Only where the section asks for them (data-hud): the home page does; the kiosk's showpiece
  // (/new-modality/) is the globe and its line alone.
  const showsHud = 'hud' in section.dataset;
  const stateLabel = document.createElement('div');
  stateLabel.className = 'redaction_state';
  stateLabel.setAttribute('aria-hidden', 'true');
  stateLabel.innerHTML = '<img class="redaction_state_title" alt=""><img class="redaction_state_detail" alt="">';
  if (showsHud) stage.appendChild(stateLabel);
  const [stateTitle, stateDetail] = stateLabel.children;
  if (showsHud) for (const name of new Set(['starting', 'listening', 'transcribing'].flatMap((k) => HUD[k]))) new Image().src = TEXT(name);
  let shownState = '';
  function showState(state) {
    if (!showsHud || state === shownState) return;
    shownState = state;
    if (state) {
      const [title, detail] = HUD[state];
      stateTitle.src = TEXT(title);
      stateDetail.src = TEXT(detail);
    }
    stateLabel.classList.toggle('redaction_state_on', !!state);
  }

  // ---------- Caption ----------
  const reveal = buildCaption(caption);
  let shownKey = '';
  function showCaption(counts) {
    const key = counts.join(',');
    if (key === shownKey) return;
    shownKey = key;
    reveal(counts);
  }
  function captionAt(t) {
    const counts = SPEECH.text.map(() => 0);
    for (const s of SPEECH.syllables) {
      if (t < s.start) break;
      counts[s.line] = s.wordTo;   // a whole word at a time, as it starts to be said
    }
    return counts;
  }
  function loudnessAt(t) {
    let level = 0;
    for (const s of SPEECH.syllables) {
      const x = (t - s.start) / s.dur;
      if (x > 0 && x < 1) level = Math.max(level, s.amp * Math.sin(Math.PI * x) ** 0.8);
    }
    return level;
  }

  // ---------- State ----------
  let clock = 0, last = null, raf = 0, dirty = true;
  let visible = false, engaged = false, introAt = null, speechAt = null, needsSpeech = false, succeeded = false, successAt = 0;
  // On a page of its own (data-replay, in seconds), the line comes round again after that long.
  const replay = Number(section.dataset.replay) || 0;
  let spin = 0, lastSpin = 0, lastTilt = START_TILT, follow = 1;
  let env = 0, pulse = 1, wrap = 0, softness = 1, bounce = 0, bounceV = 0, ringGain = 1, ringSwell = 1;
  let waveStartedAt = null, ringAt = null, traceAt = null, traceBright = false, nextTraceAt = Infinity;
  const flicker = createFlicker();
  const wallQ = new THREE.Quaternion(), dq = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const tmpV = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), camBack = new THREE.Vector3();
  camera.matrixWorld.extractBasis(camRight, camUp, camBack);

  if (reduceMotion) showCaption(SPEECH.text.map((l) => l.length));
  else showCaption(SPEECH.text.map(() => 0));

  function frame(now) {
    raf = 0;
    const dt = last == null ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    place(dt);
    clock += dt;

    // ----- the timeline -----
    if (engaged && introAt == null) { introAt = clock; speechAt = clock + INTRO_LENGTH + 0.4; }
    // Arrived part-way down, at the write-up (a reload there, or a jump): the first screen was never
    // seen, so the globe comes in now, beside the text, and the line waits to be scrolled up to.
    if (!engaged && visible && introAt == null && storyCame) { introAt = clock; needsSpeech = true; }
    if (replay && succeeded && !needsSpeech && clock - successAt > replay) {
      needsSpeech = true;
      showCaption(SPEECH.text.map(() => 0));
    }
    if (engaged && needsSpeech) {
      speechAt = Math.max(clock + 0.5, introAt + INTRO_LENGTH + 0.4);
      needsSpeech = false;
      succeeded = false;
    }
    const intro = reduceMotion ? INTRO_LENGTH : introAt == null ? 0 : clock - introAt;
    const inIntro = intro < INTRO_LENGTH;
    // `sp` is the line's own clock, quicker than the page's; once it is heard, the globe works at its own pace
    const since = reduceMotion || speechAt == null ? -1 : clock - speechAt;
    const sp = since < 0 ? -1 : since * SPEECH_TEMPO;
    const listenEnd = SPEECH.end + 0.15, heardAt = listenEnd / SPEECH_TEMPO, workEnd = heardAt + WAVE.sweep + WAVE.rest;
    const listening = sp >= 0 && sp < listenEnd, working = since >= heardAt && since < workEnd;
    const idle = !inIntro && !listening && !working;
    showState(listening ? (sp < HUD.micStarts ? 'starting' : 'listening') : working ? 'transcribing' : '');
    if (since >= workEnd && !succeeded) {
      succeeded = true;
      successAt = clock;
      ringAt = clock; ringGain = 1; ringSwell = 1;
      nextTraceAt = clock + rand(3, 6);
    }

    // ----- the intro: growing, tipping upright, turning in, the arrow striking through -----
    const t = Math.min(1, intro / INTRO);
    const tilt = START_TILT * (1 - progress(t, TILT_WINDOW));
    const grown = 0.001 + 0.999 * progress(t, TILT_WINDOW);
    globe.rotation.x = tilt;
    globe.scale.setScalar(grown);
    if (inIntro) spin = INTRO_TURN * introTurn(intro / INTRO_LENGTH);
    else if (!reduceMotion) spin += TAU / SPIN_PERIOD * dt;
    spinner.rotation.y = -spin;
    const arrowProgress = ease((intro - (INTRO - ARROW_OVERLAP)) / ARROW_DURATION);

    // ----- the voice -----
    if (sp >= 0 && sp < listenEnd + 0.2) showCaption(captionAt(sp));
    const raw = listening ? loudnessAt(sp) : 0;
    env += (raw - env) * (1 - Math.exp(-dt / (raw > env ? 0.03 : 0.15)));
    pulse += (1 + LOUDNESS_GAIN * env - pulse) * (1 - Math.exp(-dt / 0.05));
    // a tap's bounce: a spring, pushed in and settling back
    bounceV += (-TOUCH.stiffness * bounce - TOUCH.damping * bounceV) * dt;
    bounce += bounceV * dt;
    if (Math.abs(bounce) < 1e-4 && Math.abs(bounceV) < 1e-3) bounce = bounceV = 0;
    const size = pulse * (1 + bounce);
    lean.scale.setScalar(size);
    // the arrow wraps round the globe while it hears and works, and lies flat again after
    const wrapGoal = listening || working ? 1 : 0;
    wrap += (wrapGoal - wrap) * (1 - Math.exp(-WRAP_RATE * dt));
    if (Math.abs(wrapGoal - wrap) < 0.002) wrap = wrapGoal;
    // sharp while it hears, soft at rest
    softness += ((listening || working ? 0 : 1) - softness) * (1 - Math.exp(-dt / 0.25));

    // ----- the wave, while it works -----
    if (waveStartedAt != null && clock - waveStartedAt >= WAVE.sweep + WAVE.rest) waveStartedAt = working ? clock : null;
    else if (waveStartedAt == null && working) waveStartedAt = clock;
    if (waveStartedAt != null && clock - waveStartedAt < WAVE.sweep) {
      const e = ease((clock - waveStartedAt) / WAVE.sweep);
      uniforms.waveFront.value = -WAVE.lead + (Math.PI + WAVE.lead + WAVE.tail) * e;
      uniforms.waveDepth.value = WAVE.depth;
    } else uniforms.waveDepth.value = 0;

    // ----- marks running down the arrow, now and then -----
    let blanks = [];
    if (!reduceMotion && idle && arrowProgress >= 1 && traceAt == null && clock >= nextTraceAt) {
      traceAt = clock;
      traceBright = Math.random() < TRACE.bright;
      nextTraceAt = clock + rand(13, 45);
    }
    if (traceAt != null) {
      const u = (clock - traceAt) / TRACE.duration;
      if (u >= 1) traceAt = null;
      else {
        const span = TRACE.blank + TRACE.between + TRACE.follower;
        const head = ease(u) * (1 + HEAD_SHARE + span);
        const secondEnd = head - TRACE.blank - TRACE.between;
        blanks = [[head - TRACE.blank, head], [secondEnd - TRACE.follower, secondEnd]];
      }
    }
    setArrow(arrowProgress, blanks, traceBright, wrap);

    // ----- brightness: powering up, then the idle flicker -----
    const level = flicker(clock, idle && !reduceMotion && visible, 1.5);
    uniforms.inkGain.value = inIntro ? powerUp(intro) : level < 1 ? level ** LAMP_DIP : level;

    // ----- the dots: one to one with the globe as it comes in, then drifting slowly -----
    const calm = vfov / 70;
    follow = inIntro ? 1 : 1 + (calm - 1) * ease((intro - INTRO_LENGTH) / 2.4);
    dq.setFromAxisAngle(Y, -(spin - lastSpin) * follow);
    wallQ.premultiply(dq);
    dq.setFromAxisAngle(X, (tilt - lastTilt) * follow);
    wallQ.premultiply(dq);
    lastSpin = spin; lastTilt = tilt;
    wall.quaternion.copy(wallQ);
    dotUniforms.opacity.value = reduceMotion ? 1 : Math.min(1, Math.max(0, intro / 0.8));
    mask.scale.setScalar(grown * size);
    // a success's ring of white, out from behind the globe, every dot swelling as it leaves
    let swell = 0;
    if (ringAt != null) {
      const pxToTan = 2 * Math.tan(vfov * Math.PI / 360) / H;
      const corner = Math.hypot(Math.max(cx, W - cx), Math.max(centreY, 1 - centreY) * H) * pxToTan;
      const el = clock - ringAt, front = corner * el / RING.run, tail = corner * RING.tail;
      if (front > corner + tail * 6) { ringAt = null; dotUniforms.ring.value.set(0, 1, 1, 0); }
      else {
        dotUniforms.ring.value.set(front, tail, corner * RING.edge, ringGain);
        const run = el / RING.run;
        swell = ringSwell * (run < RING.swellRise ? run / RING.swellRise : Math.exp(-(run - RING.swellRise) / RING.swellFall));
      }
    }
    const baseSize = Math.max(2.5, DOTS.size * D) * pr;
    dotUniforms.size.value = baseSize * (1 + swell);

    // ----- the lamp and the eye, in the globe's own frame -----
    scene.updateMatrixWorld();
    uniforms.globeFromWorld.value.copy(spinner.matrixWorld).invert();
    const radius = grown * size;
    uniforms.eyeG.value.copy(camera.position).applyMatrix4(uniforms.globeFromWorld.value);
    tmpV.set(0, 0, 0).addScaledVector(camUp, 1.4 * radius).addScaledVector(camBack, 0.7 * radius);
    uniforms.lampG.value.copy(tmpV).applyMatrix4(uniforms.globeFromWorld.value);
    uniforms.overlayFromWorld.value.copy(overlay.matrixWorld).invert();
    uniforms.eyeO.value.copy(camera.position).applyMatrix4(uniforms.overlayFromWorld.value);

    // ----- draw -----
    if (LITE) {
      renderer.setRenderTarget(null);
      renderer.clear();
      if (KNOB('dots')) renderer.render(dotsScene, camera);
      renderer.clearDepth();
      renderer.render(scene, camera);
      return endFrame(now);
    }
    renderer.setRenderTarget(targets.dots);
    renderer.clear();
    renderer.render(dotsScene, camera);
    renderer.setRenderTarget(targets.scene);
    renderer.clear();
    renderer.render(scene, camera);

    const foot = centreY * H + D / 2;
    blur(targets.dots, targets.dotsBlur, { sigma: BLUR.dots * pr * softness, clear: 0.5, full: 0.68, gain: 1 + (BLUR.dotsGain - 1) * softness });
    blur(targets.scene, targets.sceneBlur, {
      sigma: BLUR.globe * pr * softness,
      clear: (foot - D * BLUR.above) / H, full: (foot + D * BLUR.below) / H,
    });
    finalMaterial.uniforms.sceneTex.value = targets.sceneBlur.texture;
    finalMaterial.uniforms.dotsTex.value = targets.dotsBlur.texture;
    finalMaterial.uniforms.seed.value = Math.floor(clock * 24) % 1000;
    pass(finalMaterial, null);
    endFrame(now);
  }
  // ?fpslog: frames drawn per second, posted to the server's log every 5s.
  const fpsLog = params.has('fpslog');
  let fpsFrames = 0, fpsSince = 0, worst = 0, lastAt = 0;
  function endFrame(now) {
    dirty = false;
    if (fpsLog) {
      fpsFrames++;
      if (lastAt) worst = Math.max(worst, now - lastAt);
      lastAt = now;
      if (!fpsSince) fpsSince = now;
      if (now - fpsSince >= 5000) {
        const fps = (fpsFrames * 1000 / (now - fpsSince)).toFixed(1);
        fetch(`/fps-log?fps=${fps}&worst=${worst.toFixed(0)}ms&lite=${LITE ? 1 : 0}&size=${W}x${H}&pr=${pr}`).catch(() => {});
        fpsFrames = 0; fpsSince = now; worst = 0;
      }
    }
    if (failed) return fallBack();
    if (visible && !reduceMotion) raf = requestAnimationFrame(frame);
    else last = null;
  }
  function kick() {
    if (!raf && (visible || dirty)) raf = requestAnimationFrame(frame);
  }

  // Only drawn while the section is on screen; the intro once a good part of it is in view, and the
  // line said again each time it comes back after leaving altogether.
  // Engaged by the section's first screen (.redaction_intro), the part the line is said in, so a
  // long write-up after it doesn't keep the section from ever being a good part in view.
  const ENGAGE = 0.35;
  const opening = section.querySelector('.redaction_intro') || section;
  let openingShown = 0;
  new IntersectionObserver(([entry]) => {
    openingShown = entry.intersectionRatio;
    if (openingShown >= ENGAGE && visible) { engaged = true; kick(); }
  }, { threshold: [0, ENGAGE] }).observe(opening);
  const seen = new IntersectionObserver(([entry]) => {
    const wasVisible = visible;
    visible = entry.isIntersecting;
    engaged = (visible && openingShown >= ENGAGE) || (engaged && visible);
    if (!visible && wasVisible && speechAt != null) {
      needsSpeech = true;
      speechAt = null;
      engaged = false;
      if (!reduceMotion) showCaption(SPEECH.text.map(() => 0));
      env = 0; pulse = 1; wrap = 0; softness = 1; bounce = bounceV = 0; waveStartedAt = null; ringAt = null; traceAt = null;
      showState('');
      dotUniforms.ring.value.set(0, 1, 1, 0);
    }
    if (visible) { last = null; kick(); }
  }, { threshold: 0 });
  seen.observe(section);

  // Touching the globe: it gives a little and springs back, and a soft ring runs out over the dots.
  // The stage lets pointers through, so the section hears them; only taps on (or near) the globe count.
  section.addEventListener('pointerdown', (e) => {
    if (reduceMotion || !visible || introAt == null) return;
    const box = stage.getBoundingClientRect();
    const dx = e.clientX - box.left - cx, dy = e.clientY - box.top - centreY * H;
    if (Math.hypot(dx, dy) > D * 0.62) return;
    bounceV += TOUCH.push;
    if (ringAt == null || ringGain < 1) { ringAt = clock; ringGain = TOUCH.ring; ringSwell = TOUCH.swell; }
    kick();
  });
  new ResizeObserver(() => { layout(); kick(); }).observe(stage);
  layout();

  function fallBack() {
    cancelAnimationFrame(raf);
    seen.disconnect();
    stage.dataset.fallback = '';
    showCaption(SPEECH.text.map((l) => l.length));
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

// The section's contents arrive by include (index.html's includeHTML), so wait for them.
function hasWebGL2() {
  const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return !!gl;
}

function whenStageArrives(section, then) {
  const found = section.querySelector('.redaction_stage');
  if (found) return then(found);
  const watch = new MutationObserver(() => {
    const stage = section.querySelector('.redaction_stage');
    if (stage) { watch.disconnect(); then(stage); }
  });
  watch.observe(section, { childList: true, subtree: true });
}

// Nothing is built until the section is within a screen of being scrolled to: not the WebGL
// context, the dots, the render targets (tens of MB of a phone's GPU memory) or the text's
// pictures, so a visit that never gets that far down the page pays nothing for it, and the hero
// has the page to itself as it loads. On /new-modality/ the section is the screen, so it starts at once.
function whenNear(section, then) {
  if (!('IntersectionObserver' in window)) return then();
  const near = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    near.disconnect();
    then();
  }, { rootMargin: '100% 0px' });
  near.observe(section);
}

const section = document.getElementById('new_modality');
if (section) {
  whenStageArrives(section, (stage) => whenNear(section, () => {
    const fallBack = () => {
      stage.dataset.fallback = '';
      buildCaption(stage.querySelector('.redaction_caption'))(SPEECH.text.map((l) => l.length));
    };
    if (!hasWebGL2()) return fallBack();
    try { startGlobe(stage); } catch (err) { console.warn('Redaction project globe unavailable', err); fallBack(); }
  }));
}
