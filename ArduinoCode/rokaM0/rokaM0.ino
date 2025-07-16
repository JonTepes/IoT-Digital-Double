#include <WiFi.h>
#include <PubSubClient.h>
#include <AccelStepper.h>
#include <ArduinoJson.h>
#include <math.h>

// --- Definicije pinov ---
#define M0_P1 10
#define M0_P2 2
#define M0_P3 3
#define M0_P4 4
#define POTENTIOMETER_PIN 1

AccelStepper stepper0(AccelStepper::FULL4WIRE, M0_P1, M0_P3, M0_P2, M0_P4);

const float MAX_SPEED_REGULAR = 390.0;
const float ACCEL_REGULAR = 500.0;
const int MOTOR_ID = 0;

const float STEPS_PER_REVOLUTION = 4096.0;
const float DEGREES_PER_REVOLUTION = 360.0;
const float STEPS_PER_DEGREE = STEPS_PER_REVOLUTION / DEGREES_PER_REVOLUTION;
const float DEGREES_PER_STEP = DEGREES_PER_REVOLUTION / STEPS_PER_REVOLUTION;

// Uncomment and fill in your WiFi credentials if not using credentials.h
// const char* ssid = "YOUR_WIFI_SSID";
// const char* password = "YOUR_WIFI_PASSWORD";
#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.32";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-crane-m0-consolidated";
const char* commandTopic = "assemblyline/crane/command";
const char* motorStateTopic = "assemblyline/crane/motor_state"; // izhodna tema

WiFiClient espClient;
PubSubClient mqttClient(espClient);
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250;

const int ADC_AT_ZERO_DEGREES = 1322;
const float ANGLE_AT_ZERO_DEGREES_POINT = -9.0f;
const int ADC_AT_NINETY_DEGREES = 1992;
const float ANGLE_AT_NINETY_DEGREES_POINT = -90.0f;
const float DEGREES_PER_ADC_TICK = (ANGLE_AT_NINETY_DEGREES_POINT - ANGLE_AT_ZERO_DEGREES_POINT) / (ADC_AT_NINETY_DEGREES - ADC_AT_ZERO_DEGREES);

int g_lastRawAdcValue = 0;
float g_smoothedAdcValue = 0.0;
float g_controlPotAngleDegrees = 0.0f;
float g_reportedPotAngleDegrees = 0.0f;

// For averaging potentiometer readings
const int NUM_READINGS_TO_AVERAGE = 30;
int g_adcReadings[NUM_READINGS_TO_AVERAGE];
int g_adcReadingsIndex = 0;
bool g_adcBufferFilled = false;

const float ANGLE_QUANTIZATION_STEP = 0.5f;

float g_targetPotAngleDegrees = 0.0f;
bool g_controlLoopActive = false;
const float ANGLE_TOLERANCE = 1.0f;

const float KP_GAIN = 1.0f; // Proportional gain for speed control (degrees/sec per degree of error)
const float MAX_MOTOR_SPEED_DEGREES_PER_SEC = 390.0f; // Max speed in degrees/sec
const float MOTOR_DIRECTION_FACTOR = 1.0f; // Prilagodite, če je treba smer motorja obrniti

void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishMotorStates(); // To bo zdaj vključevalo podatke potenciometra
void updatePotentiometerAngles();
long degreesToSteps(float degrees);
float stepsToDegrees(long steps);

void setup() {
    stepper0.setMaxSpeed(MAX_SPEED_REGULAR);
    stepper0.setAcceleration(ACCEL_REGULAR);
    stepper0.setCurrentPosition(0);
    pinMode(POTENTIOMETER_PIN, INPUT);
    updatePotentiometerAngles();
    g_targetPotAngleDegrees = g_controlPotAngleDegrees;
    g_controlLoopActive = false; // Start in idle mode
    setupWifi();
    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
}

void loop() {
    if (!mqttClient.connected()) {
        reconnectMqtt();
    }
    mqttClient.loop();
    updatePotentiometerAngles();

    if (g_controlLoopActive) {
        float error = g_targetPotAngleDegrees - g_controlPotAngleDegrees;
        float absError = abs(error);

        // hitrost se spreminja glede an oddaljenost od tarče
        float desiredSpeedDegreesPerSec = error * KP_GAIN;

        // Poskrbimo za maksimalno hitrost
        if (abs(desiredSpeedDegreesPerSec) > MAX_MOTOR_SPEED_DEGREES_PER_SEC) {
            desiredSpeedDegreesPerSec = copysign(MAX_MOTOR_SPEED_DEGREES_PER_SEC, desiredSpeedDegreesPerSec);
        }

        // Če je izmerjena pozicija zelo blizu tarči, se neha premikati 
        // (to prepreči neskončno "lovljenje" točne pozicije)
        if (absError <= ANGLE_TOLERANCE) {
            desiredSpeedDegreesPerSec = 0;
        }

        // Pretvorba iz stopinj na sekundo v korak na sekundo
        float desiredSpeedStepsPerSec = desiredSpeedDegreesPerSec * STEPS_PER_DEGREE * MOTOR_DIRECTION_FACTOR;
        stepper0.setSpeed(desiredSpeedStepsPerSec);
    } else {
        // Če krmilna zanka ni aktivna, zagotovimo da je motor ustavljen
        stepper0.setSpeed(0);
    }

    stepper0.run();

    unsigned long now = millis();
    if (now - lastStateReportTime > stateReportInterval && mqttClient.connected()) {
        publishMotorStates(); // This now includes pot data
        lastStateReportTime = now;
    }
}

