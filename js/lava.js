// Lava lamp, pre-rendered for phones: 2D metaballs with a 3D-shaded surface.
//
// Every globule is drawn as ONE small quad into a low-resolution half-float buffer, adding up
// a smooth "field" (additive blending): wax globules use a cheap procedural falloff, the four
// original shapes use field sprites pre-rendered offline (tools/make_blobs.py). Where fields
// overlap they sum, so globules bridge, merge and neck apart for free. A single full-resolution
// pass then thresholds the field into crisp silhouettes and shades them using a height derived
// from the field — a few texture reads per pixel instead of raymarching.
//
// Simulation (JS, screen px, y up): globules are heated at the bottom and cool near the top, so
// they rise, slow, drift and mostly gather/escape at the top. Touching globules pull together and
// merge (area is transferred, so nothing pops); big ones occasionally split. Fresh globules
// spawn below the screen. The originals hold their exact starting composition, then are
// released one by one and melt into the lava.
import * as THREE from 'three';

const MAXB = 16;                 // simulated wax globules
const NBAKED = 4;                // original shapes
const RES_SCALE = 0.4;           // field buffer resolution relative to CSS px
const T = 0.25;                  // surface threshold of the field

// site palette (sampled from the original hero / globules), cyclic
const PALETTE = ['#ffb52a', '#ff9304', '#f15265', '#d535d3', '#b731fa', '#7353ff', '#3d77ff', '#078eff', '#00dcff'];

const PALETTE_GLSL = /* glsl */`
uniform vec3 uPal[9];
vec3 palette(float t) {      // cyclic: … cyan → back to amber, no hard wrap
  t = fract(t) * 9.0;
  int i = int(floor(t));
  float f = smoothstep(0.0, 1.0, fract(t));
  vec3 a = uPal[0], b = uPal[1];
  for (int k = 0; k < 9; k++) { if (k == i) { a = uPal[k]; b = uPal[k == 8 ? 0 : k + 1]; } }
  return mix(a, b, f);
}`;

const COMMON_GLSL = /* glsl */`
precision highp float;
uniform vec2 uView;
uniform float uTime;
uniform float uWob;          // wobble amplitude (px)
uniform sampler2D uNoise;    // tiling smooth noise (pre-generated)
vec2 wobble(vec2 world) {
  vec2 p = world / uView.y * 0.7;
  vec2 n = texture(uNoise, p * 0.9 + vec2(0.013 * uTime, -0.021 * uTime)).rg
         + texture(uNoise, p * 1.7 + vec2(-0.017 * uTime, -0.011 * uTime)).gr * 0.5;
  return (n / 1.5 - 0.5) * 2.0 * uWob;
}`;

