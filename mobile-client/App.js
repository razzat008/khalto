import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Switch, ScrollView, TouchableOpacity, Vibration, Platform, TextInput } from 'react-native';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import MapView, { Circle, UrlTile } from 'react-native-maps';
import * as Application from 'expo-application';

import { 
  initDatabase, 
  insertTelemetry, 
  getUnsyncedReports, 
  markReportsAsSynced, 
  pruneSyncedReports,
  getOrCreateDeviceFingerprint,
  saveAuthSession,
  getAuthSession,
  clearAuthSession
} from './src/data/db';

const WINDOW_SIZE = 50; // 1 second of data at 50Hz
const VERTICAL_THRESHOLD = 3.0; // High tolerance — only real potholes and hard bumps trigger detection
const SERVER_IP = '192.168.101.254'; // Flask backend IP address

// Math helper: Haversine distance in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export default function App() {
  // Authentication State
  const [authToken, setAuthToken] = useState(null);
  const [username, setUsername] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [deviceId, setDeviceId] = useState('');

  // Auth UI Form State
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Vehicle Class State
  const [vehicleClass, setVehicleClass] = useState('Standard Bike'); // 'Standard Bike', 'Off-Road Bike', 'Standard Car', 'Off-Road SUV'
  const [suspensionHealth, setSuspensionHealth] = useState(100.0);

  // App Functional State
  const [isRecording, setIsRecording] = useState(false);
  const [logs, setLogs] = useState([]);
  const [connectionType, setConnectionType] = useState('unknown');
  const [isConnected, setIsConnected] = useState(false);
  const [deviceFingerprint, setDeviceFingerprint] = useState('');
  const [remoteAlert, setRemoteAlert] = useState(null);
  
  // Real-Time Acceleration & Gravity telemetry displayed on screen
  const [accelerometerData, setAccelerometerData] = useState({ x: 0, y: 0, z: 0, variance: 0 });

  // Location States
  const [userLocation, setUserLocation] = useState(null);
  const [potholes, setPotholes] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [activeWarning, setActiveWarning] = useState(null);
  const mapRef = useRef(null);

  const verticalBuffer = useRef([]);
  const xBuffer = useRef([]);
  const yBuffer = useRef([]);
  const zBuffer = useRef([]);
  const gyroBuffer = useRef([]);
  const lastDetection = useRef(0);
  const lastWarned = useRef({}); // Caches last warned pothole timestamps

  // Sensor orientation refs
  const gravityRef = useRef({ x: 0, y: 0, z: 1.0 }); // Locks onto downward gravity
  const gyroDataRef = useRef({ x: 0, y: 0, z: 0 });

  // High-rate EKF / Dead Reckoning state
  const deadReckoningState = useRef({
    lat: null,
    lng: null,
    speed: 0,
    heading: 0,
    lastUpdateTime: 0
  });

  // Keep references to avoid React state closure stale reference issues
  const deviceFingerprintRef = useRef('');
  const authTokenRef = useRef('');
  const sseXhrRef = useRef(null);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const addLog = (msg) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 15)]);
  };

  // Helper to read hardware identifier
  const getDeviceHardwareId = async () => {
    try {
      if (Platform.OS === 'android') {
        return Application.androidId || null;
      } else if (Platform.OS === 'ios') {
        return await Application.getIosIdForVendorAsync();
      }
    } catch (e) {
      console.warn('Failed to retrieve hardware id', e);
    }
    return null;
  };

  // Log out helper
  const handleLogout = async () => {
    if (sseXhrRef.current) {
      try {
        sseXhrRef.current.abort();
      } catch (e) {}
      sseXhrRef.current = null;
    }
    await clearAuthSession();
    setAuthToken(null);
    authTokenRef.current = '';
    setUsername('');
    setFriendlyName('');
    setDeviceId('');
    setDeviceFingerprint('');
    deviceFingerprintRef.current = '';
    setAuthUsername('');
    setAuthPassword('');
    setAuthError('');
    setPotholes([]);
    setIncidents([]);
    addLog('Logged out successfully.');
  };

  // 1. Initial configuration and state load
  useEffect(() => {
    initDatabase()
      .then(async () => {
        addLog('SQLite database initialized.');
        
        // Retrieve cached session
        const session = await getAuthSession();
        if (session && session.token) {
          setAuthToken(session.token);
          authTokenRef.current = session.token;
          setUsername(session.username);
          setFriendlyName(session.friendlyName);
          setDeviceId(session.deviceId);
          setDeviceFingerprint(session.deviceId);
          deviceFingerprintRef.current = session.deviceId;
          
          addLog(`Logged in as ${session.username}`);
          
          // Connect to push updates
          sseXhrRef.current = connectToSseStream(session.token, session.deviceId);
          downloadPotholesList(session.token);
        } else {
          addLog('Authentication required.');
          const hwId = await getDeviceHardwareId();
          const devId = hwId || (await getOrCreateDeviceFingerprint());
          setDeviceId(devId);
        }
      })
      .catch(err => addLog(`DB Init Error: ${err.message}`));

    // Monitor network changes
    const unsubscribeNet = NetInfo.addEventListener(state => {
      setConnectionType(state.type || 'none');
      setIsConnected(!!state.isConnected);
      addLog(`Network changed: ${state.type} (Connected: ${state.isConnected})`);
      if (state.isConnected && authTokenRef.current) {
        triggerSync(authTokenRef.current, deviceFingerprintRef.current);
      }
    });

    Accelerometer.setUpdateInterval(20);
    Gyroscope.setUpdateInterval(20);

    // Poll server data every 2 seconds if authenticated
    const interval = setInterval(() => {
      if (authTokenRef.current) {
        downloadPotholesList(authTokenRef.current);
      }
    }, 2000);

    return () => {
      unsubscribeNet();
      clearInterval(interval);
      if (sseXhrRef.current) {
        sseXhrRef.current.abort();
      }
    };
  }, []);

  // 2. Fetch verified potholes and incidents from Flask API
  const downloadPotholesList = async (tokenVal) => {
    const activeToken = tokenVal || authTokenRef.current;
    if (!activeToken) return;
    try {
      // Download verified potholes
      const response = await fetch(`http://${SERVER_IP}:5000/api/potholes`, {
        headers: {
          'Authorization': `Bearer ${activeToken}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setPotholes(data);
      } else if (response.status === 401) {
        handleLogout();
        return;
      }

      // Download unverified raw incidents
      const responseI = await fetch(`http://${SERVER_IP}:5000/api/incidents`, {
        headers: {
          'Authorization': `Bearer ${activeToken}`
        }
      });
      if (responseI.ok) {
        const dataI = await responseI.json();
        setIncidents(dataI);
      }
    } catch (err) {
      // Quietly ignore connection errors if backend is offline
    }
  };

  // Connect to SSE stream on Flask API for push-based alerts
  const connectToSseStream = (token, myFingerprint) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `http://${SERVER_IP}:5000/api/stream?token=${encodeURIComponent(token)}`);
    let lastIndex = 0;
    let heartbeatTimer = null;

    const resetHeartbeatTimer = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        addLog('SSE connection lost (heartbeat timeout). Reconnecting...');
        try {
          xhr.abort();
        } catch (e) {}
        sseXhrRef.current = connectToSseStream(token, myFingerprint);
      }, 45000);
    };

    resetHeartbeatTimer();

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        resetHeartbeatTimer();
        const responseText = xhr.responseText;
        const newText = responseText.substring(lastIndex);
        lastIndex = responseText.length;

        const lines = newText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.substring(6));
              if (data.type === 'sync') {
                downloadPotholesList(token);
              } else if (data.type === 'pothole_alert') {
                const pothole = data.pothole;
                if (pothole.created_by !== friendlyName) {
                  addLog(`🚨 REMOTE ALERT: ${pothole.created_by} reported pothole!`);
                  Vibration.vibrate([0, 500, 100, 500]);

                  setRemoteAlert({
                    device: pothole.created_by,
                    lat: pothole.lat,
                    lng: pothole.lng,
                    timestamp: Date.now()
                  });

                  downloadPotholesList(token);
                }
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    };

    xhr.onerror = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      setTimeout(() => {
        if (authTokenRef.current === token) {
          sseXhrRef.current = connectToSseStream(token, myFingerprint);
        }
      }, 3000);
    };

    xhr.onloadend = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (xhr.status !== 200) {
        setTimeout(() => {
          if (authTokenRef.current === token) {
            sseXhrRef.current = connectToSseStream(token, myFingerprint);
          }
        }, 3000);
      }
    };

    xhr.send();
    return xhr;
  };

  // Submit Authentication form
  const handleAuthSubmit = async () => {
    if (!authUsername.trim() || !authPassword.trim()) {
      setAuthError('Username and password are required');
      return;
    }

    setAuthError('');
    setAuthLoading(true);

    try {
      let devId = deviceId;
      if (!devId) {
        const hwId = await getDeviceHardwareId();
        devId = hwId || (await getOrCreateDeviceFingerprint());
        setDeviceId(devId);
      }

      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const response = await fetch(`http://${SERVER_IP}:5000${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: authUsername.trim(),
          password: authPassword.trim(),
          device_id: devId
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      await saveAuthSession(data.token, data.username, data.friendly_name, devId);

      setAuthToken(data.token);
      setUsername(data.username);
      setFriendlyName(data.friendly_name);
      setDeviceFingerprint(devId);
      deviceFingerprintRef.current = devId;

      addLog(`Authenticated as ${data.username} (${data.friendly_name})`);

      if (sseXhrRef.current) {
        try {
          sseXhrRef.current.abort();
        } catch (e) {}
      }
      sseXhrRef.current = connectToSseStream(data.token, devId);

      downloadPotholesList(data.token);
      triggerSync(data.token, devId);

    } catch (err) {
      setAuthError(err.message);
      addLog(`Auth Error: ${err.message}`);
    } finally {
      setAuthLoading(false);
    }
  };

  // Report live client location and vehicle type coordinates
  const reportLiveLocation = async (coords) => {
    const activeToken = authTokenRef.current;
    try {
      await fetch(`http://${SERVER_IP}:5000/api/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': activeToken ? `Bearer ${activeToken}` : ''
        },
        body: JSON.stringify({
          lat: coords.latitude,
          lng: coords.longitude,
          speed: coords.speed,
          vehicle_class: vehicleClass
        })
      });
    } catch (e) {
      // Quietly ignore
    }
  };

  // 3. Continuous GPS location watch loop
  useEffect(() => {
    let locationWatcher = null;

    const startWatcher = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        addLog('Location permission denied.');
        return;
      }

      locationWatcher = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 1
        },
        (loc) => {
          const coords = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            speed: loc.coords.speed !== null && loc.coords.speed >= 0 ? loc.coords.speed : 0,
            heading: loc.coords.heading !== null && loc.coords.heading >= 0 ? loc.coords.heading : 0
          };
          // Sync dead reckoning state with GPS correction
          deadReckoningState.current = {
            lat: coords.latitude,
            lng: coords.longitude,
            speed: coords.speed,
            heading: coords.heading,
            lastUpdateTime: Date.now()
          };
          setUserLocation(coords);
          runProximityCheck(coords);
          reportLiveLocation(coords);
        }
      );
    };

    if (authToken) {
      startWatcher();
    }

    return () => {
      if (locationWatcher) {
        locationWatcher.remove();
      }
    };
  }, [authToken, potholes, vehicleClass]);

  // 4. Proximity warning check
  const runProximityCheck = (coords) => {
    if (!potholes || potholes.length === 0) return;

    let warningFound = null;
    const now = Date.now();
    const triggerDist = 10.0; // Vibrate only when very close (10m) to a pothole

    for (const pothole of potholes) {
      const distance = calculateDistance(
        coords.latitude,
        coords.longitude,
        pothole.lat,
        pothole.lng
      );

      if (distance < triggerDist) {
        warningFound = {
          id: pothole.id,
          distance: Math.round(distance),
          severity: pothole.severity,
          anomaly_type: pothole.anomaly_type || 'pothole'
        };

        const lastWarnTime = lastWarned.current[pothole.id] || 0;
        if (now - lastWarnTime > 15000) {
          lastWarned.current[pothole.id] = now;
          const labelMap = { pothole: 'Pothole', speed_bump: 'Speed Bump', rough_road: 'Rough Road', sudden_brake: 'Sudden Braking' };
          const typeLabel = labelMap[pothole.anomaly_type || 'pothole'] || 'Pothole';
          addLog(`🚨 WARNING: Approaching ${pothole.severity} severity ${typeLabel}! (${warningFound.distance}m)`);
          
          // Unique early warning vibration sequence (short-short-long pulses)
          Vibration.vibrate([0, 80, 80, 80, 80, 300]);
        }
        break;
      }
    }

    setActiveWarning(warningFound);
  };

  // 5. Accelerometer and Gyroscope variance capture loop
  useEffect(() => {
    let subAcc = null;
    let subGyro = null;

    if (isRecording && authToken) {
      addLog('Sensor recording started. Keep screen on and app active!');
      
      // Accelerometer updates with LPF gravity tracking
      subAcc = Accelerometer.addListener(data => {
        const rawX = data.x;
        const rawY = data.y;
        const rawZ = data.z;

        // Apply low pass filter (LPF) to isolate the gravity vector component (alpha=0.98 locks gravity)
        const alpha = 0.98;
        gravityRef.current = {
          x: alpha * gravityRef.current.x + (1 - alpha) * rawX,
          y: alpha * gravityRef.current.y + (1 - alpha) * rawY,
          z: alpha * gravityRef.current.z + (1 - alpha) * rawZ,
        };

        // Normalize the gravity vector
        const g = gravityRef.current;
        const gNorm = Math.sqrt(g.x ** 2 + g.y ** 2 + g.z ** 2) || 1.0;
        const uG = { x: g.x / gNorm, y: g.y / gNorm, z: g.z / gNorm };

        // Project raw acceleration onto the gravity unit vector to get true vertical acceleration
        const accVertical = rawX * uG.x + rawY * uG.y + rawZ * uG.z;

        // Dynamic vertical acceleration (G forces subtracting gravity 1.0 G)
        const mag = accVertical - 1.0;

        verticalBuffer.current.push(mag);
        xBuffer.current.push(rawX);
        yBuffer.current.push(rawY);
        zBuffer.current.push(rawZ);

        // Gyroscope tracking angular velocity magnitude (rad/s)
        const rawGyro = gyroDataRef.current;
        const wMag = Math.sqrt(rawGyro.x ** 2 + rawGyro.y ** 2 + rawGyro.z ** 2);
        gyroBuffer.current.push(wMag);

        if (verticalBuffer.current.length > WINDOW_SIZE) {
          verticalBuffer.current.shift();
          xBuffer.current.shift();
          yBuffer.current.shift();
          zBuffer.current.shift();
          gyroBuffer.current.shift();
        }

        // --- High-Rate Dead Reckoning Step ---
        const now = Date.now();
        const dr = deadReckoningState.current;
        if (dr.lat !== null && dr.lastUpdateTime > 0) {
          const dt = (now - dr.lastUpdateTime) / 1000.0;
          if (dt > 0 && dt < 2.0) {
            // Isolate dynamic horizontal acceleration (in plane perpendicular to gravity)
            const dynX = rawX - gravityRef.current.x;
            const dynY = rawY - gravityRef.current.y;
            const dynZ = rawZ - gravityRef.current.z;
            const dot = dynX * uG.x + dynY * uG.y + dynZ * uG.z;
            const hX = dynX - dot * uG.x;
            const hY = dynY - dot * uG.y;
            const hZ = dynZ - dot * uG.z;
            const accH = Math.sqrt(hX**2 + hY**2 + hZ**2) * 9.81; // convert G to m/s^2

            // Simple Kalman-like velocity update damped back to last known GPS speed
            const gpsSpeed = userLocation ? userLocation.speed : dr.speed;
            dr.speed = dr.speed * 0.96 + gpsSpeed * 0.04 + accH * dt * 0.02;

            if (dr.speed > 0.1) {
              const dist = dr.speed * dt;
              const headingRad = (dr.heading * Math.PI) / 180;
              const deltaLat = (dist * Math.cos(headingRad)) / 111111;
              const deltaLng = (dist * Math.sin(headingRad)) / (111111 * Math.cos(dr.lat * Math.PI / 180));

              dr.lat += deltaLat;
              dr.lng += deltaLng;

              // Periodic location sync/update to web UI map
              // Throttled to 10% of 50Hz = 5Hz to keep real-time UI smooth without overloading network
              if (Math.random() < 0.1) {
                const estCoords = {
                  latitude: dr.lat,
                  longitude: dr.lng,
                  speed: dr.speed,
                  heading: dr.heading,
                  isEstimated: true
                };
                setUserLocation(estCoords);
                reportLiveLocation(estCoords);
              }
            }
          }
        }
        dr.lastUpdateTime = now;

        // Update live accelerometer UI values (throttled to 5Hz to prevent stutter)
        if (Math.random() < 0.1) {
          const mean = verticalBuffer.current.reduce((a, b) => a + b, 0) / (verticalBuffer.current.length || 1);
          const variance = verticalBuffer.current.reduce((a, b) => a + (b - mean) ** 2, 0) / (verticalBuffer.current.length || 1);
          setAccelerometerData({
            x: rawX,
            y: rawY,
            z: rawZ,
            variance: variance
          });
        }

        if (verticalBuffer.current.length === WINDOW_SIZE) {
          checkAnomaly();
        }
      });

      // Gyroscope listener
      subGyro = Gyroscope.addListener(data => {
        gyroDataRef.current = data;
      });
    } else if (authToken) {
      addLog('Sensor recording stopped.');
      setAccelerometerData({ x: 0, y: 0, z: 0, variance: 0 });
    }

    return () => {
      if (subAcc) subAcc.remove();
      if (subGyro) subGyro.remove();
    };
  }, [isRecording, authToken]);

  const checkAnomaly = async () => {
    const samples = verticalBuffer.current;
    if (samples.length < WINDOW_SIZE) return;
    
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;

    if (variance > VERTICAL_THRESHOLD) {
      const now = Date.now();
      if (now - lastDetection.current < 2000) return;
      lastDetection.current = now;

      const zSamples = zBuffer.current;
      const zMean = zSamples.reduce((a, b) => a + b, 0) / zSamples.length;
      const zVariance = zSamples.reduce((a, b) => a + (b - zMean) ** 2, 0) / zSamples.length;

      const speed = userLocation ? userLocation.speed : 9.5;

      addLog(`⚠️ Shock! Speed: ${speed.toFixed(1)} m/s, SVM Var: ${variance.toFixed(5)}, Z Var: ${zVariance.toFixed(5)} Gs²`);
      // No vibration on self-detected shocks — only proximity warnings vibrate

      // Compute GPS latency offset distance correction
      // Shifts coordinates back along the heading vector
      const lat = userLocation ? userLocation.latitude : 27.7172 + (Math.random() - 0.5) * 0.0002;
      const lng = userLocation ? userLocation.longitude : 85.3240 + (Math.random() - 0.5) * 0.0002;

      const latencySeconds = 0.8; // Estimated GPS latency
      const headingRad = userLocation && userLocation.heading ? (userLocation.heading * Math.PI) / 180 : 0;
      let correctedLat = lat;
      let correctedLng = lng;
      
      if (userLocation && userLocation.speed > 1.0 && userLocation.heading !== undefined) {
        const offsetMeters = userLocation.speed * latencySeconds;
        const deltaLat = (offsetMeters * Math.cos(headingRad)) / 111111;
        const deltaLng = (offsetMeters * Math.sin(headingRad)) / (111111 * Math.cos(lat * Math.PI / 180));
        
        correctedLat = lat - deltaLat;
        correctedLng = lng - deltaLng;
        addLog(`Pothole distance: shifted back ${offsetMeters.toFixed(1)}m`);
      }

      const telemetryData = {
        svm: samples.map(val => val * 9.81),
        x: xBuffer.current.map(val => val * 9.81),
        y: yBuffer.current.map(val => val * 9.81),
        z: zSamples.map(val => val * 9.81),
        gyro: [...gyroBuffer.current], // Include angular velocity magnitudes!
        z_variance: zVariance * 96.2,
        speed: speed
      };

      // Calculate suspension degradation locally
      const isOffroad = vehicleClass.toLowerCase().includes('off-road') || vehicleClass.toLowerCase().includes('offroad');
      const degradationRate = isOffroad ? 0.005 : 0.025;
      const degradation = (zVariance * 96.2) * degradationRate;
      setSuspensionHealth(prev => Math.max(0.0, prev - degradation));

      try {
        await insertTelemetry(
          correctedLat,
          correctedLng,
          speed,
          variance * 96.2, 
          telemetryData
        );
        addLog('Saved event locally to SQLite.');
        triggerSync(authTokenRef.current, deviceFingerprintRef.current);
      } catch (err) {
        addLog(`SQLite Save Error: ${err.message}`);
      }

      verticalBuffer.current = [];
      xBuffer.current = [];
      yBuffer.current = [];
      zBuffer.current = [];
      gyroBuffer.current = [];
    }
  };

  // 6. Sync Engine with backend verification headers
  const triggerSync = async (tokenVal, fingerprintVal) => {
    const activeToken = tokenVal || authTokenRef.current;
    const activeFingerprint = fingerprintVal || deviceFingerprintRef.current;
    if (!activeToken || !activeFingerprint) {
      addLog('Sync postponed: Not authenticated.');
      return;
    }

    addLog('Checking network status...');
    const netState = await NetInfo.fetch();
    
    if (!netState.isConnected) {
      addLog(`Sync ignored: No internet connection.`);
      return;
    }

    addLog('Sync starting...');
    try {
      const unsynced = await getUnsyncedReports();
      if (unsynced.length === 0) {
        addLog('No unsynced reports in database.');
        return;
      }

      addLog(`Uploading batch of ${unsynced.length} records...`);

      const payload = unsynced.map(r => ({
        lat: r.lat,
        lng: r.lng,
        speed: r.speedMs,
        vertical_power: r.verticalPower,
        samples: r.rawSamplesJson,
        timestamp: r.timestamp,
        device_id: activeFingerprint,
        vehicle_class: vehicleClass // Send vehicle class for health degradation calculations
      }));

      const response = await fetch(`http://${SERVER_IP}:5000/api/sync`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeToken}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const ids = unsynced.map(r => r.id);
        await markReportsAsSynced(ids);
        await pruneSyncedReports();
        addLog('Sync success! SQLite reports synced.');
        Vibration.vibrate([0, 100, 50, 100]);
        downloadPotholesList(activeToken);
      } else if (response.status === 401) {
        addLog('Sync failed: Unauthorized.');
        handleLogout();
      } else {
        addLog(`Sync server error: Status ${response.status}`);
      }
    } catch (err) {
      addLog(`Sync error: ${err.message}`);
    }
  };

  // Auto-dismiss remote alerts after 5 seconds
  useEffect(() => {
    if (remoteAlert) {
      const timer = setTimeout(() => {
        setRemoteAlert(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [remoteAlert]);

  // Default initial region centering
  const initialRegion = {
    latitude: userLocation ? userLocation.latitude : 27.7172,
    longitude: userLocation ? userLocation.longitude : 85.3240,
    latitudeDelta: 0.01,
    longitudeDelta: 0.01,
  };

  // Glassmorphic Authentication View Card overlay if not authenticated
  if (!authToken) {
    return (
      <View style={styles.container}>
        <MapView
          style={styles.map}
          initialRegion={initialRegion}
          showsUserLocation={true}
        >
          <UrlTile
            urlTemplate="https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
            maximumZ={19}
            flipY={false}
          />
        </MapView>
        <View style={styles.overlayDim} />
        
        <View style={styles.authContainer}>
          <Text style={styles.authTitle}>Khalto</Text>
          <Text style={styles.authSubtitle}>Pothole Detection Client</Text>
          
          <View style={styles.authTabs}>
            <TouchableOpacity 
              style={[styles.authTabBtn, authMode === 'login' && styles.authTabBtnActive]}
              onPress={() => { setAuthMode('login'); setAuthError(''); }}
            >
              <Text style={[styles.authTabBtnText, authMode === 'login' && styles.authTabBtnTextActive]}>Login</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.authTabBtn, authMode === 'register' && styles.authTabBtnActive]}
              onPress={() => { setAuthMode('register'); setAuthError(''); }}
            >
              <Text style={[styles.authTabBtnText, authMode === 'register' && styles.authTabBtnTextActive]}>Register</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.authForm}>
            <Text style={styles.inputLabel}>Username</Text>
            <TextInput
              style={styles.input}
              value={authUsername}
              onChangeText={setAuthUsername}
              placeholder="Enter username"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
            />

            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.input}
              value={authPassword}
              onChangeText={setAuthPassword}
              placeholder="Enter password"
              placeholderTextColor="#64748b"
              secureTextEntry
              autoCapitalize="none"
            />

            {authError ? (
              <Text style={styles.authErrorText}>{authError}</Text>
            ) : null}

            <TouchableOpacity 
              style={styles.authSubmitBtn} 
              onPress={handleAuthSubmit}
              disabled={authLoading}
            >
              <Text style={styles.authSubmitBtnText}>
                {authLoading ? 'Please wait...' : authMode === 'login' ? 'Login' : 'Register & Connect'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* 1. Full-Screen Map View rendering OpenStreetMap */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={initialRegion}
        showsUserLocation={true}
        followsUserLocation={true}
      >
        <UrlTile
          urlTemplate="https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
          maximumZ={19}
          flipY={false}
        />
        {/* Render verified potholes */}
        {potholes.map((p) => {
          const ANOMALY_COLORS = {
            pothole: '#ef4444',
            speed_bump: '#d97706',
            rough_road: '#854d0e',
            sudden_brake: '#7c3aed'
          };
          const ANOMALY_FILLS = {
            pothole: 'rgba(239, 68, 68, 0.35)',
            speed_bump: 'rgba(217, 119, 6, 0.35)',
            rough_road: 'rgba(133, 77, 14, 0.35)',
            sudden_brake: 'rgba(124, 58, 237, 0.35)'
          };
          const pType = p.anomaly_type || 'pothole';
          const strokeColor = ANOMALY_COLORS[pType] || '#ef4444';
          const fillColor = ANOMALY_FILLS[pType] || 'rgba(239, 68, 68, 0.4)';
          return (
            <Circle
              key={`pot-${p.id}`}
              center={{ latitude: p.lat, longitude: p.lng }}
              radius={p.severity === 'high' ? 8 : p.severity === 'medium' ? 6 : 4}
              strokeWidth={2}
              strokeColor={strokeColor}
              fillColor={fillColor}
            />
          );
        })}

        {/* Render unverified raw incident shocks */}
        {incidents.map((inc) => {
          const ANOMALY_COLORS = {
            pothole: '#ef4444',
            speed_bump: '#d97706',
            rough_road: '#854d0e',
            sudden_brake: '#7c3aed'
          };
          const ANOMALY_FILLS = {
            pothole: 'rgba(239, 68, 68, 0.2)',
            speed_bump: 'rgba(217, 119, 6, 0.2)',
            rough_road: 'rgba(133, 77, 14, 0.2)',
            sudden_brake: 'rgba(124, 58, 237, 0.2)'
          };
          const incType = inc.anomaly_type || 'pothole';
          const strokeColor = ANOMALY_COLORS[incType] || '#f97316';
          const fillColor = ANOMALY_FILLS[incType] || 'rgba(249, 115, 22, 0.2)';
          return (
            <Circle
              key={`inc-${inc.id}`}
              center={{ latitude: inc.lat, longitude: inc.lng }}
              radius={5}
              strokeWidth={1.5}
              strokeColor={strokeColor}
              fillColor={fillColor}
            />
          );
        })}
      </MapView>

      {/* Floating Proximity Warning Banner */}
      {activeWarning && (
        <View style={[styles.warningBanner, activeWarning.severity === 'high' ? styles.warnHigh : styles.warnMedium]}>
          <Text style={styles.warningText}>
            ⚠️ WARNING: {activeWarning.severity.toUpperCase()} Severity {(activeWarning.anomaly_type || 'pothole').replace('_', ' ').toUpperCase()} {activeWarning.distance}m Ahead!
          </Text>
        </View>
      )}

      {/* Floating Remote Alert Banner */}
      {remoteAlert && (
        <View style={styles.remoteAlertBanner}>
          <Text style={styles.remoteAlertTitle}>🚨 REAL-TIME REMOTE DETECTED! 🚨</Text>
          <Text style={styles.remoteAlertText}>
            {remoteAlert.device} reported a pothole nearby!
          </Text>
          <Text style={styles.remoteAlertCoords}>
            Location: {remoteAlert.lat.toFixed(5)}, {remoteAlert.lng.toFixed(5)}
          </Text>
        </View>
      )}

      {/* 2. Floating Control Overlay Panels */}
      <View style={styles.floatingControls}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Khalto Tracker</Text>
            <Text style={{ color: '#3b82f6', fontSize: 11, fontWeight: '800', marginTop: 1 }}>
              User: {username} ({friendlyName})
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <TouchableOpacity style={styles.syncBtnSmall} onPress={() => triggerSync()}>
              <Text style={styles.syncBtnTextSmall}>Sync</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.syncBtnSmall, { backgroundColor: '#374151' }]} onPress={handleLogout}>
              <Text style={styles.syncBtnTextSmall}>Logout</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Vehicle Class Selector */}
        <View style={styles.pickerRow}>
          <Text style={styles.pickerLabel}>Vehicle Class:</Text>
          <View style={styles.pickerButtons}>
            {['Standard Bike', 'Off-Road Bike', 'Standard Car', 'Off-Road SUV'].map((vClass) => (
              <TouchableOpacity
                key={vClass}
                style={[styles.pickerBtn, vehicleClass === vClass && styles.pickerBtnActive]}
                onPress={() => setVehicleClass(vClass)}
              >
                <Text style={[styles.pickerBtnText, vehicleClass === vClass && styles.pickerBtnTextActive]}>
                  {vClass.split(' ')[1]} ({vClass.startsWith('Off-Road') ? 'Off' : 'Std'})
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.switchesRow}>
          <View style={styles.switchCol}>
            <Text style={styles.switchLabel}>Record Telemetry</Text>
            <Switch 
              value={isRecording} 
              onValueChange={setIsRecording}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
              thumbColor={isRecording ? '#fff' : '#9ca3af'}
            />
          </View>
        </View>

        {/* Real-time accelerometer readings display */}
        {isRecording && (
          <View style={styles.telemetryPanel}>
            <Text style={styles.telemetryTitle}>Orientation Compensated Acceleration (Gs):</Text>
            <View style={styles.telemetryRow}>
              <Text style={styles.telemetryText}>X: {accelerometerData.x.toFixed(2)}</Text>
               <Text style={styles.telemetryText}>Y: {accelerometerData.y.toFixed(2)}</Text>
              <Text style={styles.telemetryText}>Z: {accelerometerData.z.toFixed(2)}</Text>
            </View>
            <Text style={styles.telemetryText}>
              SVM Var: <Text style={{ color: accelerometerData.variance > VERTICAL_THRESHOLD ? '#ef4444' : '#10b981', fontWeight: 'bold' }}>{accelerometerData.variance.toFixed(5)} Gs²</Text>
            </Text>
            <Text style={[styles.telemetryText, { marginTop: 4 }]}>
              Suspension Health: <Text style={{ color: suspensionHealth > 75 ? '#10b981' : suspensionHealth > 40 ? '#f59e0b' : '#ef4444', fontWeight: 'bold' }}>{suspensionHealth.toFixed(1)}%</Text>
            </Text>
          </View>
        )}

        <Text style={styles.logHeader}>Logs Console:</Text>
        <ScrollView style={styles.logs}>
          {logs.map((log, index) => (
            <Text key={index} style={styles.logText}>{log}</Text>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(248, 250, 252, 0.6)'
  },
  authContainer: {
    position: 'absolute',
    width: '90%',
    alignSelf: 'center',
    top: '15%',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 10,
    zIndex: 1000
  },
  authTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#0f172a',
    textAlign: 'center',
    marginBottom: 2
  },
  authSubtitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: 24
  },
  authTabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.04)',
    borderRadius: 10,
    padding: 3,
    marginBottom: 20
  },
  authTabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center'
  },
  authTabBtnActive: {
    backgroundColor: '#3b82f6'
  },
  authTabBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569'
  },
  authTabBtnTextActive: {
    color: '#fff'
  },
  authForm: {
    gap: 12
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#475569',
    marginBottom: 4
  },
  input: {
    backgroundColor: 'rgba(15, 23, 42, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    borderRadius: 10,
    color: '#0f172a',
    paddingVertical: 10,
    paddingHorizontal: 16,
    fontSize: 14,
    marginBottom: 12
  },
  authErrorText: {
    color: '#ef4444',
    fontSize: 11,
    textAlign: 'center',
    marginVertical: 4
  },
  authSubmitBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12
  },
  authSubmitBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700'
  },
  warningBanner: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
    zIndex: 100
  },
  warnHigh: {
    backgroundColor: '#ef4444',
  },
  warnMedium: {
    backgroundColor: '#f97316',
  },
  warningText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
    textAlign: 'center'
  },
  floatingControls: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderColor: 'rgba(15, 23, 42, 0.08)',
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 8,
    zIndex: 99
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  title: {
    fontSize: 18,
    color: '#0f172a',
    fontWeight: '800',
    letterSpacing: -0.5
  },
  syncBtnSmall: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12
  },
  syncBtnTextSmall: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700'
  },
  pickerRow: {
    flexDirection: 'column',
    marginBottom: 10,
    gap: 4
  },
  pickerLabel: {
    color: '#475569',
    fontSize: 10,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  pickerButtons: {
    flexDirection: 'row',
    gap: 4,
    flexWrap: 'wrap'
  },
  pickerBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.02)',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: 'center'
  },
  pickerBtnActive: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6'
  },
  pickerBtnText: {
    color: '#475569',
    fontSize: 10,
    fontWeight: '600'
  },
  pickerBtnTextActive: {
    color: '#fff'
  },
  switchesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 12
  },
  switchCol: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.02)',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12
  },
  switchLabel: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '600'
  },
  telemetryPanel: {
    backgroundColor: 'rgba(15, 23, 42, 0.02)',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.06)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10
  },
  telemetryTitle: {
    color: '#475569',
    fontSize: 9,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6
  },
  telemetryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6
  },
  telemetryText: {
    color: '#0f172a',
    fontFamily: 'Courier',
    fontSize: 11
  },
  logHeader: {
    color: '#475569',
    fontSize: 10,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4
  },
  logs: {
    height: 80,
    backgroundColor: 'rgba(15, 23, 42, 0.04)',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)'
  },
  logText: {
    fontFamily: 'Courier',
    fontSize: 10,
    color: '#16a34a',
    marginBottom: 2
  },
  remoteAlertBanner: {
    position: 'absolute',
    top: 120,
    left: 16,
    right: 16,
    backgroundColor: '#dc2626',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
    zIndex: 100
  },
  remoteAlertTitle: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
    marginBottom: 4
  },
  remoteAlertText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
    textAlign: 'center'
  },
  remoteAlertCoords: {
    color: '#fca5a5',
    fontWeight: '500',
    fontSize: 10,
    marginTop: 2
  }
});
