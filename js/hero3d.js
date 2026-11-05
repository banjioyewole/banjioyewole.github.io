// Hero: 3D globules + extruded name/tagline.
// Globules are extracted from the old wallpaper (assets/reigonalpha6.jpg):
// each one ships as a colour texture + a 16-bit height map (R = hi byte, G = lo byte)
// that is inflated into a closed, pillow-shaped mesh here.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/FontLoader.js';
import { TextGeometry } from 'three/addons/TextGeometry.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

const BASE = new URL('../assets/hero3d/', import.meta.url);

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
    const [map, heights] = await Promise.all([
      texLoader.loadAsync(new URL(`blob_${meta.name}.webp`, BASE).href),
      loadHeights(new URL(`height_${meta.name}.png`, BASE).href)
    ]);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;

    const geo = inflate(heights, meta);
    // matte: no clearcoat / reflections, just soft diffuse shading over the original colours
    const mat = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: map,
      emissive: 0xffffff,
      emissiveIntensity: 0.3,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.0,
      alphaTest: 0.6,
      side: THREE.FrontSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    // geometry is centred on the blob's bbox centre; the pivot moves it into place
    const pivot = new THREE.Group();
    pivot.add(mesh);
    return { meta, pivot, mesh, phase: index * 1.7 + 0.4 };
  }

  function loadHeights(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const h = new Float32Array(c.width * c.height);
        for (let i = 0; i < h.length; i++) h[i] = (d[i * 4] * 256 + d[i * 4 + 1]) / 65535;
        resolve({ w: c.width, h: c.height, data: h });
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // Front + mirrored back sheet that meet at z = 0 on the silhouette → closed pillow.
  function inflate(hm, meta) {
    const { w: gw, h: gh, data } = hm;
    const sx = meta.w / (gw - 1), sy = meta.h / (gh - 1);
    const depth = Math.min(meta.depth, Math.max(meta.w, meta.h) * 0.22) * 0.75;
    const n = gw * gh;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const px = x * sx - meta.w / 2;
        const py = meta.h / 2 - y * sy;
        const z = data[i] * depth;
        pos.set([px, py, z], i * 3);
        pos.set([px, py, -z], (i + n) * 3);
        uv.set([x / (gw - 1), 1 - y / (gh - 1)], i * 2);
        uv.set([x / (gw - 1), 1 - y / (gh - 1)], (i + n) * 2);
      }
    }
    const idx = [];
    const inside = (i) => data[i] > 0;
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const a = y * gw + x, b = a + 1, c = a + gw, d = c + 1;
        if (!(inside(a) || inside(b) || inside(c) || inside(d))) continue;
        idx.push(a, c, b, b, c, d); // front (CCW toward +z)
        idx.push(a + n, b + n, c + n, b + n, d + n, c + n); // back
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // ---------- Name + tagline ----------
  // Rendered with an orthographic camera and an oblique shear so it matches the old flat
  // artwork (assets/HERO_SAPPHIRE.png): letters face-on, extrusion receding up and to the right.
  // Everything below is laid out in that artwork's pixel space (2707 × 386).
  const ART_W = 2707, ART_H = 386;
  const ART = {
    title: { x0: 1, x1: 2705, y0: 1, y1: 234 },     // white letter faces in the artwork
    tagline: { x0: 543, x1: 2143, y0: 282, y1: 383 }
  };
  const DEPTH_ART = 260;                    // ≥ title cap height (233) — words are deeper than tall
  const SHEAR = { x: 68 / DEPTH_ART, y: 9 / DEPTH_ART }; // the artwork's extrusion offset: 68px right, 9px up

  const font = new FontLoader().parse(fontJson);
  const textScene = new THREE.Scene();
  textScene.environment = scene.environment;
  addLights(textScene);
  const text = new THREE.Group();
  text.matrixAutoUpdate = false;
  textScene.add(text);
  const textCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
  textCamera.position.z = 3000;

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

  // Fit a line of text into a box of the artwork: height sets the scale,
  // and letter-spacing is solved so the width matches too.
  function buildLine(str, box) {
    const chars = Array.from(str);
    const adv = chars.map((ch) => (font.data.glyphs[ch].ha / font.data.resolution) * SIZE);
    const boxes = chars.map((ch) => (ch === ' ' ? null : glyphBox(ch)));
    const ink = boxes.filter(Boolean);
    const yMin = Math.min(...ink.map((b) => b.min.y)), yMax = Math.max(...ink.map((b) => b.max.y));
    const k = (box.y1 - box.y0) / (yMax - yMin);
    const lastAdv = adv.slice(0, -1).reduce((a, c) => a + c, 0);
    const w0 = lastAdv + boxes[boxes.length - 1].max.x - boxes[0].min.x;
    const extra = ((box.x1 - box.x0) / k - w0) / (chars.length - 1);

    const depth = DEPTH_ART / k;
    const line = new THREE.Group();
    const meshes = [];
    let x = 0;
    chars.forEach((ch, i) => {
      if (ch !== ' ') {
        const geo = new TextGeometry(ch, {
          font, size: SIZE, depth, curveSegments: 2,
          bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.1, bevelSegments: 3
        });
        geo.translate(0, 0, -depth); // front face at z = 0, extrusion goes back
        const m = new THREE.Mesh(geo, [capMat, wallMat]);
        m.position.x = x;
        line.add(m);
        meshes.push(m);
      }
      x += adv[i] + extra;
    });
    line.scale.setScalar(k);
    // artwork pixel space (y down) → group space centred on the artwork (y up)
    line.position.set(box.x0 - ART_W / 2 - k * boxes[0].min.x, (ART_H / 2 - box.y1) - k * yMin, 0);
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
        tmp.multiplyScalar(1 - back * 0.35);
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
      m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
  }

  // text transform = translate · oblique shear · scale
  const textPos = new THREE.Vector3(), textScale = new THREE.Matrix4(), shearM = new THREE.Matrix4(), tMat = new THREE.Matrix4();
  let textK = 1;
  function setTextMatrix(kx, ky) {
    shearM.set(
      1, 0, -kx, 0,
      0, 1, -ky, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    );
    tMat.makeTranslation(textPos.x, textPos.y, 0).multiply(shearM).multiply(textScale.makeScale(textK, textK, textK));
    text.matrix.copy(tMat);
    text.matrixWorldNeedsUpdate = true;
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
    textCamera.left = -vw / 2; textCamera.right = vw / 2;
    textCamera.top = vh / 2; textCamera.bottom = -vh / 2;
    textCamera.updateProjectionMatrix();
    textK = Math.min(vw * 0.8, 1440) / ART_W;
    textPos.set(0, vh / 2 - vh * 0.45, 0);
  }

  // ---------- Interaction / animation ----------
  const pointer = new THREE.Vector2(0, 0), eased = new THREE.Vector2(0, 0);
  window.addEventListener('pointermove', (e) => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  let visible = true, running = false;
  const clock = new THREE.Clock();

  function frame() {
    const t = reduceMotion ? 0 : clock.getElapsedTime();
    eased.lerp(pointer, 0.05);

    // oblique extrusion like the artwork; the pointer nudges the "camera" a little
    setTextMatrix(
      SHEAR.x + eased.x * 0.06 + Math.sin(t * 0.35) * 0.012,
      SHEAR.y - eased.y * 0.05 + Math.sin(t * 0.27) * 0.008
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
  frame();
  start();
  canvas.classList.add('is-ready');
  return { renderer, scene };
}
