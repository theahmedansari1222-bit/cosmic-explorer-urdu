import * as THREE from 'three';
import { makeRingCanvas } from './textures.js';

/**
 * Scene units: Earth's radius is 2.
 * The sizes of Earth, Moon, Mars and Jupiter are to scale with each other.
 * Distances are heavily compressed so everything fits in one scene.
 */
const RADIUS = {
  earth: 2,
  moon: 2 * 0.2727,
  mars: 2 * 0.532,
  jupiter: 2 * 10.97,
  saturn: 2 * 9.14,
};

const MOON_ORBIT_RADIUS = 9;
const MARS_POSITION = new THREE.Vector3(-36, 5, -58);
const JUPITER_POSITION = new THREE.Vector3(105, 14, -165);
const SATURN_POSITION = new THREE.Vector3(-230, -30, -320);

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const EARTH_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform vec3 uSunDir;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSunDir);

    float ndl = dot(N, L);
    float lit = max(ndl, 0.0);
    float dayMix = smoothstep(-0.1, 0.25, ndl);

    vec3 dayCol = texture2D(uDay, vUv).rgb;
    vec3 nightCol = texture2D(uNight, vUv).rgb;

    // Oceans are the blue-dominant pixels of the day map.
    float ocean = clamp((dayCol.b - max(dayCol.r, dayCol.g)) * 5.0, 0.0, 1.0);

    // Sunlight plus a faint blue glow so the night side is not pure black.
    vec3 col = dayCol * (1.05 * lit + vec3(0.05, 0.07, 0.12));

    // Sun glint on the oceans.
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 70.0) * ocean * lit;
    col += vec3(1.0, 0.95, 0.85) * spec * 0.55;

    // Warm band along the terminator.
    float twilight = smoothstep(-0.18, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.22, ndl));
    col += vec3(0.9, 0.38, 0.14) * twilight * 0.05;

    // Decorative city lights, only on the dark side.
    col += nightCol * (1.0 - dayMix) * 1.4;

    // Soft blue atmospheric rim.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += vec3(0.25, 0.55, 1.0) * fres * (0.15 + 0.85 * smoothstep(-0.25, 0.5, ndl)) * 0.9;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const ATMOSPHERE_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

// Drawn on the inside of a slightly larger sphere (BackSide). The glow is
// strongest just outside the planet's edge and fades to nothing at the shell.
const ATMOSPHERE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunDir;
  uniform float uMax;
  uniform float uStrength;

  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float f = -dot(N, V);
    float t = clamp(f / uMax, 0.0, 1.0);
    float glow = pow(t, 2.2);
    float sunSide = smoothstep(-0.35, 0.45, dot(N, normalize(uSunDir)));
    float a = glow * uStrength * (0.12 + 0.88 * sunSide);
    gl_FragColor = vec4(mix(uColor, vec3(0.7, 0.9, 1.0), glow * 0.35), a);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

