#!/usr/bin/env python3
import socket
import struct
import time
import requests
import json
import math
import socketio
from collections import deque

# --- CONFIGURATION ---
ROR_IP = "0.0.0.0"
ROR_PORT = 4444  # Standard Rigs of Rods OutGauge Port
KHALTO_API_BASE = "http://127.0.0.1:5000/api"

# Base coordinate in Kathmandu to map the simulation to
BASE_LAT = 27.7172
BASE_LNG = 85.3240

# --- OUTGAUGE PROTOCOL DEFINITION ---
# Struct format from Rigs of Rods/LFS OutGauge documentation
# unsigned time
# char car[4]
# unsigned short flags
# char gear
# char plid
# float speed (m/s)
# float rpm
# float turbo
# float engTemp
# float fuel
# float oilPressure
# float dashLights
# float showLights
# float throttle
# float brake
# float clutch
# char display1[16]
# char display2[16]
# int id
OUTGAUGE_PACKET_FORMAT = 'I 4s H c c f f f f f f I I f f f 16s 16s i'

class RoRBridge:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((ROR_IP, ROR_PORT))
        print(f"[*] Listening for Rigs of Rods OutGauge UDP telemetry on {ROR_IP}:{ROR_PORT}...")
        
        self.last_sync_time = 0
        self.last_loc_update_time = 0
        
        self.speed_history = deque(maxlen=10)
        self.rpm_history = deque(maxlen=10)

        # To fake movement on the map, we integrate speed into a heading.
        self.sim_heading_rad = 0.0 # Start facing East
        self.current_lat = BASE_LAT
        self.current_lng = BASE_LNG
        self.token = None
        
        self.sio = socketio.Client()
        try:
            self.sio.connect('http://127.0.0.1:5000')
            print("[+] WebSocket connected to backend")
        except Exception as e:
            print(f"[-] WebSocket connection failed: {e}")

    def login(self):
        print("[*] Logging into Khalto Backend...")
        try:
            res = requests.post(f"{KHALTO_API_BASE}/auth/login", json={
                "username": "ror_driver",
                "password": "password",
                "device_id": "ror_sim_01"
            })
            if res.status_code == 200:
                self.token = res.json()['token']
                print(f"[+] Login successful! Token acquired.")
            else:
                # Try to register
                res = requests.post(f"{KHALTO_API_BASE}/auth/register", json={
                    "username": "ror_driver",
                    "password": "password",
                    "device_id": "ror_sim_01"
                })
                self.token = res.json()['token']
                print(f"[+] Registration successful! Token acquired.")
        except Exception as e:
            print(f"[-] Auth failed: {e}. Will attempt guest mode.")
            self.token = None

    def get_headers(self):
        if self.token:
            return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        return {"Content-Type": "application/json"}

    def run(self):
        self.login()
        
        last_speed = 0.0
        comfort_score = 100.0
        
        while True:
            data, addr = self.sock.recvfrom(1024)
            if not data:
                continue

            try:
                # Unpack the struct
                unpacked = struct.unpack(OUTGAUGE_PACKET_FORMAT, data[:96])
                
                time_ms = unpacked[0]
                speed_ms = unpacked[5]
                rpm = unpacked[6]
                throttle = unpacked[13]
                brake = unpacked[14]
                
                self.speed_history.append(speed_ms)
                self.rpm_history.append(rpm)
                
                now = time.time()
                
                # FAKE MOVEMENT
                if speed_ms > 0.5:
                    if len(self.rpm_history) > 1:
                        rpm_delta = self.rpm_history[-1] - self.rpm_history[-2]
                        self.sim_heading_rad += (rpm_delta * 0.0001)
                    
                    dt = 0.02 
                    dist_m = speed_ms * dt
                    
                    delta_lat = (dist_m * math.cos(self.sim_heading_rad)) / 111111.0
                    delta_lng = (dist_m * math.sin(self.sim_heading_rad)) / (111111.0 * math.cos(self.current_lat * math.pi / 180.0))
                    
                    self.current_lat += delta_lat
                    self.current_lng += delta_lng

                # SHOCK DETECTION
                acceleration = (speed_ms - last_speed) / 0.02
                
                is_emergency_braking = (brake > 0.8 and acceleration < -10.0)
                is_shock = (acceleration < -15.0 and brake < 0.5)

                fake_variance = abs(acceleration) / 5.0 if is_shock else 0.0
                depth_mm = fake_variance * 14.5 if is_shock else 0.0
                
                # Comfort score logic
                if is_shock:
                    comfort_score = max(0.0, comfort_score - 25.0)
                elif is_emergency_braking:
                    comfort_score = max(0.0, comfort_score - 10.0)
                else:
                    comfort_score = min(100.0, comfort_score + 0.5) # slow recovery

                # LOCATION UPDATE (Every 0.2s = 5Hz) via WebSocket
                if now - self.last_loc_update_time > 0.2:
                    self.last_loc_update_time = now
                    rider_key = "ror_driver:ror_sim_01" if self.token else "guest:guest_device"
                    payload = {
                        "rider_key": rider_key,
                        "lat": self.current_lat,
                        "lng": self.current_lng,
                        "speed": speed_ms,
                        "vehicle_type": "Car",
                        "vehicle_class": "Off-Road SUV",
                        "telemetry": {
                            "brake_intensity": brake,
                            "depth_mm": depth_mm,
                            "comfort_score": comfort_score,
                            "is_braking": is_emergency_braking,
                            "is_shock": is_shock
                        }
                    }
                    try:
                        self.sio.emit('location_update', {"rider": payload})
                    except Exception as e:
                        pass

                if is_shock and (now - self.last_sync_time > 2.0):
                    print(f"[!] SHOCK DETECTED! Accel: {acceleration:.1f} m/s^2. Sending to backend...")
                    self.last_sync_time = now
                    
                    payload = [{
                        "lat": self.current_lat,
                        "lng": self.current_lng,
                        "speedMs": speed_ms,
                        "verticalPower": 1500.0,
                        "rawSamplesJson": json.dumps({
                            "svm": [1.0] * 50,
                            "x": [0.0] * 50,
                            "y": [0.0] * 50,
                            "z": [9.81 + (fake_variance * 9.81)] * 50,
                            "gyro": [0.0] * 50,
                            "z_variance": fake_variance * 96.2,
                            "speed": speed_ms
                        }),
                        "timestamp": int(now * 1000)
                    }]
                    
                    try:
                        requests.post(f"{KHALTO_API_BASE}/sync", headers=self.get_headers(), json=payload, timeout=2.0)
                        print(f"    -> Synced pothole at {self.current_lat:.5f}, {self.current_lng:.5f}")
                    except Exception as e:
                        print(f"    -> Sync failed: {e}")

                last_speed = speed_ms

            except Exception as e:
                print(f"[-] Error processing packet: {e}")

if __name__ == "__main__":
    bridge = RoRBridge()
    bridge.run()
