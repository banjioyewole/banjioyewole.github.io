// Hero: 3D globules + extruded name/tagline.
// Globules are extracted from the old wallpaper (assets/reigonalpha6.jpg) and rebuilt
// offline as closed 3D blobs (see loadBlobGeometry).
import * as THREE from 'three';
import { FontLoader } from 'three/addons/FontLoader.js';
import { TextGeometry } from 'three/addons/TextGeometry.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

export const BASE = new URL('../assets/hero3d/', import.meta.url);

// Gradient sampled from the extrusion "shadow" in assets/HERO_SAPPHIRE.png (left → right).
const GRADIENT = [
  '#ffd34e', '#fe9613', '#f7533a', '#ef3f7a', '#d432d1', '#bd39ed', '#a33ff0', '#8c48f8',
  '#7450fd', '#5661ff', '#4176ff', '#2d76ff', '#118aff', '#0997ff', '#1fb8ff', '#26e2ff', '#37fdff'
].map((c) => new THREE.Color(c));

function gradientAt(t, out) {
  t = Math.min(1, Math.max(0, t)) * (GRADIENT.length - 1);
  const i = Math.min(GRADIENT.length - 2, Math.floor(t));
  return out.copy(GRADIENT[i]).lerp(GRADIENT[i + 1], t - i);
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Matte: no clearcoat / reflections, just soft diffuse shading over the original colours.
export function blobMaterial(map) {
  return new THREE.MeshStandardMaterial({
    map,
    emissiveMap: map,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0
  });
}

// Globules are closed, watertight meshes built offline (marching cubes over an inflated,
// completed silhouette). Binary: uint16 xyz quantised to meta.min..max, then the indices.
export async function loadBlobGeometry(meta) {
  const buf = await fetch(new URL(`blob_${meta.name}.bin`, BASE)).then((r) => r.arrayBuffer());
  const n = meta.vertexCount;
  const q = new Uint16Array(buf, 0, n * 3);
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) pos[i * 3 + a] = meta.min[a] + (q[i * 3 + a] / 65535) * (meta.max[a] - meta.min[a]);
    // planar projection of the wallpaper colours (front-on), bbox-centred
    uv[i * 2] = pos[i * 3] / meta.w + 0.5;
    uv[i * 2 + 1] = pos[i * 3 + 1] / meta.h + 0.5;
  }
  const idxOffset = n * 3 * 2;
  const index = meta.index32
    ? new Uint32Array(buf, idxOffset, meta.indexCount)
    : new Uint16Array(buf, idxOffset, meta.indexCount);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}

