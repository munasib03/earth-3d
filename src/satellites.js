import * as satellite from "satellite.js";
import * as THREE from "three";

// ─── Config ────────────────────────────────────────────────────────────────
const EARTH_RADIUS_KM = 6371;
const EARTH_RADIUS_3D = 1; // matches SphereGeometry(1, …)

// Handpicked satellites by NORAD ID
// Find more at: https://celestrak.org/satcat/
const SATELLITES = [
    { id: 25544, name: "ISS", color: 0xffdd44, size: 0.010 },
    { id: 48274, name: "CSS (Tiangong)", color: 0xff8844, size: 0.009 },
    { id: 43226, name: "GOES-16", color: 0x44ddff, size: 0.007 },
    { id: 45026, name: "GOES-18", color: 0x44ddff, size: 0.007 },
    { id: 28654, name: "NOAA-18", color: 0x88ff88, size: 0.006 },
    { id: 33591, name: "NOAA-19", color: 0x88ff88, size: 0.006 },
    { id: 38771, name: "Suomi NPP", color: 0x88ff88, size: 0.006 },
    { id: 43013, name: "NOAA-20", color: 0x88ff88, size: 0.006 },
    { id: 20580, name: "Hubble", color: 0xffaaff, size: 0.008 },
    { id: 39086, name: "Landsat 8", color: 0xaaffaa, size: 0.006 },
    { id: 49260, name: "Landsat 9", color: 0xaaffaa, size: 0.006 },
    { id: 25994, name: "Terra", color: 0x44ffcc, size: 0.006 },
    { id: 36516, name: "TanDEM-X", color: 0xffcc44, size: 0.006 },
];

// ─── Orbit path config ─────────────────────────────────────────────────────
const ORBIT_STEPS = 180;   // number of points along the path
const ORBIT_MINUTES = 95;    // minutes to project ahead (~1 full LEO orbit)

// ─── State ─────────────────────────────────────────────────────────────────
const satRecords = [];
const satMeshes = [];
let activeLine = null;   // currently displayed orbit line
let activeIdx = -1;     // index of selected satellite

