# 🛰️ Satellite Fire & Thermal Anomaly Detection

A full-stack proof-of-concept application that ingests active fire and thermal anomaly data from NASA FIRMS (VIIRS NOAA-20 NRT) and visualizes hotspots on an interactive Leaflet map.

---

## 🚀 Quickstart Guide

### 1. Get Your NASA FIRMS MAP Key
- Generate your free API key at: [https://firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key)

---

### 2. Configure Environment Variable
Create a `.env` file inside the `backend/` directory:

```bash
# inside backend/.env
MAP_KEY=your_nasa_firms_map_key_here
```

---

### 3. Install Dependencies & Run the Application

#### Option A: Terminal 1 — Start Backend Server
```bash
cd backend
npm install
npm start
```
*Backend API will run on `http://localhost:5000`*

#### Option B: Terminal 2 — Start Frontend Application
```bash
cd frontend
npm install
npm run dev
```
*Frontend will run on `http://localhost:5173`*

---

## 📌 Features
- **NASA FIRMS Ingestion**: Fetches near real-time thermal anomaly CSV data and parses it into JSON.
- **Server-Side Caching**: 15-minute in-memory cache to prevent redundant external API queries.
- **Interactive Leaflet Map**: Full-screen OpenStreetMap view centered over India (`[20.5937, 78.9629]`).
- **Dynamic Hotspot Markers**: Circle markers color-coded and sized according to Fire Radiative Power (FRP in MW).
- **Interactive Popups**: Click any hotspot to view FRP, acquisition time (UTC), date, confidence, and coordinates.
- **Recenter Control**: GPS button below `+` / `-` to immediately fit India within view.
