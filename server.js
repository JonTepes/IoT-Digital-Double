// TODO: Remember to install dependencies: npm install express socket.io mqtt node-fetch@2
const express = require('express');
const { createServer } = require("http");
const { Server } = require("socket.io");
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { /* options */ });

const port = 3000;

// Serve static files from the digital_double directory
app.use(express.static(path.join(__dirname, 'digital_double')));

// MJPG stream proxy
app.get('/camera_stream', async (req, res) => {
  // TODO: Change to http://iotlinija.ddns.net:8081/?action=stream if needed
  const streamUrl = 'http://iotlinija.ddns.net:8081/?action=stream';
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

const mqttClient = mqtt.connect('mqtt://192.168.1.150:1883');

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe('factory/data');
});

mqttClient.on('message', (topic, message) => {
  console.log(`Received message on topic ${topic}: ${message.toString()}`);
  io.emit('mqtt_message', { topic: topic, message: message.toString() });
});

io.on("connection", (socket) => {
  console.log('a user connected');
  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});