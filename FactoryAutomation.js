const BasicCycle = require('./automation_programs/BasicCycle');
const ColorSortingCycle = require('./automation_programs/ColorSortingCycle');

class FactoryAutomation {
    constructor(mqttClient, io) {
        this.mqttClient = mqttClient;
        this.io = io; // Socket.IO server instance for UI updates

        this.systemMode = 'STOPPED'; // 'STOPPED', 'RUNNING'
        this.automationState = 'IDLE'; // Current state in the automation sequence
        this.commandSent = false; // Lock to prevent re-entry while a command is being processed
        this.craneMotorStatus = { m0: false, m1: false, m2: false }; // For multi-motor waits
        this.conveyor1PickupPos = 0; // Stores the calculated pickup position for conveyor 1
        this.basicCycle = new BasicCycle(this);
        this.colorSortingCycle = new ColorSortingCycle(this);
        this.activeAutomationProgram = this.basicCycle; // Default to BasicCycle
        this.selectedAutomationProgram = 'BasicCycle'; // To track which program is active

        this.currentBlockR = 'none';
        this.currentBlockG = 'none';
        this.currentBlockB = 'none';
        this.currentBlockC = 'none';

        this.setupMqttSubscriptions();
    }

    setupMqttSubscriptions() {
        // Subscribe to all relevant topics for the factory state
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
        this.automationState = 'FEEDER_ACTIVATING'; // Start with feeder activation
        this.commandSent = false; // Ensure lock is off at start
        this.craneMotorStatus = { m0: false, m1: false, m2: false };
        console.log(`System START command received. Active program: ${this.selectedAutomationProgram}. Priming system by requesting conveyor state.`);
        this.updateUiStatus();

        // Prime the system by requesting conveyor state, similar to Node-RED
        this.publishMqttCommand('assemblyline/conveyor/command', { command: "GET_STATE" });
    }

    stop() {
        this.systemMode = 'STOPPED';
        this.automationState = 'IDLE';
        this.commandSent = false; // IMPORTANT: Unlock the listener
        console.log("System STOP command received. Halting all motors.");
        this.updateUiStatus();

        // Send STOP commands for ALL devices
        this.publishMqttCommand("assemblyline/crane/command", "STOP 0");
        this.publishMqttCommand("assemblyline/crane/command", "STOP 1");
        this.publishMqttCommand("assemblyline/crane/command", "STOP 2");
        this.publishMqttCommand("assemblyline/conveyor/command", { command: "STOP" });
        this.publishMqttCommand("assemblyline/conveyor2/command", { command: "STOP" });
    }

    // Helper to publish MQTT commands
    publishMqttCommand(topic, payload) {
        const message = typeof payload === 'object' ? JSON.stringify(payload) : payload.toString();
        this.mqttClient.publish(topic, message, {}, (err) => {
            if (err) {
                console.error(`Failed to publish MQTT message to ${topic}:`, err);
            } else {
                console.log(`Published MQTT command to ${topic}: ${message}`);
                // Lock and unlock logic moved to handleMqttMessage
            }
        });
    }

    unlockListener() {
        this.commandSent = false;
        console.log("Listener unlocked.");
        this.updateUiStatus(); // Update UI after unlock
    }

    updateUiStatus() {
        let blockColor = 'none';
        let r = 'none';
        let g = 'none';
        let b = 'none';
        let c = 'none';

        if (this.activeAutomationProgram && this.selectedAutomationProgram === 'ColorSortingCycle') {
            blockColor = this.activeAutomationProgram.blockColor || 'none';
            // Assuming the ColorSortingCycle instance stores the last known RGB C values
            // We need to ensure these are passed from the payload to the ColorSortingCycle instance
            // and then accessed here.
            // For now, let's assume ColorSortingCycle will have properties for these.
            // If not, we'll need to add them to ColorSortingCycle.
            // Re-reading ColorSortingCycle.js to confirm.
            // After re-reading, I see that ColorSortingCycle.js is setting this.fa.currentBlockR etc.
            // This means FactoryAutomation should have these properties.
            // The previous diff was correct in adding them to FactoryAutomation.
            // The issue is that the values are not being passed from ColorSortingCycle to FactoryAutomation.
            // Let's revert the change to FactoryAutomation.js constructor and keep the properties there.
            // The problem is that the `updateUiStatus` in FactoryAutomation is called, but the `currentBlockR` etc.
            // are not being updated in FactoryAutomation itself.
            // They are being updated in `this.fa.currentBlockR` from `ColorSortingCycle.js`.
            // So, the `FactoryAutomation` instance *does* have these properties.
            // The problem is that the `blockColor` is `this.blockColor` in FactoryAutomation, which is not updated.
            // It should be `this.activeAutomationProgram.blockColor`.

            // Let's correct the updateUiStatus to use the values from the activeAutomationProgram.
            // The `currentBlockR`, `currentBlockG`, `currentBlockB`, `currentBlockC` are indeed properties of `FactoryAutomation`.
            // The `ColorSortingCycle` updates `this.fa.currentBlockR` which means it updates the `FactoryAutomation` instance's properties.
            // So, the `FactoryAutomation` properties are correct.
            // The only thing that needs to be fixed is `this.blockColor` in `FactoryAutomation.js`'s `updateUiStatus`.
            // It should be `this.activeAutomationProgram.blockColor`.

            blockColor = this.activeAutomationProgram.blockColor || 'none';
            r = this.currentBlockR;
            g = this.currentBlockG;
            b = this.currentBlockB;
            c = this.currentBlockC;
        }

        const statusMessage = `System: ${this.systemMode}<br>Program: ${this.selectedAutomationProgram}<br>Process: ${this.automationState}<br>Block Color: ${blockColor}<br>R: ${r}, G: ${g}, B: ${b}, C: ${c}`;
        this.io.emit('ui_status_update', { payload: statusMessage });
    }

    // New method to switch automation programs
    switchAutomationProgram(programName) {
        if (this.systemMode === 'RUNNING') {
            console.warn("Cannot switch automation program while system is RUNNING. Please STOP first.");
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

        // GATEKEEPER 1: If system is stopped, do nothing.
        if (this.systemMode !== 'RUNNING') {
            console.log(`STOPPED | State: ${this.automationState}. Ignoring message.`);
            this.updateUiStatus(); // Ensure UI reflects STOPPED state
            return;
        }

        // GATEKEEPER 2 (THE LOCK): If a command was just sent, ignore all incoming messages.
        if (this.commandSent === true) {
            console.log(`LOCKED | State: ${this.automationState}. Ignoring message.`);
            this.updateUiStatus(); // Ensure UI reflects LOCKED state
            return;
        }

        // Delegate to the active automation program
        this.activeAutomationProgram.handleMqttMessage(topic, message);
    }
}

module.exports = FactoryAutomation;
