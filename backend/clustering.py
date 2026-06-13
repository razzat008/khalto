import numpy as np
from sklearn.cluster import DBSCAN

EARTH_RADIUS_M = 6371000

def haversine_matrix(coords: np.ndarray) -> np.ndarray:
    """Computes pairwise Haversine distances in meters."""
    lat = np.radians(coords[:, 0])
    lng = np.radians(coords[:, 1])
    dlat = lat[:, None] - lat[None, :]
    dlng = lng[:, None] - lng[None, :]
    a = np.sin(dlat/2)**2 + np.cos(lat[:, None]) * np.cos(lat[None, :]) * np.sin(dlng/2)**2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a))

class SpatialClusterer:
    def __init__(self, epsilon_meters: float = 15.0, min_samples: int = 3):
        self.epsilon = epsilon_meters
        self.min_samples = min_samples

    def check_cluster(self, new_lat: float, new_lng: float, all_reports: list, new_report_id: int = -1, new_severity: str = 'medium') -> dict:
        """
        Runs DBSCAN clustering over recent reports combined with the new report coordinate.
        Returns details of the cluster if the new coordinate is successfully grouped.
        """
        if self.min_samples <= 1:
            return {
                'confirmed': True,
                'centroid_lat': new_lat,
                'centroid_lng': new_lng,
                'count': 1,
                'severity': new_severity,
                'report_ids': [new_report_id]
            }

        # Shortcut: If there are no other reports, confirm immediately if min_samples <= 1
        if len(all_reports) == 0:
            if self.min_samples <= 1:
                return {
                    'confirmed': True,
                    'centroid_lat': new_lat,
                    'centroid_lng': new_lng,
                    'count': 1,
                    'severity': new_severity,
                    'report_ids': [new_report_id]
                }
            else:
                return {'confirmed': False}

        if len(all_reports) < self.min_samples - 1:
            return {'confirmed': False}

        # Build list of coords, appending the new report at the end
        coords = [[r['lat'], r['lng']] for r in all_reports]
        coords.append([new_lat, new_lng])
        coords_arr = np.array(coords)

        # Compute pairwise distance matrix using Haversine metric
        dist_matrix = haversine_matrix(coords_arr)

        # Run DBSCAN
        db = DBSCAN(eps=self.epsilon, min_samples=self.min_samples, metric='precomputed')
        labels = db.fit_predict(dist_matrix)

        # Check label of the newly added coordinate (last index)
        new_label = labels[-1]

        if new_label == -1:
            # Point is categorized as noise (no cluster formed)
            return {'confirmed': False}

        # Collect all points matching this cluster label
        cluster_indices = np.where(labels == new_label)[0]
        cluster_reports = []
        
        # Identify report IDs
        report_ids = []
        for idx in cluster_indices:
            if idx < len(all_reports):
                report_ids.append(all_reports[idx]['id'])
                cluster_reports.append(all_reports[idx])
            else:
                # Append the actual new report's ID
                report_ids.append(new_report_id)
                cluster_reports.append({'lat': new_lat, 'lng': new_lng, 'severity': new_severity})

        # Weighted Centroid calculation (Sensor Fusion centroid optimization)
        # Higher confidence, higher severity, and stable vehicles (Cars) get higher weight
        total_weight = 0.0
        weighted_lat = 0.0
        weighted_lng = 0.0
        
        for r in cluster_reports:
            weight = float(r.get('confidence', 0.5) or 0.5)
            
            # Stable vehicles get 2x weight because bikes swerve around potholes
            dev_id = str(r.get('device_id', '')).lower()
            is_car = r.get('vehicle_type', 'Bike') == 'Car' or 'car' in dev_id or 'suv' in dev_id or 'sedan' in dev_id
            if is_car:
                weight *= 2.0
                
            # Severity weighting
            sev = r.get('severity', 'medium')
            if sev == 'high':
                weight *= 1.5
            elif sev == 'low':
                weight *= 0.7
                
            weighted_lat += r['lat'] * weight
            weighted_lng += r['lng'] * weight
            total_weight += weight
            
        if total_weight > 0:
            centroid_lat = float(weighted_lat / total_weight)
            centroid_lng = float(weighted_lng / total_weight)
        else:
            centroid_lat = float(np.mean([r['lat'] for r in cluster_reports]))
            centroid_lng = float(np.mean([r['lng'] for r in cluster_reports]))

        # Count frequencies of severity ratings in the cluster
        severities = [r.get('severity', 'low') for r in cluster_reports if 'severity' in r]
        if not severities:
            severities = ['low']
        
        # Majority voting for severity
        severity = max(set(severities), key=severities.count)

        return {
            'confirmed': True,
            'centroid_lat': centroid_lat,
            'centroid_lng': centroid_lng,
            'count': len(cluster_reports),
            'severity': severity,
            'report_ids': report_ids
        }
