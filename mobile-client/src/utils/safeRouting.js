const POTHOLE_RADIUS_METERS = { high: 8, medium: 6, low: 4 };
const SAFETY_BUFFER_METERS = 10;
const SUBDIVISION_INTERVAL_METERS = 2;

// ── Haversine ────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Interpolation ────────────────────────────
function interpolatePoint([lonA, latA], [lonB, latB], t) {
  return [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
}

// ── Subdivision ──────────────────────────────
function subdividePath(coords, intervalM = SUBDIVISION_INTERVAL_METERS) {
  if (coords.length < 2) return coords;
  const result = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const A = coords[i], B = coords[i + 1];
    const segLen = haversineMeters(A[1], A[0], B[1], B[0]);
    const n = Math.ceil(segLen / intervalM);
    result.push(A);
    for (let s = 1; s < n; s++) result.push(interpolatePoint(A, B, s / n));
  }
  result.push(coords[coords.length - 1]);
  return result;
}

// ── Danger Scoring ───────────────────────────
function getAvoidanceRadius(pothole) {
  return (POTHOLE_RADIUS_METERS[pothole.severity] ?? 6) + SAFETY_BUFFER_METERS;
}

function calculateDangerScore(denseCoords, potholes) {
  // Avoid all active/unverified potholes. Just exclude closed/patched ones if they exist.
  // The provided code filters by p.verified, but in our app we want to avoid Unverified too.
  // We'll treat status !== 'Patched' as active/to-avoid.
  const active = potholes.filter(p => p.status !== 'Patched');
  const hit = new Set();
  for (const [lon, lat] of denseCoords) {
    for (const ph of active) {
      if (hit.has(ph.id)) continue;
      if (haversineMeters(lat, lon, ph.lat, ph.lng) <= getAvoidanceRadius(ph)) {
        hit.add(ph.id);
      }
    }
  }
  return hit.size;
}

// ── OSRM Fetch ───────────────────────────────
async function fetchRoutes(originLat, originLon, destLat, destLon) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${originLon},${originLat};${destLon},${destLat}` +
    `?alternatives=3&overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM error: ' + data.code);
  
  return data.routes.map((r, i) => ({
    index: i,
    distanceMeters: r.distance,
    durationSeconds: r.duration,
    rawCoordinates: r.geometry.coordinates,
    dangerScore: 0,
    isFastest: i === 0,
    isSafest: false,
  }));
}

// ── Detour Fetch ───────────────────────────────
async function fetchDetourRoute(oLat, oLon, wpLat, wpLon, dLat, dLon) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${oLon},${oLat};${wpLon},${wpLat};${dLon},${dLat}` +
    `?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') return [];
  
  return data.routes.map((r, i) => ({
    index: 99, // Marker for detour
    distanceMeters: r.distance,
    durationSeconds: r.duration,
    rawCoordinates: r.geometry.coordinates,
    dangerScore: 0,
    isFastest: false,
    isSafest: false,
    isDetour: true,
  }));
}

// ── Main Entry Point ─────────────────────────
async function computeSafeRoutes(originLat, originLon, destLat, destLon, potholes) {
  const routes = await fetchRoutes(originLat, originLon, destLat, destLon);

  if (!routes || routes.length === 0) {
    throw new Error('OSRM returned no routes for this destination.');
  }

  for (const route of routes) {
    const dense = subdividePath(route.rawCoordinates);
    route.dangerScore = calculateDangerScore(dense, potholes);
    route.denseCoordinates = dense;
  }

  const fastest = routes[0];
  let safest = routes.reduce((best, curr) => {
    if (curr.dangerScore < best.dangerScore) return curr;
    if (curr.dangerScore === best.dangerScore &&
        curr.distanceMeters < best.distanceMeters) return curr;
    return best;
  });

  // SMART DETOUR ENGINE
  // If the best native route still hits a pothole, force OSRM to calculate detours
  if (safest.dangerScore > 0) {
    let firstHitPothole = null;
    const active = potholes.filter(p => p.status !== 'Patched');
    
    // Find the first pothole collision to bypass
    outer: for (const [lon, lat] of safest.denseCoordinates) {
      for (const ph of active) {
        if (haversineMeters(lat, lon, ph.lat, ph.lng) <= getAvoidanceRadius(ph)) {
          firstHitPothole = ph;
          break outer;
        }
      }
    }

    if (firstHitPothole) {
      // Calculate a perpendicular vector to the overall route direction
      const dy = destLat - originLat;
      const dx = destLon - originLon;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const nx = dx / len;
      const ny = dy / len;
      
      // Iteratively push the detour waypoint further out until we find a safe path
      const offsets = [
        0.003, // ~300 meters
        0.008, // ~800 meters
        0.015, // ~1.5 kilometers
        0.030, // ~3 kilometers
      ];

      for (const offset of offsets) {
        const wp1Lon = firstHitPothole.lng - ny * offset;
        const wp1Lat = firstHitPothole.lat + nx * offset;
        const wp2Lon = firstHitPothole.lng + ny * offset;
        const wp2Lat = firstHitPothole.lat - nx * offset;

        try {
          const detour1 = await fetchDetourRoute(originLat, originLon, wp1Lat, wp1Lon, destLat, destLon);
          const detour2 = await fetchDetourRoute(originLat, originLon, wp2Lat, wp2Lon, destLat, destLon);
          
          const detourRoutes = [...detour1, ...detour2];
          for (const dr of detourRoutes) {
            const dense = subdividePath(dr.rawCoordinates);
            dr.dangerScore = calculateDangerScore(dense, potholes);
            dr.denseCoordinates = dense;
            routes.push(dr);
            
            // If the forced detour is safer than the native route, pick it!
            if (dr.dangerScore < safest.dangerScore) {
              safest = dr;
            } else if (dr.dangerScore === safest.dangerScore && dr.distanceMeters < safest.distanceMeters) {
              safest = dr;
            }
          }
        } catch (e) {
          // Ignore detour API failures
        }

        // If we found a route that successfully avoids ALL potholes, stop expanding the search!
        if (safest.dangerScore === 0) {
          break;
        }
      }
    }
  }

  safest.isSafest = true;

  return {
    fastestRoute: fastest,
    safestRoute: safest,
    isSameRoute: fastest.index === safest.index && !safest.isDetour,
    allRoutes: routes,
  };
}

export { computeSafeRoutes, haversineMeters, subdividePath };
