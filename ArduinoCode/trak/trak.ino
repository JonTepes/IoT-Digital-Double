#include <WiFi.h>
#include <PubSubClient.h>
#include <AccelStepper.h>
#include <Wire.h>
#include <Adafruit_TCS34725.h>
#include <ArduinoJson.h>
#include <math.h> // For round()
#include <ESP32Servo.h> // Vključite knjižnico ESP32Servo

// --- Definicije pinov ---
#define CONVEYOR_P1 1 // IN1
#define CONVEYOR_P2 2 // IN2
#define CONVEYOR_P3 3 // IN3
#define CONVEYOR_P4 4 // IN4
// --- Definicije podajalnega servomotorja ---
#define FEEDER_SERVO_PIN 21 // GPIO pin za podajalni servomotor
const int SERVO_LEFT_ANGLE = 10;  // Kot za potiskanje bloka (po potrebi prilagodite)
const int SERVO_RIGHT_ANGLE = 80; // Kot za mirovanje (po potrebi prilagodite)

// --- Zastavica za omogočanje barvnega senzorja ---
const bool ENABLE_COLOR_SENSOR = true; // Nastavite na true, če ima ta tekoči trak barvni senzor

// --- Zastavica za omogočanje podajalnega servomotorja ---
const bool ENABLE_FEEDER_SERVO = true; // Nastavite na true, če ima ta tekoči trak podajalni servomotor

AccelStepper conveyorStepper(AccelStepper::HALF4WIRE, CONVEYOR_P1, CONVEYOR_P3, CONVEYOR_P2, CONVEYOR_P4);

// --- Nastavitve motorja ---
// Hitrost in pospešek ostajata v KORAKIH na sekundo
const float CONVEYOR_MAX_SPEED = 800.0; // steps/sec
const float CONVEYOR_ACCEL = 300.0;     // steps/sec^2

// Faktorji pretvorbe za tekoči trak
const float STEPS_PER_MOVEMENT = 1000.0;
const float CM_PER_MOVEMENT = 1.5;
const float STEPS_PER_CM = STEPS_PER_MOVEMENT / CM_PER_MOVEMENT; // Steps per cm (~666.67)
const float CM_PER_STEP = CM_PER_MOVEMENT / STEPS_PER_MOVEMENT; // Cm per step (0.0015)

// --- WiFi ---
// Uncomment and fill in your WiFi credentials if not using credentials.h
// const char* ssid = "YOUR_WIFI_SSID";
// const char* password = "YOUR_WIFI_PASSWORD";
#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.32";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-conveyor";
const char* commandTopic = "assemblyline/conveyor/command";
const char* stateTopic = "assemblyline/conveyor/state";

// --- Globalni objekti ---
WiFiClient espClient;
PubSubClient mqttClient(espClient);
Adafruit_TCS34725 tcs = Adafruit_TCS34725(TCS34725_INTEGRATIONTIME_2_4MS, TCS34725_GAIN_16X);
Servo feederServo; // Ustvarite objekt Servo za ESP32Servo

// --- Timing & State ---
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250; // Kako pogosto periodično objavljati stanje
unsigned long lastColorReadTime = 0;
const long colorReadInterval = 250;   // Kako pogosto brati senzor

bool sensorInitialized = false;
String currentStatus = "INIT";

// --- Raw Color Storage ---
uint16_t raw_r = 0;
uint16_t raw_g = 0;
uint16_t raw_b = 0;
uint16_t raw_c = 0;
bool colorValuesHaveChanged = true; // Zastavica za prisilno začetno objavo

// --- Prototipi funkcij ---
void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishState();
void readColorSensor();
void controlFeederServo(const char* action); // Prototip za nadzor podajalnega servomotorja
long cmToSteps(float cm); // Pomožna funkcija
float stepsToCm(long steps);   // Pomožna funkcija

