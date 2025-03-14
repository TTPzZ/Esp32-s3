const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());

// Sử dụng biến môi trường MONGODB_URI, fallback là chuỗi rỗng (dùng để test cục bộ)
const uri = process.env.MONGODB_URI || "";
if (!uri) {
  console.error("MONGODB_URI is not set. Please configure it in environment variables.");
  process.exit(1); // Thoát nếu không có URI
}
const client = new MongoClient(uri);
let isDbConnected = false;

// Kết nối tới MongoDB Atlas
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

// Kiểm tra kết nối định kỳ (mỗi 1 phút)
setInterval(async () => {
  try {
    await client.db('esp32_db').command({ ping: 1 });
    isDbConnected = true;
  } catch (error) {
    isDbConnected = false;
    console.error("Lost connection to MongoDB:", error);
    await connectDB();
  }
}, 60000);

const db = client.db('HermitHome');
const dataCollection = db.collection('sensor_data');
const settingsCollection = db.collection('settings');

// API ghi dữ liệu từ ESP32
app.post('/write', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  const { temperature, humidity, light } = req.body;
  if (!temperature || !humidity || !light) {
    return res.status(400).send("Missing required fields");
  }
  try {
    await dataCollection.insertOne({
      temperature: parseFloat(temperature),
      humidity: parseFloat(humidity),
      light: parseInt(light),
      timestamp: new Date()
    });
    res.status(200).send("Data saved");
  } catch (error) {
    console.error("Error saving data:", error);
    res.status(500).send("Error saving data");
  }
});

// API đọc thiết lập cho ESP32
app.get('/read', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const settings = await settingsCollection.findOne({ type: "limits" });
    if (!settings) {
      return res.json({
        temp_min: 20,
        temp_max: 30,
        humid_min: 40,
        humid_max: 80,
        light_min: 100,
        light_max: 1000
      });
    }
    res.json(settings);
  } catch (error) {
    console.error("Error reading settings:", error);
    res.status(500).send("Error reading settings");
  }
});

// API kiểm tra trạng thái server
app.get('/status', (req, res) => {
  res.json({ status: "Server running", dbConnected: isDbConnected });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));