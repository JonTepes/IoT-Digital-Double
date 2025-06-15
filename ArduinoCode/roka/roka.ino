#include <WiFi.h>
#include <PubSubClient.h>
#include <AccelStepper.h>
#include <ArduinoJson.h> // For creating JSON status messages
#include <math.h>       // For round()

// --- Definicije pinov ---
// Motor 1 (Naprej/Nazaj) - Connected to THIS ESP
#define M1_P1 1  // Verify these pins are free and work on this ESP
#define M1_P2 2
#define M1_P3 3
#define M1_P4 4
// Motor 2 (Gor/Dol) - Connected to THIS ESP
#define M2_P1 5  // Verify these pins are free and work on this ESP
#define M2_P2 6
#define M2_P3 7
#define M2_P4 8

// *** Electromagnet Pin ***
#define MAGNET_PIN 0 // Using GPIO0 for the electromagnet relay/driver

// --- Objekti motorjev ---
AccelStepper stepper1(AccelStepper::FULL4WIRE, M1_P1, M1_P3, M1_P2, M1_P4);
AccelStepper stepper2(AccelStepper::FULL4WIRE, M2_P1, M2_P3, M2_P2, M2_P4);

// *** Motor IDs for reporting ***
const int MOTOR_IDS[2] = {1, 2}; // Global IDs for these motors

// --- Nastavitve motorjev ---
// Note: Speed and Acceleration are still in STEPS/SEC and STEPS/SEC^2
const float MAX_SPEED_NORMAL = 390.0;  // Steps per second
const float ACCEL_NORMAL = 1000.0;     // Steps per second^2

// *** NEW: Conversion Factors for Linear Motors ***
const float STEPS_PER_MOVEMENT = 10000.0;
const float CM_PER_MOVEMENT = 17.5;
const float STEPS_PER_CM = STEPS_PER_MOVEMENT / CM_PER_MOVEMENT; // Steps per cm (~571.43)
const float CM_PER_STEP = CM_PER_MOVEMENT / STEPS_PER_MOVEMENT; // Cm per step (~0.00175)

// --- WiFi ---
#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.150";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-crane-main-12"; // *** MUST BE UNIQUE ***
const char* commandTopic = "assemblyline/crane/command";       // Listen for commands here
const char* motorStateTopic = "assemblyline/crane/motor_state"; // Publish individual component states here

// --- Globalni objekti ---
WiFiClient espClient;
PubSubClient mqttClient(espClient);
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250; // Interval poročanja (ms)

// *** Magnet State Variable ***
bool magnetState = false; // Initially OFF

// --- Prototipi funkcij ---
void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishComponentStates(); // Publish state for M1, M2 (in CM), and Magnet individually
void setMagnet(bool state); // Function to control magnet
long cmToSteps(float cm); // Helper function
float stepsToCm(long steps);   // Helper function

void setup() {
    Serial.begin(115200); // For debugging THIS ESP
    Serial.println("ESP_Main (M1, M2, Magnet) Booting (Units: CM / Magnet State)...");

    // --- Konfiguriraj LOKALNE motorje ---
    // AccelStepper always works in steps internally
    stepper1.setMaxSpeed(MAX_SPEED_NORMAL);
    stepper1.setAcceleration(ACCEL_NORMAL);
    stepper1.setCurrentPosition(0); // Start at 0 steps (represents 0 cm)
    Serial.println("Stepper 1 (M1) Configured.");

    stepper2.setMaxSpeed(MAX_SPEED_NORMAL);
    stepper2.setAcceleration(ACCEL_NORMAL);
    stepper2.setCurrentPosition(0); // Start at 0 steps (represents 0 cm)
    Serial.println("Stepper 2 (M2) Configured.");

    // --- Configure Magnet Pin ---
    pinMode(MAGNET_PIN, OUTPUT);
    setMagnet(false); // Start with magnet OFF
    Serial.println("Electromagnet Configured (Pin 0). Initial state: OFF");

    setupWifi();

    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
    Serial.println("MQTT Configured.");
}