void setup() {
    Serial.begin(115200); // Inicializirajte serijsko povezavo za odpravljanje napak
    Serial.println("Booting Conveyor Controller (Units: CM)...");

    setupWifi();

    // Inicializirajte I2C za barvni senzor
    if (ENABLE_COLOR_SENSOR) {
        if (!Wire.begin()) {
            Serial.println("Failed to start I2C communication.");
            sensorInitialized = false;
        } else {
            Serial.println("I2C Initialized.");
            if (tcs.begin()) {
                Serial.println("Found TCS34725 sensor");
                sensorInitialized = true;
                readColorSensor(); // Pridobite začetno branje
            } else {
                Serial.println("No TCS34725 found ... check your connections");
                sensorInitialized = false;
            }
        }
    } else {
        Serial.println("Color sensor disabled by ENABLE_COLOR_SENSOR flag.");
        sensorInitialized = false; // Zagotovite, da je false, če je senzor onemogočen
    }

    // Inicializirajte podajalni servomotor
    if (ENABLE_FEEDER_SERVO) {
        feederServo.setPeriodHertz(50); // Standard 50hz servo
        feederServo.attach(FEEDER_SERVO_PIN, 500, 2500); // Priklopi servo na FEEDER_SERVO_PIN na servo objekt, z min/max širino impulza
        feederServo.write(SERVO_RIGHT_ANGLE); // Nastavite na mirovanje
        Serial.println("Feeder servo initialized using ESP32Servo.");
    } else {
        Serial.println("Feeder servo disabled by ENABLE_FEEDER_SERVO flag.");
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
    // Zanka PubSubClient je ključna za prejemanje sporočil in vzdrževanje povezave
    if (mqttClient.connected()) {
         mqttClient.loop();
    }


    // conveyorStepper.run() MORA biti klican čim pogosteje
    // Ta funkcija ne blokira in potrebuje pogoste klice za upravljanje korakov
    conveyorStepper.run();

    unsigned long now = millis();

    // Periodično berite barvni senzor (manj pogosto)
    if (ENABLE_COLOR_SENSOR && sensorInitialized && (now - lastColorReadTime > colorReadInterval)) {
        readColorSensor(); // Posodobite globalne spremenljivke raw_r/g/b/c
        lastColorReadTime = now;
    }

    // --- Logika objavljanja stanja ---
    // Preverite, ali se motor trenutno premika (še vedno na podlagi notranjega števila korakov)
    bool isRunning = (conveyorStepper.distanceToGo() != 0);
    String newStatus = isRunning ? "MOVING" : "IDLE";
    bool statusChanged = (newStatus != currentStatus);

    // Takoj objavite stanje, če se status spremeni (npr. ustavljen)
    // ali če so se barvne vrednosti spremenile od zadnje objave
    if (statusChanged || colorValuesHaveChanged) {
        currentStatus = newStatus;
        publishState();
        lastStateReportTime = now; // Ponastavite periodični časovnik
    }
    else {
        // Periodično objavljajte stanje, če je časovnik potekel, tudi če se nič ni spremenilo
        if (now - lastStateReportTime > stateReportInterval) {
            publishState();
            lastStateReportTime = now; // Ponastavite časovnik
        }
    }
}

// --- Pomožna funkcija za pretvorbo centimetrov v korake ---
long cmToSteps(float cm) {
    return round(cm * STEPS_PER_CM);
}

// --- Pomožna funkcija za pretvorbo korakov v centimetre ---
float stepsToCm(long steps) {
    return (float)steps * CM_PER_STEP;
}


// MQTT povratni klic: Obravnava dohodne ukaze (pričakuje pozicijo v CM)
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    Serial.print("Message arrived [");
    Serial.print(topic);
    Serial.print("] ");
    payload[length] = '\0'; // Null-terminirajte vsebino
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
         Serial.println("JSON manjka ključ 'command'.");
         return;
    }

    const char* command = doc["command"];
    String cmdStr = String(command);
    Serial.print("Received command: "); Serial.println(cmdStr);


    if (cmdStr == "MOVE_ABS") {
        if (doc.containsKey("value")) {
            float targetPosCm = doc["value"]; // Predpostavite, da je vrednost v CM
            long targetPosSteps = cmToSteps(targetPosCm);
            Serial.print("  MOVE_ABS: "); Serial.print(targetPosCm);
            Serial.print(" cm -> "); Serial.print(targetPosSteps); Serial.println(" steps");
            conveyorStepper.moveTo(targetPosSteps);
        } else { Serial.println("  MOVE_ABS missing 'value'"); }
    } else if (cmdStr == "MOVE_REL") {
        if (doc.containsKey("value")) {
            float relativeMoveCm = doc["value"]; // Predpostavite, da je vrednost relativna CM
            long relativeMoveSteps = cmToSteps(relativeMoveCm);
            Serial.print("  MOVE_REL: "); Serial.print(relativeMoveCm);
            Serial.print(" cm -> "); Serial.print(relativeMoveSteps); Serial.println(" steps");
            conveyorStepper.move(relativeMoveSteps);
        } else { Serial.println("  MOVE_REL missing 'value'"); }
    } else if (cmdStr == "STOP") {
        Serial.println("  STOP command received.");
        // Za "takojšnjo zaustavitev" začasno nastavite pospešek na zelo visoko vrednost
        conveyorStepper.setAcceleration(100000.0); // Zelo visoka vrednost pospeška
        conveyorStepper.stop(); // To se bo zdaj ustavilo skoraj takoj
        // Takoj ponastavite pospešek na prvotno vrednost za prihodnje premike
        conveyorStepper.setAcceleration(CONVEYOR_ACCEL);
    } else if (cmdStr == "GET_STATE") {
        Serial.println("  GET_STATE command received.");
        if (ENABLE_COLOR_SENSOR && sensorInitialized) {
            readColorSensor();
        }
        publishState(); // Objavite s potencialno posodobljenimi barvnimi podatki
        lastStateReportTime = millis(); // Ponastavite časovnik
    } else if (cmdStr == "FEED_BLOCK") {
        Serial.println("  FEED_BLOCK command received.");
        if (ENABLE_FEEDER_SERVO) {
            controlFeederServo("PUSH");
        } else {
            Serial.println("  Podajalni servomotor je onemogočen.");
        }
    } else {
        Serial.print("  Neznan ukaz: "); Serial.println(cmdStr);
    }
}

