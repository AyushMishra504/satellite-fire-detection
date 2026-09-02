// backend side, e.g. in a new /detections/enriched route or inside your classifier
import { getNearestFacility } from './src/services/facilityContext.js';


const facility = getNearestFacility(19.0760, 72.8777, 50); // Mumbai
// Delhi coords
console.log(facility);
// facility = { type: 'hospital', name: 'X', distance_km: 0.4 } or null