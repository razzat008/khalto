import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Vibration,
  ActivityIndicator,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { haversineDistance } from '../utils/haversine';
import { fetchOSRMRoute, fetchOSRMDetour, DETOUR_ROUTE } from '../utils/routeData';
import { computeSafeRoutes } from '../utils/safeRouting';

// --- Constants ---
const DEERWALK = { latitude: 27.7121, longitude: 85.3426 };
const THAMEL   = { latitude: 27.7154, longitude: 85.3123 };

const TICK_MS      = 600;   // How often the loop fires (milliseconds)
const A_STEP       = 2;     // How many route indices Marker A advances per tick
const B_STEP       = 1;     // Marker B is slightly slower (starts later, catches up)
const B_START_DELAY_TICKS = 8; // B doesn't start moving until 8 ticks after A

const WARNING_DISTANCE_M  = 50;   // metres — show banner + vibrate
const REROUTE_DISTANCE_M  = 15;   // metres — pause + reroute

function seedPotholes(route) {
  const count = 4 + Math.floor(Math.random() * 2); // 4 or 5
  const safeStart = Math.floor(route.length * 0.1);
  const safeEnd   = Math.floor(route.length * 0.85); // leave room before end

  const chosenIndices = new Set();
  while (chosenIndices.size < count) {
    const idx = safeStart + Math.floor(Math.random() * (safeEnd - safeStart));

    // Enforce minimum gap of 8 indices between potholes to avoid clustering
    const tooClose = [...chosenIndices].some((i) => Math.abs(i - idx) < 8);
    if (!tooClose) chosenIndices.add(idx);
  }

  return [...chosenIndices].sort((a, b) => a - b).map((routeIdx, i) => ({
    id: `pothole_${i}`,
    coordinate: route[routeIdx],       // {latitude, longitude}
    routeIdx,                          // which step of the route this is on
    discoveredAtStep: null,            // filled when Marker A reaches this index
    isDiscovered: false,               // has Marker A passed over it?
    hasWarnedB: false,                 // has the 50m warning fired?
    hasTriggeredReroute: false,        // has the 15m reroute fired?
  }));
}

