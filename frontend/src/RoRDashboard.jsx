import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { io } from 'socket.io-client';

export default function RoRDashboard() {
  const navigate = useNavigate();
  const [telemetryHistory, setTelemetryHistory] = useState([]);
  const [currentScore, setCurrentScore] = useState(100);
  const [events, setEvents] = useState([]);
  const socketRef = useRef(null);

  useEffect(() => {
    // Fill initial empty data for charts to look nice before data arrives
    const initialData = Array(15).fill(0).map((_, i) => ({
      time: `-${15 - i}s`,
      depth: 0,
      brake: 0,
      comfort: 100
    }));
    setTelemetryHistory(initialData);

    // Connect to WebSockets for real-time telemetry
    const socket = io('http://127.0.0.1:5000');
    socketRef.current = socket;

    socket.on('location_update', (data) => {
      const rider = data.rider;
      
      if (rider.telemetry) {
        const t = rider.telemetry;
        
        setCurrentScore(t.comfort_score);

        setTelemetryHistory(prev => {
          const newHistory = [...prev, {
            time: new Date().toLocaleTimeString().split(' ')[0],
            depth: t.depth_mm,
            brake: t.brake_intensity * 100,
            comfort: t.comfort_score
          }];
          return newHistory.slice(-15);
        });

        if (t.is_shock || t.is_braking) {
          setEvents(prev => {
            const newEvents = [{
              id: Date.now(),
              type: t.is_shock ? 'shock' : 'brake',
              msg: t.is_shock ? `Pothole hit! Depth: ${t.depth_mm.toFixed(1)}mm` : 'Emergency Braking Detected',
              time: new Date().toLocaleTimeString().split(' ')[0]
            }, ...prev];
            return newEvents.slice(0, 5);
          });
        }
      }
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const getScoreColor = (score) => {
    if (score > 80) return '#10b981'; // Green
    if (score > 50) return '#f59e0b'; // Amber
    return '#ef4444'; // Red
  };

  // Circular progress math
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (currentScore / 100) * circumference;

  return (
    <div style={{ background: '#fcfcfb', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', padding: '32px 64px', color: '#111827' }}>
      
      {/* Top Header / Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', fontSize: '13px', color: '#6b7280', marginBottom: '24px', gap: '8px' }}>
        <span style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontWeight: '500', color: '#374151' }}>A</span>
        <span>Khalto</span>
        <span>/</span>
        <span>🚗 Rigs of Rods</span>
        <span>/</span>
        <span style={{ fontWeight: '500', color: '#111827' }}>Overview</span>
      </div>

      {/* Main Title */}
      <h1 style={{ fontSize: '32px', fontWeight: '800', letterSpacing: '-0.5px', marginBottom: '24px', color: '#111827' }}>
        Overview
      </h1>

      {/* Pill Toggle */}
      <div style={{ display: 'inline-flex', background: '#f3f4f6', padding: '4px', borderRadius: '24px', marginBottom: '32px', gap: '4px' }}>
        <button 
          style={{ background: '#ffffff', border: 'none', padding: '6px 16px', borderRadius: '20px', fontSize: '13px', fontWeight: '600', color: '#111827', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <div style={{ width: '12px', height: '12px', background: `linear-gradient(135deg, #64748b 0%, #334155 100%)`, borderRadius: '3px' }}></div>
          Dashboard
        </button>
        <button 
          onClick={() => navigate('/')}
          style={{ background: 'transparent', border: 'none', padding: '6px 16px', borderRadius: '20px', fontSize: '13px', fontWeight: '500', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#9ca3af' }}></div>
          Map View
        </button>
      </div>

      {/* Top Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '24px', marginBottom: '24px' }}>
        
        {/* Card 1: Pothole Depth (Line Chart) */}
        <div style={{ background: '#ffffff', borderRadius: '12px', border: '1px solid #f3f4f6', padding: '24px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)' }}>
          <h3 style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500', marginBottom: '24px' }}>Pothole depth (mm)</h3>
          <div style={{ height: '180px', width: '100%' }}>
            <ResponsiveContainer>
              <LineChart data={telemetryHistory} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 11}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 11}} dx={-10} />
                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
                <Line type="monotone" dataKey="depth" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Card 2: Project Overview (Donut Chart replacement) */}
        <div style={{ background: '#ffffff', borderRadius: '12px', border: '1px solid #f3f4f6', padding: '24px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)', display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500', marginBottom: 'auto' }}>Comfort overview</h3>
          
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', height: '140px' }}>
            <svg width="120" height="120" viewBox="0 0 100 100">
              {/* Background ring */}
              <circle cx="50" cy="50" r={radius} fill="transparent" stroke="#f3f4f6" strokeWidth="8" />
              {/* Foreground ring */}
              <circle 
                cx="50" cy="50" r={radius} 
                fill="transparent" 
                stroke={getScoreColor(currentScore)} 
                strokeWidth="8" 
                strokeDasharray={circumference} 
                strokeDashoffset={strokeDashoffset} 
                strokeLinecap="round"
                transform="rotate(-90 50 50)" 
                style={{ transition: 'stroke-dashoffset 0.5s ease-in-out, stroke 0.5s ease' }}
              />
            </svg>
            <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: '28px', fontWeight: '700', color: '#111827', lineHeight: '1' }}>{currentScore.toFixed(0)}</span>
              <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '500', marginTop: '2px' }}>Score</span>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginTop: 'auto', paddingTop: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#3b82f6' }}></div>
              Smooth
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#6b7280' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#10b981' }}></div>
              Comfortable
            </div>
          </div>
        </div>

        {/* Card 3: Projects by Status (Bar Chart replacement) */}
        <div style={{ background: '#ffffff', borderRadius: '12px', border: '1px solid #f3f4f6', padding: '24px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)' }}>
          <h3 style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500', marginBottom: '24px' }}>Brake intensity</h3>
          <div style={{ height: '180px', width: '100%' }}>
            <ResponsiveContainer>
              <BarChart data={telemetryHistory} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 11}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 11}} dx={-10} domain={[0, 100]} />
                <Tooltip cursor={{fill: '#f3f4f6'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
                <Bar dataKey="brake" fill="#4b5563" radius={[2, 2, 0, 0]} isAnimationActive={false} barSize={12} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>

      {/* Bottom Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        
        {/* Placeholder / Timeline (Left) */}
        <div style={{ background: '#ffffff', borderRadius: '12px', border: '1px solid #f3f4f6', padding: '24px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <h3 style={{ fontSize: '13px', color: '#111827', fontWeight: '600' }}>Recent Telemetry Log</h3>
            <span style={{ fontSize: '13px', color: '#6b7280' }}>Today &gt;</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #f3f4f6', color: '#6b7280', textAlign: 'left' }}>
                <th style={{ paddingBottom: '12px', fontWeight: '500' }}>Time</th>
                <th style={{ paddingBottom: '12px', fontWeight: '500' }}>Depth</th>
                <th style={{ paddingBottom: '12px', fontWeight: '500' }}>Brake %</th>
                <th style={{ paddingBottom: '12px', fontWeight: '500' }}>Comfort</th>
              </tr>
            </thead>
            <tbody>
              {[...telemetryHistory].reverse().slice(0, 5).map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                  <td style={{ padding: '12px 0', color: '#111827' }}>{row.time}</td>
                  <td style={{ padding: '12px 0', color: '#4b5563' }}>{row.depth.toFixed(1)} mm</td>
                  <td style={{ padding: '12px 0', color: '#4b5563' }}>{row.brake.toFixed(0)}%</td>
                  <td style={{ padding: '12px 0' }}>
                    <span style={{ background: row.comfort > 80 ? '#ecfdf5' : '#fef2f2', color: row.comfort > 80 ? '#059669' : '#dc2626', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: '500' }}>
                      {row.comfort.toFixed(0)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Staff Review (Incident Log replacement) */}
        <div style={{ background: '#ffffff', borderRadius: '12px', border: '1px solid #f3f4f6', padding: '24px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02)' }}>
          <h3 style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500', marginBottom: '24px' }}>Incident review</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {events.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No incidents to review</div>
            ) : (
              events.map(ev => (
                <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '16px', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ fontSize: '16px' }}>{ev.type === 'shock' ? '💥' : '🛑'}</div>
                    <div style={{ fontSize: '13px', fontWeight: '500', color: '#111827' }}>{ev.msg}</div>
                  </div>
                  <div style={{ background: ev.type === 'shock' ? '#fee2e2' : '#fef3c7', color: ev.type === 'shock' ? '#991b1b' : '#92400e', padding: '4px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '600' }}>
                    {ev.type === 'shock' ? 'Needs review' : 'Pending'}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
