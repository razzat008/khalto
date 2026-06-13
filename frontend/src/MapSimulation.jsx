import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Play, Pause, RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { io } from 'socket.io-client';
import './App.css';

import { haversineDistance } from './utils/haversine';
import { fetchOSRMRoute, fetchOSRMDetour, DETOUR_ROUTE } from './utils/routeData';
import { computeSafeRoutes } from './utils/safeRouting';

// --- Constants ---
const DEERWALK = { latitude: 27.7121, longitude: 85.3426 };
const THAMEL   = { latitude: 27.7154, longitude: 85.3123 };

const TICK_MS      = 600;
const A_STEP       = 2;
const B_STEP       = 1;
const B_START_DELAY_TICKS = 8;
const WARNING_DISTANCE_M  = 50;
const REROUTE_DISTANCE_M  = 15;

function seedPotholes(route) {
  const count = 4 + Math.floor(Math.random() * 2);
  const safeStart = Math.floor(route.length * 0.1);
  const safeEnd   = Math.floor(route.length * 0.85);

  const chosenIndices = new Set();
  while (chosenIndices.size < count) {
    const idx = safeStart + Math.floor(Math.random() * (safeEnd - safeStart));
    const tooClose = [...chosenIndices].some((i) => Math.abs(i - idx) < 8);
    if (!tooClose) chosenIndices.add(idx);
  }

  return [...chosenIndices].sort((a, b) => a - b).map((routeIdx, i) => ({
    id: `pothole_${i}`,
    coordinate: route[routeIdx],
    routeIdx,
    discoveredAtStep: null,
    isDiscovered: false,
    hasWarnedB: false,
    hasTriggeredReroute: false,
  }));
}

