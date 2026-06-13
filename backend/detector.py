import numpy as np
from scipy.signal import butter, filtfilt, welch
from scipy.integrate import trapezoid
from dataclasses import dataclass

@dataclass
class DetectionResult:
    is_pothole: bool           # Kept for backward compatibility
    confidence: float          # 0.0 - 1.0
    severity: str              # 'low', 'medium', 'high'
    vertical_power: float
    lateral_power: float
    event_duration_ms: float
    anomaly_type: str = 'pothole'  # 'pothole', 'speed_bump', 'rough_road', 'sudden_brake'
    depth_mm: float = 0.0
    area_cm2: float = 0.0
    urgency_score: float = 0.0

class PotholeDetector:
    POTHOLE_FREQ_LOW = 5     # Hz
    POTHOLE_FREQ_HIGH = 20    # Hz
    SAMPLE_RATE = 50          # Hz (standard mobile accelerometer rate)

    def __init__(self, threshold_vertical: float = 2.0, threshold_lateral: float = 0.5):
        self.threshold_vertical = threshold_vertical
        self.threshold_lateral = threshold_lateral

    def highpass_filter(self, data: np.ndarray, cutoff: float = 0.5) -> np.ndarray:
        """Removes the DC offset/gravity drift from the acceleration signal."""
        if len(data) < 15:
            # Not enough samples to construct filter, return detrended data
            return data - np.mean(data)
        nyq = self.SAMPLE_RATE / 2
        b, a = butter(4, cutoff / nyq, btype='high')
        return filtfilt(b, a, data)

    def spectral_band_power(self, signal: np.ndarray, f_low: float, f_high: float) -> float:
        """Computes power in a specific band using Welch's method."""
        if len(signal) < 8:
            return float(np.var(signal))
        # Use a segment length suitable for our window size (usually 50 samples)
        nperseg = min(len(signal), 32)
        freqs, psd = welch(signal, fs=self.SAMPLE_RATE, nperseg=nperseg)
        band_mask = (freqs >= f_low) & (freqs <= f_high)
        if not np.any(band_mask):
            return 0.0
        return float(trapezoid(psd[band_mask], freqs[band_mask]))

    def event_duration(self, samples: np.ndarray, threshold: float) -> float:
        """Estimates the shock duration in milliseconds."""
        above_threshold = np.abs(samples) > threshold
        if not np.any(above_threshold):
            return 0.0
        indices = np.where(above_threshold)[0]
        duration_samples = indices[-1] - indices[0] + 1
        return (duration_samples / self.SAMPLE_RATE) * 1000  # Convert to ms

    def classify(self, vertical_samples: list, lateral_samples: list = None) -> DetectionResult:
        """
        Classifies the event using a multi-class neural-emulating scoring model.
        Evaluates logits for: pothole, speed bump, rough road, and sudden braking.
        Extracts physical dimensions (depth/height, surface area) and urgency priority score.
        """
        if lateral_samples is None:
            lateral_samples = []

        v = np.array(vertical_samples, dtype=float)
        l = np.array(lateral_samples, dtype=float) if lateral_samples else np.zeros_like(v)

        if len(v) < 10:
            return DetectionResult(False, 0.0, 'low', 0.0, 0.0, 0.0, 'pothole', 0.0, 0.0, 0.0)

        # Apply highpass filter to isolate transients from gravity offsets
        v_clean = self.highpass_filter(v)
        l_clean = self.highpass_filter(l) if len(l) > 10 else l

        # Compute signal features
        rms_energy = float(np.sqrt(np.mean(v_clean ** 2)))
        peak_amplitude = float(np.max(np.abs(v_clean)))
        
        # Zero-Crossing Rate (frequency heuristic)
        zero_crossings = np.sum(np.diff(np.sign(v_clean)) != 0)
        zcr = float(zero_crossings / len(v_clean))

        # Calculate energy in the pothole band (5-20 Hz)
        v_power = self.spectral_band_power(v_clean, self.POTHOLE_FREQ_LOW, self.POTHOLE_FREQ_HIGH)
        l_power = self.spectral_band_power(l_clean, 0, 10) if len(l_clean) > 0 else 0.0

        # Duration of shock wave above a noise floor (30% of critical threshold)
        duration_ms = self.event_duration(v_clean, self.threshold_vertical * 0.3)

        # Neural-emulating Logit Activations
        logit_pothole = -2.2 + 3.8 * rms_energy + 0.8 * peak_amplitude - 2.5 * zcr
        if duration_ms >= 180.0:
            logit_pothole -= 15.0  # Speed bump/Rough road duration penalty
        if zcr <= 0.08:
            logit_pothole -= 10.0  # Frequency heuristic penalty

        logit_speed_bump = -1.5 - 0.8 * rms_energy + 1.2 * (duration_ms / 100.0) - 3.5 * zcr
        logit_rough_road = -2.5 + 2.2 * rms_energy - 1.0 * peak_amplitude + 1.5 * zcr
        logit_sudden_brake = -2.0 - 2.5 * v_power + 4.0 * l_power

        p_pothole = float(1.0 / (1.0 + np.exp(-logit_pothole)))
        p_speed_bump = float(1.0 / (1.0 + np.exp(-logit_speed_bump)))
        p_rough_road = float(1.0 / (1.0 + np.exp(-logit_rough_road)))
        p_sudden_brake = float(1.0 / (1.0 + np.exp(-logit_sudden_brake)))

        probabilities = {
            'pothole': p_pothole,
            'speed_bump': p_speed_bump,
            'rough_road': p_rough_road,
            'sudden_brake': p_sudden_brake
        }

        # Argmax selection
        anomaly_type = max(probabilities, key=probabilities.get)
        confidence = float(probabilities[anomaly_type])

        # Estimate dimensions and municipal priority urgency score
        depth_mm = 0.0
        area_cm2 = 0.0
        
        if anomaly_type == 'pothole':
            depth_mm = float(v_power * 14.5)
            area_cm2 = float(duration_ms * 0.75)
            urgency_score = min(100.0, (depth_mm / 60.0) * 45.0 + (area_cm2 / 200.0) * 35.0 + confidence * 20.0)
        elif anomaly_type == 'speed_bump':
            depth_mm = float(rms_energy * 38.0) # Height of bump
            area_cm2 = float(duration_ms * 1.4)
            urgency_score = min(50.0, (depth_mm / 100.0) * 20.0 + confidence * 30.0)
        elif anomaly_type == 'rough_road':
            depth_mm = float(rms_energy * 4.5) # Surface deviation
            area_cm2 = float(duration_ms * 4.8)
            urgency_score = min(70.0, (depth_mm / 15.0) * 40.0 + confidence * 30.0)
        else: # sudden_brake
            depth_mm = 0.0
            area_cm2 = float(l_power * 12.0)
            urgency_score = min(35.0, (l_power / 2.0) * 25.0 + confidence * 10.0)

        # Map to low/medium/high severity categories
        severity = 'low'
        if urgency_score > 65.0:
            severity = 'high'
        elif urgency_score > 35.0:
            severity = 'medium'

        # Ensure compatibility with existing is_pothole boolean
        is_pothole = bool(anomaly_type == 'pothole' and confidence > 0.4)

        return DetectionResult(
            is_pothole=is_pothole,
            confidence=confidence,
            severity=severity,
            vertical_power=float(v_power),
            lateral_power=float(l_power),
            event_duration_ms=float(duration_ms),
            anomaly_type=anomaly_type,
            depth_mm=round(depth_mm, 1),
            area_cm2=round(area_cm2, 1),
            urgency_score=round(urgency_score, 1)
        )
