require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const WebSocket = require('ws');
const moment = require('moment-timezone');

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
const statsCollection = db.collection('stats');

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
          heaterEnabled: change.fullDocument.heaterEnabled, // Thêm trạng thái bật/tắt
          fanEnabled: change.fullDocument.fanEnabled,
          mistEnabled: change.fullDocument.mistEnabled
        }));
        console.log(`Thresholds and device states updated and sent to userId: ${userId}`);
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
    const timestamp = moment().tz('Asia/Ho_Chi_Minh');
    const isoTimestamp = timestamp.toISOString();
    const date = timestamp.format('YYYY-MM-DD');
    const time = timestamp.format('HH:mm');

    const currentStatsResult = await currentStatsCollection.updateOne(
      { userId },
      {
        $set: {
          userId,
          temperature: parseFloat(temperature),
          humidity: parseFloat(humidity),
          light: parseInt(light),
          timestamp: isoTimestamp
        }
      },
      { upsert: true }
    );

    await statsCollection.insertOne({
      userId,
      date,
      time,
      temperature: parseFloat(temperature),
      humidity: parseFloat(humidity),
      light: parseInt(light),
      timestamp: isoTimestamp
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

// API đọc ngưỡng và trạng thái bật/tắt
app.get('/read/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const userId = req.params.userId;
    const thresholds = await thresholdsCollection.findOne({ userId });
    if (!thresholds) {
      const defaultThresholds = {
        userId,
        minTemperature: 20,
        maxTemperature: 30,
        minHumidity: 40,
        maxHumidity: 80,
        minLight: 100,
        maxLight: 1000,
        heaterEnabled: true, // Giá trị mặc định
        fanEnabled: true,
        mistEnabled: true
      };
      await thresholdsCollection.insertOne(defaultThresholds);
      return res.json({
        minTemperature: defaultThresholds.minTemperature,
        maxTemperature: defaultThresholds.maxTemperature,
        minHumidity: defaultThresholds.minHumidity,
        maxHumidity: defaultThresholds.maxHumidity,
        minLight: defaultThresholds.minLight,
        maxLight: defaultThresholds.maxLight,
        heaterEnabled: defaultThresholds.heaterEnabled,
        fanEnabled: defaultThresholds.fanEnabled,
        mistEnabled: defaultThresholds.mistEnabled
      });
    }
    res.json({
      minTemperature: thresholds.minTemperature,
      maxTemperature: thresholds.maxTemperature,
      minHumidity: thresholds.minHumidity,
      maxHumidity: thresholds.maxHumidity,
      minLight: thresholds.minLight,
      maxLight: thresholds.maxLight,
      heaterEnabled: thresholds.heaterEnabled !== undefined ? thresholds.heaterEnabled : true, // Đảm bảo có giá trị mặc định
      fanEnabled: thresholds.fanEnabled !== undefined ? thresholds.fanEnabled : true,
      mistEnabled: thresholds.mistEnabled !== undefined ? thresholds.mistEnabled : true
    });
  } catch (error) {
    console.error("Error reading thresholds:", error);
    res.status(500).send("Error reading thresholds");
  }
});

// API cập nhật trạng thái bật/tắt từ app
app.post('/update/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  const userId = req.params.userId;
  const { heaterEnabled, fanEnabled, mistEnabled } = req.body;

  // Kiểm tra xem các trường có được gửi hay không
  if (heaterEnabled === undefined && fanEnabled === undefined && mistEnabled === undefined) {
    return res.status(400).send("At least one field (heaterEnabled, fanEnabled, mistEnabled) is required");
  }

  try {
    const updateFields = {};
    if (heaterEnabled !== undefined) updateFields.heaterEnabled = heaterEnabled;
    if (fanEnabled !== undefined) updateFields.fanEnabled = fanEnabled;
    if (mistEnabled !== undefined) updateFields.mistEnabled = mistEnabled;

    const result = await thresholdsCollection.updateOne(
      { userId },
      { $set: updateFields },
      { upsert: true }
    );

    if (result.matchedCount > 0 || result.upsertedCount > 0) {
      const updatedThresholds = await thresholdsCollection.findOne({ userId });
      res.status(200).json({
        minTemperature: updatedThresholds.minTemperature,
        maxTemperature: updatedThresholds.maxTemperature,
        minHumidity: updatedThresholds.minHumidity,
        maxHumidity: updatedThresholds.maxHumidity,
        minLight: updatedThresholds.minLight,
        maxLight: updatedThresholds.maxLight,
        heaterEnabled: updatedThresholds.heaterEnabled !== undefined ? updatedThresholds.heaterEnabled : true,
        fanEnabled: updatedThresholds.fanEnabled !== undefined ? updatedThresholds.fanEnabled : true,
        mistEnabled: updatedThresholds.mistEnabled !== undefined ? updatedThresholds.mistEnabled : true
      });
    } else {
      res.status(500).send("Failed to update device states");
    }
  } catch (error) {
    console.error("Error updating device states:", error);
    res.status(500).send("Error updating device states");
  }
});

// Endpoint để giữ server sống
app.get('/ping', (req, res) => {
  res.status(200).send('Server is alive');
});

process.on('SIGINT', async () => {
  await client.close();
  console.log("MongoDB connection closed");
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));