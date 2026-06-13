import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, Trophy, Settings } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

const SEVERITY_COLORS = {
  high: '#ef4444',
  medium: '#f97316',
  low: '#eab308'
};

const ANOMALY_CONFIG = {
  pothole: { color: '#ef4444', label: 'Pothole', icon: '🕳️' },
  speed_bump: { color: '#d97706', label: 'Speed Bump', icon: '🐫' },
  rough_road: { color: '#854d0e', label: 'Rough Road', icon: '🚧' },
  sudden_brake: { color: '#7c3aed', label: 'Sudden Braking', icon: '⚠️' }
};

const KATHMANDU_CENTER = { lat: 27.7172, lng: 85.3240 };

// Point-to-segment distance calculation in meters
function getDistanceToSegment(p, a, b) {
  const latToMeters = 111132;
  const lngToMeters = (40008000 * Math.cos((a.lat * Math.PI) / 180)) / 360;

  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * lngToMeters;
  const by = (b.lat - a.lat) * latToMeters;
  const px = (p.lng - a.lng) * lngToMeters;
  const py = (p.lat - a.lat) * latToMeters;

  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, (px * abx + py * aby) / (abx * abx + aby * aby || 1)));

  const nearestX = ax + t * abx;
  const nearestY = ay + t * aby;

  const dx = px - nearestX;
  const dy = py - nearestY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getDistanceToRoute(pothole, routePath) {
  let minDistance = Infinity;
  for (let i = 0; i < routePath.length - 1; i++) {
    const a = { lat: routePath[i][0], lng: routePath[i][1] };
    const b = { lat: routePath[i + 1][0], lng: routePath[i + 1][1] };
    const dist = getDistanceToSegment(pothole, a, b);
    if (dist < minDistance) {
      minDistance = dist;
    }
  }
  return minDistance;
}

