/**
 * Fetches a route from OSRM.
 *
 * @param {number} startLat
 * @param {number} startLon
 * @param {number} endLat
 * @param {number} endLon
 * @returns {Promise<Array<{latitude: number, longitude: number}>>}
 */
export async function fetchOSRMRoute(startLat, startLon, endLat, endLon) {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${startLon},${startLat};${endLon},${endLat}` +
      `?overview=full&geometries=geojson`;

    const response = await fetch(url);
    const json = await response.json();

    if (!json.routes || json.routes.length === 0) {
      throw new Error('OSRM returned no routes');
    }

    // OSRM returns [longitude, latitude] — flip to {latitude, longitude}
    return json.routes[0].geometry.coordinates.map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    }));
  } catch (err) {
    console.warn("OSRM fetch failed, using fallback route", err);
    return FALLBACK_ROUTE;
  }
}

export async function fetchOSRMDetour(startLat, startLon, viaLat, viaLon, endLat, endLon) {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${startLon},${startLat};${viaLon},${viaLat};${endLon},${endLat}` +
      `?overview=full&geometries=geojson`;

    const response = await fetch(url);
    const json = await response.json();

    if (!json.routes || json.routes.length === 0) {
      throw new Error('OSRM returned no routes');
    }

    return json.routes[0].geometry.coordinates.map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    }));
  } catch (err) {
    console.warn("OSRM detour fetch failed", err);
    return DETOUR_ROUTE;
  }
}

// Hardcoded fallback route roughly from Deerwalk to Thamel
export const FALLBACK_ROUTE = [
  { latitude: 27.71210, longitude: 85.34260 }, // Deerwalk
  { latitude: 27.71230, longitude: 85.34180 },
  { latitude: 27.71250, longitude: 85.34000 },
  { latitude: 27.71280, longitude: 85.33700 }, // Kamal Pokhari area
  { latitude: 27.71260, longitude: 85.33400 },
  { latitude: 27.71230, longitude: 85.33100 }, // Putalisadak/Hattisar area
  { latitude: 27.71260, longitude: 85.32800 },
  { latitude: 27.71350, longitude: 85.32500 }, // Durbar Marg area
  { latitude: 27.71420, longitude: 85.32200 },
  { latitude: 27.71500, longitude: 85.31800 }, // Jamal area
  { latitude: 27.71520, longitude: 85.31500 }, // Kantipath
  { latitude: 27.71540, longitude: 85.31230 }, // Thamel
];

export const DETOUR_ROUTE = [
  { latitude: 27.7160, longitude: 85.3400 }, // Naxal
  { latitude: 27.7170, longitude: 85.3350 }, // Gairidhara
  { latitude: 27.7180, longitude: 85.3250 }, // Lazimpat
  { latitude: 27.7154, longitude: 85.3123 }, // Thamel
];
