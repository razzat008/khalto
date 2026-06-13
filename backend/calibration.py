import numpy as np
from db import Database

DEFAULT_THRESHOLDS = {
    'vertical': 5.0,
    'lateral': 2.0
}

CALIBRATION_WINDOW = 50    # Number of samples needed to establish a baseline
SIGMA_MULTIPLIER = 2.5     # Threshold = mean + 2.5 * std


class CalibrationManager:
    def __init__(self, db_path: str = "roadsense.db"):
        self.db = Database(db_path)
        # Store in-memory calibration buffers per device
        self._buffers = {}
        self._calibrated = set()

    def is_calibrated(self, device_id: str) -> bool:
        if device_id in self._calibrated:
            return True
        
        # Check database
        try:
            with self.db.conn() as c:
                row = c.execute("SELECT device_id FROM calibration WHERE device_id = ?", (device_id,)).fetchone()
                if row:
                    self._calibrated.add(device_id)
                    return True
        except Exception:
            pass
        return False

    def update_baseline(self, device_id: str, event_data: dict):
        """
        Processes incoming telemetry to establish or adapt a device's threshold.
        """
        if device_id not in self._buffers:
            self._buffers[device_id] = []

        samples = event_data.get('samples', [])
        if not samples:
            return

        # Calculate Root-Mean-Square (RMS) of the sample window as a single road-roughness metric
        rms = float(np.sqrt(np.mean(np.array(samples) ** 2)))
        self._buffers[device_id].append(rms)

        buf = self._buffers[device_id]

        # First-time calibration phase
        if len(buf) >= CALIBRATION_WINDOW and not self.is_calibrated(device_id):
            baseline_mean = float(np.mean(buf))
            baseline_std = float(np.std(buf)) if len(buf) > 1 else 1.0
            
            # Avoid division by zero or extremely low thresholds on perfectly flat mock environments
            baseline_std = max(baseline_std, 0.2)

            threshold_v = baseline_mean + SIGMA_MULTIPLIER * baseline_std
            threshold_l = threshold_v * 0.3  # Lateral thresholds scale proportionally

            with self.db.conn() as c:
                c.execute(
                    """INSERT OR REPLACE INTO calibration
                       (device_id, threshold_vertical, threshold_lateral, baseline_mean, baseline_std, sample_count)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (device_id, threshold_v, threshold_l, baseline_mean, baseline_std, len(buf))
                )
            self._calibrated.add(device_id)
            self._buffers[device_id] = []

        # Online adaptation phase (EMA updates to track slow changes in vehicle load or tires)
        elif self.is_calibrated(device_id) and len(buf) >= 10:
            current = self.get_thresholds(device_id)
            new_rms = float(np.mean(buf[-10:]))
            alpha = 0.05  # Slow learning rate to prevent single-pothole feedback loops
            
            new_mean = (1 - alpha) * current['baseline_mean'] + alpha * new_rms
            new_std = current['baseline_std']  # Keep baseline standard deviation stable
            new_v = new_mean + SIGMA_MULTIPLIER * new_std

            with self.db.conn() as c:
                c.execute(
                    """UPDATE calibration SET
                       threshold_vertical = ?, threshold_lateral = ?,
                       baseline_mean = ?, updated_at = CURRENT_TIMESTAMP
                       WHERE device_id = ?""",
                    (new_v, new_v * 0.3, new_mean, device_id)
                )
            self._buffers[device_id] = []

    def get_thresholds(self, device_id: str) -> dict:
        try:
            with self.db.conn() as c:
                row = c.execute("SELECT * FROM calibration WHERE device_id = ?", (device_id,)).fetchone()
                if row:
                    return {
                        'vertical': row['threshold_vertical'],
                        'lateral': row['threshold_lateral'],
                        'baseline_mean': row['baseline_mean'],
                        'baseline_std': row['baseline_std']
                    }
        except Exception:
            pass
        return {
            'vertical': DEFAULT_THRESHOLDS['vertical'],
            'lateral': DEFAULT_THRESHOLDS['lateral'],
            'baseline_mean': 0.0,
            'baseline_std': 1.0
        }
