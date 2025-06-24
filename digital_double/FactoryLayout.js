// Konfiguracija postavitve tovarne (lahko se naloži iz JSON datoteke)
export const factoryLayout = [
    {
        type: 'Conveyor', // Ujema se z imenom razreda
        name: 'conveyorBelt1',
        modelPath: 'models/belt.glb',
        gridPos: { x: 5, y: 10 }, // Položaj na mreži
        rotationY: 0, // Rotacija v radianih (0 = privzeto)
        topics: { // Relevantne MQTT teme za tekoči trak (npr. hitrost, stanje delovanja)
            // Primer teme za stanje
        }
    },
    {
        type: 'Crane', // Ujema se z imenom razreda
        name: 'assemblyCrane',
        modelPath: 'models/crane.glb',
        gridPos: { x: 10, y: 12 },
        rotationY: Math.PI / 2, // Zavrten za 90 stopinj
        topics: {
            // Primer teme za položaj žerjava
        }
    },
    {
        type: 'Workpiece', // Tip: obdelovanec
        name: 'block-1',
        modelPath: 'models/block.glb', // Pot do 3D modela obdelovanca
        initialGridPos: { x: 5, y: 10 }, // Začetni položaj na mreži
        // Določi, katere teme nadzorujejo ta obdelovanec
        controlTopics: {
            position: "assemblyline/conveyor/state", // Tema, ki zagotavlja podatke o položaju obdelovanca
            highlight: "assemblyline/crane/motor_state" // Tema, ki nadzoruje osvetlitev/barvo obdelovanca
        }
    }
];