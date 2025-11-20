import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';

// ==================================================
// 1. SETUP SCENE & TEXTURE LOADING
// ==================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); 

// [FIX SCALE] Kamera dimajukan dan diturunkan agar lapangan terasa proporsional
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 6, 32); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // Mencegah kamera tembus tanah

// --- MANAGER TEXTURE ---
const texLoader = new THREE.TextureLoader();

// 1. Texture Rumput (Ground)
const grassTexture = texLoader.load('assets/grass.jpg');
grassTexture.wrapS = THREE.RepeatWrapping;
grassTexture.wrapT = THREE.RepeatWrapping;
// [FIX SCALE] Texture diulang 25x25 kali agar rumput terlihat detail (tidak raksasa)
grassTexture.repeat.set(25, 25); 

// 2. Texture Langit (Skybox)
const earthSky = texLoader.load('assets/earth_sky.avif');
const moonSky = texLoader.load('assets/moon_sky.jpg');
const marsSky = texLoader.load('assets/mars_sky.jpg');

// Default Sky
scene.background = earthSky;

// --- LIGHTING ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.3);
sunLight.position.set(50, 120, 50);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 4096; // Shadow lebih tajam
sunLight.shadow.mapSize.height = 4096;
const d = 80; 
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 250;
scene.add(sunLight);