function createAtmosphere(radius, ratio, color, strength, sunDirection) {
  const geometry = new THREE.SphereGeometry(radius * ratio, 64, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunDir: { value: sunDirection },
      uMax: { value: Math.sqrt(1 - 1 / (ratio * ratio)) },
      uStrength: { value: strength },
    },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * Creates Earth, Moon, Mars and Jupiter.
 *
 * @param {object} options
 * @param {object} options.textures   canvases from generateWorldTextures()
 * @param {THREE.Vector3} options.sunDirection  unit vector pointing toward the Sun
 * @param {number} options.maxAnisotropy
 */
export function createWorlds({ textures, sunDirection, maxAnisotropy = 4 }) {
  const root = new THREE.Group();
  const current = {};

  function makeTexture(canvas, srgb) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(4, maxAnisotropy);
    return texture;
  }

  function setTexture(key, canvas, srgb, assign) {
    const previous = current[key];
    const texture = makeTexture(canvas, srgb);
    current[key] = texture;
    assign(texture);
    if (previous) previous.dispose();
  }

  /* ---------------- Earth ---------------- */
  const earthTilt = new THREE.Group();
  earthTilt.rotation.z = -THREE.MathUtils.degToRad(23.4);
  const earthSpin = new THREE.Group();

  current.earthDay = makeTexture(textures.earthDay, true);
  current.earthNight = makeTexture(textures.earthNight, true);
  current.clouds = makeTexture(textures.clouds, false);

  const earthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uDay: { value: current.earthDay },
      uNight: { value: current.earthNight },
      uSunDir: { value: sunDirection },
    },
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_FRAG,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.earth, 96, 64), earthMaterial);

  const cloudMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    alphaMap: current.clouds,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.earth * 1.012, 80, 48), cloudMaterial);
  clouds.renderOrder = 1;

  earthSpin.add(earth, clouds);
  earthTilt.add(earthSpin);
  earthTilt.add(createAtmosphere(RADIUS.earth, 1.085, 0x59a8ff, 1.15, sunDirection));
  root.add(earthTilt);

  /* ---------------- Moon ---------------- */
  const moonOrbit = new THREE.Group();
  moonOrbit.rotation.x = THREE.MathUtils.degToRad(5.1);

  current.moon = makeTexture(textures.moon, true);
  const moonMaterial = new THREE.MeshStandardMaterial({
    map: current.moon,
    bumpMap: current.moon,
    bumpScale: 2.0,
    roughness: 1,
    metalness: 0,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.moon, 64, 48), moonMaterial);
  moonOrbit.add(moon);
  root.add(moonOrbit);

  let moonAngle = -0.9;
  function placeMoon() {
    moon.position.set(Math.cos(moonAngle) * MOON_ORBIT_RADIUS, 0, Math.sin(moonAngle) * MOON_ORBIT_RADIUS);
    // Tidal locking: the same face always points at Earth.
    moon.rotation.y = -moonAngle + Math.PI;
  }
  placeMoon();

  /* ---------------- Mars ---------------- */
  const marsTilt = new THREE.Group();
  marsTilt.position.copy(MARS_POSITION);
  marsTilt.rotation.z = THREE.MathUtils.degToRad(25.2);

  current.mars = makeTexture(textures.mars, true);
  const marsMaterial = new THREE.MeshStandardMaterial({
    map: current.mars,
    bumpMap: current.mars,
    bumpScale: 1.5,
    roughness: 1,
    metalness: 0,
  });
  const mars = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.mars, 64, 48), marsMaterial);
  marsTilt.add(mars);
  marsTilt.add(createAtmosphere(RADIUS.mars, 1.045, 0xff9a66, 0.55, sunDirection));
  root.add(marsTilt);

  /* ---------------- Jupiter ---------------- */
  const jupiterTilt = new THREE.Group();
  jupiterTilt.position.copy(JUPITER_POSITION);
  jupiterTilt.rotation.z = THREE.MathUtils.degToRad(3.1);

  current.jupiter = makeTexture(textures.jupiter, true);
  const jupiterMaterial = new THREE.MeshStandardMaterial({
    map: current.jupiter,
    roughness: 1,
    metalness: 0,
  });
  const jupiter = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.jupiter, 96, 64), jupiterMaterial);
  jupiterTilt.add(jupiter);
  jupiterTilt.add(createAtmosphere(RADIUS.jupiter, 1.025, 0xe8d0a0, 0.4, sunDirection));
  root.add(jupiterTilt);

  /* ---------------- Saturn ---------------- */
  const saturnTilt = new THREE.Group();
  saturnTilt.position.copy(SATURN_POSITION);
  saturnTilt.rotation.z = THREE.MathUtils.degToRad(26.7);

  current.saturn = makeTexture(textures.saturn, true);
  const saturnMaterial = new THREE.MeshStandardMaterial({ map: current.saturn, roughness: 1, metalness: 0 });
  const saturn = new THREE.Mesh(new THREE.SphereGeometry(RADIUS.saturn, 96, 64), saturnMaterial);

  const ringInner = RADIUS.saturn * 1.24;
  const ringOuter = RADIUS.saturn * 2.3;
  const ringGeometry = new THREE.RingGeometry(ringInner, ringOuter, 128, 1);
  const ringPos = ringGeometry.attributes.position;
  const ringUv = ringGeometry.attributes.uv;
  const ringVec = new THREE.Vector3();
  for (let i = 0; i < ringPos.count; i++) {
    ringVec.fromBufferAttribute(ringPos, i);
    ringUv.setXY(i, (ringVec.length() - ringInner) / (ringOuter - ringInner), 0.5);
  }
  current.rings = new THREE.CanvasTexture(makeRingCanvas());
  current.rings.colorSpace = THREE.SRGBColorSpace;
  const ringMaterial = new THREE.MeshStandardMaterial({
    map: current.rings,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
  });
  const rings = new THREE.Mesh(ringGeometry, ringMaterial);
  rings.rotation.x = -Math.PI / 2;
  saturnTilt.add(saturn, rings, createAtmosphere(RADIUS.saturn, 1.02, 0xf0dca8, 0.3, sunDirection));
  root.add(saturnTilt);

  /* ---------------- Public API ---------------- */

  // What the camera can fly to.
  const bodies = {
    earth: { id: 'earth', object: earthTilt, radius: RADIUS.earth },
    moon: { id: 'moon', object: moon, radius: RADIUS.moon },
    mars: { id: 'mars', object: marsTilt, radius: RADIUS.mars },
    jupiter: { id: 'jupiter', object: jupiterTilt, radius: RADIUS.jupiter },
    saturn: { id: 'saturn', object: saturnTilt, radius: RADIUS.saturn },
  };

  /** Advance the simulation by `dt` seconds (0 while paused). */
  function update(dt) {
    if (dt === 0) return;
    earthSpin.rotation.y += dt * 0.11;
    clouds.rotation.y += dt * 0.014;
    moonAngle += dt * 0.06;
    placeMoon();
    mars.rotation.y += dt * 0.09;
    jupiter.rotation.y += dt * 0.12;
    saturn.rotation.y += dt * 0.1;
  }

  /** Swap in sharper textures once they have finished generating. */
  function setTextures(canvases) {
    setTexture('earthDay', canvases.earthDay, true, (t) => {
      earthMaterial.uniforms.uDay.value = t;
    });
    setTexture('earthNight', canvases.earthNight, true, (t) => {
      earthMaterial.uniforms.uNight.value = t;
    });
    setTexture('clouds', canvases.clouds, false, (t) => {
      cloudMaterial.alphaMap = t;
    });
    setTexture('moon', canvases.moon, true, (t) => {
      moonMaterial.map = t;
      moonMaterial.bumpMap = t;
    });
    setTexture('mars', canvases.mars, true, (t) => {
      marsMaterial.map = t;
      marsMaterial.bumpMap = t;
    });
    setTexture('jupiter', canvases.jupiter, true, (t) => {
      jupiterMaterial.map = t;
    });
    setTexture('saturn', canvases.saturn, true, (t) => {
      saturnMaterial.map = t;
    });
  }

  /** Release all GPU resources. */
  function dispose() {
    root.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach((material) => material.dispose());
      }
    });
    Object.values(current).forEach((texture) => texture.dispose());
  }

  return { root, bodies, update, setTextures, dispose };
}
