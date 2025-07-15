import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragControls } from 'three/addons/controls/DragControls.js'; // Uvoz DragControls
import { FactoryManager } from './FactoryManager.js'; // Uvoz upravitelja
import { factoryLayout } from './FactoryLayout.js'; // Uvoz konfiguracije postavitve
import { io } from "socket.io-client"; // Import Socket.IO client

console.log("Script starting...");

// --- Globalne spremenljivke ---

// --- Nastavitev scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xCFE2F3);

// --- Nastavitev kamere ---
const threejsContainer = document.getElementById('threejs-container');
if (!threejsContainer) console.error("Three.js container element #threejs-container not found!");

const camera = new THREE.PerspectiveCamera(75, threejsContainer.clientWidth / threejsContainer.clientHeight, 0.1, 1000);
camera.position.set(5, 5, 5); // Kamera premaknjena bližje (povečano)
camera.lookAt(0, 0, 0); // Ohrani pogled usmerjen v središče
 
// --- Nastavitev izrisovalnika ---
const canvas = document.getElementById('webgl');
if (!canvas) console.error("Canvas element #webgl not found!");
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(threejsContainer.clientWidth, threejsContainer.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
 
// --- Obravnava spremembe velikosti okna ---
window.addEventListener('resize', () => {
    // Posodobi kamero
    const newWidth = threejsContainer.clientWidth;
    const newHeight = threejsContainer.clientHeight;
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
 
    // Posodobi izrisovalnik
    renderer.setSize(newWidth, newHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    console.log("Window resized.");
});

// --- Osvetlitev ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(20, 30, 25);
scene.add(directionalLight);

// --- Pomočnik za mrežo in definicija merila ---
const gridUnitSizeCm = 5; // Vsak kvadrat mreže predstavlja 5cm x 5cm
const threeUnitsPerGridUnit = 1;
const unitsPerCm = threeUnitsPerGridUnit / gridUnitSizeCm; // Izračunaj Three.js enote na centimeter
const gridDivisions = 10; // Naredi 10x10 mrežo
const gridSize = gridDivisions * threeUnitsPerGridUnit;

const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x888888, 0xcccccc);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

// --- Kontrole kamere (OrbitControls) ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;


// --- Pomožna funkcija za postavitev objekta na podlagi koordinat mreže ---
function gridToWorld(gridX, gridY, height = 0) {
    // Preveri, ali so konstante definirane (morale bi biti, zaradi vrstnega reda)
    if (typeof gridDivisions === 'undefined' || typeof threeUnitsPerGridUnit === 'undefined') {
        console.error("gridToWorld called before grid constants were defined!");
        return new THREE.Vector3(0, height, 0);
    }
    const worldX = (gridX - gridDivisions / 2) * threeUnitsPerGridUnit;
    const worldZ = (gridY - gridDivisions / 2) * threeUnitsPerGridUnit; // Mapiraj Y mreže na Z sveta
    const resultVector = new THREE.Vector3(worldX, height, worldZ);
    return resultVector;
}

// --- Pomožna funkcija za pretvorbo svetovnih koordinat nazaj v koordinate mreže ---
function worldToGrid(worldX, worldZ) {
    if (typeof gridDivisions === 'undefined' || typeof threeUnitsPerGridUnit === 'undefined' || threeUnitsPerGridUnit === 0) {
        console.error("worldToGrid called before grid constants were defined or grid unit size is zero!");
        return { x: 0, y: 0 };
    }
    const gridX = Math.round(worldX / threeUnitsPerGridUnit + gridDivisions / 2);
    const gridY = Math.round(worldZ / threeUnitsPerGridUnit + gridDivisions / 2); // Mapiraj Z sveta nazaj na Y mreže
    // Omeji na meje mreže (izbirno, a dobra praksa)
    const clampedX = Math.max(0, Math.min(gridDivisions, gridX));
    const clampedY = Math.max(0, Math.min(gridDivisions, gridY));
    return { x: clampedX, y: clampedY }; // Ohrani return izjavo
}

// --- Nastavitev tovarne ---
// Instanciraj FactoryManager
const factoryManager = new FactoryManager(scene, gridToWorld, factoryLayout, unitsPerCm);
 
// Inicializiraj tovarno (naloži modele, poveže se z MQTT)
// Uporabi asinhrono IIFE (Immediately Invoked Function Expression) za obravnavo asinhrone inicializacije
let draggableObjects = []; // Polje za shranjevanje modelov, ki jih je mogoče vleči
let dragControlsInstance = null; // Za shranjevanje instance DragControls
let selectedObject = null; // Za sledenje objektu, ki se vleče/izbira
let clickOffsetFromRoot_world = new THREE.Vector3(); // Svetovni odmik od izvora korenskega modela do dejanske točke klika
let conveyorCount = 0; // Števec za unikatna imena tekočih trakov
let dragControlsInstanceId = 0; // Števec za instance DragControls za odpravljanje napak
let craneCount = 0;    // Števec za unikatna imena dvigal
let craneCharts = new Map(); // Map to store Chart.js instances for cranes

const socket = io();
 
// Počakaj, da se DOM v celoti naloži, preden se izvede glavna logika
document.addEventListener('DOMContentLoaded', () => {
 
    (async () => {
        try {
            // Inicializiraj upravitelja (poveže MQTT itd., vendar ne naloži modelov)
            // Posreduj instanco vtičnice upravitelju tovarne
            await factoryManager.initialize(socket);

            // Setup drag controls (will initially have an empty array)
            setupDragControls();
            // Nastavi poslušalce gumbov uporabniškega vmesnika - ZDAJ varno za klic, ker je DOM pripravljen
            setupMenuButtons();
            setupMachineControlPanel(); // Setup the machine control panel
            setupAutomationControls(); // Setup the new automation controls

            // Listen for MQTT messages from the server
            socket.on('mqtt_message', (data) => {
                factoryManager.handleMqttMessage(data.topic, data.message);
            });
 
            // Poslušaj posodobitve statusa UI s strežnika
            socket.on('ui_status_update', (data) => {
                const automationStatusElement = document.getElementById('automation-status');
                if (automationStatusElement) {
                    automationStatusElement.innerHTML = data.payload;
                }
            });
 
            if (canvas) {
                animate();
            } else {
            }
        } catch (error) {
        }
    })();
});

// Pomožna funkcija za iskanje korenskega modela stroja iz presečenega objekta.
// Korenski model mora biti eden od objektov neposredno v polju draggableObjects.
function getRootMachineModelFromIntersection(intersectedObject) {
    let current = intersectedObject;
    let depth = 0; // Za preprečevanje potencialnih neskončnih zank v kompleksnih/pokvarjenih hierarhijah
    while (current && depth < 10) { // Največja globina iskanja 10
        // Preveri, ali je 'current' eden od objektov neposredno v draggableObjects
        // Primerjaj po UUID za zanesljivost, saj imena morda niso unikatna za pod-mreže.
        const isDraggableRoot = draggableObjects.find(obj => obj.uuid === current.uuid);

        if (isDraggableRoot) {
            // In zagotovi, da je registriran stroj
            if (factoryManager.getMachineByName(current.name)) {
                return current; // Najden korenski model stroja
            }
        }

        if (!current.parent || current.parent === scene) { // Ustavi, če ni starša ali je starš scena
            break;
        }
        current = current.parent;
        depth++;
    }
    return null; // Vrni null, če ni najden noben veljaven korenski model
}

// --- Nastavitev kontrol vlečenja ---
function setupDragControls() {
    // Zavrzi staro instanco, če obstaja, da zagotoviš svežo nastavitev
    if (dragControlsInstance) {
        dragControlsInstance.dispose(); // Keep this line
        dragControlsInstance = null; // Počisti referenco
    }

    if (!draggableObjects.length) {
        console.log("No draggable objects to set up DragControls for.");
        // Ni potrebe po ustvarjanju DragControls, če ni ničesar za vlečenje
        return;
    } else {
    }

    // Pass a shallow copy of the array. This is a defensive measure in case DragControls
    // does something unexpected with the array reference internally.
    const currentDraggableObjectsList = [...draggableObjects];
    dragControlsInstance = new DragControls(currentDraggableObjectsList, camera, renderer.domElement);
    dragControlsInstance.instanceId = ++dragControlsInstanceId; // Dodeli instanci unikatni ID

    // Izbirno: Preveri, katere objekte DragControls interno smatra za svoje, če metoda obstaja
    if (typeof dragControlsInstance.getObjects === 'function') {
        const internalObjects = dragControlsInstance.getObjects();
        internalObjects.forEach((obj, index) => { // Ohrani to zanko, če želiš videti interni seznam
            console.log(`  Internal[${index}]: ${obj.name} (UUID: ${obj.uuid})`);
        });
    }

    dragControlsInstance.transformGroup = true; // Vrni na true
    console.log(`[DEBUG] dragControlsInstance.transformGroup set to: ${dragControlsInstance.transformGroup}`);


    // Onemogoči OrbitControls med vlečenjem
    dragControlsInstance.addEventListener('dragstart', function (event) {
        // event.object iz DragControls je objekt iz polja draggableObjects.
        // Ko je transformGroup true, bi moral biti event.object sam korenski model.
        const actualClickedMesh = event.object; // Pridobi objekt, ki ga DragControls poroča kot kliknjenega
        selectedObject = getRootMachineModelFromIntersection(actualClickedMesh); // To zagotovi, da je selectedObject koren.

        if (selectedObject) {
            console.log(`   getRootMachineModelFromIntersection identified: ${selectedObject.name}. Drag Start on machine: ${selectedObject.name} (Raw event.object was: ${actualClickedMesh.name})`);
            controls.enabled = false;

            // Calculate the world offset from the root model's origin to the clicked part's origin.
            // When transformGroup = true, event.object (actualClickedMesh) should be the root model.
            // Thus, clickedPartWorldPosition and rootModelWorldPosition will be the same,
            // and clickOffsetFromRoot_world will be (0,0,0).
            // This means we're effectively preparing to snap the root's origin to the grid.
            const clickedPartWorldPosition = new THREE.Vector3();
            actualClickedMesh.updateMatrixWorld(true); // Ensure world matrix is current
            actualClickedMesh.getWorldPosition(clickedPartWorldPosition);

            const rootModelWorldPosition = new THREE.Vector3();
            selectedObject.updateMatrixWorld(true); // Ensure world matrix is current
            selectedObject.getWorldPosition(rootModelWorldPosition);

            clickOffsetFromRoot_world.subVectors(clickedPartWorldPosition, rootModelWorldPosition);

            console.log(`[DRAG START EVENT from instance ID: ${dragControlsInstance.instanceId}] Raw event.object: ${event.object.name} (UUID: ${event.object.uuid})`); // Keep this line
        } else {
            console.warn(`   Drag Start: Could not identify root machine model for raw event.object: ${actualClickedMesh.name}. Setting selectedObject to null.`);
            selectedObject = null; 
            clickOffsetFromRoot_world.set(0,0,0); // Reset offset
        }
    });

    dragControlsInstance.addEventListener('drag', function (event) {
        if (!selectedObject) { 
            return; 
        }

        // Z transformGroup = true, DragControls premika selectedObject (korenski model).
        // selectedObject.position je na tej točki že posodobljen s strani DragControls. // Ohrani ta komentar
        const currentRootPositionRaw = selectedObject.position.clone();

        // Calculate where the original click point (the "handle") would be in the world,
        // based on the root's new raw position and the stored offset. // Keep this comment
        // Since clickOffsetFromRoot_world is likely (0,0,0), effectiveClickPoint_world will be currentRootPositionRaw.
        const effectiveClickPoint_world = new THREE.Vector3().addVectors(currentRootPositionRaw, clickOffsetFromRoot_world);

        // Pripni to efektivno točko klika na mrežo
        const targetGridPos = worldToGrid(effectiveClickPoint_world.x, effectiveClickPoint_world.z); // worldToGrid beleži svoj lastni izpis, ki ga morda želiš ohraniti ali odstraniti ločeno
        const snappedEffectiveClickPoint_world = gridToWorld(targetGridPos.x, targetGridPos.y, 0); // Y je 0

        // Calculate the new position for the root model's ORIGIN.
        // Since clickOffsetFromRoot_world is likely (0,0,0), finalRootOriginPos will be snappedEffectiveClickPoint_world.
        const finalRootOriginPos = new THREE.Vector3().subVectors(snappedEffectiveClickPoint_world, clickOffsetFromRoot_world);
        finalRootOriginPos.y = 0; // Prisili izvor korenskega modela na Y=0 na ravnini mreže.

        selectedObject.position.copy(finalRootOriginPos);
    });

    dragControlsInstance.addEventListener('dragend', function (event) {
        // We use selectedObject, which is the root machine model.
        if (!selectedObject || !factoryManager.getMachineByName(selectedObject.name)) {
            console.warn(`[DRAG END from instance ID: ${dragControlsInstance.instanceId}] No valid selected machine model. Raw event.object: ${event.object?.name}. Current selectedObject: ${selectedObject?.name}`);
            controls.enabled = true; // Ponovno omogoči OrbitControls
            selectedObject = null; // Počisti izbrani objekt
            clickOffsetFromRoot_world.set(0,0,0); // Ponastavi odmik
            return;
        }
        console.log(`[DRAG END from instance ID: ${dragControlsInstance.instanceId}] Drag End on machine: ${selectedObject.name}. Raw event.object: ${event.object.name}`); // Keep this line
        controls.enabled = true; // Ponovno omogoči OrbitControls

        const machine = factoryManager.getMachineByName(selectedObject.name);
        if (machine) {
            // Uporabi položaj selectedObject, ki bi moral biti pripet.
            const finalGridPos = worldToGrid(selectedObject.position.x, selectedObject.position.z);
            // Posodobi konfiguracijski objekt, povezan z instanco stroja
            // Opomba: To posodobi *runtime* konfiguracijo. Shranjevanje zahteva dodatne korake.
            if (machine.config.gridPos) {
                machine.config.gridPos.x = finalGridPos.x;
                machine.config.gridPos.y = finalGridPos.y;
            } else if (machine.config.initialGridPos) { // Obravnavaj primer Workpiece
                 machine.config.initialGridPos.x = finalGridPos.x;
                 machine.config.initialGridPos.y = finalGridPos.y;
                 // POMEMBNO: Če je premikanje obdelovanca relativno, je treba njegov initialWorldPos ponovno izračunati!
                 if (typeof machine.updateInitialWorldPos === 'function') {
                     machine.updateInitialWorldPos();
                 } else { console.warn(`Workpiece ${machine.name} moved but has no updateInitialWorldPos method.`); }
            }
        } else {
            console.warn(`Drag End: Could not find machine instance for ${selectedObject.name} in FactoryManager.`);
        }
        selectedObject = null; // Odznači logični model stroja
        clickOffsetFromRoot_world.set(0,0,0); // Ponastavi odmik
    });
}

// --- Nastavitev poslušalcev gumbov menija ---
function setupMenuButtons() {
    const addConveyorButton = document.getElementById('add-conveyor');
    const addCraneButton = document.getElementById('add-crane'); // Keep this line
    const exportLayoutButton = document.getElementById('export-layout-btn');
    const importLayoutButton = document.getElementById('import-layout-btn');

    if (addConveyorButton) {
        addConveyorButton.addEventListener('click', () => {
            // Pozovi za teme pred dodajanjem
            promptForTopicsAndAdd('Conveyor');
        });
    } else {
        console.error("Button #add-conveyor not found");
    }

    if (addCraneButton) {
        addCraneButton.addEventListener('click', () => { // Keep this line
            console.log("Add Crane button clicked");
            // Pozovi za teme pred dodajanjem
            promptForTopicsAndAdd('Crane');
        });
    } else {
         console.error("Button #add-crane not found");
    }

    if (exportLayoutButton) {
        exportLayoutButton.addEventListener('click', exportLayoutToJson);
    } else {
        console.warn("Button #export-layout-btn not found");
    }

    if (importLayoutButton) {
        importLayoutButton.addEventListener('click', () => {
            document.getElementById('import-layout-file').click(); // Sproži skriti vnos datoteke
        });
    } else {
        console.warn("Button #import-layout-btn not found");
    }
}

// --- Publish MQTT Message via Socket.IO ---
function publishMqttMessage(topic, message) {
    if (socket && socket.connected) {
        socket.emit('publish_mqtt', { topic: topic, message: JSON.stringify(message) });
        console.log(`Emitted 'publish_mqtt' to server for topic ${topic}: ${JSON.stringify(message)}`);
    } else {
        console.warn('Socket.IO client not connected. Cannot publish message.');
    }
}

// --- Machine Control Panel Logic ---
let currentMachineControlPanel = null; // To keep track of the currently displayed panel

function setupMachineControlPanel() {
    const machineControlsContainer = document.getElementById('machine-controls');
    const controlsContentDiv = document.getElementById('controls-content');
    const threejsContainer = document.getElementById('threejs-container');

    if (!machineControlsContainer || !controlsContentDiv || !threejsContainer) {
        console.error("Missing control panel elements in HTML.");
        return;
    }

    // Raycaster for detecting clicks on Three.js objects
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // Event listener for clicks on the Three.js container
    threejsContainer.addEventListener('click', (event) => {
        // Calculate pointer position in normalized device coordinates (-1 to +1)
        pointer.x = (event.clientX / threejsContainer.clientWidth) * 2 - 1;
        pointer.y = - (event.clientY / threejsContainer.clientHeight) * 2 + 1;

        raycaster.setFromCamera(pointer, camera);

        const intersects = raycaster.intersectObjects(draggableObjects, true); // Check all draggable objects and their children

        if (intersects.length > 0) {
            const intersectedObject = intersects[0].object;
            const rootMachineModel = getRootMachineModelFromIntersection(intersectedObject);

            if (rootMachineModel) {
                const machine = factoryManager.getMachineByName(rootMachineModel.name);
                if (machine) {
                    displayMachineControls(machine);
                }
            }
        } else {
            // Clicked outside any machine, hide controls
            hideMachineControls();
        }
    });

    function displayMachineControls(machine) {
        // Clear previous controls
        controlsContentDiv.innerHTML = '';
        if (currentMachineControlPanel) {
            // Before removing, if it was a Conveyor, clear its onColorDataUpdate callback
            const oldMachineName = currentMachineControlPanel.dataset.machineName;
            if (oldMachineName) {
                const oldMachine = factoryManager.getMachineByName(oldMachineName);
                if (oldMachine) {
                    if (oldMachine.config.type === 'Conveyor') {
                        oldMachine.onColorDataUpdate = null; // Deregister callback
                    } else if (oldMachine.config.type === 'Crane') {
                        // Deregister crane motor update callbacks
                        oldMachine.onM0Update = null;
                        oldMachine.onM1Update = null;
                        oldMachine.onM2Update = null;
                        // Destroy the Chart.js instances if they exist
                        const m0ChartInstance = craneCharts.get(`${oldMachine.name}-m0`);
                        if (m0ChartInstance) {
                            m0ChartInstance.destroy();
                            craneCharts.delete(`${oldMachine.name}-m0`);
                        }
                        const m1ChartInstance = craneCharts.get(`${oldMachine.name}-m1`);
                        if (m1ChartInstance) {
                            m1ChartInstance.destroy();
                            craneCharts.delete(`${oldMachine.name}-m1`);
                        }
                        const m2ChartInstance = craneCharts.get(`${oldMachine.name}-m2`);
                        if (m2ChartInstance) {
                            m2ChartInstance.destroy();
                            craneCharts.delete(`${oldMachine.name}-m2`);
                        }
                    }
                }
            }
            currentMachineControlPanel.remove();
            currentMachineControlPanel = null;
        }

        let template;
        if (machine.config.type === 'Conveyor') {
            template = document.getElementById('conveyor-control-template');
        } else if (machine.config.type === 'Crane') {
            template = document.getElementById('crane-control-template');
        }

        if (template) {
            const clone = document.importNode(template.content, true);
            const panel = clone.querySelector('.machine-control-panel');
            panel.dataset.machineName = machine.name;
            panel.querySelector('.machine-name-display').innerText = machine.name;

            if (machine.config.type === 'Conveyor') {
                const slider = panel.querySelector('.conveyor-slider');
                const display = panel.querySelector('.conveyor-position-display');
                const moveBtn = panel.querySelector('.conveyor-move-btn');

                // Color sensor display elements
                const colorSensorDisplayDiv = panel.querySelector('.color-sensor-display');
                const colorRDisplay = panel.querySelector('.color-r-display');
                const colorGDisplay = panel.querySelector('.color-g-display');
                const colorBDisplay = panel.querySelector('.color-b-display');
                const colorCDisplay = panel.querySelector('.color-c-display');
                const sensorStatusDisplay = panel.querySelector('.sensor-status-display');

                slider.addEventListener('input', () => {
                    display.innerText = `${slider.value} cm`;
                });

                moveBtn.addEventListener('click', () => {
                    const positionCm = parseFloat(slider.value);
                    const topic = machine.config.topics?.control;
                    if (topic) {
                        // Conveyor expects JSON: {"command": "MOVE_REL", "value": <cm>}
                        publishMqttMessage(topic, { command: 'MOVE_REL', value: positionCm });
                    } else {
                        console.warn(`Conveyor ${machine.name} has no control topic defined.`);
                    }
                });

                // Feeder servo control button
                const feederFeedBtn = panel.querySelector('.feeder-feed-btn');
                if (feederFeedBtn) {
                    feederFeedBtn.addEventListener('click', () => {
                        const topic = machine.config.topics?.control;
                        if (topic) {
                            // Conveyor expects JSON: {"command": "FEED_BLOCK"}
                            publishMqttMessage(topic, { command: 'FEED_BLOCK' });
                        } else {
                            console.warn(`Conveyor ${machine.name} has no control topic defined.`);
                        }
                    });
                }

                // Register callback for color data updates
                machine.onColorDataUpdate = (colorData) => {
                    if (colorData.sensor_ok && (colorData.r !== 0 || colorData.g !== 0 || colorData.b !== 0 || colorData.c !== 0)) {
                        colorRDisplay.innerText = colorData.r;
                        colorGDisplay.innerText = colorData.g;
                        colorBDisplay.innerText = colorData.b;
                        colorCDisplay.innerText = colorData.c;
                        sensorStatusDisplay.innerText = 'Senzor: OK';
                        colorSensorDisplayDiv.style.display = 'flex'; // Show the display
                    } else {
                        // Hide if sensor not OK or all values are zero
                        colorRDisplay.innerText = 0;
                        colorGDisplay.innerText = 0;
                        colorBDisplay.innerText = 0;
                        colorCDisplay.innerText = 0;
                        sensorStatusDisplay.innerText = colorData.sensor_ok ? 'Senzor: OK (ni zaznave)' : 'Senzor: Ni na voljo';
                        colorSensorDisplayDiv.style.display = 'none'; // Hide the display
                    }
                };

                // Immediately update with current data if available
                machine.onColorDataUpdate(machine.colorData);

            } else if (machine.config.type === 'Crane') {
                const m0Slider = panel.querySelector('.crane-m0-slider');
                const m0Display = panel.querySelector('.crane-m0-display');
                const m1Slider = panel.querySelector('.crane-m1-slider');
                const m1Display = panel.querySelector('.crane-m1-display');
                const m2Slider = panel.querySelector('.crane-m2-slider');
                const m2Display = panel.querySelector('.crane-m2-display');
                const moveBtn = panel.querySelector('.crane-move-btn');

                // Set initial values from machine state
                const initialMotorPositions = machine.currentMotorPositions || { m0: 0, m1: 0, m2: 0 };
                m0Slider.value = initialMotorPositions.m0;
                m0Display.innerText = `${initialMotorPositions.m0}°`;
                m1Slider.value = initialMotorPositions.m1;
                m1Display.innerText = `${initialMotorPositions.m1.toFixed(1)} cm`;
                m2Slider.value = initialMotorPositions.m2;
                m2Display.innerText = `${initialMotorPositions.m2.toFixed(1)} cm`;

                // Initialize last command values if not already set (e.g., on first display)
                if (machine.lastM0Command === undefined) {
                    machine.lastM0Command = initialMotorPositions.m0;
                }
                if (machine.lastM1Command === undefined) {
                    machine.lastM1Command = initialMotorPositions.m1;
                }
                if (machine.lastM2Command === undefined) {
                    machine.lastM2Command = initialMotorPositions.m2;
                }

                m0Slider.addEventListener('input', () => { m0Display.innerText = `${m0Slider.value}°`; });
                m1Slider.addEventListener('input', () => { m1Display.innerText = `${parseFloat(m1Slider.value).toFixed(1)} cm`; });
                m2Slider.addEventListener('input', () => { m2Display.innerText = `${parseFloat(m2Slider.value).toFixed(1)} cm`; });

                moveBtn.addEventListener('click', () => {
                    const m0Pos = parseFloat(m0Slider.value);
                    const m1Pos = parseFloat(m1Slider.value);
                    const m2Pos = parseFloat(m2Slider.value);

                    const topic = machine.config.topics?.control;
                    if (topic) {
                        // Crane expects JSON: {"command": "move_all", "motors": [{"id": 0, "pos": <val>}, ...]}
                        publishMqttMessage(topic, {
                            command: 'move_all',
                            motors: [
                                { id: 0, pos: m0Pos }, // Motor 0 (rokaM0.ino) expects degrees
                                { id: 1, pos: m1Pos }, // Motor 1 (roka.ino) expects cm
                                { id: 2, pos: m2Pos }  // Motor 2 (roka.ino) expects cm
                            ]
                        });
                        // Store the last sent motor commands
                        machine.lastM0Command = m0Pos;
                        machine.lastM1Command = m1Pos;
                        machine.lastM2Command = m2Pos;
                    } else {
                        console.warn(`Crane ${machine.name} has no control topic defined.`);
                    }
                });

                const magnetOnBtn = panel.querySelector('.crane-magnet-on-btn');
                const magnetOffBtn = panel.querySelector('.crane-magnet-off-btn');

                magnetOnBtn.addEventListener('click', () => {
                    const topic = machine.config.topics?.control;
                    if (topic) {
                        publishMqttMessage(topic, { command: 'set_magnet', state: 1 });
                    } else {
                        console.warn(`Crane ${machine.name} has no control topic defined.`);
                    }
                });

                magnetOffBtn.addEventListener('click', () => {
                    const topic = machine.config.topics?.control;
                    if (topic) {
                        publishMqttMessage(topic, { command: 'set_magnet', state: 0 });
                    } else {
                        console.warn(`Crane ${machine.name} has no control topic defined.`);
                    }
                });

                // Chart.js integration for Crane M0, M1, M2
                const setupMotorChart = (motorIndex, labelUnit, yMin, yMax, chartClass, lastCommandProp, onUpdateProp) => {
                    const chartCanvas = panel.querySelector(chartClass);
                    if (chartCanvas) {
                        const ctx = chartCanvas.getContext('2d');
                        const chart = new Chart(ctx, {
                            type: 'line',
                            data: {
                                labels: [], // Time labels
                                datasets: [{
                                    label: `Motor ${motorIndex} (${labelUnit}) - Dejanska vrednost`,
                                    data: [], // Motor values from MCU
                                    borderColor: 'rgb(75, 192, 192)',
                                    tension: 0.1,
                                    fill: false
                                },
                                {
                                    label: `Motor ${motorIndex} (${labelUnit}) - Željena vrednost`,
                                    data: [], // Motor command values
                                    borderColor: 'rgb(255, 99, 132)', // Red color for commands
                                    tension: 0, // Set tension to 0 for straight lines
                                    stepped: true, // Enable stepped line
                                    fill: false,
                                    pointRadius: 0 // Remove points from the line
                                }]
                            },
                            options: {
                                animation: false, // Disable animation for real-time updates
                                scales: {
                                    x: {
                                        title: {
                                            display: true,
                                            text: 'Čas'
                                        }
                                    },
                                    y: {
                                        title: {
                                            display: true,
                                            text: labelUnit
                                        },
                                        min: yMin,
                                        max: yMax
                                    }
                                }
                            }
                        });
                        craneCharts.set(`${machine.name}-m${motorIndex}`, chart);

                        // Register callback for motor data updates
                        machine[onUpdateProp] = (motorValue) => {
                            const currentChart = craneCharts.get(`${machine.name}-m${motorIndex}`);
                            if (currentChart) {
                                const now = new Date();
                                const timeLabel = now.toLocaleTimeString(); // e.g., "10:30:45 AM"
                                const maxDataPoints = 50;

                                // Update labels and MCU data (dataset 0)
                                if (currentChart.data.labels.length >= maxDataPoints) {
                                    currentChart.data.labels.shift();
                                    currentChart.data.datasets[0].data.shift();
                                }
                                currentChart.data.labels.push(timeLabel);
                                currentChart.data.datasets[0].data.push(motorValue);

                                // Update command data (dataset 1)
                                if (currentChart.data.labels.length >= maxDataPoints) {
                                    currentChart.data.datasets[1].data.shift(); // Shift command data
                                }
                                currentChart.data.datasets[1].data.push(machine[lastCommandProp] !== undefined ? machine[lastCommandProp] : motorValue);

                                currentChart.update();
                            }
                        };
                        // Immediately update with current data if available
                        machine[onUpdateProp](machine.currentMotorPositions[`m${motorIndex}`]);
                    } else {
                        console.warn(`Crane ${machine.name}: M${motorIndex} chart canvas not found.`);
                    }
                };

                setupMotorChart(0, 'stopinje', -180, 180, '.crane-m0-chart', 'lastM0Command', 'onM0Update');
                setupMotorChart(1, 'cm', 0, 17.5, '.crane-m1-chart', 'lastM1Command', 'onM1Update');
                setupMotorChart(2, 'cm', 0, 8.5, '.crane-m2-chart', 'lastM2Command', 'onM2Update');

                // Add event listeners for dropdown buttons
                panel.querySelectorAll('.chart-dropdown-button').forEach(button => {
                    button.addEventListener('click', (event) => {
                        const targetId = event.target.dataset.chartTarget;
                        const targetContent = panel.querySelector(`#${targetId}`);
                        if (targetContent) {
                            targetContent.classList.toggle('show');
                        }
                    });
                });
            }
 
              controlsContentDiv.appendChild(panel);
              machineControlsContainer.style.display = 'block'; // Show the control panel
              currentMachineControlPanel = panel;
          } else {
              console.warn(`No control template found for machine type: ${machine.config.type}`);
              hideMachineControls();
          }
      }

    function hideMachineControls() {
        machineControlsContainer.style.display = 'none';
        controlsContentDiv.innerHTML = '';
        currentMachineControlPanel = null;
    }
}

// --- Function to Add Machine from Menu ---
// --- Funkcija za dodajanje stroja iz menija ---
async function promptForTopicsAndAdd(type) {
    let topics = {};

    // --- Prilagodi pozive glede na tip stroja ---
    if (type === 'Conveyor') {
        const stateTopic = prompt(`Enter MQTT topic for ${type} state/position (e.g., assemblyline/conveyor/state):`);
        if (!stateTopic) {
            console.log("Add Conveyor cancelled.");
            return;
        }
        topics.state = stateTopic;

        const controlTopic = prompt(`Enter MQTT topic for ${type} commands (e.g., assemblyline/conveyor/command):`);
        if (!controlTopic) {
            console.log("Add Conveyor cancelled (missing control topic).");
            return;
        }
        topics.control = controlTopic; // Store control topic under 'topics' for simplicity

    } else if (type === 'Crane') {
        const motorStateTopic = prompt(`Enter MQTT topic for ${type} motor state (e.g., assemblyline/crane/motor_state):`);
         if (!motorStateTopic) {
            console.log("Add Crane cancelled.");
            return;
        }
        topics.motor_state = motorStateTopic;

        const controlTopic = prompt(`Enter MQTT topic for ${type} commands (e.g., assemblyline/crane/command):`);
        if (!controlTopic) {
            console.log("Add Crane cancelled (missing control topic).");
            return;
        }
        topics.control = controlTopic; // Store control topic under 'topics' for simplicity
    }

    // Find the blueprint configuration from the original layout array
    // Note: The blueprint itself might have topics defined, but we'll override with user input.
    const blueprint = factoryLayout.find(item => item.type === type);
    if (!blueprint) {
        console.error(`Cannot find blueprint config for type: ${type}`);
        return;
    }

    // Create a config for the new instance
    let newName;
    let count;
    if (type === 'Conveyor') {
        conveyorCount++;
        newName = `conveyor-${conveyorCount}`;
    } else if (type === 'Crane') {
        craneCount++;
        newName = `crane-${craneCount}`;
    } else {
        // Handle other types or default naming
        newName = `${type.toLowerCase()}-${Date.now()}`; // Enostavno unikatno ime
    }

    // Calculate a unique starting grid position to avoid overlap
    // This is a simple strategy: stagger X based on counts, keep Y somewhat central.
    // Adjust as needed for better initial placement.
    let initialGridX = 0;
    if (type === 'Conveyor') {
        initialGridX = (conveyorCount -1) % gridDivisions; // conveyorCount is already incremented
    } else if (type === 'Crane') {
        initialGridX = (craneCount -1) % gridDivisions; // craneCount is already incremented
    }
    // Offset cranes slightly in Y to further differentiate from conveyors if X values collide
    let initialGridY = Math.floor(gridDivisions / 2) + (type === 'Crane' ? 1 : 0);
    initialGridY = initialGridY % gridDivisions;

    const newInstanceConfig = {
        ...blueprint, // Kopiraj lastnosti iz načrta (modelPath itd.)
        name: newName,
        gridPos: { x: initialGridX, y: initialGridY }, // Postavi na novo mesto
        rotationY: 0, // Privzeta rotacija
        topics: topics // Dodeli teme, ki jih je vnesel uporabnik (zdaj vključuje control)
    };

    // Uporabi FactoryManager za dodajanje stroja
    const newMachineInstance = await factoryManager.addMachine(newInstanceConfig);

    if (newMachineInstance && newMachineInstance.model) {
        // Vedno dodaj model najvišje ravni na seznam vlečljivih objektov
        draggableObjects.unshift(newMachineInstance.model); // Dodaj na začetek


        // Ponovno inicializiraj DragControls, da zagotoviš prepoznavanje novega objekta
        setupDragControls();
    } else {
        console.error(`Failed to add machine ${newName} or its model was not loaded.`);
        // Zmanjšaj števec, če ustvarjanje ni uspelo
        if (type === 'Conveyor') conveyorCount--;
        if (type === 'Crane') craneCount--;
    }
}

// --- Funkcija za izvoz postavitve v JSON ---
function exportLayoutToJson() {
    if (factoryManager.machines.size === 0) {
        console.log("No machinesw to export. Downloading empty layout.");
        // Kljub temu prenesi prazen JSON polja za doslednost
    }
    const layoutToExport = [];
    for (const machine of factoryManager.machines.values()) {
        const machineConfig = {
            type: machine.config.type,
            name: machine.name, // Use the instance name
            modelPath: machine.config.modelPath,
            rotationY: machine.config.rotationY !== undefined ? machine.config.rotationY : 0,
            topics: machine.config.topics || {} // Now includes control topic
        };

        // Obravnavaj položaj glede na to, ali gre za običajen stroj ali podoben obdelovancu
        if (machine.config.initialGridPos) {
            machineConfig.initialGridPos = machine.config.initialGridPos;
        } else if (machine.config.gridPos) {
            machineConfig.gridPos = machine.config.gridPos;
        } else {
            // This case should ideally not be hit for machines added via UI or valid JSON
            // Fallback if neither is present, though one should be
            machineConfig.gridPos = { x: 0, y: 0 };
            console.warn(`Machine ${machine.name} has no gridPos or initialGridPos in its config.`);
        }

        layoutToExport.push(machineConfig);
    }

    const jsonString = JSON.stringify(layoutToExport, null, 2); // Lep izpis
    const blob = new Blob([jsonString], { type: 'application/json' }); // Ustvari Blob
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'factory_layout.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url); // Ohrani to vrstico
    console.log("Layout exported.");
}

// --- Funkcija za uvoz postavitve iz JSON ---
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('import-layout-file');
    if (fileInput) {
        fileInput.addEventListener('change', handleJsonFileImport);
    } else {
        console.warn("File input #import-layout-file not found for JSON import.");
    }
});

