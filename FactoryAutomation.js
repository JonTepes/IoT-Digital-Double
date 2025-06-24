const BasicCycle = require('./automation_programs/BasicCycle');
const ColorSortingCycle = require('./automation_programs/ColorSortingCycle');

class FactoryAutomation {
    constructor(mqttClient, io) {
        this.mqttClient = mqttClient;
        this.io = io; // Instanca strežnika Socket.IO za posodobitve UI

        this.systemMode = 'STOPPED'; // 'USTAVLJENO', 'TEČE'
        this.automationState = 'IDLE'; // Trenutno stanje v avtomatizacijskem zaporedju
        this.commandSent = false; // Zaklep za preprečitev ponovnega vstopa med obdelavo ukaza
        this.craneMotorStatus = { m0: false, m1: false, m2: false }; // Za čakanje na več motorjev
        this.conveyor1PickupPos = 0; // Shrani izračunano pozicijo prevzema za transporter 1
        this.basicCycle = new BasicCycle(this);
        this.colorSortingCycle = new ColorSortingCycle(this);
        this.activeAutomationProgram = this.basicCycle; // Privzeto na BasicCycle
        this.selectedAutomationProgram = 'BasicCycle'; // Za sledenje aktivnemu programu

        this.currentBlockR = 'none';
        this.currentBlockG = 'none';
        this.currentBlockB = 'none';
        this.currentBlockC = 'none';

        this.setupMqttSubscriptions();
    }

    setupMqttSubscriptions() {
        // Naročite se na vse relevantne teme za stanje tovarne
        this.mqttClient.subscribe('assemblyline/conveyor/state');
        this.mqttClient.subscribe('assemblyline/conveyor2/state');
        this.mqttClient.subscribe('assemblyline/crane/motor_state');
        console.log('FactoryAutomation subscribed to MQTT topics.');
    }

    initialize() {
        this.systemMode = 'STOPPED';
        this.automationState = 'IDLE';
        this.commandSent = false;
        this.craneMotorStatus = { m0: false, m1: false, m2: false };
        this.updateUiStatus();
        console.log("Factory Automation Initialized.");
    }

    start() {
        if (this.systemMode === 'RUNNING') {
            console.log("System already RUNNING.");
            return;
        }
        this.systemMode = 'RUNNING';
        this.automationState = 'FEEDER_ACTIVATING'; // Začnite z aktivacijo podajalnika
        this.commandSent = false; // Zagotovite, da je zaklep izklopljen na začetku
        this.craneMotorStatus = { m0: false, m1: false, m2: false };
        console.log(`System START command received. Active program: ${this.selectedAutomationProgram}. Priming system by requesting conveyor state.`);
        this.updateUiStatus();

        // Pripravite sistem z zahtevo stanja transporterja, podobno kot Node-RED
        this.publishMqttCommand('assemblyline/conveyor/command', { command: "GET_STATE" });
    }

    stop() {
        this.systemMode = 'STOPPED';
        this.automationState = 'IDLE';
        this.commandSent = false; // POMEMBNO: Odklenite poslušalca
        console.log("System STOP command received. Halting all motors.");
        this.updateUiStatus();

        // Pošljite ukaze STOP za VSE naprave
        this.publishMqttCommand("assemblyline/crane/command", "STOP 0");
        this.publishMqttCommand("assemblyline/crane/command", "STOP 1");
        this.publishMqttCommand("assemblyline/crane/command", "STOP 2");
        this.publishMqttCommand("assemblyline/conveyor/command", { command: "STOP" });
        this.publishMqttCommand("assemblyline/conveyor2/command", { command: "STOP" });
    }

    // Pomožna funkcija za objavo MQTT ukazov
    publishMqttCommand(topic, payload) {
        const message = typeof payload === 'object' ? JSON.stringify(payload) : payload.toString();
        this.mqttClient.publish(topic, message, {}, (err) => {
            if (err) {
                console.error(`Failed to publish MQTT message to ${topic}:`, err);
            } else {
                console.log(`Published MQTT command to ${topic}: ${message}`);
                // Logika zaklepanja in odklepanja premaknjena v handleMqttMessage
            }
        });
    }

    unlockListener() {
        this.commandSent = false;
        console.log("Listener unlocked.");
        this.updateUiStatus(); // Posodobite UI po odklepanju
    }

    updateUiStatus() {
        let blockColor = 'none';
        let r = 'none';
        let g = 'none';
        let b = 'none';
        let c = 'none';

        if (this.activeAutomationProgram && this.selectedAutomationProgram === 'ColorSortingCycle') {
            blockColor = this.activeAutomationProgram.blockColor || 'none';
            r = this.currentBlockR;
            g = this.currentBlockG;
            b = this.currentBlockB;
            c = this.currentBlockC;
        }

        const statusMessage = `System: ${this.systemMode}<br>Program: ${this.selectedAutomationProgram}<br>Process: ${this.automationState}<br>Block Color: ${blockColor}<br>R: ${r}, G: ${g}, B: ${b}, C: ${c}`;
        this.io.emit('ui_status_update', { payload: statusMessage });
    }

    // Nova metoda za preklop avtomatizacijskih programov
    switchAutomationProgram(programName) {
        if (this.systemMode === 'RUNNING') {
            console.warn("Ne morete preklopiti avtomatizacijskega programa, medtem ko sistem TEČE. Najprej USTAVITE.");
            return false;
        }
        switch (programName) {
            case 'BasicCycle':
                this.activeAutomationProgram = this.basicCycle;
                this.selectedAutomationProgram = 'BasicCycle';
                console.log("Switched to Basic Cycle program.");
                break;
            case 'ColorSortingCycle':
                this.activeAutomationProgram = this.colorSortingCycle;
                this.selectedAutomationProgram = 'ColorSortingCycle';
                console.log("Switched to Color Sorting Cycle program.");
                break;
            default:
                console.warn(`Unknown automation program: ${programName}`);
                return false;
        }
        this.updateUiStatus();
        return true;
    }

    handleMqttMessage(topic, message) {
        console.log(`FactoryAutomation received MQTT message: Topic: ${topic}, Message: ${message}`);

        // VRATAR 1: Če je sistem ustavljen, ne storite ničesar.
        if (this.systemMode !== 'RUNNING') {
            console.log(`USTAVLJENO | Stanje: ${this.automationState}. Ignoriram sporočilo.`);
            this.updateUiStatus(); // Zagotovite, da UI odraža stanje USTAVLJENO
            return;
        }

        // VRATAR 2 (ZAKLEP): Če je bil ukaz pravkar poslan, prezrite vsa dohodna sporočila.
        if (this.commandSent === true) {
            console.log(`ZAKLENJENO | Stanje: ${this.automationState}. Ignoriram sporočilo.`);
            this.updateUiStatus(); // Zagotovite, da UI odraža stanje ZAKLENJENO
            return;
        }

        // Delegirajte aktivnemu avtomatizacijskemu programu
        this.activeAutomationProgram.handleMqttMessage(topic, message);
    }
}

module.exports = FactoryAutomation;
