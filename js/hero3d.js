// Hero: 3D globules + extruded name/tagline.
// Globules: see js/lava.js (raymarched lava lamp seeded with the old wallpaper's shapes).
// Draw order: globules → extrusion walls → film grain → white letter faces, so grain covers
// everything except the faces.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/FontLoader.js';
import { TextGeometry } from 'three/addons/TextGeometry.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { createLava } from './lava.js';

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

// Dynamic film grain over the transparent canvas (so over the stars behind it too). One noise
// tile; ~24 times a second it jumps to a random offset, so the grain "boils" like film.
function createGrain(renderer) {
  const TILE = 512, STRENGTH = 0.13, FPS = 24;
  const data = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); // ~N(0,1)
    const a = Math.min(1, Math.abs(g) * 70 / 255) * STRENGTH;
    data[i] = data[i + 1] = data[i + 2] = g > 0 ? a * 255 : 0;   // light and dark specks (premultiplied)
    data[i + 3] = a * 255;
  }
  const tile = new THREE.DataTexture(data, TILE, TILE, THREE.RGBAFormat);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.minFilter = tile.magFilter = THREE.NearestFilter;
  tile.needsUpdate = true;

  const uniforms = { uTile: { value: tile }, uOffset: { value: new THREE.Vector2() }, uScale: { value: 1 } };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      uniform sampler2D uTile; uniform vec2 uOffset; uniform float uScale;
      out vec4 outColor;
      void main() { outColor = texture(uTile, gl_FragCoord.xy * uScale + uOffset); }`,
    uniforms, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
  }));
  quad.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(quad);
  const cam = new THREE.Camera();
  let last = -Infinity;
  return {
    render(now) {
      if (now - last >= 1000 / FPS) { last = now; uniforms.uOffset.value.set(Math.random(), Math.random()); }
      uniforms.uScale.value = 1 / (renderer.getPixelRatio() * TILE);   // 1 grain per CSS pixel
      renderer.render(scene, cam);
    }
  };
}

export async function initHero(canvas, hero) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;


  function addLights(target) {
    target.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.6, 0.8, 1);
    target.add(key);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 0.8);
    rim.position.set(0.8, -0.4, 0.6);
    target.add(rim);
  }
  addLights(scene);
  renderer.autoClear = false;

  const [lava, fontJson] = await Promise.all([
    createLava(renderer, BASE, { reduceMotion }),
    fetch(new URL('roboto_black_italic.subset.json', BASE)).then((r) => r.json())
  ]);

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
  textScene.environment = scene.environment;
  addLights(textScene);
  const text = new THREE.Group();
    textScene.add(text);
  const textCamera = new THREE.PerspectiveCamera(TEXT_FOV, 1, 10, 20000);

  const SIZE = 100;
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  // walls: mostly self-lit gradient with only a little diffuse shading, so they stay as saturated as the artwork
  const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x3a3a3a, roughness: 0.9, metalness: 0, envMapIntensity: 0.0 });
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

  // The artwork's letters are a little heavier and ~13% wider than Roboto Black Italic's
  // natural shape: grow the outline slightly (bevelOffset, no actual bevel: a bevel would make
  // the walls wider than the face, leaving a coloured outline) and stretch horizontally.
  const EMBOLDEN = 2.2;   // font units at SIZE 100
  const STRETCH_X = 1.13;

  // Fit a line of text into a box of the artwork: height sets the scale,
  // and letter-spacing is solved so the width matches too.
  function buildLine(str, box) {
    const chars = Array.from(str);
    const adv = chars.map((ch) => (font.data.glyphs[ch].ha / font.data.resolution) * SIZE);
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
  let vw = 1, vh = 1;
  function layout() {
    // the canvas is fixed to the viewport: globules stay behind the whole site
    vw = Math.max(1, canvas.clientWidth); vh = Math.max(1, canvas.clientHeight);
    renderer.setSize(vw, vh, false);
    lava.layout(vw, vh, renderer.getPixelRatio());

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
    textCamera.setViewOffset(vw, vh, 0, textCenterY, vw, vh);
  }

  // ---------- Interaction / animation ----------
  const pointer = new THREE.Vector2(0, 0), eased = new THREE.Vector2(0, 0);
  // Scrolling: the name keeps facing the viewer, but the vanishing point stays put on the
  // screen while the hero scrolls away, so more of the rear extrusion is revealed.
  let scrollOffset = 0;
  const readScroll = () => { scrollOffset = Math.max(0, -hero.getBoundingClientRect().top); };
  window.addEventListener('scroll', () => { readScroll(); if (reduceMotion) frame(); }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  const grain = createGrain(renderer);
  const clock = new THREE.Clock();
  // ?lavaSpeed=8 fast-forwards the animation (handy for previewing the lava lamp); ?debug exposes it
  const params = new URLSearchParams(location.search);
  const TIME_SCALE = Number(params.get('lavaSpeed')) || 1;
  if (params.has('debug')) window.__lava = lava;
  let lastT = 0, lastScroll = 0, lastFrame = performance.now();

  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function frame() {
    const t = reduceMotion ? 0 : clock.getElapsedTime() * TIME_SCALE;
    eased.lerp(pointer, 0.05);

    // ---- name: scrolls away with the hero, always face-on ----
    // The vanishing point stays fixed on screen, so scrolling reveals the underside of the
    // extrusion. The "lie": the extrusion shortens as you scroll, so it never reaches absurd
    // lengths once the letters are far from the vanishing point.
    const sv = scrollOffset / vh;
    text.position.y = textCenterY + scrollOffset;
    text.scale.z = textK * (1 - 0.88 * smooth(0, 1.1, sv));
    text.visible = sv < 1.6;

    // ---- globules: lava lamp (js/lava.js); scrolling lifts it at 0.35× ----
    const now = performance.now(), frameMs = now - lastFrame; lastFrame = now;
    const dt = Math.max(0, t - lastT); lastT = t;
    lava.update(dt, scrollOffset - lastScroll, eased, frameMs);
    lastScroll = scrollOffset;

    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    lava.render();
    if (text.visible) {
      renderer.clearDepth();
      capMat.visible = false; wallMat.visible = true;
      renderer.render(textScene, textCamera);
    }
    grain.render(now);
    if (text.visible) {
      capMat.visible = true; wallMat.visible = false;
      renderer.render(textScene, textCamera);
    }
  }

  function loop() {
    frame();
    requestAnimationFrame(loop);
  }

  new ResizeObserver(() => { layout(); readScroll(); frame(); }).observe(canvas);
  layout();
  readScroll();
  lastScroll = scrollOffset;
  frame();
  if (!reduceMotion) requestAnimationFrame(loop);
  canvas.classList.add('is-ready');
  window.dispatchEvent(new Event('hero-ready'));
  return { renderer, scene };
}
