/**
 * BleManager.js — RoadSense Offline BLE P2P Alert Engine
 *
 * Architecture:
 *   • SCANNING (Central mode): Uses react-native-ble-plx to scan for nearby
 *     Roadsense devices broadcasting pothole alerts via BLE manufacturer data.
 *   • ADVERTISING (Peripheral mode): Encodes a 20-byte payload containing
 *     lat/lng/severity and starts BLE advertisement so nearby phones receive it.
 *     Peripheral mode requires a native EAS build — gracefully degrades in Expo Go.
 *
 * Payload format (20 bytes, fits in BLE manufacturer data):
 *   [0-3]  lat  as Float32 (4 bytes)
 *   [4-7]  lng  as Float32 (4 bytes)
 *   [8]    severity: 0=low, 1=medium, 2=high (1 byte)
 *   [9-19] padding zeros (11 bytes)
 *
 * Service UUID used: '0000DEAD-0000-1000-8000-00805F9B34FB' (custom Roadsense UUID)
 */

import { Platform, NativeModules } from 'react-native';

// ── Constants ─────────────────────────────────────────────────────────────────
const ROADSENSE_SERVICE_UUID = '0000DEAD-0000-1000-8000-00805F9B34FB';
const ROADSENSE_MANUFACTURER_ID = 0x0A15; // Roadsense custom company ID
const SCAN_DURATION_MS = 15000; // 15 seconds per scan cycle
const SEVERITY_MAP = { 0: 'low', 1: 'medium', 2: 'high' };
const SEVERITY_REVERSE = { low: 0, medium: 1, high: 2 };

// ── Lazy-load BLE library to avoid crashing in environments without native modules
let BleManagerLib = null;
let BleManagerInstance = null;
let isLibAvailable = false;

const loadBleLib = () => {
  if (BleManagerLib !== null) return isLibAvailable;
  try {
    const { BleManager } = require('react-native-ble-plx');
    BleManagerLib = BleManager;
    BleManagerInstance = new BleManager();
    isLibAvailable = true;
  } catch (e) {
    // react-native-ble-plx not linked (Expo Go) — degrade gracefully
    isLibAvailable = false;
  }
  return isLibAvailable;
};

// ── Payload Encoding / Decoding ───────────────────────────────────────────────

/**
 * Encodes a pothole alert into a 20-byte Buffer.
 */
export function encodePotholePayload(lat, lng, severity) {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  view.setFloat32(0, lat, true);   // little-endian
  view.setFloat32(4, lng, true);
  view.setUint8(8, SEVERITY_REVERSE[severity] ?? 1);
  // bytes 9-19 remain 0 (padding)
  return buf;
}

/**
 * Decodes a 20-byte manufacturer data Buffer from a BLE advertisement.
 * Returns null if the buffer is too short or malformed.
 */
export function decodePotholePayload(base64Data) {
  try {
    // BLE manufacturer data arrives as base64 from react-native-ble-plx
    const binary = atob(base64Data);
    if (binary.length < 9) return null;
    const buf = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(buf);
    const lat = view.getFloat32(0, true);
    const lng = view.getFloat32(4, true);
    const sevByte = view.getUint8(8);
    const severity = SEVERITY_MAP[sevByte] ?? 'medium';
    // Sanity check: valid GPS range
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, severity };
  } catch {
    return null;
  }
}

// ── BLE Engine ────────────────────────────────────────────────────────────────

let _scanSubscription = null;
let _isScanning = false;
let _scanTimer = null;

/**
 * Starts BLE scanning for nearby Roadsense pothole broadcasts.
 * @param {(pothole: {lat, lng, severity, deviceId}) => void} onPotholeDetected
 * @param {(log: string) => void} onLog
 */
