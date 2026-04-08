import * as satellite from "satellite.js";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";



// ─── Config ────────────────────────────────────────────────────────────────
const EARTH_RADIUS_KM = 6371;
const EARTH_RADIUS_3D = 1; // matches SphereGeometry(1, …)

// Handpicked satellites by NORAD ID
// Find more at: https://celestrak.org/satcat/
const SATELLITES = [
    { id: 25544, name: "ISS", color: 0xffdd44, size: 0.010, link: "https://en.wikipedia.org/wiki/International_Space_Station", image: "/iss.jpg", model: "/iss.glb" },
    { id: 48274, name: "CSS (Tiangong)", color: 0xff8844, size: 0.009, link: "https://en.wikipedia.org/wiki/Tiangong_space_station", image: "/tiangong.jpg" },
    { id: 43226, name: "GOES-16", color: 0x44ddff, size: 0.007 },
    { id: 45026, name: "GOES-18", color: 0x44ddff, size: 0.007 },
    { id: 28654, name: "NOAA-18", color: 0x88ff88, size: 0.006 },
    { id: 33591, name: "NOAA-19", color: 0x88ff88, size: 0.006 },
    { id: 38771, name: "Suomi NPP", color: 0x88ff88, size: 0.006 },
    { id: 43013, name: "NOAA-20", color: 0x88ff88, size: 0.006, link: "https://en.wikipedia.org/wiki/NOAA-20", image: "/noaa-20.jpg" },
    { id: 20580, name: "Hubble", color: 0xffaaff, size: 0.008, link: "https://en.wikipedia.org/wiki/Hubble_Space_Telescope", image: "/hubble.jpg", model: "/hubble.glb" },
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
    try {
        const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=TLE`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        // Split into non-empty lines, trim whitespace
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        // Expect: [name, line1, line2]
        if (lines.length >= 3) {
            return {
                name: lines[0],
                tle1: lines[1], // starts with "1 "
                tle2: lines[2]  // starts with "2 "
            };
        }
        throw new Error(`Unexpected TLE response`);
    } catch (err) {
        console.warn(`[satellites] CelesTrak failed for ${noradId}, attempting fallback API...`);
        // Fallback to Ivan Stanojevic's API
        const fUrl = `https://tle.ivanstanojevic.me/api/tle/${noradId}`;
        const fRes = await fetch(fUrl);
        if (!fRes.ok) throw new Error(`Fallback HTTP ${fRes.status}`);
        const data = await fRes.json();
        return {
            name: data.name,
            tle1: data.line1,
            tle2: data.line2
        };
    }
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

    const { satrec, name, color } = satRecords[idx];
    const satColor = color;
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

    const positions = [];
    for (const p of points) {
        positions.push(p.x, p.y, p.z);
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
        color: satColor,
        linewidth: 3, // in pixels
        dashed: true,
        dashSize: 0.08,  // world space units
        gapSize: 0.04,
        opacity: 0.9,
        transparent: true,
        resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });

    activeLine = new Line2(geometry, material);
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

    function getSatIndex(hitObject) {
        let obj = hitObject;
        while (obj) {
            const idx = satMeshes.indexOf(obj);
            if (idx !== -1) return idx;
            obj = obj.parent;
        }
        return -1;
    }

    // Hover — show tooltip
    ren.domElement.addEventListener("mousemove", (e) => {
        const rect = ren.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, cam);
        const hits = raycaster.intersectObjects(satMeshes, true); // true for recursive

        if (hits.length > 0) {
            const idx = getSatIndex(hits[0].object);
            if (idx !== -1) {
                labelEl.textContent = satRecords[idx]?.name ?? "Unknown";
                labelEl.style.display = "block";
                labelEl.style.left = (e.clientX + 14) + "px";
                labelEl.style.top = (e.clientY - 6) + "px";
                ren.domElement.style.cursor = "pointer";
                return;
            }
        }

        labelEl.style.display = "none";
        ren.domElement.style.cursor = "";
    });

    // Click — toggle orbit path
    ren.domElement.addEventListener("click", (e) => {
        const rect = ren.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, cam);
        const hits = raycaster.intersectObjects(satMeshes, true); // true for recursive

        if (hits.length > 0) {
            const idx = getSatIndex(hits[0].object);
            if (idx !== -1) {
                if (idx === activeIdx) {
                    clearOrbit(scene);   // click same satellite → hide orbit
                } else {
                    drawOrbit(scene, idx); // click new satellite → show its orbit
                }
                return;
            }
        }

        clearOrbit(scene); // click empty space → clear
    });
}

