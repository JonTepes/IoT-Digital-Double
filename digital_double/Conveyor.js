import * as THREE from 'three'; // Uvoz knjižnice THREE
import { BaseMachine } from './BaseMachine.js';

export class Conveyor extends BaseMachine {
    constructor(config, gridToWorld, scene) {
        super(config, gridToWorld, scene);
        // Tukaj dodaj specifične lastnosti tekočega traku
        this.mixer = null; // Mešalnik animacij
        this.animationActions = []; // Polje za shranjevanje vseh animacijskih akcij
    }

    async loadModel() {
        // Uporabi GLTF objekt, ki ga vrne nalagalnik osnovnega razreda
        const gltf = await super.loadModel(true); // Posreduj true, da dobiš celoten gltf objekt

        if (gltf && gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.model); // Uporabi this.model (objekt scene)

            // console.log(`Conveyor ${this.name}: Found ${gltf.animations.length} animation clips.`); // Odstranjeno za končno verzijo

            // Ustvari akcijo za vsak najden animacijski posnetek
            gltf.animations.forEach((clip) => {
                const action = this.mixer.clipAction(clip);
                action.setLoop(THREE.LoopRepeat); // Nastavi ponavljanje za vse
                this.animationActions.push(action);
                // console.log(`Conveyor ${this.name}: Created action for clip "${clip.name}".`); // Odstranjeno za končno verzijo
            });

        } else if (gltf) {
            // console.warn(`Conveyor ${this.name}: Model loaded but no animations found.`); // Odstranjeno za končno verzijo
        }
    }

    // Prepiši handleMessage, če se mora tekoči trak sam odzivati na sporočila MQTT
    handleMessage(topic, message) {
        // Primer: Obravnava sporočila o stanju/položaju
        // Preveri, ali se prejeta tema ujema s tisto, ki je dodeljena v njegovi konfiguraciji
        if (topic === this.config.topics?.state) {
            if (message.hasOwnProperty('position')) {
                // Tukaj dodaj logiko za vizualno posodobitev tekočega traku (npr. premikanje teksture, animiranje valjev)
            }
            // --- Obravnava animacije glede na status ---
            if (message.hasOwnProperty('status')) {
                if (this.animationActions.length > 0) {
                    if (message.status === "MOVING") {
                        this.animationActions.forEach(action => {
                            if (!action.isRunning()) {
                                action.play();
                            }
                        });
                    } else { // Assume any other status means stop
                        this.animationActions.forEach(action => {
                            if (action.isRunning()) {
                                action.stop();
                            }
                        });
                    }
                }
            }
        }
    }

    // Prepiši metodo update za posodabljanje mešalnika animacij
    update(deltaTime) {
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }
    }
}