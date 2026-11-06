// Decides which backdrop this visitor gets. The live hero gets the first try, with the page black
// until it can draw; the static design (wallpaper and flat name) appears only if it can't run or
// takes too long. The state lives on <html data-backdrop="live|static"> (css/hero3d.css).
//
//   ?hero=static  always the static design
//   ?hero=live    always the live hero, skipping the speed checks
const root = document.documentElement;
const mode = new URLSearchParams(location.search).get('hero');
const LOAD_LIMIT_MS = 8000;   // how long to leave the page black before settling for the static design

function setState(state, reason) {
  root.dataset.backdrop = state;
  if (reason) root.dataset.backdropReason = reason;
  console.info(`[backdrop] ${state}${reason ? ` (${reason})` : ''} at ${Math.round(performance.now())}ms`);
}

function hasWebGL2() {
  const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return !!gl;
}

async function startLive() {
  const force = mode === 'live';
  const attempt = new AbortController();
  const limit = force ? null : setTimeout(() => {
    attempt.abort();
    if (!root.dataset.backdrop) setState('static', 'load-timeout');
  }, LOAD_LIMIT_MS);
  try {
    const { initHero } = await import('./hero3d.js');
    if (attempt.signal.aborted) return;
    await initHero(document.getElementById('hero3d-canvas'), document.getElementById('hero3d-name'), document.getElementById('hero'), {
      force,
      signal: attempt.signal,
      onLive: () => { clearTimeout(limit); setState('live'); },
      onGiveUp: (reason) => { clearTimeout(limit); setState('static', reason); }
    });
  } catch (err) {
    clearTimeout(limit);
    console.warn('Live hero unavailable, using the static design', err);
    if (!root.dataset.backdrop) setState('static', 'load-error');
  }
}

if (mode === 'static') setState('static', 'requested');
else if (!hasWebGL2()) setState('static', 'no-webgl2');
else startLive();
