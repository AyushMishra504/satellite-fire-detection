import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import detectionRoutes from './routes/detectionRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend requests
app.use(cors());
app.use(express.json());

// Routes
app.use('/detections', detectionRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Backend] Thermal Anomaly Detection API running on http://localhost:${PORT}`);
  console.log(`[Backend] Detections endpoint available at http://localhost:${PORT}/detections`);
});