export default function MapSimulation() {
  const [destination, setDestination] = useState(THAMEL);
  const [phase, setPhase] = useState('IDLE');
  
  // Metrics
  const [distA, setDistA] = useState(0);
  const [distB, setDistB] = useState(0);
  const [comfortA, setComfortA] = useState(100);
  const [comfortB, setComfortB] = useState(100);
  const [speedB, setSpeedB] = useState(40);
  const [totalSafeDistance, setTotalSafeDistance] = useState(0);
  const [routeCoordsA, setRouteCoordsA] = useState([]);
  const [routeCoordsB, setRouteCoordsB] = useState([]);
  const [markerAIdx, setMarkerAIdx] = useState(0);
  const [markerBIdx, setMarkerBIdx] = useState(0);
  const [potholes, setPotholes] = useState([]);
  const [activeWarning, setActiveWarning] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const intervalRef = useRef(null);
  const routeCoordsBRef = useRef([]);
  const markerBIdxRef   = useRef(0);
  const potholesRef     = useRef([]);
  const phaseRef        = useRef('IDLE');
  const tickCountRef    = useRef(0);
  const isMountedRef    = useRef(true);

  // Map Refs
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const layerGroupRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    socketRef.current = io(import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:5000');
    init();

    // Init Leaflet
    if (mapRef.current && !mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, {
        center: [27.7135, 85.3275],
        zoom: 15,
        zoomControl: false
      });
      L.control.zoom({ position: 'topright' }).addTo(mapInstance.current);
      L.tileLayer('https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
        maxZoom: 20,
      }).addTo(mapInstance.current);
      layerGroupRef.current = L.layerGroup().addTo(mapInstance.current);

      mapInstance.current.on('contextmenu', (e) => {
        const { lat, lng } = e.latlng;
        handleMapClick({ latitude: lat, longitude: lng });
      });
    }

    return () => {
      isMountedRef.current = false;
      if (socketRef.current) socketRef.current.disconnect();
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // Sync Leaflet UI with State
  useEffect(() => {
    if (!mapInstance.current || !layerGroupRef.current) return;
    layerGroupRef.current.clearLayers();

    // Draw Route A (Muted Gray)
    if (routeCoordsA.length > 0) {
      L.polyline(routeCoordsA.map(c => [c.latitude, c.longitude]), {
        color: 'rgba(180, 180, 180, 0.6)',
        weight: 3,
        dashArray: '6, 4'
      }).addTo(layerGroupRef.current);
    }

    // Draw Route B (Bold Blue)
    if (routeCoordsB.length > 0) {
      L.polyline(routeCoordsB.map(c => [c.latitude, c.longitude]), {
        color: '#2A7CFF',
        weight: 4
      }).addTo(layerGroupRef.current);
    }

    // Draw Potholes
    potholes.filter(p => p.isDiscovered).forEach(pothole => {
      const icon = L.divIcon({
        className: 'custom-pothole-icon',
        html: `<div style="font-size: 22px; text-align: center; width: 32px; height: 32px;">⚠️</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });
      L.marker([pothole.coordinate.latitude, pothole.coordinate.longitude], { icon }).addTo(layerGroupRef.current);
    });

    // Draw Marker A
    if (routeCoordsA[markerAIdx]) {
      const pos = routeCoordsA[markerAIdx];
      const icon = L.divIcon({
        className: 'custom-rider-a',
        html: `<div style="width: 24px; height: 24px; border-radius: 12px; background: #E8630A; border: 2px solid white; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 12px;">A</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      L.marker([pos.latitude, pos.longitude], { icon }).addTo(layerGroupRef.current);
    }

    // Draw Marker B
    if (routeCoordsB[markerBIdx] && phase !== 'IDLE') {
      const pos = routeCoordsB[markerBIdx];
      const icon = L.divIcon({
        className: 'custom-rider-b',
        html: `<div style="width: 24px; height: 24px; border-radius: 12px; background: #2A7CFF; border: 2px solid white; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 12px;">B</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      L.marker([pos.latitude, pos.longitude], { icon }).addTo(layerGroupRef.current);
    }

    // Draw Destination Marker
    const destIcon = L.divIcon({
      className: 'custom-dest',
      html: `<div style="font-size: 24px; text-align: center; width: 24px; height: 24px;">📍</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 24]
    });
    L.marker([destination.latitude, destination.longitude], { icon: destIcon }).addTo(layerGroupRef.current);
  }, [routeCoordsA, routeCoordsB, markerAIdx, markerBIdx, potholes, phase, destination]);

  async function init(dest = destination) {
    try {
      setIsLoading(true);
      setError(null);

      const route = await fetchOSRMRoute(
        DEERWALK.latitude, DEERWALK.longitude,
        dest.latitude,   dest.longitude,
      );

      if (!isMountedRef.current) return;

      setRouteCoordsA(route);
      setRouteCoordsB(route);
      routeCoordsBRef.current = route;

      const holes = seedPotholes(route);
      setPotholes(holes);
      potholesRef.current = holes;

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
        setError('Failed to load route.');
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
          
          if (socketRef.current) {
            socketRef.current.emit('broadcast_alert', {
              id: pothole.id,
              lat: pothole.coordinate.latitude,
              lng: pothole.coordinate.longitude,
              severity: 'high',
              created_by: 'Web Simulator',
              created_by_device: 'sim_web'
            });
          }
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
    const holes = seedPotholes(routeCoordsA);
    setPotholes(holes);
    potholesRef.current = holes;

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
    setTotalSafeDistance(0);
  }

  function handleMapClick(newDest) {
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

  async function handleReroute(fromCoord) {
    setPhase('REROUTING');
    phaseRef.current = 'REROUTING';
    setActiveWarning(null);

    try {
      const discovered = potholesRef.current
        .filter(p => p.isDiscovered)
        .map(p => ({
            id: p.id,
            lat: p.coordinate.latitude,
            lng: p.coordinate.longitude,
            severity: 'medium',
            status: 'Unverified'
        }));

      // In MapSimulation, destination state holds the current endpoint
      setDestination(prevDest => {
        computeSafeRoutes(fromCoord.latitude, fromCoord.longitude, prevDest.latitude, prevDest.longitude, discovered)
          .then(routes => {
            const newRoute = routes.safestRoute.rawCoordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
            
            if (!isMountedRef.current) return;
            const stitchedRoute = [
              { latitude: fromCoord.latitude, longitude: fromCoord.longitude },
              ...newRoute,
            ];

            setRouteCoordsB(stitchedRoute);
            routeCoordsBRef.current = stitchedRoute;

            setMarkerBIdx(0);
            markerBIdxRef.current = 0;

            setTotalSafeDistance(routes.safestRoute.distanceMeters);

            setPhase('RUNNING');
            phaseRef.current = 'RUNNING';
          })
          .catch(err => {
            console.warn('Reroute failed', err);
            setPhase('RUNNING');
            phaseRef.current = 'RUNNING';
          });
        return prevDest;
      });
    } catch (err) {
      console.warn('Reroute failed', err);
      setPhase('RUNNING');
      phaseRef.current = 'RUNNING';
    }
  }

  return (
    <div className="app-container" style={{ position: 'relative' }}>
      <div className="sidebar" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '350px', zIndex: 1000 }}>
        <div className="brand" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1>Khalto</h1>
          </div>
        </div>
        <p className="subtitle" style={{ marginBottom: '10px' }}>2D Map Simulation</p>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <Link to="/" style={{ flex: 1, padding: '8px', textAlign: 'center', background: 'rgba(15, 23, 42, 0.05)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>Back to Map</Link>
          <Link to="/map-simulation" style={{ flex: 1, padding: '8px', textAlign: 'center', background: '#E8630A', color: '#fff', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>2D Simulator</Link>
        </div>

        <div className="logs-panel" style={{ padding: '16px', marginBottom: '14px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            Phase: <span style={{ color: '#E8630A', fontWeight: 'bold' }}>{phase}</span>
          </h3>

          <div style={{ marginBottom: '16px', background: 'rgba(15, 23, 42, 0.05)', borderRadius: '8px', padding: '12px' }}>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'bold' }}>Rider A (Lead)</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '4px' }}>
                <span>Dist: {(distA / 1000).toFixed(2)} km</span>
                <span style={{ color: comfortA < 100 ? '#dc2626' : 'inherit' }}>Comfort: {comfortA}%</span>
              </div>
            </div>
            
            <div style={{ height: '1px', background: 'var(--border-color)', margin: '8px 0' }} />
            
            <div>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'bold' }}>Rider B (Follower)</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '4px' }}>
                <span>Dist Travelled: {(distB / 1000).toFixed(2)} km</span>
                <span style={{ color: comfortB < 100 ? '#dc2626' : 'inherit' }}>Comfort: {comfortB}%</span>
              </div>
              <div style={{ fontSize: '13px', marginTop: '4px' }}>
                <span>Safe Route Total: {totalSafeDistance > 0 ? (totalSafeDistance / 1000).toFixed(2) + ' km' : '---'}</span>
              </div>
              <div style={{ fontSize: '13px', marginTop: '4px' }}>
                Speed: <span style={{ fontWeight: 'bold', color: speedB <= 15 && speedB > 0 ? '#E8630A' : '#10b981' }}>{speedB} km/h</span>
              </div>
              <div style={{ fontSize: '13px', marginTop: '4px' }}>
                Simulated Sensor Z-Var: <span style={{ fontWeight: 'bold', color: comfortB < 100 ? '#E8630A' : '#10b981' }}>{comfortB < 100 ? (Math.random() * 5 + 10).toFixed(2) : (Math.random() * 0.5).toFixed(2)} g</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexDirection: 'column' }}>
            {phase === 'IDLE' && (
              <button onClick={startSimulation} style={{ padding: '10px', background: '#E8630A', color: '#fff', borderRadius: '8px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: 'none', cursor: 'pointer' }}>
                <Play size={16} /> Start Simulation
              </button>
            )}
            {(phase === 'RUNNING' || phase === 'WARNING') && (
              <button onClick={pauseSimulation} style={{ padding: '10px', background: 'rgba(15, 23, 42, 0.1)', color: 'var(--text-primary)', borderRadius: '8px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: '1px solid var(--border-color)', cursor: 'pointer' }}>
                <Pause size={16} /> Pause
              </button>
            )}
            {phase === 'PAUSED' && (
              <button onClick={resumeSimulation} style={{ padding: '10px', background: '#E8630A', color: '#fff', borderRadius: '8px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: 'none', cursor: 'pointer' }}>
                <Play size={16} /> Resume
              </button>
            )}
            {phase === 'COMPLETE' && (
              <button onClick={resetSimulation} style={{ padding: '10px', background: '#10b981', color: '#fff', borderRadius: '8px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: 'none', cursor: 'pointer' }}>
                <RefreshCw size={16} /> Replay
              </button>
            )}
          </div>
        </div>

        {activeWarning && (
          <div className="logs-panel" style={{ padding: '16px', background: 'rgba(220, 38, 38, 0.1)', border: '1px solid #dc2626' }}>
            <h3 style={{ color: '#dc2626', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <AlertTriangle size={18} /> Pothole Ahead!
            </h3>
            <p style={{ fontSize: '13px', color: '#7f1d1d' }}>{activeWarning.distance}m away — rerouting imminent.</p>
          </div>
        )}

        {phase === 'REROUTING' && (
          <div className="logs-panel" style={{ padding: '16px', background: 'rgba(37, 99, 235, 0.1)', border: '1px solid #2563eb' }}>
            <h3 style={{ color: '#2563eb', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <RefreshCw size={18} className="spin" /> Recalculating...
            </h3>
            <p style={{ fontSize: '13px', color: '#1e3a8a' }}>Finding safest alternative route.</p>
          </div>
        )}

        {phase === 'COMPLETE' && (
          <div className="logs-panel" style={{ padding: '16px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid #10b981' }}>
            <h3 style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <CheckCircle size={18} /> Safely Arrived!
            </h3>
            <p style={{ fontSize: '13px', color: '#064e3b' }}>Follower rider reached destination avoiding hazards.</p>
          </div>
        )}
        <p style={{ marginTop: '10px', fontSize: '12px', color: '#64748b' }}>Tip: Right-click on the map to set a new destination.</p>
      </div>

      <div className="map-view" style={{ flexGrow: 1, position: 'relative' }}>
        {isLoading && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(255,255,255,0.8)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <RefreshCw className="spin" size={32} style={{ color: '#E8630A', marginBottom: '10px' }} />
              <p>Loading routes...</p>
            </div>
          </div>
        )}
        <div ref={mapRef} style={{ width: '100%', height: '100%', borderRadius: '0' }} />
      </div>
    </div>
  );
}
