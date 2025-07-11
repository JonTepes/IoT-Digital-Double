import * as THREE from 'three';
import { BaseMachine } from './BaseMachine.js';

export class Crane extends BaseMachine {
    constructor(config, gridToWorld, scene, unitsPerCm) {
        super(config, gridToWorld, scene);
        this.unitsPerCm = unitsPerCm; // Shrani faktor pretvorbe enot

        // Reference na premikajoče se dele žerjava
        this.motor0 = null; // Rotacijski del (npr. rotacija osnove)
        this.motor1 = null; // Linearni del 1 (npr. horizontalni izteg roke)
        this.motor2 = null; // Linearni del 2 (npr. vertikalno dvigalo)
        this.magnet = null; // Referenca na magnetni del za vizualne spremembe stanja

        // Shrani začetna stanja motorjev
        this.initialRotationM0 = 0;
        this.initialPositionM1 = new THREE.Vector3();
        this.initialPositionM2 = new THREE.Vector3();
        this.currentMotorPositions = { m0: 0, m1: 0, m2: 0 }; // Lastnost za shranjevanje trenutnih položajev motorjev
    }

    async loadModel() {
        await super.loadModel(); // Počakaj, da osnovni razred naloži model

        if (this.model) {
            // --- Poišči specifične dele ---
            this.motor0 = this.model.getObjectByName('M0'); // Predvideva, da se del za rotacijo osnove imenuje 'M0'
            this.motor1 = this.model.getObjectByName('M1'); // Predvideva, da se horizontalna roka imenuje 'M1'
            this.motor2 = this.model.getObjectByName('M2'); // Predvideva, da se vertikalno dvigalo imenuje 'M2'
            this.magnet = this.model.getObjectByName('Magnet'); // Predvideva, da se magnet imenuje 'Magnet'

            // --- Preverjanje napak ---
            if (!this.motor0) console.warn(`Žerjav ${this.name}: Ni bilo mogoče najti dela motorja M0`);
            if (!this.motor1) console.warn(`Žerjav ${this.name}: Ni bilo mogoče najti dela motorja M1`);
            if (!this.motor2) console.warn(`Žerjav ${this.name}: Ni bilo mogoče najti dela motorja M2`);
            if (!this.magnet) console.warn(`Žerjav ${this.name}: Ni bilo mogoče najti dela magneta 'Magnet'`);

            // --- Shrani začetne transformacije ---
            if (this.motor0) this.initialRotationM0 = this.motor0.rotation.y;
            if (this.motor1) this.initialPositionM1.copy(this.motor1.position);
            if (this.motor2) this.initialPositionM2.copy(this.motor2.position);


        }
    }

