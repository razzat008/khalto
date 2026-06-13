import sqlite3
import os
from datetime import datetime

class Database:
    def __init__(self, path: str = "roadsense.db"):
        self.path = path

    def conn(self):
        # Ensure path is absolute or in the correct working directory
        db_conn = sqlite3.connect(self.path)
        db_conn.row_factory = sqlite3.Row
        return db_conn

    def init(self):
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        with self.conn() as c:
            with open(schema_path, "r") as f:
                c.executescript(f.read())
            
            # Run migrations on reports table for user properties
            try:
                c.execute("SELECT username FROM reports LIMIT 1")
            except sqlite3.OperationalError:
                c.execute("ALTER TABLE reports ADD COLUMN username TEXT")
                c.execute("ALTER TABLE reports ADD COLUMN friendly_name TEXT")

            # Run migrations on reports table for anomaly classification columns
            try:
                c.execute("SELECT anomaly_type FROM reports LIMIT 1")
            except sqlite3.OperationalError:
                c.execute("ALTER TABLE reports ADD COLUMN anomaly_type TEXT NOT NULL DEFAULT 'pothole'")
                c.execute("ALTER TABLE reports ADD COLUMN depth_mm REAL DEFAULT 0.0")
                c.execute("ALTER TABLE reports ADD COLUMN area_cm2 REAL DEFAULT 0.0")
                c.execute("ALTER TABLE reports ADD COLUMN urgency_score REAL DEFAULT 0.0")
                c.execute("ALTER TABLE reports ADD COLUMN road_name TEXT")
                c.execute("ALTER TABLE reports ADD COLUMN contractor TEXT")
                c.execute("ALTER TABLE reports ADD COLUMN road_creation_date TEXT")

            # Run migrations on verified_potholes table
            try:
                c.execute("SELECT anomaly_type FROM verified_potholes LIMIT 1")
            except sqlite3.OperationalError:
                c.execute("ALTER TABLE verified_potholes ADD COLUMN anomaly_type TEXT NOT NULL DEFAULT 'pothole'")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN depth_mm REAL DEFAULT 0.0")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN area_cm2 REAL DEFAULT 0.0")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN urgency_score REAL DEFAULT 0.0")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN road_name TEXT")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN contractor TEXT")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN road_creation_date TEXT")

            try:
                c.execute("SELECT status FROM verified_potholes LIMIT 1")
            except sqlite3.OperationalError:
                c.execute("ALTER TABLE verified_potholes ADD COLUMN status TEXT NOT NULL DEFAULT 'Active'")
                c.execute("ALTER TABLE verified_potholes ADD COLUMN smooth_passes INTEGER NOT NULL DEFAULT 0")

    def insert_report(self, lat: float, lng: float, device_id: str, confidence: float, severity: str, vertical_power: float, z_variance: float, speed: float, telemetry_json: str, username: str, friendly_name: str, timestamp: int, anomaly_type: str = 'pothole', depth_mm: float = 0.0, area_cm2: float = 0.0, urgency_score: float = 0.0, road_name: str = None, contractor: str = None, road_creation_date: str = None) -> int:
        with self.conn() as c:
            cur = c.execute(
                """INSERT INTO reports
                   (lat, lng, device_id, confidence, severity, vertical_power, z_variance, speed, telemetry_json, username, friendly_name, timestamp, anomaly_type, depth_mm, area_cm2, urgency_score, road_name, contractor, road_creation_date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (lat, lng, device_id, confidence, severity, vertical_power, z_variance, speed, telemetry_json, username, friendly_name, timestamp, anomaly_type, depth_mm, area_cm2, urgency_score, road_name, contractor, road_creation_date)
            )
            return cur.lastrowid

    def create_user(self, username: str, password_hash: str, device_id: str = None) -> bool:
        try:
            with self.conn() as c:
                c.execute(
                    "INSERT INTO users (username, password_hash, device_id) VALUES (?, ?, ?)",
                    (username, password_hash, device_id)
                )
                return True
        except Exception:
            return False

    def get_user(self, username: str) -> dict:
        with self.conn() as c:
            row = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
            return dict(row) if row else None

    def update_user_device(self, username: str, device_id: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE users SET device_id = ? WHERE username = ?", (device_id, username))

    def get_recent_reports(self, limit: int = 500) -> list:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM reports ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def get_reports_by_ids(self, ids: list) -> list:
        if not ids:
            return []
        placeholders = ','.join(['?'] * len(ids))
        with self.conn() as c:
            rows = c.execute(
                f"SELECT * FROM reports WHERE id IN ({placeholders})", ids
            ).fetchall()
            return [dict(r) for r in rows]

    def upsert_verified_pothole(self, lat: float, lng: float, report_count: int, severity: str, mcmc_confidence: float, anomaly_type: str = 'pothole', depth_mm: float = 0.0, area_cm2: float = 0.0, urgency_score: float = 0.0, road_name: str = None, contractor: str = None, road_creation_date: str = None) -> int:
        # 15 meters in degrees lat/lng is approx 0.00015
        threshold_deg = 0.00015
        with self.conn() as c:
            # Check if there is an existing verified pothole near these coordinates of the same type
            existing = c.execute(
                """SELECT id, report_count, depth_mm, area_cm2, urgency_score FROM verified_potholes
                   WHERE ABS(lat - ?) < ? AND ABS(lng - ?) < ? AND anomaly_type = ?""",
                (lat, threshold_deg, lng, threshold_deg, anomaly_type)
            ).fetchone()

            if existing:
                pothole_id = existing['id']
                new_count = max(existing['report_count'] + 1, report_count)
                # Compute average depth, area, and urgency score
                existing_depth = existing['depth_mm'] if existing['depth_mm'] is not None else 0.0
                existing_area = existing['area_cm2'] if existing['area_cm2'] is not None else 0.0
                existing_urgency = existing['urgency_score'] if existing['urgency_score'] is not None else 0.0
                new_depth = (existing_depth * existing['report_count'] + depth_mm) / new_count
                new_area = (existing_area * existing['report_count'] + area_cm2) / new_count
                new_urgency = (existing_urgency * existing['report_count'] + urgency_score) / new_count
                
                c.execute(
                    """UPDATE verified_potholes
                       SET report_count = ?, severity = ?, mcmc_confidence = ?, depth_mm = ?, area_cm2 = ?, urgency_score = ?, status = 'Active', smooth_passes = 0, last_updated = ?
                       WHERE id = ?""",
                    (new_count, severity, mcmc_confidence, new_depth, new_area, new_urgency, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), pothole_id)
                )
                return pothole_id
            else:
                cur = c.execute(
                    """INSERT INTO verified_potholes (lat, lng, report_count, severity, mcmc_confidence, anomaly_type, depth_mm, area_cm2, urgency_score, road_name, contractor, road_creation_date, status, smooth_passes)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 0)""",
                    (lat, lng, report_count, severity, mcmc_confidence, anomaly_type, depth_mm, area_cm2, urgency_score, road_name, contractor, road_creation_date)
                )
                return cur.lastrowid

    def register_smooth_pass(self, pothole_id: int) -> dict:
        """
        Increments the smooth_passes counter.
        If smooth_passes reaches 3, updates the status to 'Patched'.
        Returns the updated row.
        """
        with self.conn() as c:
            existing = c.execute("SELECT smooth_passes, status FROM verified_potholes WHERE id = ?", (pothole_id,)).fetchone()
            if existing:
                passes = existing['smooth_passes'] + 1
                status = 'Patched' if passes >= 3 else existing['status']
                c.execute(
                    "UPDATE verified_potholes SET smooth_passes = ?, status = ?, last_updated = ? WHERE id = ?",
                    (passes, status, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), pothole_id)
                )
                return {"id": pothole_id, "status": status, "smooth_passes": passes}
            return None

    def get_all_potholes(self) -> list:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM verified_potholes ORDER BY last_updated DESC").fetchall()
            return [dict(r) for r in rows]

    def get_stats(self) -> dict:
        with self.conn() as c:
            total_reports = c.execute("SELECT COUNT(*) FROM reports").fetchone()[0] or 0
            verified = c.execute("SELECT COUNT(*) FROM verified_potholes").fetchone()[0] or 0
            high_severity = c.execute("SELECT COUNT(*) FROM verified_potholes WHERE severity='high'").fetchone()[0] or 0
            return {
                'total_reports': total_reports,
                'verified_potholes': verified,
                'high_severity': high_severity
            }