// ─── Public: init ──────────────────────────────────────────────────────────
export async function initSatellites(scene, cam, ren) {
    console.log(`[satellites] Fetching ${SATELLITES.length} satellites…`);

    // Map to hold loaded 3D models
    const loadedModels = {};

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    // Preload all uniquely specified models in the config
    const modelUrls = [...new Set(SATELLITES.map(s => s.model).filter(Boolean))];
    for (const url of modelUrls) {
        try {
            const gltf = await loader.loadAsync(url);
            const model = gltf.scene;

            // Auto-scale the model so it fits perfectly on the globe
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim > 0) {
                const target = 0.08 / maxDim;
                model.scale.set(target, target, target);
            }
            loadedModels[url] = model;
        } catch (err) {
            console.warn(`[satellites] Failed to load model ${url}. Falling back to default spheres.`);
            console.error("GLTF Load Error:", err);
        }
    }

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
            let mesh;

            if (cfg.model && loadedModels[cfg.model]) {
                mesh = loadedModels[cfg.model].clone();
            } else {
                // Original colored sphere fallback
                mesh = new THREE.Mesh(
                    new THREE.SphereGeometry(cfg.size, 8, 8),
                    new THREE.MeshBasicMaterial({ color: cfg.color })
                );
            }

            mesh.visible = false;
            scene.add(mesh);
            satRecords.push({ satrec, name: cfg.name, color: cfg.color, link: cfg.link, image: cfg.image });
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

        // Dynamically orient to face the direction of flight
        const tFuture = new Date(now.getTime() + 1000); // 1 second in the future
        const pvFuture = satellite.propagate(satRecords[i].satrec, tFuture);
        if (pvFuture && typeof pvFuture.position === "object" && pvFuture.position !== false) {
            const geoFuture = satellite.eciToGeodetic(pvFuture.position, satellite.gstime(tFuture));
            const posFuture = geodeticToXYZ(geoFuture.latitude, geoFuture.longitude, geoFuture.height);
            satMeshes[i].lookAt(posFuture);

            // IF THE ISS IS UPSIDE DOWN OR SIDEWAYS: 
            // You can easily fix it by uncommenting and adjusting these local rotations:
            // satMeshes[i].rotateX(Math.PI / 2);
            // satMeshes[i].rotateY(Math.PI);
        }

        satMeshes[i].visible = true;
    }

    if (activeLine && activeLine.material && activeLine.material.resolution) {
        activeLine.material.resolution.set(window.innerWidth, window.innerHeight);
    }

    updateInfoPanel(now, gmst);
}

// ─── Info Panel ────────────────────────────────────────────────────────────
let panelEl = null;
let nameEl = null;
let altEl = null;
let velEl = null;
let latLngEl = null;
let imgEl = null;
let linkEl = null;