// ─── Fetch TLE as plain text (FORMAT=TLE) and parse lines ─────────────────
// CelesTrak TLE format returns 3 lines: name, line1, line2
async function fetchTLE(noradId) {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=TLE`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    // Split into non-empty lines, trim whitespace
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Expect: [name, line1, line2]
    if (lines.length < 3) throw new Error(`Unexpected TLE response: ${text.slice(0, 80)}`);

    return {
        name: lines[0],
        tle1: lines[1], // starts with "1 "
        tle2: lines[2], // starts with "2 "
    };
}

// ─── Convert geodetic → Three.js XYZ ──────────────────────────────────────
function geodeticToXYZ(latRad, lngRad, altKm) {
    const r = EARTH_RADIUS_3D + (altKm / EARTH_RADIUS_KM) * EARTH_RADIUS_3D;
    const phi = Math.PI / 2 - latRad;
    const theta = lngRad + Math.PI;
    return new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
    );
}

// ─── Orbit path drawing ────────────────────────────────────────────────────
function drawOrbit(scene, idx) {
    clearOrbit(scene);

    const { satrec, name } = satRecords[idx];
    const satColor = satMeshes[idx].material.color;
    const now = new Date();
    const points = [];

    for (let i = 0; i <= ORBIT_STEPS; i++) {
        const t = new Date(now.getTime() + (i / ORBIT_STEPS) * ORBIT_MINUTES * 60 * 1000);
        const gmst = satellite.gstime(t);
        const pv = satellite.propagate(satrec, t);

        if (!pv || typeof pv.position !== "object" || pv.position === false) continue;

        const geo = satellite.eciToGeodetic(pv.position, gmst);
        points.push(geodeticToXYZ(geo.latitude, geo.longitude, geo.height));
    }

    if (points.length < 2) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
        color: satColor,
        dashSize: 0.03,
        gapSize: 0.02,
        opacity: 0.7,
        transparent: true,
    });

    activeLine = new THREE.Line(geometry, material);
    activeLine.computeLineDistances(); // required for dashes to render
    scene.add(activeLine);
    activeIdx = idx;

    console.log(`[satellites] Orbit drawn for ${name} (${points.length} points)`);
}

function clearOrbit(scene) {
    if (activeLine) {
        scene.remove(activeLine);
        activeLine.geometry.dispose();
        activeLine.material.dispose();
        activeLine = null;
        activeIdx = -1;
    }
}

// ─── Tooltip label ─────────────────────────────────────────────────────────
let labelEl = null;

function ensureLabel() {
    if (labelEl) return;
    labelEl = document.createElement("div");
    Object.assign(labelEl.style, {
        position: "fixed",
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        padding: "4px 10px",
        borderRadius: "6px",
        fontSize: "12px",
        pointerEvents: "none",
        display: "none",
        zIndex: "100",
        fontFamily: "system-ui, sans-serif",
        letterSpacing: "0.03em",
    });
    document.body.appendChild(labelEl);
}

// ─── Raycaster hover + click ───────────────────────────────────────────────
function setupHover(scene, cam, ren) {
    ensureLabel();
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Hover — show tooltip
    ren.domElement.addEventListener("mousemove", (e) => {
        const rect = ren.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, cam);
        const hits = raycaster.intersectObjects(satMeshes);

        if (hits.length > 0) {
            const idx = satMeshes.indexOf(hits[0].object);
            labelEl.textContent = satRecords[idx]?.name ?? "Unknown";
            labelEl.style.display = "block";
            labelEl.style.left = (e.clientX + 14) + "px";
            labelEl.style.top = (e.clientY - 6) + "px";
            ren.domElement.style.cursor = "pointer";
        } else {
            labelEl.style.display = "none";
            ren.domElement.style.cursor = "";
        }
    });

    // Click — toggle orbit path
    ren.domElement.addEventListener("click", (e) => {
        const rect = ren.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, cam);
        const hits = raycaster.intersectObjects(satMeshes);

        if (hits.length > 0) {
            const idx = satMeshes.indexOf(hits[0].object);
            if (idx === activeIdx) {
                clearOrbit(scene);   // click same satellite → hide orbit
            } else {
                drawOrbit(scene, idx); // click new satellite → show its orbit
            }
        } else {
            clearOrbit(scene);     // click empty space → clear
        }
    });
}

// ─── Public: init ──────────────────────────────────────────────────────────
export async function initSatellites(scene, cam, ren) {
    console.log(`[satellites] Fetching ${SATELLITES.length} satellites…`);

    const results = await Promise.allSettled(
        SATELLITES.map((cfg) => fetchTLE(cfg.id).then((tle) => ({ cfg, tle })))
    );

    for (const result of results) {
        if (result.status === "rejected") {
            console.warn("[satellites] Fetch failed:", result.reason.message);
            continue;
        }

        const { cfg, tle } = result.value;
        try {
            const satrec = satellite.twoline2satrec(tle.tle1, tle.tle2);
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(cfg.size, 8, 8),
                new THREE.MeshBasicMaterial({ color: cfg.color })
            );
            mesh.visible = false;
            scene.add(mesh);
            satRecords.push({ satrec, name: cfg.name });
            satMeshes.push(mesh);
            console.log(`[satellites] ✓ ${cfg.name}`);
        } catch (err) {
            console.warn(`[satellites] Bad TLE for ${cfg.name}:`, err.message);
        }
    }

    console.log(`[satellites] Loaded ${satMeshes.length} / ${SATELLITES.length} satellites.`);
    setupHover(scene, cam, ren);
}

// ─── Public: call every frame in animate() ────────────────────────────────
export function updateSatellites() {
    const now = new Date();
    const gmst = satellite.gstime(now);

    for (let i = 0; i < satRecords.length; i++) {
        const pv = satellite.propagate(satRecords[i].satrec, now);

        if (!pv || typeof pv.position !== "object" || pv.position === false) {
            satMeshes[i].visible = false;
            continue;
        }

        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const pos = geodeticToXYZ(geo.latitude, geo.longitude, geo.height);
        satMeshes[i].position.copy(pos);
        satMeshes[i].visible = true;
    }
}