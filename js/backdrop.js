// Decides which backdrop this visitor gets. Everyone starts on the static design (wallpaper and
// flat name: instant, and cheap to scroll); the live hero loads behind it and crossfades in only
// if this device can run it. The state lives on <html data-backdrop="live|static"> (css/hero3d.css).
//
//   ?hero=static  always the static design
//   ?hero=live    always the live hero, skipping the speed checks
const root = document.documentElement;
const mode = new URLSearchParams(location.search).get('hero');

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
  try {
    const { initHero } = await import('./hero3d.js');
    await initHero(document.getElementById('hero3d-canvas'), document.getElementById('hero'), {
      force: mode === 'live',
      onLive: () => setState('live'),
      onGiveUp: (reason) => setState('static', reason)
    });
  } catch (err) {
    console.warn('Live hero unavailable, keeping the static design', err);
    setState('static', 'load-error');
  }
}

if (mode === 'static') setState('static', 'requested');
else if (!hasWebGL2()) setState('static', 'no-webgl2');
else startLive();
