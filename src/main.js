import * as THREE from 'three';
import { WORLDS } from './data.js';
import { generateNebulaTexture, generateWorldTextures } from './textures.js';
import { createWorlds } from './planets.js';
import { BAND_NORMAL, createStarfield } from './starfield.js';
import { createGalaxy } from './galaxy.js';
import { createControls } from './controls.js';
import { initUI } from './ui.js';

const canvas = document.getElementById('scene');

// The UI exists before the 3D scene so that a WebGL failure can still show a message.
// Handlers are wired to the real functions further down.
const actions = {
  select: () => {},
  reset: () => {},
  togglePause: () => {},
  toggleStars: () => {},
};

const ui = initUI({
  worlds: WORLDS,
  handlers: {
    onSelect: (id) => actions.select(id),
    onReset: () => actions.reset(),
    onTogglePause: () => actions.togglePause(),
    onToggleStars: () => actions.toggleStars(),
  },
});

start().catch((error) => {
  console.error('Cosmic Explorer failed to start:', error);
  ui.showFallback();
});

async function start() {
  /* ---------------- renderer ---------------- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      // Anti-aliasing is expensive on dense phone screens, and less needed there.
      antialias: (window.devicePixelRatio || 1) < 2,
      alpha: false,
      stencil: false,
    });
  } catch (error) {
    console.warn('WebGL is not available:', error);
    ui.showFallback();
    return;
  }
  renderer.setClearColor(0x000000, 1);

  // Cap the pixel ratio: rendering at 3x on a phone costs 9x the pixels for little gain.
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  const isSmallDevice =
    Math.min(window.screen.width, window.screen.height) < 700 ||
    window.matchMedia('(pointer: coarse)').matches;
  const hiQuality = isSmallDevice ? 'mobile' : 'desktop';

  /* ---------------- scene ---------------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);

  // Direction pointing from the scene toward the Sun.
  const sunDirection = new THREE.Vector3(0.82, 0.28, 0.62).normalize();
  const sunLight = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sunLight.position.copy(sunDirection).multiplyScalar(300);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x4a6aa8, 1.1)); // faint "earthshine" so night sides are not pitch black

  // Quick, low-resolution textures first so the scene appears almost immediately.
  const [lowTextures, nebulaCanvas] = await Promise.all([
    generateWorldTextures('low'),
    generateNebulaTexture(BAND_NORMAL.toArray(), isSmallDevice ? [512, 256] : [1024, 512]),
  ]);

  const worlds = createWorlds({
    textures: lowTextures,
    sunDirection,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
  });
  scene.add(worlds.root);

  const sky = createStarfield({
    nebulaCanvas,
    sunDirection,
    starCount: isSmallDevice ? 3800 : 6000,
    pixelRatio,
  });
  scene.add(sky.root);

  const galaxy = createGalaxy();
  scene.add(galaxy.root);
  const bodies = { ...worlds.bodies, galaxy: galaxy.body };

  const controls = createControls(camera, canvas);

  /* ---------------- state ---------------- */
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let paused = reducedMotion;
  let starsVisible = true;
  let simTime = 0;
  let needsResize = true;
  let dirty = true;
  let generating = true;
  let disposed = false;
  let running = false;

  ui.setPaused(paused);
  ui.setStars(starsVisible);

  /* ---------------- sizing ---------------- */
  function applySize() {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false); // false: CSS controls the canvas size
    camera.aspect = width / height;
    // On tall (portrait) screens, nudge the scene up so the info card does not cover it.
    if (height > width) {
      camera.setViewOffset(width, height, 0, Math.round(height * 0.07), width, height);
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
    sky.setPixelRatio(pixelRatio);
    controls.handleResize();
    needsResize = false;
    dirty = true;
  }

  const requestResize = () => {
    needsResize = true;
  };
  window.addEventListener('resize', requestResize);
  window.addEventListener('orientationchange', requestResize);
  const resizeObserver = new ResizeObserver(requestResize);
  resizeObserver.observe(canvas);

  /* ---------------- actions ---------------- */
  actions.select = (id) => {
    const body = bodies[id];
    if (!body) return;
    controls.setFocus(body);
    ui.showWorld(id);
    dirty = true;
  };
  actions.reset = () => {
    controls.reset();
    dirty = true;
  };
  actions.togglePause = () => {
    paused = !paused;
    ui.setPaused(paused);
    dirty = true;
  };
  actions.toggleStars = () => {
    starsVisible = !starsVisible;
    sky.setStarsVisible(starsVisible);
    ui.setStars(starsVisible);
    dirty = true;
  };

  /* ---------------- animation loop ---------------- */
  let lastTime = performance.now();
  let perfTime = 0;
  let perfFrames = 0;

  // If frames are consistently slow, quietly lower the render resolution.
  function watchPerformance(dt) {
    if (generating || paused) {
      perfTime = 0;
      perfFrames = 0;
      return;
    }
    perfTime += dt;
    perfFrames++;
    if (perfFrames >= 90) {
      const average = perfTime / perfFrames;
      perfTime = 0;
      perfFrames = 0;
      if (average > 1 / 28 && pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25);
        needsResize = true;
      }
    }
  }

  function tick(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (needsResize) applySize();

    const simDt = paused ? 0 : dt;
    simTime += simDt;
    worlds.update(simDt);
    galaxy.update(simDt);
    const moved = controls.update(dt);
    sky.update(simTime, camera.position);

    // While paused and idle there is nothing new to draw, which saves battery.
    if (!paused || moved || dirty) {
      renderer.render(scene, camera);
      dirty = false;
      watchPerformance(dt);
    }
  }

  function startLoop() {
    if (running || disposed) return;
    running = true;
    lastTime = performance.now();
    renderer.setAnimationLoop(tick);
  }

  function stopLoop() {
    running = false;
    renderer.setAnimationLoop(null);
  }

  // Do no work while the tab or app is in the background.
  const onVisibility = () => {
    if (document.hidden) stopLoop();
    else startLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Recover gracefully if the browser reclaims the GPU context.
  const onContextLost = (event) => {
    event.preventDefault();
    stopLoop();
  };
  const onContextRestored = () => {
    dirty = true;
    needsResize = true;
    startLoop();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  /* ---------------- cleanup ---------------- */
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopLoop();
    window.removeEventListener('resize', requestResize);
    window.removeEventListener('orientationchange', requestResize);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    resizeObserver.disconnect();
    controls.dispose();
    sky.dispose();
    worlds.dispose();
    galaxy.dispose();
    renderer.dispose();
  }
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  });

  /* ---------------- go ---------------- */
  applySize();
  controls.setFocus(worlds.bodies.earth, { instant: true });
  ui.showWorld('earth');
  if (!reducedMotion) controls.intro();

  startLoop();
  requestAnimationFrame(() => requestAnimationFrame(() => ui.hideLoader()));

  // Refine the textures in the background, a few milliseconds per frame.
  generateWorldTextures(hiQuality, {
    onProgress: (value) => ui.setProgress(value),
    cancelled: () => disposed,
  })
    .then((sharp) => {
      if (sharp && !disposed) {
        worlds.setTextures(sharp);
        dirty = true;
      }
    })
    .catch((error) => console.warn('Sharper textures were skipped:', error))
    .finally(() => {
      generating = false;
      ui.setProgress(1);
    });
}

// Lets the app be installed and open offline (only on https, e.g. GitHub Pages).
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Offline mode unavailable:', error));
  });
}
