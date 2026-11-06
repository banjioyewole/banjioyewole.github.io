// A moving recreation of the long-exposure star streaks in assets/reigonalpha6.jpg. Numbers below
// were measured from that image: streaks sit 12.5° off vertical, the bright end is always at the
// top, and brightness and width fall off from a wide head into a hair-thin tail. Stars travel
// head-first: up and slightly to the right.
//
// Every star is drawn in one instanced draw call and moves in the vertex shader, so JavaScript
// does no per-star work after setup. (Stamping them from a 2D canvas held a Raspberry Pi 5 to
// 15fps; without them it ran at 69.)
import * as THREE from 'three';

const TILT = 12.5 * Math.PI / 180;
const SPEED = 0.15;       // overall drift speed
const PARALLAX = 0.08;    // stars scroll with the page, far slower than it
const MARGIN = 80;        // stars wrap this far off screen, so their tails clear the edge first
const WARM_SHARE = 0.015; // a rare few stars burn a slightly warmer white

// Four populations, sized in CSS px for a 1440-wide window (the image's scale at that width).
// headW/tailW are half-widths; halo is the bloom around the brightest heads.
const TIERS = [
  { share: 0.38, len: [16, 38], headW: 0.42, tailW: 0.2, alpha: [0.3, 0.7], core: 0, halo: 0, colors: ['#6f97b0', '#5f8cb0', '#7ea3bd', '#4f86bb'] },
  { share: 0.10, len: [20, 40], headW: 0.62, tailW: 0.2, alpha: [0.7, 0.95], core: 0.3, halo: 1.8, colors: ['#5aa2ea', '#4a8dff', '#74b6ee', '#3d7bff'] },
  { share: 0.02, len: [28, 52], headW: 0.95, tailW: 0.22, alpha: [0.95, 1], core: 0.9, halo: 3.2, colors: ['#8fd3f3', '#a5dcff', '#6aa6ff', '#cfe4ff'] },
  // the far background: half of all stars, too dim to pick out one by one
  { share: 0.50, len: [10, 28], headW: 0.3, tailW: 0.14, alpha: [0.14, 0.34], core: 0, halo: 0, colors: ['#6f97b0', '#5f8cb0', '#7ea3bd', '#4f86bb'] }
];
const WARM_COLORS = ['#ffe9cf', '#ffe2c0', '#ffeedb'];

// The canvas is Display P3 (for the blobs); these stay the same colour they'd be in sRGB.
function p3(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return [
    0.8225 * lin[0] + 0.1775 * lin[1],
    0.0332 * lin[0] + 0.9669 * lin[1],
    0.0171 * lin[0] + 0.0724 * lin[1] + 0.9108 * lin[2]
  ].map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

const VERT = /* glsl */`
precision highp float;
in vec3 position;          // unit quad: x -1..1, y 0..1
in vec2 iStart;
in vec4 iShape;            // length, head half-width, tail half-width, speed
in vec4 iLook;             // alpha, core, halo, warm
in vec3 iColor;
uniform vec2 uView;
uniform float uTime, uLift, uMargin;
uniform vec2 uDir;
out vec2 vP;               // px from the head: x across, y down the tail
flat out vec4 vShape;
flat out vec4 vLook;
flat out vec3 vColor;
void main() {
  float reach = max(iLook.z, iShape.y) + 2.0;
  vec2 local = vec2(position.x * reach, mix(-reach, iShape.x + 2.0, position.y));
  vec2 travelled = iStart + uDir * iShape.w * uTime + vec2(0.0, -uLift);
  vec2 span = uView + 2.0 * uMargin;
  vec2 head = mod(travelled + uMargin, span) - uMargin;
  // tail runs down and to the left of the head
  vec2 screen = head + vec2(local.x * -uDir.y - local.y * uDir.x, local.x * uDir.x - local.y * uDir.y);
  gl_Position = vec4(screen.x / uView.x * 2.0 - 1.0, 1.0 - screen.y / uView.y * 2.0, 0.0, 1.0);
  vP = local; vShape = iShape; vLook = iLook; vColor = iColor;
}`;

const FRAG = /* glsl */`
precision highp float;
in vec2 vP;
flat in vec4 vShape;
flat in vec4 vLook;
flat in vec3 vColor;
uniform float uPx;         // one device pixel, in CSS px
out vec4 outColor;

// a head-up teardrop: round cap at (0, 0), curving in to a thin tail at (0, len)
float teardrop(vec2 p, float headW, float tailW, float len) {
  float halfWidth, edge;
  if (p.y < 0.0) { edge = length(p); halfWidth = headW; }
  else {
    float t = clamp(p.y / len, 0.0, 1.0);
    edge = abs(p.x);
    halfWidth = mix(tailW, headW, pow(1.0 - t, 2.6));
    if (p.y > len) return 0.0;
  }
  // hairlines thinner than a pixel get dimmer rather than vanishing between pixels
  return clamp((halfWidth - edge) / uPx + 0.5, 0.0, 1.0) * min(1.0, 2.0 * halfWidth / uPx);
}

void main() {
  float len = vShape.x, headW = vShape.y, tailW = vShape.z;
  float alpha = vLook.x, core = vLook.y, halo = vLook.z, warm = vLook.w;
  vec3 haloColor = mix(vec3(0.078, 0.353, 1.0), vec3(1.0, 0.831, 0.647), warm);
  vec3 coreColor = mix(vec3(0.922, 0.973, 1.0), vec3(1.0, 0.965, 0.91), warm);
  float t = vP.y / len;
  vec3 col = vec3(0.0);

  if (halo > 0.0) {            // bloom round the head, and a fainter sheath down the tail
    float r = length(vP) / halo;
    float bloom = r < 0.45 ? mix(0.5, 0.22, r / 0.45) : mix(0.22, 0.0, min((r - 0.45) / 0.55, 1.0));
    float sheath = teardrop(vP, headW * 1.7, tailW, len * 0.65) * 0.3 * max(1.0 - max(t, 0.0) / 0.65, 0.0);
    col += haloColor * alpha * (bloom + sheath);
  }
  // body: brightness falls off nearly linearly from head to tail, as in the photo
  float fade = t < 0.55 ? mix(1.0, 0.6, max(t, 0.0) / 0.55) : mix(0.6, 0.0, (t - 0.55) / 0.45);
  col += vColor * alpha * fade * teardrop(vP, headW, tailW, len);
  // near-white hot core inside the head
  if (core > 0.0) col += coreColor * alpha * core * max(1.0 - max(t, 0.0) / 0.45, 0.0) * teardrop(vP, headW * 0.6, tailW * 0.6, len * 0.45);

  outColor = vec4(col, max(col.r, max(col.g, col.b)));
}`;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];

