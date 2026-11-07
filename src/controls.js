import * as THREE from 'three';

/**
 * Touch-first orbit controls built on Pointer Events (one API for fingers,
 * mouse and pen).
 *
 *  - one finger / left mouse button: rotate around the focused world
 *  - two fingers / mouse wheel: zoom
 *  - smooth momentum after a drag
 *  - eased "fly-to" when the focused world changes or the view is reset
 *
 * The canvas has `touch-action: none` in CSS, so the browser never scrolls or
 * zooms the page while the person is interacting with the 3D view. Buttons and
 * the info card are separate elements and keep working normally.
 */

const TWO_PI = Math.PI * 2;
const DEFAULT_AZIMUTH = 0;
const DEFAULT_ELEVATION = THREE.MathUtils.degToRad(14);
const MAX_ELEVATION = THREE.MathUtils.degToRad(86);
const FILL = 0.68; // how much of the screen a focused world should fill at home zoom
const MAX_ZOOM = 2.6; // furthest zoom-out, as a multiple of the home distance

const clamp = THREE.MathUtils.clamp;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createControls(camera, element) {
  const abort = new AbortController();
  const { signal } = abort;

  const target = new THREE.Vector3();
  const focusPosition = new THREE.Vector3();
  const previousCamera = new THREE.Vector3();
  const pointers = new Map();

  let focus = null; // { object, radius }
  let azimuth = DEFAULT_AZIMUTH;
  let elevation = DEFAULT_ELEVATION;
  let targetAzimuth = azimuth;
  let targetElevation = elevation;
  let velocityAz = 0;
  let velocityEl = 0;
  let lastMoveTime = 0;

  let home = 20; // camera distance that frames the focused world nicely
  let minZoom = 0.3;
  let zoom = 1;
  let distance = 20;
  let targetDistance = 20;

  let travel = null; // active fly-to: { t, duration, from, fromDistance }
  let dragging = false;
  let pinchPrevious = 0;
  let changed = true;

  /* ---------------- framing ---------------- */

  function computeHome() {
    if (!focus) return;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanMin = Math.min(tanV, tanV * camera.aspect);
    const t = FILL * tanMin;
    home = focus.radius * Math.sqrt(1 + 1 / (t * t));
    minZoom = (focus.radius * 1.5) / home;
    zoom = clamp(zoom, minZoom, MAX_ZOOM);
    targetDistance = home * zoom;
  }

  function beginTravel(duration) {
    travel = { t: 0, duration, from: target.clone(), fromDistance: distance };
  }

  function zoomBy(factor) {
    zoom = clamp(zoom * factor, minZoom, MAX_ZOOM);
    targetDistance = home * zoom;
    changed = true;
  }

  /* ---------------- public actions ---------------- */

  /** Focus on a world: { object: Object3D, radius: number }. */
  function setFocus(body, { instant = false } = {}) {
    const first = focus === null;
    focus = body;
    zoom = 1;
    computeHome();
    body.object.getWorldPosition(focusPosition);

    if (instant || first) {
      target.copy(focusPosition);
      distance = targetDistance;
      travel = null;
    } else {
      const length = target.distanceTo(focusPosition);
      const duration = clamp(1.3 + Math.log10(1 + length) * 0.6, 1.3, 3.2);
      beginTravel(duration);
    }
    changed = true;
  }

  /** Return to the default angle and zoom for the current world. */
  function reset() {
    zoom = 1;
    computeHome();
    targetAzimuth = azimuth + wrapAngle(DEFAULT_AZIMUTH - azimuth);
    targetElevation = DEFAULT_ELEVATION;
    velocityAz = 0;
    velocityEl = 0;
    beginTravel(1.3);
    changed = true;
  }

  /** Opening shot: start far away and glide in. */
  function intro() {
    if (!focus) return;
    distance = home * 2.1;
    travel = { t: 0, duration: 3, from: target.clone(), fromDistance: distance };
    changed = true;
  }

  /** Call when the canvas size or camera aspect changes. */
  function handleResize() {
    computeHome();
    changed = true;
  }

  /* ---------------- input ---------------- */

  function rotate(dx, dy, timeStamp) {
    const height = element.clientHeight || 1;
    // Rotate more slowly when zoomed in close, for finer control.
    const speed = (TWO_PI / height) * clamp(Math.sqrt(distance / home), 0.5, 1.2);
    const dAz = -dx * speed;
    const dEl = dy * speed;

    targetAzimuth += dAz;
    targetElevation = clamp(targetElevation + dEl, -MAX_ELEVATION, MAX_ELEVATION);

    const dt = Math.max((timeStamp - lastMoveTime) / 1000, 0.008);
    lastMoveTime = timeStamp;
    velocityAz = clamp(velocityAz * 0.6 + (dAz / dt) * 0.4, -6, 6);
    velocityEl = clamp(velocityEl * 0.6 + (dEl / dt) * 0.4, -6, 6);
    changed = true;
  }

  function pinchDistance() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already gone; ignore */
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      dragging = true;
      velocityAz = 0;
      velocityEl = 0;
      lastMoveTime = event.timeStamp;
      element.classList.add('is-dragging');
    } else if (pointers.size === 2) {
      pinchPrevious = pinchDistance();
    }
  }

  function onPointerMove(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (pointers.size === 1) {
      rotate(dx, dy, event.timeStamp);
    } else if (pointers.size === 2) {
      const current = pinchDistance();
      if (pinchPrevious > 0 && current > 0) zoomBy(pinchPrevious / current);
      pinchPrevious = current;
    }
  }

  function onPointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      /* not captured; ignore */
    }

    if (pointers.size === 0) {
      dragging = false;
      element.classList.remove('is-dragging');
      // If the finger rested before lifting, do not throw the globe.
      if (event.timeStamp - lastMoveTime > 90) {
        velocityAz = 0;
        velocityEl = 0;
      }
    }
    pinchPrevious = 0;
  }

  function onWheel(event) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    zoomBy(Math.exp(clamp(event.deltaY * unit, -300, 300) * 0.0011));
  }

  element.addEventListener('pointerdown', onPointerDown, { signal });
  element.addEventListener('pointermove', onPointerMove, { signal });
  element.addEventListener('pointerup', onPointerEnd, { signal });
  element.addEventListener('pointercancel', onPointerEnd, { signal });
  element.addEventListener('lostpointercapture', onPointerEnd, { signal });
  element.addEventListener('wheel', onWheel, { passive: false, signal });
  element.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });

  /* ---------------- per-frame update ---------------- */

  /**
   * Advances the camera by `dt` real seconds.
   * Returns true if the view changed (so the caller knows a redraw is needed).
   */
  function update(dt) {
    if (!focus) return false;
    previousCamera.copy(camera.position);

    // Momentum after letting go.
    if (!dragging && (velocityAz !== 0 || velocityEl !== 0)) {
      targetAzimuth += velocityAz * dt;
      targetElevation = clamp(targetElevation + velocityEl * dt, -MAX_ELEVATION, MAX_ELEVATION);
      const decay = Math.exp(-dt * 3.2);
      velocityAz *= decay;
      velocityEl *= decay;
      if (Math.abs(velocityAz) < 0.002) velocityAz = 0;
      if (Math.abs(velocityEl) < 0.002) velocityEl = 0;
    }

    // Ease the angles toward their targets (slower during fly-to moves).
    const angleK = 1 - Math.exp(-dt * (travel ? 5 : 14));
    azimuth += (targetAzimuth - azimuth) * angleK;
    elevation += (targetElevation - elevation) * angleK;

    // Follow the focused world (the Moon keeps moving).
    focus.object.getWorldPosition(focusPosition);
    if (travel) {
      travel.t += dt / travel.duration;
      const k = easeInOutCubic(Math.min(travel.t, 1));
      target.lerpVectors(travel.from, focusPosition, k);
      distance = travel.fromDistance + (targetDistance - travel.fromDistance) * k;
      if (travel.t >= 1) travel = null;
    } else {
      target.copy(focusPosition);
      distance += (targetDistance - distance) * (1 - Math.exp(-dt * 9));
    }

    const cosE = Math.cos(elevation);
    camera.position.set(
      target.x + distance * cosE * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * cosE * Math.cos(azimuth),
    );
    camera.lookAt(target);

    const moved = changed || previousCamera.distanceToSquared(camera.position) > 1e-9;
    changed = false;
    return moved;
  }

  function dispose() {
    abort.abort();
    pointers.clear();
  }

  return { setFocus, reset, intro, handleResize, update, dispose };
}