// Bere senzor in posodablja globalne spremenljivke
void readColorSensor() {
    if (!sensorInitialized) {
        // Če senzor postane nedosegljiv, ponastavite vrednosti in označite spremembo
        if (raw_r != 0 || raw_g != 0 || raw_b != 0 || raw_c != 0) {
             raw_r = 0; raw_g = 0; raw_b = 0; raw_c = 0;
             colorValuesHaveChanged = true;
        }
        return;
    }

    // Preberite podatke senzorja
    uint16_t r, g, b, c;
    tcs.getRawData(&r, &g, &b, &c);

    // Preverite, ali so se vrednosti dejansko spremenile, preden posodobite globalne spremenljivke in zastavico
    if (r != raw_r || g != raw_g || b != raw_b || c != raw_c) {
        raw_r = r;
        raw_g = g;
        raw_b = b;
        raw_c = c;
        colorValuesHaveChanged = true; // Označite, da se je barva spremenila od zadnje preverbe objave
    }
}

// Objavlja stanje (pozicija v CM)
void publishState() {
    if (!mqttClient.connected()) {
        Serial.println("Cannot publish state: MQTT not connected.");
        return;
    }

    // Ustvarite JSON dokument z uporabo trenutnih globalnih vrednosti
    StaticJsonDocument<256> doc;

    // Pridobite trenutno pozicijo v korakih in pretvorite v CM
    long currentSteps = conveyorStepper.currentPosition();
    float currentCm = stepsToCm(currentSteps);

    doc["status"] = currentStatus; // Posodobljeno v zanki()
    doc["position"] = currentCm;   // Objavite pozicijo v CM
    doc["sensor_ok"] = ENABLE_COLOR_SENSOR && sensorInitialized; // Poročajte o statusu senzorja na podlagi zastavice in inicializacije
    doc["timestamp"] = millis(); // Uporabite čas delovanja plošče kot časovni žig

    if (ENABLE_COLOR_SENSOR && sensorInitialized) {
        doc["color_r"] = raw_r;
        doc["color_g"] = raw_g;
        doc["color_b"] = raw_b;
        doc["color_c"] = raw_c;
    }

    // Serializirajte JSON v medpomnilnik
    char jsonBuffer[256];
    size_t n = serializeJson(doc, jsonBuffer);

    // Objavite JSON niz
    if (mqttClient.publish(stateTopic, jsonBuffer, n)) {
        colorValuesHaveChanged = false; // Ponastavite zastavico SAMO, če je bila objava uspešna
    } else {
        Serial.println("  State publish FAILED.");
    }
}

