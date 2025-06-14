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

    async loadModel(returnFullGltf = false) { // Dodaj izbirni parameter
        return new Promise((resolve, reject) => {
            console.log(`Loading model for ${this.name}: ${this.config.modelPath}`);
            loader.load(
                this.config.modelPath,
                (gltf) => {
                    this.model = gltf.scene;
                    this.model.name = this.name;

                    // Calculate world position using gridPos or initialGridPos
                    const gridPos = this.config.gridPos || this.config.initialGridPos || { x: 0, y: 0 };
                    const initialWorldPos = this.gridToWorld(gridPos.x, gridPos.y, 0); // Zaenkrat predpostavimo višino 0
                    this.model.position.copy(initialWorldPos);

                    // Uporabi rotacijo, če je določena
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
                undefined, // Povratni klic za napredek (izbirno)
                (error) => {
                    console.error(`An error happened loading model for ${this.name}:`, error);
                    reject(error); // Zavrni obljubo v primeru napake
                }
            );
        });
    }

    // Osnovna metoda handleMessage - podrazredi jo lahko prepišejo
    handleMessage(topic, message) {
        // Privzeto obnašanje: zabeleži neobravnavano sporočilo. Podrazredi naj to prepišejo.
    }

    // Osnovna metoda update - lahko se prepiše za animacije
    update(deltaTime) {
        // Privzeto: ne naredi ničesar
    }
}