void updatePotentiometerAngles() {
    g_lastRawAdcValue = analogRead(POTENTIOMETER_PIN);

    // Store the new reading in the buffer
    g_adcReadings[g_adcReadingsIndex] = g_lastRawAdcValue;
    g_adcReadingsIndex = (g_adcReadingsIndex + 1) % NUM_READINGS_TO_AVERAGE;

    // If the buffer is not yet filled, only average the readings collected so far
    if (!g_adcBufferFilled && g_adcReadingsIndex == 0) {
        g_adcBufferFilled = true;
    }

    // Calculate the sum of readings in the buffer
    long sumReadings = 0;
    int count = g_adcBufferFilled ? NUM_READINGS_TO_AVERAGE : g_adcReadingsIndex;
    for (int i = 0; i < count; i++) {
        sumReadings += g_adcReadings[i];
    }

    // Calculate the average
    g_smoothedAdcValue = (float)sumReadings / count;

    g_controlPotAngleDegrees = (g_smoothedAdcValue - (float)ADC_AT_ZERO_DEGREES) * DEGREES_PER_ADC_TICK + ANGLE_AT_ZERO_DEGREES_POINT;
    g_reportedPotAngleDegrees = round(g_controlPotAngleDegrees / ANGLE_QUANTIZATION_STEP) * ANGLE_QUANTIZATION_STEP;
}

long degreesToSteps(float degrees) { return round(degrees * STEPS_PER_DEGREE); }
float stepsToDegrees(long steps) { return steps * DEGREES_PER_STEP; }

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    payload[length] = '\0';
    String message = String((char*)payload);
    message.toUpperCase();
    if (String(topic) == commandTopic) {
        StaticJsonDocument<256> doc; // Increased size for JSON parsing
        DeserializationError error = deserializeJson(doc, payload, length);

        if (error) {
            Serial.print(F("deserializeJson() failed: "));
            Serial.println(error.f_str());
            // Fallback to old string parsing for non-JSON commands
            if (message.startsWith("STOP ")) {
                 String indexStr = message.substring(5);
                 indexStr.trim();
                 if (indexStr.length() > 0) {
                    int motorIndex = indexStr.toInt();
                    if (motorIndex == MOTOR_ID) {
                        g_controlLoopActive = false; // Deactivate control loop
                        stepper0.setSpeed(0); // Stop the motor
                        publishMotorStates(); // Publish updated state immediately
                    }
                 }
            } else if (message == "GETPOS") {
                publishMotorStates(); // Publish current consolidated state
            } else {
                Serial.println("Unknown command format received.");
            }
        } else {
            // Uspešno razčlenjevanje JSON
            const char* command = doc["command"];
            if (command && String(command) == "move_all") {
                JsonArray motors = doc["motors"].as<JsonArray>();
                if (motors) {
                    for (JsonObject motor : motors) {
                        int motorId = motor["id"];
                        float pos = motor["pos"]; // To bo v stopinjah za M0

                        if (motorId == MOTOR_ID) { // Motor 0
                            g_targetPotAngleDegrees = pos;
                            g_controlLoopActive = true; // Aktivirajte krmilno zanko
                            publishMotorStates();
                        }
                    }
                }
            } else {
                Serial.println("Prejet neznan JSON ukaz.");
            }
        }
    }
}

void publishMotorStates() {
    if (!mqttClient.connected()) return;

    // velikost JSON dokumenta za podatke potenciometra
    StaticJsonDocument<250> doc0;
    char jsonBuffer[250];


    long currentStepperInternalPos = stepper0.currentPosition();
    float internalStepperDegrees = stepsToDegrees(currentStepperInternalPos);
    doc0["motor"] = MOTOR_ID;
    doc0["stepper_pos_deg"] = round(internalStepperDegrees * 10.0)/10.0;

    // Report state based on control loop activity and error
    if (g_controlLoopActive) {
        float error = g_targetPotAngleDegrees - g_controlPotAngleDegrees;
        float absError = abs(error);
        if (absError <= ANGLE_TOLERANCE) { // Use the same smaller tolerance for reporting "IDLE"
            doc0["state"] = "IDLE"; // Motor is effectively stopped at target
        } else {
            doc0["state"] = "MOVING";
        }
    } else {
        doc0["state"] = "IDLE"; // Control loop not active, motor is idle
    }

    doc0["target_pot_angle"] = round(g_targetPotAngleDegrees * 10.0)/10.0;

    // Dodajte podatke potenciometra k tej vsebini
    doc0["pos"] = g_reportedPotAngleDegrees; // Kvantiziran kot za prikaz
    doc0["pot_raw"] = g_lastRawAdcValue;

    serializeJson(doc0, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);
}

void setupWifi() {
     delay(10);
     WiFi.mode(WIFI_STA);
     WiFi.begin(ssid, password);
     int connection_attempts = 0;
     while (WiFi.status() != WL_CONNECTED) {
         delay(500);
         connection_attempts++;
         if (connection_attempts > 40) { delay(5000); ESP.restart(); }
     }
}

void reconnectMqtt() {
    while (!mqttClient.connected()) {
        if (mqttClient.connect(mqttClientId)) {
            if (mqttClient.subscribe(commandTopic)) {
                 updatePotentiometerAngles();
                 g_targetPotAngleDegrees = g_controlPotAngleDegrees;
                 g_controlLoopActive = false; // Zagotovite, da je krmilna zanka sprva izklopljena
                 publishMotorStates(); // Objavite začetno konsolidirano stanje
             } else { delay(500); }
         } else { delay(500); }
     }
}