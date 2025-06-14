import mqtt from 'mqtt';
import { Conveyor } from './Conveyor.js';
import { Crane } from './Crane.js';
import { Workpiece } from './Workpiece.js';

export class FactoryManager {
    constructor(scene, gridToWorld, layout, mqttBrokerUrl, unitsPerCm) { // Dodaj unitsPerCm
        this.scene = scene;
        this.gridToWorld = gridToWorld;
        this.layout = layout;
        this.mqttBrokerUrl = mqttBrokerUrl;
        this.unitsPerCm = unitsPerCm; // Shrani faktor merila

        this.machines = new Map(); // Hrani instance strojev { ime: instanca }
        this.topicMap = new Map(); // Mapira MQTT teme na instanco stroja, ki naj jih obravnava { tema: instanca }
        this.mqttClient = null;
    }

    async initialize() {
        // Takoj se poveži z MQTT, tudi če še ni prisotnih strojev
        this.connectToMqtt();
    }

    // Metoda za dinamično dodajanje posameznega stroja
    async addMachine(config) {
        let machineInstance = this.createMachineInstance(config);

        if (!machineInstance) {
            console.error(`Failed to create instance for ${config.name}`);
            return null;
        }
        try {
            await machineInstance.loadModel(); // Naloži model
            this.machines.set(config.name, machineInstance); // Dodaj na seznam upravitelja
            // Izbirno: Posodobi mapo tem in se naroči, če so potrebne dinamične teme
            this.updateTopicMapForMachine(machineInstance);
            return machineInstance; // Vrni instanco (ali njen model)
        } catch (error) {
            console.error(`Failed to load model for ${config.name}:`, error);
            return null;
        }
    }

    async createAndLoadMachine(config) {
        let machineInstance;

        // Tovarniški vzorec za ustvarjanje instanc glede na tip
        switch (config.type) {
            case 'Conveyor':
                machineInstance = new Conveyor(config, this.gridToWorld, this.scene);
                break;
            case 'Crane':
                machineInstance = new Crane(config, this.gridToWorld, this.scene, this.unitsPerCm); // Posreduj merilo
                break;
            case 'Workpiece':
                machineInstance = new Workpiece(config, this.gridToWorld, this.scene);
                break;
            default:
                console.warn(`Unknown machine type: ${config.type}`);
                return; // Preskoči neznane tipe
        }

        if (machineInstance) {
            this.machines.set(config.name, machineInstance);
            // Naloži model (vrne obljubo)
            await machineInstance.loadModel(); // Počakaj, da se ta specifični model naloži
        }
    }

    // Ločena logika ustvarjanja instanc
    createMachineInstance(config) {
         let machineInstance;
         switch (config.type) {
            case 'Conveyor':
                machineInstance = new Conveyor(config, this.gridToWorld, this.scene);
                break;
            case 'Crane':
                machineInstance = new Crane(config, this.gridToWorld, this.scene, this.unitsPerCm); // Posreduj merilo
                break;
            case 'Workpiece': // Ohrani logiko za obdelovance, če je potrebna, ali jo odstrani, če se ne dodajajo preko menija
                machineInstance = new Workpiece(config, this.gridToWorld, this.scene);
                break;
            default:
                console.warn(`Unknown machine type: ${config.type}`);
                return null;
        }
        return machineInstance;
    }

    buildTopicMap() {
         // Mapiraj teme, definirane v postavitvi, na pravilno instanco stroja
         for (const config of this.layout) {
            const machineInstance = this.machines.get(config.name);
            if (!machineInstance) continue;

            // Mapiraj splošne teme, definirane v 'topics'
            if (config.topics) {
                for (const key in config.topics) {
                    this.addTopicMapping(config.topics[key], machineInstance);
                }
            }
            // Mapiraj specifične nadzorne teme (kot za Workpiece)
            if (config.controlTopics) {
                 for (const key in config.controlTopics) {
                    this.addTopicMapping(config.controlTopics[key], machineInstance);
                }
            }
        }
    }