async function handleJsonFileImport(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const importedLayout = JSON.parse(e.target.result);
            if (!Array.isArray(importedLayout)) {
                throw new Error("Imported JSON is not an array.");
            }

            // 1. Počisti obstoječe stroje in stanje tovarne
            // Odstrani modele iz scene in zavrzi kontrole vlečenja
            draggableObjects.forEach(obj => scene.remove(obj));
            draggableObjects.length = 0; // Počisti polje
            if (dragControlsInstance) {
                dragControlsInstance.dispose();
                dragControlsInstance = null;
            }

            await factoryManager.reset(); // Ponastavi stroje, topicMap in MQTT naročnine

            // Ponastavi števce (preprost pristop, lahko bi bil bolj robusten s preverjanjem največjih uvoženih številk)
            conveyorCount = 0;
            craneCount = 0;

            // 2. Naloži stroje iz uvožene postavitve
            for (const machineConfig of importedLayout) {
                const newMachineInstance = await factoryManager.addMachine(machineConfig);
                if (newMachineInstance && newMachineInstance.model) {
                    draggableObjects.push(newMachineInstance.model);

                    // Posodobi števce na podlagi uvoženih imen, da se izogneš prihodnjim trkom
                    if (machineConfig.type === 'Conveyor' && machineConfig.name.startsWith('conveyor-')) {
                        const num = parseInt(machineConfig.name.split('-')[1]);
                        if (!isNaN(num) && num > conveyorCount) conveyorCount = num;
                    } else if (machineConfig.type === 'Crane' && machineConfig.name.startsWith('crane-')) {
                        const num = parseInt(machineConfig.name.split('-')[1]);
                        if (!isNaN(num) && num > craneCount) craneCount = num;
                    }
                } else {
                    console.warn(`Failed to add machine from imported config: ${machineConfig.name}`);
                }
            }

            setupDragControls(); // Ponovno inicializiraj kontrole vlečenja z novimi objekti

        } catch (error) {
            console.error("Error importing layout from JSON:", error);
            alert(`Error importing layout: ${error.message}`);
        } finally {
            event.target.value = null; // Ponastavi vnos datoteke
        }
    };
    reader.readAsText(file);
}

