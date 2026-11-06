// Dynamic fake film grain over the background (stars + 3D hero), under the page content.
// A few noise tiles are generated once; each frame (~24 fps, like film) picks a tile
// and a random offset, so the grain "boils" without re-generating noise every frame.
(function () {
  var canvas = document.getElementById('filmgrain');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var TILE = 256, FRAMES = 8, FPS = 24;
  var patterns = [];

  function gauss() { // Box–Muller, approx N(0,1)
    var u = 1 - Math.random(), v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  for (var f = 0; f < FRAMES; f++) {
    var c = document.createElement('canvas');
    c.width = c.height = TILE;
    var cx = c.getContext('2d');
    var img = cx.createImageData(TILE, TILE);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var g = gauss();
      var v = g > 0 ? 255 : 0;            // light and dark specks
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.min(255, Math.abs(g) * 70);
    }
    cx.putImageData(img, 0, 0);
    patterns.push(ctx.createPattern(c, 'repeat'));
  }

  var w = 0, h = 0;
  function resize() {
    // 1 grain per CSS pixel: reads as film grain on high-DPI screens instead of fizz
    w = canvas.width = Math.ceil(window.innerWidth);
    h = canvas.height = Math.ceil(window.innerHeight);
  }

  function draw() {
    var p = patterns[(Math.random() * FRAMES) | 0];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(-((Math.random() * TILE) | 0), -((Math.random() * TILE) | 0));
    ctx.fillStyle = p;
    ctx.fillRect(0, 0, w + TILE, h + TILE);
  }

  var last = 0;
  function loop(now) {
    if (now - last >= 1000 / FPS) { last = now; draw(); }
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', function () { resize(); draw(); });
  resize();
  draw();
  if (!reduceMotion) requestAnimationFrame(loop);
})();
