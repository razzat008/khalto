import * as SQLite from 'expo-sqlite';

let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const dbInstance = await SQLite.openDatabaseAsync('roadsense.db');
      await dbInstance.execAsync(`
        CREATE TABLE IF NOT EXISTS telemetry_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          speedMs REAL NOT NULL,
          verticalPower REAL NOT NULL,
          rawSamplesJson TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          isSynced INTEGER DEFAULT 0
        );
      `);
      return dbInstance;
    })();
  }
  return dbPromise;
}

export async function initDatabase() {
  await getDb();
}

export async function insertTelemetry(lat, lng, speedMs, verticalPower, samples) {
  const database = await getDb();
  await database.runAsync(
    `INSERT INTO telemetry_reports (lat, lng, speedMs, verticalPower, rawSamplesJson, timestamp)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [lat, lng, speedMs, verticalPower, JSON.stringify(samples), Date.now()]
  );
}

export async function getUnsyncedReports() {
  const database = await getDb();
  return await database.getAllAsync('SELECT * FROM telemetry_reports WHERE isSynced = 0;');
}

export async function markReportsAsSynced(ids) {
  if (ids.length === 0) return;
  const database = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(
    `UPDATE telemetry_reports SET isSynced = 1 WHERE id IN (${placeholders});`,
    ids
  );
}

export async function pruneSyncedReports() {
  const database = await getDb();
  await database.runAsync('DELETE FROM telemetry_reports WHERE isSynced = 1;');
}

export async function getOrCreateDeviceFingerprint() {
  const database = await getDb();
  await database.runAsync(`
    CREATE TABLE IF NOT EXISTS device_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  
  const row = await database.getFirstAsync("SELECT value FROM device_config WHERE key = 'fingerprint';");
  if (row) {
    return row.value;
  }
  
  // Generate a random 4-character hex suffix to append to vehicle type for unique ID
  const randomHex = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const vehicleType = Math.random() > 0.5 ? 'suv' : 'motorcycle';
  const fingerprint = `${vehicleType}_rider_${randomHex}`;
  
  await database.runAsync("INSERT OR REPLACE INTO device_config (key, value) VALUES ('fingerprint', ?);", [fingerprint]);
  return fingerprint;
}

export async function saveAuthSession(token, username, friendlyName, deviceId) {
  const database = await getDb();
  await database.runAsync("INSERT OR REPLACE INTO device_config (key, value) VALUES ('token', ?);", [token]);
  await database.runAsync("INSERT OR REPLACE INTO device_config (key, value) VALUES ('username', ?);", [username]);
  await database.runAsync("INSERT OR REPLACE INTO device_config (key, value) VALUES ('friendly_name', ?);", [friendlyName]);
  await database.runAsync("INSERT OR REPLACE INTO device_config (key, value) VALUES ('device_id', ?);", [deviceId]);
}

export async function getAuthSession() {
  const database = await getDb();
  await database.runAsync(`
    CREATE TABLE IF NOT EXISTS device_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  
  const tokenRow = await database.getFirstAsync("SELECT value FROM device_config WHERE key = 'token';");
  const userRow = await database.getFirstAsync("SELECT value FROM device_config WHERE key = 'username';");
  const friendlyRow = await database.getFirstAsync("SELECT value FROM device_config WHERE key = 'friendly_name';");
  const deviceRow = await database.getFirstAsync("SELECT value FROM device_config WHERE key = 'device_id';");

  return {
    token: tokenRow ? tokenRow.value : null,
    username: userRow ? userRow.value : null,
    friendlyName: friendlyRow ? friendlyRow.value : null,
    deviceId: deviceRow ? deviceRow.value : null
  };
}

export async function clearAuthSession() {
  const database = await getDb();
  await database.runAsync("DELETE FROM device_config WHERE key IN ('token', 'username', 'friendly_name');");
}
