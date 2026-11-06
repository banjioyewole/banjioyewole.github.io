// Lava lamp: raymarched metaball globules with simple lava physics.
//
// Rendering: one full-screen shader raymarches a signed-distance field made of
//   • the four original globules (baked SDF volumes extracted from the old wallpaper), and
//   • spherical/ellipsoidal "wax" globules from the simulation,
// all joined with a smooth minimum, so nearby globules bridge, merge and neck apart
// naturally. It renders at reduced resolution into a render target; colour is upscaled as is,
// but alpha holds the distance to the silhouette, so edges stay sharp at full resolution.
//
// Simulation (JS, screen pixels, y up): globules are heated at the bottom and cool near the
// top, so they rise, slow, drift and mostly gather/escape at the top. Touching globules pull
// together and merge (volume is transferred, so nothing pops); big ones occasionally split.
// Fresh globules are spawned below the screen and float up. The originals hold their exact
// starting composition, then are released one by one and relax into the lava.
import * as THREE from 'three';

const MAXB = 16;                 // simulated wax globules
const NBAKED = 4;                // original shapes
const RES_SCALE = 0.5;           // raymarch resolution relative to the canvas
const SPEED = 0.8;               // how fast the lava lamp runs
const EDGE_LANE = 0.42;          // globules drift toward this fraction of the width from centre

// site palette (sampled from the original hero / globules), cyclic
const PALETTE = ['#ffb52a', '#ff9304', '#f15265', '#d535d3', '#b731fa', '#7353ff', '#3d77ff', '#078eff', '#00dcff'];

const VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

#define MAXB ${MAXB}
#define NB ${NBAKED}

uniform vec2 uView;            // viewport size in CSS px
uniform float uTime;
uniform float uK;              // smooth-union radius (px)
uniform float uEdge;           // distances to the silhouette are stored within ±uEdge (px)
uniform float uNoiseAmp;       // surface wobble (px)
uniform float uZTop;
uniform int uCount;
uniform vec4 uBall[MAXB];      // xyz centre, radius
uniform vec4 uBallB[MAXB];     // stretchY, colour seed, colour dir angle, unused
uniform vec4 uBk[NB];          // x, y, scale, morph (0 = original shape, 1 = round wax)
uniform mat3 uBkRot[NB];       // world → local rotation
uniform vec3 uBkMin[NB];
uniform vec3 uBkMax[NB];
uniform vec4 uBkInfo[NB];      // range, rEq (local px), visible, colour seed
uniform vec2 uBkSize[NB];      // bbox w, h (local px) for colour lookup
uniform sampler3D uSdf;
uniform sampler2D uColor;
uniform vec3 uPal[9];

const float VIVID = 1.2;       // saturation boost on top of the wallpaper's colours

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

vec3 palette(float t) {      // cyclic: … cyan → back to amber, no hard wrap
  t = fract(t) * 9.0;
  int i = int(floor(t));
  float f = smoothstep(0.0, 1.0, fract(t));
  vec3 a = uPal[0], b = uPal[1];
  for (int k = 0; k < 9; k++) { if (k == i) { a = uPal[k]; b = uPal[k == 8 ? 0 : k + 1]; } }
  return mix(a, b, f);
}

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}

// one original globule: baked SDF blended toward a round wax ball as it "melts"
float bakedDist(int b, vec3 p, out vec3 lp) {
  vec4 bk = uBk[b];
  lp = uBkRot[b] * (p - vec3(bk.xy, 0.0)) / bk.z;
  vec3 mn = uBkMin[b], mx = uBkMax[b];
  vec3 uvw = (lp - mn) / (mx - mn);
  vec3 c = clamp(uvw, vec3(0.5 / 96.0, 0.5 / 96.0, 0.5 / 80.0), vec3(1.0 - 0.5 / 96.0, 1.0 - 0.5 / 96.0, 1.0 - 0.5 / 80.0));
  float s = texture(uSdf, vec3((float(b) + c.x) / float(NB), c.y, c.z)).r;
  float d = s * uBkInfo[b].x;          // stored as a fraction of the blob's range
  vec3 half_ = (mx - mn) * 0.5;
  vec3 q = abs(lp - (mn + mx) * 0.5) - half_;
  d += length(max(q, 0.0));
  float dBall = length(lp) - uBkInfo[b].y;
  d = mix(d, dBall, bk.w);
  return d * bk.z;
}

