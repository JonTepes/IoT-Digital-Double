import * as THREE from 'three';
import { BaseMachine } from './BaseMachine.js';

export class Crane extends BaseMachine {
    constructor(config, gridToWorld, scene, unitsPerCm) {
        super(config, gridToWorld, scene);
        this.unitsPerCm = unitsPerCm; // Shrani faktor pretvorbe

        // Reference na premikajoče se dele
        this.motor0 = null; // Rotacijski del (npr. rotacija osnove)
        this.motor1 = null; // Linearni del 1 (npr. horizontalni izteg roke)
        this.motor2 = null; // Linearni del 2 (npr. vertikalno dvigalo)
        this.magnet = null; // Referenca na magnetni del za vizualne spremembe stanja

        // Shrani začetna stanja
        this.initialRotationM0 = 0;
        this.initialPositionM1 = new THREE.Vector3();
        this.initialPositionM2 = new THREE.Vector3();
    }

    async loadModel() {
        await super.loadModel(); // Počakaj, da osnovni razred naloži model

        if (this.model) {
            // --- Poišči specifične dele ---
            // Prilagodi ta imena glede na dejansko strukturo GLB datoteke!
            // Možnost 1: Po imenu (priporočljivo, če so imena nastavljena v Blenderju/GLB)
            this.motor0 = this.model.getObjectByName('M0'); // Predvideva, da se del za rotacijo osnove imenuje 'M0'
            this.motor1 = this.model.getObjectByName('M1'); // Predvideva, da se horizontalna roka imenuje 'M1'
            this.motor2 = this.model.getObjectByName('M2'); // Predvideva, da se vertikalno dvigalo imenuje 'M2'

            // --- Preverjanje napak ---
            if (!this.motor0) console.warn(`Crane ${this.name}: Could not find motor part M0`);
            if (!this.motor1) console.warn(`Crane ${this.name}: Could not find motor part M1`);
            if (!this.motor2) console.warn(`Crane ${this.name}: Could not find motor part M2`);

            // --- Shrani začetne transformacije ---
            if (this.motor0) this.initialRotationM0 = this.motor0.rotation.y;
            if (this.motor1) this.initialPositionM1.copy(this.motor1.position);
            if (this.motor2) this.initialPositionM2.copy(this.motor2.position);


        }
    }

    // Prepiši handleMessage, če se mora dvigalo samo odzivati na sporočila MQTT
    handleMessage(topic, message) {
        // Primer: Obravnava sporočila o stanju motorja
        if (topic === this.config.topics?.motor_state) { // Uporabi temo, definirano v konfiguraciji
             if (message.component === 'magnet') { // Primer strukture
                const magnetOn = message.state === 1;
                // Tukaj dodaj logiko za vizualno posodobitev dvigala (npr. sprememba barve magneta, predvajanje zvoka)
            }
            // Po potrebi obravnavaj druga stanja motorjev
            else if (message.hasOwnProperty('motor') && message.hasOwnProperty('pos')) {
                const motorIndex = message.motor;
                const positionValue = message.pos; // Degrees for motor 0, cm for 1 & 2
                // const state = message.state; // "IDLE", "RUNNING", itd. - to lahko uporabiš kasneje

                switch (motorIndex) {
                    case 0: // Rotacija (npr. osnova) - Predpostavlja rotacijo okoli osi Y
                        if (this.motor0) {
                            const rotationRadians = THREE.MathUtils.degToRad(positionValue);
                            this.motor0.rotation.y = this.initialRotationM0 - rotationRadians;
                        }
                        break;
                    case 1: // Linearno gibanje 1 (npr. horizontalna roka) - Predpostavlja gibanje po osi X
                        if (this.motor1) {
                            const positionUnits = positionValue * this.unitsPerCm;
                            // Uporabi relativno glede na začetni položaj vzdolž lokalne osi X motorja
                            // Ali, če je gibanje vzdolž svetovne osi X:
                            this.motor1.position.z = this.initialPositionM1.x + positionUnits;
                        }
                        break;
                    case 2: // Linearno gibanje 2 (npr. vertikalno dvigalo) - Predpostavlja gibanje po osi Y
                        if (this.motor2) {
                            const positionUnits = positionValue * this.unitsPerCm;
                            // Uporabi relativno glede na začetni položaj vzdolž lokalne osi Y motorja (gor/dol)
                            // Upoštevaj negativni predznak, če pozitivni cm pomeni premik navzdol v Three.js sistemu z osjo Y navzgor
                            this.motor2.position.y = this.initialPositionM2.y - positionUnits;
                        }
                        break;
                    default:
                        console.warn(`Crane ${this.name}: Received message for unknown motor index ${motorIndex}`);
                }
            }
    }
}
}