    // Izbirno: Pokliči to, če dinamično dodajanje strojev zahteva nove MQTT naročnine
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
        if (config.controlTopics) { // npr. za Workpiece
            for (const key in config.controlTopics) {
                this.addTopicMapping(config.controlTopics[key], machineInstance);
                // Prepreči podvojene naročnine, če se controlTopics prekrivajo s topics
                if (!topicsToSubscribe.includes(config.controlTopics[key])) {
                    topicsToSubscribe.push(config.controlTopics[key]);
                }
            }
        }

        // Naroči se na nove teme, če je klient povezan
        if (this.mqttClient && this.mqttClient.connected && topicsToSubscribe.length > 0) {
            this.mqttClient.subscribe(topicsToSubscribe, (err) => {
                if (err) {
                    console.error(`Failed to subscribe to new topics for ${config.name}:`, err);
                }
            });
        }
    }

     addTopicMapping(topic, instance) {
        if (this.topicMap.has(topic) && this.topicMap.get(topic) !== instance) {
            // Dovoli več komponentam, da poslušajo isto temo, če je potrebno,
            // vendar zabeleži opozorilo, če se zdi nenamerno (mapirane različne instance)
            console.warn(`MQTT topic collision: ${topic} is mapped to multiple different instances!`);
        }
        // Mapiraj temo na instanco, ki naj jo obravnava
        this.topicMap.set(topic, instance);
    }

    connectToMqtt() {
        if (this.mqttClient) {
            return; // Prepreči večkratne povezave
        }
        this.mqttClient = mqtt.connect(this.mqttBrokerUrl);

        this.mqttClient.on('connect', () => {
            // Naroči se na teme, ki so *trenutno* v mapi (lahko je na začetku prazna)
            const currentTopics = Array.from(this.topicMap.keys());
            if (currentTopics.length > 0) {
                this.mqttClient.subscribe(currentTopics, (err) => {
                    if (err) console.error(`Failed initial subscription:`, err);
                });
            }
        });

        this.mqttClient.on('message', (topic, payload) => {
            const machineInstance = this.topicMap.get(topic); // Poišči instanco, mapirano na to temo
            if (machineInstance && typeof machineInstance.handleMessage === 'function') {
                 try {
                    const message = JSON.parse(payload.toString());
                    machineInstance.handleMessage(topic, message); // Delegiraj
                } catch (e) {
                    console.error(`Failed to parse MQTT message on topic ${topic}:`, e, `Payload: ${payload.toString()}`);
                }
            } else {
                // console.warn(`Received message on unmapped topic: ${topic}`); // Can be noisy
            }
        });

        this.mqttClient.on('error', (err) => console.error('MQTT Connection Error:', err));
    }

    async reset() {
        // Odjavi se od vseh trenutnih tem
        if (this.mqttClient && this.mqttClient.connected) {
            const topics = Array.from(this.topicMap.keys());
            if (topics.length > 0) {
                // Odjava MQTT je lahko asinhrona, vendar knjižnica morda ne vrne obljube.
                // Nadaljevali bomo ob predpostavki, da je dovolj hitra, ali pa bomo obravnavali napake.
                try {
                    this.mqttClient.unsubscribe(topics, (err) => {
                        if (err) {
                            console.error("Error unsubscribing from topics:", err);
                        }
                    });
                } catch (e) {
                    console.error("Exception during unsubscribe:", e);
                }
            }
        }
        this.machines.clear();
        this.topicMap.clear(); // Počisti mapo tem po odjavi
    }

    getMachineByName(name) {
        return this.machines.get(name);
    }

    update(deltaTime) {
        for (const machine of this.machines.values()) {
            if (typeof machine.update === 'function') {
                machine.update(deltaTime);
            }
        }
    }
}