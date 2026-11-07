import * as THREE from 'three';
import { makeSoftDotCanvas, mulberry32 } from './textures.js';

/** A spiral galaxy made of ~6,000 points. Artistic, not a real galaxy. */
const GALAXY_RADIUS = 140;
const GALAXY_POSITION = new THREE.Vector3(430, 150, -720);

export function createGalaxy() {
  const rand = mulberry32(555);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * rand());
  };

  const count = 6000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const core = [1.0, 0.86, 0.62];
  const arm = [0.62, 0.76, 1.0];

  for (let i = 0; i < count; i++) {
    const isCore = i < 1100;
    let x, y, z, t;
    if (isCore) {
      const r = Math.pow(rand(), 1.6) * GALAXY_RADIUS * 0.22;
      const a = rand() * Math.PI * 2;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = gauss() * GALAXY_RADIUS * 0.05;
      t = 0;
    } else {
      const r = Math.pow(rand(), 0.7) * GALAXY_RADIUS;
      const a = (r / GALAXY_RADIUS) * 5.5 + (i % 2) * Math.PI + gauss() * 0.28 * (1 - 0.5 * (r / GALAXY_RADIUS));
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = gauss() * GALAXY_RADIUS * 0.025 * (1 - r / GALAXY_RADIUS);
      t = r / GALAXY_RADIUS;
    }
    positions.set([x, y, z], i * 3);
    const b = 0.55 + 0.45 * rand();
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = (core[c] + (arm[c] - core[c]) * Math.min(1, t * 1.4)) * b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const texture = new THREE.CanvasTexture(makeSoftDotCanvas());
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.PointsMaterial({
    size: 3.4,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  const root = new THREE.Group();
  root.position.copy(GALAXY_POSITION);
  root.rotation.set(0.95, 0, 0.35); // tilt so it is seen at an angle
  root.add(stars);

  return {
    root,
    body: { id: 'galaxy', object: root, radius: GALAXY_RADIUS },
    update(dt) {
      if (dt) stars.rotation.y += dt * 0.03;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
