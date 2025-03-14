// const express = require('express');
// const { MongoClient } = require('mongodb');
// const app = express();
// app.use(express.json());

// const uri = process.env.MONGODB_URI || "";
// if (!uri) {
//   console.error("MONGODB_URI is not set. Please configure it in environment variables.");
//   process.exit(1);
// }
// const client = new MongoClient(uri);
// let isDbConnected = false;

// // Kết nối tới MongoDB Atlas
// async function connectDB() {
//   try {
//     await client.connect();
//     isDbConnected = true;
//     console.log("Connected to MongoDB Atlas");
//   } catch (error) {
//     isDbConnected = false;
//     console.error("MongoDB connection error:", error);
//   }
// }
// connectDB();

// // Kiểm tra kết nối định kỳ (mỗi 1 phút)
// setInterval(async () => {
//   try {
//     await client.db('HermitHome').command({ ping: 1 });
//     isDbConnected = true;
//   } catch (error) {
//     isDbConnected = false;
//     console.error("Lost connection to MongoDB:", error);
//     await connectDB();
//   }
// }, 60000);

// const db = client.db('HermitHome');
// const currentStatsCollection = db.collection('current_stats');
// const thresholdsCollection = db.collection('thresholds');

// // API ghi dữ liệu từ ESP32 vào current_stats
// // app.post('/write', async (req, res) => {
// //   if (!isDbConnected) {
// //     return res.status(503).send("Database not connected");
// //   }
// //   const { temperature, humidity, light } = req.body;
// //   if (!temperature || !humidity || !light) {
// //     return res.status(400).send("Missing required fields");
// //   }
// //   try {
// //     await currentStatsCollection.insertOne({
// //       temperature: parseFloat(temperature),
// //       humidity: parseFloat(humidity),
// //       light: parseInt(light),
// //       timestamp: new Date()
// //     });
// //     res.status(200).send("Data saved");
// //   } catch (error) {
// //     console.error("Error saving data:", error);
// //     res.status(500).send("Error saving data");
// //   }
// // });

// app.post('/write', async (req, res) => {
//     if (!isDbConnected) {
//       return res.status(503).send("Database not connected");
//     }
//     const { userId, temperature, humidity, light } = req.body;
//     console.log("Received data:", { userId, temperature, humidity, light });
  
//     // Kiểm tra dữ liệu đầu vào
//     if (!userId || !temperature || !humidity || !light) {
//       return res.status(400).send("Missing required fields: userId, temperature, humidity, and light are required");
//     }
  
//     try {
//       // Cập nhật hoặc tạo mới tài liệu dựa trên userId
//       const result = await currentStatsCollection.updateOne(
//         { userId: userId }, // Tìm tài liệu theo userId
//         {
//           $set: {
//             temperature: parseFloat(temperature),
//             humidity: parseFloat(humidity),
//             light: parseInt(light),
//             timestamp: new Date()
//           }
//         },
//         { upsert: true } // Nếu không tìm thấy tài liệu, tạo mới
//       );
  
//       if (result.matchedCount > 0 || result.upsertedCount > 0) {
//         console.log(`Data updated for userId: ${userId}`);
//         res.status(200).send("Data updated");
//       } else {
//         console.log("No data updated or inserted");
//         res.status(500).send("No data updated or inserted");
//       }
//     } catch (error) {
//       console.error("Error updating data:", error.message);
//       res.status(500).send("Error updating data: " + error.message);
//     }
//   });

// // API đọc thiết lập từ thresholds cho ESP32
// app.get('/read', async (req, res) => {
//   if (!isDbConnected) {
//     return res.status(503).send("Database not connected");
//   }
//   try {
//     const thresholds = await thresholdsCollection.findOne({ type: "limits" });
//     if (!thresholds) {
//       return res.json({
//         temp_min: 20,
//         temp_max: 30,
//         humid_min: 40,
//         humid_max: 80,
//         light_min: 100,
//         light_max: 1000
//       });
//     }
//     res.json(thresholds);
//   } catch (error) {
//     console.error("Error reading thresholds:", error);
//     res.status(500).send("Error reading thresholds");
//   }
// });

// // API kiểm tra trạng thái server
// app.get('/status', (req, res) => {
//   res.json({ status: "Server running", dbConnected: isDbConnected });
// });

// // Lắng nghe trên port do Render cung cấp
// const PORT = process.env.PORT;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());

const uri = process.env.MONGODB_URI || "";
if (!uri) {
  console.error("MONGODB_URI is not set. Please configure it in environment variables.");
  process.exit(1);
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
const sensorsCollection = db.collection('sensors');

// API ghi dữ liệu từ ESP32 vào current_stats và sensors
app.post('/write', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  const { userId, temperature, humidity, light } = req.body;
  console.log("Received data:", { userId, temperature, humidity, light });

  // Kiểm tra dữ liệu đầu vào
  if (!userId || !temperature || !humidity || !light) {
    return res.status(400).send("Missing required fields: userId, temperature, humidity, and light are required");
  }

  try {
    const timestamp = new Date();

    // Cập nhật hoặc tạo mới tài liệu trong current_stats
    const currentStatsResult = await currentStatsCollection.updateOne(
      { userId }, // userId là chuỗi đơn giản
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

    // Lưu dữ liệu vào sensors (lịch sử dữ liệu)
    await sensorsCollection.insertOne({
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

// API đọc thiết lập từ thresholds cho ESP32
app.get('/read/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const userId = req.params.userId;
    const thresholds = await thresholdsCollection.findOne({ userId });
    if (!thresholds) {
      return res.json({
        minTemperature: 20,
        maxTemperature: 30,
        minHumidity: 40,
        maxHumidity: 80,
        minLight: 100,
        maxLight: 1000
      });
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

// API để Flutter lấy dữ liệu từ current_stats
app.get('/get-current-stats/:userId', async (req, res) => {
  if (!isDbConnected) {
    return res.status(503).send("Database not connected");
  }
  try {
    const userId = req.params.userId;
    const currentStats = await currentStatsCollection.findOne({ userId });
    if (!currentStats) {
      return res.status(404).send("Không tìm thấy dữ liệu current_stats cho userId: " + userId);
    }
    res.status(200).json(currentStats);
  } catch (error) {
    console.error("Error fetching current_stats:", error);
    res.status(500).send("Error fetching current_stats: " + error.message);
  }
});

// API kiểm tra trạng thái server
app.get('/status', (req, res) => {
  res.json({ status: "Server running", dbConnected: isDbConnected });
});

// Lắng nghe trên port do Render cung cấp
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));