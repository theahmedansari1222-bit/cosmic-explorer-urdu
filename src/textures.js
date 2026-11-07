/**
 * Procedural textures.
 *
 * Every surface in Cosmic Explorer is generated at runtime on <canvas> elements,
 * so the site needs no image files, has no licensing concerns and cannot show a
 * broken image. Pixel work is spread across animation frames (a few milliseconds
 * per frame) so the page stays responsive while textures are being built.
 *
 * NOTE: these are artistic approximations, not real maps of any planet.
 */

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Tiny deterministic random number generator (same seed, same universe). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Smooth 0..1 ramp. Works in both directions (edge0 > edge1 reverses it). */
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* 3D value noise + fractal Brownian motion                            */
/* ------------------------------------------------------------------ */

function createNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  const p = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    p[i] = i;
    vals[i] = rand();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function noise(x, y, z) {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const zf = Math.floor(z);
    const fx = x - xf;
    const fy = y - yf;
    const fz = z - zf;
    const X = xf & 255;
    const Y = yf & 255;
    const Z = zf & 255;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const a = perm[X];
    const b = perm[X + 1];
    const aa = perm[a + Y];
    const ab = perm[a + Y + 1];
    const ba = perm[b + Y];
    const bb = perm[b + Y + 1];

    const v000 = vals[perm[aa + Z]];
    const v001 = vals[perm[aa + Z + 1]];
    const v010 = vals[perm[ab + Z]];
    const v011 = vals[perm[ab + Z + 1]];
    const v100 = vals[perm[ba + Z]];
    const v101 = vals[perm[ba + Z + 1]];
    const v110 = vals[perm[bb + Z]];
    const v111 = vals[perm[bb + Z + 1]];

    const x00 = v000 + (v100 - v000) * u;
    const x01 = v001 + (v101 - v001) * u;
    const x10 = v010 + (v110 - v010) * u;
    const x11 = v011 + (v111 - v011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  };
}

// Different offsets per octave break up the grid alignment of value noise.
const OFFSETS = [
  12.3, 47.1, 5.7, 91.2, 3.3, 66.6, 27.8, 81.4, 14.9, 55.5, 21.2, 38.8, 7.7, 99.1, 62.3, 33.3,
  71.7, 9.9, 44.4, 17.1, 83.5, 58.2, 36.6, 25.4,
];

/** Fractal noise, normalised to roughly 0..1 (mean about 0.5). */
function fbm(noise, x, y, z, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    const o = i * 3;
    sum += amp * noise(x * f + OFFSETS[o], y * f + OFFSETS[o + 1], z * f + OFFSETS[o + 2]);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* Sphere-map painter                                                  */
/* ------------------------------------------------------------------ */

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Paints one or more equirectangular maps. For every pixel, `pixelFn` receives
 * a point (x, y, z) on the unit sphere and writes RGB values (0..255) for each
 * layer into `out` (layer 0 -> out[0..2], layer 1 -> out[3..5], ...).
 *
 * Because colours are computed from 3D positions, the maps have no seams and no
 * pinching at the poles. The work is split into time-boxed slices so that the
 * browser can keep drawing frames in between.
 *
 * Resolves to an array of canvases, or null if `cancelled()` returned true.
 */
async function paintSphereMap(width, height, layers, pixelFn, options = {}) {
  const { budgetMs = 8, onProgress, cancelled } = options;

  const canvases = [];
  const contexts = [];
  const datas = [];
  for (let l = 0; l < layers; l++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    canvases.push(canvas);
    contexts.push({ ctx, image });
    datas.push(image.data);
  }

  const cosP = new Float32Array(width);
  const sinP = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    const phi = ((i + 0.5) / width) * TWO_PI;
    cosP[i] = Math.cos(phi);
    sinP[i] = Math.sin(phi);
  }

  const out = new Float32Array(layers * 3);
  let row = 0;

  while (row < height) {
    const sliceStart = performance.now();
    do {
      const theta = ((row + 0.5) / height) * Math.PI;
      const sinT = Math.sin(theta);
      const y = Math.cos(theta);
      let idx = row * width * 4;
      for (let col = 0; col < width; col++) {
        // Same parametrisation as THREE.SphereGeometry, so maps line up.
        pixelFn(-cosP[col] * sinT, y, sinP[col] * sinT, out);
        for (let l = 0; l < layers; l++) {
          const d = datas[l];
          const o = l * 3;
          d[idx] = out[o];
          d[idx + 1] = out[o + 1];
          d[idx + 2] = out[o + 2];
          d[idx + 3] = 255;
        }
        idx += 4;
      }
      row++;
    } while (row < height && performance.now() - sliceStart < budgetMs);

    if (onProgress) onProgress(row / height);
    if (cancelled && cancelled()) return null;
    if (row < height) await nextFrame();
  }

  for (let l = 0; l < layers; l++) {
    contexts[l].ctx.putImageData(contexts[l].image, 0, 0);
  }
  return canvases;
}

