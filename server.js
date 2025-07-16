const express = require('express');
const { createServer } = require("http");
const { Server } = require("socket.io");
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
// Uncomment and fill in your configuration if not using config.js
// const config = {
//   port: 3000,
//   cameraStreamUrl: 'http://localhost:8081/?action=stream',
//   mqttBrokerUrl: 'mqtt://localhost:1883'
// };
const config = require('./config');
const FactoryAutomation = require('./FactoryAutomation'); // Import FactoryAutomation

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {});

const port = config.port;

// Strežite statične datoteke iz imenika digital_twin
app.use(express.static(path.join(__dirname, 'digital_twin')));

// MJPG pretočni proxy
app.get('/camera_stream', async (req, res) => {
  const streamUrl = config.cameraStreamUrl;
  try {
    const response = await fetch(streamUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch stream: ${response.status} ${response.statusText}`);
    }

    // Copy all headers from the camera stream response to the proxy response
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    response.body.pipe(res);
  } catch (error) {
    console.error(`Error fetching camera stream from ${streamUrl}:`, error.message);
    res.status(500).send('Error fetching camera stream. Check server logs for details.');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'digital_twin', 'index.html'));
});

const mqttClient = mqtt.connect(config.mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  // FactoryAutomation bo upravljal lastne naročnine
});

// Ustvarite instanco FactoryAutomation po razpoložljivosti mqttClient in io
let factoryAutomation;

mqttClient.on('message', (topic, message) => {
  // Oddajte vsa MQTT sporočila povezanim Socket.IO odjemalcem za posodobitve digitalnega dvojčka
  io.emit('mqtt_message', { topic: topic, message: message.toString() });

  // Posredujte relevantna MQTT sporočila FactoryAutomation za avtomatizacijsko logiko
  if (factoryAutomation) {
    factoryAutomation.handleMqttMessage(topic, message.toString());
  }
});

io.on("connection", (socket) => {
  console.log('a user connected');
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });

  // Ponovno dodajte poslušalca publish_mqtt za ročne kontrole
  socket.on('publish_mqtt', (data) => {
    const { topic, message } = data;
    console.log(`Received publish request from client for topic ${topic}: ${message}`);
    mqttClient.publish(topic, message);
  });

  // Obravnavajte zahteve odjemalcev za zagon/ustavitev avtomatizacijskih programov
  socket.on('start_program', (data) => {
    console.log(`Client requested to start program: ${data.programName}`);
    if (factoryAutomation) {
      factoryAutomation.start();
    }
  });

  socket.on('stop_program', () => {
    console.log('Client requested to stop program.');
    if (factoryAutomation) {
      factoryAutomation.stop();
    }
  });

  // Obravnavajte zahteve odjemalcev za preklop avtomatizacijskih programov
  socket.on('switch_program', (data) => {
    console.log(`Client requested to switch program to: ${data.programName}`);
    if (factoryAutomation) {
      factoryAutomation.switchAutomationProgram(data.programName);
    }
  });

  // Dovolite odjemalcem, da se neposredno naročijo/odjavijo na MQTT teme, če je potrebno za druge funkcije
  socket.on('subscribe_mqtt', (topic) => {
    console.log(`Client requested subscription to topic: ${topic}`);
    mqttClient.subscribe(topic, (err) => {
      if (err) {
        console.error(`Failed to subscribe to ${topic} for client:`, err);
      } else {
        console.log(`Successfully subscribed to ${topic} for client.`);
      }
    });
  });

  socket.on('unsubscribe_mqtt', (topic) => {
    console.log(`Client requested unsubscription from topic: ${topic}`);
    mqttClient.unsubscribe(topic, (err) => {
      if (err) {
        console.error(`Failed to unsubscribe from ${topic} for client:`, err);
      } else {
        console.log(`Successfully unsubscribed from ${topic} for client.`);
      }
    });
  });
});

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  // Inicializirajte FactoryAutomation po zagonu strežnika in povezavi MQTT odjemalca
  factoryAutomation = new FactoryAutomation(mqttClient, io);
  factoryAutomation.initialize();
});