// --- TANAH (GROUND) ---
const groundGeo = new THREE.PlaneGeometry(150, 150);
const groundMat = new THREE.MeshStandardMaterial({ 
    map: grassTexture, // Pakai texture rumput
    roughness: 0.8,
    color: 0xcccccc    // Sedikit redupkan agar tidak terlalu silau
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);


// ==================================================
// 2. LOAD MODEL 3D
// ==================================================
let goalPost, ballMesh, keeperMesh;
let goalColliders = [];
let goalAreaBox; 
let mixer; 

// [FIX] Ukuran bola disesuaikan dengan realisme
const BALL_RADIUS = 0.35; 
const GOAL_Z = -30; 
let startPos = new THREE.Vector3(0, BALL_RADIUS, 25);

// A. Load Gawang
const fbxLoader = new FBXLoader();
fbxLoader.load('assets/footbal_goal.fbx', (object) => {
    object.scale.set(0.02, 0.02, 0.02);
    object.position.set(0, 0, GOAL_Z);
    object.traverse((child) => { 
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    scene.add(object);

    // Hitbox Tiang
    const leftPost = new THREE.Box3(new THREE.Vector3(-7.2,0,-34), new THREE.Vector3(-7,5,-30));
    const rightPost = new THREE.Box3(new THREE.Vector3(7,0,-34), new THREE.Vector3(7.2,5,-30));
    const crossbar = new THREE.Box3(new THREE.Vector3(-6.5,4.6,-34), new THREE.Vector3(6,4.8,-30));
    goalColliders.push(leftPost, rightPost, crossbar);
    
    goalAreaBox = new THREE.Box3(new THREE.Vector3(-6.5, 0, -34), new THREE.Vector3(6.5, 4, -32.5));
});

// B. Load Kiper
fbxLoader.load('assets/keeper.fbx', (object) => {
    // [FIX KEEPER GEPENG] Pastikan X, Y, Z sama persis
    object.scale.set(0.045, 0.045, 0.045); 
    
    object.position.set(0, 0, GOAL_Z + 1.5); 
    object.rotation.x = -Math.PI/2;
    object.rotation.y = 0; // Hadap depan

    object.traverse((child) => { 
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });

    if (object.animations.length > 0) {
        mixer = new THREE.AnimationMixer(object);
        const action = mixer.clipAction(object.animations[0]);
        action.play();
    }

    keeperMesh = object;
    scene.add(keeperMesh);
}, undefined, (e) => console.log("Error load keeper:", e));

// C. Load Bola
const daeLoader = new ColladaLoader();
daeLoader.load('assets/ball.dae', (collada) => {
    ballMesh = collada.scene;
    ballMesh.scale.set(0.25, 0.25, 0.25);
    ballMesh.traverse(c => { if(c.isMesh) c.castShadow=true; });
    scene.add(ballMesh);
    resetBall(); 
});


// ==================================================
// 3. LOGIKA GAME & FISIKA
// ==================================================
// Helper Visual
const trailGeo = new THREE.BufferGeometry();
const trailMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
const trailLine = new THREE.Line(trailGeo, trailMat);
scene.add(trailLine);
const trailPoints = [];

const predGeo = new THREE.BufferGeometry();
const predMat = new THREE.LineDashedMaterial({ 
    color: 0xffffff, dashSize: 1, gapSize: 0.5, opacity: 0.5, transparent: true 
});
const predLine = new THREE.Line(predGeo, predMat);
scene.add(predLine);

// State Variables
let isFlying = false;   
let gameEnded = false;  
let velocity = new THREE.Vector3();
let angularVelocity = new THREE.Vector3();
let position = new THREE.Vector3();
let aimAssistEnabled = true;

// Kiper Patroli
let keeperSpeed = 4.0; 
let keeperDir = 1;      
const KEEPER_LIMIT = 5.5; 

const planets = {
    earth:{g:-9.8,density:1, name: "Bumi"},
    moon:{g:-1.6,density:0, name: "Bulan"},
    mars:{g:-3.7,density:0.02, name: "Mars"}
};
let currentPlanet = planets.earth;

// --- UPDATE LOOP ---

function updateKeeper(dt) {
    if (!keeperMesh || gameEnded) return; 

    keeperMesh.position.x += keeperSpeed * keeperDir * dt;

    if (keeperMesh.position.x > KEEPER_LIMIT) {
        keeperMesh.position.x = KEEPER_LIMIT;
        keeperDir = -1; 
    }
    else if (keeperMesh.position.x < -KEEPER_LIMIT) {
        keeperMesh.position.x = -KEEPER_LIMIT;
        keeperDir = 1; 
    }

    if (mixer) mixer.update(dt);
}

function calculateAcceleration(vel, angVel, planetData, windVector) {
    const mass = 0.45; 
    const airDensity = 0.002 * planetData.density; 
    
    // F.Gravitasi
    const F_gravity = new THREE.Vector3(0, planetData.g * mass, 0);
    // F.Magnus
    const F_magnus = new THREE.Vector3().crossVectors(angVel, vel).multiplyScalar(airDensity);
    // F.Angin
    const F_wind = windVector.clone().multiplyScalar(0.05 * planetData.density);
    
    return new THREE.Vector3().addVectors(F_gravity, F_magnus).add(F_wind).divideScalar(mass);
}

function updatePhysics(dt) {
    if (!isFlying || !ballMesh || gameEnded) return;

    // Ambil Angin
    const wSpeed = parseFloat(document.getElementById('windSpeed').value);
    const wDirDeg = parseFloat(document.getElementById('windDir').value); 
    const wDirRad = wDirDeg * (Math.PI/180);
    const windVec = new THREE.Vector3(Math.sin(wDirRad), 0, -Math.cos(wDirRad)).multiplyScalar(wSpeed);

    const accel = calculateAcceleration(velocity, angularVelocity, currentPlanet, windVec);
    
    velocity.add(accel.multiplyScalar(dt));
    const nextPos = position.clone().add(velocity.clone().multiplyScalar(dt));

    // Tumbukan Tanah - LOGIKA BARU UNTUK ROLLING/GAYA GESEK
    if (nextPos.y <= BALL_RADIUS) {
        nextPos.y = BALL_RADIUS;
        
        // Cek apakah masih dalam mode pantulan atau sudah menggelinding
        if (velocity.y < -0.6) { // Pantulan keras (hard bounce)
            velocity.y *= -0.6; // Koefisien restitusi (bounce)
            velocity.x *= 0.9; velocity.z *= 0.9; // Damping horizontal saat pantul
        } else { 
            // Sudah di ground atau pantulan sangat kecil (masuk mode rolling)
            velocity.y = 0; // Hentikan gerakan vertikal
            
            // Gaya Gesek (Rolling Friction Damping)
            // Koefisien 2.5 dikalikan dt untuk mensimulasikan gaya gesek konstan
            const frictionFactor = 1 - (0.35 * dt); 
            velocity.x *= frictionFactor;
            velocity.z *= frictionFactor;

            // Stop condition
            const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
            if(horizontalSpeed < 0.1) { // Jika kecepatan horizontal sangat rendah
                 isFlying = false;
                 velocity.set(0, 0, 0);
            }
        }
    }
    // AKHIR LOGIKA BARU UNTUK ROLLING/GAYA GESEK

    // Tumbukan Tiang
    const ballSphere = new THREE.Sphere(nextPos, BALL_RADIUS);
    for(let box of goalColliders) {
        if(box.intersectsSphere(ballSphere)) {
            velocity.z *= -0.5; velocity.x *= 0.5;
            updateGameStatus("TIANG!", "#FFFF00");
        }
    }

    // Tumbukan Kiper
    if (keeperMesh) {
        const kPos = keeperMesh.position;
        const keeperHitbox = new THREE.Box3(
            new THREE.Vector3(kPos.x - 1.0, kPos.y, kPos.z - 0.5), 
            new THREE.Vector3(kPos.x + 1.0, kPos.y + 4.0, kPos.z + 0.5)
        );
        if (keeperHitbox.intersectsSphere(ballSphere)) {
            velocity.z *= -0.5; velocity.y *= 0.8;
            gameEnded = true; 
            updateGameStatus("DIBLOKIR!", "#FF0000");
        }
    }

    // Gol
    if (goalAreaBox && goalAreaBox.containsPoint(nextPos)) {
        gameEnded = true; 
        updateGameStatus("GOOOOL!!!", "#00FF00");
    }

    position.copy(nextPos);
    ballMesh.position.copy(position);
    
    // --- PENAMBAHAN/PERUBAHAN LOGIKA ROTASI BOLA (RAGDOLL/ROLLING) ---
    // Rotasi bola saat terbang atau menggelinding
    const speedMagnitude = velocity.length();
    
    if(speedMagnitude > 0) {
        // Ambil komponen horizontal dari kecepatan
        const horizontalVelocity = new THREE.Vector3(velocity.x, 0, velocity.z);
        // Vektor sumbu rotasi harus tegak lurus dengan arah gerak horizontal (cross product dengan [0, 1, 0])
        const rotationAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), horizontalVelocity).normalize();
        // Sudut putaran tergantung kecepatan dan radius bola (v = r*omega)
        const angularSpeed = speedMagnitude / BALL_RADIUS; 
        const rotationAngle = angularSpeed * dt;
        
        // Terapkan rotasi
        ballMesh.rotateOnAxis(rotationAxis, rotationAngle);
    }
    // --- AKHIR LOGIKA ROTASI BOLA ---

    trailPoints.push(position.x, position.y, position.z);
    if(trailPoints.length > 600) trailPoints.splice(0,3);
    trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(trailPoints, 3));
}

