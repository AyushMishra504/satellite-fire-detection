import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import detectionRoutes from './routes/detectionRoutes.js';
import geoContextRoutes from './routes/geoContext.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend requests
app.use(cors());
app.use(express.json());

// Routes
app.use('/detections', detectionRoutes);
app.use('/api/geo-context', geoContextRoutes);
app.use('/geo-context', geoContextRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Backend] Thermal Anomaly Detection API running on http://localhost:${PORT}`);
  console.log(`[Backend] Detections endpoint available at http://localhost:${PORT}/detections`);
  console.log(`[Backend] Geo-context endpoint available at http://localhost:${PORT}/api/geo-context`);
});
