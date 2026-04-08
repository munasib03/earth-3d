import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { initSatellites, updateSatellites } from "./satellites.js";

const canvas = document.querySelector("canvas");

// ---------------- Renderer / Scene / Camera ----------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

// Tone mapping helps avoid crushed blacks
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace; // add this line

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060606); // deep navy blue

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
camera.position.set(0, 0, 3.3);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
initSatellites(scene, camera, renderer);

// One ambient light only (enough to see the night side a bit)
scene.add(new THREE.AmbientLight(0xffffff, 0.18));

// ---------------- Sun (visible) + Light ----------------
const SUN_DISTANCE = 25;
const sunPos = new THREE.Vector3(SUN_DISTANCE, 6, 10);

// Sun mesh removed
// const sunMesh = new THREE.Mesh(
//   new THREE.SphereGeometry(1.2, 32, 32),
//   new THREE.MeshBasicMaterial({ color: 0xffffff })
// );
// sunMesh.position.copy(sunPos);
// scene.add(sunMesh);

// Directional light (acts like the sun)
const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
sunLight.position.copy(sunPos);
scene.add(sunLight);

// ---------------- Earth textures ----------------
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

// Live Earth Map (Day + Clouds)
// Source: https://github.com/matteason/live-cloud-maps
const LIVE_EARTH_URL =
  "https://clouds.matteason.co.uk/images/4096x2048/earth.jpg";

function cacheBust(url) {
  return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

const dayTex = loader.load(cacheBust(LIVE_EARTH_URL));
dayTex.colorSpace = THREE.SRGBColorSpace;

// Night lights map (optional)
let nightTex = null;
let hasNight = false;

function tryLoadNightTexture() {
  return new Promise((resolve) => {
    loader.load(
      "/textures/earth_night.jpg",
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        nightTex = t;
        hasNight = true;
        resolve(true);
      },
      undefined,
      () => resolve(false)
    );
  });
}

// ---------------- Atmosphere glow (simple & cheap) ----------------
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.03, 64, 64),
  new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    uniforms: {
      glowColor: { value: new THREE.Color(0x3aa7ff) },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      uniform vec3 glowColor;
      void main() {
        float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
        gl_FragColor = vec4(glowColor, intensity * 0.35);
      }
    `,
  })
);
scene.add(atmosphere);

// ---------------- Earth material (day/night shader) ----------------
const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    dayMap: { value: dayTex },
    nightMap: { value: nightTex }, // may be null
    sunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    nightEnabled: { value: 0.0 }, // 1 if nightTex exists
    sunIntensity: { value: 2.2 }, // Match sunLight.intensity
  },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNormalW;
    void main() {
      vUv = uv;
      // world-space normal
      vNormalW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D dayMap;
    uniform sampler2D nightMap;
    uniform vec3 sunDirWorld;
    uniform float nightEnabled;
    uniform float sunIntensity;

    varying vec2 vUv;
    varying vec3 vNormalW;

    void main() {
      vec3 dayColor = texture2D(dayMap, vUv).rgb;
      dayColor = pow(dayColor, vec3(2.2)); // sRGB -> linear

      // lighting term
      // float ndl = dot(normalize(vNormalW), normalize(sunDirWorld));
      // float light = clamp(ndl, 0.0, 1.0);

      // softer terminator
      // float dayFactor = smoothstep(0.02, 0.35, light);

      // Always keep surface visible at night:
      // If no night texture, use a dimmed day map + slight blue tint.
      // vec3 nightColor = dayColor * 0.18 + vec3(0.02, 0.02, 0.03);
      // if (nightEnabled > 0.5) {
      //   nightColor = texture2D(nightMap, vUv).rgb;
      // }

      // Boost day color by sun intensity
      vec3 litDayColor = dayColor * sunIntensity;

      // vec3 color = mix(nightColor, litDayColor, dayFactor);
      vec3 color = litDayColor; // removing night shade
      color = pow(color, vec3(1.0 / 2.2)); // linear -> sRGB
      gl_FragColor = vec4(color, 1.0);
    }
  `,
});

const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), earthMat);
scene.add(earth);

// Auto-refresh texture every 3 hours
const THREE_HOURS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const newUrl = cacheBust(LIVE_EARTH_URL);
  loader.load(newUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    earthMat.uniforms.dayMap.value = tex;
    // THREE.js often needs a manual update if reusing the same uniform slot,
    // but replacing the value object works.
  });
}, THREE_HOURS);

// Controls (None for now as 'W' is redundant)


// ---------------- Resize ----------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ---------------- Animate ----------------
const clock = new THREE.Clock();

(async function init() {
  // Try to load night texture if present
  const ok = await tryLoadNightTexture();
  earthMat.uniforms.nightEnabled.value = ok ? 1.0 : 0.0;
  if (ok) earthMat.uniforms.nightMap.value = nightTex;

  function animate() {
    const dt = clock.getDelta();

    // earth.rotation.y += dt * 0.06;
    // atmosphere.rotation.y += dt * 0.06;

    // Sun direction in world space.
    // If lighting appears reversed, multiply by -1.
    const sunDir = new THREE.Vector3().copy(sunLight.position).normalize();
    earthMat.uniforms.sunDirWorld.value.copy(sunDir);

    controls.update();
    updateSatellites();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  animate();
})();