// --- PREDIKSI ---
function updatePredictionPath() {
    if (!aimAssistEnabled || isFlying) return;

    const points = [];
    let simPos = startPos.clone();
    
    const speed = parseFloat(document.getElementById('speed').value);
    const spin = parseFloat(document.getElementById('spin').value);
    // AMBIL NILAI TARGET BARU
    const targetX = parseFloat(document.getElementById('targetX').value);
    const targetY = parseFloat(document.getElementById('targetY').value);
    
    const wSpeed = parseFloat(document.getElementById('windSpeed').value);
    const wDirDeg = parseFloat(document.getElementById('windDir').value);
    const wDirRad = wDirDeg * (Math.PI/180);
    
    // GUNAKAN TARGET BARU
    let target = new THREE.Vector3(targetX, targetY, GOAL_Z);
    let dir = new THREE.Vector3().subVectors(target, startPos).normalize();

    let simVel = dir.multiplyScalar(speed);
    let simAngVel = new THREE.Vector3(10, -spin, 0);
    let simWind = new THREE.Vector3(Math.sin(wDirRad), 0, -Math.cos(wDirRad)).multiplyScalar(wSpeed);
    const dt = 0.05; 
    
    // HITUNG GAYA MAGNUS AWAL UNTUK DITAMPILKAN DI PANEL
    const airDensity = 0.002 * currentPlanet.density; 
    const F_magnus_initial = new THREE.Vector3().crossVectors(simAngVel, simVel).multiplyScalar(airDensity);


    for(let i=0; i<50; i++) {
        points.push(simPos.x, simPos.y, simPos.z);
        
        // Simulasikan pergerakan di udara
        const acc = calculateAcceleration(simVel, simAngVel, currentPlanet, simWind);
        simVel.add(acc.multiplyScalar(dt));
        simPos.add(simVel.clone().multiplyScalar(dt));
        
        // Cek tumbukan tanah dalam simulasi prediksi
        if (simPos.y <= BALL_RADIUS) { 
            simPos.y = BALL_RADIUS;
            simVel.y = 0; // Hentikan vertikal
            
            // Terapkan gesek horizontal
            const frictionFactor = 1 - (2.5 * dt); 
            simVel.x *= frictionFactor;
            simVel.z *= frictionFactor;

            // Jika kecepatan terlalu rendah, hentikan simulasi
            const horizontalSpeed = Math.sqrt(simVel.x * simVel.x + simVel.z * simVel.z);
            if(horizontalSpeed < 0.1) break; 
        } 
        
        if (simPos.y <= 0) break; // Jika sudah di bawah tanah atau berhenti
    }
    
    predGeo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    predLine.computeLineDistances(); 
    predGeo.attributes.position.needsUpdate = true;

    // UPDATE PANEL STATS DENGAN NILAI GAYA MAGNUS
    updateStatsPanel(simVel, simAngVel, simWind, F_magnus_initial);
}


