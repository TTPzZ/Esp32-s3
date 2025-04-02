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
          heaterEnabled: change.fullDocument.heaterEnabled,
          fanEnabled: change.fullDocument.fanEnabled,
          mistEnabled: change.fullDocument.mistEnabled,
          lightEnabled: change.fullDocument.lightEnabled, // Thêm trạng thái đèn
          lightOnHour: change.fullDocument.lightOnHour,   // Thêm giờ bật đèn
          lightOffHour: change.fullDocument.lightOffHour  // Thêm giờ tắt đèn
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

// API đọc ngưỡng, trạng thái bật/tắt, thời gian hiện tại và thời gian bật/tắt đèn
app.get('/read/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const userId = req.params.userId;
    const thresholds = await thresholdsCollection.findOne({ userId });

    // Lấy thời gian hiện tại theo múi giờ Việt Nam
    const timestamp = moment().tz('Asia/Ho_Chi_Minh');
    const isoTimestamp = timestamp.toISOString();

    if (!thresholds) {
      const defaultThresholds = {
        userId,
        minTemperature: 20,
        maxTemperature: 30,
        minHumidity: 40,
        maxHumidity: 80,
        minLight: 100,
        maxLight: 1000,
        heaterEnabled: true,
        fanEnabled: true,
        mistEnabled: true,
        lightEnabled: true,  // Mặc định đèn được bật
        lightOnHour: 9,      // Mặc định bật lúc 9:00
        lightOffHour: 21     // Mặc định tắt lúc 21:00
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
        mistEnabled: defaultThresholds.mistEnabled,
        lightEnabled: defaultThresholds.lightEnabled,
        lightOnHour: defaultThresholds.lightOnHour,
        lightOffHour: defaultThresholds.lightOffHour,
        currentTime: isoTimestamp
      });
    }
    res.json({
      minTemperature: thresholds.minTemperature,
      maxTemperature: thresholds.maxTemperature,
      minHumidity: thresholds.minHumidity,
      maxHumidity: thresholds.maxHumidity,
      minLight: thresholds.minLight,
      maxLight: thresholds.maxLight,
      heaterEnabled: thresholds.heaterEnabled !== undefined ? thresholds.heaterEnabled : true,
      fanEnabled: thresholds.fanEnabled !== undefined ? thresholds.fanEnabled : true,
      mistEnabled: thresholds.mistEnabled !== undefined ? thresholds.mistEnabled : true,
      lightEnabled: thresholds.lightEnabled !== undefined ? thresholds.lightEnabled : true,
      lightOnHour: thresholds.lightOnHour !== undefined ? thresholds.lightOnHour : 9,
      lightOffHour: thresholds.lightOffHour !== undefined ? thresholds.lightOffHour : 21,
      currentTime: isoTimestamp
    });
  } catch (error) {
    console.error("Error reading thresholds:", error);
    res.status(500).send("Error reading thresholds");
  }
});

// API cập nhật trạng thái bật/tắt và thời gian bật/tắt đèn từ app
app.post('/update/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  const userId = req.params.userId;
  const { heaterEnabled, fanEnabled, mistEnabled, lightEnabled, lightOnHour, lightOffHour } = req.body;

  // Kiểm tra xem có ít nhất một trường được gửi hay không
  if (heaterEnabled === undefined && fanEnabled === undefined && mistEnabled === undefined &&
      lightEnabled === undefined && lightOnHour === undefined && lightOffHour === undefined) {
    return res.status(400).send("At least one field (heaterEnabled, fanEnabled, mistEnabled, lightEnabled, lightOnHour, lightOffHour) is required");
  }

  try {
    const updateFields = {};
    if (heaterEnabled !== undefined) updateFields.heaterEnabled = heaterEnabled;
    if (fanEnabled !== undefined) updateFields.fanEnabled = fanEnabled;
    if (mistEnabled !== undefined) updateFields.mistEnabled = mistEnabled;
    if (lightEnabled !== undefined) updateFields.lightEnabled = lightEnabled;
    if (lightOnHour !== undefined) {
      const onHour = parseInt(lightOnHour);
      if (onHour >= 0 && onHour <= 23) {
        updateFields.lightOnHour = onHour;
      } else {
        return res.status(400).send("lightOnHour must be between 0 and 23");
      }
    }
    if (lightOffHour !== undefined) {
      const offHour = parseInt(lightOffHour);
      if (offHour >= 0 && offHour <= 23) {
        updateFields.lightOffHour = offHour;
      } else {
        return res.status(400).send("lightOffHour must be between 0 and 23");
      }
    }

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
        mistEnabled: updatedThresholds.mistEnabled !== undefined ? updatedThresholds.mistEnabled : true,
        lightEnabled: updatedThresholds.lightEnabled !== undefined ? updatedThresholds.lightEnabled : true,
        lightOnHour: updatedThresholds.lightOnHour !== undefined ? updatedThresholds.lightOnHour : 9,
        lightOffHour: updatedThresholds.lightOffHour !== undefined ? updatedThresholds.lightOffHour : 21
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