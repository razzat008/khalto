import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Switch, ScrollView, TouchableOpacity, Vibration, Platform, TextInput, Modal, ActivityIndicator } from 'react-native';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import MapView, { Circle, UrlTile, Polyline, Marker, Callout } from 'react-native-maps';
import * as Application from 'expo-application';
import { io } from 'socket.io-client';
import { useAudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import {
  initDatabase,
  insertTelemetry,
  getUnsyncedReports,
  markReportsAsSynced,
  pruneSyncedReports,
  getOrCreateDeviceFingerprint,
  saveAuthSession,
  clearAuthSession
} from './src/data/db';
import { computeSafeRoutes, haversineMeters } from './src/utils/safeRouting';
import * as BleManager from './src/utils/BleManager';
import SimulationScreen from './src/screens/SimulationScreen';

const WINDOW_SIZE = 50; // 1 second of data at 50Hz
const VERTICAL_THRESHOLD = 1.0; // High tolerance — only real potholes and hard bumps trigger detection
const SERVER_IP = '192.168.101.254'; // Flask backend IP address

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('map'); // 'map' | 'simulation'

  // Audio Player
  const audioPlayer = useAudioPlayer('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');

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
  const [isDevMode, setIsDevMode] = useState(false);
  const [gamificationPoints, setGamificationPoints] = useState(120);
  
  // Real-Time Acceleration & Gravity telemetry displayed on screen
  const [accelerometerData, setAccelerometerData] = useState({ x: 0, y: 0, z: 0, variance: 0 });

  // Location States
  const [userLocation, setUserLocation] = useState(null);
  const [potholes, setPotholes] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [activeWarning, setActiveWarning] = useState(null);
  
  // Routing states
  const [destination, setDestination] = useState(null);
  const [safestRouteCoords, setSafestRouteCoords] = useState([]);
  const [fastestRouteCoords, setFastestRouteCoords] = useState([]);
  const [routeStats, setRouteStats] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchSuggestions, setSearchSuggestions] = useState([]);
  
  // Rendering / UI States for Routing
  const [isFollowingUser, setIsFollowingUser] = useState(true);
  const [isSameRoute, setIsSameRoute] = useState(false);
  
  // Manual Reporting & CV Scan states
  const [isReportingMode, setIsReportingMode] = useState(false); // true = next long-press drops a report pin
  const [reportPin, setReportPin] = useState(null);              // {latitude, longitude}
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [reportSeverity, setReportSeverity] = useState('medium');
  const [reportExperienced, setReportExperienced] = useState(null); // true | false | null
  const [isScanningSatellite, setIsScanningSatellite] = useState(false);

  // BLE Offline P2P states
  const [bleOfflineMode, setBleOfflineMode] = useState(false);
  const [isBleScanning, setIsBleScanning] = useState(false);
  const [bleTestStatus, setBleTestStatus] = useState('idle'); // 'idle'|'scanning'|'found'|'failed'

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
        sseXhrRef.current.disconnect();
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

  const handleVerifyPothole = async (potholeId) => {
    try {
      const response = await fetch(`http://${SERVER_IP}:5000/api/potholes/${potholeId}/verify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authTokenRef.current}`
        }
      });
      if (response.ok) {
        addLog(`Pothole ${potholeId} manually verified!`);
        downloadPotholesList();
      }
    } catch (e) {
      addLog(`Failed to verify pothole: ${e.message}`);
    }
  };

  // ── BLE Offline Mode lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    if (bleOfflineMode) {
      setIsBleScanning(true);
      BleManager.startScanning(
        (pothole) => {
          // Inject BLE-received pothole into local list
          setPotholes(prev => {
            const exists = prev.some(p => Math.abs(p.lat - pothole.lat) < 0.0001 && Math.abs(p.lng - pothole.lng) < 0.0001);
            if (exists) return prev;
            addLog(`📡 BLE: New pothole injected from nearby device!`);
            Vibration.vibrate([0, 300, 100, 300]);
            return [...prev, { id: `ble_${Date.now()}`, lat: pothole.lat, lng: pothole.lng, severity: pothole.severity, status: 'Unverified', report_count: 1, anomaly_type: 'pothole' }];
          });
        },
        addLog
      ).then(started => {
        if (!started) setIsBleScanning(false);
      });
    } else {
      BleManager.stopScanning(addLog);
      setIsBleScanning(false);
    }
    return () => {
      BleManager.stopScanning();
    };
  }, [bleOfflineMode]);

  // ── Report Pothole: Pin-drop flow ─────────────────────────────────────────
  const enterReportMode = () => {
    setIsReportingMode(true);
    setReportPin(null);
    setReportExperienced(null);
    setReportSeverity('medium');
    addLog('📍 Report mode: long-press the map where the pothole is.');
  };

  const handleMapLongPress = (e) => {
    const coord = e.nativeEvent.coordinate;
    if (isReportingMode) {
      // Drop a purple report pin
      setReportPin(coord);
      setReportModalVisible(true);
      addLog(`📍 Pin dropped at ${coord.latitude.toFixed(5)}, ${coord.longitude.toFixed(5)}`);
    } else {
      // Normal behaviour: route planning
      fetchSafeRoute(coord);
    }
  };

  const cancelReport = () => {
    setReportModalVisible(false);
    setReportPin(null);
    setIsReportingMode(false);
  };

  const submitManualReport = async () => {
    addLog(`[SUBMIT] pin=${JSON.stringify(reportPin)} sev=${reportSeverity}`);

    if (!reportPin) {
      addLog('❌ No pin dropped — long-press the map first.');
      return;
    }

    const lat = reportPin.latitude;
    const lng = reportPin.longitude;

    // ── STEP 1: Add to local map instantly (works fully offline) ──
    const localId = `manual_${Date.now()}`;
    setPotholes(prev => [
      ...prev,
      { id: localId, lat, lng, severity: reportSeverity, status: 'Unverified', report_count: 1, anomaly_type: 'pothole' }
    ]);
    addLog(`📍 Pin added to map at ${lat.toFixed(5)}, ${lng.toFixed(5)}`);

    // ── STEP 2: Close modal right away, don't make user wait ──
    setGamificationPoints(prev => prev + 10);
    addLog(`🏆 +10 Points! You now have ${gamificationPoints + 10} points.`);

    setReportModalVisible(false);
    setIsReportingMode(false);
    setReportPin(null);

    // ── STEP 3: Try syncing to backend in the background ──
    const token = authTokenRef.current;
    if (!token) {
      addLog('⚠️ Not authenticated — saved locally only.');
      return;
    }
    try {
      addLog('[SUBMIT] Syncing to server...');
      const response = await fetch(`http://${SERVER_IP}:5000/api/potholes/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ lat, lng, severity: reportSeverity, experienced: reportExperienced })
      });
      addLog(`[SUBMIT] Server: ${response.status}`);
      if (response.ok) {
        addLog('✅ Synced to server!');
        downloadPotholesList(token);
      } else {
        const body = await response.text().catch(() => '');
        addLog(`⚠️ Sync failed (${response.status}): ${body.slice(0, 60)}`);
      }
    } catch (e) {
      addLog(`⚠️ Server unreachable: ${e.message} — kept locally.`);
    }
  };

  const triggerSatelliteScan = async () => {
    if (!mapRef.current) {
      addLog('Map not ready.');
      return;
    }
    setIsScanningSatellite(true);
    addLog('Initiating Satellite Vision Scan...');
    try {
      let boundaries;
      try {
        boundaries = await mapRef.current.getMapBoundaries();
      } catch {
        const cLat = deadReckoningState.current?.lat || 27.7172;
        const cLng = deadReckoningState.current?.lng || 85.3240;
        boundaries = {
          southWest: { latitude: cLat - 0.01, longitude: cLng - 0.01 },
          northEast: { latitude: cLat + 0.01, longitude: cLng + 0.01 }
        };
        addLog('Using GPS-based bounding box for scan.');
      }
      const response = await fetch(`http://${SERVER_IP}:5000/api/satellite-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authTokenRef.current}`
        },
        body: JSON.stringify({
          minLat: boundaries.southWest.latitude,
          maxLat: boundaries.northEast.latitude,
          minLng: boundaries.southWest.longitude,
          maxLng: boundaries.northEast.longitude
        })
      });
      if (response.ok) {
        const data = await response.json();
        addLog(data.message || 'Scan complete.');
        downloadPotholesList(authTokenRef.current);
      } else {
        const errText = await response.text().catch(() => 'unknown error');
        addLog(`Scan failed (${response.status}): ${errText.slice(0, 80)}`);
      }
    } catch (e) {
      addLog(`Scan error: ${e.message}`);
    } finally {
      setIsScanningSatellite(false);
    }
  };

  const testBleNotification = async () => {
    setBleTestStatus('scanning');
    addLog('📡 BLE Test: Broadcasting pothole alert...');
    const lat = deadReckoningState.current?.lat || 27.7172;
    const lng = deadReckoningState.current?.lng || 85.3240;
    try {
      // Use real BLE advertising via BleManager (degrades gracefully in Expo Go)
      await BleManager.broadcastAlert(lat, lng, 'high', addLog);
      setBleTestStatus('found');
      Vibration.vibrate([0, 200, 100, 200]);
      setTimeout(() => setBleTestStatus('idle'), 3000);
    } catch (e) {
      // Fallback: if BLE fails, push via backend SSE so WiFi users still see it
      addLog('BLE native unavailable. Falling back to SSE push...');
      try {
        const r = await fetch(`http://${SERVER_IP}:5000/api/demo/pothole`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authTokenRef.current}` },
          body: JSON.stringify({ lat, lng, severity: 'high', anomaly_type: 'pothole' })
        });
        if (r.ok) {
          setBleTestStatus('found');
          addLog('✅ Fallback SSE alert sent to all online devices!');
        } else {
          setBleTestStatus('failed');
          addLog('❌ Both BLE and SSE failed — device is fully offline.');
        }
      } catch {
        setBleTestStatus('failed');
        addLog('❌ Fully offline — no alert sent.');
      }
      setTimeout(() => setBleTestStatus('idle'), 3000);
    }
  };

  const fetchSafeRoute = async (destCoords) => {
    let startLat = deadReckoningState.current?.lat;
    let startLng = deadReckoningState.current?.lng;

    if (!startLat || !startLng) {
      addLog("GPS not fixed. Using default Kathmandu center for testing.");
      // Fallback to default initial region so simulator testing works immediately
      startLat = 27.7172;
      startLng = 85.3240;
    }

    setDestination(destCoords);
    addLog(`Calculating safe route to destination...`);
    try {
      const destLng = destCoords.longitude;
      const destLat = destCoords.latitude;
      
      const { fastestRoute, safestRoute, isSameRoute: sameRouteStatus } = await computeSafeRoutes(
        startLat, startLng, destLat, destLng, potholes
      );

      // ── DIAGNOSTIC: confirm OSRM is returning alternatives ──
      addLog(`OSRM returned routes. Same route: ${sameRouteStatus}`);
      addLog(`Fastest score: ${fastestRoute.dangerScore}, Safest score: ${safestRoute.dangerScore}`);

      setIsSameRoute(sameRouteStatus);

      // Convert from internal [lon, lat] to renderable {latitude, longitude}
      const fastestCoords = fastestRoute.rawCoordinates.map(c => ({ latitude: c[1], longitude: c[0] }));
      const safestCoords = safestRoute.rawCoordinates.map(c => ({ latitude: c[1], longitude: c[0] }));
      
      setFastestRouteCoords(fastestCoords);
      setSafestRouteCoords(safestCoords);

      // ── FIX: stop following user, then zoom to show the full route ──
      setIsFollowingUser(false);

      // Wait one frame for state to flush before fitting
      setTimeout(() => {
        if (mapRef.current && safestCoords.length > 0) {
          mapRef.current.fitToCoordinates(
            [...safestCoords, ...fastestCoords],
            {
              edgePadding: { top: 80, right: 40, bottom: 200, left: 40 },
              animated: true,
            }
          );
        }
      }, 100);
      
      setRouteStats({
        safest: {
          distance: (safestRoute.distanceMeters / 1000).toFixed(1),
          duration: Math.round(safestRoute.durationSeconds / 60),
          dangerScore: safestRoute.dangerScore
        },
        fastest: {
          distance: (fastestRoute.distanceMeters / 1000).toFixed(1),
          duration: Math.round(fastestRoute.durationSeconds / 60),
          dangerScore: fastestRoute.dangerScore
        }
      });
      addLog(`Routes Found. Safest: ${safestRoute.dangerScore} potholes, Fastest: ${fastestRoute.dangerScore} potholes.`);
    } catch (e) {
      addLog(`Routing failed: ${e.message}`);
    }
  };

  // ── AUTOCOMPLETE & SEARCH ───────────────────────────────────────────────
  const fetchSuggestions = async (text) => {
    setSearchQuery(text);
    if (!text.trim()) {
      setSearchSuggestions([]);
      return;
    }
    try {
      // Use Photon API for fast, typo-tolerant OpenStreetMap autocomplete
      // Biased roughly towards Kathmandu area (lat=27.7, lon=85.3)
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&lat=27.7&lon=85.3&zoom=12&limit=5`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.features) {
        setSearchSuggestions(data.features);
      }
    } catch (e) {
      console.log('Autocomplete error:', e);
    }
  };

  const selectSuggestion = (feature) => {
    const coords = feature.geometry.coordinates; // [lon, lat]
    const destCoords = { latitude: coords[1], longitude: coords[0] };
    const name = feature.properties.name || 'Destination';
    
    setSearchQuery(name);
    setSearchSuggestions([]);
    
    // Pan map
    if (mapRef.current) {
      mapRef.current.animateToRegion({
        ...destCoords,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05
      }, 1000);
    }
    fetchSafeRoute(destCoords);
  };

  const handleSearchDestination = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    addLog(`Searching for "${searchQuery}"...`);
    setSearchSuggestions([]);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`, {
        headers: {
          'User-Agent': 'RoadSenseMobileClient/1.0'
        }
      });
      const data = await res.json();
      if (data && data.length > 0) {
        const destCoords = {
          latitude: parseFloat(data[0].lat),
          longitude: parseFloat(data[0].lon)
        };
        // Pan map
        if (mapRef.current) {
          mapRef.current.animateToRegion({
            ...destCoords,
            latitudeDelta: 0.05,
            longitudeDelta: 0.05
          }, 1000);
        }
        fetchSafeRoute(destCoords);
      } else {
        addLog(`No results found for "${searchQuery}"`);
      }
    } catch (e) {
      addLog(`Search error: ${e.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  // Connect to Socket.IO stream on Flask API for push-based alerts
  const connectToSseStream = (token, myFingerprint) => {
    const socket = io(`http://${SERVER_IP}:5000`, {
      transports: ['websocket'],
      auth: { token }
    });

    socket.on('connect', () => {
      addLog('Socket connected.');
    });

    socket.on('sync_event', () => {
      downloadPotholesList(token);
    });

    socket.on('pothole_alert', async (data) => {
      // For simulated alerts or real remote alerts
      if (data.created_by_device !== myFingerprint) {
        addLog(`🚨 REMOTE ALERT: ${data.created_by} hit pothole! (${data.severity})`);
        Vibration.vibrate([0, 500, 100, 500]);
        Speech.speak("ALERT! POTHOLE AHEAD!", { pitch: 1, rate: 0.9, language: 'en' });
        
        try {
          if (audioPlayer) {
            audioPlayer.play();
          }
        } catch (err) {
          // Ignore sound errors
        }

        setRemoteAlert({
          device: data.created_by,
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now()
        });
        downloadPotholesList(token);
      }
    });

    socket.on('disconnect', () => {
      addLog('Socket disconnected.');
    });

    return socket;
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
      const distance = haversineMeters(
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
          if (pothole.anomaly_type === 'pothole' || !pothole.anomaly_type) {
             Speech.speak("ALERT! POTHOLE AHEAD!", { pitch: 1, rate: 0.9, language: 'en' });
          }
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

  if (currentScreen === 'simulation') {
    return <SimulationScreen onExit={() => setCurrentScreen('map')} />;
  }

  return (
    <View style={styles.container}>
      {/* 1. Full-Screen Map View rendering OpenStreetMap */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={initialRegion}
        showsUserLocation={true}
        followsUserLocation={isFollowingUser}
        onLongPress={handleMapLongPress}
        onTouchStart={() => setIsFollowingUser(false)}
      >
        <UrlTile
          urlTemplate="https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
          maximumZ={19}
          flipY={false}
        />
        
        {/* Fastest/Shortest Route — bright red and wide to be visible underneath the safest route */}
        {fastestRouteCoords.length > 0 && (
          <React.Fragment>
            <Polyline
              coordinates={fastestRouteCoords}
              strokeColor="#ef4444"
              strokeWidth={10}
            />
            <Polyline
              coordinates={fastestRouteCoords}
              strokeColor="#dc2626"
              strokeWidth={5}
              lineDashPattern={[8, 6]}
            />
          </React.Fragment>
        )}
        
        {/* Safest Route — solid blue on top */}
        {safestRouteCoords.length > 0 && (
           <Polyline coordinates={safestRouteCoords} strokeColor="#3b82f6" strokeWidth={6} />
        )}
        
        {destination && (
           <Marker coordinate={destination} pinColor="blue" title="Destination" />
        )}

        {/* Report pin — purple/magenta, shows where user wants to report a pothole */}
        {reportPin && (
          <Marker
            coordinate={reportPin}
            pinColor="#a855f7"
            title="Report Here"
            description={`${reportPin.latitude.toFixed(5)}, ${reportPin.longitude.toFixed(5)}`}
          />
        )}

        {/* Render verified/unverified potholes */}
        {potholes.map((p) => {
          if (p.status === 'Patched') return null;
          
          const isUnverified = p.status === 'Unverified';
          const pRadius = p.severity === 'high' ? 8 : p.severity === 'medium' ? 6 : 4;
          return (
            <React.Fragment key={`pot-${p.id}`}>
              <Circle
                center={{ latitude: p.lat, longitude: p.lng }}
                radius={pRadius}
                strokeWidth={2}
                strokeColor={isUnverified ? 'orange' : '#ef4444'}
                fillColor={isUnverified ? 'rgba(255, 165, 0, 0.3)' : 'rgba(239, 68, 68, 0.35)'}
              />
              <Marker
                coordinate={{ latitude: p.lat, longitude: p.lng }}
                pinColor={isUnverified ? 'orange' : 'red'}
              >
                 <Callout onPress={() => {
                    if (isUnverified) handleVerifyPothole(p.id);
                 }}>
                    <View style={{ padding: 5, alignItems: 'center' }}>
                       <Text style={{ fontWeight: 'bold' }}>{isUnverified ? 'Unverified Pothole' : 'Active Pothole'}</Text>
                       <Text style={{ fontSize: 10 }}>Reports: {p.report_count}</Text>
                       {isUnverified && (
                          <Text style={{ color: '#3b82f6', marginTop: 4, fontWeight: 'bold' }}>Tap to Verify</Text>
                       )}
                    </View>
                 </Callout>
              </Marker>
            </React.Fragment>
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

      {/* Google Maps Style Floating Search Bar */}
    <View style={styles.searchContainer}>
        <TouchableOpacity style={styles.searchIconWrapper} onPress={handleSearchDestination} disabled={isSearching}>
          {isSearching ? (
             <ActivityIndicator size="small" color="#4b5563" />
          ) : (
             <Text style={{ fontSize: 18 }}>🔍</Text>
          )}
        </TouchableOpacity>
        <TextInput
          style={styles.searchInput}
          placeholder="Search here"
          placeholderTextColor="#4b5563"
          value={searchQuery}
          onChangeText={fetchSuggestions}
          onSubmitEditing={handleSearchDestination}
          returnKeyType="search"
        />
      </View>

      {/* Autocomplete Dropdown */}
      {searchSuggestions.length > 0 && (
        <View style={styles.autocompleteDropdown}>
          {searchSuggestions.map((feature, idx) => {
            const props = feature.properties;
            const subtitle = [props.city, props.state, props.country].filter(Boolean).join(', ');
            return (
              <TouchableOpacity key={idx} style={styles.autocompleteItem} onPress={() => selectSuggestion(feature)}>
                <Text style={styles.autocompleteItemText}>{props.name || 'Unknown'}</Text>
                {subtitle ? <Text style={styles.autocompleteItemSubtext}>{subtitle}</Text> : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Reporting Mode Hint Banner */}
      {isReportingMode && !reportModalVisible && (
        <View style={styles.reportingBanner}>
          <Text style={styles.reportingBannerText}>📍 Long-press the map where the pothole is</Text>
          <TouchableOpacity onPress={cancelReport}>
            <Text style={{ color: '#fbbf24', fontWeight: 'bold', marginLeft: 12 }}>✕ Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

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

      {/* Gamification Sidebar overlay */}
      {!isDevMode && (
        <View style={[styles.gamificationOverlay, { top: 120 }]}>
          <Text style={{ fontSize: 24, textAlign: 'center' }}>🏆</Text>
          <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16, marginTop: 4 }}>{gamificationPoints} pts</Text>
          <Text style={{ color: '#fbbf24', fontSize: 10, fontWeight: 'bold', marginTop: 2 }}>PRO RIDER</Text>
        </View>
      )}

      {/* 2. Floating Control Overlay Panels */}
      <View style={styles.floatingControls}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Khalto Tracker {isDevMode && '(DEV)'}</Text>
            {routeStats ? (
               <View>
                 <Text style={{ color: '#3b82f6', fontSize: 11, fontWeight: '800', marginTop: 2 }}>
                   🔵 Safest: {routeStats.safest.distance}km, {routeStats.safest.duration}m (Potholes: {routeStats.safest.dangerScore})
                 </Text>
                 <Text style={{ color: '#6b7280', fontSize: 11, fontWeight: '800', marginTop: 1 }}>
                   {routeStats.safest.distance === routeStats.fastest.distance && routeStats.safest.dangerScore === routeStats.fastest.dangerScore 
                     ? '⚪ Fastest is the Safest route' 
                     : `⚪ Fastest: ${routeStats.fastest.distance}km, ${routeStats.fastest.duration}m (Potholes: ${routeStats.fastest.dangerScore})`}
                 </Text>
               </View>
            ) : (
               <Text style={{ color: '#3b82f6', fontSize: 11, fontWeight: '800', marginTop: 1 }}>
                 Long press map or search to route!
               </Text>
            )}
          </View>
          <View style={{ flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
             <View style={{ flexDirection: 'row', gap: 6 }}>
                {!isFollowingUser && (
                  <TouchableOpacity style={[styles.syncBtnSmall, { backgroundColor: '#4b5563' }]} onPress={() => setIsFollowingUser(true)}>
                    <Text style={styles.syncBtnTextSmall}>Recenter</Text>
                  </TouchableOpacity>
                )}
                {safestRouteCoords.length > 0 && (
                  <TouchableOpacity style={[styles.syncBtnSmall, { backgroundColor: '#ef4444' }]} onPress={() => { setSafestRouteCoords([]); setFastestRouteCoords([]); setRouteStats(null); setDestination(null); setIsFollowingUser(true); }}>
                    <Text style={styles.syncBtnTextSmall}>Clear</Text>
                  </TouchableOpacity>
                )}
             </View>
             <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity style={[styles.syncBtnSmall, { backgroundColor: isDevMode ? '#10b981' : '#64748b' }]} onPress={() => setIsDevMode(!isDevMode)}>
                  <Text style={styles.syncBtnTextSmall}>{isDevMode ? 'Normal Mode' : 'Dev Mode'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.syncBtnSmall, { backgroundColor: '#374151' }]} onPress={handleLogout}>
                  <Text style={styles.syncBtnTextSmall}>Logout</Text>
                </TouchableOpacity>
             </View>
          </View>
        </View>

        {/* Normal Mode Controls */}
        {!isDevMode && (
           <View>
             <TouchableOpacity
               style={[styles.actionBtn, { backgroundColor: isReportingMode ? '#7c3aed' : '#8b5cf6', marginTop: 8 }]}
               onPress={enterReportMode}
             >
               <Text style={styles.actionBtnText}>{isReportingMode ? '📍 Drop Pin...' : '📍 Report Pothole'}</Text>
             </TouchableOpacity>

             <View style={[styles.switchesRow, { marginTop: 12 }]}>
               <View style={styles.switchCol}>
                 <Text style={styles.switchLabel}>Record Telemetry</Text>
                 <Switch
                   value={isRecording}
                   onValueChange={setIsRecording}
                   trackColor={{ false: '#374151', true: '#3b82f6' }}
                   thumbColor={isRecording ? '#fff' : '#9ca3af'}
                 />
               </View>
               <View style={styles.switchCol}>
                  <TouchableOpacity style={styles.syncBtnSmall} onPress={() => triggerSync()}>
                    <Text style={styles.syncBtnTextSmall}>Sync Data</Text>
                  </TouchableOpacity>
               </View>
             </View>
           </View>
        )}

        {/* Developer Mode Controls */}
        {isDevMode && (
          <View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: '#10b981', flex: 1 }]}
                onPress={triggerSatelliteScan}
                disabled={isScanningSatellite}
              >
                {isScanningSatellite ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.actionBtnText}>🛰️ Satellite Scan</Text>
                )}
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[
                styles.actionBtn,
                { 
                  marginTop: 8,
                  backgroundColor: bleTestStatus === 'found' ? '#16a34a' : bleTestStatus === 'failed' ? '#dc2626' : bleTestStatus === 'scanning' ? '#6b7280' : '#1d4ed8'
                }
              ]}
              onPress={testBleNotification}
              disabled={bleTestStatus === 'scanning'}
            >
              {bleTestStatus === 'scanning' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.actionBtnText}>Broadcasting BLE Alert...</Text>
                </View>
              ) : (
                <Text style={styles.actionBtnText}>
                  {bleTestStatus === 'found' ? '✅ BLE Alert Sent!' : bleTestStatus === 'failed' ? '❌ BLE Test Failed' : '📡 Test BLE P2P Alert'}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.actionBtn, { marginTop: 8, backgroundColor: '#E8630A' }]}
              onPress={() => setCurrentScreen('simulation')}
            >
              <Text style={styles.actionBtnText}>▶ Run Simulation</Text>
            </TouchableOpacity>

            <View style={styles.switchesRow}>
              <View style={styles.switchCol}>
                <Text style={[styles.switchLabel, { color: bleOfflineMode ? '#34d399' : '#0f172a' }]}>
                  {isBleScanning ? '📡 BLE Active' : '📡 BLE Offline'}
                </Text>
                <Switch
                  value={bleOfflineMode}
                  onValueChange={setBleOfflineMode}
                  trackColor={{ false: '#374151', true: '#10b981' }}
                  thumbColor={bleOfflineMode ? '#fff' : '#9ca3af'}
                />
              </View>
            </View>

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
        )}
      </View>

      <Modal
        animationType="slide"
        transparent={true}
        visible={reportModalVisible}
        onRequestClose={cancelReport}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>📍 Report a Pothole</Text>

            {/* Pinned location — read-only, set by map long-press */}
            <View style={styles.pinLocationBox}>
              <Text style={styles.pinLocationLabel}>📌 Pin Location</Text>
              <Text style={styles.pinLocationCoords}>
                {reportPin
                  ? `${reportPin.latitude.toFixed(5)}, ${reportPin.longitude.toFixed(5)}`
                  : 'No pin dropped yet'}
              </Text>
            </View>

            {/* Experience Question */}
            <Text style={styles.inputLabel}>Did you drive through this pothole?</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              <TouchableOpacity
                style={[styles.sevBtn, { flex: 1 }, reportExperienced === true && styles.sevBtnActive]}
                onPress={() => setReportExperienced(true)}
              >
                <Text style={[styles.sevBtnText, reportExperienced === true && styles.sevBtnTextActive]}>✅ Yes, I hit it</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sevBtn, { flex: 1 }, reportExperienced === false && styles.sevBtnActive]}
                onPress={() => setReportExperienced(false)}
              >
                <Text style={[styles.sevBtnText, reportExperienced === false && styles.sevBtnTextActive]}>👁 I saw it</Text>
              </TouchableOpacity>
            </View>

            {/* Severity */}
            <Text style={styles.inputLabel}>Pothole Size</Text>
            <View style={styles.severityRow}>
              {[['low', '🟡 Small'], ['medium', '🟠 Medium'], ['high', '🔴 Large']].map(([sev, label]) => (
                <TouchableOpacity
                  key={sev}
                  style={[styles.sevBtn, { flex: 1 }, reportSeverity === sev && styles.sevBtnActive]}
                  onPress={() => setReportSeverity(sev)}
                >
                  <Text style={[styles.sevBtnText, reportSeverity === sev && styles.sevBtnTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={cancelReport}>
                <Text style={styles.modalBtnTextCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSubmit} onPress={submitManualReport}>
                <Text style={styles.modalBtnTextSubmit}>Submit Report</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  searchContainer: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    backgroundColor: '#fff',
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 52,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    zIndex: 100,
  },
  autocompleteDropdown: {
    position: 'absolute',
    top: 110,
    left: 16,
    right: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    zIndex: 99,
  },
  autocompleteItem: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  autocompleteItemText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
  },
  autocompleteItemSubtext: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  searchIconWrapper: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#1f2937',
    fontWeight: '500',
  },
  searchRightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarPlaceholder: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
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
  reportingBanner: {
    position: 'absolute',
    top: 115,
    left: 16,
    right: 16,
    backgroundColor: '#7c3aed',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 102
  },
  reportingBannerText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  pinLocationBox: {
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  pinLocationLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  pinLocationCoords: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    fontFamily: 'Courier',
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
,

  // ... (existing styles)
  warnHigh: {
    backgroundColor: '#fee2e2',
    borderColor: '#ef4444',
  },
  actionBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
    color: '#1f2937'
  },
  imagePickerBtn: {
    height: 150,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#d1d5db',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    overflow: 'hidden'
  },
  imagePickerText: {
    color: '#6b7280',
    fontWeight: 'bold',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  severityRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  sevBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sevBtnActive: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  sevBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
  },
  sevBtnTextActive: {
    color: '#fff',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  modalBtnCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  modalBtnTextCancel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#6b7280',
  },
  modalBtnSubmit: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: '#8b5cf6',
  },
  modalBtnTextSubmit: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
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
    top: 180,
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
  gamificationOverlay: {
    position: 'absolute',
    top: 70,
    right: 16,
    backgroundColor: '#3b82f6',
    borderRadius: 16,
    padding: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
    zIndex: 10
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
