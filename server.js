const express = require('express');
const { createServer } = require("http");
const { Server } = require("socket.io");
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('./config');
const FactoryAutomation = require('./FactoryAutomation'); // Import FactoryAutomation

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { /* options */ });

const port = config.port;

// Serve static files from the digital_double directory
app.use(express.static(path.join(__dirname, 'digital_double')));

// MJPG stream proxy
app.get('/camera_stream', async (req, res) => {
  // TODO: Change to http://iotlinija.ddns.net:8081/?action=stream if needed
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
  res.sendFile(path.join(__dirname, 'digital_double', 'index.html'));
});

const mqttClient = mqtt.connect(config.mqttBrokerUrl);

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  // FactoryAutomation will handle its own subscriptions
});

// Instantiate FactoryAutomation after mqttClient and io are available
let factoryAutomation;

mqttClient.on('message', (topic, message) => {
  // Emit all MQTT messages to connected Socket.IO clients for digital twin updates
  io.emit('mqtt_message', { topic: topic, message: message.toString() });

  // Forward relevant MQTT messages to FactoryAutomation for automation logic
  if (factoryAutomation) {
    factoryAutomation.handleMqttMessage(topic, message.toString());
  }
});

io.on("connection", (socket) => {
  console.log('a user connected');
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });

  // Handle client requests to start/stop automation programs
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

  // Allow clients to subscribe/unsubscribe to MQTT topics directly if needed for other features
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
  // Initialize FactoryAutomation after server starts and MQTT client is connected
  factoryAutomation = new FactoryAutomation(mqttClient, io);
  factoryAutomation.initialize();
});