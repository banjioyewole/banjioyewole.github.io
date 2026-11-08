// The four globules from the old wallpaper. They hold their composition and colours, and float up
// as the page scrolls, each at its own rate as if at its own depth. Position comes directly from
// the scroll offset, so scrolling back to the top returns them exactly to where they started.
//
// Rendering: a 2D signed-distance field of the outlines, with shading baked from the same shapes
// inflated like balloons, so they read as rounded objects. It renders at reduced resolution into a
// render target, only when something moves; colour is upscaled as is, but alpha holds the distance
// to the silhouette, so edges stay sharp at full resolution.
//
// Mouse and trackpad: drawn on the shared canvas, which stays in step with the scroll position.
// Touch screens: iOS moves the page without waiting for JavaScript and reports the scroll late and
// in bursts, so each globule is baked once into its own layer, moved by a scroll-driven animation.
import * as THREE from 'three';

const ORIGINALS = 4;       // the wallpaper's globules, always first in blobs.json
const ATLAS_TILES = 5;     // baked shapes: those, plus tools/blob_extra.png
const RES_SCALE = 0.5;     // shader resolution relative to the layer
const ARRIVAL_ZOOM = 1.06;  // how far they come forward on arrival, and stay
const LIGHT = 0.2;         // how strongly the baked shading affects the wallpaper's colours
const VIVID = 1.2;         // saturation boost on top of the wallpaper's colours
const NAME_GAP = 0.02;   // least space between the name and a bottom globule, as a share of the height
// how far each blob rises per px scrolled (nearer blobs move faster)
const RISE = { tl: 0.5, tr: 0.32, bl: 0.62, br: 0.24 };
// More globules further down the page, reusing those shapes. Each passes through the middle of the
// screen after scrolling `at` screenfuls: x is a fraction of the width from centre, size is relative
// to the original shape, and mirror flips it so it doesn't read as a copy.
// atBottom instead of at: it ends up centred on the screen's bottom edge when the page is scrolled
// all the way down, so half of it shows. turn rotates it anticlockwise, in degrees.
const FURTHER_DOWN = [
  { shape: 'br', at: 2.5, x: -0.44, size: 1.5, rise: 0.3, mirror: true },
  { shape: 'tr', at: 5.5, x: 0.5, size: 0.8, rise: 0.26, mirror: true },
  { shape: 'tl', at: 7, x: -0.5, size: 0.8, rise: 0.28, mirror: false },
  { shape: 'extra', atBottom: true, x: 0.42, size: 0.8, rise: 0.3, mirror: false, turn: 90 }
];
const NB = ORIGINALS + FURTHER_DOWN.length;

