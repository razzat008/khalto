import unittest
import numpy as np
import json
import os

from db import Database
from detector import PotholeDetector
from clustering import SpatialClusterer
from mcmc import MCMCChangePointDetector
from calibration import CalibrationManager

class TestRoadSensePipeline(unittest.TestCase):

    def setUp(self):
        # Initialize test database
        self.db = Database("test_roadsense.db")
        self.db.init()
        self.detector = PotholeDetector(threshold_vertical=2.0, threshold_lateral=0.5)
        self.clusterer = SpatialClusterer(epsilon_meters=15.0, min_samples=3)
        self.mcmc = MCMCChangePointDetector()

    def tearDown(self):
        # Clean up database file after test
        if os.path.exists("test_roadsense.db"):
            os.remove("test_roadsense.db")

    def test_dsp_pothole_classification(self):
        """Verify that high-frequency sharp transients are classified as potholes, but long-duration waves are not."""
        # 1. Pothole signal: Sudden high amplitude spike (1 second at 50Hz)
        pothole_samples = np.random.normal(0, 0.1, 50)
        pothole_samples[24] = 15.0  # Spike
        pothole_samples[25] = -12.0 # Rebound
        
        result_p = self.detector.classify(pothole_samples.tolist())
        self.assertTrue(result_p.is_pothole, "Sharp transient should be classified as a pothole")
        self.assertGreater(result_p.confidence, 0.0)

        # 2. Speed Bump signal: Low frequency swell (longer duration)
        bump_samples = np.random.normal(0, 0.1, 50)
        for i in range(15, 35):
            bump_samples[i] += np.sin(((i - 15) / 20) * np.pi) * 1.8
            
        result_b = self.detector.classify(bump_samples.tolist())
        self.assertFalse(result_b.is_pothole, "Longer duration swells (speed bumps) should be filtered out")

    def test_spatial_clustering(self):
        """Verify that DBSCAN clusters coordinates within 15 meters correctly."""
        # Kathmandu coordinates
        base_lat, base_lng = 27.7172, 85.3240
        
        # Reports near each other (<10 meters delta)
        reports = [
            {'id': 1, 'lat': base_lat + 0.00002, 'lng': base_lng + 0.00001, 'severity': 'high'},
            {'id': 2, 'lat': base_lat - 0.00001, 'lng': base_lng + 0.00002, 'severity': 'high'},
        ]
        
        # Check if a new report at the base coordinate confirms a cluster
        cluster = self.clusterer.check_cluster(base_lat, base_lng, reports)
        self.assertTrue(cluster['confirmed'], "Points within 15m should cluster")
        self.assertEqual(cluster['count'], 3)
        self.assertAlmostEqual(cluster['centroid_lat'], base_lat, places=4)
        self.assertEqual(cluster['severity'], 'high')

        # Report far away (e.g. 500 meters) should not cluster
        far_reports = [
            {'id': 1, 'lat': base_lat + 0.005, 'lng': base_lng + 0.005, 'severity': 'low'},
            {'id': 2, 'lat': base_lat - 0.005, 'lng': base_lng - 0.005, 'severity': 'low'},
        ]
        cluster_far = self.clusterer.check_cluster(base_lat, base_lng, far_reports)
        self.assertFalse(cluster_far['confirmed'], "Points far away should not form a cluster")

    def test_mcmc_change_point_detection(self):
        """Verify that MCMC detects rising confidence change-points, but ignores stationary noise."""
        # 1. Real Pothole Pattern: Rising confidence trend
        rising_seq = [0.1, 0.12, 0.15, 0.65, 0.7, 0.78, 0.82]
        res_rising = self.mcmc.detect_change_point(rising_seq)
        self.assertTrue(res_rising['change_detected'], "Regime shift with rising confidence should be detected")
        self.assertGreater(res_rising['posterior_probability'], 0.3)

        # 2. Random Noise Pattern: Stationary low confidence scores
        noisy_seq = [0.12, 0.15, 0.11, 0.13, 0.14, 0.12, 0.16]
        res_noisy = self.mcmc.detect_change_point(noisy_seq)
        self.assertFalse(res_noisy['change_detected'], "Uniform low confidence noise sequence should have no change point")

    def test_database_insert_and_upsert(self):
        """Verify report inserts and verified pothole upserts in SQLite."""
        # Insert report
        rid = self.db.insert_report(27.7172, 85.3240, "dev_1", 0.8, "high", 3.2, 0.0, 9.5, None, "test_user", "Test Friendly Name", 1620000000000)
        self.assertGreater(rid, 0)

        # Upsert verified pothole
        pid1 = self.db.upsert_verified_pothole(27.7172, 85.3240, 3, "high", 0.9)
        self.assertGreater(pid1, 0)

        # Upsert close coordinate should update the count instead of creating new marker
        pid2 = self.db.upsert_verified_pothole(27.717205, 85.324005, 4, "high", 0.95)
        self.assertEqual(pid1, pid2, "Upserting within 15 meters should update the existing pothole record")

        potholes = self.db.get_all_potholes()
        self.assertEqual(len(potholes), 1)
        self.assertEqual(potholes[0]['report_count'], 4)

if __name__ == '__main__':
    unittest.main()