vec3 ballColor(int i, vec3 p) {
  vec4 B = uBall[i]; vec4 X = uBallB[i];
  vec3 dir = vec3(cos(X.z), sin(X.z), 0.35);
  vec3 rel = (p - B.xyz) / max(B.w, 1.0);
  return palette(X.y + 0.3 * dot(rel, dir) + 0.08 * rel.z);
}

vec3 bakedColor(int b, vec3 lp, vec3 p) {
  vec2 sz = uBkSize[b];
  vec2 uv = clamp(lp.xy / sz + 0.5, 0.002, 0.998);
  vec3 tex = texture(uColor, vec2((float(b) + uv.x) / float(NB), uv.y)).rgb;
  vec3 wax = palette(uBkInfo[b].w + 0.3 * dot(lp / max(uBkInfo[b].y, 1.0), vec3(0.7, 0.7, 0.3)));
  return mix(tex, wax, smoothstep(0.02, 0.45, uBk[b].w));
}

int gMask;   // per-pixel set of globules near this ray

float smin(float a, float b, float k, out float h) {
  h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float wobble(vec3 p) {
  return uNoiseAmp * snoise(p * (1.6 / uView.y) + vec3(0.0, -uTime * 0.12, uTime * 0.07));
}

float map(vec3 p) {
  float d = 1e5, h;
  vec3 lp;
  for (int b = 0; b < NB; b++) {
    if ((gMask & (1 << (MAXB + b))) == 0) continue;
    d = smin(bakedDist(b, p, lp), d, uK, h);
  }
  for (int i = 0; i < MAXB; i++) {
    if (i >= uCount) break;
    if ((gMask & (1 << i)) == 0) continue;
    vec4 B = uBall[i]; float st = uBallB[i].x;
    vec3 r = vec3(B.w / sqrt(st), B.w * st, B.w / sqrt(st));
    d = smin(sdEllipsoid(p - B.xyz, r), d, uK, h);
  }
  return d + wobble(p);
}

float gFlat;  // 1 = unlit wallpaper colours (original shapes), 0 = fully lit wax

vec3 mapColor(vec3 p) {
  float d = 1e5, h; vec3 col = vec3(0.0); vec3 lp;
  gFlat = 0.0;
  for (int b = 0; b < NB; b++) {
    if ((gMask & (1 << (MAXB + b))) == 0) continue;
    float db = bakedDist(b, p, lp);
    vec3 cb = bakedColor(b, lp, p);
    d = smin(db, d, uK, h);
    col = mix(col, cb, h);
    gFlat = mix(gFlat, 1.0 - smoothstep(0.0, 0.7, uBk[b].w), h);
  }
  for (int i = 0; i < MAXB; i++) {
    if (i >= uCount) break;
    if ((gMask & (1 << i)) == 0) continue;
    vec4 B = uBall[i]; float st = uBallB[i].x;
    vec3 r = vec3(B.w / sqrt(st), B.w * st, B.w / sqrt(st));
    float di = sdEllipsoid(p - B.xyz, r);
    d = smin(di, d, uK, h);
    col = mix(col, ballColor(i, p), h);
    gFlat = mix(gFlat, 0.0, h);
  }
  return col;
}

void main() {
  vec2 px = (vUv - 0.5) * uView;      // CSS px, origin centre, y up
  // which globules can touch this ray (2D bounds), so the march only evaluates those
  gMask = 0;
  float reach = uK * 1.6 + uNoiseAmp * 1.5;
  for (int i = 0; i < MAXB; i++) {
    if (i >= uCount) break;
    vec4 B = uBall[i]; float st = uBallB[i].x;
    float rr = B.w * max(st, 1.0 / sqrt(st)) + reach;
    if (length(px - B.xy) < rr) gMask |= (1 << i);
  }
  for (int b = 0; b < NB; b++) {
    if (uBkInfo[b].z < 0.5) continue;
    vec3 half_ = (uBkMax[b] - uBkMin[b]) * 0.5;
    float rr = length(half_.xy) * uBk[b].z + reach;
    if (length(px - uBk[b].xy) < rr) gMask |= (1 << (MAXB + b));
  }
  if (gMask == 0) { outColor = vec4(0.0); return; }

  vec3 ro = vec3(px, uZTop);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  float t = 0.0, tBest = 0.0, minD = 1e5;
  bool hit = false;
  for (int s = 0; s < 72; s++) {
    float d = map(ro + rd * t);
    if (d < minD) { minD = d; tBest = t; }
    if (d < 0.4) { hit = true; break; }
    t += d * 0.85;
    if (t > uZTop * 2.0) break;
  }
  float tSurface = hit ? t : tBest;   // where the colour is read

  // Signed distance to the silhouette (negative inside), stored in alpha so the composite can
  // draw a sharp edge at full resolution. Inside: carry on through the blob to find how deep
  // this ray gets; rays well inside stop after a step or two.
  if (hit) {
    float stride = uEdge * 0.5;
    for (int s = 0; s < 6 && minD > -uEdge; s++) {
      t += stride;
      float d = map(ro + rd * t);
      if (d < minD) { minD = d; tBest = t; }
      stride *= 2.0;
    }
  }
  if (minD >= uEdge) { outColor = vec4(0.0); return; }
  if (minD > -uEdge) {               // near the edge: pin down the closest approach
    float w = uEdge * 2.0;
    for (int s = 0; s < 4; s++) {
      float dA = map(ro + rd * (tBest - w)), dB = map(ro + rd * (tBest + w));
      if (dA < minD) { minD = dA; tBest -= w; }
      if (dB < minD) { minD = dB; tBest += w; }
      w *= 0.5;
    }
  }

  vec3 p = ro + rd * tSurface;
  const vec2 e = vec2(1.0, -1.0) * 5.0;  // wide normal stencil (about one voxel) = smooth shading
  vec3 n = normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
  vec3 base = mapColor(p);

  // matte shading, same light as the rest of the hero
  vec3 L = normalize(vec3(-0.6, 0.8, 1.0));
  float diff = max(dot(n, L), 0.0);
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  vec3 col = base * (0.86 + 0.3 * diff) + rim * 0.12 * vec3(1.0, 0.92, 0.7);
  col = mix(col, base, gFlat);       // the opening shapes start flat, like the wallpaper; light fades in as they melt
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, VIVID);
  // pixels just outside the blob keep a colour too, so upscaling never fringes toward black
  outColor = vec4(col, clamp(0.5 - minD / (2.0 * uEdge), 0.0, 1.0));
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;           // size of one render-target pixel, in uv
uniform float uEdge, uDpr;

// bicubic (B-spline, 4 bilinear taps): smooths the stored distance so the edge has no stair-steps
float sampleDistance(vec2 uv) {
  vec2 st = uv / uTexel - 0.5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 w2 = 1.0 - w0 - w1 - w3;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 p0 = (i - 0.5 + w1 / g0) * uTexel;
  vec2 p1 = (i + 1.5 + w3 / g1) * uTexel;
  float a = g0.y * (g0.x * texture(uTex, vec2(p0.x, p0.y)).a + g1.x * texture(uTex, vec2(p1.x, p0.y)).a)
          + g1.y * (g0.x * texture(uTex, vec2(p0.x, p1.y)).a + g1.x * texture(uTex, vec2(p1.x, p1.y)).a);
  return (0.5 - a) * 2.0 * uEdge;
}

void main() {
  float a = clamp(0.5 - sampleDistance(vUv) * uDpr, 0.0, 1.0);   // one device pixel of antialiasing
  outColor = vec4(texture(uTex, vUv).rgb, a);
}`;

function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}

export async function createLava(renderer, baseUrl, { reduceMotion = false } = {}) {
  const meta = await fetch(new URL('blobs.json', baseUrl)).then((r) => r.json());
  const baked = meta.blobs.slice(0, NBAKED);
  const [GX, GY, GZ] = baked[0].grid;

  // ---- baked SDF volumes → one 3D texture (blobs side by side along x) ----
  const imgs = await Promise.all(baked.map((b) => loadImage(new URL(`sdf_${b.name}.png`, baseUrl).href)));
  const vol = new Uint16Array(GX * NBAKED * GY * GZ);   // half floats: filterable and most precise near the surface
  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', { willReadFrequently: true });
  imgs.forEach((img, b) => {
    cv.width = img.width; cv.height = img.height;
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, img.width, img.height).data;
    for (let z = 0; z < GZ; z++) {
      const tr = Math.floor(z / 8), tc = z % 8;
      for (let y = 0; y < GY; y++) {
        for (let x = 0; x < GX; x++) {
          const sx = tc * GX + x, sy = tr * GY + y;
          const o = (sy * img.width + sx) * 4;
          const s = ((px[o] << 4) | (px[o + 1] >> 4)) / 4095 * 2 - 1;
          vol[(z * GY + y) * GX * NBAKED + b * GX + x] = THREE.DataUtils.toHalfFloat(s);
        }
      }
    }
  });
  const sdfTex = new THREE.Data3DTexture(vol, GX * NBAKED, GY, GZ);
  sdfTex.format = THREE.RedFormat;
  sdfTex.type = THREE.HalfFloatType;
  sdfTex.minFilter = sdfTex.magFilter = THREE.LinearFilter;
  sdfTex.wrapS = sdfTex.wrapT = sdfTex.wrapR = THREE.ClampToEdgeWrapping;
  sdfTex.needsUpdate = true;

  const colorTex = await new THREE.TextureLoader().loadAsync(new URL('blob_color_atlas.webp', baseUrl).href);
  colorTex.colorSpace = THREE.NoColorSpace; // shade in display space, written out as-is
  colorTex.minFilter = THREE.LinearFilter;
  colorTex.generateMipmaps = false;

  // ---- materials ----
  const uniforms = {
    uView: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uK: { value: 60 },
    uEdge: { value: 4 },
    uNoiseAmp: { value: 0 },
    uZTop: { value: 1000 },
    uCount: { value: 0 },
    uBall: { value: Array.from({ length: MAXB }, () => new THREE.Vector4()) },
    uBallB: { value: Array.from({ length: MAXB }, () => new THREE.Vector4(1, 0, 0, 0)) },
    uBk: { value: Array.from({ length: NBAKED }, () => new THREE.Vector4()) },
    uBkRot: { value: Array.from({ length: NBAKED }, () => new THREE.Matrix3()) },
    uBkMin: { value: baked.map((b) => new THREE.Vector3(b.box[0], b.box[1], b.box[2])) },
    uBkMax: { value: baked.map((b) => new THREE.Vector3(b.box[3], b.box[4], b.box[5])) },
    uBkInfo: { value: baked.map((b, i) => new THREE.Vector4(b.range, b.rEq, 1, 0.1 + i * 0.23)) },
    uBkSize: { value: baked.map((b) => new THREE.Vector2(b.w, b.h)) },
    uSdf: { value: sdfTex },
    uColor: { value: colorTex },
    uPal: { value: PALETTE.map((c) => new THREE.Color(c)).map((c) => new THREE.Vector3(...c.convertLinearToSRGB().toArray())) }
  };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: 'in vec3 position; in vec2 uv;\n' + VERT, fragmentShader: FRAG, uniforms,
    depthTest: false, depthWrite: false
  }));
  quad.frustumCulled = false;
  const lavaScene = new THREE.Scene(); lavaScene.add(quad);
  const compMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: 'in vec3 position; in vec2 uv;\n' + VERT, fragmentShader: COMPOSITE_FRAG,
    uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uEdge: uniforms.uEdge, uDpr: { value: 1 } }, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  });
  const comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat);
  comp.frustumCulled = false;
  const compScene = new THREE.Scene(); compScene.add(comp);
  const cam = new THREE.Camera();
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  compMat.uniforms.uTex.value = rt.texture;

  // ---- simulation state ----
  let vw = 1, vh = 1;
  const balls = [];
  const bk = baked.map((b, i) => ({
    meta: b, x: 0, y: 0, s: 1, grow: 1, morph: 0, released: false, alive: true,
    vx: 0, vy: 0, temp: 0.55, rot: new THREE.Euler(), spin: [0, 0, 0], phase: i * 1.7 + 0.4,
    releaseAt: [4, 9, 6.5, 11.5][i] ?? 6 + i * 2.5
  }));
  let nextSpawn = 14, seedCounter = 0.37;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const volOf = (r) => r * r * r;           // ∝ volume (constant factor cancels)
  const radOf = (v) => Math.cbrt(Math.max(v, 0));

  function layout(w, h, dpr) {
    const first = vw === 1;
    vw = w; vh = h;
    uniforms.uView.value.set(vw, vh);
    uniforms.uK.value = vh * 0.075;
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
      x: (Math.random() < 0.5 ? -1 : 1) * rnd(0.3, 0.55) * vw, y: fromBottom ? -vh / 2 - r * 1.4 : rnd(-0.5, 0.5) * vh, z: rnd(-0.1, 0.1) * vh,
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
        b.rot.set(Math.sin(t * 0.3 + b.phase) * 0.07, Math.cos(t * 0.25 + b.phase) * 0.09, 0);
        if (t > b.releaseAt) b.released = true;
        continue;
      }
      b.morph = Math.min(1, b.morph + dt / 11);
      physics(b, dt, H, b.meta.rEq * b.s * b.grow);
      b.rot.x += Math.sin(t * 0.13 + b.phase) * 0.05 * dt;
      b.rot.y += Math.cos(t * 0.11 + b.phase) * 0.08 * dt;
      // fully melted → hand over to the regular wax simulation
      if (b.morph >= 1 && balls.length < MAXB) {
        b.alive = false;
        balls.push({ x: b.x, y: b.y, z: 0, r: b.meta.rEq * b.s * b.grow, vx: b.vx, vy: b.vy, temp: b.temp, st: 1,
          seed: (0.1 + bk.indexOf(b) * 0.23) % 1, dirA: 0.785, noMergeUntil: t + 3, absorbInto: null, feed: null, light: bk.indexOf(b) % 2 === 0 });
      }
      if (b.y - b.meta.rEq * b.s > H * 0.5 + H * 0.6) b.alive = false; // floated far away
    }

    // ---- wax globules ----
    for (const a of balls) { a.y += lift; physics(a, dt, H, a.r); }

    // cohesion + merging
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i], b = balls[j];
        if (a.absorbInto || b.absorbInto || a.feed === b || b.feed === a) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const reach = a.r + b.r + uniforms.uK.value;
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
      s.x += (big.x - s.x) * k; s.y += (big.y - s.y) * k; s.z += (big.z - s.z) * k;
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
          x: a.x + rnd(-0.2, 0.2) * a.r, y: a.y + up * a.r * 0.3, z: a.z, r: 1, vx: rnd(-1, 1) * H * 0.01,
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
      if (onScreen < 10) spawn(true);
      // refill quickly if scrolling has lifted most of the lava away
      nextSpawn = t + (onScreen < 4 ? rnd(1, 2.5) : rnd(3, 6));
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
    a.vx += (Math.sin(a.y * 0.004 + (a.seed ?? a.phase) * 10) * H * 0.004 + ((a.x < 0 ? -EDGE_LANE : EDGE_LANE) - a.x / vw) * H * 0.012) * dt;
    const halfW = vw / 2;   // a globule may hang half out of frame, like the old wallpaper
    if (a.x > halfW) a.vx -= (a.x - halfW) * 0.6 * dt; else if (a.x < -halfW) a.vx -= (a.x + halfW) * 0.6 * dt;
    const drag = 1 - Math.exp(-dt / 1.6);
    a.vx -= a.vx * drag; a.vy -= a.vy * drag;
    a.x += a.vx * dt; a.y += a.vy * dt;
    if ('st' in a) a.st += (1 + Math.min(0.35, Math.abs(a.vy) / H * 3) - a.st) * Math.min(1, dt * 2);
  }

  function upload(t, pointer) {
    const u = uniforms;
    u.uTime.value = t;
    const lavaAmt = reduceMotion ? 0 : Math.min(1, Math.max(0, (t - 3) / 8));
    u.uNoiseAmp.value = vh * 0.028 * lavaAmt;
    const px = -pointer.x * 12, py = pointer.y * 10;
    let zTop = 10;
    const n = Math.min(balls.length, MAXB);
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      u.uBall.value[i].set(a.x + px, a.y + py, a.z, a.r);
      u.uBallB.value[i].set(a.st, a.seed, a.dirA, 0);
      zTop = Math.max(zTop, Math.abs(a.z) + a.r * 1.4);
    }
    u.uCount.value = n;
    bk.forEach((b, i) => {
      u.uBk.value[i].set(b.x + px, b.y + py, b.s * b.grow, b.morph);
      u.uBkRot.value[i].setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(b.rot)).transpose();
      u.uBkInfo.value[i].z = b.alive ? 1 : 0;
      const half = (b.meta.box[5] - b.meta.box[2]) / 2;
      if (b.alive) zTop = Math.max(zTop, Math.max(half, b.meta.box[3]) * b.s * b.grow);
    });
    u.uZTop.value = zTop + u.uK.value + u.uNoiseAmp.value * 2;
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

  // adaptive resolution: drop the raymarch resolution on slow GPUs, raise it back when fast
  let quality = 1, slowAcc = 0, fastAcc = 0, lastDpr = 1;
  function adapt(frameMs) {
    if (frameMs > 26) { slowAcc += frameMs; fastAcc = 0; } else if (frameMs < 14) { fastAcc += frameMs; slowAcc = 0; }
    if (slowAcc > 1500 && quality > 0.5) { quality = Math.max(0.5, quality * 0.8); slowAcc = 0; resizeRT(); }
    if (fastAcc > 4000 && quality < 1) { quality = Math.min(1, quality / 0.8); fastAcc = 0; resizeRT(); }
  }
  function resizeRT() {
    const k = RES_SCALE * Math.min(lastDpr, 1.5) * quality;
    const rw = Math.max(1, Math.round(vw * k)), rh = Math.max(1, Math.round(vh * k));
    rt.setSize(rw, rh);
    compMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    compMat.uniforms.uDpr.value = lastDpr;
    uniforms.uEdge.value = 3 / k;   // three render-target pixels, enough for the bicubic footprint
  }

  return {
    layout(w, h, dpr) { lastDpr = dpr; layout(w, h, dpr); resizeRT(); },
    update(dt, scrollDelta, pointer, frameMs = 16) {
      if (!reduceMotion) advance(Math.min(dt, 0.25) * SPEED, scrollDelta);
      upload(simT, pointer);
      if (frameMs) adapt(frameMs);
    },
    render() {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(lavaScene, cam);
      renderer.setRenderTarget(null);
      renderer.render(compScene, cam);
    },
    // debug helpers (exposed as window.__lava with ?debug)
    advance: (sec) => { advance(sec); upload(simT, { x: 0, y: 0 }); },
    debug: () => ({ t: +simT.toFixed(1), balls: balls.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.r)]),
      baked: bk.map((b) => ({ alive: b.alive, released: b.released, morph: +b.morph.toFixed(2) })) })
  };
}
