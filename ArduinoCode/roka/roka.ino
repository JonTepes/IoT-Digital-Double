#include <WiFi.h>
#include <PubSubClient.h>
#include <AccelStepper.h>
#include <ArduinoJson.h> // For creating JSON status messages
#include <math.h>       // For round()

// --- Definicije pinov ---
// Motor 1 (Naprej/Nazaj) - Povezan na ta ESP
#define M1_P1 1  // Verify these pins are free and work on this ESP
#define M1_P2 2
#define M1_P3 3
#define M1_P4 4
// Motor 2 (Gor/Dol) - Povezan na ta ESP
#define M2_P1 5  // Verify these pins are free and work on this ESP
#define M2_P2 6
#define M2_P3 7
#define M2_P4 8

// Pin elektromagneta
#define MAGNET_PIN 0 // Using GPIO0 for the electromagnet relay/driver

// --- Objekti motorjev ---
AccelStepper stepper1(AccelStepper::FULL4WIRE, M1_P1, M1_P3, M1_P2, M1_P4);
AccelStepper stepper2(AccelStepper::FULL4WIRE, M2_P1, M2_P3, M2_P2, M2_P4);

// ID-ji motorjev za poročanje
const int MOTOR_IDS[2] = {1, 2}; // Global IDs for these motors

// --- Nastavitve motorjev ---
// Opomba: Hitrost in pospešek sta še vedno v KORAKIH/SEK in KORAKIH/SEK^2
const float MAX_SPEED_NORMAL = 390.0;  // Steps per second
const float ACCEL_NORMAL = 1000.0;     // Steps per second^2

// Faktorji pretvorbe za linearne motorje
const float STEPS_PER_MOVEMENT = 10000.0;
const float CM_PER_MOVEMENT = 17.5;
const float STEPS_PER_CM = STEPS_PER_MOVEMENT / CM_PER_MOVEMENT; // Steps per cm (~571.43)
const float CM_PER_STEP = CM_PER_MOVEMENT / STEPS_PER_MOVEMENT; // Cm per step (~0.00175)

// --- WiFi ---
// Uncomment and fill in your WiFi credentials if not using credentials.h
// const char* ssid = "YOUR_WIFI_SSID";
// const char* password = "YOUR_WIFI_PASSWORD";
#include "credentials.h"

// --- MQTT ---
const char* mqttServer = "192.168.1.32";
const int mqttPort = 1883;
const char* mqttClientId = "esp32-crane-main-12"; // MORA BITI UNIKATEN
const char* commandTopic = "assemblyline/crane/command";       // Tukaj poslušajte ukaze
const char* motorStateTopic = "assemblyline/crane/motor_state"; // Tukaj objavite stanja posameznih komponent

// --- Globalni objekti ---
WiFiClient espClient;
PubSubClient mqttClient(espClient);
unsigned long lastStateReportTime = 0;
const long stateReportInterval = 250; // Interval poročanja (ms)

// Spremenljivka stanja magneta
bool magnetState = false; // Sprva IZKLOPLJENO

// --- Prototipi funkcij ---
void setupWifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishComponentStates(); // Objavite stanje za M1, M2 (v CM) in magnet posamezno
void setMagnet(bool state); // Funkcija za nadzor magneta
long cmToSteps(float cm); // Pomožna funkcija
float stepsToCm(long steps);   // Pomožna funkcija