// ==================================================
// 4. UI INTERACTION
// ==================================================

function updateGameStatus(text, color) {
    const el = document.getElementById('game-status-text');
    el.innerText = text;
    el.style.color = color;
}

// FUNGSI UPDATE STATS DITAMBAH PARAMETER F_magnus
function updateStatsPanel(v, w, wind, F_magnus) {
    const el = document.getElementById('realtime-stats');
    el.innerHTML = `
        <b>Planet:</b> ${currentPlanet.name}<br>
        <b>Kec. Awal:</b> ${v.length().toFixed(1)} m/s<br>
        <b>Spin (Y):</b> ${w.y.toFixed(1)}<br>
        <b>Angin:</b> ${wind.length().toFixed(1)} m/s<br>
        <b>Gaya Magnus Awal:</b> ${F_magnus.length().toFixed(3)} N
    `;
}

window.toggleStats = () => {
    const el = document.getElementById('stats-modal');
    el.style.display = (el.style.display === 'none' || el.style.display === '') ? 'block' : 'none';
};

window.toggleAimAssist = () => {
    aimAssistEnabled = !aimAssistEnabled;
    document.getElementById('btn-assist').innerText = aimAssistEnabled ? "Aim Assist: ON" : "Aim Assist: OFF";
    predLine.visible = aimAssistEnabled;
    if(aimAssistEnabled) updatePredictionPath();
};

window.setStartPos = (type) => {
    if(type==='left') startPos.set(-15, BALL_RADIUS, 25);
    if(type==='center') startPos.set(0, BALL_RADIUS, 25);
    if(type==='right') startPos.set(15, BALL_RADIUS, 25);
    resetBall();
};

window.shootBall = () => {
    if(isFlying) return;
    resetBall(); 
    
    const speed = parseFloat(document.getElementById('speed').value);
    const spin = parseFloat(document.getElementById('spin').value);
    const targetX = parseFloat(document.getElementById('targetX').value);
    const targetY = parseFloat(document.getElementById('targetY').value);
    
    let target = new THREE.Vector3(targetX, targetY, GOAL_Z);
    let direction = new THREE.Vector3().subVectors(target, startPos).normalize();

    velocity.copy(direction).multiplyScalar(speed);
    angularVelocity.set(10, -spin, 0); 
    
    isFlying = true;
    gameEnded = false; 
    predLine.visible = false; 
    updateGameStatus("BOLA TERBANG...", "#fff");
};

window.resetBall = () => {
    isFlying = false;
    gameEnded = false; 
    if(ballMesh) {
        position.copy(startPos);
        ballMesh.position.copy(position);
        ballMesh.rotation.set(0,0,0);
    }
    trailPoints.length = 0;
    trailGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    predLine.visible = aimAssistEnabled;
    updatePredictionPath();
    updateGameStatus("SIAP!", "#00ff00");
};

// Input Listeners
['speed', 'spin', 'windSpeed', 'windDir', 'targetX', 'targetY'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
        if(id !== 'windDir') {
            const displayEl = document.getElementById('val-' + id);
            if(displayEl) displayEl.innerText = e.target.value;
        }
        updatePredictionPath();
    });
});

// Logic Ganti Planet
document.getElementById('planetSelect').addEventListener('change', (e) => {
    const val = e.target.value;
    currentPlanet = planets[val];
    
    if(val === 'earth') scene.background = earthSky;
    if(val === 'moon') scene.background = moonSky;
    if(val === 'mars') scene.background = marsSky;
    
    updatePredictionPath();
});

const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    updateKeeper(dt);   
    updatePhysics(dt);  
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});