// --- Automation Control Logic ---
function setupAutomationControls() {
    const programSelect = document.getElementById('program-select');
    const startProgramBtn = document.getElementById('start-program-btn');
    const stopProgramBtn = document.getElementById('stop-program-btn');
    const automationStatusElement = document.getElementById('automation-status');

    if (!programSelect || !startProgramBtn || !stopProgramBtn || !automationStatusElement) {
        console.error("Missing automation control elements in HTML.");
        return;
    }

    // Populate dropdown (currently hardcoded, but could be dynamic from server)
    // The option is already in index.html, so no need to add dynamically for now.
    // If we add more programs to FactoryAutomation.js, we'd fetch them here.
 
    // Add event listener for program selection change
    programSelect.addEventListener('change', () => {
        const selectedProgram = programSelect.value;
        if (socket && socket.connected) {
            socket.emit('switch_program', { programName: selectedProgram });
            console.log(`Sent 'switch_program' for: ${selectedProgram}`);
        } else {
            console.warn('Socket.IO client not connected. Cannot switch program.');
        }
    });

    startProgramBtn.addEventListener('click', () => {
        const selectedProgram = programSelect.value;
        if (socket && socket.connected) {
            socket.emit('start_program', { programName: selectedProgram });
            console.log(`Sent 'start_program' for: ${selectedProgram}`);
        } else {
            console.warn('Socket.IO client not connected. Cannot start program.');
        }
    });
 
    stopProgramBtn.addEventListener('click', () => {
        if (socket && socket.connected) {
            socket.emit('stop_program');
            console.log('Sent \'stop_program\'');
        } else {
            console.warn('Socket.IO client not connected. Cannot stop program.');
        }
    });
}


