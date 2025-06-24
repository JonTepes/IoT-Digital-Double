const OBJECT_PRESENT_THRESHOLD = 150; // Object is PRESENT if color_c > this value

class FactoryAutomation {
    constructor(mqttClient, io) {
        this.mqttClient = mqttClient;
        this.io = io; // Socket.IO server instance for UI updates

        this.systemMode = 'STOPPED'; // 'STOPPED', 'RUNNING'
        this.automationState = 'IDLE'; // Current state in the automation sequence
        this.commandSent = false; // Lock to prevent re-entry while a command is being processed
        this.craneMotorStatus = { m0: false, m1: false, m2: false }; // For multi-motor waits
        this.conveyor1PickupPos = 0; // Stores the calculated pickup position for conveyor 1

        this.automationPrograms = {
            "Extended Cycle": [],
            "Sort by Color": []
        };

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
        this.currentProgram = programName; // Store the selected program name
        console.log(`System START command received for program: ${this.currentProgram}. Priming system by requesting conveyor state.`);
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
        const statusMessage = `System: ${this.systemMode}<br>Process: ${this.automationState}<br>Program: ${this.currentProgram || 'N/A'}`;
        this.io.emit('ui_status_update', { payload: statusMessage });
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

        let command_msg = null;
        let payload;
        try {
            payload = JSON.parse(message);
        } catch (e) {
            payload = message; // Handle non-JSON messages (like "STOP 0")
        }

        // Display current state on the node for easy debugging
        console.log(`RUNNING | State: ${this.automationState}`);
        this.updateUiStatus();

        switch (this.currentProgram) {
            case "Extended Cycle":
                command_msg = this.handleExtendedCycle(topic, payload);
                break;
            case "Sort by Color":
                command_msg = this.handleSortByColor(topic, payload);
                break;
            default:
                console.warn(`Unknown automation program: ${this.currentProgram}`);
                this.systemMode = 'STOPPED';
                this.automationState = 'IDLE';
                this.updateUiStatus();
                return;
        }

        // --- ACTION ---
        if (command_msg) {
            // A decision was made. Lock the listener and send the command(s).
            // Set the lock BEFORE sending commands
            this.commandSent = true;
            this.updateUiStatus(); // Update UI to show "LOCKED" state if applicable

            if (Array.isArray(command_msg)) {
                command_msg.forEach(cmd => {
                    this.publishMqttCommand(cmd.topic, cmd.payload);
                });
            } else if (command_msg.topic) { // Check if it's a single command object
                this.publishMqttCommand(command_msg.topic, command_msg.payload);
            } else {
                // This is the "No command, just triggering UI update and delay" case
                // No actual MQTT command is sent, so we can unlock immediately or after a short UI delay.
                // Node-RED had a delay here, so let's keep a small delay for consistency.
                console.log("No MQTT command to send, but state transition occurred. Unlocking listener after delay.");
            }
            // Start a single timer to unlock the listener after all commands are initiated
            setTimeout(() => this.unlockListener(), 1000); // 1000ms (1 second) delay, as requested
        }
    }

    handleExtendedCycle(topic, payload) {
        let command_msg = null;
        switch (this.automationState) {
            // --- Feeder Sequence ---
            case 'FEEDER_ACTIVATING':
                console.warn("Activating feeder to move block onto conveyor.");
                this.automationState = 'WAITING_FOR_FEEDER_COMPLETE';
                command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "FEED_BLOCK" } };
                break;

            case 'WAITING_FOR_FEEDER_COMPLETE':
                // The feeder action is quick and doesn't have a separate state topic.
                // We assume it's complete after the command is sent and a short delay.
                // Transition back to IDLE to check the conveyor sensor for the new block.
                console.warn("Feeder moved block. Transitioning to IDLE to check conveyor sensor.");
                this.automationState = 'IDLE';
                // No command, just state transition
                break;

