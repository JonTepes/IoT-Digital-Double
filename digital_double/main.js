import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragControls } from 'three/addons/controls/DragControls.js'; // Uvoz DragControls
import { FactoryManager } from './FactoryManager.js'; // Uvoz upravitelja
import { factoryLayout } from './FactoryLayout.js'; // Uvoz konfiguracije postavitve

console.log("Script starting...");

// --- Globalne spremenljivke ---
const mqttBrokerUrl = 'ws://86.61.17.115:9001';

// --- Nastavitev scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xCFE2F3);

// --- Nastavitev kamere ---
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(5, 5, 5); // Kamera premaknjena bližje (povečano)
camera.lookAt(0, 0, 0); // Ohrani pogled usmerjen v središče

// --- Nastavitev izrisovalnika ---
const canvas = document.getElementById('webgl');
if (!canvas) console.error("Canvas element #webgl not found!");
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// --- Obravnava spremembe velikosti okna ---
window.addEventListener('resize', () => {
    // Posodobi kamero
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    // Posodobi izrisovalnik
    renderer.setSize(window.innerWidth, window.innerHeight);
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
const gridUnitSizeCm = 5; // Each grid square represents 5cm x 5cm
const threeUnitsPerGridUnit = 1;
const unitsPerCm = threeUnitsPerGridUnit / gridUnitSizeCm; // Calculate Three.js units per centimeter
const gridDivisions = 10; // Make it a 10x10 grid
const gridSize = gridDivisions * threeUnitsPerGridUnit;

const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x888888, 0xcccccc);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

// --- Kontrole kamere (OrbitControls) --- <<< Mora biti definirano *pred* DragControls, če si delita DOM element
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
const factoryManager = new FactoryManager(scene, gridToWorld, factoryLayout, mqttBrokerUrl, unitsPerCm); // Posreduj unitsPerCm

// Inicializiraj tovarno (naloži modele, poveže se z MQTT)
// Uporabi asinhrono IIFE (Immediately Invoked Function Expression) za obravnavo asinhrone inicializacije
let draggableObjects = []; // Polje za shranjevanje modelov, ki jih je mogoče vleči
let dragControlsInstance = null; // Za shranjevanje instance DragControls
let selectedObject = null; // Za sledenje objektu, ki se vleče/izbira
let clickOffsetFromRoot_world = new THREE.Vector3(); // Svetovni odmik od izvora korenskega modela do dejanske točke klika
let conveyorCount = 0; // Števec za unikatna imena tekočih trakov
let dragControlsInstanceId = 0; // Števec za instance DragControls za odpravljanje napak
let craneCount = 0;    // Števec za unikatna imena dvigal
let boxHelpers = []; // Za shranjevanje BoxHelpers za posodabljanje

// Počakaj, da se DOM v celoti naloži, preden se izvede glavna logika
document.addEventListener('DOMContentLoaded', () => {
    // Odstranjeno: poslušalec pointermove za ročno vlečenje

    (async () => {
        try {
            // Initialize manager (connects MQTT, etc., but doesn't load models)
            await factoryManager.initialize();

            // Setup drag controls (will initially have an empty array)
            setupDragControls();
            // Nastavi poslušalce gumbov uporabniškega vmesnika - ZDAJ varno za klic, ker je DOM pripravljen
            setupMenuButtons();

            if (canvas) { // Check canvas again just in case
                animate();
                console.log("Animation loop started after factory initialization.");
            } else {
                console.error("Cannot start animation loop, canvas not found.");
            }
        } catch (error) {
            console.error("Failed to initialize the factory:", error);
        }
    })();
});

// Pomožna funkcija za iskanje korenskega modela stroja iz presečenega objekta.
// Korenski model mora biti eden od objektov neposredno v polju draggableObjects.
function getRootMachineModelFromIntersection(intersectedObject) {
    let current = intersectedObject;
    let depth = 0; // Za preprečevanje potencialnih neskončnih zank v kompleksnih/pokvarjenih hierarhijah
    while (current && depth < 10) { // Max search depth of 10
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
            console.log(`[getRootMachineModelFromIntersection]   No more valid parents for ${current.name}. Stopping search.`);
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

// --- Function to Add Machine from Menu ---
// --- Funkcija za dodajanje stroja iz menija ---
async function promptForTopicsAndAdd(type) {
    let topics = {};

    // --- Prilagodi pozive glede na tip stroja ---
    if (type === 'Conveyor') {
        const stateTopic = prompt(`Enter MQTT topic for ${type} state/position (e.g., assemblyline/conveyor/state):`);
        if (!stateTopic) { // Obravnavaj preklic ali prazen vnos
            console.log("Add Conveyor cancelled.");
            return;
        }
        topics.state = stateTopic; // Dodeli ključu, na katerega se lahko kasneje sklicujemo
    } else if (type === 'Crane') {
        const motorStateTopic = prompt(`Enter MQTT topic for ${type} motor state (e.g., assemblyline/crane/motor_state):`);
         if (!motorStateTopic) { // Obravnavaj preklic ali prazen vnos
            console.log("Add Crane cancelled.");
            return;
        }
        topics.motor_state = motorStateTopic; // Dodeli ključu
        // Tukaj dodaj več pozivov, če dvigalo potrebuje druge teme (npr. položaj)
        // const positionTopic = prompt(...);
        // if (positionTopic) topics.position = positionTopic;
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
        topics: topics, // Dodeli teme, ki jih je vnesel uporabnik
        controlTopics: {} // Ohrani ločeno, če je potrebno, ali združi logiko
    };

    // Uporabi FactoryManager za dodajanje stroja
    const newMachineInstance = await factoryManager.addMachine(newInstanceConfig);

    if (newMachineInstance && newMachineInstance.model) {
        // Vedno dodaj model najvišje ravni na seznam vlečljivih objektov
        draggableObjects.unshift(newMachineInstance.model); // Dodaj na začetek

        // --- DODAJ POMOČNIKA ZA OMEJEVALNO POLJE ZA ODPRAVLJANJE NAPAK ---
        const boxColor = (type === 'Crane') ? 0x0000ff : 0xff0000; // Modra za dvigalo, rdeča za ostale
        const boxHelper = new THREE.BoxHelper(newMachineInstance.model, boxColor);
        scene.add(boxHelper);
        boxHelpers.push(boxHelper); // Shrani za posodabljanje v zanki animacije
        // --- KONEC POMOČNIKA ZA OMEJEVALNO POLJE ---

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
            topics: machine.config.topics || {},
            controlTopics: machine.config.controlTopics || {}
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
            // Počisti pomožnike za polja iz scene in polja
            boxHelpers.forEach(helper => scene.remove(helper));
            boxHelpers.length = 0;

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

// --- Zanka animacije ---
const clock = new THREE.Clock(); // Ura za delta čas
function animate() {
    requestAnimationFrame(animate);
    const deltaTime = clock.getDelta();

    controls.update();
    factoryManager.update(deltaTime); // Posodobi stroje (za potencialne animacije)

    // Update BoxHelpers
    for (const helper of boxHelpers) {
        helper.update();
    }
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
