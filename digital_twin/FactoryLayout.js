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
    }
];