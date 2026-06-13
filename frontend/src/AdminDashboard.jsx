import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { io } from 'socket.io-client';

// Fix Leaflet's default icon path issues with Webpack/Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Custom colored icons for pothole statuses
const createIcon = (color) => {
  return new L.Icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
  });
};

const ICONS = {
  Active: createIcon('red'),
  Unverified: createIcon('orange'),
  Patched: createIcon('green')
};

function MapUpdater({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.setView(center, 18, { animate: true });
    }
  }, [center, map]);
  return null;
}

export default function AdminDashboard() {
  const [potholes, setPotholes] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [filter, setFilter] = useState('All'); // All, Active, Unverified, Patched
  const socketRef = useRef(null);

  const fetchPotholes = async () => {
    try {
      const res = await fetch('http://127.0.0.1:5000/api/potholes');
      if (res.ok) {
        const data = await res.json();
        setPotholes(data);
      }
    } catch (e) {
      console.error('Error fetching potholes:', e);
    }
  };

  useEffect(() => {
    fetchPotholes();

    const socket = io('http://127.0.0.1:5000');
    socketRef.current = socket;
    
    socket.on('sync_event', () => {
      fetchPotholes();
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  const updateStatus = async (id, newStatus) => {
    try {
      const res = await fetch(`http://127.0.0.1:5000/api/potholes/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        fetchPotholes(); // Real-time sync event will also fire, but we eagerly fetch
      }
    } catch (e) {
      console.error('Error updating status:', e);
    }
  };

  const filteredPotholes = potholes.filter(p => filter === 'All' || p.status === filter);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#f8fafc' }}>
      
      {/* LEFT PANE: List View */}
      <div style={{ width: '400px', backgroundColor: '#fff', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column' }}>
        
        {/* Header */}
        <div style={{ padding: '24px', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: '800', margin: 0, color: '#0f172a' }}>Admin Hub</h1>
            <Link to="/" style={{ fontSize: '12px', color: '#3b82f6', textDecoration: 'none', fontWeight: '600' }}>Exit</Link>
          </div>
          
          {/* Filters */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {['All', 'Active', 'Unverified', 'Patched'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '16px',
                  border: '1px solid',
                  borderColor: filter === f ? '#3b82f6' : '#cbd5e1',
                  backgroundColor: filter === f ? '#eff6ff' : '#fff',
                  color: filter === f ? '#1d4ed8' : '#64748b',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          {filteredPotholes.map(p => (
            <div 
              key={p.id} 
              onClick={() => setSelectedLocation([p.lat, p.lng])}
              style={{
                backgroundColor: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '12px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
                borderColor: selectedLocation && selectedLocation[0] === p.lat ? '#3b82f6' : '#e2e8f0'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '14px', fontWeight: '700', color: '#0f172a' }}>ID: #{p.id}</span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: '700',
                  padding: '4px 8px',
                  borderRadius: '12px',
                  backgroundColor: p.status === 'Active' ? '#fee2e2' : p.status === 'Patched' ? '#dcfce3' : '#ffedd5',
                  color: p.status === 'Active' ? '#991b1b' : p.status === 'Patched' ? '#166534' : '#9a3412'
                }}>
                  {p.status}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
                Type: {p.anomaly_type.replace('_', ' ')}<br/>
                Severity: <span style={{ textTransform: 'capitalize' }}>{p.severity}</span> (Reports: {p.report_count})
              </div>

              {/* Status Action Buttons */}
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                {['Unverified', 'Active', 'Patched'].map(action => (
                  <button
                    key={action}
                    onClick={(e) => { e.stopPropagation(); updateStatus(p.id, action); }}
                    disabled={p.status === action}
                    style={{
                      flex: 1,
                      padding: '6px',
                      fontSize: '11px',
                      fontWeight: '600',
                      borderRadius: '4px',
                      border: 'none',
                      cursor: p.status === action ? 'not-allowed' : 'pointer',
                      backgroundColor: p.status === action ? '#f1f5f9' : '#e2e8f0',
                      color: p.status === action ? '#94a3b8' : '#334155'
                    }}
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filteredPotholes.length === 0 && (
            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', marginTop: '40px' }}>
              No potholes found for this filter.
            </div>
          )}
        </div>
      </div>

      {/* RIGHT PANE: Minimap */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer 
          center={selectedLocation || [27.7172, 85.3240]} 
          zoom={14} 
          style={{ width: '100%', height: '100%' }}
        >
          <TileLayer
            url="https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          />
          <MapUpdater center={selectedLocation} />
          
          {filteredPotholes.map(p => (
            <Marker 
              key={p.id} 
              position={[p.lat, p.lng]} 
              icon={ICONS[p.status] || ICONS['Active']}
            >
              <Popup>
                <strong>ID: #{p.id}</strong><br/>
                Status: {p.status}<br/>
                Severity: {p.severity}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

    </div>
  );
}
