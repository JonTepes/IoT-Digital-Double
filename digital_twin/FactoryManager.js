import { Conveyor } from './Conveyor.js';
import { Crane } from './Crane.js';
import { Workpiece } from './Workpiece.js';

export class FactoryManager {
    constructor(scene, gridToWorld, layout, unitsPerCm) {
        this.scene = scene;
        this.gridToWorld = gridToWorld;
        this.layout = layout;
        this.unitsPerCm = unitsPerCm; // Shrani faktor pretvorbe enot

        this.machines = new Map(); // Shrani instance strojev { ime: instanca }
        this.topicMap = new Map(); // Mapira MQTT teme na instanco stroja, ki naj jih obravnava { tema: instanca }
    }

    async initialize(socket) { // Sprejmi instanco vtičnice
        this.socket = socket; // Shrani instanco vtičnice
        // Neposredna MQTT povezava tukaj ni več potrebna
    }

    // Metoda za dinamično dodajanje posameznega stroja v sceno
    async addMachine(config) {
        let machineInstance = this.createMachineInstance(config);

        if (!machineInstance) {
            console.error(`Spodletelo ustvarjanje instance za ${config.name}`);
            return null;
        }
        try {
            await machineInstance.loadModel(); // Naloži 3D model stroja
            this.machines.set(config.name, machineInstance); // Dodaj instanco na seznam upravitelja
            this.updateTopicMapForMachine(machineInstance); // Posodobi mapo tem in se naroči na MQTT teme
            return machineInstance; // Vrni ustvarjeno instanco stroja
        } catch (error) {
            console.error(`Spodletelo nalaganje modela za ${config.name}:`, error);
            return null;
        }
    }

    // Metoda za ustvarjanje in nalaganje stroja (uporablja se pri inicializaciji iz postavitve)
    async createAndLoadMachine(config) {
        let machineInstance;

        // Tovarniški vzorec za ustvarjanje instanc strojev glede na tip
        switch (config.type) {
            case 'Conveyor':
                machineInstance = new Conveyor(config, this.gridToWorld, this.scene);
                break;
            case 'Crane':
                machineInstance = new Crane(config, this.gridToWorld, this.scene, this.unitsPerCm); // Posreduj faktor merila
                break;
            case 'Workpiece':
                machineInstance = new Workpiece(config, this.gridToWorld, this.scene);
                break;
            default:
                console.warn(`Neznan tip stroja: ${config.type}`);
                return; // Preskoči neznane tipe
        }

        if (machineInstance) {
            this.machines.set(config.name, machineInstance);
            await machineInstance.loadModel(); // Počakaj, da se model naloži
        }
    }

    // Ločena logika za ustvarjanje instance stroja (uporablja se pri dinamičnem dodajanju)
    createMachineInstance(config) {
         let machineInstance;
         switch (config.type) {
            case 'Conveyor':
                machineInstance = new Conveyor(config, this.gridToWorld, this.scene);
                break;
            case 'Crane':
                machineInstance = new Crane(config, this.gridToWorld, this.scene, this.unitsPerCm); // Posreduj faktor merila
                break;
            case 'Workpiece':
                machineInstance = new Workpiece(config, this.gridToWorld, this.scene);
                break;
            default:
                console.warn(`Neznan tip stroja: ${config.type}`);
                return null;
        }
        return machineInstance;
    }

    // Zgradi mapo MQTT tem, ki jih obravnavajo posamezni stroji
    buildTopicMap() {
         for (const config of this.layout) {
            const machineInstance = this.machines.get(config.name);
            if (!machineInstance) continue;

            // Mapiraj splošne teme, definirane v 'topics' konfiguraciji stroja
            if (config.topics) {
                for (const key in config.topics) {
                    this.addTopicMapping(config.topics[key], machineInstance);
                }
            }
            // Mapiraj specifične nadzorne teme (npr. za obdelovance)
            if (config.controlTopics) {
                 for (const key in config.controlTopics) {
                    this.addTopicMapping(config.controlTopics[key], machineInstance);
                }
            }
        }
    }