// ---- wax globules: instanced quads, procedural falloff A·(1-x²)² ----
const BALL_VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec4 iA;   // x, y, Rx, Ry (field radius, px)
in vec4 iB;   // colour seed, colour direction, amplitude, weight
uniform vec2 uView;
out vec2 vQ; out vec2 vWorld; flat out vec4 vB; flat out vec2 vR;
void main() {
  vec2 q = position.xy * 1.3;                 // margin for the wobble
  vec2 world = iA.xy + q * iA.zw;
  vQ = q; vWorld = world; vB = iB; vR = iA.zw;
  gl_Position = vec4(world / (uView * 0.5), 0.0, 1.0);
}`;
const BALL_FRAG = /* glsl */`
${COMMON_GLSL}
${PALETTE_GLSL}
in vec2 vQ; in vec2 vWorld; flat in vec4 vB; flat in vec2 vR;
out vec4 outColor;
void main() {
  vec2 q = vQ + wobble(vWorld) / vR;
  float x2 = dot(q, q);
  if (x2 >= 1.0) discard;
  float k = 1.0 - x2;
  float F = vB.z * k * k * vB.w;
  vec3 col = palette(vB.x + 0.3 * dot(q, vec2(cos(vB.y), sin(vB.y))));
  outColor = vec4(col * F, F);
}`;

// ---- the four originals: pre-rendered 16-bit field sprites + colour atlas ----
const BAKED_VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
uniform vec2 uView;
uniform vec4 uC;      // x, y, scale, angle
uniform vec4 uBox;    // field box in local px: x0, y0, x1, y1
out vec2 vLocal; out vec2 vWorld;
void main() {
  vec2 local = mix(uBox.xy, uBox.zw, uv);
  float c = cos(uC.w), s = sin(uC.w);
  vec2 world = uC.xy + mat2(c, s, -s, c) * local * uC.z;
  vLocal = local; vWorld = world;
  gl_Position = vec4(world / (uView * 0.5), 0.0, 1.0);
}`;
const BAKED_FRAG = /* glsl */`
${COMMON_GLSL}
uniform sampler2D uField;  // RG = 16-bit field, row 0 = bottom
uniform sampler2D uColor;  // atlas: 4 blobs side by side
uniform vec4 uBox;
uniform vec4 uC;
uniform vec2 uSize;        // blob bbox w, h (local px)
uniform float uIdx;
uniform float uAmp;        // dome amplitude (taller for bigger globules)
uniform float uWeight;     // fades out as it melts into wax
in vec2 vLocal; in vec2 vWorld;
out vec4 outColor;
float fieldAt(ivec2 p, ivec2 sz) {
  vec2 rg = texelFetch(uField, clamp(p, ivec2(0), sz - 1), 0).rg;
  return (rg.r * 65280.0 + rg.g * 255.0) / 65535.0;
}
void main() {
  vec2 local = vLocal + wobble(vWorld) / uC.z;
  ivec2 sz = textureSize(uField, 0);
  vec2 f = (local - uBox.xy) / (uBox.zw - uBox.xy) * vec2(sz) - 0.5;   // manual bilinear (16-bit decode)
  ivec2 i0 = ivec2(floor(f)); vec2 w = fract(f);
  float F = mix(mix(fieldAt(i0, sz), fieldAt(i0 + ivec2(1, 0), sz), w.x),
                mix(fieldAt(i0 + ivec2(0, 1), sz), fieldAt(i0 + ivec2(1, 1), sz), w.x), w.y);
  // taller dome for bigger globules, eased in so the field has no kink at the edge
  float g = mix(1.0, (uAmp - ${T.toFixed(2)}) / ${(1 - T).toFixed(2)}, smoothstep(0.0, 0.35, F - ${T.toFixed(2)}));
  if (F > ${T.toFixed(2)}) F = ${T.toFixed(2)} + (F - ${T.toFixed(2)}) * g;
  F *= uWeight;
  if (F <= 0.0) discard;
  vec2 cuv = clamp(local / uSize + 0.5, 0.002, 0.998);
  vec3 col = texture(uColor, vec2((uIdx + cuv.x) / 4.0, cuv.y)).rgb;
  outColor = vec4(col * F, F);
}`;

