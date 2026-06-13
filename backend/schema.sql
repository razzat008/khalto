-- Raw reports received from Android devices
CREATE TABLE IF NOT EXISTS reports (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    lat                REAL NOT NULL,
    lng                REAL NOT NULL,
    device_id          TEXT NOT NULL,
    confidence         REAL NOT NULL,
    severity           TEXT NOT NULL,
    vertical_power     REAL NOT NULL,
    z_variance         REAL NOT NULL DEFAULT 0.0,
    speed              REAL NOT NULL DEFAULT 0.0,
    telemetry_json     TEXT,
    username           TEXT,
    friendly_name      TEXT,
    timestamp          INTEGER NOT NULL,
    anomaly_type       TEXT NOT NULL DEFAULT 'pothole',
    depth_mm           REAL DEFAULT 0.0,
    area_cm2           REAL DEFAULT 0.0,
    urgency_score      REAL DEFAULT 0.0,
    road_name          TEXT,
    contractor         TEXT,
    road_creation_date TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User accounts table
CREATE TABLE IF NOT EXISTS users (
    username        TEXT PRIMARY KEY,
    password_hash   TEXT NOT NULL,
    device_id       TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Spatially aggregated, MCMC change-point verified potholes
CREATE TABLE IF NOT EXISTS verified_potholes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    lat                REAL NOT NULL,
    lng                REAL NOT NULL,
    report_count       INTEGER NOT NULL DEFAULT 1,
    severity           TEXT NOT NULL,
    mcmc_confidence    REAL NOT NULL,
    anomaly_type       TEXT NOT NULL DEFAULT 'pothole',
    depth_mm           REAL DEFAULT 0.0,
    area_cm2           REAL DEFAULT 0.0,
    urgency_score      REAL DEFAULT 0.0,
    road_name          TEXT,
    contractor         TEXT,
    road_creation_date TEXT,
    status             TEXT NOT NULL DEFAULT 'Active',
    smooth_passes      INTEGER NOT NULL DEFAULT 0,
    first_reported     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Calibration profiles for individual vehicles/devices
CREATE TABLE IF NOT EXISTS calibration (
    device_id           TEXT PRIMARY KEY,
    threshold_vertical  REAL NOT NULL DEFAULT 2.0,
    threshold_lateral   REAL NOT NULL DEFAULT 0.5,
    baseline_mean       REAL NOT NULL DEFAULT 0.0,
    baseline_std        REAL NOT NULL DEFAULT 1.0,
    sample_count        INTEGER NOT NULL DEFAULT 0,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