// --- Zanka animacije ---
const clock = new THREE.Clock(); // Ura za delta čas
function animate() {
    requestAnimationFrame(animate);
    const deltaTime = clock.getDelta();

    controls.update();
    factoryManager.update(deltaTime); // Posodobi stroje (za potencialne animacije)

    renderer.render(scene, camera);
}

// --- Kontrole tipkovnice za rotacijo ---
window.addEventListener('keydown', (event) => {
    if (event.key === 'r' || event.key === 'R') {
        if (selectedObject) { // Rotiraj samo, če je objekt trenutno izbran (se vleče)
            // Rotiraj izbrani objekt (ki je vedno korenski model)
            selectedObject.rotation.y += Math.PI / 2; // Rotiraj za 90 stopinj
            // Zagotovi, da rotacija ostane v območju od 0 do 2*PI (izbirno)
            selectedObject.rotation.y %= (2 * Math.PI);

            // --- Posodobi logično rotacijo stroja ---
            const machine = factoryManager.getMachineByName(selectedObject.name); // Uporabi ime objekta
            if (machine?.config) { // Preveri, ali stroj in konfiguracija obstajata
                machine.config.rotationY = selectedObject.rotation.y;
                // console.log(`[DEBUG Rotate] Updated ${machine.name} machine.config.rotationY to: ${machine.config.rotationY}`); // Odstranjeno za končno verzijo
            }
        } else {
            console.log("Press 'R' while dragging an object to rotate it.");
        }
    }
});
