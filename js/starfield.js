// Full-page background: a moving recreation of the long-exposure star streaks in
// assets/reigonalpha6.jpg. Numbers below were measured from that image: streaks sit 12.5° off
// vertical, the bright end is always at the top, and brightness and width fall off from a wide
// head into a hair-thin tail. Stars travel head-first: up and slightly to the right.
// The canvas is softened with a CSS blur (css/hero3d.css) so it reads as a photo, not as vector lines.
(function () {
  var canvas = document.getElementById('starfield');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var TILT = 12.5 * Math.PI / 180;
  var DX = Math.sin(TILT), DY = -Math.cos(TILT);
  var MARGIN = 80; // stars wrap this far off screen, so their tails clear the edge first

  // Three populations, sized in CSS px for a 1440-wide window (the image's scale at that width).
  // headW/tailW are half-widths; halo is the saturated blue bloom around the brightest heads.
  var TIERS = [
    { share: 0.76, len: [16, 38], headW: 0.42, tailW: 0.2, alpha: [0.3, 0.7], core: 0, halo: 0, colors: ['#6f97b0', '#5f8cb0', '#7ea3bd', '#4f86bb'] },
    { share: 0.20, len: [20, 40], headW: 0.62, tailW: 0.2, alpha: [0.7, 0.95], core: 0.3, halo: 1.8, colors: ['#5aa2ea', '#4a8dff', '#74b6ee', '#3d7bff'] },
    { share: 0.04, len: [28, 52], headW: 0.95, tailW: 0.22, alpha: [0.95, 1], core: 0.9, halo: 3.2, colors: ['#8fd3f3', '#a5dcff', '#6aa6ff', '#cfe4ff'] }
  ];
  var VARIANTS = 10; // sprites per tier; every frame just stamps these, so 1000+ stars stay cheap
  var HALO_BLUE = '20, 90, 255';

  var w = 0, h = 0, dpr = 1, scale = 1, stars = [], sprites = [];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(list) { return list[(Math.random() * list.length) | 0]; }

  // A head-up teardrop: round cap at (0, 0), curving in to a thin tail at (0, len).
  function teardrop(c, headW, tailW, len) {
    c.beginPath();
    c.arc(0, 0, headW, Math.PI, 0);
    c.quadraticCurveTo(tailW + (headW - tailW) * 0.22, len * 0.26, tailW, len);
    c.lineTo(-tailW, len);
    c.quadraticCurveTo(-tailW - (headW - tailW) * 0.22, len * 0.26, -headW, 0);
    c.closePath();
  }

  function makeSprite(tier) {
    var len = rand(tier.len[0], tier.len[1]) * scale;
    var headW = tier.headW * scale, tailW = tier.tailW * scale, halo = tier.halo * scale;
    var alpha = rand(tier.alpha[0], tier.alpha[1]);
    var color = pick(tier.colors);
    var pad = Math.ceil(Math.max(halo, headW) + 3);
    var sw = Math.ceil(len * DX + pad * 2 + 2), sh = Math.ceil(len + pad * 2 + 2);

    var c = document.createElement('canvas');
    c.width = Math.ceil(sw * dpr); c.height = Math.ceil(sh * dpr);
    var g = c.getContext('2d');
    g.scale(dpr, dpr);
    // anchor (head) sits top-right of the sprite; the tail runs down-left
    var ax = sw - pad - 1, ay = pad + 1;
    g.translate(ax, ay);
    g.rotate(TILT);
    g.globalCompositeOperation = 'lighter';

    if (halo > 0) { // bloom: strongest round the head, a fainter sheath down the first part of the tail
      var bloom = g.createRadialGradient(0, 0, 0, 0, 0, halo);
      bloom.addColorStop(0, 'rgba(' + HALO_BLUE + ',' + 0.5 * alpha + ')');
      bloom.addColorStop(0.45, 'rgba(' + HALO_BLUE + ',' + 0.22 * alpha + ')');
      bloom.addColorStop(1, 'rgba(' + HALO_BLUE + ',0)');
      g.fillStyle = bloom;
      g.beginPath(); g.arc(0, 0, halo, 0, Math.PI * 2); g.fill();
      var sheath = g.createLinearGradient(0, 0, 0, len * 0.65);
      sheath.addColorStop(0, 'rgba(' + HALO_BLUE + ',' + 0.3 * alpha + ')');
      sheath.addColorStop(1, 'rgba(' + HALO_BLUE + ',0)');
      g.fillStyle = sheath;
      teardrop(g, headW * 1.7, tailW, len * 0.65);
      g.fill();
    }

    // body: brightness falls off nearly linearly from head to tail, as in the photo
    var body = g.createLinearGradient(0, 0, 0, len);
    body.addColorStop(0, color);
    body.addColorStop(0.55, color + '99');
    body.addColorStop(1, color + '00');
    g.globalAlpha = alpha;
    g.fillStyle = body;
    teardrop(g, headW, tailW, len);
    g.fill();

    if (tier.core > 0) { // near-white hot core inside the head
      var hot = g.createLinearGradient(0, 0, 0, len * 0.45);
      hot.addColorStop(0, 'rgba(235, 248, 255,' + tier.core + ')');
      hot.addColorStop(1, 'rgba(235, 248, 255,0)');
      g.fillStyle = hot;
      teardrop(g, headW * 0.6, tailW * 0.6, len * 0.45);
      g.fill();
    }
    return { canvas: c, w: c.width / dpr, h: c.height / dpr, ax: ax, ay: ay, len: len / scale };
  }

  function makeStar(x, y) {
    var r = Math.random(), i = 0;
    while (i < TIERS.length - 1 && r > TIERS[i].share) { r -= TIERS[i].share; i++; }
    var s = pick(sprites[i]);
    return { x: x, y: y, sprite: s, speed: s.len * rand(0.9, 1.6) }; // px/s; longer streaks move faster
  }

  function resize() {
    var nw = window.innerWidth, nh = window.innerHeight;
    var ndpr = Math.min(window.devicePixelRatio || 1, 2);
    var reseed = nw !== w || Math.abs(nh - h) > 160 || ndpr !== dpr; // ignore mobile URL-bar jitter
    w = nw; h = nh; dpr = ndpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (!reseed && stars.length) return;

    // the photo is drawn "cover", so its streaks scale with the window
    scale = Math.min(1.6, Math.max(0.75, Math.max(w / 1440, h / 900)));
    sprites = TIERS.map(function (tier) {
      var list = [];
      for (var v = 0; v < VARIANTS; v++) list.push(makeSprite(tier));
      return list;
    });
    var target = Math.round((w * h) / (620 * scale * scale));
    stars = [];
    for (var i = 0; i < target; i++) stars.push(makeStar(rand(-MARGIN, w + MARGIN), rand(-MARGIN, h + MARGIN)));
  }

  function draw(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter'; // overlapping streaks add up, like light on film

    var spanX = w + MARGIN * 2, spanY = h + MARGIN * 2;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.x += DX * s.speed * dt; s.y += DY * s.speed * dt;
      // wrap along the direction of travel, which keeps the density even
      if (s.y < -MARGIN) { s.y += spanY; s.x -= spanY * DX / -DY; }
      if (s.x > w + MARGIN) s.x -= spanX; else if (s.x < -MARGIN) s.x += spanX;
      var sp = s.sprite;
      ctx.drawImage(sp.canvas, s.x - sp.ax, s.y - sp.ay, sp.w, sp.h);
    }
  }

  var last = 0;
  function loop(now) {
    var t = now / 1000;
    var dt = last ? Math.min(0.05, t - last) : 0;
    last = t;
    draw(dt);
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', function () { resize(); if (reduceMotion) draw(0); });
  resize();
  // The film grain lives in the hero canvas: stars wait for it, then both fade in together.
  window.addEventListener('hero-ready', function () {
    canvas.classList.add('is-ready');
    if (reduceMotion) draw(0); else requestAnimationFrame(loop);
  }, { once: true });
})();
