const OBJECT_PRESENT_THRESHOLD = 150; // Objekt je PRISOTEN, če je color_c > te vrednosti
// Pragovi za zaznavanje barv na podlagi RGB vrednosti
const BLUE_THRESHOLD_B_MIN = 40; // Minimalna modra komponenta za moder blok
const BLUE_THRESHOLD_RG_MAX = 75; // Maksimalne rdeče/zelene komponente za moder blok
const YELLOW_THRESHOLD_RG_MIN = 50; // Minimalne rdeče/zelene komponente za rumen blok
const YELLOW_THRESHOLD_B_MAX = 45; // Maksimalna modra komponenta za rumen blok

class ColorSortingCycle {
    constructor(factoryAutomationInstance) {
        this.fa = factoryAutomationInstance; // Referenca na instanco FactoryAutomation
        this.blockColor = null; // Za shranjevanje zaznane barve bloka ('modra', 'rumena', 'neznana')
    }

    handleMqttMessage(topic, message) {
        // Vratarji so obravnavani v FactoryAutomation.js pred klicem te metode.
        // Ta metoda vsebuje samo logiko stroja stanj za osnovni cikel.

        let command_msg = null;
        let payload;
        try {
            payload = JSON.parse(message);
        } catch (e) {
            payload = message; // Obravnavajte sporočila, ki niso JSON (npr. "STOP 0")
        }

        console.log(`RUNNING | State: ${this.fa.automationState}`);
        switch (this.fa.automationState) {
            // --- Zaporedje podajalnika ---
            case 'FEEDER_ACTIVATING':
                console.warn("Activating feeder to move block onto conveyor.");
                this.fa.automationState = 'WAITING_FOR_FEEDER_COMPLETE';
                command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "FEED_BLOCK" } };
                break;

            case 'WAITING_FOR_FEEDER_COMPLETE':
                // Dejanje podajalnika je hitro in nima ločene teme stanja.
                // Predvidevamo, da je dokončano po poslanem ukazu in kratki zamudi.
                // Prehod nazaj v IDLE za preverjanje senzorja transporterja za nov blok.
                console.warn("Feeder moved block. Transitioning to IDLE to check conveyor sensor.");
                this.fa.automationState = 'IDLE';
                // Brez ukaza, samo prehod stanja
                break;

            // --- Zaporedje podajalnika ---