void setup() {
    Serial.begin(115200); // Za odpravljanje napak TEGA ESP-ja
    Serial.println("ESP_Main (M1, M2, Magnet) Booting (Units: CM / Magnet State)...");

    // --- Konfiguriraj LOKALNE motorje ---
    // AccelStepper vedno deluje v korakih interno
    stepper1.setMaxSpeed(MAX_SPEED_NORMAL);
    stepper1.setAcceleration(ACCEL_NORMAL);
    stepper1.setCurrentPosition(0); // Začnite pri 0 korakih (predstavlja 0 cm)
    Serial.println("Stepper 1 (M1) Configured.");

    stepper2.setMaxSpeed(MAX_SPEED_NORMAL);
    stepper2.setAcceleration(ACCEL_NORMAL);
    stepper2.setCurrentPosition(0); // Začnite pri 0 korakih (predstavlja 0 cm)
    Serial.println("Stepper 2 (M2) Configured.");

    // --- Konfiguriraj pin magneta ---
    pinMode(MAGNET_PIN, OUTPUT);
    setMagnet(false); // Začnite z magnetom IZKLOPLJENO
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
    mqttClient.loop(); // Obdelajte MQTT sporočila

    // Zaženite lokalne koračne motorje (notranja obdelava korakov)
    stepper1.run();
    stepper2.run();

    // Periodično objavljajte stanje preko MQTT
    unsigned long now = millis();
    if (now - lastStateReportTime > stateReportInterval && mqttClient.connected()) {
        publishComponentStates(); // Objavite posamezna stanja (M1/M2 v CM)
        lastStateReportTime = now;
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

// Funkcija za nastavitev stanja magneta in posodobitev spremenljivke
void setMagnet(bool state) {
    digitalWrite(MAGNET_PIN, state ? HIGH : LOW); // HIGH = VKLOPLJENO, LOW = IZKLOPLJENO (Prilagodite, če je vaša relejna logika obrnjena)
    magnetState = state;
    Serial.print("Magnet set to: "); Serial.println(magnetState ? "ON" : "OFF");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    payload[length] = '\0';
    String message = String((char*)payload);
    Serial.print("MQTT Received ["); Serial.print(topic); Serial.print("]: "); Serial.println(message);

    if (String(topic) == commandTopic) {
        StaticJsonDocument<256> doc; // Povečana velikost za razčlenjevanje JSON
        DeserializationError error = deserializeJson(doc, payload, length);

        if (error) {
            Serial.print(F("deserializeJson() failed: "));
            Serial.println(error.f_str());
            // Nadomestna možnost za staro razčlenjevanje nizov za ukaze, ki niso JSON
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
                        Serial.println("Ignoriram ukaz STOP za neznan/oddaljen indeks motorja.");
                    }
                } else { Serial.println("Invalid STOP format (missing motor index)."); }
            } else if (message.startsWith("SET MAGNET ")) {
                String stateStr = message.substring(11);
                stateStr.trim();
                if (stateStr == "1") {
                    setMagnet(true); // Vklopite magnet
                    publishComponentStates(); // Publish immediate update
                } else if (stateStr == "0") {
                    setMagnet(false); // Izklopite magnet
                    publishComponentStates(); // Publish immediate update
                } else {
                    Serial.println("Neveljavna oblika SET MAGNET (uporabite 1 za VKLOP, 0 za IZKLOP).");
                }
            } else if (message == "GETSTATUS" || message == "GETPOS") {
                Serial.println("GETSTATUS/GETPOS received, publishing current component states (positions in CM).");
                publishComponentStates();
            } else {
                 Serial.println("Prejeta neznana oblika ukaza.");
            }
        } else {
            // Uspešno razčlenjevanje JSON
            const char* command = doc["command"];
            if (command && String(command) == "move_all") {
                JsonArray motors = doc["motors"].as<JsonArray>();
                if (motors) {
                    for (JsonObject motor : motors) {
                        int motorId = motor["id"];
                        float pos = motor["pos"]; // To bo v cm za M1 in M2

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
            } else if (command && String(command) == "set_magnet") { // Nov JSON ukaz za magnet
                bool state = doc["state"];
                setMagnet(state);
                publishComponentStates();
            } else {
                Serial.println("Prejet neznan JSON ukaz.");
            }
        }
    }
}

// Objavlja stanje M1, M2 (v CM) in magneta posamezno na motorStateTopic
void publishComponentStates() {
    if (!mqttClient.connected()) return;

    char jsonBuffer[128]; // Medpomnilnik za JSON podatke

    // --- Objavite stanje za motor 1 ---
    StaticJsonDocument<100> doc1;
    long currentSteps1 = stepper1.currentPosition();
    float currentCm1 = stepsToCm(currentSteps1); // Pretvori korake v CM
    doc1["motor"] = MOTOR_IDS[0]; // ID motorja = 1
    doc1["pos"] = currentCm1;      // Objavite pozicijo v CM
    doc1["state"] = (stepper1.distanceToGo() == 0) ? "IDLE" : "MOVING";
    serializeJson(doc1, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);

    // --- Objavite stanje za motor 2 ---
    StaticJsonDocument<100> doc2;
    long currentSteps2 = stepper2.currentPosition();
    float currentCm2 = stepsToCm(currentSteps2); // Pretvori korake v CM
    doc2["motor"] = MOTOR_IDS[1]; // ID motorja = 2
    doc2["pos"] = currentCm2;      // Objavite pozicijo v CM
    doc2["state"] = (stepper2.distanceToGo() == 0) ? "IDLE" : "MOVING";
    serializeJson(doc2, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer);

    // --- Objavite stanje za magnet ---
    StaticJsonDocument<100> docM;
    docM["component"] = "magnet"; // Uporabite ključ "component" za dele, ki niso motorji
    docM["state"] = magnetState ? 1 : 0; // 1 za VKLOP, 0 za IZKLOP
    serializeJson(docM, jsonBuffer);
    mqttClient.publish(motorStateTopic, jsonBuffer); // Objavite na isto temo
}

// --- Standardne WiFi in MQTT funkcije (nespremenjeno) ---
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
            // Naročite se na temo ukazov
            if (mqttClient.subscribe(commandTopic)) {
                 Serial.print("Subscribed to: ");
                 Serial.println(commandTopic);
                 // Objavite začetna stanja ob povezavi (pozicije v CM)
                 publishComponentStates();
            } else {
                Serial.println("MQTT Subscription failed! Retrying in 5s...");
                delay(5000);
            }
        } else {
            Serial.print("failed, rc=");
            Serial.print(mqttClient.state());
            Serial.println(" try again in 5 seconds");
            delay(5000); // Počakajte 5 sekund pred ponovnim poskusom
        }
    }
}