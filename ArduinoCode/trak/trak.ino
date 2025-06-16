#include <WiFi.h>
#include <PubSubClient.h>
#include <AccelStepper.h>
#include <Wire.h>
#include <Adafruit_TCS34725.h>
#include <ArduinoJson.h>
#include <math.h> // For round()

// --- Definicije pinov ---
#define CONVEYOR_P1 1 // IN1
#define CONVEYOR_P2 2 // IN2
#define CONVEYOR_P3 3 // IN3
#define CONVEYOR_P4 4 // IN4

// Use default I2C pins (SDA=8, SCL=9 on some ESP32 boards, adjust if needed)
// For standard ESP32: SDA=21, SCL=22

AccelStepper conveyorStepper(AccelStepper::HALF4WIRE, CONVEYOR_P1, CONVEYOR_P3, CONVEYOR_P2, CONVEYOR_P4);

// --- Nastavitve motorja ---
// Speed and Acceleration remain in STEPS per second
const float CONVEYOR_MAX_SPEED = 800.0; // steps/sec
const float CONVEYOR_ACCEL = 300.0;     // steps/sec^2

// *** NEW: Conversion Factors for Conveyor Belt ***
const float STEPS_PER_MOVEMENT = 1000.0;
const float CM_PER_MOVEMENT = 1.5;
const float STEPS_PER_CM = STEPS_PER_MOVEMENT / CM_PER_MOVEMENT; // Steps per cm (~666.67)
const float CM_PER_STEP = CM_PER_MOVEMENT / STEPS_PER_MOVEMENT; // Cm per step (0.0015)

// --- WiFi ---
#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.150";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-conveyor";
const char* commandTopic = "assemblyline/conveyor/command";
const char* stateTopic = "assemblyline/conveyor/state"; // Corrected topic typo

// --- Globalni objekti ---
WiFiClient espClient;
PubSubClient mqttClient(espClient);
Adafruit_TCS34725 tcs = Adafruit_TCS34725(TCS34725_INTEGRATIONTIME_2_4MS, TCS34725_GAIN_16X);

// --- Timing & State ---
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250; // How often to publish state periodically
unsigned long lastColorReadTime = 0;
const long colorReadInterval = 250;   // How often to read the sensor

bool sensorInitialized = false;
String currentStatus = "INIT";

// --- Raw Color Storage ---
uint16_t raw_r = 0;
uint16_t raw_g = 0;
uint16_t raw_b = 0;
uint16_t raw_c = 0;
bool colorValuesHaveChanged = true; // Flag to force initial publish

// --- Prototipi funkcij ---
void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishState(bool forceColorRead);
void readColorSensor();
long cmToSteps(float cm); // Helper function
float stepsToCm(long steps);   // Helper function

void setup() {
    Serial.begin(115200); // Initialize Serial for debugging
    Serial.println("Booting Conveyor Controller (Units: CM)...");

    setupWifi();

    // Initialize I2C for the color sensor
    // Use Wire.begin() without arguments for default ESP32 pins (SDA=21, SCL=22)
    // Or specify pins if using non-defaults: Wire.begin(SDA_PIN, SCL_PIN);
    if (!Wire.begin()) {
        Serial.println("Failed to start I2C communication.");
        sensorInitialized = false;
    } else {
        Serial.println("I2C Initialized.");
        if (tcs.begin()) {
            Serial.println("Found TCS34725 sensor");
            sensorInitialized = true;
            readColorSensor(); // Get initial reading
        } else {
            Serial.println("No TCS34725 found ... check your connections");
            sensorInitialized = false;
        }
    }

    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);

    conveyorStepper.setMaxSpeed(CONVEYOR_MAX_SPEED);
    conveyorStepper.setAcceleration(CONVEYOR_ACCEL);
    conveyorStepper.setCurrentPosition(0); // Start at 0 steps (0 cm)
    Serial.println("Conveyor stepper initialized.");
    currentStatus = "IDLE";
}