export async function startScanning(onPotholeDetected, onLog) {
  if (!loadBleLib()) {
    onLog('BLE: Library not available (Expo Go). Running in simulation mode.');
    return false;
  }

  if (_isScanning) {
    onLog('BLE: Already scanning.');
    return true;
  }

  // Request permissions on Android 12+
  if (Platform.OS === 'android' && Platform.Version >= 31) {
    try {
      const { PermissionsAndroid } = require('react-native');
      const grants = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      const allGranted = Object.values(grants).every(
        v => v === PermissionsAndroid.RESULTS.GRANTED
      );
      if (!allGranted) {
        onLog('BLE: Bluetooth permissions denied.');
        return false;
      }
    } catch (e) {
      onLog(`BLE: Permission error — ${e.message}`);
      return false;
    }
  }

  onLog('BLE: Starting scan for nearby Roadsense devices...');
  _isScanning = true;

  const seenDevices = new Set();

  _scanSubscription = BleManagerInstance.onStateChange(state => {
    if (state === 'PoweredOn') {
      BleManagerInstance.startDeviceScan(
        null, // scan all UUIDs (filter in callback)
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            onLog(`BLE Scan error: ${error.message}`);
            return;
          }
          if (!device) return;

          // Filter by our manufacturer data or device name
          const name = device.name || device.localName || '';
          const mfData = device.manufacturerData;

          if (name.startsWith('RS-') || (mfData && mfData.length >= 12)) {
            if (seenDevices.has(device.id)) return;
            seenDevices.add(device.id);

            if (mfData) {
              const pothole = decodePotholePayload(mfData);
              if (pothole) {
                onLog(`📡 BLE Alert received from ${device.id.slice(-8)}: ${pothole.severity} pothole at ${pothole.lat.toFixed(5)}, ${pothole.lng.toFixed(5)}`);
                onPotholeDetected({ ...pothole, deviceId: device.id });
              }
            }
          }
        }
      );
    }
  }, true);

  // Restart scan every 15 seconds to stay fresh
  _scanTimer = setInterval(() => {
    if (_isScanning && BleManagerInstance) {
      BleManagerInstance.stopDeviceScan();
      seenDevices.clear();
      BleManagerInstance.startDeviceScan(null, { allowDuplicates: false }, () => {});
    }
  }, SCAN_DURATION_MS);

  return true;
}

/**
 * Stops all BLE scanning.
 */
export function stopScanning(onLog) {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  if (_scanSubscription) { _scanSubscription.remove(); _scanSubscription = null; }
  if (isLibAvailable && BleManagerInstance) {
    try { BleManagerInstance.stopDeviceScan(); } catch {}
  }
  _isScanning = false;
  if (onLog) onLog('BLE: Scanning stopped.');
}

/**
 * Broadcasts a pothole alert over BLE (Peripheral/Advertising mode).
 * Works in native EAS builds. In Expo Go, logs the payload that WOULD be sent.
 * @param {number} lat
 * @param {number} lng
 * @param {'low'|'medium'|'high'} severity
 * @param {(log: string) => void} onLog
 */
export async function broadcastAlert(lat, lng, severity, onLog) {
  const payload = encodePotholePayload(lat, lng, severity);
  const bytes = new Uint8Array(payload);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

  // Check if native BLE advertising is available (requires EAS build)
  const hasNativeAdvertising = NativeModules.BLEAdvertiser != null;

  if (!hasNativeAdvertising) {
    // Graceful degradation: log the would-be payload
    onLog(`📡 BLE (Expo Go sim): Would broadcast payload → [${hex.slice(0, 23)}...]`);
    onLog(`   Encoded: lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} severity=${severity}`);
    onLog(`   ⚠ Install EAS build to enable real BLE advertising to nearby phones.`);
    return { simulated: true };
  }

  // Real BLE advertising (EAS native build only)
  try {
    const BleAdvertiser = NativeModules.BLEAdvertiser;
    await BleAdvertiser.setCompanyId(ROADSENSE_MANUFACTURER_ID);
    await BleAdvertiser.broadcast(
      ROADSENSE_SERVICE_UUID,
      Array.from(bytes),
      {}
    );
    onLog(`✅ BLE: Alert broadcast! (${severity} pothole at ${lat.toFixed(5)}, ${lng.toFixed(5)})`);
    // Auto-stop after 10 seconds to save battery
    setTimeout(() => {
      try { BleAdvertiser.stopBroadcast(); } catch {}
    }, 10000);
    return { simulated: false };
  } catch (e) {
    onLog(`❌ BLE broadcast error: ${e.message}`);
    throw e;
  }
}

/**
 * Full cleanup — call on component unmount.
 */
export function destroyBle(onLog) {
  stopScanning(onLog);
  if (isLibAvailable && BleManagerInstance) {
    try { BleManagerInstance.destroy(); } catch {}
  }
}
