// Full-page background: tiny stars streaking across the sky at the same steep
// angle as the old long-exposure wallpaper (~99° from horizontal, drifting down-left).
(function () {
  var canvas = document.getElementById('starfield');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ANGLE = 99 * Math.PI / 180;
  var DX = Math.cos(ANGLE), DY = Math.sin(ANGLE);
  // blue-white palette taken from the old wallpaper's streaks
  var COLORS = ['#3d7bff', '#4f8dff', '#6aa6ff', '#2f6bff', '#8fc3ff', '#cfe4ff', '#ffffff', '#5fd0ff'];
  var BUCKETS = 4; // alpha buckets so each frame is a handful of stroke() calls

  var w = 0, h = 0, dpr = 1, stars = [], dust = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function makeStar(anywhere) {
    var len = Math.pow(Math.random(), 2) * 22 + 3; // mostly short streaks, a few long ones
    return {
      x: rand(-40, w + 80),
      y: anywhere ? rand(-40, h + 40) : rand(-120, -10),
      len: len,
      speed: len * rand(0.9, 1.6),           // px/s — longer streaks move faster
      color: COLORS[(Math.random() * COLORS.length) | 0],
      bucket: (Math.random() * BUCKETS) | 0
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var nw = window.innerWidth, nh = window.innerHeight;
    var reseed = nw !== w || Math.abs(nh - h) > 160; // ignore mobile URL-bar jitter
    w = nw; h = nh;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (!reseed && stars.length) return;
    var target = Math.round((w * h) / 2200);
    stars = [];
    for (var i = 0; i < target; i++) stars.push(makeStar(true));
    // static pin-prick stars for depth
    dust = [];
    var dustN = Math.round((w * h) / 9000);
    for (var j = 0; j < dustN; j++) dust.push({ x: Math.random() * w, y: Math.random() * h, r: rand(0.25, 0.6), a: rand(0.25, 0.7), p: Math.random() * 6.28 });
  }

  function draw(t, dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.x += DX * s.speed * dt; s.y += DY * s.speed * dt;
      if (s.y - s.len > h + 20 || s.x < -60) { stars[i] = makeStar(false); }
    }

    // tails (faint) then heads (bright), grouped by colour + alpha bucket
    for (var b = 0; b < BUCKETS; b++) {
      var alpha = 0.35 + b * 0.2;
      for (var c = 0; c < COLORS.length; c++) {
        var col = COLORS[c];
        ctx.strokeStyle = col;
        ctx.globalAlpha = alpha * 0.35;
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        var any = false;
        for (var k = 0; k < stars.length; k++) {
          var st = stars[k];
          if (st.bucket !== b || st.color !== col) continue;
          any = true;
          ctx.moveTo(st.x - DX * st.len, st.y - DY * st.len);
          ctx.lineTo(st.x - DX * st.len * 0.35, st.y - DY * st.len * 0.35);
        }
        if (!any) continue;
        ctx.stroke();
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        for (var q = 0; q < stars.length; q++) {
          var s2 = stars[q];
          if (s2.bucket !== b || s2.color !== col) continue;
          ctx.moveTo(s2.x - DX * s2.len * 0.35, s2.y - DY * s2.len * 0.35);
          ctx.lineTo(s2.x, s2.y);
        }
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#dfeaff';
    for (var d = 0; d < dust.length; d++) {
      var p = dust[d];
      ctx.globalAlpha = p.a * (0.65 + 0.35 * Math.sin(t * 1.3 + p.p));
      ctx.fillRect(p.x, p.y, p.r * 2, p.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  var last = 0;
  function loop(now) {
    var t = now / 1000;
    var dt = last ? Math.min(0.05, t - last) : 0;
    last = t;
    draw(t, dt);
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', function () { resize(); if (reduceMotion) draw(0, 0); });
  resize();
  if (reduceMotion) draw(0, 0); else requestAnimationFrame(loop);
})();