// --- Funkcija za nastavitev WiFi (ni potrebnih sprememb) ---
void setupWifi() {
     Serial.print("Connecting to WiFi: "); Serial.println(ssid);
     WiFi.mode(WIFI_STA);
     WiFi.begin(ssid, password);
     int connection_attempts = 0;
     while (WiFi.status() != WL_CONNECTED) {
         delay(500);
         Serial.print(".");
         connection_attempts++;
         if (connection_attempts > 40) {
            Serial.println("\nWiFi connection failed, restarting...");
            ESP.restart();
         }
     }
     Serial.println("\nWiFi connected!");
     Serial.print("IP Address: "); Serial.println(WiFi.localIP());
}

// --- Funkcija za ponovno povezavo MQTT (ni potrebnih sprememb) ---
void reconnectMqtt() {
    // Zanka, dokler se ne ponovno povežemo
    while (!mqttClient.connected()) {
        Serial.print("Attempting MQTT connection to ");
        Serial.print(mqttServer);
        Serial.print(" as ");
        Serial.print(mqttClientId);
        Serial.print("...");
        // Poskus povezave
        if (mqttClient.connect(mqttClientId)) {
            Serial.println("connected");
            // Naročite se na temo ukazov
            if (mqttClient.subscribe(commandTopic)) {
                Serial.print("Subscribed to: "); Serial.println(commandTopic);
                if (ENABLE_COLOR_SENSOR && sensorInitialized) {
                    readColorSensor();
                }
                publishState(); // Objavite začetno stanje s potencialno svežim branjem barve
                lastStateReportTime = millis();
                lastColorReadTime = millis(); // Ponastavite tudi barvni časovnik
            } else {
                Serial.println("MQTT Subscription failed!");
                 mqttClient.disconnect(); // Prekinite povezavo, če naročnina ni uspela
                delay(5000); // Počakajte pred ponovnim poskusom povezave
            }
        } else {
            Serial.print("failed, rc=");
            Serial.print(mqttClient.state());
            Serial.println(" try again in 5 seconds");
            // Počakajte 5 sekund pred ponovnim poskusom
            delay(5000);
        }
    }
}

// --- Funkcija za nadzor podajalnega servomotorja ---
void controlFeederServo(const char* action) {
    if (strcmp(action, "PUSH") == 0) {
        Serial.println("Feeder: Pushing block...");
        feederServo.write(SERVO_LEFT_ANGLE); // Premaknite se v položaj potiskanja
        delay(500); // Počakajte, da se servo premakne
        feederServo.write(SERVO_RIGHT_ANGLE); // Vrnite se v položaj mirovanja
        Serial.println("Feeder: Returned to resting position.");
    } else {
        Serial.print("Unknown feeder action: ");
        Serial.println(action);
    }
}