const VERT = /* glsl */`
in vec3 position; in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
#define NB ${NB}
#define ATLAS_TILES ${ATLAS_TILES}.0
uniform vec2 uView;            // viewport size in CSS px
uniform float uEdge;           // distances to the silhouette are stored within ±uEdge (px)
uniform vec4 uBk[NB];          // x, y, scale, x mirror (1 or -1)
uniform float uBkTile[NB];     // which baked shape
uniform vec2 uBkTurn[NB];      // cos, sin of its anticlockwise rotation
uniform float uBkRange[NB];    // distances are stored as a fraction of this (local px)
uniform vec2 uBkSize[NB];      // bbox w, h (local px)
uniform sampler2D uSdf;
uniform sampler2D uShade;
uniform vec2 uSdfInset;        // half a texel of one atlas tile, in tile uv
uniform sampler2D uColor;

vec2 toLocal(int b, vec2 p) {
  vec2 q = (p - uBk[b].xy) / uBk[b].z;
  vec2 t = uBkTurn[b];
  return vec2(q.x * t.x + q.y * t.y, q.y * t.x - q.x * t.y) * vec2(uBk[b].w, 1.0);
}

float blobDist(int b, vec2 p) {
  vec2 lp = toLocal(b, p);
  vec2 sz = uBkSize[b];
  vec2 c = clamp(lp / sz + 0.5, uSdfInset, 1.0 - uSdfInset);
  float d = texture(uSdf, vec2((uBkTile[b] + c.x) / ATLAS_TILES, c.y)).r * uBkRange[b];
  d += length(max(abs(lp) - sz * 0.5, 0.0));   // outside the baked box
  return d * uBk[b].z;
}

// nearest blob to this pixel
float nearest(vec2 p, out int which) {
  float d = 1e5;
  which = -1;
  for (int b = 0; b < NB; b++) {
    if (length(p - uBk[b].xy) > length(uBkSize[b] * 0.5) * uBk[b].z + uEdge) continue;
    float db = blobDist(b, p);
    if (db < d) { d = db; which = b; }
  }
  return d;
}

void main() {
  vec2 p = (vUv - 0.5) * uView;      // CSS px, origin centre, y up
  int b;
  float d = nearest(p, b);
  if (b < 0 || d >= uEdge) { outColor = vec4(0.0); return; }

  vec2 lp = toLocal(b, p);
  vec3 base = texture(uColor, vec2((uBkTile[b] + clamp(lp.x / uBkSize[b].x + 0.5, 0.002, 0.998)) / ATLAS_TILES,
                                   clamp(lp.y / uBkSize[b].y + 0.5, 0.002, 0.998))).rgb;

  vec2 c = clamp(lp / uBkSize[b] + 0.5, uSdfInset, 1.0 - uSdfInset);
  float shade = texture(uShade, vec2((uBkTile[b] + c.x) / ATLAS_TILES, c.y)).r * 1.5 - 1.0;
  vec3 col = base * (1.0 + ${LIGHT.toFixed(2)} * shade);   // unchanged where the surface faces the viewer

  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, ${VIVID.toFixed(2)});
  // pixels just outside the blob keep a colour too, so upscaling never fringes toward black
  outColor = vec4(col, clamp(0.5 - d / (2.0 * uEdge), 0.0, 1.0));
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

export async function createBlobs(renderer, baseUrl) {
  const meta = await fetch(new URL('blobs.json', baseUrl)).then((r) => r.json());
  const baked = meta.blobs.slice(0, ATLAS_TILES), originals = baked.slice(0, ORIGINALS);
  const tileOf = (name) => baked.findIndex((b) => b.name === name);
  const shapes = [...originals.map((b, tile) => ({ tile, b, extraSize: 1, mirror: 1 })),
    ...FURTHER_DOWN.map((e) => ({ tile: tileOf(e.shape), b: baked[tileOf(e.shape)], extraSize: e.size, mirror: e.mirror ? -1 : 1 }))];

  // ---- baked outlines: one atlas, blobs side by side; red + green hold a 12-bit distance ----
  const img = await loadImage(new URL('sdf_atlas.png', baseUrl).href);
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, img.width, img.height).data;
  const sdf = new Uint16Array(img.width * img.height);   // half floats: filterable and most precise near the edge
  const shade = new Uint8Array(img.width * img.height);
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = THREE.DataUtils.toHalfFloat(((px[i * 4] << 4) | (px[i * 4 + 1] >> 4)) / 4095 * 2 - 1);
    shade[i] = px[i * 4 + 2];
  }
  // each original's outline, row by row: the leftmost and rightmost columns inside it (-1 if none).
  // Row 0 is the bottom of the shape, as the shader samples it.
  const tileW = img.width / ATLAS_TILES;
  const spans = originals.map((_, tile) => Array.from({ length: img.height }, (_, row) => {
    let lo = -1, hi = -1;
    for (let col = 0; col < tileW; col++) {
      const i = (row * img.width + tile * tileW + col) * 4;
      if (((px[i] << 4) | (px[i + 1] >> 4)) / 4095 * 2 - 1 < 0) { if (lo < 0) lo = col; hi = col; }
    }
    return [lo, hi];
  }));
  const sdfTex = new THREE.DataTexture(sdf, img.width, img.height, THREE.RedFormat, THREE.HalfFloatType);
  sdfTex.minFilter = sdfTex.magFilter = THREE.LinearFilter;
  sdfTex.wrapS = sdfTex.wrapT = THREE.ClampToEdgeWrapping;
  sdfTex.needsUpdate = true;
  const shadeTex = new THREE.DataTexture(shade, img.width, img.height, THREE.RedFormat, THREE.UnsignedByteType);
  shadeTex.minFilter = shadeTex.magFilter = THREE.LinearFilter;
  shadeTex.wrapS = shadeTex.wrapT = THREE.ClampToEdgeWrapping;
  shadeTex.unpackAlignment = 1;
  shadeTex.needsUpdate = true;

  const colorTex = await new THREE.TextureLoader().loadAsync(new URL('blob_color_atlas.webp', baseUrl).href);
  colorTex.colorSpace = THREE.NoColorSpace; // shade in display space, written out as-is
  colorTex.minFilter = THREE.LinearFilter;
  colorTex.generateMipmaps = false;

  const uEdge = { value: 4 };
  const uniforms = {
    uView: { value: new THREE.Vector2(1, 1) },
    uEdge,
    uBk: { value: shapes.map(() => new THREE.Vector4()) },
    uBkTile: { value: shapes.map((s) => s.tile) },
    uBkTurn: { value: [...originals.map(() => new THREE.Vector2(1, 0)),
      ...FURTHER_DOWN.map((e) => new THREE.Vector2(Math.cos((e.turn || 0) * Math.PI / 180), Math.sin((e.turn || 0) * Math.PI / 180)))] },
    uBkRange: { value: shapes.map((s) => s.b.range) },
    uBkSize: { value: shapes.map((s) => new THREE.Vector2(s.b.w, s.b.h)) },
    uSdf: { value: sdfTex },
    uShade: { value: shadeTex },
    uSdfInset: { value: new THREE.Vector2(0.5 * ATLAS_TILES / img.width, 0.5 / img.height) },
    uColor: { value: colorTex }
  };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms, depthTest: false, depthWrite: false
  }));
  quad.frustumCulled = false;
  const fieldScene = new THREE.Scene(); fieldScene.add(quad);
  const compMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
    uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uEdge, uDpr: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false,
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

  const layered = 'ScrollTimeline' in window && matchMedia('(pointer: coarse)').matches;
  const page = document.scrollingElement;   // <body>: this page has no doctype, so it's in quirks mode
  let vw = 1, vh = 1, dpr = 1, home = [], scale = 1, maxScroll = 0, layers = [], timeline = null;
  let dirty = true, drawnAt = null, drawnArrival = null, centerY = 0;
  let host = null;
  if (layered) {
    host = document.createElement('div');
    host.className = 'hero3d-globules';
    host.setAttribute('aria-hidden', 'true');
    document.body.prepend(host);
  }

  // Where a globule's centre sits with the page scrolled by `offset`: CSS px, origin centre, y up
  function positionAt(index, offset) {
    if (index < ORIGINALS) return { x: home[index].x, y: home[index].y + offset * RISE[shapes[index].b.name] };
    const extra = FURTHER_DOWN[index - ORIGINALS];
    const settlesAt = extra.atBottom ? maxScroll : extra.at * vh, settledY = extra.atBottom ? -vh / 2 : 0;
    if (extra.atBottom) {   // undo the arrival zoom, so it still ends up where it's meant to
      return { x: (extra.x * vw) / ARRIVAL_ZOOM, y: (offset - settlesAt) * extra.rise + centerY + (settledY - centerY) / ARRIVAL_ZOOM };
    }
    return { x: extra.x * vw, y: (offset - settlesAt) * extra.rise + settledY };
  }

  function transformAt({ index, w, h }, offset) {
    const { x, y } = positionAt(index, offset);
    return `translate(${(vw / 2 + x - w / 2).toFixed(2)}px, ${(vh / 2 - y - h / 2).toFixed(2)}px)`;
  }

  const keyframes = (layer) => [{ transform: transformAt(layer, 0) }, { transform: transformAt(layer, maxScroll) }];

  // the page's height changes as its sections and images load
  function measurePage() {
    maxScroll = Math.max(0, page.scrollHeight - page.clientHeight);
    dirty = true;
    for (const layer of layers) layer.animation.effect.setKeyframes(keyframes(layer));
  }
  const pageObserver = new ResizeObserver(measurePage);
  pageObserver.observe(document.body);

  function bakeLayer(index) {
    const extra = index < ORIGINALS ? null : FURTHER_DOWN[index - ORIGINALS];
    const { b, extraSize, mirror } = shapes[index], size = scale * extraSize;
    const turn = ((extra?.turn || 0) * Math.PI) / 180, cos = Math.abs(Math.cos(turn)), sin = Math.abs(Math.sin(turn));
    const w = Math.ceil((cos * b.w + sin * b.h) * size + 8), h = Math.ceil((sin * b.w + cos * b.h) * size + 8);

    renderer.setSize(w, h, false);
    uniforms.uView.value.set(w, h);
    uniforms.uBk.value.forEach((v) => v.set(1e7, 1e7, 1e-3, 1));   // everything else out of the way
    uniforms.uBk.value[index].set(0, 0, size, mirror);
    const k = RES_SCALE * Math.min(dpr, 1.5);
    const rw = Math.max(1, Math.round(w * k)), rh = Math.max(1, Math.round(h * k));
    rt.setSize(rw, rh);
    compMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(fieldScene, cam);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(compScene, cam);

    const el = document.createElement('canvas');
    el.className = 'hero3d-globule';
    el.width = renderer.domElement.width;
    el.height = renderer.domElement.height;
    el.getContext('2d', { colorSpace: 'display-p3' }).drawImage(renderer.domElement, 0, 0);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    host.append(el);
    return { el, index, w, h, animation: null };
  }

  function removeLayers() {
    layers.forEach((layer) => layer.el.remove());
    layers = [];
  }

  // Borrows the canvas to draw on, so the caller has to redraw it afterwards.
  function bake() {
    if (!layered) return;
    removeLayers();
    layers = shapes.map((_, index) => bakeLayer(index));
    renderer.setSize(vw, renderer.domElement.clientHeight, false);
    timeline ||= new ScrollTimeline({ source: page, axis: 'block' });
    maxScroll = Math.max(0, page.scrollHeight - page.clientHeight);
    for (const layer of layers) {
      // in place by itself too: the animation has no effect whenever the timeline is inactive
      layer.el.style.transform = transformAt(layer, page.scrollTop);
      layer.animation = layer.el.animate(keyframes(layer), { timeline, fill: 'both', easing: 'linear' });
    }
  }

  return {
    layered,
    layout(w, h, ratio, vanishingY, nameBox) {
      vw = w; vh = h; dpr = ratio;
      centerY = vh / 2 - vanishingY;
      if (host) host.style.transformOrigin = `${vw / 2}px ${vanishingY}px`;
      uniforms.uView.value.set(vw, vh);
      // same placement as the old wallpaper, corner-anchored on narrow screens
      const iw = meta.imageW, ih = meta.imageH;
      scale = Math.min(Math.max(vw / iw, vh / ih), (vw / iw) * (vw < vh ? 1.3 : 1.7));
      home = originals.map((m, tile) => {
        const left = m.name[1] === 'l', top = m.name[0] === 't';
        let cxp = left ? (m.x + m.w / 2) * scale : vw - (iw - (m.x + m.w / 2)) * scale;
        let cyp = top ? (m.y + m.h / 2) * scale : vh - (ih - (m.y + m.h / 2)) * scale;
        // a bottom globule whose box reaches up beside the name drops until it's clear, with a gap
        if (!top && nameBox) {
          const boxLeft = cxp - (m.w / 2) * scale, boxRight = cxp + (m.w / 2) * scale;
          if (boxRight > nameBox.left && boxLeft < nameBox.right) {
            cyp += Math.max(0, nameBox.bottom + NAME_GAP * vh - (cyp - (m.h / 2) * scale));
          }
        }
        // a top globule whose outline reaches down beside the name slides out toward its edge until
        // that part clears the end of the name. Only the rows level with the name count.
        if (top && nameBox) {
          let reach = left ? -Infinity : Infinity;
          spans[tile].forEach(([lo, hi], row) => {
            if (lo < 0) return;
            const y = cyp - ((row + 0.5) / img.height - 0.5) * m.h * scale;   // screen y, down
            if (y < nameBox.top - NAME_GAP * vh || y > nameBox.bottom + NAME_GAP * vh) return;
            const x = (col) => cxp + ((col + 0.5) / tileW - 0.5) * m.w * scale;
            reach = left ? Math.max(reach, x(hi)) : Math.min(reach, x(lo));
          });
          if (left) cxp -= Math.max(0, reach - (nameBox.left - NAME_GAP * vh));
          else cxp += Math.max(0, nameBox.right + NAME_GAP * vh - reach);
        }
        return { x: cxp - vw / 2, y: vh / 2 - cyp };
      });
      const k = RES_SCALE * Math.min(dpr, 1.5);
      const rw = Math.max(1, Math.round(vw * k)), rh = Math.max(1, Math.round(vh * k));
      rt.setSize(rw, rh);
      compMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
      compMat.uniforms.uDpr.value = dpr;
      uEdge.value = 3 / k;   // three render-target pixels, enough for the bicubic footprint
      dirty = true;
      if (layers.length) bake();
    },
    // Starts the shaders compiling without blocking the page; resolves when they're ready.
    compile() {
      renderer.setRenderTarget(rt);   // shaders are compiled per kind of output, so match the bake
      const field = renderer.compileAsync(fieldScene, cam);
      renderer.setRenderTarget(null);
      return Promise.all([field, renderer.compileAsync(compScene, cam)]);
    },
    bake,
    // Layers come forward by themselves, on the same timing as `render` gets from the page.
    arrive({ delay, duration }) {
      host?.animate([{ transform: 'scale(1)' }, { transform: `scale(${ARRIVAL_ZOOM})` }],
        { delay, duration, fill: 'both', easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });   // same curve as js/hero3d.js
    },
    // arrived: 0 to 1, how far they've come forward
    render(offset, arrived) {
      if (layered) return;
      if (dirty || offset !== drawnAt || arrived !== drawnArrival) {   // nothing moves between scrolls
        const zoom = 1 + (ARRIVAL_ZOOM - 1) * arrived;
        shapes.forEach(({ extraSize, mirror }, index) => {
          const { x, y } = positionAt(index, offset);
          uniforms.uBk.value[index].set(x * zoom, centerY + (y - centerY) * zoom, scale * extraSize * zoom, mirror);
        });
        drawnAt = offset; drawnArrival = arrived; dirty = false;
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(fieldScene, cam);
        renderer.setRenderTarget(null);
      }
      renderer.render(compScene, cam);
    },
    remove() {
      pageObserver.disconnect();
      removeLayers();
      host?.remove();
    }
  };
}