void loop() {
    if (!mqttClient.connected()) {
        reconnectMqtt();
    }
    mqttClient.loop(); // Process MQTT messages

    // Run local steppers (internal step processing)
    stepper1.run();
    stepper2.run();

    // Periodically publish status via MQTT
    unsigned long now = millis();
    if (now - lastStateReportTime > stateReportInterval && mqttClient.connected()) {
        publishComponentStates(); // Publish individual states (M1/M2 in CM)
        lastStateReportTime = now;
    }
}

// --- Helper function to convert centimeters to steps ---
long cmToSteps(float cm) {
    return round(cm * STEPS_PER_CM);
}

// --- Helper function to convert steps to centimeters ---
float stepsToCm(long steps) {
    return (float)steps * CM_PER_STEP;
}

// *** Function to set magnet state and update variable ***
void setMagnet(bool state) {
    digitalWrite(MAGNET_PIN, state ? HIGH : LOW); // HIGH = ON, LOW = OFF (Adjust if your relay logic is inverted)
    magnetState = state;
    Serial.print("Magnet set to: "); Serial.println(magnetState ? "ON" : "OFF");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    payload[length] = '\0';
    String message = String((char*)payload);
    // message.toUpperCase(); // Keep case sensitivity for commands like "SET MAGNET"
    Serial.print("MQTT Received ["); Serial.print(topic); Serial.print("]: "); Serial.println(message);

    if (String(topic) == commandTopic) {
        StaticJsonDocument<256> doc; // Increased size for JSON parsing
        DeserializationError error = deserializeJson(doc, payload, length);

        if (error) {
            Serial.print(F("deserializeJson() failed: "));
            Serial.println(error.f_str());
            // Fallback to old string parsing for non-JSON commands
            if (message.startsWith("STOP ")) {
                int motorIndex = -1;
                String indexStr = message.substring(5);
                indexStr.trim();
                if (indexStr.length() > 0) {
                     motorIndex = indexStr.toInt();
                    if (motorIndex == MOTOR_IDS[0]) { // Motor 1
                        Serial.println("Stopping Local Motor 1");
                        stepper1.stop();
                        stepper1.runToPosition(); // Ensure smooth deceleration
                        publishComponentStates(); // Publish immediate update
                    } else if (motorIndex == MOTOR_IDS[1]) { // Motor 2
                        Serial.println("Stopping Local Motor 2");
                        stepper2.stop();
                        stepper2.runToPosition(); // Ensure smooth deceleration
                        publishComponentStates(); // Publish immediate update
                    } else {
                        Serial.println("Ignoring STOP command for unknown/remote motor index.");
                    }
                } else { Serial.println("Invalid STOP format (missing motor index)."); }
            } else if (message.startsWith("SET MAGNET ")) {
                String stateStr = message.substring(11);
                stateStr.trim();
                if (stateStr == "1") {
                    setMagnet(true); // Turn magnet ON
                    publishComponentStates(); // Publish immediate update
                } else if (stateStr == "0") {
                    setMagnet(false); // Turn magnet OFF
                    publishComponentStates(); // Publish immediate update
                } else {
                    Serial.println("Invalid SET MAGNET format (use 1 for ON, 0 for OFF).");
                }
            } else if (message == "GETSTATUS" || message == "GETPOS") {
                Serial.println("GETSTATUS/GETPOS received, publishing current component states (positions in CM).");
                publishComponentStates();
            } else {
                 Serial.println("Unknown command format received.");
            }
        } else {
            // JSON parsing successful
            const char* command = doc["command"];
            if (command && String(command) == "move_all") {
                JsonArray motors = doc["motors"].as<JsonArray>();
                if (motors) {
                    for (JsonObject motor : motors) {
                        int motorId = motor["id"];
                        float pos = motor["pos"]; // This will be in cm for M1 and M2

                        if (motorId == MOTOR_IDS[0]) { // Motor 1
                            long targetPosSteps = cmToSteps(pos);
                            Serial.print("Moving Local Motor 1 to ");
                            Serial.print(pos);
                            Serial.print(" cm (");
                            Serial.print(targetPosSteps);
                            Serial.println(" steps)");
                            stepper1.moveTo(targetPosSteps);
                            publishComponentStates();
                        } else if (motorId == MOTOR_IDS[1]) { // Motor 2
                            long targetPosSteps = cmToSteps(pos);
                            Serial.print("Moving Local Motor 2 to ");
                            Serial.print(pos);
                            Serial.print(" cm (");
                            Serial.print(targetPosSteps);
                            Serial.println(" steps)");
                            stepper2.moveTo(targetPosSteps);
                            publishComponentStates();
                        }
                    }
                }
            } else if (command && String(command) == "set_magnet") { // New JSON command for magnet
                bool state = doc["state"];
                setMagnet(state);
                publishComponentStates();
            } else {
                Serial.println("Unknown JSON command received.");
            }
        }
    }
}