void loop() {
    if (!mqttClient.connected()) {
        reconnectMqtt();
    }
    // PubSubClient loop is crucial for receiving messages and maintaining connection
    if (mqttClient.connected()) {
         mqttClient.loop();
    }


    // *** conveyorStepper.run() MUST be called as often as possible ***
    // This function is non-blocking and needs frequent calls to manage steps
    conveyorStepper.run();

    unsigned long now = millis();

    // *** Read color sensor periodically (less often) ***
    if (sensorInitialized && (now - lastColorReadTime > colorReadInterval)) {
        readColorSensor(); // Update global raw_r/g/b/c variables
        lastColorReadTime = now;
    }

    // --- State Publishing Logic ---
    // Check if the motor is currently moving (still based on internal step count)
    bool isRunning = (conveyorStepper.distanceToGo() != 0);
    String newStatus = isRunning ? "MOVING" : "IDLE";
    bool statusChanged = (newStatus != currentStatus);

    // Publish state immediately if status changes (e.g., stopped)
    // or if color values have changed since last publish
    if (statusChanged || colorValuesHaveChanged) {
        currentStatus = newStatus;
        // Force a color read when stopping for the most up-to-date value
        // Don't force read if just color changed while moving
        bool forceRead = !isRunning;
        publishState(forceRead);
        lastStateReportTime = now; // Reset periodic timer
    }
    else {
        // Periodically publish state if timer expired, even if nothing changed
        if (now - lastStateReportTime > stateReportInterval) {
            // Don't force a color read on periodic updates, use cached values
            publishState(false);
            lastStateReportTime = now;
        }
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


// *** MQTT Callback: Handles incoming commands (expects position in CM) ***
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    Serial.print("Message arrived [");
    Serial.print(topic);
    Serial.print("] ");
    payload[length] = '\0'; // Null-terminate the payload
    String message = String((char*)payload);
    Serial.println(message);

    StaticJsonDocument<128> doc;
    DeserializationError error = deserializeJson(doc, payload, length);

    if (error) {
        Serial.print(F("deserializeJson() failed: "));
        Serial.println(error.f_str());
        return;
    }

    if (!doc.containsKey("command")) {
         Serial.println("JSON missing 'command' key.");
         return;
    }

    const char* command = doc["command"];
    String cmdStr = String(command);
    Serial.print("Received command: "); Serial.println(cmdStr);


    if (cmdStr == "MOVE_ABS") {
        if (doc.containsKey("value")) {
            float targetPosCm = doc["value"]; // Assume value is in CM
            long targetPosSteps = cmToSteps(targetPosCm);
            Serial.print("  MOVE_ABS: "); Serial.print(targetPosCm);
            Serial.print(" cm -> "); Serial.print(targetPosSteps); Serial.println(" steps");
            conveyorStepper.moveTo(targetPosSteps);
        } else { Serial.println("  MOVE_ABS missing 'value'"); }
    } else if (cmdStr == "MOVE_REL") {
        if (doc.containsKey("value")) {
            float relativeMoveCm = doc["value"]; // Assume value is relative CM
            long relativeMoveSteps = cmToSteps(relativeMoveCm);
            Serial.print("  MOVE_REL: "); Serial.print(relativeMoveCm);
            Serial.print(" cm -> "); Serial.print(relativeMoveSteps); Serial.println(" steps");
            conveyorStepper.move(relativeMoveSteps);
        } else { Serial.println("  MOVE_REL missing 'value'"); }
    } else if (cmdStr == "STOP") {
        Serial.println("  STOP command received.");
        // To achieve an "instant stop", set acceleration to a very high value temporarily
        conveyorStepper.setAcceleration(100000.0); // A very high acceleration value
        conveyorStepper.stop(); // This will now stop almost instantly
        // Immediately reset acceleration to original value for future movements
        conveyorStepper.setAcceleration(CONVEYOR_ACCEL);
        // State change detection in loop() will trigger publish with fresh color read
    } else if (cmdStr == "GET_STATE") {
        Serial.println("  GET_STATE command received.");
        publishState(true); // Force fresh read on explicit request
        lastStateReportTime = millis(); // Reset timer
    } else {
        Serial.print("  Unknown command: "); Serial.println(cmdStr);
    }
}

// *** Reads sensor and updates global variables ***
void readColorSensor() {
    if (!sensorInitialized) {
        // If sensor becomes unavailable, reset values and mark change
        if (raw_r != 0 || raw_g != 0 || raw_b != 0 || raw_c != 0) {
             raw_r = 0; raw_g = 0; raw_b = 0; raw_c = 0;
             colorValuesHaveChanged = true;
        }
        return;
    }

    // Read the sensor data
    uint16_t r, g, b, c;
    tcs.getRawData(&r, &g, &b, &c); // This can briefly block

    // Check if values actually changed before updating globals and flag
    if (r != raw_r || g != raw_g || b != raw_b || c != raw_c) {
        // Serial.print("Color changed: R:"); Serial.print(r); // Debug
        // Serial.print(" G:"); Serial.print(g);
        // Serial.print(" B:"); Serial.print(b);
        // Serial.print(" C:"); Serial.println(c);
        raw_r = r;
        raw_g = g;
        raw_b = b;
        raw_c = c;
        colorValuesHaveChanged = true; // Mark that color changed since last publish check
    }
}

// *** Publishes state (position in CM) ***
void publishState(bool forceColorRead) {
    if (!mqttClient.connected()) {
        Serial.println("Cannot publish state: MQTT not connected.");
        return;
    }

    // Read color sensor *only if forced* or if it's needed anyway
    if (forceColorRead && sensorInitialized) {
        readColorSensor(); // Get the latest values immediately before publishing
    }

    // Create JSON document using the current global values
    StaticJsonDocument<256> doc;

    // Get current position in steps and convert to CM
    long currentSteps = conveyorStepper.currentPosition();
    float currentCm = stepsToCm(currentSteps);

    doc["status"] = currentStatus; // Updated in loop()
    doc["position"] = currentCm;   // Publish position in CM
    doc["sensor_ok"] = sensorInitialized;
    doc["timestamp"] = millis(); // Use board uptime as timestamp
    doc["color_r"] = raw_r;
    doc["color_g"] = raw_g;
    doc["color_b"] = raw_b;
    doc["color_c"] = raw_c;

    // Serialize JSON to a buffer
    char jsonBuffer[256];
    size_t n = serializeJson(doc, jsonBuffer);

    // Publish the JSON string
    // Serial.print("Publishing state: "); Serial.println(jsonBuffer); // Debug
    if (mqttClient.publish(stateTopic, jsonBuffer, n)) {
        // Serial.println("  State published successfully."); // Debug
        colorValuesHaveChanged = false; // Reset flag ONLY if publish was successful
    } else {
        Serial.println("  State publish FAILED.");
        // Don't reset colorValuesHaveChanged, try again next time
    }
}

// --- WiFi Setup function (no changes needed) ---
void setupWifi() {
     Serial.print("Connecting to WiFi: "); Serial.println(ssid);
     WiFi.mode(WIFI_STA);
     WiFi.begin(ssid, password);
     int connection_attempts = 0;
     while (WiFi.status() != WL_CONNECTED) {
         delay(500); // delay() is blocking, but okay during setup
         Serial.print(".");
         connection_attempts++;
         if (connection_attempts > 40) { // ~20 seconds timeout
            Serial.println("\nWiFi connection failed, restarting...");
            ESP.restart();
         }
     }
     Serial.println("\nWiFi connected!");
     Serial.print("IP Address: "); Serial.println(WiFi.localIP());
}

// --- MQTT Reconnect function (no changes needed) ---
void reconnectMqtt() {
    // Loop until we're reconnected
    while (!mqttClient.connected()) {
        Serial.print("Attempting MQTT connection to ");
        Serial.print(mqttServer);
        Serial.print(" as ");
        Serial.print(mqttClientId);
        Serial.print("...");
        // Attempt to connect
        if (mqttClient.connect(mqttClientId)) {
            Serial.println("connected");
            // Subscribe to the command topic
            if (mqttClient.subscribe(commandTopic)) {
                Serial.print("Subscribed to: "); Serial.println(commandTopic);
                publishState(true); // Publish initial state with fresh color read
                lastStateReportTime = millis();
                lastColorReadTime = millis(); // Reset color timer too
            } else {
                Serial.println("MQTT Subscription failed!");
                 mqttClient.disconnect(); // Disconnect if subscribe failed
                delay(5000); // Wait before retrying connection
            }
        } else {
            Serial.print("failed, rc=");
            Serial.print(mqttClient.state());
            Serial.println(" try again in 5 seconds");
            // Wait 5 seconds before retrying
            delay(5000);
        }
    }
}