// ---- full-resolution pass: threshold + shade ----
const COMP_VERT = /* glsl */`
precision highp float;
in vec3 position; in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const COMP_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;       // 1 / field buffer size
uniform float uPxPerTexel; // CSS px per field texel
uniform float uHs;         // height scale (px)
float hOf(float F) { return sqrt(max(F - ${T.toFixed(2)}, 0.0) / ${(1 - T).toFixed(2)}); }
// bicubic B-spline from 4 bilinear taps: smooth outlines from the low-res field
vec4 bicubic(vec2 uv) {
  vec2 tsz = 1.0 / uTexel;
  vec2 st = uv * tsz - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 c0 = (i - 0.5 + w1 / s0) * uTexel, c1 = (i + 1.5 + w3 / s1) * uTexel;
  return mix(mix(texture(uTex, vec2(c0.x, c0.y)), texture(uTex, vec2(c1.x, c0.y)), s1.x / (s0.x + s1.x)),
             mix(texture(uTex, vec2(c0.x, c1.y)), texture(uTex, vec2(c1.x, c1.y)), s1.x / (s0.x + s1.x)),
             s1.y / (s0.y + s1.y));
}
void main() {
  vec4 s0 = texture(uTex, vUv);
  if (s0.a < ${(T * 0.5).toFixed(3)}) { outColor = vec4(0.0); return; }   // cheap early-out away from globules
  vec4 s = bicubic(vUv);
  float F = s.a;
  float e = fwidth(F) * 0.8 + 1e-4;
  float a = smoothstep(${T.toFixed(2)} - e, ${T.toFixed(2)} + e, F);
  if (a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 base = s.rgb / max(F, 1e-4);
  float hl = hOf(texture(uTex, vUv - vec2(uTexel.x, 0.0)).a), hr = hOf(texture(uTex, vUv + vec2(uTexel.x, 0.0)).a);
  float hd = hOf(texture(uTex, vUv - vec2(0.0, uTexel.y)).a), hu = hOf(texture(uTex, vUv + vec2(0.0, uTexel.y)).a);
  float k = uHs / (2.0 * uPxPerTexel);
  vec3 n = normalize(vec3(-(hr - hl) * k, -(hu - hd) * k, 1.0));
  // matte shading, same light as the rest of the hero
  vec3 L = normalize(vec3(-0.6, 0.8, 1.0));
  float diff = max(dot(n, L), 0.0);
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  vec3 col = base * (0.62 + 0.48 * diff) + rim * 0.22 * vec3(1.0, 0.92, 0.7);
  outColor = vec4(col, a);
}`;

function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}