// *** UPDATED: Publishes the state of M1, M2 (in CM), and Magnet individually on motorStateTopic ***
void publishComponentStates() {
    if (!mqttClient.connected()) return;

    char jsonBuffer[128]; // Buffer for JSON payload

    // --- Publish state for Motor 1 ---
    StaticJsonDocument<100> doc1;
    long currentSteps1 = stepper1.currentPosition();
    float currentCm1 = stepsToCm(currentSteps1); // Convert steps to CM
    doc1["motor"] = MOTOR_IDS[0]; // Motor ID = 1
    doc1["pos"] = currentCm1;      // Publish position in CM
    doc1["state"] = (stepper1.distanceToGo() == 0) ? "IDLE" : "MOVING";
    serializeJson(doc1, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);
    // Serial.print("Published M1 State (CM): "); Serial.println(jsonBuffer); // Debug

    // --- Publish state for Motor 2 ---
    StaticJsonDocument<100> doc2;
    long currentSteps2 = stepper2.currentPosition();
    float currentCm2 = stepsToCm(currentSteps2); // Convert steps to CM
    doc2["motor"] = MOTOR_IDS[1]; // Motor ID = 2
    doc2["pos"] = currentCm2;      // Publish position in CM
    doc2["state"] = (stepper2.distanceToGo() == 0) ? "IDLE" : "MOVING";
    serializeJson(doc2, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);
    // Serial.print("Published M2 State (CM): "); Serial.println(jsonBuffer); // Debug

    // --- Publish state for Magnet ---
    StaticJsonDocument<100> docM;
    docM["component"] = "magnet"; // Use "component" key for non-motor parts
    docM["state"] = magnetState ? 1 : 0; // 1 for ON, 0 for OFF
    serializeJson(docM, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer); // Publish to the same topic
    // Serial.print("Published Magnet State: "); Serial.println(jsonBuffer); // Debug
}

// --- Standard WiFi and MQTT Functions (Unchanged) ---
void setupWifi() {
     delay(10);
     Serial.println("Connecting to WiFi...");
     WiFi.mode(WIFI_STA);
     WiFi.begin(ssid, password);
     int connection_attempts = 0;
     while (WiFi.status() != WL_CONNECTED) {
         delay(500);
         Serial.print(".");
         connection_attempts++;
         if (connection_attempts > 40) {
             Serial.println("\nWiFi Connection Failed!");
             // Consider adding a restart or error state here
             return;
          }
     }
     Serial.println("\nWiFi connected");
     Serial.print("IP address: ");
     Serial.println(WiFi.localIP());
}

void reconnectMqtt() {
    while (!mqttClient.connected()) {
        Serial.print("Attempting MQTT connection (");
        Serial.print(mqttClientId);
        Serial.print(")...");
        if (mqttClient.connect(mqttClientId)) {
            Serial.println("connected");
            // Subscribe to the command topic
            if (mqttClient.subscribe(commandTopic)) {
                 Serial.print("Subscribed to: ");
                 Serial.println(commandTopic);
                 // Publish initial states upon connection (positions in CM)
                 publishComponentStates();
            } else {
                Serial.println("MQTT Subscription failed! Retrying in 5s...");
                delay(5000);
            }
        } else {
            Serial.print("failed, rc=");
            Serial.print(mqttClient.state());
            Serial.println(" try again in 5 seconds");
            delay(5000); // Wait 5 seconds before retrying
        }
    }
}