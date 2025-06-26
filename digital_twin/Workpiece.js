import * as THREE from 'three';
import { BaseMachine } from './BaseMachine.js'; // Deduj za nalaganje modela itd.

export class Workpiece extends BaseMachine {
    constructor(config, gridToWorld, scene) {
        super(config, gridToWorld, scene);
        this.initialWorldPos = null; // Shrani začetni položaj za relativno premikanje
        this.stepsPerUnit = 100; // Faktor pretvorbe iz MQTT korakov v Three.js enote
        this.defaultColor = 0x00ff00; // Privzeta barva (npr. zelena)
        this.highlightColor = 0xff0000; // Barva za osvetlitev (npr. rdeča)
    }

    async loadModel() {
        // Pokliči osnovno metodo loadModel in počakaj, da se konča
        await super.loadModel();
        // Shrani začetni svetovni položaj *po tem, ko* je model naložen in postavljen
        if (this.model) {
            this.initialWorldPos = this.model.position.clone();
            console.log(`Workpiece ${this.name} initial world position stored:`, this.initialWorldPos);
            // Nastavi začetno barvo
            this.setHighlight(false); // Začni s privzeto barvo
        }
    }

    // Pokliči to metodo, ko se obdelovanec premakne s potegni-in-spusti
    updateInitialWorldPos() {
        if (this.model) {
            this.initialWorldPos = this.model.position.clone();
            console.log(`Workpiece ${this.name} initial world position RECALCULATED to:`, this.initialWorldPos);
        }
    }
    handleMessage(topic, message) {
        if (!this.model || !this.initialWorldPos) return; // Ne obdeluj, če model ni pripravljen

        // Preveri, ali je ta tema za nadzor položaja
        if (topic === this.config.controlTopics?.position && message.hasOwnProperty('position')) {
            const targetXOffset = message.position / this.stepsPerUnit;
            // Posodobi položaj relativno na začetni položaj
            this.model.position.x = this.initialWorldPos.x + targetXOffset;
        }

        // Preveri, ali je ta tema za nadzor osvetlitve (kot magnet dvigala)
        if (topic === this.config.controlTopics?.highlight && message.component === 'magnet') {
            const isHighlighted = message.state === 1; // Osvetli, če je stanje 1
            this.setHighlight(isHighlighted);
        }
    }

    setHighlight(highlight) {
        const mesh = this.model?.getObjectByProperty('isMesh', true);
        if (mesh && mesh.material && mesh.material.color) {
            const newColor = highlight ? this.highlightColor : this.defaultColor;
            mesh.material.color.setHex(newColor);
        } else {
            console.warn(`Workpiece ${this.name}: Could not find mesh material to set color.`);
        }
    }
}