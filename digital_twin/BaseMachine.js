import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

export class BaseMachine {
    constructor(config, gridToWorld, scene) {
        this.config = config;
        this.gridToWorld = gridToWorld;
        this.scene = scene;
        this.model = null;
        this.name = config.name;
    }

async loadModel(returnFullGltf = false) { // Dodaj izbirni parameter za vrnitev celotnega GLTF objekta
        return new Promise((resolve, reject) => {
            console.log(`Loading model for ${this.name}: ${this.config.modelPath}`);
            loader.load(
                this.config.modelPath,
                (gltf) => {
                    this.model = gltf.scene;
                    this.model.name = this.name;

                    const gridPos = this.config.gridPos || this.config.initialGridPos || { x: 0, y: 0 };
                    const initialWorldPos = this.gridToWorld(gridPos.x, gridPos.y, 0); // Predpostavimo višino 0
                    this.model.position.copy(initialWorldPos);

                    // Uporabi rotacijo modela, če je določena v konfiguraciji
                    if (this.config.rotationY !== undefined) {
                        this.model.rotation.y = this.config.rotationY;
                    }

                    this.scene.add(this.model);
                    console.log(`Model ${this.name} loaded and added to scene at`, this.model.position);
                    if (returnFullGltf) {
                        resolve(gltf); // Razreši s celotnim GLTF objektom, če je zahtevano
                    } else {
                        resolve(this.model); // Privzeto razreši samo z objektnim prizorom
                    }
                },
                undefined, // Povratni klic za napredek nalaganja (izbirno)
                (error) => {
                    console.error(`An error happened loading model for ${this.name}:`, error);
                    reject(error); // Zavrni obljubo v primeru napake
                }
            );
        });
    }

    // Osnovna metoda handleMessage - podrazredi jo lahko prepišejo za obravnavo MQTT sporočil
    handleMessage(topic, message) {
        // Privzeto obnašanje: ne naredi ničesar. Podrazredi naj to prepišejo za specifično logiko.
    }

    // Osnovna metoda update - podrazredi jo lahko prepišejo za animacije ali posodobitve stanja
    update(deltaTime) {
        // Privzeto: ne naredi ničesar
    }
}