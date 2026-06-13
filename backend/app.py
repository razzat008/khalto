from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import json
import logging
import queue
from flask_socketio import SocketIO, emit

sse_listeners = []
active_locations = {}

from db import Database
from detector import PotholeDetector
from clustering import SpatialClusterer
from mcmc import MCMCChangePointDetector
from calibration import CalibrationManager

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("KhaltoServer")

import os
backend_dir = os.path.dirname(os.path.abspath(__file__))
db_path = os.path.join(backend_dir, "roadsense.db")

db = Database(db_path)
db.init() # Ensure DB tables are initialized regardless of how Flask is run

clusterer = SpatialClusterer(epsilon_meters=15.0, min_samples=1)
mcmc_detector = MCMCChangePointDetector()
calibration = CalibrationManager(db_path)

# Cache detectors per device
detectors = {}

def get_detector(device_id: str) -> PotholeDetector:
    if device_id not in detectors:
        thresholds = calibration.get_thresholds(device_id)
        detectors[device_id] = PotholeDetector(
            threshold_vertical=thresholds['vertical'],
            threshold_lateral=thresholds['lateral']
        )
    return detectors[device_id]

import urllib.request
import urllib.parse
import datetime

def check_google_traffic(lat: float, lng: float) -> bool:
    """
    Queries Google Directions API to check for traffic congestion around coordinates.
    Returns True if heavy traffic is detected, False otherwise.
    Falls back to a peak-hours/time-based simulation if GOOGLE_MAPS_API_KEY is not set.
    """
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not api_key:
        # Simulation fallback: assume heavy traffic during peak hours (8-10 AM, 5-7 PM)
        # or if the coordinates are in a deterministic simulated traffic zone
        hour = datetime.datetime.now().hour
        is_peak = (8 <= hour <= 10) or (17 <= hour <= 19)
        # Deterministic simulation: even values of lat/lng thousandths digit represent heavy traffic
        coord_val = int(abs(lat) * 1000) + int(abs(lng) * 1000)
        return is_peak or (coord_val % 2 == 0)

    url = "https://maps.googleapis.com/maps/api/directions/json"
    params = {
        "origin": f"{lat},{lng}",
        "destination": f"{lat + 0.002},{lng + 0.002}",
        "departure_time": "now",
        "key": api_key
    }
    try:
        query_string = urllib.parse.urlencode(params)
        full_url = f"{url}?{query_string}"
        req = urllib.request.Request(full_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3.0) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                routes = data.get("routes", [])
                if routes:
                    leg = routes[0].get("legs", [])[0]
                    duration = leg.get("duration", {}).get("value", 1)
                    duration_in_traffic = leg.get("duration_in_traffic", {}).get("value", duration)
                    return duration_in_traffic > duration * 1.25
    except Exception as e:
        logger.error(f"Error checking traffic from Google Maps API: {e}")
    return False

def get_road_metadata(lat: float, lng: float) -> tuple:
    """
    Simulates reverse geocoding to return (road_name, contractor, road_creation_date)
    for roads in Kathmandu based on coordinate bounding boxes.
    """
    # Kathmandu Ring Road (approx)
    if (27.67 <= lat <= 27.69) or (27.73 <= lat <= 27.75) or (85.34 <= lng <= 85.36):
        return "Ring Road", "Kalika Construction Ltd.", "2018-04-12"
    elif (27.71 <= lat <= 27.72) and (85.31 <= lng <= 85.33):
        return "Kanti Path", "Tundi Construction Ltd.", "2021-09-15"
    elif (27.70 <= lat <= 27.71) and (85.31 <= lng <= 85.32):
        return "Durbar Marg", "Lama Construction", "2022-11-20"
    elif (27.67 <= lat <= 27.68) and (85.31 <= lng <= 85.32):
        return "Pulchowk Road", "Raman Construction", "2019-06-08"
    else:
        h = int(abs(lat * 1000) + abs(lng * 1000))
        roads = ["Prithvi Highway", "Arniko Highway", "Bishnumati Link Road", "Baneshwor Marg", "Tripureshwor Marg"]
        contractors = ["CE Construction Pvt. Ltd.", "Ashish Construction", "Bajra Guru Construction", "Tundi Construction Ltd."]
        dates = ["2015-05-10", "2017-08-22", "2020-03-14", "2023-01-30", "2016-12-05"]
        return roads[h % len(roads)], contractors[h % len(contractors)], dates[h % len(dates)]

