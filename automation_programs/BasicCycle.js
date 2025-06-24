const OBJECT_PRESENT_THRESHOLD = 150; // Object is PRESENT if color_c > this value

class BasicCycle {
    constructor(factoryAutomationInstance) {
        this.fa = factoryAutomationInstance; // Reference to the FactoryAutomation instance
    }

    handleMqttMessage(topic, message) {
        // The gatekeepers are handled in FactoryAutomation.js before calling this method.
        // This method only contains the state machine logic for the Basic Cycle.

        let command_msg = null;
        let payload;
        try {
            payload = JSON.parse(message);
        } catch (e) {
            payload = message; // Handle non-JSON messages (like "STOP 0")
        }

        // Display current state on the node for easy debugging
        console.log(`RUNNING | State: ${this.fa.automationState}`);
        this.fa.updateUiStatus();

        switch (this.fa.automationState) {
            // --- Feeder Sequence ---
            case 'FEEDER_ACTIVATING':
                console.warn("Activating feeder to move block onto conveyor.");
                this.fa.automationState = 'WAITING_FOR_FEEDER_COMPLETE';
                command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "FEED_BLOCK" } };
                break;

            case 'WAITING_FOR_FEEDER_COMPLETE':
                // The feeder action is quick and doesn't have a separate state topic.
                // We assume it's complete after the command is sent and a short delay.
                // Transition back to IDLE to check the conveyor sensor for the new block.
                console.warn("Feeder moved block. Transitioning to IDLE to check conveyor sensor.");
                this.fa.automationState = 'IDLE';
                // No command, just state transition
                break;

            // --- Feeder Sequence ---

            // --- Conveyor 1 Sequence ---
            case 'IDLE':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok) {
                    if (payload.color_c <= OBJECT_PRESENT_THRESHOLD) {
                        console.warn(`Sensor is clear (c=${payload.color_c}). Starting conveyor 1.`);
                        this.fa.automationState = 'WAITING_FOR_OBJECT';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_REL", value: 1000 } };
                    } else {
                        let currentPos = payload.position;
                        let targetPos = currentPos + 5.5;
                        console.warn(`Object already present (c=${payload.color_c}). Moving to pickup pos: ${targetPos}cm.`);
                        this.fa.conveyor1PickupPos = targetPos;
                        this.fa.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                        command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                    }
                }
                break;

            case 'WAITING_FOR_OBJECT':
                if (topic === 'assemblyline/conveyor/state' && payload.sensor_ok && payload.color_c > OBJECT_PRESENT_THRESHOLD) {
                    let currentPos = payload.position;
                    let targetPos = currentPos + 4.0;
                    console.warn(`Object detected at ${currentPos}cm. Moving to calculated pickup position: ${targetPos}cm.`);
                    this.fa.conveyor1PickupPos = targetPos;
                    this.fa.automationState = 'CONVEYOR1_MOVING_TO_PICKUP';
                    command_msg = { topic: 'assemblyline/conveyor/command', payload: { command: "MOVE_ABS", value: targetPos } };
                }
                break;

            case 'CONVEYOR1_MOVING_TO_PICKUP':
                if (topic === 'assemblyline/conveyor/state' && payload.status === 'IDLE') {
                    // Assuming conveyor always stops at the right position as per user's instruction
                    console.warn(`Conveyor at pickup position. Starting crane sequence.`);
                    this.fa.automationState = 'CRANE_MOVING_TO_PICKUP_XY';
                    this.fa.craneMotorStatus = { m0: false, m1: false, m2: true }; // m2 is true because it's not moving yet
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
                    console.warn("Crane at safe height. Moving to dropoff X/Y.");
                    this.fa.automationState = 'CRANE_MOVING_TO_DROPOFF_XY';
                    this.fa.craneMotorStatus = { m0: false, m1: false, m2: true };
                    const cmd_m0_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 0, pos: 52.5 }] }) };
                    const cmd_m1_d = { topic: "assemblyline/crane/command", payload: JSON.stringify({ command: "move_all", motors: [{ id: 1, pos: 12.0 }] }) };
                    command_msg = [cmd_m0_d, cmd_m1_d];
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

            // --- Final Step & Loop ---
            case 'CONVEYOR2_MOVING':
                if (topic === 'assemblyline/conveyor2/state' && payload.status === 'IDLE') {
                    console.warn("Cycle complete. Resetting to FEEDER_ACTIVATING.");
                    this.fa.automationState = 'FEEDER_ACTIVATING'; // Loop back to feeder activation
                    // No command to send, just triggering UI update and delay
                    command_msg = { payload: "No command, just triggering UI update and delay" };
                }
                break;
        }

        // --- ACTION ---
        if (command_msg) {
            // A decision was made. Lock the listener and send the command(s).
            // Set the lock BEFORE sending commands
            this.fa.commandSent = true;
            this.fa.updateUiStatus(); // Update UI to show "LOCKED" state if applicable

            if (Array.isArray(command_msg)) {
                command_msg.forEach(cmd => {
                    this.fa.publishMqttCommand(cmd.topic, cmd.payload);
                });
            } else if (command_msg.topic) { // Check if it's a single command object
                this.fa.publishMqttCommand(command_msg.topic, command_msg.payload);
            } else {
                // This is the "No command, just triggering UI update and delay" case
                // No actual MQTT command is sent, so we can unlock immediately or after a short UI delay.
                // Node-RED had a delay here, so let's keep a small delay for consistency.
                console.log("No MQTT command to send, but state transition occurred. Unlocking listener after delay.");
            }
            // Start a single timer to unlock the listener after all commands are initiated
            setTimeout(() => this.fa.unlockListener(), 1000); // 1000ms (1 second) delay, as requested
        }
    }
}

module.exports = BasicCycle;