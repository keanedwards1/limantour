import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BeachAudio } from "./audio.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.3, 12000);

const FOG_NEAR = 120;
const FOG_FAR = 1500;
// land haze matches the sky's horizon colour on the side away from the sun
scene.fog = new THREE.Fog(new THREE.Color().setRGB(0.62, 0.42, 0.55, THREE.SRGBColorSpace), 260, 3600);

// The sun sits low over the ocean (+z), half sunk into the horizon.
const SUN_DIR = new THREE.Vector3(-0.25, 0.02, 1).normalize();

// Region covered by the dense, fully-animated wave mesh.
const NEAR_CENTER_Z = 120;
const NEAR_HALF = 350;

// ---------------------------------------------------------------------------
// Shared helpers (JS + GLSL use the same shoreline formula)
// ---------------------------------------------------------------------------
const shoreZ = (x) => 6 * Math.sin(x * 0.025) + 3 * Math.sin(x * 0.061 + 1.3);
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, oct = 5) {
  let v = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    v += a * vnoise(x, y);
    x *= 2.03; y *= 2.03; a *= 0.5;
  }
  return v;
}

// z of the foredune toe — the beach ends and the dunes begin here
const duneZ = (x) => -36 + 8 * Math.sin(x * 0.013) + 5 * Math.sin(x * 0.031 + 2);
// sandstone cliffs back the far (+x) end of the beach, like the Drakes Bay cliffs
const cliffEdgeZ = (x) => shoreZ(x) - 28 + (fbm(x * 0.025, 1.7, 4) - 0.5) * 34;
// separate bluffs divided by lower, grassy gaps
const bluff = (x) => 0.3 + 0.7 * smoothstep(0.32, 0.6, fbm(x * 0.012, 3.3, 3));
const cliffRegion = (x) => smoothstep(320, 560, x);
const cliffMask = (x, z) => cliffRegion(x) * smoothstep(cliffEdgeZ(x), cliffEdgeZ(x) - 7, z);

// 0 on the open beach, 1 inside the dune field
const duneMask = (x, z) => smoothstep(duneZ(x) + 14, duneZ(x), z) * (1 - smoothstep(290, 370, x));

// 0..1 how strongly a spot is a ravine (valleys run down the ridge toward the sea)
const ravine = (x, z) => 1 - smoothstep(0, 0.16, Math.abs(2 * vnoise(x * 0.011 + 5, z * 0.0032) - 1));
// ridge rises inland; its foot wanders a little along the coast
const ridgeMask = (x, z) => smoothstep(-260, -950, z + 140 * Math.sin(x * 0.0015 + 1));

function hillHeight(x, z) {
  // rolling coastal grassland behind the dunes
  let h = smoothstep(-100, -230, z) * (6 + 24 * fbm(x * 0.006 + 3, z * 0.006, 4));
  // Inverness-style ridge with ridgelines and ravines
  const r = ridgeMask(x, z);
  const ridged = 1 - Math.abs(2 * vnoise(x * 0.004 + 9, z * 0.004) - 1);
  h += r * (150 + 170 * fbm(x * 0.0025 + 11, z * 0.003, 5) + 55 * ridged * ridged);
  h += r * (fbm(x * 0.02, z * 0.02, 3) - 0.5) * 18;
  h -= r * 38 * ravine(x, z);
  return h;
}

function sandHeight(x, z) {
  const dist = shoreZ(x) - z; // >0 on land
  let h = dist > 0 ? 3.0 * (1 - Math.exp(-(dist * 0.06) / 3.0)) : dist * 0.06;
  const m = duneMask(x, z);
  const hummock = fbm(x * 0.02, z * 0.028, 4);
  h += m * (3.0 + 8.5 * hummock * hummock * 1.6);                 // foredune ridge + hummocks
  h += m * (fbm(x * 0.09, z * 0.09, 2) - 0.5) * 1.1;              // small bumps around plants
  const cm = cliffMask(x, z);
  h += cm * (30 + 34 * fbm(x * 0.008, 4.2, 3)) * bluff(x);          // cliff face
  h += cm * Math.min(Math.max(cliffEdgeZ(x) - 7 - z, 0) * 0.25, 40) * (0.6 + 0.8 * fbm(x * 0.02, z * 0.02, 3)); // land rising behind
  h += hillHeight(x, z);
  return h;
}

// beachgrass cover on the dunes (0..1), shared by ground tint and tuft placement
const grassCover = (x, z) => duneMask(x, z) * smoothstep(0.24, 0.46, fbm(x * 0.045 + 7, z * 0.045, 3));

// vegetation zones, shared by the terrain colouring and tree placement
function forestAmount(x, z, h) {
  if (z > -140) return 0;
  const n = fbm(x * 0.006 + 20, z * 0.006, 4);
  const v = n + ravine(x, z) * 0.22 + Math.min(h / 320, 1) * 0.28 - 0.1 * (1 - ridgeMask(x, z));
  return smoothstep(0.58, 0.7, v);
}
function scrubAmount(x, z) {
  return smoothstep(0.5, 0.64, fbm(x * 0.01 + 40, z * 0.01, 3));
}

const GLSL_COMMON = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  float shoreZ(float x) { return 6.0 * sin(x * 0.025) + 3.0 * sin(x * 0.061 + 1.3); }

  // slow tide that laps the water up and down the beach
  float washLevel(float t) { return sin(t * 0.55) * 0.22 + sin(t * 0.31 + 1.0) * 0.10; }

  vec3 skyColor(vec3 d, bool clouds) {
    float h = d.y;
    vec2 dh = normalize(d.xz + 1e-5);
    vec2 sh = normalize(uSunDir.xz);
    float side = dot(dh, sh) * 0.5 + 0.5;          // 1 = facing the sun

    vec3 horizon = mix(vec3(0.62, 0.40, 0.55), vec3(1.00, 0.52, 0.22), pow(side, 1.5));
    vec3 mid     = mix(vec3(0.34, 0.26, 0.50), vec3(0.90, 0.36, 0.34), pow(side, 2.0));
    vec3 zenith  = vec3(0.09, 0.09, 0.25);

    float hp = max(h, 0.0);
    vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, hp));
    col = mix(col, zenith, smoothstep(0.10, 0.75, hp));

    float sd = max(dot(d, uSunDir), 0.0);
    col += vec3(1.0, 0.45, 0.15) * pow(sd, 6.0) * 0.45;
    col += vec3(1.0, 0.70, 0.35) * pow(sd, 60.0) * 0.6;
    col += vec3(1.0, 0.85, 0.55) * pow(sd, 900.0) * 1.0;
    float disc = smoothstep(0.99955, 0.99968, sd);
    col = mix(col, vec3(1.0, 0.86, 0.6) * 1.3, disc);

    if (clouds && h > 0.0) {
      vec2 uv = d.xz / (h + 0.12) * 0.9;
      float n = fbm(vec2(uv.x * 0.6, uv.y * 1.8) + vec2(uTime * 0.006, 0.0));
      float dens = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.35, 0.75, h));
      vec3 cl = mix(vec3(0.40, 0.25, 0.42), vec3(1.0, 0.52, 0.34), pow(side, 2.0));
      cl += vec3(1.0, 0.62, 0.3) * pow(sd, 10.0) * 0.9;
      cl *= mix(1.0, 0.72, smoothstep(0.66, 0.9, n));
      col = mix(col, cl, dens * 0.85);
    }
    if (h < 0.0) col = mix(col, horizon * 0.55, smoothstep(0.0, -0.1, h));
    return col;
  }