export function createStars(renderer) {
  const uniforms = {
    uView: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uLift: { value: 0 },
    uMargin: { value: MARGIN },
    uPx: { value: 1 },
    uDir: { value: new THREE.Vector2(Math.sin(TILT), -Math.cos(TILT)) }
  };
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geometry, new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    // overlapping streaks add up, like light on film
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor
  }));
  mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  const cam = new THREE.Camera();

  function seed(w, h) {
    // the photo is drawn "cover", so its streaks scale with the window
    const scale = Math.min(1.6, Math.max(0.75, Math.max(w / 1440, h / 900)));
    const count = Math.round((w * h) / (310 * scale * scale));
    const start = new Float32Array(count * 2), shape = new Float32Array(count * 4);
    const look = new Float32Array(count * 4), color = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      let r = Math.random(), k = 0;
      while (k < TIERS.length - 1 && r > TIERS[k].share) { r -= TIERS[k].share; k++; }
      const tier = TIERS[k], warm = Math.random() < WARM_SHARE;
      const len = rand(tier.len[0], tier.len[1]);
      start.set([rand(0, w + 2 * MARGIN), rand(0, h + 2 * MARGIN)], i * 2);
      // px/s; longer streaks move faster
      shape.set([len * scale, tier.headW * scale, tier.tailW * scale, len * rand(0.9, 1.6) * SPEED], i * 4);
      look.set([rand(tier.alpha[0], tier.alpha[1]), tier.core, tier.halo * scale, warm ? 1 : 0], i * 4);
      color.set(p3(pick(warm ? WARM_COLORS : tier.colors)), i * 3);
    }
    geometry.setAttribute('iStart', new THREE.InstancedBufferAttribute(start, 2));
    geometry.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 4));
    geometry.setAttribute('iLook', new THREE.InstancedBufferAttribute(look, 4));
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
    geometry.instanceCount = count;
  }

  let seededW = 0, seededH = 0;
  return {
    compile: () => renderer.compileAsync(scene, cam),
    layout(w, h, dpr) {
      uniforms.uView.value.set(w, h);
      uniforms.uPx.value = 1 / dpr;
      if (w !== seededW || Math.abs(h - seededH) > 160) { // ignore mobile URL-bar jitter
        seededW = w; seededH = h;
        seed(w, h);
      }
    },
    render(t, scrollOffset) {
      uniforms.uTime.value = t;
      uniforms.uLift.value = scrollOffset * PARALLAX;
      renderer.render(scene, cam);
    }
  };
}