    // Prepiši handleMessage za obravnavo MQTT sporočil, specifičnih za žerjav
    handleMessage(topic, message) {
        // Obravnava sporočil o stanju motorja
        if (topic === this.config.topics?.motor_state) { // Uporabi temo, definirano v konfiguraciji
             if (message.component === 'magnet') {
                const magnetOn = message.state === 1;
                // Tukaj dodaj logiko za vizualno posodobitev magneta (npr. sprememba barve)
                if (this.magnet) {
                    const magnetMesh = this.magnet.getObjectByProperty('isMesh', true);
                    if (magnetMesh && magnetMesh.material) {
                        if (magnetOn) {
                            magnetMesh.material.color.set(0xff0000); // Rdeča, ko je magnet vklopljen
                        } else {
                            magnetMesh.material.color.set(0x888888); // Siva, ko je magnet izklopljen
                        }
                    }
                }
            }
            // Obravnavaj sporočila o položaju motorjev
            else if (message.hasOwnProperty('motor') && message.hasOwnProperty('pos')) {
                const motorIndex = message.motor;
                const positionValue = message.pos; // Stopinje za motor 0, cm za 1 in 2

                switch (motorIndex) {
                    case 0: // Rotacija (osnova) - Predpostavlja rotacijo okoli osi Y
                        if (this.motor0) {
                            const rotationRadians = THREE.MathUtils.degToRad(positionValue);
                            this.motor0.rotation.y = this.initialRotationM0 - rotationRadians;
                            this.currentMotorPositions.m0 = positionValue; // Posodobi trenutni položaj
                            if (typeof this.onM0AngleUpdate === 'function') { // NEW: Call update function
                                this.onM0AngleUpdate(positionValue);
                            }
                        }
                        break;
                    case 1: // Linearno gibanje 1 (horizontalna roka) - Predpostavlja gibanje po osi Z
                        if (this.motor1) {
                            const positionUnits = positionValue * this.unitsPerCm;
                            this.motor1.position.z = this.initialPositionM1.z + positionUnits;
                            this.currentMotorPositions.m1 = positionValue; // Posodobi trenutni položaj
                        }
                        break;
                    case 2: // Linearno gibanje 2 (vertikalno dvigalo) - Predpostavlja gibanje po osi Y
                        if (this.motor2) {
                            const positionUnits = positionValue * this.unitsPerCm;
                            // Upoštevaj negativni predznak, če pozitivni cm pomeni premik navzdol v Three.js sistemu z osjo Y navzgor
                            this.motor2.position.y = this.initialPositionM2.y - positionUnits;
                            this.currentMotorPositions.m2 = positionValue; // Posodobi trenutni položaj
                        }
                        break;
                    default:
                        console.warn(`Žerjav ${this.name}: Prejeto sporočilo za neznan indeks motorja ${motorIndex}`);
                }
            }
        } else if (topic === this.config.topics?.control) {
            // Obravnava kontrolnih sporočil, poslanih iz uporabniškega vmesnika
            if (message.command === 'set_magnet' && message.hasOwnProperty('state')) {
                const magnetOn = message.state === 1;
                if (this.magnet) {
                    const magnetMesh = this.magnet.getObjectByProperty('isMesh', true);
                    if (magnetMesh && magnetMesh.material) {
                        if (magnetOn) {
                            magnetMesh.material.color.set(0xff0000); // Rdeča, ko je magnet vklopljen
                        } else {
                            magnetMesh.material.color.set(0x888888); // Siva, ko je magnet izklopljen
                        }
                    }
                }
                console.log(`Žerjav ${this.name}: Magnet nastavljen na ${magnetOn ? 'ON' : 'OFF'}`);
            } else if (message.command === 'move_all' && message.hasOwnProperty('motors')) {
                message.motors.forEach(motorCmd => {
                    const motorIndex = motorCmd.id;
                    const positionValue = motorCmd.pos;
 
                    switch (motorIndex) {
                        case 0:
                            if (this.motor0) {
                                const rotationRadians = THREE.MathUtils.degToRad(positionValue);
                                this.motor0.rotation.y = this.initialRotationM0 - rotationRadians;
                                this.currentMotorPositions.m0 = positionValue;
                                if (typeof this.onM0AngleUpdate === 'function') { // NEW: Call update function
                                    this.onM0AngleUpdate(positionValue);
                                }
                            }
                            break;
                        case 1:
                            if (this.motor1) {
                                const positionUnits = positionValue * this.unitsPerCm;
                                this.motor1.position.z = this.initialPositionM1.z + positionUnits;
                                this.currentMotorPositions.m1 = positionValue;
                            }
                            break;
                        case 2:
                            if (this.motor2) {
                                const positionUnits = positionValue * this.unitsPerCm;
                                this.motor2.position.y = this.initialPositionM2.y - positionUnits;
                                this.currentMotorPositions.m2 = positionValue;
                            }
                            break;
                    }
                });
                console.log(`Žerjav ${this.name} je prejel ukaz za premik vseh motorjev na:`, this.currentMotorPositions);
            }
        }
    }
}