`;

const sharedUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: SUN_DIR },
};

// ---------------------------------------------------------------------------
// Sky dome (+ a blurred copy of it as the environment for reflections)
// ---------------------------------------------------------------------------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: sharedUniforms,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    ${GLSL_COMMON}
    varying vec3 vDir;
    void main() {
      vec3 col = skyColor(normalize(vDir), true);
      col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither banding
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), skyMat);
sky.renderOrder = -1;
scene.add(sky);

{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), skyMat));
  scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 1000).texture;
}

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xa8a4cc, 0x55504a, 0.8));

const sunLight = new THREE.DirectionalLight(0xffc08a, 2.6);
const lightDir = new THREE.Vector3(SUN_DIR.x, 0.22, SUN_DIR.z).normalize();
sunLight.position.copy(lightDir).multiplyScalar(220).add(new THREE.Vector3(0, 0, -20));
sunLight.target.position.set(0, 0, -20);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -120, right: 120, top: 90, bottom: -90, near: 1, far: 500 });
sunLight.shadow.bias = -0.0005;
sunLight.shadow.normalBias = 0.05;
scene.add(sunLight, sunLight.target);

// ---------------------------------------------------------------------------
// Terrain: beach, dunes, cliffs, grassland and the ridge behind.
//   JS builds the shape + vegetation zones per vertex, the shader adds detail.
// ---------------------------------------------------------------------------
{
  const W = 3200, D = 1700, SX = 320, SZ = 440;
  const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -D / 2 + 45); // z from ~-1655 to +45

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const vegA = new Float32Array(count), forestA = new Float32Array(count), rockA = new Float32Array(count);
  const c = new THREE.Color(), v = new THREE.Color();
  const dry = srgb(0.76, 0.72, 0.64);          // pale, grey-beige Point Reyes sand
  const duneTint = srgb(0.58, 0.54, 0.38);   // straw-coloured ground under the grass
  const grassGold = srgb(0.66, 0.60, 0.38);
  const grassGreen = srgb(0.40, 0.46, 0.25);
  const scrub = srgb(0.26, 0.30, 0.19);
  const forest = srgb(0.11, 0.17, 0.10);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = sandHeight(x, z);
    pos.setY(i, h);

    const edge = cliffEdgeZ(x);
    const veg = Math.max(smoothstep(-92, -135, z), cliffRegion(x) * smoothstep(edge - 5, edge - 12, z));
    const fo = forestAmount(x, z, h);
    vegA[i] = veg;
    forestA[i] = fo;
    rockA[i] = cliffRegion(x) * smoothstep(edge + 4, edge + 1, z);

    c.copy(dry).multiplyScalar(0.94 + 0.12 * vnoise(x * 0.08, z * 0.08));
    c.lerp(duneTint, grassCover(x, z) * 0.8);
    v.copy(grassGold).lerp(grassGreen, smoothstep(0.35, 0.65, fbm(x * 0.008 + 2, z * 0.008, 3)) * 0.8);
    v.lerp(scrub, scrubAmount(x, z) * 0.85);
    v.lerp(forest, fo);
    c.lerp(v, veg);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aVeg", new THREE.BufferAttribute(vegA, 1));
  geo.setAttribute("aForest", new THREE.BufferAttribute(forestA, 1));
  geo.setAttribute("aRock", new THREE.BufferAttribute(rockA, 1));
  geo.computeVertexNormals();

  const sandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, envMapIntensity: 0.45 });
  sandMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uSunDir = sharedUniforms.uSunDir;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aVeg; attribute float aForest; attribute float aRock;
        varying vec3 vSandPos; varying float vVeg; varying float vForest; varying float vRock;`
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vSandPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vVeg = aVeg; vForest = aForest; vRock = aRock;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vSandPos; varying float vVeg; varying float vForest; varying float vRock;
        ${GLSL_COMMON}

        // scattered soft dimples — trampled / wind-scooped sand
        float pits(vec2 p) {
          vec2 n = floor(p), f = fract(p);
          float d = 0.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = hash22(n + g);
            float keep = step(0.72, hash(n + g + 9.1));
            vec2 r = g + o - f;
            r.y *= 1.5;
            d = max(d, keep * (1.0 - smoothstep(0.0, 0.34, length(r))));
          }
          return d;
        }

        // irregular mounds + dimples on dry sand, grain everywhere, gentle swash bumps when wet
        float sandRelief(vec2 p, float dryAmp, float gAmp, float wet) {
          vec2 w = vec2(noise(p * 0.11), noise(p * 0.11 + 7.3)) - 0.5;
          vec2 q = p + w * 7.0;
          float mounds = noise(q * 0.45) * 0.5 + noise(q * 1.1 + 3.1) * 0.3 + noise(q * 2.6 + 1.7) * 0.2;
          float dimples = pits(p * 0.8 + w * 2.0);
          float grain = noise(p * 24.0) + noise(p * 61.0) * 0.5;
          float swash = noise(p * 0.18) * 0.6 + noise(p * 0.5) * 0.4;
          return dryAmp * (mounds * 0.35 - dimples * 0.07) + grain * gAmp + wet * swash * 0.06;
        }

        // rolling grass, scrub clumps, bumpy conifer canopy
        float vegRelief(vec2 p, float forest, float fine) {
          float base = noise(p * 0.12) * 1.2 + noise(p * 0.35) * 0.6 * (0.4 + forest);
          float canopy = (noise(p * 0.9) * 0.5 + noise(p * 2.1) * 0.25) * fine * (0.15 + forest);
          return base * (0.4 + forest * 1.6) * 0.5 + canopy * 1.5;
        }`
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `#include <roughnessmap_fragment>
        vec2 sp = vSandPos.xz;
        float sDist = shoreZ(sp.x) - sp.y;                  // distance up the beach
        float sPx = length(fwidth(sp));                     // world size of a pixel
        float sReach = (washLevel(uTime) + 0.32) / 0.06;    // how far the water reaches right now
        float sDry = smoothstep(6.0, 15.0, sDist);
        float sFilm = (1.0 - smoothstep(sReach, sReach + 5.0, sDist)) * (1.0 - sDry);
        float gFade = 1.0 - smoothstep(0.02, 0.12, sPx);
        float vegFine = 1.0 - smoothstep(0.4, 2.0, sPx);

        // sandstone cliff faces (steep parts of the cliff zone)
        vec3 wNg = inverseTransformDirection(normalize(vNormal), viewMatrix);
        float rock = vRock * smoothstep(0.25, 0.5, 1.0 - wNg.y);
        float sSandMask = (1.0 - vVeg) * (1.0 - rock);

        // --- sand
        float g = noise(sp * 22.0) * 0.6 + noise(sp * 57.0) * 0.4;
        diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.84, 0.86, 0.9), vec3(1.08, 1.04, 0.96), g), gFade * sSandMask);

        // salt-and-pepper mineral grains (dark magnetite, light quartz)
        float spk = hash(floor(sp * 38.0));
        float spkMul = spk > 0.9 ? 0.45 : (spk < 0.06 ? 1.22 : 1.0);
        diffuseColor.rgb *= mix(1.0, spkMul, gFade * sSandMask);

        // soft shading in the dimples, a touch lighter on the mounds
        float sPit = pits(sp * 0.8 + (vec2(noise(sp * 0.11), noise(sp * 0.11 + 7.3)) - 0.5) * 2.0);
        diffuseColor.rgb *= 1.0 - sPit * 0.1 * sDry * sSandMask * (1.0 - smoothstep(0.1, 0.6, sPx));

        // wet sand: darker, greyer and blotchy
        float blot = noise(sp * 0.06) * 0.6 + noise(sp * 0.21) * 0.4;
        diffuseColor.rgb *= mix(vec3(0.5, 0.51, 0.53) * (0.85 + 0.3 * blot), vec3(1.0), sDry);
        diffuseColor.rgb *= 1.0 - 0.12 * sFilm;

        // wrack line of washed-up kelp near the high-tide mark
        float wrackBand = smoothstep(8.5, 10.0, sDist) * (1.0 - smoothstep(11.0, 13.5, sDist + noise(sp * 0.1) * 3.0));
        float wrack = wrackBand * smoothstep(0.62, 0.78, noise(sp * vec2(0.35, 1.6)) * 0.7 + noise(sp * 2.5) * 0.3);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.10, 0.06), wrack * 0.85 * sSandMask);

        // scattered pebbles and shell fragments
        vec2 cell = floor(sp * 4.0);
        vec2 cf = fract(sp * 4.0) - 0.5 + (hash22(cell) - 0.5) * 0.6;
        float hc = hash(cell + 17.3);
        float peb = step(0.96, hc) * (1.0 - smoothstep(0.06, 0.11, length(cf * vec2(1.0, 1.4))));
        vec3 pebCol = hc > 0.985 ? vec3(0.95, 0.84, 0.78) : vec3(0.28, 0.22, 0.22);
        diffuseColor.rgb = mix(diffuseColor.rgb, pebCol, peb * gFade * sSandMask * 0.9);

        // --- vegetation: patchy grass/scrub, darker clumpy forest
        float vn = noise(sp * 0.04) * 0.45 + noise(sp * 0.15) * 0.35 + noise(sp * 0.6) * 0.2 * vegFine;
        diffuseColor.rgb *= mix(1.0, 0.6 + 0.8 * vn, vVeg);
        float canopyC = noise(sp * 0.45) * 0.6 + noise(sp * 1.3) * 0.4 * vegFine;
        diffuseColor.rgb *= mix(1.0, 0.5 + 0.85 * canopyC, vForest * vVeg);

        // --- layered cream sandstone with vertical erosion streaks
        float strata = 0.86 + 0.14 * sin(vSandPos.y * 1.6 + noise(sp * 0.06) * 5.0);
        float gully = 0.78 + 0.32 * noise(vec2(sp.x * 0.5, vSandPos.y * 0.08));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.53, 0.38) * strata * gully, rock);

        roughnessFactor = mix(0.55, 0.97, sDry);
        roughnessFactor = mix(roughnessFactor, 0.08, sFilm);
        roughnessFactor = mix(roughnessFactor, 0.92, max(vVeg, rock));`
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
        {
          float dryAmp = sDry * (1.0 - smoothstep(0.3, 1.2, sPx)) * sSandMask;
          float gAmp = 0.01 * gFade * sSandMask;
          float wet = (1.0 - sDry) * (1.0 - sFilm * 0.8) * (1.0 - smoothstep(0.2, 0.8, sPx)) * sSandMask;
          float e = 0.03;
          float h0 = sandRelief(sp, dryAmp, gAmp, wet);
          float hx = sandRelief(sp + vec2(e, 0.0), dryAmp, gAmp, wet);
          float hz = sandRelief(sp + vec2(0.0, e), dryAmp, gAmp, wet);
          vec2 grad = vec2(hx - h0, hz - h0) / e;
          if (vVeg > 0.01) {
            float ev = 0.15;
            float v0 = vegRelief(sp, vForest, vegFine);
            float vx = vegRelief(sp + vec2(ev, 0.0), vForest, vegFine);
            float vz = vegRelief(sp + vec2(0.0, ev), vForest, vegFine);
            grad += vec2(vx - v0, vz - v0) / ev * vVeg * (1.0 - rock);
          }
          vec3 nW = inverseTransformDirection(normal, viewMatrix);
          nW = normalize(nW + vec3(-grad.x, 0.0, -grad.y));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`
      );
  };

  const terrain = new THREE.Mesh(geo, sandMat);
  terrain.receiveShadow = true;
  scene.add(terrain);
}

