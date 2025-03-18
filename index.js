require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// Kết nối MongoDB Atlas
const uri = process.env.MONGODB_URI || "";
if (!uri) {
  console.error("MONGODB_URI is not set. Please configure it in environment variables.");
  process.exit(1);
}
const client = new MongoClient(uri);
let isDbConnected = false;

async function connectDB() {
  try {
    await client.connect();
    isDbConnected = true;
    console.log("Connected to MongoDB Atlas");
  } catch (error) {
    isDbConnected = false;
    console.error("MongoDB connection error:", error);
  }
}
connectDB();

setInterval(async () => {
  try {
    await client.db('HermitHome').command({ ping: 1 });
    isDbConnected = true;
  } catch (error) {
    isDbConnected = false;
    console.error("Lost connection to MongoDB:", error);
    await connectDB();
  }
}, 60000);

const db = client.db('HermitHome');
const currentStatsCollection = db.collection('current_stats');
const thresholdsCollection = db.collection('thresholds');
const statsCollection = db.collection('stats'); // Sử dụng bảng stats thay cho sensors

// Tạo WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();

wss.on('connection', (ws, req) => {
  const userId = req.url.split('?userId=')[1];
  if (!userId) {
    ws.close();
    return;
  }
  clients.set(userId, ws);
  console.log(`Client connected: ${userId}`);

  ws.on('close', () => {
    clients.delete(userId);
    console.log(`Client disconnected: ${userId}`);
  });
});

async function watchThresholds() {
  const changeStream = thresholdsCollection.watch();
  for await (const change of changeStream) {
    if (change.operationType === 'update' || change.operationType === 'insert') {
      const userId = change.fullDocument.userId;
      const client = clients.get(userId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          minTemperature: change.fullDocument.minTemperature,
          maxTemperature: change.fullDocument.maxTemperature,
          minHumidity: change.fullDocument.minHumidity,
          maxHumidity: change.fullDocument.maxHumidity,
          minLight: change.fullDocument.minLight,
          maxLight: change.fullDocument.maxLight,
        }));
        console.log(`Thresholds updated and sent to userId: ${userId}`);
      }
    }
  }
}
watchThresholds().catch(console.error);

// API ghi dữ liệu từ ESP32
app.post('/write', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  const { userId, temperature, humidity, light } = req.body;
  console.log("Received data:", { userId, temperature, humidity, light });

  if (!userId || !temperature || !humidity || !light) {
    return res.status(400).send("Missing required fields: userId, temperature, humidity, and light are required");
  }

  try {
    const timestamp = new Date();

    // Cập nhật hoặc chèn mới vào current_stats
    const currentStatsResult = await currentStatsCollection.updateOne(
      { userId },
      {
        $set: {
          userId,
          temperature: parseFloat(temperature),
          humidity: parseFloat(humidity),
          light: parseInt(light),
          timestamp
        }
      },
      { upsert: true }
    );

    // Ghi thêm vào stats (lịch sử dữ liệu)
    await statsCollection.insertOne({
      userId,
      temperature: parseFloat(temperature),
      humidity: parseFloat(humidity),
      light: parseInt(light),
      timestamp
    });

    if (currentStatsResult.matchedCount > 0 || currentStatsResult.upsertedCount > 0) {
      console.log(`Data updated for userId: ${userId}`);
      res.status(200).send("Data updated");
    } else {
      console.log("No data updated or inserted in current_stats");
      res.status(500).send("No data updated or inserted in current_stats");
    }
  } catch (error) {
    console.error("Error updating data:", error.message);
    res.status(500).send("Error updating data: " + error.message);
  }
});

// API đọc ngưỡng
app.get('/read/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const userId = req.params.userId;
    const thresholds = await thresholdsCollection.findOne({ userId });
    if (!thresholds) {
      const defaultThresholds = {
        minTemperature: 20,
        maxTemperature: 30,
        minHumidity: 40,
        maxHumidity: 80,
        minLight: 100,
        maxLight: 1000
      };
      await thresholdsCollection.insertOne({ userId, ...defaultThresholds });
      return res.json(defaultThresholds);
    }
    res.json({
      minTemperature: thresholds.minTemperature,
      maxTemperature: thresholds.maxTemperature,
      minHumidity: thresholds.minHumidity,
      maxHumidity: thresholds.maxHumidity,
      minLight: thresholds.minLight,
      maxLight: thresholds.maxLight
    });
  } catch (error) {
    console.error("Error reading thresholds:", error);
    res.status(500).send("Error reading thresholds");
  }
});

process.on('SIGINT', async () => {
  await client.close();
  console.log("MongoDB connection closed");
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));