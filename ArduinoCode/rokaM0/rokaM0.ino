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

#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.150";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-crane-m0-consolidated"; // Consolidated Output
const char* commandTopic = "assemblyline/crane/command";
const char* motorStateTopic = "assemblyline/crane/motor_state"; // Single output topic

WiFiClient espClient;
PubSubClient mqttClient(espClient);
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250;
// No lastPotReportTime or potReportInterval needed as it's part of motorStateTopic

const int ADC_AT_ZERO_DEGREES = 670;
const float ANGLE_AT_ZERO_DEGREES_POINT = -170.0f;
const int ADC_AT_NINETY_DEGREES = 1995;
const float ANGLE_AT_NINETY_DEGREES_POINT = 190.0f;
const float DEGREES_PER_ADC_TICK = (ANGLE_AT_NINETY_DEGREES_POINT - ANGLE_AT_ZERO_DEGREES_POINT) / (ADC_AT_NINETY_DEGREES - ADC_AT_ZERO_DEGREES);

int g_lastRawAdcValue = 0;
float g_smoothedAdcValue = 0.0;
bool g_firstAdcReading = true;
float g_controlPotAngleDegrees = 0.0f;
float g_reportedPotAngleDegrees = 0.0f;

const float ADC_SMOOTHING_ALPHA = 0.05f;
const float ANGLE_QUANTIZATION_STEP = 2.5f;

float g_targetPotAngleDegrees = 0.0f;
bool g_controlLoopActive = false;
const float ANGLE_TOLERANCE = 2.5f;

const float KP_GAIN = 5.0f; // Proportional gain for speed control (degrees/sec per degree of error)
const float MAX_MOTOR_SPEED_DEGREES_PER_SEC = 390.0f; // Max speed in degrees/sec
const float MIN_MOTOR_SPEED_DEGREES_PER_SEC = 10.0f; // Min speed in degrees/sec (to avoid stalling)
const float MOTOR_DIRECTION_FACTOR = 1.0f; // Adjust if motor direction needs to be inverted

// No explicit states needed, just a flag for active control

void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishMotorStates(); // This will now include potentiometer data
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

        if (absError > ANGLE_TOLERANCE) {
            // Proportional control: speed is proportional to error
            float desiredSpeedDegreesPerSec = error * KP_GAIN;

            // Constrain speed within min/max limits
            if (abs(desiredSpeedDegreesPerSec) > MAX_MOTOR_SPEED_DEGREES_PER_SEC) {
                desiredSpeedDegreesPerSec = copysign(MAX_MOTOR_SPEED_DEGREES_PER_SEC, desiredSpeedDegreesPerSec);
            } else if (abs(desiredSpeedDegreesPerSec) < MIN_MOTOR_SPEED_DEGREES_PER_SEC) {
                // Only apply min speed if there's a significant error to avoid micro-movements
                if (absError > (ANGLE_TOLERANCE / 2.0f)) { // A small hysteresis
                    desiredSpeedDegreesPerSec = copysign(MIN_MOTOR_SPEED_DEGREES_PER_SEC, desiredSpeedDegreesPerSec);
                } else {
                    desiredSpeedDegreesPerSec = 0; // Stop if error is very small
                }
            }

            // Convert desired speed from degrees/sec to steps/sec
            float desiredSpeedStepsPerSec = desiredSpeedDegreesPerSec * STEPS_PER_DEGREE * MOTOR_DIRECTION_FACTOR;
            stepper0.setSpeed(desiredSpeedStepsPerSec);
        } else {
            // Within tolerance, stop the motor
            stepper0.setSpeed(0);
        }
    } else {
        // Control loop not active, ensure motor is stopped
        stepper0.setSpeed(0);
    }

    stepper0.run();

    unsigned long now = millis();
    if (now - lastStateReportTime > stateReportInterval && mqttClient.connected()) {
        publishMotorStates(); // This now includes pot data
        lastStateReportTime = now;
    }
    // No separate pot publishing block
}

void updatePotentiometerAngles() {
    g_lastRawAdcValue = analogRead(POTENTIOMETER_PIN);
    if (g_firstAdcReading) {
        g_smoothedAdcValue = g_lastRawAdcValue;
        g_firstAdcReading = false;
    } else {
        g_smoothedAdcValue = (ADC_SMOOTHING_ALPHA * g_lastRawAdcValue) + ((1.0f - ADC_SMOOTHING_ALPHA) * g_smoothedAdcValue);
    }
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
            // JSON parsing successful
            const char* command = doc["command"];
            if (command && String(command) == "move_all") {
                JsonArray motors = doc["motors"].as<JsonArray>();
                if (motors) {
                    for (JsonObject motor : motors) {
                        int motorId = motor["id"];
                        float pos = motor["pos"]; // This will be in degrees for M0

                        if (motorId == MOTOR_ID) { // Motor 0
                            g_targetPotAngleDegrees = pos;
                            g_controlLoopActive = true; // Activate control loop
                            publishMotorStates();
                        }
                    }
                }
            } else {
                Serial.println("Unknown JSON command received.");
            }
        }
    }
}

void publishMotorStates() {
    if (!mqttClient.connected()) return;

    // Increased JSON document size to accommodate potentiometer data
    StaticJsonDocument<250> doc0; // Was 200, increased a bit
    char jsonBuffer[250];


    long currentStepperInternalPos = stepper0.currentPosition();
    float internalStepperDegrees = stepsToDegrees(currentStepperInternalPos);
    doc0["motor"] = MOTOR_ID;
    doc0["stepper_pos_deg"] = round(internalStepperDegrees * 10.0)/10.0;

    // Report state based on control loop activity and error
    if (g_controlLoopActive) {
        float error = g_targetPotAngleDegrees - g_controlPotAngleDegrees;
        float absError = abs(error);
        if (absError <= ANGLE_TOLERANCE) {
            doc0["state"] = "HOLDING";
        } else {
            doc0["state"] = "MOVING";
        }
    } else {
        doc0["state"] = "IDLE";
    }

    doc0["target_pot_angle"] = round(g_targetPotAngleDegrees * 10.0)/10.0;

    // Add potentiometer data to this payload
    doc0["pos"] = g_reportedPotAngleDegrees; // The quantized angle for display
    doc0["pot_raw"] = g_lastRawAdcValue;
    // Optionally, publish the control angle for debugging if needed:
    // doc0["pot_control_angle_deg"] = round(g_controlPotAngleDegrees * 100.0) / 100.0;

    serializeJson(doc0, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);
}

// No publishPotentiometerAngle() function needed anymore

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
                 g_controlLoopActive = false; // Ensure control loop is off initially
                 publishMotorStates(); // Publish initial consolidated state
             } else { delay(500); }
         } else { delay(500); }
     }
}