// ---------------------------------------------------------------------------
// Ocean
//   near: dense mesh with Gerstner waves + breakers rolling into shore
//   far:  coarse plane out to the horizon (discarded where near mesh is)
// ---------------------------------------------------------------------------
const OCEAN_GLSL = /* glsl */ `
  ${GLSL_COMMON}
  uniform float uNear;

  // dir.x, dir.z, wavelength, steepness — all travelling toward the shore (-z)
  // spread over a wide arc with uneven wavelengths so no single direction dominates
  const int NW = 12;
  const vec4 WAVES[12] = vec4[12](
    vec4( 0.000, -1.000, 52.0, 0.080),
    vec4( 0.423, -0.906, 37.0, 0.080),
    vec4(-0.500, -0.866, 31.0, 0.080),
    vec4( 0.766, -0.643, 23.0, 0.070),
    vec4(-0.819, -0.574, 19.0, 0.070),
    vec4( 0.208, -0.978, 15.0, 0.065),
    vec4(-0.259, -0.966, 12.0, 0.060),
    vec4( 0.940, -0.342,  9.5, 0.055),
    vec4(-0.966, -0.259,  8.0, 0.050),
    vec4( 0.574, -0.819,  6.2, 0.050),
    vec4(-0.643, -0.766,  4.4, 0.045),
    vec4( 0.996, -0.087,  3.1, 0.040)
  );
  const float STEEP_SUM = 0.745;

  // each wave train grows and fades across the sea, breaking up long regular crests
  float waveGroup(vec2 p, int i) {
    float fi = float(i);
    return 0.4 + 1.2 * noise(p * 0.011 + vec2(fi * 3.7, fi * 1.9));
  }

  float edgeFade(vec2 p) {
    float e = max(abs(p.x), abs(p.y - ${NEAR_CENTER_Z.toFixed(1)}));
    return 1.0 - smoothstep(${(NEAR_HALF - 90).toFixed(1)}, ${(NEAR_HALF - 2).toFixed(1)}, e);
  }

  // how much the open-water waves are allowed to grow (shrinks in the shallows)
  float waveAtten(vec2 p) {
    float depth0 = (p.y - shoreZ(p.x)) * 0.06;
    return smoothstep(0.2, 3.5, depth0) * edgeFade(p) * uNear * 0.75;
  }

  float baseSwell(vec2 p, float t) {
    return sin(p.x * 0.012 + p.y * 0.020 + t * 0.6) * 0.18
         + sin(-p.x * 0.017 + p.y * 0.013 + t * 0.45) * 0.12
         + washLevel(t);
  }

  // breakers: rise as they approach the shore, then collapse into whitewater
  // returns (height, phase-in-cycle, envelope)
  vec3 breaker(vec2 p, float t) {
    float d = p.y - shoreZ(p.x);
    float ph = d * 0.16 + t * 1.0 + noise(vec2(p.x * 0.015, 0.0)) * 3.5 + noise(vec2(p.x * 0.05, d * 0.03)) * 1.4;
    float cyc = ph / 6.2831853;
    float s = fract(cyc);
    float idx = floor(cyc);
    float prof = smoothstep(0.0, 0.12, s) * pow(1.0 - smoothstep(0.12, 1.0, s), 2.0);
    // sets: some waves big, some barely there, and they break in sections along the beach
    float set = 0.25 + 0.75 * noise(vec2(idx * 1.37, p.x * 0.012 + idx * 0.71));
    float env = smoothstep(80.0, 32.0, d) * smoothstep(2.0, 14.0, d) * edgeFade(p) * uNear * set;
    return vec3(prof * env * 0.95, s, env);
  }

  vec3 gerstnerOffset(vec2 p, float t, float a, int count) {
    vec3 off = vec3(0.0);
    for (int i = 0; i < NW; i++) {
      if (i >= count) break;
      vec4 w = WAVES[i];
      vec2 d = normalize(w.xy);
      float k = 6.2831853 / w.z;
      float c = sqrt(9.8 / k) * 0.7;
      float f = k * (dot(d, p) - c * t);
      float A = w.w / k * a * waveGroup(p, i);
      off.x += d.x * A * cos(f);
      off.z += d.y * A * cos(f);
      off.y += A * sin(f);
    }
    return off;
  }

  vec3 gerstnerNormal(vec2 p, float t, float a, out float crest) {
    vec3 T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, 0.0, 1.0);
    crest = 0.0;
    for (int i = 0; i < NW; i++) {
      vec4 w = WAVES[i];
      vec2 d = normalize(w.xy);
      float k = 6.2831853 / w.z;
      float c = sqrt(9.8 / k) * 0.7;
      float f = k * (dot(d, p) - c * t);
      float st = w.w * a * waveGroup(p, i);
      float sf = sin(f), cf = cos(f);
      T += vec3(-d.x * d.x * st * sf, d.x * st * cf, -d.x * d.y * st * sf);
      B += vec3(-d.x * d.y * st * sf, d.y * st * cf, -d.y * d.y * st * sf);
      crest += w.w * sf;
    }
    crest /= STEEP_SUM;
    return normalize(cross(B, T));
  }
`;