            // --- Zaporedje transporterja 1 ---
            case 'IDLE':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok) {
                    if (payload.color_c <= OBJECT_PRESENT_THRESHOLD) {
                        console.warn(`Sensor is clear (c=${payload.color_c}). Starting conveyor 1.`);
                        this.fa.automationState = 'WAITING_FOR_OBJECT';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_REL", value: 1000 } };
                    } else {
                        let currentPos = payload.position;
                        let targetPos = currentPos + 4.5;
                        console.warn(`Object already present (c=${payload.color_c}). Moving to pickup pos: ${targetPos}cm.`);
                        this.fa.conveyor1PickupPos = targetPos;
                        this.fa.automationState = 'CONVEYOR1_MOVING_WITH_OBJECT';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                        // Zahtevajte posodobitev stanja po zamudi, da dobite stabilne barvne vrednosti med premikanjem
                        setTimeout(() => {
                            this.fa.publishMqttCommand('assemblyline/conveyor/command', { command: "GET_STATE" });
                        }, 500); // 500ms zamude
                    }
                }
                break;

            case 'WAITING_FOR_OBJECT':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok && payload.color_c > OBJECT_PRESENT_THRESHOLD) {
                    let currentPos = payload.position;
                    let targetPos = currentPos + 4.5;
                    console.warn(`Object detected at ${currentPos}cm (c=${payload.color_c}). Moving to calculated pickup position: ${targetPos}cm.`);
                    this.fa.conveyor1PickupPos = targetPos;
                    this.fa.automationState = 'CONVEYOR1_MOVING_WITH_OBJECT';
                    command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                    // Zahtevajte posodobitev stanja po zamudi, da dobite stabilne barvne vrednosti med premikanjem
                    setTimeout(() => {
                        this.fa.publishMqttCommand('assemblyline/conveyor/command', { command: "GET_STATE" });
                    }, 500); // 500ms zamude
                }
                break;

            case 'CONVEYOR1_MOVING_WITH_OBJECT':
                // To stanje se vnese po zaznavi bloka in začetku premikanja transporterja.
                // Pričakujemo odgovor GET_STATE po 0.5s zamude.
                if (topic === 'assemblyline/conveyor/state' && payload.status === 'MOVING' && payload.color_r !== undefined) {
                    console.warn(`Received color reading while moving (R:${payload.color_r}, G:${payload.color_g}, B:${payload.color_b}, C:${payload.color_c}).`);
                    this.fa.currentBlockR = payload.color_r;
                    this.fa.currentBlockG = payload.color_g;
                    this.fa.currentBlockB = payload.color_b;
                    this.fa.currentBlockC = payload.color_c;

                    if (payload.color_b > BLUE_THRESHOLD_B_MIN && payload.color_r < BLUE_THRESHOLD_RG_MAX && payload.color_g < BLUE_THRESHOLD_RG_MAX) {
                        this.blockColor = 'blue';
                        console.warn("Detected: Blue block.");
                    } else if (payload.color_r > YELLOW_THRESHOLD_RG_MIN && payload.color_g > YELLOW_THRESHOLD_RG_MIN && payload.color_b < YELLOW_THRESHOLD_B_MAX) {
                        this.blockColor = 'yellow';
                        console.warn("Detected: Yellow block.");
                    } else {
                        this.blockColor = 'unknown';
                        console.warn(`Detected: Unknown block color (R:${payload.color_r}, G:${payload.color_g}, B:${payload.color_b}, C:${payload.color_c}).`);
                    }
                    this.fa.automationState = 'CONVEYOR1_MOVING_TO_PICKUP'; // Prehod v naslednje stanje
                    this.fa.updateUiStatus(); // Posodobite UI po zaznavi barve
                }
                break;

            case 'CONVEYOR1_MOVING_TO_PICKUP':
                if (topic === 'assemblyline/conveyor/state' && payload.status === 'IDLE') {
                    // Predpostavljamo, da se transporter vedno ustavi na pravi poziciji po navodilih uporabnika
                    console.warn(`Conveyor at pickup position. Starting crane sequence.`);
                    this.fa.automationState = 'CRANE_MOVING_TO_PICKUP_XY';
                    this.fa.craneMotorStatus = { m0: false, m1: false, m2: true }; // m2 je true, ker se še ne premika
                    const cmd_m0 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: -35.0 }] }) };
                    const cmd_m1 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 7.7 }] }) };
                    command_msg = [cmd_m0, cmd_m1]; // Pošljite več ukazov
                }
                break;

            // --- Prvi prevzem/odlaganje žerjava ---
            case 'CRANE_MOVING_TO_PICKUP_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.fa.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.fa.craneMotorStatus.m0 && this.fa.craneMotorStatus.m1) {
                        console.warn("Crane at pickup X/Y. Lowering to pickup Z.");
                        this.fa.automationState = 'CRANE_MOVING_TO_PICKUP_Z';
                        command_msg = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 6.5 }] }) };
                    }
                }
                break;

            case 'CRANE_MOVING_TO_PICKUP_Z':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    console.warn("Crane at pickup Z. Activating magnet.");
                    this.fa.automationState = 'ACTIVATING_MAGNET';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 1 }) };
                }
                break;

            case 'ACTIVATING_MAGNET':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 1) {
                    console.warn(`Magnet ON. Raising to safe height.`);
                    this.fa.automationState = 'CRANE_RAISING_TO_SAFE_HEIGHT';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 1.5 }] }) };
                }
                break;

            case 'CRANE_RAISING_TO_SAFE_HEIGHT':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    this.fa.craneMotorStatus = { m0: false, m1: false, m2: true };
                    if (this.blockColor === 'blue') {
                        console.warn("Blue block detected. Moving to blue block dropoff X/Y.");
                        this.fa.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                        const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: 52.5 }] }) };
                        const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 12.0 }] }) };
                        command_msg = [cmd_m0_d, cmd_m1_d];
                    } else if (this.blockColor === 'yellow') {
                        console.warn("Yellow block detected. Moving to yellow block dropoff X/Y.");
                        this.fa.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                        const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: -90.0 }] }) };
                        const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 10.0 }] }) };
                        command_msg = [cmd_m0_d, cmd_m1_d];
                    } else {
                        console.warn(`Unknown block color (${this.blockColor}). Defaulting to blue block dropoff.`);
                        this.fa.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                        const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: 52.5 }] }) };
                        const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 12.0 }] }) };
                        command_msg = [cmd_m0_d, cmd_m1_d];
                    }
                }
                break;

            case 'CRANE_MOVING_TO_DROPOFF_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.fa.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.fa.craneMotorStatus.m0 && this.fa.craneMotorStatus.m1) {
                        console.warn(`Crane at dropoff X/Y. Deactivating magnet.`);
                        this.fa.automationState = 'DEACTIVATING_MAGNET_FIRST_TIME';
                        command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 0 }) };
                    }
                }
                break;

            case 'DEACTIVATING_MAGNET_FIRST_TIME':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 0) {
                    console.warn(`Magnet OFF. Moving conveyor 2.`);
                    this.fa.automationState = 'CONVEYOR2_MOVING';
                    command_msg = { topic: 'assemblyline/conveyor2/command', payload: { command: "MOVE_REL", value: -9.0 } };
                }
                break;

            // --- Končni korak in zanka ---
            case 'CONVEYOR2_MOVING':
                if (topic === 'assemblyline/conveyor2/state' && payload.status === 'IDLE') {
                    console.warn("Cycle complete. Resetting to FEEDER_ACTIVATING.");
                    this.fa.automationState = 'FEEDER_ACTIVATING'; // Zanka nazaj na aktivacijo podajalnika
                    this.blockColor = null; // Ponastavite barvo bloka za naslednji cikel
                    this.fa.currentBlockR = 'none';
                    this.fa.currentBlockG = 'none';
                    this.fa.currentBlockB = 'none';
                    this.fa.currentBlockC = 'none';
                    this.fa.updateUiStatus(); // Posodobite UI po ponastavitvi vrednosti
                    // Ni ukaza za pošiljanje, samo sprožitev posodobitve UI in zamude
                    command_msg = { payload: "No command, just triggering UI update and delay" };
                }
                break;
        }

        // --- AKCIJA ---
        if (command_msg) {
            // Odločitev je bila sprejeta. Zaklenite poslušalca in pošljite ukaz(e).
            // Nastavite zaklep PRED pošiljanjem ukazov
            this.fa.commandSent = true;
            this.fa.updateUiStatus(); // Posodobite UI za prikaz stanja "ZAKLENJENO", če je primerno

            if (Array.isArray(command_msg)) {
                command_msg.forEach(cmd => {
                    this.fa.publishMqttCommand(cmd.topic, cmd.payload);
                });
            } else if (command_msg.topic) { // Preverite, ali gre za en sam objekt ukaza
                this.fa.publishMqttCommand(command_msg.topic, command_msg.payload);
            } else {
                // To je primer "Brez ukaza, samo sprožitev posodobitve UI in zamude"
                // Dejanski MQTT ukaz ni poslan, zato lahko odklenemo takoj ali po kratki zamudi UI.
                // Node-RED je imel tukaj zamudo, zato ohranimo majhno zamudo za doslednost.
                console.log("No MQTT command to send, but state transition occurred. Unlocking listener after delay.");
            }
            // Zaženite en sam časovnik za odklepanje poslušalca po inicializaciji vseh ukazov
            setTimeout(() => this.fa.unlockListener(), 1000); // 1000ms (1 sekunda) zamude, kot je bilo zahtevano
        }
    }
}

module.exports = ColorSortingCycle;