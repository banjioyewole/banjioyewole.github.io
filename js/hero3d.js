// Hero: 3D globules + extruded name/tagline.
// Globules: see js/blobs.js (the old wallpaper's shapes, floating up as the page scrolls).
// Back to front: a fixed canvas (stars → globules → film grain), then the name's canvas, which scrolls
// with the page. The name draws walls → film grain → white letter faces, so grain covers everything
// except the faces. Touch screens move the globules as layers instead (js/blobs.js), with their own
// grain layer between those and the name.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/FontLoader.js';
import { TextGeometry } from 'three/addons/TextGeometry.js';
import { createBlobs } from './blobs.js';
import { createStars } from './stars.js';

export const BASE = new URL('../assets/hero3d/', import.meta.url);

// Gradient sampled from the old hero exactly as it rendered on the page
// (assets/HERO_SAPPHIRE.png over black), left → right in 1/16 steps.
const GRADIENT = [
  '#ffb52a', '#ff9304', '#f96c5f', '#f15265', '#d535d3', '#b731fa', '#af41e3', '#934cf2',
  '#7353ff', '#5464ff', '#3d77ff', '#3875ff', '#078eff', '#0596ff', '#01b4ff', '#00dcff', '#00f0ff'
].map((c) => new THREE.Color(c));