function makeOceanMaterial(isNear) {
  return new THREE.ShaderMaterial({
    transparent: true,
    fog: false,
    uniforms: {
      ...sharedUniforms,
      uNear: { value: isNear ? 1 : 0 },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR * 1.6 },
    },
    vertexShader: /* glsl */ `
      ${OCEAN_GLSL}
      varying vec3 vWorld;
      varying vec2 vBase;
      varying float vHeight;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 p = wp.xz;
        float t = uTime;
        float a = waveAtten(p);
        vec3 off = gerstnerOffset(p, t, a, 9);         // only waves the mesh can resolve
        vec3 br = breaker(p, t);
        wp.xyz += off;
        wp.y += baseSwell(p, t) + br.x;
        wp.z -= br.x * 0.6;                             // lean the breaker forward
        vBase = p;
        vHeight = off.y + br.x;
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${OCEAN_GLSL}
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vWorld;
      varying vec2 vBase;
      varying float vHeight;

      // animated cellular pattern -> lacy foam texture
      float lace(vec2 p) {
        vec2 n = floor(p), f = fract(p);
        float f1 = 8.0, f2 = 8.0;
        for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = hash22(n + g);
          o = 0.5 + 0.45 * sin(uTime * 0.7 + 6.2831 * o);
          vec2 r = g + o - f;
          float d = dot(r, r);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
        return 1.0 - smoothstep(0.0, 0.22, sqrt(f2) - sqrt(f1));
      }

      // small capillary ripples riding on top of the big waves
      float ripples(vec2 p, float t) {
        float h = 0.0;
        h += (noise(p * 0.9 + vec2(0.0, t * 0.9)) - 0.5) * 0.10;
        h += (noise(p * 2.3 + vec2(t * 0.5, t * 1.4)) - 0.5) * 0.05;
        h += (noise(p * 5.7 - vec2(t * 0.8, -t * 1.1)) - 0.5) * 0.022;
        h += (noise(p * 13.0 + vec2(-t * 1.3, t * 1.7)) - 0.5) * 0.009;
        return h;
      }

      void main() {
        float t = uTime;
        vec2 p = vBase;

        if (uNear < 0.5) {
          float e = max(abs(p.x), abs(p.y - ${NEAR_CENTER_Z.toFixed(1)}));
          if (e < ${(NEAR_HALF - 1).toFixed(1)}) discard;
        }

        vec3 V = cameraPosition - vWorld;
        float dist = length(V);
        V /= dist;

        // --- surface normal: Gerstner + breaker slope + capillary ripples
        float a = waveAtten(p);
        float crest;
        vec3 N = gerstnerNormal(p, t, a, crest);

        vec3 br = breaker(p, t);
        float eb = 0.4;
        float bx = breaker(p + vec2(eb, 0.0), t).x - breaker(p - vec2(eb, 0.0), t).x;
        float bz = breaker(p + vec2(0.0, eb), t).x - breaker(p - vec2(0.0, eb), t).x;
        N = normalize(N + vec3(-bx, 0.0, -bz) / (2.0 * eb));

        float detail = 1.0 - smoothstep(25.0, 400.0, dist);
        float e = 0.05 + dist * 0.002;
        vec2 rp = vWorld.xz;
        float rx = ripples(rp + vec2(e, 0.0), t) - ripples(rp - vec2(e, 0.0), t);
        float rz = ripples(rp + vec2(0.0, e), t) - ripples(rp - vec2(0.0, e), t);
        N = normalize(N + vec3(-rx, 0.0, -rz) / (2.0 * e) * (0.35 + 0.65 * detail));

        // --- reflection / refraction
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = skyColor(R, false);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

        float depth = vWorld.y - (shoreZ(vWorld.x) - vWorld.z) * 0.06;

        vec3 deep = vec3(0.03, 0.06, 0.12);
        vec3 shallow = vec3(0.24, 0.38, 0.36);
        vec3 body = mix(shallow, deep, smoothstep(0.0, 3.5, depth));

        // light glowing through the back of waves when looking toward the sun
        float toSun = max(dot(normalize(-V.xz + 1e-5), normalize(uSunDir.xz)), 0.0);
        float thick = clamp(vHeight * 0.9 + crest * 0.4 * a + br.x * 0.8, 0.0, 1.0);
        body += vec3(0.20, 0.42, 0.34) * pow(toSun, 3.0) * thick * 0.9;
        body += vec3(0.30, 0.12, 0.05) * pow(toSun, 4.0) * 0.5;

        vec3 col = mix(body, refl, fres);

        // --- sun glitter
        float sd = max(dot(R, uSunDir), 0.0);
        col += vec3(1.0, 0.72, 0.42) * (pow(sd, 600.0) * 9.0 + pow(sd, 120.0) * 1.2 + pow(sd, 25.0) * 0.25);

        // --- foam
        vec2 flow = vec2(0.0, -t * 0.6);
        vec2 fw = vWorld.xz + (vec2(noise(vWorld.xz * 0.2), noise(vWorld.xz * 0.2 + 5.0)) - 0.5) * 3.0;
        float tex = lace(fw * 1.1 + flow * 0.3) * 0.55 + lace(fw * 2.9 - flow * 0.2) * 0.45;
        tex = mix(tex, noise(vWorld.xz * 4.0), 0.2);

        float whitecap = smoothstep(0.45, 0.9, crest) * a * smoothstep(0.45, 0.7, noise(p * 0.03 + t * 0.02));
        float broken = smoothstep(30.0, 16.0, p.y - shoreZ(p.x));
        float breakerFoam = br.z * (
            smoothstep(0.06, 0.13, br.y) * (1.0 - smoothstep(0.13, 0.55, br.y)) * (0.35 + broken)
          + broken * 0.35 * (1.0 - smoothstep(0.3, 0.9, br.y))
        );
        float shore = 1.0 - smoothstep(0.0, 0.6, depth);
        float amount = clamp(whitecap * 0.7 + breakerFoam * 1.4 + shore, 0.0, 1.0);
        float foam = smoothstep(1.0 - amount, 1.0 - amount + 0.3, tex) * amount;
        foam = max(foam, smoothstep(0.75, 1.0, amount) * 0.85);

        vec3 foamCol = vec3(1.0, 0.88, 0.80) * (0.62 + 0.38 * max(dot(N, normalize(uSunDir + vec3(0.0, 0.35, 0.0))), 0.0));
        col = mix(col, foamCol, foam);

        float alpha = mix(0.28, 1.0, smoothstep(0.0, 1.1, depth));
        alpha = max(alpha, foam);

        // --- fade into the horizon colour of the sky in that direction
        vec3 fogC = skyColor(normalize(vec3(-V.x, 0.0, -V.z)), false);
        float fo = smoothstep(uFogNear, uFogFar, dist);
        col = mix(col, fogC, fo);
        alpha = mix(alpha, 1.0, fo);

        gl_FragColor = vec4(col, alpha);
      }`,
  });
}