            // --- Conveyor 1 Sequence ---
            case 'IDLE':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok) {
                    if (payload.color_c <= OBJECT_PRESENT_THRESHOLD) {
                        console.warn(`Sensor is clear (c=${payload.color_c}). Starting conveyor 1.`);
                        this.automationState = 'WAITING_FOR_OBJECT';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_REL", value: 1000 } };
                    } else {
                        let currentPos = payload.position;
                        let targetPos = currentPos + 5.5;
                        console.warn(`Object already present (c=${payload.color_c}). Moving to pickup pos: ${targetPos}cm.`);
                        this.conveyor1PickupPos = targetPos;
                        this.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                    }
                }
                break;

            case 'WAITING_FOR_OBJECT':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok && payload.color_c > OBJECT_PRESENT_THRESHOLD) {
                    let currentPos = payload.position;
                    let targetPos = currentPos + 4.0;
                    console.warn(`Object detected at ${currentPos}cm. Moving to calculated pickup position: ${targetPos}cm.`);
                    this.conveyor1PickupPos = targetPos;
                    this.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                    command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                }
                break;

            case 'CONVEYOR1_MOVING_TO_PICKUP':
                if (topic === 'assemblyline/conveyor/state' && payload.status === 'IDLE') {
                    // Assuming conveyor always stops at the right position as per user's instruction
                    console.warn(`Conveyor at pickup position. Starting crane sequence.`);
                    this.automationState = 'CRANE_MOVING_TO_PICKUP_XY';
                    this.craneMotorStatus = { m0: false, m1: false, m2: true }; // m2 is true because it's not moving yet
                    const cmd_m0 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: -35.0 }] }) };
                    const cmd_m1 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 7.7 }] }) };
                    command_msg = [cmd_m0, cmd_m1]; // Send multiple commands
                }
                break;

            // --- Crane First Pickup/Dropoff ---
            case 'CRANE_MOVING_TO_PICKUP_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.craneMotorStatus.m0 && this.craneMotorStatus.m1) {
                        console.warn("Crane at pickup X/Y. Lowering to pickup Z.");
                        this.automationState = 'CRANE_MOVING_TO_PICKUP_Z';
                        command_msg = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 6.5 }] }) };
                    }
                }
                break;

            case 'CRANE_MOVING_TO_PICKUP_Z':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    console.warn("Crane at pickup Z. Activating magnet.");
                    this.automationState = 'ACTIVATING_MAGNET';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 1 }) };
                }
                break;

            case 'ACTIVATING_MAGNET':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 1) {
                    console.warn(`Magnet ON. Raising to safe height.`);
                    this.automationState = 'CRANE_RAISING_TO_SAFE_HEIGHT';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 1.5 }] }) };
                }
                break;

            case 'CRANE_RAISING_TO_SAFE_HEIGHT':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    console.warn("Crane at safe height. Moving to dropoff X/Y.");
                    this.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                    this.craneMotorStatus = { m0: false, m1: false, m2: true };
                    const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: 52.5 }] }) };
                    const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 12.0 }] }) };
                    command_msg = [cmd_m0_d, cmd_m1_d];
                }
                break;

            case 'CRANE_MOVING_TO_DROPOFF_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.craneMotorStatus.m0 && this.craneMotorStatus.m1) {
                        console.warn(`Crane at dropoff X/Y. Deactivating magnet.`);
                        this.automationState = 'DEACTIVATING_MAGNET_FIRST_TIME';
                        command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 0 }) };
                    }
                }
                break;

            case 'DEACTIVATING_MAGNET_FIRST_TIME':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 0) {
                    console.warn(`Magnet OFF. Moving conveyor 2.`);
                    this.automationState = 'CONVEYOR2_MOVING';
                    command_msg = { topic: 'assemblyline/conveyor2/command', payload: { command: "MOVE_REL", value: -9.0 } };
                }
                break;

            // --- Final Step & Loop ---
            case 'CONVEYOR2_MOVING':
                if (topic === 'assemblyline/conveyor2/state' && payload.status === 'IDLE') {
                    console.warn("Cycle complete. Resetting to FEEDER_ACTIVATING.");
                    this.automationState = 'FEEDER_ACTIVATING'; // Loop back to feeder activation
                    // No command to send, just triggering UI update and delay
                    command_msg = { payload: "No command, just triggering UI update and delay" };
                }
                break;
        }
        return command_msg;
    }

    handleSortByColor(topic, payload) {
        let command_msg = null;
        switch (this.automationState) {
            // --- Feeder Sequence (same as Extended Cycle) ---
            case 'FEEDER_ACTIVATING':
                console.warn("Activating feeder to move block onto conveyor for sorting.");
                this.automationState = 'WAITING_FOR_FEEDER_COMPLETE';
                command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "FEED_BLOCK" } };
                break;

            case 'WAITING_FOR_FEEDER_COMPLETE':
                console.warn("Feeder moved block. Transitioning to IDLE to check conveyor sensor for color.");
                this.automationState = 'IDLE';
                break;

            // --- Conveyor 1 Sequence (modified to check color) ---
            case 'IDLE':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok) {
                    if (payload.color_c <= OBJECT_PRESENT_THRESHOLD) {
                        console.warn(`Sensor is clear (c=${payload.color_c}). Starting conveyor 1.`);
                        this.automationState = 'WAITING_FOR_OBJECT';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_REL", value: 1000 } };
                    } else {
                        let currentPos = payload.position;
                        let targetPos = currentPos + 5.5;
                        console.warn(`Object already present (c=${payload.color_c}). Moving to pickup pos: ${targetPos}cm.`);
                        this.conveyor1PickupPos = targetPos;
                        this.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                    }
                }
                break;

            case 'WAITING_FOR_OBJECT':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok && payload.color_c > OBJECT_PRESENT_THRESHOLD) {
                    let currentPos = payload.position;
                    let targetPos = currentPos + 4.0;
                    console.warn(`Object detected at ${currentPos}cm. Moving to calculated pickup position: ${targetPos}cm.`);
                    this.conveyor1PickupPos = targetPos;
                    this.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                    command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                }
                break;

            case 'CONVEYOR1_MOVING_TO_PICKUP':
                if (topic === 'assemblyline/conveyor/state' && payload.status === 'IDLE') {
                    console.warn(`Conveyor at pickup position. Determining block color.`);
                    const blockColor = getBlockColor(payload.color_c);
                    this.blockColor = blockColor; // Store the detected color
                    console.warn(`Detected block color: ${blockColor}`);

                    this.automationState = 'CRANE_MOVING_TO_PICKUP_XY';
                    this.craneMotorStatus = { m0: false, m1: false, m2: true };
                    const cmd_m0 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: -35.0 }] }) };
                    const cmd_m1 = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 7.7 }] }) };
                    command_msg = [cmd_m0, cmd_m1];
                }
                break;

            // --- Crane Pickup (same as Extended Cycle) ---
            case 'CRANE_MOVING_TO_PICKUP_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.craneMotorStatus.m0 && this.craneMotorStatus.m1) {
                        console.warn("Crane at pickup X/Y. Lowering to pickup Z.");
                        this.automationState = 'CRANE_MOVING_TO_PICKUP_Z';
                        command_msg = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 6.5 }] }) };
                    }
                }
                break;

            case 'CRANE_MOVING_TO_PICKUP_Z':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    console.warn("Crane at pickup Z. Activating magnet.");
                    this.automationState = 'ACTIVATING_MAGNET';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 1 }) };
                }
                break;

            case 'ACTIVATING_MAGNET':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 1) {
                    console.warn(`Magnet ON. Raising to safe height.`);
                    this.automationState = 'CRANE_RAISING_TO_SAFE_HEIGHT';
                    command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "move_all", motors: [{ id: 2, pos: 1.5 }] }) };
                }
                break;

            case 'CRANE_RAISING_TO_SAFE_HEIGHT':
                if (topic === 'assemblyline/crane/motor_state' && payload.motor === 2 && payload.state === 'IDLE') {
                    console.warn("Crane at safe height. Moving to dropoff X/Y based on color.");
                    this.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                    this.craneMotorStatus = { m0: false, m1: false, m2: true };

                    let dropoff_m0_pos;
                    let dropoff_m1_pos;

                    if (this.blockColor === 'blue') {
                        dropoff_m0_pos = 52.5; // Blue block dropoff (same as extended cycle)
                        dropoff_m1_pos = 12.0;
                    } else if (this.blockColor === 'yellow') {
                        dropoff_m0_pos = -90.0; // Yellow block dropoff
                        dropoff_m1_pos = 5.0;
                    } else {
                        console.warn(`Unknown block color (${this.blockColor}). Dropping off at default extended cycle position.`);
                        dropoff_m0_pos = 52.5;
                        dropoff_m1_pos = 12.0;
                    }

                    const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: dropoff_m0_pos }] }) };
                    const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: dropoff_m1_pos }] }) };
                    command_msg = [cmd_m0_d, cmd_m1_d];
                }
                break;

            case 'CRANE_MOVING_TO_DROPOFF_XY':
                if (topic === 'assemblyline/crane/motor_state') {
                    if (payload.motor === 0 || payload.motor === 1) {
                        if (payload.state === 'IDLE' || payload.state === 'HOLDING') {
                            this.craneMotorStatus[`m${payload.motor}`] = true;
                        }
                    }
                    if (this.craneMotorStatus.m0 && this.craneMotorStatus.m1) {
                        console.warn(`Crane at dropoff X/Y. Deactivating magnet.`);
                        this.automationState = 'DEACTIVATING_MAGNET_FIRST_TIME';
                        command_msg = { topic: 'assemblyline/crane/command', payload: JSON.stringify({ command: "set_magnet", state: 0 }) };
                    }
                }
                break;

            case 'DEACTIVATING_MAGNET_FIRST_TIME':
                if (topic === 'assemblyline/crane/motor_state' && payload.component === 'magnet' && payload.state === 0) {
                    console.warn(`Magnet OFF. Moving conveyor 2.`);
                    this.automationState = 'CONVEYOR2_MOVING';
                    command_msg = { topic: 'assemblyline/conveyor2/command', payload: { command: "MOVE_REL", value: -9.0 } };
                }
                break;

            // --- Final Step & Loop (same as Extended Cycle) ---
            case 'CONVEYOR2_MOVING':
                if (topic === 'assemblyline/conveyor2/state' && payload.status === 'IDLE') {
                    console.warn("Cycle complete. Resetting to FEEDER_ACTIVATING.");
                    this.automationState = 'FEEDER_ACTIVATING'; // Loop back to feeder activation
                    command_msg = { payload: "No command, just triggering UI update and delay" };
                }
                break;
        }
        return command_msg;
    }
}

// Helper function to determine block color based on color_c value
function getBlockColor(color_c) {
    if (color_c > 200) { // Example threshold for blue (adjust as needed)
        return 'blue';
    } else if (color_c > 100) { // Example threshold for yellow (adjust as needed)
        return 'yellow';
    }
    return 'unknown';
}

module.exports = FactoryAutomation;
