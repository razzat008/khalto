import socket
import struct
import time
import math

# I 4s H c c f f f f f f I I f f f 16s 16s i
OUTGAUGE_PACKET_FORMAT = 'I 4s H c c f f f f f f I I f f f 16s 16s i'

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
target = ("127.0.0.1", 4444)

print("Starting Fake Rigs of Rods Telemetry Stream...")
speed = 0.0
brake = 0.0
time_val = 0

try:
    while True:
        # Simulate accelerating, then sudden braking (pothole/shock)
        if time_val % 100 < 80:
            speed += 0.5  # Accelerate
            brake = 0.0
        else:
            speed = max(0.0, speed - 5.0)  # Sudden brake
            brake = 1.0

        pack = struct.pack(OUTGAUGE_PACKET_FORMAT,
            time_val,            # time
            b'CAR ',             # car
            0,                   # flags
            b'1',                # gear
            b'0',                # plid
            speed,               # speed
            3000.0 + speed * 10, # rpm
            0.0,                 # turbo
            90.0,                # engTemp
            0.5,                 # fuel
            4.0,                 # oilPressure
            0,                   # dashLights
            0,                   # showLights
            1.0 - brake,         # throttle
            brake,               # brake
            0.0,                 # clutch
            b'Display1',         # display1
            b'Display2',         # display2
            0                    # id
        )
        
        sock.sendto(pack, target)
        time_val += 1
        time.sleep(0.02) # 50Hz
except KeyboardInterrupt:
    print("Stopped.")