{
  const nearGeo = new THREE.PlaneGeometry(NEAR_HALF * 2, NEAR_HALF * 2, 560, 560);
  nearGeo.rotateX(-Math.PI / 2);
  nearGeo.translate(0, 0, NEAR_CENTER_Z);
  const near = new THREE.Mesh(nearGeo, makeOceanMaterial(true));
  near.frustumCulled = false;
  scene.add(near);

  const farGeo = new THREE.PlaneGeometry(9000, 9000, 220, 220);
  farGeo.rotateX(-Math.PI / 2);
  const far = new THREE.Mesh(farGeo, makeOceanMaterial(false));
  far.renderOrder = -0.5;
  scene.add(far);
}

// ---------------------------------------------------------------------------
// Rocks at the water's edge
// ---------------------------------------------------------------------------
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
{
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3d3138, roughness: 0.75, flatShading: true, envMapIntensity: 0.4 });
  const rockSpots = [[78, 4, 4.5], [86, 9, 3], [72, 10, 2.2], [-90, 6, 3.6], [-84, 12, 2]];
  for (const [x, dz, s] of rockSpots) {
    const g = new THREE.IcosahedronGeometry(s, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(0.75 + 0.45 * vnoise(v.x * 0.9 + x, v.z * 0.9 + v.y));
      v.y *= 0.65;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    const rock = new THREE.Mesh(g, rockMat);
    const z = shoreZ(x) + dz;
    rock.position.set(x, sandHeight(x, z) + s * 0.15, z);
    rock.rotation.y = rand() * Math.PI;
    rock.castShadow = rock.receiveShadow = true;
    scene.add(rock);
  }
}

// ---------------------------------------------------------------------------
// Dune plants: European beachgrass tufts + ice plant mats (Limantour style)
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

