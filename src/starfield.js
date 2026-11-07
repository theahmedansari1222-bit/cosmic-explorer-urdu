import * as THREE from 'three';
import { makeGalaxyCanvas, makeSunCanvas, mulberry32 } from './textures.js';

/** Normal of the great circle where the "Milky Way" band of stars is densest. */
export const BAND_NORMAL = new THREE.Vector3(0.28, 0.86, 0.42).normalize();

const STAR_RADIUS = 900;
const NEBULA_RADIUS = 1500;
const SUN_DISTANCE = 1200;

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vColor = aColor;
    vTwinkle = 0.82 + 0.18 * sin(uTime * (0.6 + aPhase * 0.8) + aPhase * 40.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = pow(clamp(1.0 - d * 2.0, 0.0, 1.0), 1.6) * 1.25;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * vTwinkle, a);
  }
`;

// Rough star colours: blue-white, white, pale yellow, orange, red.
const STAR_PALETTE = [
  [0.62, 0.72, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.93, 0.82],
  [1.0, 0.78, 0.55],
  [1.0, 0.6, 0.45],
];

function pickStarColor(rand) {
  const r = rand();
  if (r < 0.25) return STAR_PALETTE[0];
  if (r < 0.65) return STAR_PALETTE[1];
  if (r < 0.85) return STAR_PALETTE[2];
  if (r < 0.95) return STAR_PALETTE[3];
  return STAR_PALETTE[4];
}

function buildStars(count, pixelRatio) {
  const TWO_PI = Math.PI * 2;
  const rand = mulberry32(2024);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * rand());
  };

  const bandRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), BAND_NORMAL);
  const dir = new THREE.Vector3();

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const inBand = rand() < 0.4;
    if (inBand) {
      const phi = rand() * TWO_PI;
      dir.set(Math.cos(phi), gauss() * 0.17, Math.sin(phi)).normalize().applyQuaternion(bandRotation);
    } else {
      // Uniform point on a sphere.
      const z = rand() * 2 - 1;
      const phi = rand() * TWO_PI;
      const r = Math.sqrt(1 - z * z);
      dir.set(r * Math.cos(phi), z, r * Math.sin(phi));
    }

    positions[i * 3] = dir.x * STAR_RADIUS;
    positions[i * 3 + 1] = dir.y * STAR_RADIUS;
    positions[i * 3 + 2] = dir.z * STAR_RADIUS;

    const color = pickStarColor(rand);
    const brightness = (0.45 + 0.55 * Math.pow(rand(), 0.6)) * (inBand ? 0.85 : 1);
    colors[i * 3] = color[0] * brightness;
    colors[i * 3 + 1] = color[1] * brightness;
    colors[i * 3 + 2] = color[2] * brightness;

    // Mostly tiny stars, a few bright ones.
    sizes[i] = (1.0 + Math.pow(rand(), 6) * 2.6 + rand() * 0.5) * (inBand ? 0.9 : 1);
    phases[i] = rand();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function spriteTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Creates the sky: a faint nebula sphere, a distant Sun glow, thousands of
 * stars and a few galaxies. Everything is re-centred on the camera every frame,
 * so the sky always looks infinitely far away.
 */
export function createStarfield({ nebulaCanvas, sunDirection, starCount, pixelRatio }) {
  const root = new THREE.Group();
  const backdrop = new THREE.Group(); // nebula + Sun: always visible
  const starGroup = new THREE.Group(); // stars + galaxies: can be hidden
  root.add(backdrop, starGroup);

  // Nebula: a big inside-out sphere with a soft painted texture.
  if (nebulaCanvas) {
    const nebulaTexture = new THREE.CanvasTexture(nebulaCanvas);
    nebulaTexture.colorSpace = THREE.SRGBColorSpace;
    nebulaTexture.wrapS = THREE.RepeatWrapping;
    const nebula = new THREE.Mesh(
      new THREE.SphereGeometry(NEBULA_RADIUS, 48, 24),
      new THREE.MeshBasicMaterial({
        map: nebulaTexture,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        fog: false,
      }),
    );
    nebula.renderOrder = -10;
    backdrop.add(nebula);
  }

  // Distant Sun glow, in the same direction the scene's sunlight comes from.
  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: spriteTexture(makeSunCanvas(256)),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  sun.position.copy(sunDirection).multiplyScalar(SUN_DISTANCE);
  sun.scale.setScalar(240);
  sun.renderOrder = -5;
  backdrop.add(sun);

  // Stars.
  const stars = buildStars(starCount, pixelRatio);
  starGroup.add(stars);

  // A few distant galaxies.
  const galaxyRand = mulberry32(77);
  const tints = [
    [150, 170, 255],
    [255, 205, 160],
    [190, 160, 255],
    [140, 220, 255],
  ];
  const galaxyDir = new THREE.Vector3();
  for (let i = 0; i < tints.length; i++) {
    let tries = 0;
    do {
      galaxyDir
        .set(galaxyRand() * 2 - 1, galaxyRand() * 2 - 1, galaxyRand() * 2 - 1)
        .normalize();
      tries++;
    } while (galaxyDir.dot(sunDirection) > 0.7 && tries < 20); // keep clear of the Sun glow

    const galaxy = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: spriteTexture(makeGalaxyCanvas(256, 31 + i * 17, tints[i])),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0.8,
        fog: false,
      }),
    );
    galaxy.position.copy(galaxyDir).multiplyScalar(1100);
    const size = 70 + galaxyRand() * 60;
    galaxy.scale.set(size, size, 1);
    galaxy.material.rotation = galaxyRand() * Math.PI;
    galaxy.renderOrder = -4;
    starGroup.add(galaxy);
  }

  /** Call every frame: keeps the sky centred on the camera and drives twinkling. */
  function update(time, cameraPosition) {
    backdrop.position.copy(cameraPosition);
    starGroup.position.copy(cameraPosition);
    stars.material.uniforms.uTime.value = time;
  }

  function setStarsVisible(visible) {
    starGroup.visible = visible;
  }

  function setPixelRatio(value) {
    stars.material.uniforms.uPixelRatio.value = value;
  }

  function dispose() {
    root.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        if (object.material.map) object.material.map.dispose();
        object.material.dispose();
      }
    });
  }

  return { root, update, setStarsVisible, setPixelRatio, dispose };
}
