import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import detectionRoutes from './routes/detectionRoutes.js';
import geoContextRoutes from './routes/geoContext.js';
import persistenceRoutes from './routes/persistenceRoutes.js';
import mlRoute from './routes/mlRoute.js';
import { runPersistenceBootstrap } from './services/persistenceService.js';
import { loadModels } from './services/mlInference.js';

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
app.use('/api/persistence', persistenceRoutes);
app.use('/api/ml', mlRoute);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Backend] Thermal Anomaly Detection API running on http://localhost:${PORT}`);
  console.log(`[Backend] Detections endpoint available at http://localhost:${PORT}/detections`);
  console.log(`[Backend] Geo-context endpoint available at http://localhost:${PORT}/api/geo-context`);

  // Seed the persistence tracker in the background (backfill FIRMS history so
  // persistent sources aren't mistaken for "day 1"). Never blocks the server.
  runPersistenceBootstrap().then((res) => {
    if (res?.error) console.log(`[Persistence] backfill skipped: ${res.error}`);
    else console.log(`[Persistence] backfill done: ${JSON.stringify(res)}`);
  }).catch((err) => {
    console.warn(`[Persistence] bootstrap error: ${err.message}`);
  });

  // Load the ML (ONNX) models in the background — never blocks the server.
  loadModels().catch((err) => {
    console.warn(`[ML] model load had an error: ${err.message}`);
  });
});