/* ------------------------------------------------------------------ */
/* Crater stamping (Moon and Mars)                                     */
/* ------------------------------------------------------------------ */

/**
 * Draws soft crater shapes (dark floor, bright rim) onto a finished map.
 * Circles are stretched horizontally by 1/sin(latitude) so they look round on
 * the sphere, and are drawn twice when they cross the map's left/right edge.
 */
function stampCraters(canvas, seed, { count, minR, maxR, dark, rim, strength }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const rand = mulberry32(seed);
  const darkRgb = dark.join(',');
  const rimRgb = rim.join(',');

  for (let i = 0; i < count; i++) {
    const y = (rand() * 2 - 1) * 0.94;
    const theta = Math.acos(y);
    const cx = rand() * W;
    const cy = (theta / Math.PI) * H;
    const angular = minR * Math.pow(maxR / minR, Math.pow(rand(), 2.4));
    const ry = (angular / Math.PI) * H;
    const power = strength * (0.55 + 0.45 * rand());
    if (ry < 0.7) continue;

    const sx = 1 / Math.max(Math.sin(theta), 0.32);
    const rx = ry * sx;
    const offsets = [0];
    if (cx - rx < 0) offsets.push(W);
    if (cx + rx > W) offsets.push(-W);

    for (const off of offsets) {
      ctx.save();
      ctx.translate(cx + off, cy);
      ctx.scale(sx, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
      g.addColorStop(0.0, `rgba(${darkRgb},${(0.4 * power).toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${darkRgb},${(0.26 * power).toFixed(3)})`);
      g.addColorStop(0.8, `rgba(${darkRgb},${(0.05 * power).toFixed(3)})`);
      g.addColorStop(0.9, `rgba(${rimRgb},${(0.2 * power).toFixed(3)})`);
      g.addColorStop(1.0, `rgba(${rimRgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, ry, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pixel functions for each world                                      */
/* ------------------------------------------------------------------ */

const SEA_LEVEL = 0.545;

/** Earth: layer 0 = daytime colour, layer 1 = decorative city lights. */
function earthPixelFn(N) {
  return (x, y, z, out) => {
    // Domain warping gives continents organic, irregular coastlines.
    const warp = fbm(N, x * 1.1 + 2.0, y * 1.1 - 1.0, z * 1.1 + 4.0, 2) - 0.5;
    const e = fbm(N, x * 1.45 + warp * 1.2, y * 1.45 + warp * 0.9, z * 1.45 - warp * 1.2, 5);

    const lat = Math.abs(y);
    const iceEdge = (N(x * 5.0 + 3.0, y * 5.0, z * 5.0) - 0.5) * 0.1;
    const ice = smoothstep(0.925, 0.98, lat + iceEdge);

    let r;
    let g;
    let b;
    let lights = 0;

    if (e < SEA_LEVEL) {
      // Ocean: turquoise shallows fading to deep blue.
      const depth = clamp01((SEA_LEVEL - e) / 0.2);
      if (depth < 0.4) {
        const t = depth / 0.4;
        r = mix(0.1, 0.04, t);
        g = mix(0.44, 0.26, t);
        b = mix(0.64, 0.54, t);
      } else {
        const t = (depth - 0.4) / 0.6;
        r = mix(0.04, 0.015, t);
        g = mix(0.26, 0.11, t);
        b = mix(0.54, 0.3, t);
      }
    } else {
      const h = clamp01((e - SEA_LEVEL) / 0.3);
      const moist = fbm(N, x * 2.3 + 4.0, y * 2.3 - 2.0, z * 2.3, 3);
      const temp = clamp01(1.12 - Math.pow(lat, 1.5) * 1.25 - h * 0.35 + (moist - 0.5) * 0.2);

      // Vegetation: grassland to dense forest.
      const wet = smoothstep(0.4, 0.68, moist);
      let lr = mix(0.36, 0.09, wet);
      let lg = mix(0.48, 0.28, wet);
      let lb = mix(0.2, 0.11, wet);

      // Deserts where it is hot and dry.
      const dry = smoothstep(0.45, 0.33, moist) * smoothstep(0.35, 0.65, temp);
      lr = mix(lr, 0.78, dry);
      lg = mix(lg, 0.64, dry);
      lb = mix(lb, 0.4, dry);

      // Tundra in cold regions.
      const cold = smoothstep(0.42, 0.22, temp);
      lr = mix(lr, 0.55, cold);
      lg = mix(lg, 0.58, cold);
      lb = mix(lb, 0.48, cold);

      // Bare rock and snow on high ground.
      const rock = smoothstep(0.46, 0.72, h);
      lr = mix(lr, 0.46, rock);
      lg = mix(lg, 0.4, rock);
      lb = mix(lb, 0.34, rock);
      const snow = smoothstep(0.8, 0.96, h);
      lr = mix(lr, 0.95, snow);
      lg = mix(lg, 0.96, snow);
      lb = mix(lb, 0.98, snow);

      const grain = 0.92 + 0.16 * N(x * 45, y * 45, z * 45);
      r = lr * grain;
      g = lg * grain;
      b = lb * grain;

      // Decorative night-side lights, clustered on low, temperate land.
      if (h < 0.45 && lat < 0.78) {
        const cluster = fbm(N, x * 6.5 + 8.0, y * 6.5, z * 6.5, 2);
        const fine = N(x * 34 + 1.0, y * 34, z * 34);
        lights = smoothstep(0.6, 0.74, cluster) * smoothstep(0.45, 0.8, fine) * (1 - dry * 0.85);
      }
    }

    // Polar ice over land and sea.
    r = mix(r, 0.93, ice);
    g = mix(g, 0.96, ice);
    b = mix(b, 1.0, ice);

    out[0] = r * 255;
    out[1] = g * 255;
    out[2] = b * 255;
    out[3] = lights * 255;
    out[4] = lights * 205;
    out[5] = lights * 120;
  };
}

/** Cloud cover, stored as grey (used as an alpha map). */
function cloudPixelFn(N) {
  return (x, y, z, out) => {
    const warp = fbm(N, x * 1.6 + 5.0, y * 1.6, z * 1.6, 3) - 0.5;
    const c = fbm(N, x * 2.4 + warp * 1.2, y * 3.6 + warp * 0.8, z * 2.4 - warp * 1.2, 6);
    // Slightly clearer skies around the subtropics (about 25 degrees latitude).
    const d = Math.abs(y) - 0.42;
    const belt = 1 - 0.35 * Math.exp(-(d * d) / 0.02);
    const v = smoothstep(0.44, 0.7, c * belt) * 255;
    out[0] = v;
    out[1] = v;
    out[2] = v;
  };
}

/** Moon: pale highlands and darker volcanic plains (maria). Craters are stamped later. */
function moonPixelFn(N) {
  return (x, y, z, out) => {
    const m = fbm(N, x * 1.15 + 7.0, y * 1.15, z * 1.15 - 3.0, 4);
    const mare = smoothstep(0.56, 0.66, m);
    const broad = fbm(N, x * 3.0, y * 3.0 + 5.0, z * 3.0, 5);
    const grain = N(x * 22.0, y * 22.0, z * 22.0);
    const v = mix(0.64, 0.3, mare) * (0.8 + 0.36 * broad) * (0.94 + 0.12 * grain);
    out[0] = clamp01(v * 1.03) * 255;
    out[1] = clamp01(v) * 255;
    out[2] = clamp01(v * 0.95) * 255;
  };
}

/** Mars: rusty dust, darker basalt regions and bright polar caps. */
function marsPixelFn(N) {
  return (x, y, z, out) => {
    const base = smoothstep(0.35, 0.65, fbm(N, x * 1.6 + 5.0, y * 1.6, z * 1.6, 5));
    const dark = fbm(N, x * 2.6 + 9.0, y * 2.6 - 4.0, z * 2.6, 3);
    const fine = fbm(N, x * 11.0, y * 11.0, z * 11.0, 2);

    let r = mix(0.66, 0.84, base);
    let g = mix(0.31, 0.5, base);
    let b = mix(0.18, 0.31, base);

    const d = smoothstep(0.54, 0.68, dark) * 0.6;
    r = mix(r, 0.32, d);
    g = mix(g, 0.19, d);
    b = mix(b, 0.15, d);

    const shade = 0.82 + 0.36 * fine;
    r *= shade;
    g *= shade;
    b *= shade;

    const capEdge = Math.abs(y) + (fbm(N, x * 4.0, y * 4.0, z * 4.0, 3) - 0.5) * 0.14;
    const cap = smoothstep(0.95, 0.985, capEdge);
    r = mix(r, 0.94, cap);
    g = mix(g, 0.93, cap);
    b = mix(b, 0.9, cap);

    out[0] = clamp01(r) * 255;
    out[1] = clamp01(g) * 255;
    out[2] = clamp01(b) * 255;
  };
}

const JUPITER_STOPS = [
  [0.0, 0.46, 0.28, 0.2],
  [0.28, 0.68, 0.44, 0.28],
  [0.52, 0.84, 0.68, 0.48],
  [0.76, 0.94, 0.86, 0.72],
  [1.0, 0.98, 0.94, 0.86],
];

function samplePalette(stops, t, target) {
  const n = stops.length;
  for (let i = 1; i < n; i++) {
    if (t <= stops[i][0] || i === n - 1) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = clamp01((t - a[0]) / (b[0] - a[0]));
      target[0] = mix(a[1], b[1], k);
      target[1] = mix(a[2], b[2], k);
      target[2] = mix(a[3], b[3], k);
      return;
    }
  }
}

/** Jupiter: stretched, turbulent cloud bands plus a simplified Great Red Spot. */
function jupiterPixelFn(N) {
  const rgb = new Float32Array(3);
  const spotY = Math.sin(-0.384); // about 22 degrees south
  const spotLon = 2.2;

  return (x, y, z, out) => {
    // Noise squashed in x/z and stretched in y creates east-west streaks.
    const warp = fbm(N, x * 2.2, y * 9.0, z * 2.2, 4) - 0.5;
    const fine = fbm(N, x * 5.0 + 3.0, y * 34.0, z * 5.0, 4) - 0.5;
    const s = Math.sin(y * 19.0 + warp * 3.2) * 0.5 + 0.5;
    const s2 = Math.sin(y * 43.0 + warp * 5.0 + 1.3) * 0.5 + 0.5;
    const t = clamp01(s * 0.62 + s2 * 0.22 + fine * 0.5 + 0.08);
    samplePalette(JUPITER_STOPS, t, rgb);
    let r = rgb[0];
    let g = rgb[1];
    let b = rgb[2];

    // Cooler, greyer polar regions.
    const pol = smoothstep(0.62, 0.95, Math.abs(y)) * 0.5;
    r = mix(r, 0.5, pol);
    g = mix(g, 0.52, pol);
    b = mix(b, 0.56, pol);

    // Great Red Spot (decorative, simplified).
    const dy = (y - spotY) / 0.125;
    if (dy > -1 && dy < 1) {
      const lon = Math.atan2(z, -x);
      let dl = lon - spotLon;
      dl = Math.atan2(Math.sin(dl), Math.cos(dl));
      const dx = dl / 0.24;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const m = smoothstep(1.0, 0.55, d2);
        const sw = N(x * 14.0 + d2 * 3.0, y * 14.0, z * 14.0);
        r = mix(r, 0.7 + 0.14 * sw, m * 0.92);
        g = mix(g, 0.27 + 0.16 * sw, m * 0.92);
        b = mix(b, 0.17 + 0.12 * sw, m * 0.92);
      }
    }

    out[0] = clamp01(r) * 255;
    out[1] = clamp01(g) * 255;
    out[2] = clamp01(b) * 255;
  };
}

/** Saturn: pale golden bands, calmer than Jupiter. */
function saturnPixelFn(N) {
  return (x, y, z, out) => {
    const w = fbm(N, x * 1.6, y * 7.0, z * 1.6, 3) - 0.5;
    const s = Math.sin(y * 14.0 + w * 2.4) * 0.5 + 0.5;
    const t = clamp01(s * 0.7 + 0.15 + (fbm(N, x * 3.0 + 4.0, y * 26.0, z * 3.0, 2) - 0.5) * 0.3);
    out[0] = mix(0.72, 0.93, t) * 255;
    out[1] = mix(0.6, 0.83, t) * 255;
    out[2] = mix(0.42, 0.62, t) * 255;
  };
}

/** Background nebula: faint blue, teal and magenta wisps, strongest along the star band. */
function nebulaPixelFn(N, band) {
  return (x, y, z, out) => {
    const bd = x * band[0] + y * band[1] + z * band[2];
    const bandGlow = Math.exp(-(bd * bd) / 0.05);

    const n1 = fbm(N, x * 1.5, y * 1.5, z * 1.5, 5);
    const n2 = fbm(N, x * 2.6 + 7.0, y * 2.6 + 3.0, z * 2.6, 5);
    const n3 = fbm(N, x * 1.1 + 13.0, y * 1.1, z * 1.1 + 5.0, 4);

    const a = smoothstep(0.48, 0.78, n1) * (0.45 + 0.9 * bandGlow);
    const b = smoothstep(0.52, 0.8, n2) * (0.35 + 0.9 * bandGlow);
    const c = smoothstep(0.58, 0.82, n3) * 0.5;

    const k = 0.55 * 255;
    const dither = Math.random() - 0.5;
    out[0] = clamp01(a * 0.22 + b * 0.04 + c * 0.28 + bandGlow * 0.035) * k + dither;
    out[1] = clamp01(a * 0.1 + b * 0.18 + c * 0.05 + bandGlow * 0.045) * k + dither;
    out[2] = clamp01(a * 0.42 + b * 0.3 + c * 0.2 + bandGlow * 0.07) * k + dither;
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** [width, height] of each map. "low" is quick; the others refine it in the background. */
export const QUALITY = {
  low: { earth: [512, 256], clouds: [512, 256], moon: [256, 128], mars: [256, 128], jupiter: [256, 128], saturn: [256, 128] },
  mobile: {
    earth: [1280, 640],
    clouds: [768, 384],
    moon: [768, 384],
    mars: [768, 384],
    jupiter: [768, 384],
    saturn: [768, 384],
  },
  desktop: {
    earth: [2048, 1024],
    clouds: [1536, 768],
    moon: [2048, 1024],
    mars: [1536, 768],
    jupiter: [1024, 512],
    saturn: [1024, 512],
  },
};

/**
 * Builds the surface maps for all worlds.
 * Resolves to { earthDay, earthNight, clouds, moon, mars, jupiter } (canvases),
 * or null if cancelled.
 */
export async function generateWorldTextures(quality = 'low', { onProgress, cancelled } = {}) {
  const q = QUALITY[quality] || QUALITY.low;
  const N = createNoise(1337);
  let done = 0;

  const options = (weight) => ({
    budgetMs: 8,
    cancelled,
    onProgress: (p) => {
      if (onProgress) onProgress(Math.min(1, done + weight * p));
    },
  });

  const earth = await paintSphereMap(q.earth[0], q.earth[1], 2, earthPixelFn(N), options(0.42));
  if (!earth) return null;
  done += 0.42;

  const clouds = await paintSphereMap(q.clouds[0], q.clouds[1], 1, cloudPixelFn(N), options(0.16));
  if (!clouds) return null;
  done += 0.16;

  const moon = await paintSphereMap(q.moon[0], q.moon[1], 1, moonPixelFn(N), options(0.16));
  if (!moon) return null;
  stampCraters(moon[0], 7, {
    count: Math.round(q.moon[0] * 0.6) + 60,
    minR: 0.007,
    maxR: 0.1,
    dark: [10, 10, 12],
    rim: [255, 255, 255],
    strength: 1,
  });
  done += 0.16;

  const mars = await paintSphereMap(q.mars[0], q.mars[1], 1, marsPixelFn(N), options(0.16));
  if (!mars) return null;
  stampCraters(mars[0], 21, {
    count: Math.round(q.mars[0] * 0.16) + 30,
    minR: 0.008,
    maxR: 0.07,
    dark: [50, 25, 15],
    rim: [255, 215, 180],
    strength: 0.7,
  });
  done += 0.16;

  const jupiter = await paintSphereMap(q.jupiter[0], q.jupiter[1], 1, jupiterPixelFn(N), options(0.05));
  if (!jupiter) return null;
  done += 0.05;

  const saturn = await paintSphereMap(q.saturn[0], q.saturn[1], 1, saturnPixelFn(N), options(0.05));
  if (!saturn) return null;

  if (onProgress) onProgress(1);
  return {
    earthDay: earth[0],
    earthNight: earth[1],
    clouds: clouds[0],
    moon: moon[0],
    mars: mars[0],
    jupiter: jupiter[0],
    saturn: saturn[0],
  };
}

/** Low-resolution nebula backdrop. `band` is the [x, y, z] normal of the star band. */
export async function generateNebulaTexture(band, size = [512, 256]) {
  const N = createNoise(90210);
  const result = await paintSphereMap(size[0], size[1], 1, nebulaPixelFn(N, band), { budgetMs: 8 });
  return result ? result[0] : null;
}

/** Saturn's rings: gaps and bands drawn across the ring's radius (left = inner edge). */
export function makeRingCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 512, 0);
  g.addColorStop(0.0, 'rgba(120,105,85,0)');
  g.addColorStop(0.08, 'rgba(120,105,85,0.25)');
  g.addColorStop(0.22, 'rgba(190,170,140,0.55)');
  g.addColorStop(0.3, 'rgba(228,208,172,0.95)');
  g.addColorStop(0.52, 'rgba(215,195,160,0.9)');
  g.addColorStop(0.56, 'rgba(30,25,20,0.04)'); // the Cassini Division
  g.addColorStop(0.6, 'rgba(210,190,155,0.8)');
  g.addColorStop(0.85, 'rgba(190,170,140,0.65)');
  g.addColorStop(1.0, 'rgba(190,170,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 8);
  return canvas;
}

/** Small round soft dot for point sprites. */
export function makeSoftDotCanvas(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Soft glow used for the distant Sun. */
export function makeSunCanvas(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0.0, 'rgba(255,252,240,1)');
  g.addColorStop(0.05, 'rgba(255,246,222,1)');
  g.addColorStop(0.14, 'rgba(255,226,175,0.62)');
  g.addColorStop(0.38, 'rgba(255,196,130,0.17)');
  g.addColorStop(0.7, 'rgba(255,170,110,0.05)');
  g.addColorStop(1.0, 'rgba(255,170,100,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** A tiny, flattened glow that reads as a distant galaxy. */
export function makeGalaxyCanvas(size = 256, seed = 1, tint = [150, 170, 255]) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(seed);
  ctx.translate(size / 2, size / 2);
  ctx.rotate(rand() * Math.PI);
  ctx.scale(1, 0.34 + rand() * 0.2);
  const rgb = tint.join(',');
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
  g.addColorStop(0.0, 'rgba(255,248,235,0.95)');
  g.addColorStop(0.1, 'rgba(235,235,255,0.55)');
  g.addColorStop(0.4, `rgba(${rgb},0.2)`);
  g.addColorStop(1.0, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(-size, -size, size * 2, size * 2);
  return canvas;
}
