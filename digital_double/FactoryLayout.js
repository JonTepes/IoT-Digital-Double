// Primer konfiguracije (lahko se kasneje naloži iz JSON datoteke)
export const factoryLayout = [
    {
        type: 'Conveyor', // Ujema se z imenom razreda
        name: 'conveyorBelt1',
        modelPath: 'models/belt.glb',
        gridPos: { x: 5, y: 10 }, // Položaj na mreži
        rotationY: 0, // Rotacija v radianih (0 = privzeto)
        topics: { // Relevantne MQTT teme za sam tekoči trak (npr. hitrost, stanje delovanja)
            // state: 'assemblyline/conveyor1/state', // Primer, če bi tekoči trak imel svoje stanje
        }
    },
    {
        type: 'Crane', // Ujema se z imenom razreda
        name: 'assemblyCrane',
        modelPath: 'models/crane.glb',
        gridPos: { x: 10, y: 12 },
        rotationY: Math.PI / 2, // Zavrten za 90 stopinj
        topics: {
            // position: 'assemblyline/crane/position', // Primer za položaj dvigala
            // Dodaj več tem (prijemalo, rotacija itd.)
        }
    },
    {
        type: 'Workpiece', // Element, ki se premika
        name: 'block-1',
        modelPath: 'models/block.glb', // Pot do modela bloka
        initialGridPos: { x: 5, y: 10 }, // Kje začne (npr. na tekočem traku conveyor1)
        // Določi, katere teme nadzorujejo *ta* obdelovanec
        controlTopics: {
            position: "assemblyline/conveyor/state", // Tema, ki zagotavlja podatke o položaju
            highlight: "assemblyline/crane/motor_state" // Tema, ki nadzoruje osvetlitev/barvo
        }
    }
    // Tukaj dodaj več strojev ali obdelovancev...
];