// SVG Sparkline Component for Accelerometer waveforms
function TelemetrySparkline({ data }) {
  if (!data) return null;
  let samples = [];
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    samples = parsed.svm || parsed || [];
  } catch (e) {
    return null;
  }

  if (samples.length === 0) return null;

  const maxVal = Math.max(...samples.map(Math.abs), 1.0);
  const width = 160;
  const height = 30;
  const points = samples
    .map((val, idx) => {
      const x = (idx / (samples.length - 1)) * width;
      const y = (height / 2) - (val / maxVal) * (height / 2 - 2);
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '9px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>SVM Waveform:</span>
      <svg width={width} height={height} style={{ background: 'rgba(15, 23, 42, 0.05)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
        <polyline
          fill="none"
          stroke="#2563eb"
          strokeWidth="1.5"
          points={points}
        />
        <line x1="0" y1={height/2} x2={width} y2={height/2} stroke="rgba(15, 23, 42, 0.08)" strokeDasharray="2,2" />
      </svg>
    </div>
  );
}

// Leaflet Map Component rendering Potholes, Incidents, Riders, & Routes
function LeafletMap({ center, potholes, incidents, riders, startPoint, endPoint, routePath, encounteredPotholeIds, onMapClick }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const elementsRef = useRef([]);

  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    if (!mapRef.current) return;

    // Initialize Leaflet map
    const map = L.map(mapRef.current, {
      center: [center.lat, center.lng],
      zoom: 15,
      zoomControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(map);

    // Add CartoDB Voyager light tiles
    L.tileLayer('https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      if (onMapClickRef.current) {
        onMapClickRef.current(lat, lng);
      }
    });

    mapInstance.current = map;

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // Pan map when center changes
  useEffect(() => {
    if (mapInstance.current) {
      mapInstance.current.panTo([center.lat, center.lng]);
    }
  }, [center]);

  // Redraw layers
  useEffect(() => {
    if (!mapInstance.current) return;

    // Remove old layers
    elementsRef.current.forEach(el => el.remove());
    elementsRef.current = [];

    // 1. Draw Verified Potholes
    potholes.forEach((p) => {
      const isEncountered = encounteredPotholeIds && encounteredPotholeIds.includes(p.id);
      const typeConfig = ANOMALY_CONFIG[p.anomaly_type] || ANOMALY_CONFIG.pothole;
      const circleColor = isEncountered ? '#ef4444' : typeConfig.color;

      const circle = L.circle([p.lat, p.lng], {
        color: circleColor,
        fillColor: circleColor,
        fillOpacity: isEncountered ? 0.75 : 0.45,
        radius: isEncountered ? 12 : (p.severity === 'high' ? 8 : p.severity === 'medium' ? 6 : 4),
        weight: isEncountered ? 4 : 2
      }).addTo(mapInstance.current);

      const popupContent = `
        <div style="color: #0f172a; font-family: sans-serif; padding: 6px; font-size: 13px; min-width: 200px;">
          <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 800; color: ${circleColor}">
            ${isEncountered ? '⚠️ HAZARD ON YOUR ROUTE' : `${typeConfig.icon} VERIFIED ${typeConfig.label.toUpperCase()}`}
          </h3>
          ${p.road_name ? `<div style="margin: 4px 0 6px 0; font-weight: 800; color: #1e293b; font-size: 12px;">📍 ${p.road_name}</div>` : ''}
          <div style="margin: 4px 0; border-top: 1px dashed #e2e8f0; padding-top: 4px; font-size: 11px;">
            <strong>Urgency Priority:</strong> <span style="color: ${circleColor}; font-weight: 900;">${p.urgency_score || '0.0'}/100</span>
          </div>
          <div style="margin: 2px 0; font-size: 11px;">
            <strong>Est. Depth:</strong> ${p.depth_mm ? p.depth_mm.toFixed(1) : '0.0'} mm
          </div>
          <div style="margin: 2px 0; font-size: 11px;">
            <strong>Surface Area:</strong> ${p.area_cm2 ? p.area_cm2.toFixed(0) : '0'} cm²
          </div>
          <div style="margin: 2px 0; font-size: 11px;">
            <strong>Reports Count:</strong> ${p.report_count}
          </div>
          ${p.contractor ? `<div style="margin: 3px 0 1px 0; font-size: 10px; color: #475569; border-top: 1px solid #f1f5f9; padding-top: 3px;"><strong>Contractor:</strong> ${p.contractor}</div>` : ''}
          ${p.road_creation_date ? `<div style="margin: 1px 0; font-size: 10px; color: #475569;"><strong>Last Resurfaced:</strong> ${p.road_creation_date}</div>` : ''}
          <div style="margin: 6px 0 2px 0; font-size: 9px; color: #94a3b8; border-top: 1px solid #cbd5e1; padding-top: 4px;">
            Coordinates: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
          </div>
        </div>
      `;

      circle.bindPopup(popupContent);
      elementsRef.current.push(circle);
    });

    // 2. Draw Unverified Shock Incidents
    incidents.forEach((inc) => {
      const incType = inc.anomaly_type || 'pothole';
      const typeConfig = ANOMALY_CONFIG[incType] || ANOMALY_CONFIG.pothole;

      const circle = L.circle([inc.lat, inc.lng], {
        color: typeConfig.color,
        fillColor: typeConfig.color,
        fillOpacity: 0.25,
        radius: 5,
        weight: 1.5,
        dashArray: '4, 4'
      }).addTo(mapInstance.current);

      const popupContent = `
        <div style="color: #0f172a; font-family: sans-serif; padding: 6px; font-size: 13px; min-width: 180px;">
          <h3 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 800; color: ${typeConfig.color}">
            UNVERIFIED ${typeConfig.label.toUpperCase()}
          </h3>
          ${inc.road_name ? `<div style="margin: 3px 0; font-weight: 700; color: #1e293b;">📍 ${inc.road_name}</div>` : ''}
          <div style="margin: 3px 0; font-weight: 500;">
            <strong>Reporter:</strong> ${inc.fingerprint}
          </div>
          <div style="margin: 3px 0; font-weight: 500;">
            <strong>Speed:</strong> ${inc.speed ? inc.speed.toFixed(1) : '0.0'} m/s
          </div>
          <div style="margin: 3px 0; font-weight: 500;">
            <strong>Urgency:</strong> ${inc.urgency_score || '0.0'} / 100
          </div>
          <div style="margin: 8px 0 3px 0; font-size: 11px; color: #475569; border-top: 1px solid #cbd5e1; padding-top: 6px;">
            📍 ${inc.lat.toFixed(5)}, ${inc.lng.toFixed(5)}
          </div>
          <div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">
            Time: ${inc.created_at}
          </div>
        </div>
      `;

      circle.bindPopup(popupContent);
      elementsRef.current.push(circle);
    });

    // 3. Draw Active Tracked Riders
    riders.forEach((r) => {
      const riderIcon = L.divIcon({
        className: 'custom-rider-icon',
        html: `<div class="rider-dot-pulse"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });

      const marker = L.marker([r.lat, r.lng], { icon: riderIcon }).addTo(mapInstance.current);

      const popupContent = `
        <div style="color: #0f172a; font-family: sans-serif; padding: 6px; font-size: 13px; min-width: 170px;">
          <h3 style="margin: 0 0 4px 0; font-size: 14px; font-weight: 800; color: #3b82f6">
            ACTIVE RIDER
          </h3>
          <div style="margin: 2px 0;"><strong>Name:</strong> ${r.friendly_name}</div>
          <div style="margin: 2px 0;"><strong>Speed:</strong> ${r.speed.toFixed(1)} m/s (${(r.speed * 3.6).toFixed(0)} km/h)</div>
          <div style="margin: 2px 0;"><strong>Vehicle:</strong> ${r.vehicle_class || r.vehicle_type}</div>
          <div style="margin: 2px 0;"><strong>Suspension health:</strong> ${r.vehicle_health ? r.vehicle_health.toFixed(1) : '100.0'}%</div>
          <div style="margin: 6px 0 2px 0; font-size: 10px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 4px;">
            Last updated: ${r.updated_at.split('T')[1].substring(0, 8)}
          </div>
        </div>
      `;

      marker.bindPopup(popupContent);
      elementsRef.current.push(marker);
    });

    // 4. Draw Start Point CircleMarker
    if (startPoint) {
      const startMarker = L.circleMarker([startPoint.lat, startPoint.lng], {
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.9,
        radius: 10,
        weight: 3
      }).addTo(mapInstance.current);
      startMarker.bindPopup("<strong>Start Point</strong>");
      elementsRef.current.push(startMarker);
    }

    // 5. Draw Destination CircleMarker
    if (endPoint) {
      const endMarker = L.circleMarker([endPoint.lat, endPoint.lng], {
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.9,
        radius: 10,
        weight: 3
      }).addTo(mapInstance.current);
      endMarker.bindPopup("<strong>Destination Point</strong>");
      elementsRef.current.push(endMarker);
    }

    // 6. Draw Route Polyline
    if (routePath && routePath.length > 0) {
      const routePolyline = L.polyline(routePath, {
        color: '#3b82f6',
        weight: 6,
        opacity: 0.65,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(mapInstance.current);
      elementsRef.current.push(routePolyline);
    }

  }, [potholes, incidents, riders, startPoint, endPoint, routePath, encounteredPotholeIds]);

  return <div ref={mapRef} style={{ width: '100%', height: '100%', borderRadius: '12px', background: '#f1f5f9' }} />;
}
import { Link } from 'react-router-dom';

export default function MainMap() {
  // Application Data State
  const [potholes, setPotholes] = useState([]);
  const [stats, setStats] = useState({ total_reports: 0, verified_potholes: 0, high_severity: 0 });
  const [mapCenter, setMapCenter] = useState(KATHMANDU_CENTER);
  const [incidents, setIncidents] = useState([]);
  const [riders, setRiders] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);

  // Routing and Auditor States
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [routePath, setRoutePath] = useState([]);
  const [routeInfo, setRouteInfo] = useState(null);
  const [encounteredPotholeIds, setEncounteredPotholeIds] = useState([]);

  // Demo Mode State
  const [demoMode, setDemoMode] = useState(false);
  const [demoSeverity, setDemoSeverity] = useState('medium');
  const [demoCount, setDemoCount] = useState(0);

  const prevIncidentsLengthRef = useRef(0);

  // Auto-center map when new shocks arrive
  useEffect(() => {
    if (incidents.length > prevIncidentsLengthRef.current) {
      const latest = incidents[0];
      if (latest) {
        setMapCenter({ lat: latest.lat, lng: latest.lng });
      }
    } else if (incidents.length === 0 && potholes.length > 0) {
      setMapCenter({ lat: potholes[0].lat, lng: potholes[0].lng });
    }
    prevIncidentsLengthRef.current = incidents.length;
  }, [incidents, potholes]);

  // Fetch driving route and audit for potholes along the path
  useEffect(() => {
    if (!startPoint || !endPoint) {
      setRoutePath([]);
      setRouteInfo(null);
      setEncounteredPotholeIds([]);
      return;
    }

    const fetchRoute = async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const route = data.routes[0];
          if (route) {
            const coords = route.geometry.coordinates.map(c => [c[1], c[0]]); // Leaflet wants [lat, lng]
            setRoutePath(coords);

            const distance = route.distance / 1000.0; // km
            const duration = route.duration / 60.0; // minutes

            // Calculate intersecting potholes
            const encounteredIds = [];
            const obstacleCounts = { pothole: 0, speed_bump: 0, rough_road: 0, sudden_brake: 0 };
            potholes.forEach(p => {
              const dist = getDistanceToRoute(p, coords);
              if (dist < 25.0) { // 25 meters threshold
                encounteredIds.push(p.id);
                const type = p.anomaly_type || 'pothole';
                obstacleCounts[type] = (obstacleCounts[type] || 0) + 1;
              }
            });

            setEncounteredPotholeIds(encounteredIds);
            setRouteInfo({
              distance,
              duration,
              potholeCount: encounteredIds.length,
              obstacleCounts
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch route from OSRM:", err);
      }
    };

    fetchRoute();
  }, [startPoint, endPoint, potholes]);

  const clearRoute = () => {
    setStartPoint(null);
    setEndPoint(null);
  };

  const handleMapClick = async (lat, lng) => {
    if (demoMode) {
      // Demo Mode: place a pothole at clicked location
      try {
        const res = await fetch('/api/demo/pothole', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lng, severity: demoSeverity, anomaly_type: 'pothole' })
        });
        if (res.ok) {
          setDemoCount(prev => prev + 1);
          fetchPublicData();
        }
      } catch (err) {
        console.error('Demo pothole placement failed:', err);
      }
      return;
    }
    if (!startPoint) {
      setStartPoint({ lat, lng });
    } else if (!endPoint) {
      setEndPoint({ lat, lng });
    } else {
      setStartPoint({ lat, lng });
      setEndPoint(null);
    }
  };

  const fetchPublicData = async () => {
    try {
      const resP = await fetch('/api/potholes');
      const dataP = await resP.json();
      setPotholes(dataP);

      const resS = await fetch('/api/stats');
      const dataS = await resS.json();
      setStats(dataS);

      const resI = await fetch('/api/incidents');
      const dataI = await resI.json();
      setIncidents(dataI);

      const resR = await fetch('/api/locations');
      const dataR = await resR.json();
      setRiders(dataR);

      const resL = await fetch('/api/leaderboard');
      if (resL.ok) {
        const dataL = await resL.json();
        setLeaderboard(dataL);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
    }
  };

  useEffect(() => {
    fetchPublicData();

    // SSE updates connection (no token header needed)
    const eventSource = new EventSource(`/api/stream`);

    eventSource.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync') {
          fetchPublicData();
        } else if (msg.type === 'location_update') {
          setRiders(prev => {
            const filtered = prev.filter(r => (r.rider_key || r.username) !== (msg.rider.rider_key || msg.rider.username));
            return [...filtered, msg.rider];
          });
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      console.debug('SSE connection error. Retrying...');
    };

    const interval = setInterval(fetchPublicData, 1000);

    return () => {
      eventSource.close();
      clearInterval(interval);
    };
  }, []);

  const resetDB = async () => {
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      console.log('Database reset: ' + data.status);
      fetchPublicData();
    } catch (err) {
      console.error('Error resetting database: ' + err.message);
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar Panel */}
      <div className="sidebar" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '450px', minWidth: '420px' }}>
        <div className="brand" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1>Khalto</h1>
          </div>
          <button onClick={resetDB} className="reset-btn" style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }} title="Reset Database">
            <RefreshCw size={12} /> Reset
          </button>
        </div>
        <p className="subtitle" style={{ marginBottom: '10px' }}>Real-time Crowdsourced Pothole Tracker</p>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <Link to="/" style={{ flex: 1, padding: '8px', textAlign: 'center', background: '#3b82f6', color: '#fff', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>Map View</Link>
          <Link to="/rigsofrod" style={{ flex: 1, padding: '8px', textAlign: 'center', background: 'rgba(15, 23, 42, 0.05)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none' }}>Simulator</Link>
        </div>

        {/* Demo Mode Panel */}
        <div className="logs-panel" style={{ flexGrow: 0, marginBottom: '14px', padding: '12px', border: demoMode ? '2px solid #f59e0b' : '1px solid var(--border-color)', background: demoMode ? 'rgba(245, 158, 11, 0.06)' : undefined }}>
          <div className="logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px', color: demoMode ? '#d97706' : 'var(--text-secondary)' }}>
              🎯 Demo Mode
            </h3>
            <button
              onClick={() => setDemoMode(!demoMode)}
              style={{
                background: demoMode ? '#f59e0b' : 'rgba(15, 23, 42, 0.05)',
                border: demoMode ? '1px solid #d97706' : '1px solid var(--border-color)',
                borderRadius: '6px',
                padding: '4px 12px',
                fontSize: '10px',
                fontWeight: '700',
                color: demoMode ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer'
              }}
            >
              {demoMode ? 'ON' : 'OFF'}
            </button>
          </div>
          {demoMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '11px', color: '#92400e', fontWeight: '600' }}>
                👆 Click anywhere on the map to place a pothole
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: '600' }}>Severity:</span>
                {['low', 'medium', 'high'].map(s => (
                  <button
                    key={s}
                    onClick={() => setDemoSeverity(s)}
                    style={{
                      padding: '3px 10px',
                      fontSize: '10px',
                      fontWeight: '700',
                      borderRadius: '4px',
                      border: demoSeverity === s ? '1px solid' : '1px solid var(--border-color)',
                      background: demoSeverity === s
                        ? (s === 'high' ? '#ef4444' : s === 'medium' ? '#f59e0b' : '#eab308')
                        : 'rgba(15, 23, 42, 0.03)',
                      color: demoSeverity === s ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      textTransform: 'capitalize'
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {demoCount > 0 && (
                <div style={{ fontSize: '10px', color: '#16a34a', fontWeight: '600' }}>
                  ✅ {demoCount} demo pothole{demoCount > 1 ? 's' : ''} placed — walk within 10m to trigger phone vibration
                </div>
              )}
            </div>
          )}
        </div>

        {/* Route Hazard Auditor Panel */}
        <div className="logs-panel" style={{ flexGrow: 0, marginBottom: '14px', padding: '12px' }}>
          <div className="logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <Settings size={11} style={{ color: '#3b82f6' }} />
              Route Hazard Auditor
            </h3>
            {(startPoint || endPoint) && (
              <button onClick={clearRoute} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '4px', padding: '2px 8px', fontSize: '9px', color: '#fca5a5', cursor: 'pointer' }}>
                Clear
              </button>
            )}
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(15, 23, 42, 0.03)', border: '1px solid var(--border-color)', padding: '6px 10px', borderRadius: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }}></span>
              <span>
                <strong>Start:</strong> {startPoint ? `${startPoint.lat.toFixed(4)}, ${startPoint.lng.toFixed(4)}` : "Click map to set Start"}
              </span>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(15, 23, 42, 0.03)', border: '1px solid var(--border-color)', padding: '6px 10px', borderRadius: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }}></span>
              <span>
                <strong>Destination:</strong> {endPoint ? `${endPoint.lat.toFixed(4)}, ${endPoint.lng.toFixed(4)}` : startPoint ? "Click map to set Destination" : "Set start first"}
              </span>
            </div>
          </div>

          {routeInfo && (
            <div style={{ marginTop: '10px', padding: '8px 12px', background: routeInfo.potholeCount > 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(16, 185, 129, 0.08)', border: `1px solid ${routeInfo.potholeCount > 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'}`, borderRadius: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '4px' }}>
                <span>Distance: {routeInfo.distance.toFixed(1)} km</span>
                <span>Time: {routeInfo.duration.toFixed(0)} mins</span>
              </div>
              <div style={{ fontSize: '11px', color: routeInfo.potholeCount > 0 ? '#dc2626' : '#16a34a', fontWeight: '800' }}>
                🚨 {routeInfo.potholeCount > 0 ? `Alert: ${routeInfo.potholeCount} hazards on this route!` : "Route clear! No hazards detected."}
              </div>
              {routeInfo.potholeCount > 0 && (
                <div style={{ fontSize: '9px', color: 'var(--text-secondary)', display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px', borderTop: '1px solid var(--border-color)', paddingTop: '4px' }}>
                  {routeInfo.obstacleCounts.pothole > 0 && <span>🕳️ Potholes: {routeInfo.obstacleCounts.pothole}</span>}
                  {routeInfo.obstacleCounts.speed_bump > 0 && <span>🐫 Bumps: {routeInfo.obstacleCounts.speed_bump}</span>}
                  {routeInfo.obstacleCounts.rough_road > 0 && <span>🚧 Rough: {routeInfo.obstacleCounts.rough_road}</span>}
                  {routeInfo.obstacleCounts.sudden_brake > 0 && <span>⚠️ Braking: {routeInfo.obstacleCounts.sudden_brake}</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Stats Section */}
        <div className="stats-container" style={{ marginBottom: '14px' }}>
          <div className="stat-card">
            <span className="stat-num">{stats.verified_potholes}</span>
            <span className="stat-label">Verified Potholes</span>
          </div>
          <div className="stat-card urgent">
            <span className="stat-num">{stats.high_severity}</span>
            <span className="stat-label">High Severity</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.total_reports}</span>
            <span className="stat-label">Total Reports</span>
          </div>
        </div>

        {/* Live Tracked Riders with Vehicle Health */}
        <div className="logs-panel" style={{ flexGrow: 0.8, display: 'flex', flexDirection: 'column', minHeight: '130px', marginBottom: '10px' }}>
          <div className="logs-header">
            <h3>Online Riders & Vehicle Health</h3>
          </div>
          <div style={{ overflowY: 'auto', flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {riders.length === 0 ? (
              <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', padding: '4px 0' }}>No riders currently online.</div>
            ) : (
              riders.map((r) => {
                const health = r.vehicle_health !== undefined ? r.vehicle_health : 100.0;
                const isOffroad = r.vehicle_class && r.vehicle_class.toLowerCase().includes('off-road');
                return (
                  <div 
                    key={r.rider_key || r.username} 
                    className="rider-item"
                    onClick={() => setMapCenter({ lat: r.lat, lng: r.lng })}
                    style={{ 
                      display: 'flex', 
                      flexDirection: 'column',
                      background: 'rgba(15, 23, 42, 0.02)', 
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      cursor: 'pointer'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--text-primary)' }}>{r.friendly_name}</span>
                      <span style={{ fontSize: '9px', color: isOffroad ? '#2563eb' : '#7c3aed', fontWeight: '600' }}>
                        {r.vehicle_class || r.vehicle_type}
                      </span>
                    </div>
                    
                    {/* Health bar visualization */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ flexGrow: 1, height: '4px', background: 'rgba(15, 23, 42, 0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ width: `${health}%`, height: '100%', background: health > 70 ? '#10b981' : health > 40 ? '#f59e0b' : '#ef4444', borderRadius: '2px' }} />
                      </div>
                      <span style={{ fontSize: '9px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{health.toFixed(0)}% Health</span>
                    </div>
                    <span style={{ fontSize: '8px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      Velocity: {r.speed ? r.speed.toFixed(1) : '0.0'} m/s | Latency Compensation Active
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Crowdsourced Leaderboard */}
        <div className="logs-panel" style={{ flexGrow: 0.6, display: 'flex', flexDirection: 'column', minHeight: '110px', marginBottom: '10px' }}>
          <div className="logs-header" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Trophy size={11} style={{ color: '#f59e0b' }} />
            <h3>Top Pothole Detectors</h3>
          </div>
          <div style={{ overflowY: 'auto', flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {leaderboard.length === 0 ? (
              <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic', padding: '4px 0' }}>No leaderboard records yet.</div>
            ) : (
              leaderboard.map((item, idx) => (
                <div 
                  key={item.username} 
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    fontSize: '10px', 
                    background: 'rgba(15, 23, 42, 0.01)', 
                    padding: '4px 8px', 
                    borderRadius: '4px' 
                  }}
                >
                  <span style={{ color: 'var(--text-primary)' }}>
                    <strong style={{ color: idx === 0 ? '#d97706' : idx === 1 ? '#475569' : idx === 2 ? '#b45309' : '#64748b' }}>
                      #{idx + 1}
                    </strong> {item.friendly_name}
                  </span>
                  <span style={{ fontFamily: 'monospace', color: '#2563eb', fontWeight: 'bold' }}>
                    {item.reports_count} shocks
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Anonymous Incident Log Stream */}
        <div className="logs-panel" style={{ flexGrow: 1.2, display: 'flex', flexDirection: 'column', height: '0', minHeight: '200px' }}>
          <div className="logs-header">
            <h3>Anonymous Incident Stream</h3>
          </div>
          <div className="logs-body" style={{ flexGrow: 1, overflowY: 'auto' }}>
            {incidents.length === 0 ? (
              <div className="log-line">No incidents synced yet.</div>
            ) : (
              incidents.map((inc) => {
                const incType = inc.anomaly_type || 'pothole';
                const typeConfig = ANOMALY_CONFIG[incType] || ANOMALY_CONFIG.pothole;
                return (
                  <div key={inc.id} className="log-line" style={{ marginBottom: 10, borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                    <span className="log-time" style={{ display: 'block', fontSize: '9px', color: 'var(--text-secondary)' }}>
                      {inc.created_at.split(' ')[1] || ''}
                    </span>
                    <span className="log-text" style={{ fontSize: '11px', lineHeight: '1.4' }}>
                      <strong style={{ color: inc.vehicle_type === 'Car' ? '#2563eb' : '#10b981' }}>
                        {inc.fingerprint}
                      </strong> ({inc.vehicle_type}) reported <strong style={{ color: typeConfig.color }}>{typeConfig.label.toUpperCase()}</strong> ({inc.severity})
                      {inc.road_name ? ` at <strong>${inc.road_name}</strong>` : ` at ${inc.lat.toFixed(5)}, ${inc.lng.toFixed(5)}`}
                      <span style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        ⚡ Speed: {inc.speed ? inc.speed.toFixed(1) : '0.0'} m/s | Depth/Height: {inc.depth_mm || 0} mm | Urgency: {inc.urgency_score || 0}/100
                      </span>
                    </span>
                    <TelemetrySparkline data={inc.telemetry} />
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Map View */}
      <div className="map-view">
        <LeafletMap 
          center={mapCenter} 
          potholes={potholes} 
          incidents={incidents} 
          riders={riders}
          startPoint={startPoint}
          endPoint={endPoint}
          routePath={routePath}
          encounteredPotholeIds={encounteredPotholeIds}
          onMapClick={handleMapClick}
        />
      </div>
    </div>
  );
}