export async function initHero(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(20, 1, 10, 20000);

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

  const [blobMeta, fontJson] = await Promise.all([
    fetch(new URL('blobs.json', BASE)).then((r) => r.json()),
    fetch(new URL('roboto_black_italic.subset.json', BASE)).then((r) => r.json())
  ]);

  // ---------- Globules ----------
  const texLoader = new THREE.TextureLoader();
  const blobs = await Promise.all(blobMeta.blobs.map((b, i) => buildBlob(b, i)));
  blobs.forEach((b) => scene.add(b.pivot));

  async function buildBlob(meta, index) {
    const [map, geo] = await Promise.all([
      texLoader.loadAsync(new URL(`blob_${meta.name}.webp`, BASE).href),
      loadBlobGeometry(meta)
    ]);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const mesh = new THREE.Mesh(geo, blobMaterial(map));
    // geometry is centred on the blob's bbox centre; the pivot moves it into place
    const pivot = new THREE.Group();
    pivot.add(mesh);
    return { meta, pivot, mesh, phase: index * 1.7 + 0.4 };
  }

  // ---------- Name + tagline ----------
  // Same size and placement as the old flat artwork (assets/HERO_SAPPHIRE.png), seen by a
  // perspective camera centred on the name: every letter extrudes straight back toward one
  // vanishing point, so walls only show on the inner sides (never past the outer letters).
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
  const capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.72, roughness: 0.5, metalness: 0 });
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
  // natural shape: grow the outline slightly (bevelOffset) and stretch horizontally.
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
          bevelEnabled: true, bevelThickness: 1.6, bevelSize: 0.8, bevelOffset: EMBOLDEN, bevelSegments: 3
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

  // Front faces stay pinned at 1 world unit = 1 CSS px; the camera can drift (pointer/idle)
  // to move the vanishing point while setViewOffset keeps the front faces exactly in place.
  let textCenterY = 0, textDist = 1;
  function placeTextCamera(dx, dy) {
    textCamera.position.set(dx, textCenterY + dy, textDist);
    textCamera.setViewOffset(vw, vh, -dx, textCenterY + dy, vw, vh);
  }

  // ---------- Layout ----------
  let vw = 1, vh = 1;
  function layout() {
    const r = canvas.parentElement.getBoundingClientRect();
    vw = Math.max(1, r.width); vh = Math.max(1, r.height);
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    // 1 world unit == 1 CSS pixel on the z = 0 plane
    camera.position.set(0, 0, (vh / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    camera.near = 10; camera.far = camera.position.z * 4;
    camera.updateProjectionMatrix();

    // globules: on landscape screens this matches the old `background-size: cover`
    // wallpaper; each blob is pinned to its own corner so portrait/phone screens keep all four.
    const iw = blobMeta.imageW, ih = blobMeta.imageH;
    const s = Math.min(Math.max(vw / iw, vh / ih), (vw / iw) * (vw < vh ? 1.3 : 1.7));
    for (const b of blobs) {
      const m = b.meta;
      const left = m.name[1] === 'l', top = m.name[0] === 't';
      const cx = left ? (m.x + m.w / 2) * s : vw - (iw - (m.x + m.w / 2)) * s;
      const cy = top ? (m.y + m.h / 2) * s : vh - (ih - (m.y + m.h / 2)) * s;
      b.base = new THREE.Vector3(cx - vw / 2, vh / 2 - cy, -40);
      b.pivot.scale.setScalar(s);
      b.pivot.position.copy(b.base);
    }

    // text: same box as the old <img class="hero-transparent">: 80% wide (max 1440px),
    // centred horizontally, vertically centred at 45% of the hero (top: -10%; bottom: 0)
    const textK = Math.min(vw * 0.8, 1440) / ART_W;
    text.scale.setScalar(textK);
    text.position.set(0, vh / 2 - vh * 0.45, 0);
    // vanishing point = centre of the name + tagline block
    textCenterY = text.position.y;
    textCamera.aspect = vw / vh;
    textDist = (vh / 2) / Math.tan(THREE.MathUtils.degToRad(TEXT_FOV / 2));
    textCamera.far = textDist + DEPTH_ART * textK * 2 + 1000;
    placeTextCamera(0, 0);
  }

  // ---------- Interaction / animation ----------
  const pointer = new THREE.Vector2(0, 0), eased = new THREE.Vector2(0, 0);
  // Scrolling: the name keeps facing the viewer, but the vanishing point stays put on the
  // screen while the hero scrolls away, so more of the rear extrusion is revealed.
  let scrollOffset = 0;
  const readScroll = () => { scrollOffset = Math.max(0, -canvas.getBoundingClientRect().top); };
  window.addEventListener('scroll', () => { readScroll(); if (reduceMotion) frame(); }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  let visible = true, running = false;
  const clock = new THREE.Clock();

  function frame() {
    const t = reduceMotion ? 0 : clock.getElapsedTime();
    eased.lerp(pointer, 0.05);

    // the pointer (and a slow idle drift) nudges the vanishing point a little;
    // scrolling holds it in place on screen (the hero moves up, the VP doesn't)
    placeTextCamera(
      eased.x * vw * 0.06 + Math.sin(t * 0.35) * vw * 0.01,
      -eased.y * vh * 0.06 + Math.sin(t * 0.27) * vh * 0.01 - scrollOffset
    );

    for (const b of blobs) {
      if (!b.base) continue;
      const ph = b.phase;
      b.pivot.position.set(
        b.base.x - eased.x * 14 + Math.sin(t * 0.4 + ph) * 6,
        b.base.y + eased.y * 10 + Math.sin(t * 0.55 + ph) * 9,
        b.base.z
      );
      b.pivot.rotation.set(
        Math.sin(t * 0.3 + ph) * 0.07 + eased.y * 0.08,
        Math.cos(t * 0.25 + ph) * 0.09 + eased.x * 0.1,
        Math.sin(t * 0.2 + ph) * 0.03
      );
    }
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(textScene, textCamera);
  }

  function loop() {
    if (!visible || reduceMotion) { running = false; return; }
    frame();
    requestAnimationFrame(loop);
  }
  function start() {
    if (running || reduceMotion) return;
    running = true;
    requestAnimationFrame(loop);
  }

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) start();
  }).observe(canvas);

  new ResizeObserver(() => { layout(); frame(); }).observe(canvas.parentElement);
  layout();
  readScroll();
  frame();
  start();
  canvas.classList.add('is-ready');
  return { renderer, scene };
}