export default function SimulationScreen({ onExit }) {
  // --- Phase ---
  const [destination, setDestination] = useState(THAMEL);
  const [phase, setPhase] = useState('IDLE');
  
  // Metrics
  const [distA, setDistA] = useState(0);
  const [distB, setDistB] = useState(0);
  const [comfortA, setComfortA] = useState(100);
  const [comfortB, setComfortB] = useState(100);
  const [speedB, setSpeedB] = useState(40);
  const [totalSafeDistance, setTotalSafeDistance] = useState(0);
  // 'IDLE' | 'RUNNING' | 'WARNING' | 'REROUTING' | 'COMPLETE' | 'PAUSED'

  // --- Routes ---
  const [routeCoordsA, setRouteCoordsA] = useState([]);   // full A route, never changes
  const [routeCoordsB, setRouteCoordsB] = useState([]);   // B's current route, swapped on reroute

  // --- Marker positions (indices into their respective route arrays) ---
  const [markerAIdx, setMarkerAIdx] = useState(0);
  const [markerBIdx, setMarkerBIdx] = useState(0);

  // --- Potholes ---
  const [potholes, setPotholes] = useState([]);

  // --- Warning state ---
  const [activeWarning, setActiveWarning] = useState(null);
  // null | { potholeId: string, distance: number }

  // --- Loading / Error ---
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // --- Refs to solve stale closures in setInterval ---
  const intervalRef = useRef(null);
  const routeCoordsBRef = useRef([]);
  const markerBIdxRef   = useRef(0);
  const potholesRef     = useRef([]);
  const phaseRef        = useRef('IDLE');
  const tickCountRef    = useRef(0);
  const isMountedRef    = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    init();

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function init(dest = destination) {
    try {
      setIsLoading(true);
      setError(null);

      // 1. Fetch route
      const route = await fetchOSRMRoute(
        DEERWALK.latitude, DEERWALK.longitude,
        dest.latitude,   dest.longitude,
      );

      if (!isMountedRef.current) return;

      // 2. Set routes (both start on the same path)
      setRouteCoordsA(route);
      setRouteCoordsB(route);
      routeCoordsBRef.current = route;

      // 3. Seed potholes
      const holes = seedPotholes(route);
      setPotholes(holes);
      potholesRef.current = holes;

      // 4. Position markers at start
      setMarkerAIdx(0);
      setMarkerBIdx(0);
      markerBIdxRef.current = 0;
      tickCountRef.current = 0;
      
      setDistA(0);
      setDistB(0);
      setComfortA(100);
      setComfortB(100);
      setSpeedB(40);
      setTotalSafeDistance(0);

      setIsLoading(false);
    } catch (err) {
      if (isMountedRef.current) {
        setError('Failed to load route. Check your connection.');
        setIsLoading(false);
      }
    }
  }

  function calculateDistance(coords, upToIdx) {
    if (!coords || coords.length === 0) return 0;
    let dist = 0;
    for (let i = 1; i <= upToIdx && i < coords.length; i++) {
      dist += haversineDistance(coords[i-1].latitude, coords[i-1].longitude, coords[i].latitude, coords[i].longitude);
    }
    return dist;
  }

  function startAnimationLoop() {
    intervalRef.current = setInterval(() => {
      tickCountRef.current++;

      setMarkerAIdx((prevA) => {
        const nextA = Math.min(prevA + A_STEP, routeCoordsA.length - 1);
        
        let newHits = 0;
        potholesRef.current = potholesRef.current.map((p) => {
          if (!p.isDiscovered && nextA >= p.routeIdx) {
            newHits++;
            return { ...p, isDiscovered: true, discoveredAtStep: nextA };
          }
          return p;
        });
        
        if (newHits > 0) {
          setPotholes([...potholesRef.current]);
          setComfortA(prev => Math.max(0, prev - (newHits * 15)));
        }
        
        setDistA(calculateDistance(routeCoordsA, nextA));
        return nextA;
      });

      if (tickCountRef.current <= B_START_DELAY_TICKS) return;
      if (phaseRef.current === 'REROUTING') return;

      const currentRoute = routeCoordsBRef.current;
      const currentBIdx  = markerBIdxRef.current;
      const nextBIdx     = Math.min(currentBIdx + B_STEP, currentRoute.length - 1);

      markerBIdxRef.current = nextBIdx;
      setMarkerBIdx(nextBIdx);
      setDistB(calculateDistance(currentRoute, nextBIdx));

      const bPos = currentRoute[nextBIdx];
      let warningActive = false;

      for (const pothole of potholesRef.current) {
        if (!pothole.isDiscovered) continue;

        const dist = haversineDistance(
          bPos.latitude, bPos.longitude,
          pothole.coordinate.latitude, pothole.coordinate.longitude,
        );
        
        if (dist < 5 && !pothole.hitByB) {
           potholesRef.current = potholesRef.current.map((p) =>
            p.id === pothole.id ? { ...p, hitByB: true } : p,
          );
          setComfortB(prev => Math.max(0, prev - 15));
        }

        if (dist < WARNING_DISTANCE_M && !pothole.hasWarnedB) {
          potholesRef.current = potholesRef.current.map((p) =>
            p.id === pothole.id ? { ...p, hasWarnedB: true } : p,
          );
          setPotholes([...potholesRef.current]);

          setActiveWarning({ potholeId: pothole.id, distance: Math.round(dist) });
          setPhase('WARNING');
          phaseRef.current = 'WARNING';
          warningActive = true;
        }

        if (dist < REROUTE_DISTANCE_M && !pothole.hasTriggeredReroute) {
          potholesRef.current = potholesRef.current.map((p) =>
            p.id === pothole.id ? { ...p, hasTriggeredReroute: true } : p,
          );
          setPotholes([...potholesRef.current]);
          handleReroute(bPos);
          return;
        }
      }
      
      setSpeedB(warningActive || phaseRef.current === 'WARNING' ? 15 : 40);

      if (nextBIdx >= currentRoute.length - 1) {
        clearInterval(intervalRef.current);
        setPhase('COMPLETE');
        phaseRef.current = 'COMPLETE';
        setActiveWarning(null);
        setSpeedB(0);
      }

    }, TICK_MS);
  }

  function startSimulation() {
    setPhase('RUNNING');
    phaseRef.current = 'RUNNING';
    tickCountRef.current = 0;
    startAnimationLoop();
  }

  function pauseSimulation() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPhase('PAUSED');
    phaseRef.current = 'PAUSED';
  }

  function resumeSimulation() {
    setPhase('RUNNING');
    phaseRef.current = 'RUNNING';
    startAnimationLoop();
  }

  function resetSimulation() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Re-seed potholes
    const holes = seedPotholes(routeCoordsA);
    setPotholes(holes);
    potholesRef.current = holes;

    // Reset routes and positions
    setRouteCoordsB(routeCoordsA);
    routeCoordsBRef.current = routeCoordsA;

    setMarkerAIdx(0);
    setMarkerBIdx(0);
    markerBIdxRef.current = 0;
    tickCountRef.current = 0;

    setActiveWarning(null);
    setPhase('IDLE');
    phaseRef.current = 'IDLE';
    
    setDistA(0);
    setDistB(0);
    setComfortA(100);
    setComfortB(100);
    setSpeedB(40);
  }

  function handleMapLongPress(e) {
    const newDest = e.nativeEvent.coordinate;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPhase('IDLE');
    phaseRef.current = 'IDLE';
    setActiveWarning(null);
    setDestination(newDest);
    init(newDest);
  }

  function handleMapLongPress(e) {
    if (phase !== 'IDLE') return; // only allow changing dest when idle
    const newDest = e.nativeEvent.coordinate;
    setDestination(newDest);
    init(newDest);
  }

  async function handleReroute(fromCoord) {
    // 1. Pause the simulation
    setPhase('REROUTING');
    phaseRef.current = 'REROUTING';
    setActiveWarning(null);

    try {
      // Create a fake list of potholes for computeSafeRoutes (it expects {lat, lng, severity})
      // Only include discovered ones.
      const discovered = potholesRef.current
        .filter(p => p.isDiscovered)
        .map(p => ({
            id: p.id,
            lat: p.coordinate.latitude,
            lng: p.coordinate.longitude,
            severity: 'medium', // Default
            status: 'Unverified' // so computeSafeRoutes avoids it
        }));
      
      // Now using computeSafeRoutes directly so any destination is supported
      const routes = await computeSafeRoutes(fromCoord.latitude, fromCoord.longitude, destination.latitude, destination.longitude, discovered);
      const newRoute = routes.safestRoute.rawCoordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));

      if (!isMountedRef.current) return;

      // 4. Prepend Marker B's exact current position
      const stitchedRoute = [
        { latitude: fromCoord.latitude, longitude: fromCoord.longitude },
        ...newRoute,
      ];

      // 5. Swap out B's route and reset B's index to 0
      setRouteCoordsB(stitchedRoute);
      routeCoordsBRef.current = stitchedRoute;

      setMarkerBIdx(0);
      markerBIdxRef.current = 0;

      setTotalSafeDistance(routes.safestRoute.distanceMeters);

      // 6. Resume
      setPhase('RUNNING');
      phaseRef.current = 'RUNNING';

    } catch (err) {
      if (!isMountedRef.current) return;
      console.warn('Reroute failed, continuing on original path:', err);
      setPhase('RUNNING');
      phaseRef.current = 'RUNNING';
    }
  }

  return (
    <View style={styles.container}>
      {/* ── LOADING STATE ─────────────────────────────────────────────── */}
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#E8630A" />
          <Text style={styles.loadingText}>Loading Kathmandu route…</Text>
        </View>
      )}

      {/* ── ERROR STATE ───────────────────────────────────────────────── */}
      {error && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={init}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── MAP ───────────────────────────────────────────────────────── */}
      {!isLoading && !error && (
        <MapView
          style={StyleSheet.absoluteFillObject}
          initialRegion={{
            latitude:      27.7135,
            longitude:     85.3275,
            latitudeDelta:  0.025,
            longitudeDelta: 0.025,
          }}
          showsUserLocation={false}
          showsTraffic={false}
          onLongPress={handleMapLongPress}
        >
          {/* Marker A's full original route — shown in muted gray */}
          {routeCoordsA.length > 0 && (
            <Polyline
              coordinates={routeCoordsA}
              strokeColor="rgba(180, 180, 180, 0.6)"
              strokeWidth={3}
              lineDashPattern={[6, 4]}
            />
          )}

          {/* Marker B's current route — shown in bold blue */}
          {routeCoordsB.length > 0 && (
            <Polyline
              coordinates={routeCoordsB}
              strokeColor="#2A7CFF"
              strokeWidth={4}
            />
          )}

          {/* Destination marker */}
          <Marker
            coordinate={destination}
            pinColor="purple"
            title="Destination"
            description="Long press map to change"
          />

          {/* Pothole markers — only show discovered ones */}
          {potholes
            .filter((p) => p.isDiscovered)
            .map((pothole) => (
              <Marker
                key={pothole.id}
                coordinate={pothole.coordinate}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={styles.potholeMarker}>
                  <Text style={styles.potholeEmoji}>⚠️</Text>
                </View>
              </Marker>
            ))}

          {/* Marker A — lead rider */}
          {routeCoordsA[markerAIdx] && (
            <Marker
              coordinate={routeCoordsA[markerAIdx]}
              title="Lead Rider"
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={[styles.markerIconFallback, { backgroundColor: '#E8630A' }]}>
                <Text style={styles.markerText}>A</Text>
              </View>
            </Marker>
          )}

          {/* Marker B — follower rider (only show after delay) */}
          {routeCoordsB[markerBIdx] && phase !== 'IDLE' && (
            <Marker
              coordinate={routeCoordsB[markerBIdx]}
              title="Follower Rider"
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={[styles.markerIconFallback, { backgroundColor: '#2A7CFF' }]}>
                <Text style={styles.markerText}>B</Text>
              </View>
            </Marker>
          )}
        </MapView>
      )}

      {/* ── TOP BAR (always visible) ──────────────────────────────────── */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.exitButton} onPress={onExit}>
          <Text style={styles.exitButtonText}>✕ Exit</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>RoadSense Simulation</Text>
        <View style={styles.phaseBadge}>
          <Text style={styles.phaseBadgeText}>{phase}</Text>
        </View>
      </View>

      {/* Metrics Overlay */}
      {!isLoading && !error && (
        <View style={styles.metricsOverlay}>
          <Text style={styles.metricsTitle}>Rider A (Lead)</Text>
          <Text style={styles.metricsText}>Dist: {(distA / 1000).toFixed(2)} km</Text>
          <Text style={styles.metricsText}>Comfort: {comfortA}%</Text>
          
          <View style={styles.divider} />
          
          <Text style={styles.metricsTitle}>Rider B (Follower)</Text>
          <Text style={styles.metricsText}>Dist Travelled: {(distB / 1000).toFixed(2)} km</Text>
          <Text style={styles.metricsText}>Safe Route Total: {totalSafeDistance > 0 ? (totalSafeDistance / 1000).toFixed(2) + ' km' : '---'}</Text>
          <Text style={styles.metricsText}>Comfort: {comfortB}%</Text>
          <Text style={styles.metricsText}>Recommended Speed: <Text style={{color: speedB <= 15 && speedB > 0 ? '#E8630A' : '#10b981'}}>{speedB} km/h</Text></Text>
        </View>
      )}

      {/* ── WARNING BANNER ────────────────────────────────────────────── */}
      {activeWarning && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningIcon}>🚨</Text>
          <View>
            <Text style={styles.warningTitle}>Pothole Ahead!</Text>
            <Text style={styles.warningSubtitle}>
              {activeWarning.distance}m away — rerouting calculated
            </Text>
          </View>
        </View>
      )}

      {/* ── REROUTING BANNER ──────────────────────────────────────────── */}
      {phase === 'REROUTING' && (
        <View style={[styles.warningBanner, styles.reroutingBanner]}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.reroutingText}>  Recalculating safest route…</Text>
        </View>
      )}

      {/* ── COMPLETE BANNER ───────────────────────────────────────────── */}
      {phase === 'COMPLETE' && (
        <View style={styles.completeBanner}>
          <Text style={styles.completeText}>✅ Reached Thamel safely!</Text>
          <TouchableOpacity style={styles.replayButton} onPress={resetSimulation}>
            <Text style={styles.replayButtonText}>Replay</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── BOTTOM CONTROL BAR ────────────────────────────────────────── */}
      {!isLoading && !error && (
        <View style={styles.bottomBar}>
          {phase === 'IDLE' && (
            <TouchableOpacity style={styles.playButton} onPress={startSimulation}>
              <Text style={styles.playButtonText}>▶ Start Simulation</Text>
            </TouchableOpacity>
          )}
          {(phase === 'RUNNING' || phase === 'WARNING') && (
            <TouchableOpacity style={styles.pauseButton} onPress={pauseSimulation}>
              <Text style={styles.playButtonText}>⏸ Pause</Text>
            </TouchableOpacity>
          )}
          {phase === 'PAUSED' && (
            <TouchableOpacity style={styles.playButton} onPress={resumeSimulation}>
              <Text style={styles.playButtonText}>▶ Resume</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(13, 13, 13, 0.85)',
    zIndex: 10,
  },
  topBarTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  exitButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
  },
  exitButtonText: {
    color: '#fff',
    fontSize: 13,
  },
  phaseBadge: {
    backgroundColor: '#E8630A',
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  phaseBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  warningBanner: {
    position: 'absolute',
    top: 110,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#CC2200',
    borderRadius: 12,
    padding: 14,
    zIndex: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  reroutingBanner: {
    backgroundColor: '#1A5CCC',
  },
  warningIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  warningTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  warningSubtitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    marginTop: 2,
  },
  reroutingText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  completeBanner: {
    position: 'absolute',
    top: 110,
    left: 16,
    right: 16,
    backgroundColor: '#1A7A3C',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    zIndex: 20,
  },
  completeText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  replayButton: {
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 24,
  },
  replayButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    paddingBottom: 32,
    backgroundColor: 'rgba(13, 13, 13, 0.85)',
    alignItems: 'center',
    zIndex: 10,
  },
  playButton: {
    backgroundColor: '#E8630A',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  pauseButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  playButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  markerIconFallback: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  markerText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12,
  },
  potholeMarker: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  potholeEmoji: {
    fontSize: 22,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99,
  },
  loadingText: {
    color: '#888',
    marginTop: 12,
    fontSize: 14,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    zIndex: 99,
  },
  errorText: {
    color: '#CC2200',
    fontSize: 15,
    textAlign: 'center',
  },
  retryText: {
    color: '#E8630A',
    marginTop: 16,
    fontSize: 15,
    fontWeight: '600',
  },
  metricsOverlay: {
    position: 'absolute',
    top: 60,
    right: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    padding: 12,
    borderRadius: 8,
    zIndex: 100,
    minWidth: 160,
  },
  metricsTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  metricsText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginVertical: 8,
  },
});