function ensureInfoPanel() {
    if (panelEl) return;
    panelEl = document.createElement("div");
    Object.assign(panelEl.style, {
        position: "fixed",
        top: "20px",
        right: "20px",
        background: "rgba(10, 15, 30, 0.65)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        color: "#fff",
        padding: "20px 24px",
        borderRadius: "16px",
        fontFamily: "'Inter', 'Roboto', system-ui, sans-serif",
        minWidth: "260px",
        maxWidth: "300px",
        display: "none",
        zIndex: "100",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
        transition: "opacity 0.3s ease, transform 0.3s ease",
        opacity: "0",
        transform: "translateY(-10px)",
    });

    // Header
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.margin = "0 0 16px 0";

    nameEl = document.createElement("h2");
    Object.assign(nameEl.style, {
        margin: "0",
        fontSize: "20px",
        fontWeight: "600",
        letterSpacing: "0.05em",
        textTransform: "uppercase"
    });

    linkEl = document.createElement("a");
    Object.assign(linkEl.style, {
        color: "#44ddff",
        fontSize: "12px",
        textDecoration: "none",
        display: "none", // hidden by default
        background: "rgba(68, 221, 255, 0.1)",
        padding: "4px 8px",
        borderRadius: "4px",
        fontWeight: "500"
    });
    linkEl.target = "_blank";
    linkEl.textContent = "Wiki ↗";

    headerRow.appendChild(nameEl);
    headerRow.appendChild(linkEl);

    // Optional Image container
    imgEl = document.createElement("img");
    Object.assign(imgEl.style, {
        width: "100%",
        height: "140px",
        objectFit: "cover",
        borderRadius: "8px",
        marginBottom: "16px",
        display: "none", // hidden by default
        border: "1px solid rgba(255, 255, 255, 0.05)"
    });

    const statsContainer = document.createElement("div");
    Object.assign(statsContainer.style, {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        fontSize: "14px",
        color: "rgba(255, 255, 255, 0.8)",
    });

    const createRow = (label) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        const lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.style.color = "rgba(255, 255, 255, 0.55)";

        const val = document.createElement("span");
        val.style.fontWeight = "500";
        val.style.fontVariantNumeric = "tabular-nums";

        row.appendChild(lbl);
        row.appendChild(val);
        return { row, val };
    };

    const altRow = createRow("Altitude:");
    const velRow = createRow("Velocity:");
    const coordsRow = createRow("Coordinates:");

    altEl = altRow.val;
    velEl = velRow.val;
    latLngEl = coordsRow.val;

    statsContainer.appendChild(altRow.row);
    statsContainer.appendChild(velRow.row);
    statsContainer.appendChild(coordsRow.row);

    panelEl.appendChild(headerRow);
    panelEl.appendChild(imgEl);
    panelEl.appendChild(statsContainer);
    document.body.appendChild(panelEl);
}

function updateInfoPanel(now, gmst) {
    if (activeIdx === -1) {
        if (panelEl && panelEl.style.display !== "none" && panelEl.style.opacity !== "0") {
            panelEl.style.opacity = "0";
            panelEl.style.transform = "translateY(-10px)";
            setTimeout(() => { if (activeIdx === -1) panelEl.style.display = "none"; }, 300);
        }
        return;
    }

    ensureInfoPanel();

    if (panelEl.style.display === "none") {
        panelEl.style.display = "block";
        void panelEl.offsetWidth; // flush CSS to trigger transition
        panelEl.style.opacity = "1";
        panelEl.style.transform = "translateY(0)";
    }

    const rec = satRecords[activeIdx];
    const pv = satellite.propagate(rec.satrec, now);
    if (!pv || !pv.position || !pv.velocity) return;

    const geo = satellite.eciToGeodetic(pv.position, gmst);

    // Convert components from km/s to scalar magnitude
    const velMagnitude = Math.sqrt(
        Math.pow(pv.velocity.x, 2) + Math.pow(pv.velocity.y, 2) + Math.pow(pv.velocity.z, 2)
    );

    nameEl.textContent = rec.name;
    nameEl.style.color = `#${rec.color.toString(16).padStart(6, '0')}`;

    // Conditionally show Wikipedia link
    if (rec.link) {
        linkEl.href = rec.link;
        linkEl.style.display = "block";
    } else {
        linkEl.style.display = "none";
    }

    // Conditionally show custom Image
    if (rec.image) {
        // Prevent flickering by only setting it if it changed
        if (imgEl.src !== rec.image) {
            imgEl.src = rec.image;
        }
        imgEl.style.display = "block";
    } else {
        imgEl.style.display = "none";
    }

    altEl.textContent = `${geo.height.toFixed(1)} km`;
    velEl.textContent = `${velMagnitude.toFixed(2)} km/s`;

    const latDeg = satellite.degreesLat(geo.latitude).toFixed(2);
    const lngDeg = satellite.degreesLong(geo.longitude).toFixed(2);
    latLngEl.textContent = `${latDeg}°, ${lngDeg}°`;
}