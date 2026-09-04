# Project Explanation: Satellite Fire & Thermal Anomaly Detection

This document provides an overview of the `satellite-fire-detection` project. This is a full-stack proof-of-concept application built to ingest, process, and visualize active fire and thermal anomaly data from NASA's Fire Information for Resource Management System (FIRMS), specifically the VIIRS NOAA-20 Near Real-Time (NRT) dataset.

## System Architecture

The project consists of two main components: a Backend API and a Frontend Application.

### Backend (Node.js/Express)
- **Role:** Acts as an intermediary between the NASA FIRMS API and the Frontend application.
- **Data Ingestion:** Periodically fetches near real-time thermal anomaly data in CSV format from NASA FIRMS and parses it into JSON for easier consumption by the frontend.
- **Caching Mechanism:** Implements a 15-minute server-side, in-memory cache to optimize performance and prevent redundant, costly calls to the external NASA API.
- **Tech Stack:** Node.js, Express, and standard npm packages for environment variable management, cross-origin resource sharing (CORS), and HTTP requests.

### Frontend (React/Vite)
- **Role:** Provides a user-friendly, interactive dashboard to visualize the fire hotspots.
- **Visualization:** Utilizes an interactive Leaflet map to display the data, initially centering the view over India.
- **Dynamic Indicators:** Represents hotspots using circle markers. The markers are dynamically sized and color-coded based on the Fire Radiative Power (FRP, measured in MW) to intuitively show the intensity of the anomaly.
- **Interactivity:**
  - Users can click on any hotspot marker to view a detailed popup containing the FRP, UTC acquisition time, date, confidence level, and precise geographic coordinates.
  - Includes custom map controls, such as a GPS recenter button, to immediately reset the view to fit India.
- **Tech Stack:** React, Vite (for fast builds and HMR), React Leaflet, and standard CSS for styling.

## Key Features
1. **Near Real-Time Data:** Leverages NASA FIRMS data for up-to-date tracking of thermal anomalies.
2. **Performance Optimized:** Uses backend caching to ensure fast loading times on the frontend and compliance with potential rate limits on the NASA API.
3. **Intuitive Visualization:** Clear, color-coded, and interactive mapping interface for analyzing hotspot intensity and location.

## Setup Requirements
To run this project locally, you need:
- A NASA FIRMS MAP Key (available for free from the NASA EOSDIS website).
- Node.js installed on your machine.
- Configuration of the `.env` file in the backend directory with your `MAP_KEY`.
- Running both the backend server and frontend development server concurrently.