// tiling smooth value noise (RG), generated once at start-up
function makeNoiseTexture(size = 128, cells = 8) {
  const data = new Uint8Array(size * size * 4);
  const lat = [0, 1].map(() => Array.from({ length: cells * cells }, () => Math.random()));
  const lat2 = [0, 1].map(() => Array.from({ length: cells * 2 * cells * 2 }, () => Math.random()));
  const fade = (t) => t * t * (3 - 2 * t);
  const sample = (L, n, x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
    const g = (i, j) => L[((j % n + n) % n) * n + ((i % n + n) % n)];
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 2; c++) {
        const v = sample(lat[c], cells, (x / size) * cells, (y / size) * cells) * 0.7 +
                  sample(lat2[c], cells * 2, (x / size) * cells * 2, (y / size) * cells * 2) * 0.3;
        data[(y * size + x) * 4 + c] = Math.round(v * 255);
      }
      data[(y * size + x) * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export async function createLava(renderer, baseUrl, { reduceMotion = false } = {}) {
  const meta = await fetch(new URL('blobs.json', baseUrl)).then((r) => r.json());
  const baked = meta.blobs.slice(0, NBAKED);
  const texLoader = new THREE.TextureLoader();
  const [fieldTexs, colorTex] = await Promise.all([
    Promise.all(baked.map(async (b) => {
      const t = await texLoader.loadAsync(new URL(`field_${b.name}.png`, baseUrl).href);
      t.flipY = false;                       // PNG row 0 is already the bottom
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = t.magFilter = THREE.NearestFilter; // decoded + filtered by hand
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    })),
    texLoader.loadAsync(new URL('blob_color_atlas.webp', baseUrl).href)
  ]);
  colorTex.colorSpace = THREE.NoColorSpace; // shade in display space, written out as-is
  colorTex.minFilter = THREE.LinearFilter;
  colorTex.generateMipmaps = false;

  const shared = {
    uView: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uWob: { value: 0 },
    uNoise: { value: makeNoiseTexture() },
    uPal: { value: PALETTE.map((c) => new THREE.Color(c)).map((c) => new THREE.Vector3(...c.convertLinearToSRGB().toArray())) }
  };
  const additive = {
    glslVersion: THREE.GLSL3, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor
  };

  // wax globules: one instanced draw
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const ballGeo = new THREE.InstancedBufferGeometry();
  ballGeo.index = quadGeo.index;
  ballGeo.setAttribute('position', quadGeo.getAttribute('position'));
  const iA = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 4), 4);
  const iB = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 4), 4);
  iA.setUsage(THREE.DynamicDrawUsage); iB.setUsage(THREE.DynamicDrawUsage);
  ballGeo.setAttribute('iA', iA); ballGeo.setAttribute('iB', iB);
  ballGeo.instanceCount = 0;
  const ballMesh = new THREE.Mesh(ballGeo, new THREE.RawShaderMaterial({ ...additive, vertexShader: BALL_VERT, fragmentShader: BALL_FRAG, uniforms: shared }));
  ballMesh.frustumCulled = false;

  // originals: one quad each
  const bakedMeshes = baked.map((b, i) => {
    const mat = new THREE.RawShaderMaterial({
      ...additive, vertexShader: BAKED_VERT, fragmentShader: BAKED_FRAG,
      uniforms: {
        ...shared,
        uField: { value: fieldTexs[i] }, uColor: { value: colorTex },
        uBox: { value: new THREE.Vector4(b.field.x0, b.field.y0, b.field.x1, b.field.y1) },
        uC: { value: new THREE.Vector4() }, uSize: { value: new THREE.Vector2(b.w, b.h) },
        uIdx: { value: i }, uAmp: { value: 1 }, uWeight: { value: 1 }
      }
    });
    const m = new THREE.Mesh(quadGeo, mat);
    m.frustumCulled = false;
    return m;
  });

  const fieldScene = new THREE.Scene();
  bakedMeshes.forEach((m) => fieldScene.add(m));
  fieldScene.add(ballMesh);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  const compUniforms = {
    uTex: { value: rt.texture }, uTexel: { value: new THREE.Vector2() },
    uPxPerTexel: { value: 1 }, uHs: { value: 60 }
  };
  const comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: COMP_VERT, fragmentShader: COMP_FRAG, uniforms: compUniforms,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  }));
  comp.frustumCulled = false;
  const compScene = new THREE.Scene(); compScene.add(comp);
  const cam = new THREE.Camera();

  // ---- simulation state ----
  let vw = 1, vh = 1;
  const balls = [];
  const bk = baked.map((b, i) => ({
    meta: b, x: 0, y: 0, s: 1, grow: 1, morph: 0, released: false, alive: true,
    vx: 0, vy: 0, temp: 0.55, angle: 0, phase: i * 1.7 + 0.4,
    releaseAt: [4, 9, 6.5, 11.5][i] ?? 6 + i * 2.5
  }));
  let nextSpawn = 14, seedCounter = 0.37;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const volOf = (r) => r * r;               // 2D: area ∝ r² (constant factor cancels)
  const radOf = (v) => Math.sqrt(Math.max(v, 0));
  // dome amplitude grows with size so big globules look as round as small ones
  const ampOf = (r) => 1 + (r / (vh * 0.07)) ** 2;
  // field radius that puts the threshold (the visible edge) at r for amplitude A
  const fieldR = (r, A) => r / Math.sqrt(1 - Math.sqrt(T / A));

  function layout(w, h) {
    const first = vw === 1;
    vw = w; vh = h;
    shared.uView.value.set(vw, vh);
    // originals: same placement as before (old wallpaper, corner-anchored on narrow screens)
    const iw = meta.imageW, ih = meta.imageH;
    const s = Math.min(Math.max(vw / iw, vh / ih), (vw / iw) * (vw < vh ? 1.3 : 1.7));
    for (const b of bk) {
      if (b.released && !first) continue;
      const m = b.meta;
      const left = m.name[1] === 'l', top = m.name[0] === 't';
      const cxp = left ? (m.x + m.w / 2) * s : vw - (iw - (m.x + m.w / 2)) * s;
      const cyp = top ? (m.y + m.h / 2) * s : vh - (ih - (m.y + m.h / 2)) * s;
      b.homeX = cxp - vw / 2; b.homeY = vh / 2 - cyp; b.s = s;
      if (!b.released) { b.x = b.homeX; b.y = b.homeY; }
    }
  }

  function spawn(fromBottom = true) {
    if (balls.length >= MAXB) return;
    const r = vh * rnd(0.04, 0.085);
    balls.push({
      x: rnd(-0.42, 0.42) * vw, y: fromBottom ? -vh / 2 - r * 1.4 : rnd(-0.5, 0.5) * vh,
      r, vx: 0, vy: vh * 0.02, temp: 1, st: 1, seed: (seedCounter = (seedCounter + 0.382) % 1), dirA: rnd(0, 6.283),
      noMergeUntil: 0, absorbInto: null, feed: null, light: Math.random() < 0.4
    });
  }

  function step(t, dt, scrollDelta) {
    const H = vh;
    // parallax: scrolling lifts the whole lava layer, slower than the page
    const lift = scrollDelta * 0.35;

    // ---- originals: hold the composition, then melt into the lava one by one ----
    for (const b of bk) {
      if (!b.alive) continue;
      b.y += lift; b.homeY += lift;
      if (!b.released) {
        // gentle idle float while still in the opening composition
        b.x = b.homeX + Math.sin(t * 0.4 + b.phase) * 6;
        b.y = b.homeY + Math.sin(t * 0.55 + b.phase) * 9;
        b.angle = Math.sin(t * 0.3 + b.phase) * 0.035;
        if (t > b.releaseAt) b.released = true;
        continue;
      }
      b.morph = Math.min(1, b.morph + dt / 11);
      physics(b, dt, H, b.meta.r2d * b.s * b.grow);
      b.angle += Math.sin(t * 0.13 + b.phase) * 0.05 * dt;
      // fully melted → hand over to the regular wax simulation
      if (b.morph >= 1 && balls.length < MAXB) {
        b.alive = false;
        balls.push({ x: b.x, y: b.y, r: b.meta.r2d * b.s * b.grow, vx: b.vx, vy: b.vy, temp: b.temp, st: 1,
          seed: (0.1 + bk.indexOf(b) * 0.23) % 1, dirA: 0.785, noMergeUntil: t + 3, absorbInto: null, feed: null, light: bk.indexOf(b) % 2 === 0 });
      }
      if (b.y - b.meta.r2d * b.s > H * 0.5 + H * 0.6) b.alive = false; // floated far away
    }

    // ---- wax globules ----
    for (const a of balls) { a.y += lift; physics(a, dt, H, a.r); }

    // cohesion + merging
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i], b = balls[j];
        if (a.absorbInto || b.absorbInto || a.feed === b || b.feed === a) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const reach = (a.r + b.r) * 1.25;
        if (d < reach && t > a.noMergeUntil && t > b.noMergeUntil) {
          const pull = H * 0.012 * (1 - d / reach);
          a.vx += (dx / d) * pull * dt * (b.r / (a.r + b.r)) * 20; a.vy += (dy / d) * pull * dt * (b.r / (a.r + b.r)) * 20;
          b.vx -= (dx / d) * pull * dt * (a.r / (a.r + b.r)) * 20; b.vy -= (dy / d) * pull * dt * (a.r / (a.r + b.r)) * 20;
          if (d < (a.r + b.r) * 0.6) { // close enough: the bigger one swallows the smaller
            const [big, small] = a.r >= b.r ? [a, b] : [b, a];
            small.absorbInto = big;
          }
        }
      }
    }
    for (const s of balls) {
      if (!s.absorbInto) continue;
      const big = s.absorbInto;
      const vT = volOf(s.r) + volOf(big.r);
      const move = Math.min(volOf(s.r), vT * 0.35 * dt);
      s.r = radOf(volOf(s.r) - move); big.r = radOf(volOf(big.r) + move);
      const k = Math.min(1, dt * 1.6);
      s.x += (big.x - s.x) * k; s.y += (big.y - s.y) * k;
      big.vx = (big.vx * big.r + s.vx * s.r) / (big.r + s.r); big.vy = (big.vy * big.r + s.vy * s.r) / (big.r + s.r);
    }

    // splitting: large globules occasionally bud off a piece that drifts away
    for (const a of [...balls]) {
      if (a.feed && a.feed.feedLeft > 0) {
        const c = a.feed, move = Math.min(c.feedLeft, volOf(a.r) * 0.5 * dt);
        a.r = radOf(volOf(a.r) - move); c.r = radOf(volOf(c.r) + move); c.feedLeft -= move;
        if (c.feedLeft <= 1e-3) { a.feed = null; }
      }
      if (a.absorbInto || a.feed || balls.length >= MAXB) continue;
      if (a.r > H * 0.13 && Math.random() < dt * 0.16 * (a.r / (H * 0.13))) {
        const frac = rnd(0.3, 0.5), up = Math.random() < 0.6 ? 1 : -1;
        const c = {
          x: a.x + rnd(-0.2, 0.2) * a.r, y: a.y + up * a.r * 0.3, r: 1, vx: rnd(-1, 1) * H * 0.01,
          vy: up * H * 0.035, temp: up > 0 ? 1 : 0.1, st: 1, seed: (a.seed + rnd(0.08, 0.2)) % 1, dirA: a.dirA + 1.3,
          noMergeUntil: t + 9, absorbInto: null, feed: null, feedLeft: volOf(a.r) * frac, light: up > 0 && Math.random() < 0.5
        };
        a.vy -= up * H * 0.012; a.noMergeUntil = t + 9; a.feed = c;
        balls.push(c);
      }
    }

    // remove absorbed / escaped globules
    for (let i = balls.length - 1; i >= 0; i--) {
      const a = balls[i];
      const gone = (a.absorbInto && a.r < Math.max(3, a.absorbInto.r * 0.12)) ||
        a.y - a.r > H * 0.5 + H * 0.35 || a.y + a.r < -H * 0.5 - H * 0.9;
      if (gone) {
        if (a.absorbInto) a.absorbInto.r = radOf(volOf(a.absorbInto.r) + volOf(a.r));
        for (const o of balls) { if (o.absorbInto === a) o.absorbInto = null; if (o.feed === a) o.feed = null; }
        balls.splice(i, 1);
      }
    }

    // fresh globules from the bottom, once the opening composition has started melting
    const onScreen = balls.filter((b) => Math.abs(b.y) < H * 0.6).length + bk.filter((b) => b.alive && b.released).length;
    if (t > nextSpawn) {
      if (onScreen < 7) spawn(true);
      // refill quickly if scrolling has lifted most of the lava away
      nextSpawn = t + (onScreen < 4 ? rnd(1, 2.5) : rnd(4, 9));
    }
  }

  // buoyant wax: hot at the bottom, cools near the top; viscous drag; walls
  function physics(a, dt, H, r) {
    const yn = a.y / H; // -0.5 bottom … 0.5 top
    // heater below, cooling above: hot wax rises, cools at the top and sinks back down
    const target = yn < -0.28 ? 1 : yn > 0.28 ? 0 : a.temp;
    a.temp += (target - a.temp) * (1 - Math.exp(-dt / 6));
    // "light" globules stay buoyant and drift off the top; fresh ones replace them from below
    const ay = (a.temp - 0.42 + (a.light ? 0.3 : 0)) * H * 0.045;
    a.vy += ay * dt;
    a.vx += (Math.sin(a.y * 0.004 + (a.seed ?? a.phase) * 10) * H * 0.004 - (a.x / vw) * H * 0.012) * dt;
    const halfW = vw / 2 - r * 0.4;
    if (a.x > halfW) a.vx -= (a.x - halfW) * 0.6 * dt; else if (a.x < -halfW) a.vx -= (a.x + halfW) * 0.6 * dt;
    const drag = 1 - Math.exp(-dt / 1.6);
    a.vx -= a.vx * drag; a.vy -= a.vy * drag;
    a.x += a.vx * dt; a.y += a.vy * dt;
    if ('st' in a) a.st += (1 + Math.min(0.35, Math.abs(a.vy) / H * 3) - a.st) * Math.min(1, dt * 2);
  }

  function upload(t, pointer) {
    shared.uTime.value = t;
    const lavaAmt = reduceMotion ? 0 : Math.min(1, Math.max(0, (t - 3) / 8));
    shared.uWob.value = vh * 0.012 * lavaAmt;
    const px = -pointer.x * 12, py = pointer.y * 10;

    // wax globules (+ the round wax each original is melting into)
    let n = 0;
    const put = (x, y, r, st, seed, dirA, weight) => {
      if (n >= MAXB) return;
      const A = ampOf(r), R = fieldR(r, A);
      iA.setXYZW(n, x + px, y + py, R / Math.sqrt(st), R * st);
      iB.setXYZW(n, seed, dirA, A, weight);
      n++;
    };
    for (const a of balls) put(a.x, a.y, a.r, a.st, a.seed, a.dirA, 1);
    bk.forEach((b, i) => {
      const m = bakedMeshes[i], u = m.material.uniforms;
      m.visible = b.alive;
      if (!b.alive) return;
      const r = b.meta.r2d * b.s * b.grow;
      u.uC.value.set(b.x + px, b.y + py, b.s * b.grow, b.angle);
      u.uAmp.value = ampOf(r);
      u.uWeight.value = 1 - b.morph;
      if (b.morph > 0) put(b.x, b.y, r, 1, (0.1 + i * 0.23) % 1, 0.785, b.morph);
    });
    ballGeo.instanceCount = n;
    iA.needsUpdate = true; iB.needsUpdate = true;
  }

  // the lava keeps its own clock so a slow frame never skips physics
  let simT = 0;
  function advance(dt, scrollDelta = 0) {
    let left = dt, first = true;
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 30);
      simT += h;
      step(simT, h, first ? scrollDelta : 0);
      first = false; left -= h;
    }
  }

  // adaptive resolution of the field buffer (the full-res pass is already cheap)
  let quality = 1, slowAcc = 0, fastAcc = 0;
  function adapt(frameMs) {
    if (frameMs > 22) { slowAcc += frameMs; fastAcc = 0; } else if (frameMs < 14) { fastAcc += frameMs; slowAcc = 0; }
    if (slowAcc > 1500 && quality > 0.5) { quality = Math.max(0.5, quality * 0.8); slowAcc = 0; resizeRT(); }
    if (fastAcc > 4000 && quality < 1) { quality = Math.min(1, quality / 0.8); fastAcc = 0; resizeRT(); }
  }
  function resizeRT() {
    const k = RES_SCALE * quality;
    const w = Math.max(1, Math.round(vw * k)), h = Math.max(1, Math.round(vh * k));
    rt.setSize(w, h);
    compUniforms.uTexel.value.set(1 / w, 1 / h);
    compUniforms.uPxPerTexel.value = vw / w;
    compUniforms.uHs.value = vh * 0.07;
  }

  return {
    layout(w, h) { layout(w, h); resizeRT(); },
    update(dt, scrollDelta, pointer, frameMs = 16) {
      if (!reduceMotion) advance(Math.min(dt, 0.25), scrollDelta);
      upload(simT, pointer);
      if (frameMs) adapt(frameMs);
    },
    render() {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(fieldScene, cam);
      renderer.setRenderTarget(null);
      renderer.render(compScene, cam);
    },
    // debug helpers (exposed as window.__lava with ?debug)
    advance: (sec) => { advance(sec); upload(simT, { x: 0, y: 0 }); },
    debug: () => ({ t: +simT.toFixed(1), balls: balls.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.r)]),
      baked: bk.map((b) => ({ alive: b.alive, released: b.released, morph: +b.morph.toFixed(2) })) })
  };
}