function buildGeometry(pos, col, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// one tuft of stiff, spiky blades — grey-green with straw tips and some dead blades
function beachgrassGeometry() {
  const pos = [], col = [], idx = [];
  const SEG = 3;
  const green = srgb(0.44, 0.47, 0.28), tip = srgb(0.82, 0.76, 0.54);
  const deadBase = srgb(0.62, 0.55, 0.38), deadTip = srgb(0.88, 0.80, 0.60);
  const c = new THREE.Color();
  for (let b = 0; b < 44; b++) {
    const phi = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.2;
    const base = new THREE.Vector3(Math.cos(phi) * r0, 0, Math.sin(phi) * r0);
    const og = phi + (rand() - 0.5) * 0.8;
    const out = new THREE.Vector3(Math.cos(og), 0, Math.sin(og));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    const lean = 0.08 + rand() * 0.45 + r0 * 1.6;
    const curl = 0.15 + rand() * 0.5;
    const L = 0.55 + rand() * 0.75;
    const w0 = 0.014 + rand() * 0.01;
    const dead = rand() < 0.35;
    const start = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const p = base.clone()
        .addScaledVector(out, L * (Math.sin(lean) * t + curl * 0.5 * t * t))
        .addScaledVector(UP, L * Math.cos(lean) * t * (1 - curl * 0.3 * t));
      const w = w0 * (1 - t * 0.9);
      const a = p.clone().addScaledVector(side, w), bb = p.clone().addScaledVector(side, -w);
      pos.push(a.x, a.y, a.z, bb.x, bb.y, bb.z);
      c.copy(dead ? deadBase : green).lerp(dead ? deadTip : tip, Math.pow(t, 1.4));
      c.multiplyScalar(0.55 + 0.45 * t); // darker at the base
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let s = 0; s < SEG; s++) {
      const a = start + s * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  return buildGeometry(pos, col, idx);
}

// a sprawl of fleshy, three-sided ice plant leaves, green going red at the tips
function iceplantGeometry() {
  const pos = [], col = [], idx = [];
  const SEG = 3;
  const green = srgb(0.28, 0.45, 0.18), yellowGreen = srgb(0.44, 0.52, 0.20), red = srgb(0.68, 0.16, 0.20);
  const c = new THREE.Color();
  for (let l = 0; l < 34; l++) {
    const phi = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.4;
    const out = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    let p = new THREE.Vector3(Math.cos(phi + 0.3) * r0, 0.02, Math.sin(phi + 0.3) * r0);
    const len = 0.25 + rand() * 0.2;
    const pitch = 0.2 + rand() * 0.7;
    const rr = 0.032 + rand() * 0.012;
    const redness = Math.pow(rand(), 0.9);
    const baseC = green.clone().lerp(yellowGreen, rand() * 0.6);
    const start = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const ang = pitch + 0.5 * t;
      const dir = out.clone().multiplyScalar(Math.cos(ang)).addScaledVector(UP, Math.sin(ang));
      const n = new THREE.Vector3().crossVectors(dir, side).normalize();
      const r = rr * (1 - t * 0.55);
      c.copy(baseC).lerp(red, redness * Math.pow(t, 1.2));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const v = p.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(n, Math.sin(a) * r);
        pos.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
      }
      if (s < SEG) p = p.addScaledVector(dir, len / SEG);
    }
    const tipDir = out.clone().multiplyScalar(Math.cos(pitch + 0.5)).addScaledVector(UP, Math.sin(pitch + 0.5));
    const tipP = p.clone().addScaledVector(tipDir, 0.04);
    const tipI = pos.length / 3;
    pos.push(tipP.x, tipP.y, tipP.z);
    c.copy(baseC).lerp(red, redness);
    col.push(c.r, c.g, c.b);
    for (let s = 0; s < SEG; s++) {
      for (let k = 0; k < 3; k++) {
        const a = start + s * 3 + k, b = start + s * 3 + ((k + 1) % 3);
        idx.push(a, b, a + 3, b, b + 3, a + 3);
      }
    }
    for (let k = 0; k < 3; k++) idx.push(start + SEG * 3 + k, start + SEG * 3 + ((k + 1) % 3), tipI);
  }
  return buildGeometry(pos, col, idx);
}

// a pink ice plant flower: thin petals around a yellow centre
function flowerGeometry() {
  const pos = [], col = [], idx = [];
  const pink = srgb(0.88, 0.30, 0.58), pale = srgb(0.96, 0.62, 0.78), yellow = srgb(0.95, 0.80, 0.32);
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + rand() * 0.05;
    const w = 0.012;
    const L = 0.085 + rand() * 0.02;
    const b0 = [Math.cos(a - w / 0.03) * 0.022, 0.0, Math.sin(a - w / 0.03) * 0.022];
    const b1 = [Math.cos(a + w / 0.03) * 0.022, 0.0, Math.sin(a + w / 0.03) * 0.022];
    const tp = [Math.cos(a) * L, 0.03, Math.sin(a) * L];
    const s = pos.length / 3;
    pos.push(...b0, ...b1, ...tp);
    col.push(pink.r, pink.g, pink.b, pink.r, pink.g, pink.b, pale.r, pale.g, pale.b);
    idx.push(s, s + 1, s + 2);
  }
  const cI = pos.length / 3;
  pos.push(0, 0.012, 0);
  col.push(yellow.r, yellow.g, yellow.b);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.025, 0.006, Math.sin(a) * 0.025);
    col.push(yellow.r, yellow.g, yellow.b);
  }
  for (let i = 0; i < 10; i++) idx.push(cI, cI + 1 + i, cI + 1 + ((i + 1) % 10));
  return buildGeometry(pos, col, idx);
}