function gradientAt(t, out) {
  t = Math.min(1, Math.max(0, t)) * (GRADIENT.length - 1);
  const i = Math.min(GRADIENT.length - 2, Math.floor(t));
  return out.copy(GRADIENT[i]).lerp(GRADIENT[i + 1], t - i);
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const GRAIN_FPS = 24;

// Dynamic film grain. One noise tile; ~24 times a second it jumps to a random offset, so the
// grain "boils" like film. Two blends, so it never greys the colours:
//  • over anything already drawn (globules, extrusion walls): multiply, which only changes
//    brightness, keeping hue and saturation, and leaves black alone
//  • where the canvas is still empty (the sky): a faint light/dark speckle
function createGrain(renderer, { sky }) {
  const TILE = 512, MULTIPLY = 0.035, SKY = 0.1;
  const data = new Uint8Array(TILE * TILE * 4);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  for (let i = 0; i < data.length; i += 4) {
    const g = gauss(), s = gauss();
    const a = Math.min(1, Math.abs(s) * 70 / 255) * SKY;
    data[i] = Math.max(0, Math.min(255, (0.5 + g * MULTIPLY / 2) * 255));   // R: multiply factor, 0.5 = no change
    data[i + 1] = s > 0 ? a * 255 : 0;                                      // G: sky speckle (premultiplied)
    data[i + 3] = a * 255;                                                  // A: sky speckle coverage
  }
  const tile = new THREE.DataTexture(data, TILE, TILE, THREE.RGBAFormat);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.minFilter = tile.magFilter = THREE.NearestFilter;
  tile.needsUpdate = true;

  const uniforms = { uTile: { value: tile }, uOffset: { value: new THREE.Vector2() }, uScale: { value: 1 } };
  const scene = new THREE.Scene();
  const pass = (output, blending, order) => {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;
        uniform sampler2D uTile; uniform vec2 uOffset; uniform float uScale;
        out vec4 outColor;
        void main() { vec4 t = texture(uTile, gl_FragCoord.xy * uScale + uOffset); outColor = ${output}; }`,
      uniforms, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, ...blending
    }));
    quad.frustumCulled = false;
    quad.renderOrder = order;
    scene.add(quad);
  };
  // result = 2 × factor × what's there; alpha untouched
  pass('vec4(t.rrr, 0.0)', { blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }, 1);
  // drawn behind what's there, so it only lands on the empty part of the canvas
  if (sky) pass('vec4(t.ggg, t.a)', { blendSrc: THREE.OneMinusDstAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneMinusDstAlphaFactor, blendDstAlpha: THREE.OneFactor }, 2);
  const cam = new THREE.Camera();
  let last = -Infinity;
  return {
    compile: () => renderer.compileAsync(scene, cam),
    render(now) {
      if (now - last >= 1000 / GRAIN_FPS) { last = now; uniforms.uOffset.value.set(Math.random(), Math.random()); }
      // 1 grain per CSS pixel, or 2 on low-resolution displays, where that's too fine to see
      const lowRes = Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1) < 1000;
      uniforms.uScale.value = 1 / ((lowRes ? 2 : 1) * renderer.getPixelRatio() * TILE);
      renderer.render(scene, cam);
    }
  };
}

// Grain over the globule layers on touch screens: a faint dark speckle (which darkens without changing hue) that the
// browser jumps around by itself. Layers can't multiply into each other without a lot of compositing.
function createGrainLayer() {
  const TILE = 512, STRENGTH = 0.05, JUMPS = 12;
  const tile = document.createElement('canvas');
  tile.width = tile.height = TILE;
  const cx = tile.getContext('2d'), image = cx.createImageData(TILE, TILE);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = Math.min(255, Math.abs(gauss()) * STRENGTH * 255);
  cx.putImageData(image, 0, 0);
  const layer = document.createElement('div');
  layer.className = 'hero3d-grain';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.backgroundImage = `url(${tile.toDataURL()})`;
  const offset = () => Math.floor(Math.random() * TILE);
  layer.animate(Array.from({ length: JUMPS }, () => ({ transform: `translate(${offset()}px, ${offset()}px)`, easing: 'steps(1, end)' })),
    { duration: (JUMPS / GRAIN_FPS) * 1000, iterations: Infinity });
  return layer;
}

// How long this device gets to prove it can run the hero. Failing either means the static design.
const COMPILE_BUDGET_MS = 5000;              // shaders must compile within this
const STRETCH_START = 0.2, STRETCH_DELAY = 0.15, STRETCH_SECONDS = 2.2;   // the name's colours stretching back on arrival
const SPEED_CHECK = { settleMs: 500, windowMs: 3000, minFps: 18 };   // measured once live
// Touch screens report scroll late and in uneven bursts, so what follows it eases toward each report.
// A mouse or trackpad's scroll is drawn as it's reported, which keeps it in step with the page.
const GLIDE_MS = matchMedia('(pointer: coarse)').matches ? 90 : 0;

function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  // Never more than the screen's real pixels. Without a viewport tag, iOS lays the page out 980px
  // wide and scales it down, so devicePixelRatio alone asks for over twice what the screen shows.
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(Math.min(dpr, 2, dpr * (window.visualViewport?.scale || 1)));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Wide-gamut screens show these same values more saturated, for extra vividness. Browsers or
  // screens without Display P3 just stay in sRGB.
  renderer.getContext().drawingBufferColorSpace = 'display-p3';
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;
  return renderer;
}

export async function initHero(canvas, nameCanvas, hero, { force = false, signal, onLive, onGiveUp }) {
  const renderer = createRenderer(canvas);
  const nameRenderer = createRenderer(nameCanvas);

  // Giving up has to stop everything: hidden but still running, this costs almost as much as
  // showing it (measured on a Raspberry Pi 5: ~10fps while running, 70+ once truly stopped).
  let stopped = false;
  const listeners = new AbortController();
  let resizeObserver = null;
  let removeLayers = () => {};
  function giveUp(reason) {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    resizeObserver?.disconnect();
    removeLayers();
    for (const r of [renderer, nameRenderer]) {
      r.dispose();
      r.forceContextLoss();   // releases the GPU memory now, not whenever GC gets to it
    }
    onGiveUp(reason);
  }
  signal?.addEventListener('abort', () => giveUp('load-timeout'), { once: true });
  renderer.debug.onShaderError = nameRenderer.debug.onShaderError = (gl, program, vs, fs) => {
    console.error('Live hero shader failed', gl.getProgramInfoLog(program), gl.getShaderInfoLog(fs));
    giveUp('shader-error');
  };

  function addLights(target) {
    target.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.6, 0.8, 1);
    target.add(key);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 0.8);
    rim.position.set(0.8, -0.4, 0.6);
    target.add(rim);
  }

  const [blobs, fontJson] = await Promise.all([
    createBlobs(renderer, BASE),
    fetch(new URL('hero_compact_text.json', BASE)).then((r) => r.json())
  ]);
  if (stopped) return;

  // ---------- Name + tagline ----------
  // Same size and placement as the old flat artwork (assets/HERO_SAPPHIRE.png), seen by a
  // perspective camera centred on the name: every letter extrudes straight back toward one
  // fixed vanishing point, so walls only show on the inner sides (never past the outer letters).
  // Everything below is laid out in that artwork's pixel space (2707 × 386).
  const ART_W = 2707, ART_H = 386;
  const ART = {
    title: { x0: 1, x1: 2705, y0: 1, y1: 234 },     // white letter faces in the artwork
    tagline: { x0: 543, x1: 2143, y0: 282, y1: 383 }
  };
  const DEPTH_ART = 1400;                   // ~6× the title's cap height (233): a long run back
  const TEXT_FOV = 34;

  const font = new FontLoader().parse(fontJson);
  const textScene = new THREE.Scene();
  addLights(textScene);
  const text = new THREE.Group();
    textScene.add(text);
  const textCamera = new THREE.PerspectiveCamera(TEXT_FOV, 1, 10, 20000);

  const SIZE = 100;
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  // walls: mostly self-lit gradient with only a little diffuse shading, so they stay as saturated as the artwork
  const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x3a3a3a, roughness: 0.9, metalness: 0 });
  wallMat.onBeforeCompile = (shader) => {
    // keep the walls as saturated as the 2D gradient: add the vertex colour back in as glow
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n totalEmissiveRadiance = vColor.rgb * 0.85;'
    );
  };

  function glyphBox(ch) {
    const g = new THREE.ShapeGeometry(font.generateShapes(ch, SIZE));
    g.computeBoundingBox();
    const b = g.boundingBox.clone();
    g.dispose();
    return b;
  }

  // Knobs for matching the artwork: grow the outline (bevelOffset, no actual bevel: a bevel would
  // make the walls wider than the face, leaving a coloured outline) and stretch horizontally.
  const EMBOLDEN = 0;   // font units at SIZE 100
  const STRETCH_X = 1.01;

  // Fit a line of text into a box of the artwork: height sets the scale,
  // and letter-spacing is solved so the width matches too.
  function buildLine(str, box) {
    const chars = Array.from(str);
    const toSize = (units) => (units / font.data.resolution) * SIZE;
    // each letter's advance, plus the font's kerning with the letter after it (O–Y is the big one)
    const adv = chars.map((ch, i) => toSize(font.data.glyphs[ch].ha + (font.data.kern[ch + chars[i + 1]] || 0)));
    const boxes = chars.map((ch) => (ch === ' ' ? null : glyphBox(ch)));
    const ink = boxes.filter(Boolean);
    const E = EMBOLDEN;
    const yMin = Math.min(...ink.map((b) => b.min.y)) - E, yMax = Math.max(...ink.map((b) => b.max.y)) + E;
    const k = (box.y1 - box.y0) / (yMax - yMin);
    const kx = k * STRETCH_X;
    const lastAdv = adv.slice(0, -1).reduce((a, c) => a + c, 0);
    const w0 = lastAdv + (boxes[boxes.length - 1].max.x + E) - (boxes[0].min.x - E);
    const extra = ((box.x1 - box.x0) / kx - w0) / (chars.length - 1);

    const depth = DEPTH_ART / k;
    const line = new THREE.Group();
    const meshes = [];
    let x = 0;
    chars.forEach((ch, i) => {
      if (ch !== ' ') {
        const geo = new TextGeometry(ch, {
          font, size: SIZE, depth, curveSegments: 2,
          bevelEnabled: true, bevelThickness: 0, bevelSize: 0, bevelOffset: EMBOLDEN, bevelSegments: 1
        });
        geo.translate(0, 0, -depth); // front face at z = 0, extrusion goes back
        const m = new THREE.Mesh(geo, [capMat, wallMat]);
        m.position.x = x;
        line.add(m);
        meshes.push(m);
      }
      x += adv[i] + extra;
    });
    line.scale.set(kx, k, k);
    // artwork pixel space (y down) → group space centred on the artwork (y up)
    line.position.set(box.x0 - ART_W / 2 - kx * (boxes[0].min.x - E), (ART_H / 2 - box.y1) - k * yMin, 0);
    return { line, meshes, depth };
  }

  const title = buildLine('BANJI OYEWOLE', ART.title);
  const tagline = buildLine('SOFTWARE CHEF', ART.tagline);
  text.add(title.line, tagline.line);

  // colour the extrusion walls by x across the artwork, darker toward the back
  const tmp = new THREE.Color();
  const v = new THREE.Vector3();
  text.updateMatrixWorld(true);
  for (const { meshes, depth } of [title, tagline]) {
    for (const m of meshes) {
      const p = m.geometry.attributes.position;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        gradientAt((v.x + ART_W / 2) / ART_W, tmp);
        const back = Math.min(1, Math.max(0, -p.getZ(i) / depth));
        tmp.multiplyScalar(1 - back * 0.55);
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
      m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
  }

  // Front faces are pinned at 1 world unit = 1 CSS px.
  let textCenterY = 0, textDist = 1, textK = 1;

  // ---------- Layout ----------
  let vw = 1, vh = 1, nameDrawnAt = null;
  function layout() {
    // the canvas is fixed to the viewport: globules stay behind the whole site
    vw = Math.max(1, canvas.clientWidth); vh = Math.max(1, canvas.clientHeight);
    renderer.setSize(vw, vh, false);
    nameRenderer.setSize(vw, vh, false);
    nameDrawnAt = null;   // resizing wipes the canvas
    blobs.layout(vw, vh, renderer.getPixelRatio());
    stars.layout(vw, vh, renderer.getPixelRatio());

    // text: same box as the old <img class="hero-transparent">: 80% wide (max 1440px),
    // centred horizontally, vertically centred at 45% of the hero (top: -10%; bottom: 0)
    textK = Math.min(vw * 0.8, 1440) / ART_W;
    text.scale.setScalar(textK);
    // vanishing point = centre of the name + tagline block (fixed on screen)
    textCenterY = vh / 2 - vh * 0.45;
    text.position.set(0, textCenterY, 0);
    textCamera.aspect = vw / vh;
    textDist = (vh / 2) / Math.tan(THREE.MathUtils.degToRad(TEXT_FOV / 2));
    textCamera.far = textDist + DEPTH_ART * textK * 2 + 1000;
    textCamera.position.set(0, textCenterY, textDist);
  }

  // ---------- Interaction / animation ----------
  // Scrolling: the name keeps facing the viewer, but the vanishing point stays put on the
  // screen while the hero scrolls away, so more of the rear extrusion is revealed.
  let scrollOffset = 0;
  const readScroll = () => { scrollOffset = Math.max(0, -hero.getBoundingClientRect().top); };
  let running = false;
  window.addEventListener('scroll', () => { readScroll(); if (reduceMotion && running) frame(); },
    { passive: true, signal: listeners.signal });

  const grain = createGrain(renderer, { sky: true });
  const nameGrain = createGrain(nameRenderer, { sky: false });   // the sky is already behind it
  const stars = createStars(renderer);
  const clock = new THREE.Clock();
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // On arrival the colours stretch back from STRETCH_START of their length. Perspective squeezes
  // the far end of the depth, so this eases the length seen on screen and converts that to a depth.
  function arrival(t) {
    if (reduceMotion) return 1;
    const x = Math.min(1, Math.max(0, (t - STRETCH_DELAY) / STRETCH_SECONDS));
    const full = DEPTH_ART * textK, fullOnScreen = full / (textDist + full);
    const onScreen = (STRETCH_START + (1 - STRETCH_START) * x * x * (3 - 2 * x)) * fullOnScreen;   // gentle start and finish
    // never exactly zero: a flat scale can't be inverted for lighting
    return Math.max(0.002, (onScreen * textDist / (1 - onScreen)) / full);
  }

  let glide = 0, glidedAt = 0, nameGrainAt = 0;
  function frame() {
    const t = reduceMotion ? 0 : clock.getElapsedTime();

    // ---- name: scrolls away with the hero, always face-on ----
    // The vanishing point stays fixed on screen, so scrolling reveals the underside of the
    // extrusion. The "lie": the extrusion shortens as you scroll, so it never reaches absurd
    // lengths once the letters are far from the vanishing point.
    const sv = scrollOffset / vh;
    text.position.y = textCenterY + scrollOffset;
    text.scale.z = textK * (1 - 0.88 * smooth(0, 1.1, sv)) * arrival(t);
    text.visible = sv < 1.6;

    // ---- behind the page: glides toward the reported scroll position ----
    const now = performance.now(), dt = Math.min(100, now - glidedAt);
    glidedAt = now;
    glide = reduceMotion || !GLIDE_MS ? scrollOffset : glide + (scrollOffset - glide) * (1 - Math.exp(-dt / GLIDE_MS));
    if (Math.abs(scrollOffset - glide) < 0.25) glide = scrollOffset;
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    stars.render(t, glide);
    blobs.render(glide);
    grain.render(now);

    // ---- the name: its canvas scrolls with the page, so its scroll is undone inside the canvas.
    // Only redrawn when something in it changes: the walls, or the grain's next jump. ----
    const grainDue = now - nameGrainAt >= 1000 / GRAIN_FPS;
    const arriving = !reduceMotion && t < STRETCH_DELAY + STRETCH_SECONDS + 0.1;
    if (text.visible && (arriving || grainDue || nameDrawnAt !== scrollOffset)) {
      if (grainDue) nameGrainAt = now;
      nameDrawnAt = scrollOffset;
      textCamera.setViewOffset(vw, vh, 0, textCenterY - scrollOffset, vw, vh);
      nameRenderer.setClearColor(0x000000, 0);
      nameRenderer.clear();
      capMat.visible = false; wallMat.visible = true;
      nameRenderer.render(textScene, textCamera);
      nameGrain.render(now);
      capMat.visible = true; wallMat.visible = false;
      nameRenderer.render(textScene, textCamera);
    }
  }

  // Once live: is it actually fast enough? Skipped if the tab was hidden partway (no frames then).
  let check = null;
  function checkSpeed(now) {
    if (!check) return;
    if (now - check.last > 1000) { check.start = now + SPEED_CHECK.settleMs; check.frames = 0; }
    check.last = now;
    if (now < check.start) return;
    check.frames++;
    const elapsed = now - check.start;
    if (elapsed < SPEED_CHECK.windowMs) return;
    const fps = (check.frames / elapsed) * 1000;
    check = null;
    console.info(`[backdrop] speed check: ${fps.toFixed(1)}fps (needs ${SPEED_CHECK.minFps})`);
    if (fps < SPEED_CHECK.minFps) giveUp('too-slow');
  }

  function loop(now) {
    if (stopped) return;
    frame();
    checkSpeed(now);
    requestAnimationFrame(loop);
  }

  layout();
  readScroll();
  glide = scrollOffset;   // arriving partway down the page: start there, no glide

  // Compile in the background with a time limit, so a weak GPU can't hold the page up for minutes.
  // The clock starts here, once the assets are in: a slow network says nothing about the device.
  const compileStart = performance.now();
  const compiled = Promise.all([blobs.compile(), stars.compile(), nameRenderer.compileAsync(textScene, textCamera), grain.compile(), nameGrain.compile()]);
  const limit = new Promise((resolve) => setTimeout(() => resolve('timeout'), COMPILE_BUDGET_MS));
  if (await (force ? compiled : Promise.race([compiled, limit])) === 'timeout') giveUp('compile-timeout');
  if (stopped) return;
  console.info(`[backdrop] assets in at ${Math.round(compileStart)}ms, compiled in ${Math.round(performance.now() - compileStart)}ms`);

  blobs.bake();
  const grainLayer = blobs.layered ? document.body.appendChild(createGrainLayer()) : null;
  removeLayers = () => { blobs.remove(); grainLayer?.remove(); };

  running = true;
  resizeObserver = new ResizeObserver(() => { layout(); readScroll(); frame(); });
  resizeObserver.observe(canvas);
  frame();
  if (!reduceMotion) {
    const now = performance.now();
    if (!force) check = { start: now + SPEED_CHECK.settleMs, last: now, frames: 0 };
    requestAnimationFrame(loop);
  }
  onLive();
}