    // Posodobi mapo tem za določen stroj in se naroči na nove MQTT teme
    updateTopicMapForMachine(machineInstance) {
        const config = machineInstance.config;
        if (!config) return;

        const topicsToSubscribe = [];
        if (config.topics) {
            for (const key in config.topics) {
                this.addTopicMapping(config.topics[key], machineInstance);
                topicsToSubscribe.push(config.topics[key]);
            }
        }
        // Naroči se tudi na kontrolne teme, če obstajajo, saj se bo stroj morda moral odzvati na lastne ukaze
        if (config.controlTopics) {
            for (const key in config.controlTopics) {
                this.addTopicMapping(config.controlTopics[key], machineInstance);
                if (!topicsToSubscribe.includes(config.controlTopics[key])) {
                    topicsToSubscribe.push(config.controlTopics[key]);
                }
            }
        }

        // Pošlji zahteve za naročnino strežniku
        if (this.socket && this.socket.connected && topicsToSubscribe.length > 0) {
            topicsToSubscribe.forEach(topic => {
                this.socket.emit('subscribe_mqtt', topic);
            });
        }
    }

    // Doda preslikavo MQTT teme na instanco stroja
     addTopicMapping(topic, instance) {
        if (this.topicMap.has(topic) && this.topicMap.get(topic) !== instance) {
            // Opozorilo, če je tema že preslikana na drugo instanco
            console.warn(`Trk MQTT teme: ${topic} je preslikana na več različnih instanc!`);
        }
        this.topicMap.set(topic, instance); // Preslikaj temo na instanco
    }

    // Obravnavaj dohodna MQTT sporočila s strežnika preko Socket.IO
    handleMqttMessage(topic, payloadString) {
        const machineInstance = this.topicMap.get(topic); // Poišči instanco, preslikano na to temo
        if (machineInstance && typeof machineInstance.handleMessage === 'function') {
             try {
                const message = JSON.parse(payloadString);
                
                // Special handling for crane command messages to track lastM0Command
                if (machineInstance.config.type === 'Crane' && topic === machineInstance.config.topics?.control) {
                    this.trackCraneCommands(machineInstance, message);
                }
                
                machineInstance.handleMessage(topic, message); // Delegiraj obravnavo sporočila
            } catch (e) {
                console.error(`Spodletelo razčlenjevanje MQTT sporočila na temi ${topic}:`, e, `Vsebina: ${payloadString}`);
            }
        } else {
        }
    }

    // Track crane commands to update lastM0Command for chart display
    trackCraneCommands(craneInstance, message) {
        if (message.command === 'move_all' && Array.isArray(message.motors)) {
            // Find motor 0 command in the motors array
            const m0Command = message.motors.find(motor => motor.id === 0);
            if (m0Command && m0Command.pos !== undefined) {
                craneInstance.lastM0Command = m0Command.pos;
                console.log(`Tracked M0 command for ${craneInstance.name}: ${m0Command.pos}°`);
            }
        }
    }

    // Ponastavi stanje upravitelja tovarne
    async reset() {
        // Pošlji zahteve za odjavo strežniku za vse trenutne teme
        if (this.socket && this.socket.connected) {
            Array.from(this.topicMap.keys()).forEach(topic => {
                this.socket.emit('unsubscribe_mqtt', topic);
            });
        }
        this.machines.clear(); // Počisti seznam strojev
        this.topicMap.clear(); // Počisti mapo tem po odjavi
    }

    getMachineByName(name) {
        return this.machines.get(name);
    }

    // Posodobi stanje vseh strojev v tovarni
    update(deltaTime) {
        for (const machine of this.machines.values()) {
            if (typeof machine.update === 'function') {
                machine.update(deltaTime); // Pokliči metodo update na vsakem stroju
            }
        }
    }
}