import * as THREE from 'three';
import { BaseMachine } from './BaseMachine.js';

export class Conveyor extends BaseMachine {
    constructor(config, gridToWorld, scene) {
        super(config, gridToWorld, scene);
        // Specifične lastnosti tekočega traku
        this.mixer = null; // Mešalnik animacij za model
        this.animationActions = []; // Seznam animacijskih akcij
    }

    async loadModel() {
        // Naloži model in pridobi celoten GLTF objekt iz osnovnega razreda
        const gltf = await super.loadModel(true);

        if (gltf && gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.model); // Inicializiraj mešalnik animacij z modelom

            // Ustvari animacijsko akcijo za vsak najden posnetek
            gltf.animations.forEach((clip) => {
                const action = this.mixer.clipAction(clip);
                action.setLoop(THREE.LoopRepeat); // Nastavi ponavljanje animacije
                this.animationActions.push(action);
            });

        } else if (gltf) {
            console.warn(`Tekoči trak ${this.name}: Model naložen, vendar ni najdenih animacij.`);
        }
    }

    // Prepiši handleMessage za obravnavo MQTT sporočil, specifičnih za tekoči trak
    handleMessage(topic, message) {
        // Obravnava sporočil o stanju/položaju
        if (topic === this.config.topics?.state) {
            if (message.hasOwnProperty('position')) {
                console.log(`Tekoči trak ${this.name} je prejel položaj: ${message.position} cm`);
            }
            // Obravnava animacije glede na status
            if (message.hasOwnProperty('status')) {
                if (this.animationActions.length > 0) {
                    if (message.status === "MOVING") {
                        this.animationActions.forEach(action => {
                            if (!action.isRunning()) {
                                action.play();
                            }
                        });
                    } else { // Predpostavi, da vsak drug status pomeni ustavitev
                        this.animationActions.forEach(action => {
                            if (action.isRunning()) {
                                action.stop();
                            }
                        });
                    }
                }
            }
        } else if (topic === this.config.topics?.control) {
            // Obravnava kontrolnih sporočil, poslanih iz uporabniškega vmesnika
            if (message.command === 'move' && message.hasOwnProperty('position')) {
                console.log(`Tekoči trak ${this.name} je prejel ukaz za premik na ${message.position} cm`);
                // Tukaj bi običajno poslali ta ukaz dejanskemu fizičnemu tekočemu traku
                // Za zdaj lahko simuliramo premik ali neposredno posodobimo vizualno stanje
                if (this.animationActions.length > 0) {
                    this.animationActions.forEach(action => {
                        if (!action.isRunning()) {
                            action.play(); // Zaženi animacijo ob ukazu za premik
                        }
                    });
                    // Simuliraj ustavitev po kratki zamudi, če ni dejanske povratne zanke
                    setTimeout(() => {
                        this.animationActions.forEach(action => action.stop());
                        console.log(`Tekoči trak ${this.name} je simuliral ustavitev.`);
                    }, 2000); // Ustavi po 2 sekundah
                }
            }
        }
    }

    // Prepiši metodo update za posodabljanje mešalnika animacij tekočega traku
    update(deltaTime) {
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }
    }
}