// wind sway for instanced vegetation (wind blows onshore, toward -z)
function addWind(material, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        {
          vec3 ip = instanceMatrix[3].xyz;
          float gust = 0.6 + 0.4 * sin(uTime * 0.7 + ip.x * 0.05 - ip.z * 0.08);
          float sway = sin(uTime * 2.3 + ip.x * 0.4 + ip.z * 0.3) * 0.5 + 0.5;
          vec3 windW = vec3(0.25, 0.0, -1.0) * (gust * (0.35 + 0.65 * sway)) * ${strength.toFixed(3)};
          // bring the world-space wind into the instance's local space
          float s2 = dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz);
          vec3 windL = transpose(mat3(instanceMatrix)) * windW / s2;
          float bend = position.y * position.y;
          transformed += windL * bend;
          transformed.y -= length(windL) * bend * 0.3;
        }`
      );
  };
}

{
  const MAX_GRASS = 20000;
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, envMapIntensity: 0.4 });
  addWind(grassMat, 0.18);
  const grass = new THREE.InstancedMesh(beachgrassGeometry(), grassMat, MAX_GRASS);

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let n = 0;
  for (let tries = 0; tries < 220000 && n < MAX_GRASS; tries++) {
    const x = (rand() - 0.5) * 560;
    const z = duneZ(x) + 10 - rand() * 105;
    const m = duneMask(x, z);
    // thick on the dunes, a few pioneer tufts creeping onto the beach
    const want = grassCover(x, z) + (1 - m) * 0.03;
    if (rand() > want) continue;
    const s = 1.1 + rand() * 0.9;
    dummy.position.set(x, sandHeight(x, z) - 0.05, z);
    dummy.rotation.set((rand() - 0.5) * 0.15, rand() * Math.PI * 2, (rand() - 0.5) * 0.15);
    dummy.scale.set(s, s * (0.85 + rand() * 0.35), s);
    dummy.updateMatrix();
    grass.setMatrixAt(n, dummy.matrix);
    tint.setRGB(0.88 + rand() * 0.2, 0.88 + rand() * 0.2, 0.85 + rand() * 0.15);
    grass.setColorAt(n, tint);
    n++;
  }
  grass.count = n;
  grass.castShadow = true;
  grass.receiveShadow = true;
  scene.add(grass);

  // ice plant: dense carpets on the dune faces and at the dune toe
  const MAX_ICE = 5200;
  const iceMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, envMapIntensity: 0.6 });
  addWind(iceMat, 0.015);
  const ice = new THREE.InstancedMesh(iceplantGeometry(), iceMat, MAX_ICE);
  const flowers = new THREE.InstancedMesh(
    flowerGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6 }),
    2200
  );
  let ni = 0, nf = 0;
  for (let patch = 0; patch < 34 && ni < MAX_ICE; patch++) {
    const cx = (rand() - 0.5) * 420;
    const cz = duneZ(cx) + 5 - rand() * 30;
    const rx = 3 + rand() * 5, rz = 2.5 + rand() * 3;
    const count = 100 + Math.floor(rand() * 80);
    for (let k = 0; k < count && ni < MAX_ICE; k++) {
      const ang = rand() * Math.PI * 2;
      const rad = Math.sqrt(rand());
      const x = cx + Math.cos(ang) * rad * rx + (vnoise(cx + k, 1) - 0.5) * 2;
      const z = cz + Math.sin(ang) * rad * rz;
      const s = 1.3 + rand() * 0.7;
      dummy.position.set(x, sandHeight(x, z) - 0.03, z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(s, s * (0.8 + rand() * 0.4), s);
      dummy.updateMatrix();
      ice.setMatrixAt(ni, dummy.matrix);
      tint.setRGB(0.85 + rand() * 0.25, 0.85 + rand() * 0.2, 0.85 + rand() * 0.15);
      ice.setColorAt(ni, tint);
      ni++;

      if (rand() < 0.42 && nf < 2200) {
        const fx = x + (rand() - 0.5) * 0.4, fz = z + (rand() - 0.5) * 0.4;
        dummy.position.set(fx, sandHeight(fx, fz) + 0.3 + rand() * 0.1, fz);
        dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI, (rand() - 0.5) * 0.5);
        const fs = 1.5 + rand() * 0.6;
        dummy.scale.set(fs, fs, fs);
        dummy.updateMatrix();
        flowers.setMatrixAt(nf++, dummy.matrix);
      }
    }
  }
  ice.count = ni;
  flowers.count = nf;
  ice.castShadow = ice.receiveShadow = true;
  scene.add(ice, flowers);
}

// ---------------------------------------------------------------------------
// Bleached driftwood logs on the upper beach
// ---------------------------------------------------------------------------
{
  const woodMat = new THREE.MeshStandardMaterial({ color: srgb(0.62, 0.60, 0.56), roughness: 0.92, envMapIntensity: 0.4 });
  const logs = [[-22, 0.55], [14, 0.7], [-58, 0.6], [44, 0.45], [70, 0.5], [-8, 0.35], [-95, 0.55]];
  for (const [x, rel] of logs) {
    const len = 6 + rand() * 7;
    const r = 0.32 + rand() * 0.25;
    const g = new THREE.CylinderGeometry(r * 0.7, r, len, 12, 10);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const k = 1 + (vnoise(vy * 1.5 + x, Math.atan2(vz, vx) * 2) - 0.5) * 0.35;
      p.setXYZ(i, vx * k, vy + Math.sin(vy * 0.4 + x) * 0.0, vz * k);
    }
    g.computeVertexNormals();
    g.rotateZ(Math.PI / 2);
    const log = new THREE.Mesh(g, woodMat);
    const shore = shoreZ(x), toe = duneZ(x);
    const z = shore + (toe - shore) * rel;
    log.position.set(x, sandHeight(x, z) + r * 0.45, z);
    log.rotation.y = (rand() - 0.5) * 1.4;
    log.rotation.x = (rand() - 0.5) * 0.08;
    log.castShadow = log.receiveShadow = true;
    // a couple of broken branch stubs
    for (let b = 0; b < 2; b++) {
      const stub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.35, r * 3, 6), woodMat);
      stub.position.set((rand() - 0.5) * len * 0.7, r * 0.8, (rand() - 0.5) * r);
      stub.rotation.set((rand() - 0.5) * 1.2, 0, (rand() - 0.5) * 1.2);
      stub.castShadow = true;
      log.add(stub);
    }
    scene.add(log);
  }
}

// ---------------------------------------------------------------------------
// Trees: Douglas fir / bishop pine forest on the ridge, windswept cypress
// behind the dunes
// ---------------------------------------------------------------------------
{
  const treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, envMapIntensity: 0.3 });

  // conifer: short trunk + stacked tiers, ~1 unit tall
  const coniferParts = [];
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.3, 5);
  trunk.translate(0, 0.15, 0);
  coniferParts.push(trunk);
  for (let k = 0; k < 4; k++) {
    const r = 0.3 - k * 0.065, hgt = 0.36 - k * 0.04;
    const cone = new THREE.ConeGeometry(r, hgt, 7);
    cone.translate(0, 0.22 + k * 0.19 + hgt / 2, 0);
    coniferParts.push(cone);
  }
  const conifer = mergeGeometries(coniferParts);

  const MAX_TREES = 16000;
  const forest = new THREE.InstancedMesh(conifer, treeMat, MAX_TREES);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let n = 0;
  for (let tries = 0; tries < 160000 && n < MAX_TREES; tries++) {
    const x = (rand() - 0.5) * 3000;
    const z = -150 - rand() * 1480;
    const h = sandHeight(x, z);
    if (rand() > smoothstep(0.15, 0.6, forestAmount(x, z, h))) continue;
    const s = 14 + rand() * 20;
    dummy.position.set(x, h - 1, z);
    dummy.rotation.set((rand() - 0.5) * 0.1, rand() * Math.PI * 2, (rand() - 0.5) * 0.1);
    dummy.scale.set(s * (0.75 + rand() * 0.4), s, s * (0.75 + rand() * 0.4));
    dummy.updateMatrix();
    forest.setMatrixAt(n, dummy.matrix);
    tint.setRGB(0.09 + rand() * 0.05, 0.15 + rand() * 0.06, 0.09 + rand() * 0.04, THREE.SRGBColorSpace);
    forest.setColorAt(n, tint);
    n++;
  }
  forest.count = n;
  scene.add(forest);


  // coyote brush / scrub: low rounded bushes dotted over the grassland and ridge
  const bush = new THREE.IcosahedronGeometry(1, 1);
  bush.scale(1, 0.6, 1);
  const MAX_BUSH = 14000;
  const bushes = new THREE.InstancedMesh(bush, treeMat, MAX_BUSH);
  let nb = 0;
  for (let tries = 0; tries < 120000 && nb < MAX_BUSH; tries++) {
    const x = (rand() - 0.5) * 3000;
    const z = -105 - rand() * 1500;
    if (cliffRegion(x) > 0.5 && z > cliffEdgeZ(x) - 10) continue;
    const sa = scrubAmount(x, z);
    const want = 0.02 + sa * sa * 0.95;
    if (rand() > want) continue;
    const h = sandHeight(x, z);
    const s = 0.8 + Math.pow(rand(), 2) * 4.5;
    dummy.position.set(x, h + s * 0.15, z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.set(s * (0.8 + rand() * 0.6), s, s * (0.8 + rand() * 0.6));
    dummy.updateMatrix();
    bushes.setMatrixAt(nb, dummy.matrix);
    tint.setRGB(0.18 + rand() * 0.08, 0.22 + rand() * 0.07, 0.13 + rand() * 0.05, THREE.SRGBColorSpace);
    bushes.setColorAt(nb++, tint);
  }
  bushes.count = nb;
  scene.add(bushes);

  // windswept cypress: a flat, inland-leaning crown of foliage blobs
  const cypressParts = [];
  const ct = new THREE.CylinderGeometry(0.04, 0.08, 0.6, 6);
  ct.rotateX(-0.25);
  ct.translate(0, 0.28, -0.07);
  cypressParts.push(ct);
  for (let k = 0; k < 11; k++) {
    const blob = new THREE.IcosahedronGeometry(0.3 + rand() * 0.15, 1);
    blob.scale(1.3, 0.6, 1.0);
    blob.translate((rand() - 0.5) * 0.8, 0.35 + rand() * 0.35, -0.1 - rand() * 0.5);
    cypressParts.push(blob);
  }
  const cypressGeo = mergeGeometries(cypressParts.map((g) => (g.index ? g.toNonIndexed() : g)));
  const cypress = new THREE.InstancedMesh(cypressGeo, treeMat, 30);
  let nc = 0;
  for (let i = 0; i < 30; i++) {
    const x = (rand() - 0.5) * 520;
    const z = -125 - rand() * 90;
    const s = 7 + rand() * 6;
    dummy.position.set(x, sandHeight(x, z) - 0.3, z);
    dummy.rotation.set(0, (rand() - 0.5) * 0.6, 0);
    dummy.scale.set(s, s * (0.8 + rand() * 0.3), s);
    dummy.updateMatrix();
    cypress.setMatrixAt(nc, dummy.matrix);
    tint.setRGB(0.10 + rand() * 0.04, 0.17 + rand() * 0.05, 0.11 + rand() * 0.03, THREE.SRGBColorSpace);
    cypress.setColorAt(nc++, tint);
  }
  cypress.castShadow = true;
  scene.add(cypress);
}

// ---------------------------------------------------------------------------
// Birds
// ---------------------------------------------------------------------------
const birds = [];
{
  const birdMat = new THREE.MeshBasicMaterial({ color: 0x1c1222, side: THREE.DoubleSide });
  const wingGeo = (sign) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0.35,   0, 0, -0.25,   sign * 1.6, 0.05, -0.25,
    ], 3));
    return g;
  };
  const bodyGeo = new THREE.ConeGeometry(0.12, 0.9, 5).rotateX(Math.PI / 2);
  for (let i = 0; i < 7; i++) {
    const bird = new THREE.Group();
    bird.add(new THREE.Mesh(bodyGeo, birdMat));
    const l = new THREE.Mesh(wingGeo(-1), birdMat);
    const r = new THREE.Mesh(wingGeo(1), birdMat);
    bird.add(l, r);
    bird.userData = {
      l, r,
      off: i * 0.07 + rand() * 0.02,
      lane: (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 3,
      y: 28 + rand() * 4,
      flap: rand() * 10,
    };
    birds.push(bird);
    scene.add(bird);
  }
}

// ---------------------------------------------------------------------------
// Drone camera path
// ---------------------------------------------------------------------------
const LOOP_SECONDS = 80;
const ORBIT_CENTER = new THREE.Vector3(0, 0, -4);
const START = -Math.PI / 2 + 0.35; // begin over the beach, looking at the sunset
const lookTarget = new THREE.Vector3();

function dronePose(t, outPos, outLook) {
  const a = START + (t / LOOP_SECONDS) * Math.PI * 2;
  const r = 84 + 14 * Math.sin(a * 2 + 0.6);
  const x = ORBIT_CENTER.x + Math.cos(a) * r + Math.sin(t * 0.9) * 0.15;
  const z = ORBIT_CENTER.z + Math.sin(a) * r + Math.cos(t * 0.7) * 0.15;
  let h = 16 + 5 * Math.sin(a * 3 + 1.2) + 1.5 * Math.sin(a * 7);
  // smooth-max against the terrain so the drone glides up and over the dunes
  const floor = sandHeight(x, z) + 9;
  h = 0.5 * (h + floor + Math.sqrt((h - floor) ** 2 + 16));
  outPos.set(x, h + Math.sin(t * 1.3) * 0.12, z);
  // lead the target slightly and bias it toward the surf
  outLook.set(
    ORBIT_CENTER.x + Math.cos(a + 0.5) * 10,
    2 + 1.5 * Math.sin(a * 2),
    ORBIT_CENTER.z + Math.sin(a + 0.5) * 10 + 14
  );
  return a;
}

// ---------------------------------------------------------------------------
// Audio (starts on the first click / key press — browsers require a gesture)
// ---------------------------------------------------------------------------
const audio = new BeachAudio({
  shoreZ,
  washLevel: (t) => Math.sin(t * 0.55) * 0.22 + Math.sin(t * 0.31 + 1.0) * 0.1,
});
const soundBtn = document.getElementById("sound");
const prompt = document.getElementById("prompt");

function startAudio() {
  if (audio.started) return;
  audio.start(sceneTime());
  prompt.classList.add("hidden");
  soundBtn.classList.add("on");
}
function toggleSound(e) {
  e.stopPropagation();
  if (!audio.started) return startAudio();
  const muted = audio.toggleMute();
  soundBtn.classList.toggle("on", !muted);
}
window.addEventListener("pointerdown", startAudio);
soundBtn.addEventListener("pointerdown", toggleSound);
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "m") toggleSound(e);
  else startAudio();
});

// ---------------------------------------------------------------------------
// Animate
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
// ?t=SECONDS jumps to a point in the drone loop
const T0 = parseFloat(new URLSearchParams(location.search).get("t")) || 0;
const sceneTime = () => clock.getElapsedTime() + T0;

function animate() {
  const t = sceneTime();
  sharedUniforms.uTime.value = t;

  const a = dronePose(t, camera.position, lookTarget);
  camera.lookAt(lookTarget);
  camera.rotateZ(Math.sin(a * 2) * 0.035); // gentle bank through the turns
  sky.position.copy(camera.position);

  for (const b of birds) {
    const u = b.userData;
    const ang = t * 0.06 + u.off;
    const R = 110 + u.lane;
    b.position.set(Math.cos(ang) * R + 10, u.y + Math.sin(t * 0.5 + u.flap) * 1.2, Math.sin(ang) * R + 70);
    b.lookAt(Math.cos(ang + 0.01) * R + 10, b.position.y, Math.sin(ang + 0.01) * R + 70);
    const glide = Math.sin(t * 0.4 + u.flap) > 0.3;
    const flap = glide ? 0.12 : Math.sin(t * 7 + u.flap) * 0.6;
    u.l.rotation.z = flap;
    u.r.rotation.z = -flap;
  }

  audio.update(t, camera, birds);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