from itsdangerous import URLSafeTimedSerializer
serializer = URLSafeTimedSerializer("roadsense_secret_salt_12345")

ADJECTIVES = ["Swift", "Silent", "Bold", "Sleek", "Stealthy", "Vibrant", "Nimble", "Robust"]
VEHICLES = ["Rider", "Cruiser", "Explorer", "Navigator", "Tracker", "Patroller"]

def get_friendly_name(device_id: str) -> str:
    if not device_id:
        return "Guest Device"
    h = int(hashlib.md5(device_id.encode('utf-8')).hexdigest(), 16)
    adj = ADJECTIVES[h % len(ADJECTIVES)]
    veh = VEHICLES[(h // len(ADJECTIVES)) % len(VEHICLES)]
    suffix = hex(h % 0xffff)[2:].upper().zfill(4)
    return f"{adj} {veh} ({suffix})"

def authenticate_request() -> tuple:
    """
    Authenticates requests using Bearer token from Authorization or X-Authorization header,
    or from the 'token' query parameter (for SSE clients).
    Returns tuple of (username, device_id, friendly_name).
    Falls back to guest user credentials if no token is provided or parsing fails,
    ensuring unauthenticated connection does not fail.
    """
    token = None
    auth_header = request.headers.get("Authorization") or request.headers.get("X-Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1].strip()
    else:
        # Fallback to query parameter (e.g. for browser EventSource connections)
        token = request.args.get("token")

    if token:
        try:
            username = serializer.loads(token, max_age=86400 * 30) # Token valid for 30 days
            user = db.get_user(username)
            if user:
                device_id = user.get("device_id") or "unknown_device"
                friendly_name = get_friendly_name(device_id)
                return username, device_id, friendly_name
        except Exception:
            pass
            
    # Fallback to guest user
    return "guest", "guest_device", "Guest Rider"

import hashlib

def hash_password(password: str) -> str:
    salt = "roadsense_pwd_salt_54321"
    return hashlib.sha256((password + salt).encode('utf-8')).hexdigest()

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    device_id = data.get("device_id", "").strip() or "web_browser_client"

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    if db.get_user(username):
        return jsonify({"error": "Username is already taken"}), 400

    password_hash = hash_password(password)
    success = db.create_user(username, password_hash, device_id)
    if not success:
        return jsonify({"error": "Failed to create user account"}), 500

    token = serializer.dumps(username)
    friendly = get_friendly_name(device_id)
    return jsonify({
        "status": "success",
        "token": token,
        "username": username,
        "friendly_name": friendly
    }), 200

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    device_id = data.get("device_id", "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    user = db.get_user(username)
    if not user or user["password_hash"] != hash_password(password):
        return jsonify({"error": "Invalid username or password"}), 401

    if device_id:
        db.update_user_device(username, device_id)
        user["device_id"] = device_id

    token = serializer.dumps(username)
    friendly = get_friendly_name(user.get("device_id") or "web_browser_client")
    return jsonify({
        "status": "success",
        "token": token,
        "username": username,
        "friendly_name": friendly
    }), 200

@app.route('/api/auth/me', methods=['GET'])
def get_me():
    username, device_id, friendly_name = authenticate_request()
    if not username:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({
        "username": username,
        "device_id": device_id,
        "friendly_name": friendly_name
    }), 200

@socketio.on('connect')
def handle_connect():
    # Allow anonymous connects
    pass

@socketio.on('location_update')
def handle_location_update(data):
    """
    Receives location_update from the Python bridge and rebroadcasts it to all connected React clients.
    """
    # Maintain active_locations state so /api/locations endpoint still works
    try:
        rider = data.get("rider", {})
        rider_key = rider.get("rider_key")
        if rider_key:
            rider["updated_at"] = datetime.datetime.now().isoformat()
            active_locations[rider_key] = rider
    except Exception:
        pass
        
    socketio.emit('location_update', data, include_self=False)

@socketio.on('broadcast_alert')
def handle_broadcast_alert(data):
    """
    Receives alert from the simulation web client and rebroadcasts it to the connected mobile app.
    """
    socketio.emit('pothole_alert', data, include_self=False)

@app.route('/api/stream')
def sse_stream():
    # Deprecated fallback for backward compatibility
    return jsonify({"error": "Please connect via WebSockets"}), 400

@app.route('/')
def index_landing():
    return jsonify({
        "name": "Khalto API Server",
        "status": "online",
        "endpoints": {
            "/api/potholes": "GET - Retrieve verified potholes list",
            "/api/stats": "GET - Retrieve statistics",
            "/api/sync": "POST - Sync local SQLite database reports",
            "/api/reset": "POST - Reset database"
        }
    })

@app.route('/api/sync', methods=['POST'])
def sync_data():
    """
    Accepts sync batches from Android clients.
    Processes, classifies, aggregates, and runs MCMC change-point verification.
    """
    username, device_id, friendly_name = authenticate_request()
    if not username:
        return jsonify({"error": "Unauthorized: Missing device authentication token"}), 401

    payload = request.json
    if not isinstance(payload, list):
        return jsonify({"error": "Payload must be a list of telemetry events"}), 400

    new_potholes = []
    processed_count = 0

    for event in payload:
        try:
            lat = float(event['lat'])
            lng = float(event['lng'])
            speed = float(event.get('speed', 0.0))
            timestamp = int(event['timestamp'])

            # If device is a bike, and speed is extremely low, check traffic to avoid false-positives
            # We bypass this check if speed is exactly 0.0 (stationary testing/demo)
            is_bike = "motorcycle" in device_id or "rider" in device_id or "bike" in device_id
            if is_bike and 0.1 <= speed < 1.0:
                if check_google_traffic(lat, lng):
                    logger.info(f"Report from bike {device_id} at ({lat}, {lng}) skipped: traffic stop detected.")
                    continue
            
            # Extract samples (can be raw list or dictionary of multi-axis readings)
            samples_raw = event['samples']
            if isinstance(samples_raw, str):
                samples_data = json.loads(samples_raw)
            else:
                samples_data = samples_raw

            if isinstance(samples_data, dict):
                samples = samples_data.get('svm', [])
                x_samples = samples_data.get('x', [])
                y_samples = samples_data.get('y', [])
                z_samples = samples_data.get('z', [])
                z_variance = float(samples_data.get('z_variance', 0.0))
            else:
                samples = list(samples_data)
                x_samples, y_samples, z_samples = [], [], []
                z_variance = 0.0
                
            processed_count += 1

            # Calculate vehicle degradation
            # Off-road vehicles decay 5x slower (tolerance is higher)
            vehicle_class = event.get('vehicle_class', 'Standard Bike')
            is_off_road = "off-road" in vehicle_class.lower() or "offroad" in vehicle_class.lower()
            degradation_rate = 0.005 if is_off_road else 0.025
            degradation = z_variance * degradation_rate
            
            # Update health in active_locations if rider is active
            rider_key = f"{username}:{device_id}"
            if rider_key in active_locations:
                current_health = active_locations[rider_key].get("vehicle_health", 100.0)
                new_health = max(0.0, current_health - degradation)
                active_locations[rider_key]["vehicle_health"] = new_health
                logger.info(f"Vehicle degradation for {rider_key}: -{degradation:.2f}% (Health: {new_health:.2f}%)")
            
            # Step 1: Run Classifier
            detector_inst = get_detector(device_id)
            result = detector_inst.classify(vertical_samples=samples, lateral_samples=[])

            # Step 2: Calibrate suspension baselines
            calibration.update_baseline(device_id, {'samples': samples})
            # Evict from detector cache to pick up updated thresholds on next sync event
            detectors.pop(device_id, None)

            # Check if it's a smooth pass (confidence < 0.2)
            is_smooth_pass = result.confidence < 0.2
            if is_smooth_pass:
                result.is_pothole = False
            else:
                # For demo/test mode: ensure confident events are treated nicely
                result.is_pothole = True
                if result.severity == 'low':
                    result.severity = 'medium'

            # Determine road name, contractor, and road creation date
            road_name, contractor, creation_date = get_road_metadata(lat, lng)

            # Step 3: Insert raw candidate report
            report_id = db.insert_report(
                lat=lat,
                lng=lng,
                device_id=device_id,
                confidence=result.confidence,
                severity=result.severity,
                vertical_power=result.vertical_power,
                z_variance=z_variance,
                speed=speed,
                telemetry_json=json.dumps(samples_data) if isinstance(samples_data, dict) else None,
                username=username,
                friendly_name=friendly_name,
                timestamp=timestamp,
                anomaly_type=result.anomaly_type,
                depth_mm=result.depth_mm,
                area_cm2=result.area_cm2,
                urgency_score=result.urgency_score,
                road_name=road_name,
                contractor=contractor,
                road_creation_date=creation_date
            )

            # Step 4: Run DBSCAN Spatial Clusterer
            recent_reports = db.get_recent_reports(limit=500)
            # Exclude the current report from recent_reports to avoid double-counting in check_cluster
            existing_reports = [r for r in recent_reports if r['id'] != report_id]
            cluster = clusterer.check_cluster(lat, lng, existing_reports, report_id, result.severity)

            if cluster['confirmed']:
                # Step 5: Run MCMC change-point validation over reports in the spatial cluster
                cluster_reports = db.get_reports_by_ids(cluster['report_ids'])
                confidence_sequence = [r['confidence'] for r in cluster_reports]
                
                mcmc_result = mcmc_detector.detect_change_point(confidence_sequence)

                # Verify immediately if a single shock is detected (walking demo), or if MCMC change-point is satisfied
                if mcmc_result['change_detected'] or cluster['count'] >= 1:
                    # Step 6: Upsert to verified potholes list
                    pothole_confidence = max(mcmc_result['posterior_probability'], result.confidence)
                    pothole_id = db.upsert_verified_pothole(
                        lat=cluster['centroid_lat'],
                        lng=cluster['centroid_lng'],
                        report_count=cluster['count'],
                        severity=cluster['severity'],
                        mcmc_confidence=pothole_confidence,
                        anomaly_type=result.anomaly_type,
                        depth_mm=result.depth_mm,
                        area_cm2=result.area_cm2,
                        urgency_score=result.urgency_score,
                        road_name=road_name,
                        contractor=contractor,
                        road_creation_date=creation_date
                    )
                    pothole_obj = {
                        "id": pothole_id,
                        "lat": cluster['centroid_lat'],
                        "lng": cluster['centroid_lng'],
                        "severity": cluster['severity'],
                        "confidence": pothole_confidence,
                        "created_by": friendly_name,
                        "created_by_device": device_id,
                        "anomaly_type": result.anomaly_type,
                        "depth_mm": result.depth_mm,
                        "area_cm2": result.area_cm2,
                        "urgency_score": result.urgency_score,
                        "road_name": road_name,
                        "contractor": contractor,
                        "road_creation_date": creation_date
                    }
                    new_potholes.append(pothole_obj)
                    logger.info(f"Pothole confirmed at ({cluster['centroid_lat']}, {cluster['centroid_lng']})")

                    # Broadcast pothole alert instantly to other active devices via WebSockets
                    socketio.emit('pothole_alert', pothole_obj)
            
            # Step 7: Check for Smooth Pass / Patch Detection
            if is_smooth_pass:
                # Find any active pothole nearby
                all_potholes = db.get_all_potholes()
                for p in all_potholes:
                    if p['status'] == 'Active' and abs(p['lat'] - lat) < 0.00015 and abs(p['lng'] - lng) < 0.00015:
                        patch_info = db.register_smooth_pass(p['id'])
                        if patch_info:
                            logger.info(f"Smooth pass registered on pothole {p['id']}. Total passes: {patch_info['smooth_passes']}")
                            if patch_info['status'] == 'Patched':
                                logger.info(f"Pothole {p['id']} has been PATCHED!")
                                p['status'] = 'Patched'
                                p['smooth_passes'] = patch_info['smooth_passes']
                                socketio.emit('pothole_patched', p)
                        break

        except Exception as e:
            logger.error(f"Error processing synced event: {e}")
            continue

    # Notify listeners of general sync events
    socketio.emit('sync_event', {"data": "updated"})

    return jsonify({
        "status": "success",
        "processed_count": processed_count,
        "new_verified_potholes": new_potholes
    }), 200

@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    # Public endpoint
    potholes = db.get_all_potholes()
    return jsonify(potholes)

@app.route('/api/potholes/<int:pothole_id>/verify', methods=['POST'])
def verify_pothole(pothole_id):
    username, device_id, friendly_name = authenticate_request()
    if not username:
        return jsonify({"error": "Unauthorized"}), 401
    
    updated_pothole = db.verify_pothole(pothole_id)
    if updated_pothole:
        socketio.emit('sync_event', {"data": "verified_pothole"})
        return jsonify({"status": "success", "pothole": updated_pothole}), 200
    else:
        return jsonify({"error": "Pothole not found"}), 404

@app.route('/api/potholes/<int:pothole_id>/status', methods=['PATCH'])
def update_pothole_status(pothole_id):
    # Public endpoint or admin endpoint
    data = request.json or {}
    new_status = data.get('status')
    
    if not new_status:
        return jsonify({"error": "Status is required"}), 400
        
    updated_pothole = db.update_pothole_status(pothole_id, new_status)
    if updated_pothole:
        socketio.emit('sync_event', {"data": "status_updated"})
        return jsonify({"status": "success", "pothole": updated_pothole}), 200
    else:
        return jsonify({"error": "Invalid status or pothole not found"}), 400

@app.route('/api/stats', methods=['GET'])
def get_stats():
    # Public endpoint
    stats = db.get_stats()
    return jsonify(stats)

@app.route('/api/incidents', methods=['GET'])
def get_incidents():
    """
    Returns recent synced reports anonymously.
    Masks device_id with a hashed fingerprint and maps vehicle type.
    """
    # Public endpoint
    import hashlib
    reports = db.get_recent_reports(limit=100)
    incidents = []
    for r in reports:
        rep_device_id = r.get('device_id', 'unknown')
        device_hash = hashlib.sha256(rep_device_id.encode('utf-8')).hexdigest()
        
        # Use the stored friendly name if available, otherwise fallback to fingerprint
        rep_friendly_name = r.get('friendly_name')
        if not rep_friendly_name:
            if 'sports_car' in rep_device_id or 'suv' in rep_device_id or 'sedan' in rep_device_id:
                rep_friendly_name = f"USER-{device_hash[:4].upper()}"
            else:
                rep_friendly_name = f"RIDER-{device_hash[:4].upper()}"
        
        if 'sports_car' in rep_device_id or 'suv' in rep_device_id or 'sedan' in rep_device_id:
            vehicle = 'Car'
        else:
            vehicle = 'Bike'

        incidents.append({
            "id": r['id'],
            "lat": r['lat'],
            "lng": r['lng'],
            "severity": r['severity'],
            "confidence": r['confidence'],
            "vertical_power": r['vertical_power'],
            "z_variance": r.get('z_variance', 0.0),
            "speed": r.get('speed', 0.0),
            "telemetry": r.get('telemetry_json'),
            "timestamp": r['timestamp'],
            "created_at": r['created_at'],
            "fingerprint": rep_friendly_name,
            "vehicle_type": vehicle,
            "anomaly_type": r.get('anomaly_type', 'pothole'),
            "depth_mm": r.get('depth_mm', 0.0),
            "area_cm2": r.get('area_cm2', 0.0),
            "urgency_score": r.get('urgency_score', 0.0),
            "road_name": r.get('road_name'),
            "contractor": r.get('contractor'),
            "road_creation_date": r.get('road_creation_date')
        })
    return jsonify(incidents)

@app.route('/api/location', methods=['POST'])
def update_location():
    username, device_id, friendly_name = authenticate_request()
    # Accept anonymous guest posts smoothly
    if not username or username == 'guest':
        username, device_id, friendly_name = "guest", "guest_device", "Guest Rider"
    
    data = request.json or {}
    lat = data.get("lat")
    lng = data.get("lng")
    speed = data.get("speed", 0.0)
    vehicle_class = data.get("vehicle_class", "Standard Bike")
    
    if lat is None or lng is None:
        return jsonify({"error": "Invalid coordinates"}), 400
    
    if 'sports_car' in device_id or 'suv' in device_id or 'sedan' in device_id or 'web_browser' in device_id:
        vehicle = 'Car'
    else:
        vehicle = 'Bike'

    # Preserve health across updates
    current_health = 100.0
    rider_key = f"{username}:{device_id}"
    if rider_key in active_locations:
        current_health = active_locations[rider_key].get("vehicle_health", 100.0)

    active_locations[rider_key] = {
        "rider_key": rider_key,
        "username": username,
        "device_id": device_id,
        "friendly_name": friendly_name,
        "lat": float(lat),
        "lng": float(lng),
        "speed": float(speed),
        "vehicle_type": vehicle,
        "vehicle_class": vehicle_class,
        "vehicle_health": current_health,
        "telemetry": {
            "brake_intensity": data.get("brake_intensity", 0.0),
            "depth_mm": data.get("depth_mm", 0.0),
            "comfort_score": data.get("comfort_score", 100.0),
            "is_braking": data.get("is_braking", False),
            "is_shock": data.get("is_shock", False)
        },
        "updated_at": datetime.datetime.now().isoformat()
    }
    
    # Broadcast location update via WebSockets
    socketio.emit('location_update', {"rider": active_locations[rider_key]})
            
    return jsonify({"status": "success"}), 200

@app.route('/api/locations', methods=['GET'])
def get_locations():
    # Public endpoint
    now = datetime.datetime.now()
    active = []
    for user, info in list(active_locations.items()):
        updated_time = datetime.datetime.fromisoformat(info["updated_at"])
        if (now - updated_time).total_seconds() < 60:
            active.append(info)
            
    return jsonify(active)

@app.route('/api/leaderboard', methods=['GET'])
def get_leaderboard():
    # Public leaderboard
    try:
        with db.conn() as c:
            rows = c.execute(
                """SELECT username, friendly_name, COUNT(*) as reports_count
                   FROM reports
                   WHERE username IS NOT NULL AND username != 'guest'
                   GROUP BY username, friendly_name
                   ORDER BY reports_count DESC
                   LIMIT 10"""
            ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        logger.warning(f"Leaderboard query failed (migration pending?): {e}")
        return jsonify([])

@app.route('/api/reset', methods=['POST'])
def reset_database():
    """Resets the sqlite database tables (for testing purposes)."""
    username, device_id, friendly_name = authenticate_request()
    if not username:
        return jsonify({"error": "Unauthorized"}), 401
    try:
        with db.conn() as c:
            c.execute("DROP TABLE IF EXISTS reports")
            c.execute("DROP TABLE IF EXISTS verified_potholes")
            c.execute("DROP TABLE IF EXISTS calibration")
        db.init()

        socketio.emit('sync_event', {"data": "reset"})

        return jsonify({"status": "database reset successfully"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/potholes/manual', methods=['POST'])
def manual_add_pothole():
    """
    Manually report a pothole from the mobile app.
    Accepts lat, lng, severity, and optionally experienced (bool).
    """
    data = request.json or {}
    lat = data.get('lat')
    lng = data.get('lng')
    severity = data.get('severity', 'medium')

    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required"}), 400

    try:
        lat = float(lat)
        lng = float(lng)
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng must be numbers"}), 400

    try:
        road_name, contractor, creation_date = get_road_metadata(lat, lng)

        pothole_id = db.upsert_verified_pothole(
            lat=lat,
            lng=lng,
            report_count=1,
            severity=severity,
            mcmc_confidence=0.8,
            anomaly_type='pothole',
            road_name=road_name,
            contractor=contractor,
            road_creation_date=creation_date
        )

        with db.conn() as conn:
            conn.execute(
                "UPDATE verified_potholes SET status = 'Unverified' WHERE id = ?",
                (pothole_id,)
            )

        broadcast_pothole_update()
        return jsonify({"status": "success", "id": pothole_id}), 201

    except Exception as e:
        logger.error(f"manual_add_pothole error: {e}")
        return jsonify({"error": str(e)}), 500

import time
import random

@app.route('/api/satellite-scan', methods=['POST'])
def satellite_scan():
    """
    Simulates satellite imagery CV analysis for a given bounding box.
    Uses a deterministic seed derived from the bbox so the same area always
    produces the same potholes (realistic for testing & demos).
    """
    data = request.json or {}
    min_lat = data.get('minLat')
    max_lat = data.get('maxLat')
    min_lng = data.get('minLng')
    max_lng = data.get('maxLng')

    if min_lat is None or max_lat is None or min_lng is None or max_lng is None:
        return jsonify({"error": "Bounding box coordinates required (minLat, maxLat, minLng, maxLng)"}), 400

    try:
        min_lat = float(min_lat)
        max_lat = float(max_lat)
        min_lng = float(min_lng)
        max_lng = float(max_lng)
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"Invalid coordinates: {e}"}), 400

    logger.info(f"Satellite Vision Scan: ({min_lat},{min_lng}) -> ({max_lat},{max_lng})")

    # Deterministic seed from bbox so same area = same results
    seed = int(abs(min_lat * 1000) + abs(min_lng * 1000) + abs(max_lat * 100) + abs(max_lng * 100))
    rng = random.Random(seed)

    num_potholes = rng.randint(1, 3)
    detected = []

    for _ in range(num_potholes):
        plat = rng.uniform(min_lat, max_lat)
        plng = rng.uniform(min_lng, max_lng)
        severity = rng.choice(['low', 'medium', 'high'])

        road_name, contractor, creation_date = get_road_metadata(plat, plng)

        try:
            pothole_id = db.upsert_verified_pothole(
                lat=plat,
                lng=plng,
                report_count=0,
                severity=severity,
                mcmc_confidence=0.9,
                anomaly_type='pothole',
                road_name=road_name,
                contractor=contractor,
                road_creation_date=creation_date
            )

            # Mark as Unverified — needs human confirmation before routing avoids it
            with db.conn() as conn:
                conn.execute(
                    "UPDATE verified_potholes SET status = 'Unverified' WHERE id = ?",
                    (pothole_id,)
                )

            detected.append({"id": pothole_id, "lat": plat, "lng": plng, "severity": severity})
        except Exception as e:
            logger.error(f"Failed to insert satellite-detected pothole: {e}")

    broadcast_pothole_update()

    return jsonify({
        "status": "success",
        "message": f"Satellite CV scan complete. Detected {len(detected)} anomalies in viewport.",
        "detected": detected
    }), 200

@app.route('/api/demo/pothole', methods=['POST'])
def demo_add_pothole():
    """
    Demo Mode: Manually place a pothole at given coordinates.
    Inserts directly into verified_potholes and broadcasts via SSE
    so mobile clients get proximity alerts immediately.
    """
    data = request.json or {}
    lat = data.get('lat')
    lng = data.get('lng')
    severity = data.get('severity', 'medium')
    anomaly_type = data.get('anomaly_type', 'pothole')

    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required"}), 400

    road_name, contractor, creation_date = get_road_metadata(float(lat), float(lng))

    pothole_id = db.upsert_verified_pothole(
        lat=float(lat),
        lng=float(lng),
        report_count=1,
        severity=severity,
        mcmc_confidence=0.95,
        anomaly_type=anomaly_type,
        depth_mm=25.0,
        area_cm2=80.0,
        urgency_score=55.0 if severity == 'medium' else 80.0 if severity == 'high' else 25.0,
        road_name=road_name,
        contractor=contractor,
        road_creation_date=creation_date
    )

    pothole_obj = {
        "id": pothole_id,
        "lat": float(lat),
        "lng": float(lng),
        "severity": severity,
        "confidence": 0.95,
        "created_by": "Demo Mode",
        "anomaly_type": anomaly_type,
        "depth_mm": 25.0,
        "area_cm2": 80.0,
        "urgency_score": 55.0,
        "road_name": road_name,
        "contractor": contractor,
        "road_creation_date": creation_date
    }

    # Broadcast to all listeners so mobile clients pick it up for proximity alerts
    socketio.emit('pothole_alert', pothole_obj)

    # Also broadcast a sync event so dashboards refresh
    socketio.emit('sync_event', {"data": "demo_pothole"})

    logger.info(f"Demo pothole placed at ({lat}, {lng}) severity={severity}")
    return jsonify({"status": "success", "pothole": pothole_obj}), 200

if __name__ == '__main__':
    db.init()
    logger.info("Initializing RoadSense server with WebSockets...")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)
