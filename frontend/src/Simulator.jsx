import React, { useState, useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sky, Html, Box, Plane, Line } from '@react-three/drei';
import { io } from 'socket.io-client';
import * as THREE from 'three';
import './Simulator.css';

const BACKEND_URL = 'http://127.0.0.1:5000';

// A scrolling road marking to simulate movement
function MovingRoad() {
    const materialRef = useRef();
    useFrame((state, delta) => {
        if (materialRef.current) {
            // Move texture offset to simulate speed
            materialRef.current.dashOffset -= delta * 10;
        }
    });
    return (
        <Line points={[[0, 0.05, -500], [0, 0.05, 500]]} color="white" lineWidth={5} dashed dashScale={50} dashSize={5} dashRatio={0.5}>
            <lineDashedMaterial ref={materialRef} color="white" dashSize={5} gapSize={5} />
        </Line>
    );
}

function Vehicle({ position, color, isScout, zVarianceRef, alertData, patched }) {
    const meshRef = useRef();
    const basePosition = new THREE.Vector3(...position);
    
    useFrame((state, delta) => {
        if (!meshRef.current) return;
        
        if (isScout) {
            // Simulate suspension bounce driven by Z-axis variance telemetry
            // If zVariance is high, we shake heavily
            const bounce = zVarianceRef.current > 0 ? Math.sin(state.clock.elapsedTime * 30) * (zVarianceRef.current * 0.15) : 0;
            meshRef.current.position.y = basePosition.y + bounce;
            
            // Add slight pitch forward/backward
            meshRef.current.rotation.x = zVarianceRef.current > 0 ? Math.sin(state.clock.elapsedTime * 20) * 0.2 : 0;
        } else {
            // Follower car is smooth unless it hits it too
            meshRef.current.position.y = basePosition.y;
        }
    });

    return (
        <group ref={meshRef} position={position}>
            {/* Simple Boxy Car Model */}
            <Box args={[1.8, 1, 4]} castShadow>
                <meshStandardMaterial color={color} />
            </Box>
            <Box args={[1.6, 0.8, 2]} position={[0, 0.9, -0.2]} castShadow>
                <meshStandardMaterial color="#7f8fa6" />
            </Box>

            {/* V2V Alert Hologram (for Follower) */}
            {!isScout && alertData && (
                <Html position={[0, 3, 0]} center zIndexRange={[100, 0]}>
                    <div className="v2v-hologram">
                        {patched ? '✅ ROAD PATCHED' : `⚠️ POTHOLE AHEAD (${alertData.severity})`}
                    </div>
                </Html>
            )}
            
            {/* Label */}
            <Html position={[0, 2, 0]} center>
                <div className="vehicle-label3d">{isScout ? "Scout" : "Follower"}</div>
            </Html>
        </group>
    );
}

function CinematicEnvironment({ potholeZ, setPotholeZ }) {
    useFrame((state, delta) => {
        // Move pothole towards camera
        if (potholeZ > -100 && potholeZ < 50) {
            setPotholeZ(potholeZ + delta * 25); // Speed of 25 units/sec
        }
    });

    return (
        <>
            <Sky distance={450000} sunPosition={[0, 1, 0]} inclination={0} azimuth={0.25} />
            <ambientLight intensity={0.6} />
            <directionalLight castShadow position={[10, 20, 10]} intensity={1.5} />
            
            {/* The Road */}
            <Plane args={[15, 1000]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <meshStandardMaterial color="#2f3542" />
            </Plane>
            
            <MovingRoad />
            
            {/* Pothole Mesh */}
            <mesh position={[0, 0.01, potholeZ]} rotation={[-Math.PI/2, 0, 0]}>
                <circleGeometry args={[1.5, 32]} />
                <meshBasicMaterial color="#1e272e" />
            </mesh>
        </>
    );
}

export default function Simulator() {
    const [socket, setSocket] = useState(null);
    const [potholeData, setPotholeData] = useState(null);
    const [patched, setPatched] = useState(false);
    
    // Telemetry Refs for high-speed useFrame
    const zVarianceRef = useRef(0.0);
    const [v1Comfort, setV1Comfort] = useState(100);
    const [simSpeed, setSimSpeed] = useState(10.0);
    const [jerk, setJerk] = useState(0.0);
    
    // Cinematic state
    const [potholeZ, setPotholeZ] = useState(-100);
    const [mapMarkers, setMapMarkers] = useState([]); // [{id, y}]

    useEffect(() => {
        const newSocket = io(BACKEND_URL);
        setSocket(newSocket);

        newSocket.on('location_update', (data) => {
            // Real ROS2 data sync disabled during cinematic to avoid conflict, 
            // but left here for real architecture.
        });

        newSocket.on('pothole_alert', (data) => {
            console.log("V2 received pothole alert!", data);
            setPotholeData(data);
            
            // Mark on minimap
            setMapMarkers(prev => [...prev, { id: Date.now(), top: '40%', color: '#ff4757' }]);
        });

        newSocket.on('pothole_patched', (data) => {
            setPatched(true);
            setPotholeData(data);
            
            // Mark patch on minimap
            setMapMarkers(prev => [...prev, { id: Date.now(), top: '40%', color: '#2ed573' }]);
            setTimeout(() => setPotholeData(null), 4000);
        });

        return () => newSocket.close();
    }, []);

    // Cinematic Check
    useEffect(() => {
        // Scout is at Z=0. If Pothole crosses Z=0, trigger Hit!
        if (potholeZ > -1.0 && potholeZ < 1.0 && zVarianceRef.current === 0.0) {
            triggerPotholeHit();
        }
    }, [potholeZ]);

    const triggerPotholeHit = async () => {
        // 1. Violent Bounce and Jerk
        zVarianceRef.current = 12.5; 
        setV1Comfort(25);
        setJerk(145.2); // Simulated jerk m/s^3
        
        // 2. Post to Backend (MCMC/DBSCAN triggers alert)
        try {
            await fetch(`${BACKEND_URL}/api/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    lat: 27.7172, lng: 85.3240, speed: 10.0, timestamp: Date.now(),
                    samples: { svm: [], x: [], y: [], z: [], z_variance: 12.5 },
                    vehicle_class: "Simulated Scout"
                }])
            });
        } catch (e) { }
        
        // 3. Settle Down
        setTimeout(() => { 
            zVarianceRef.current = 0.0; 
            setV1Comfort(98); 
            setJerk(1.2);
        }, 800);
    };

    const runCinematicSimulation = () => {
        // Reset and spawn pothole far ahead
        setPotholeData(null);
        setPatched(false);
        setPotholeZ(-80); // Distance
    };

    const runCinematicPatch = async () => {
        // Spawn pothole
        setPotholeZ(-80);
        
        setTimeout(async () => {
            // We do a smooth pass
            try {
                await fetch(`${BACKEND_URL}/api/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify([
                        { lat: 27.7172, lng: 85.3240, speed: 12.0, timestamp: Date.now(), samples: { svm: [], x: [], y: [], z: [], z_variance: 0.1 }, vehicle_class: "Simulated Patch Verifier" },
                        { lat: 27.7172, lng: 85.3240, speed: 12.0, timestamp: Date.now()+1000, samples: { svm: [], x: [], y: [], z: [], z_variance: 0.1 }, vehicle_class: "Simulated Patch Verifier" },
                        { lat: 27.7172, lng: 85.3240, speed: 12.0, timestamp: Date.now()+2000, samples: { svm: [], x: [], y: [], z: [], z_variance: 0.1 }, vehicle_class: "Simulated Patch Verifier" }
                    ])
                });
            } catch (e) { }
        }, 1500);
    };

    return (
        <div className="simulator-container">
            <div className="simulator-header">
                <h1>3D ROS2 PyChrono Simulator</h1>
                <p>Watch the Scout hit the pothole, triggering the V2V alert for the Follower.</p>
                <div className="sim-controls">
                    <button onClick={runCinematicSimulation}>Play Encounter Sequence</button>
                    <button onClick={runCinematicPatch}>Simulate Patch (3 Passes)</button>
                </div>
            </div>

            <div className="simulator-main">
                <div className="road-view 3d-view">
                    
                    {/* UI OVERLAYS inside road-view */}
                    <div className="overlay-minimap">
                        <h4>Virtual Map</h4>
                        <div className="minimap-track">
                            <div className="minimap-scout"></div>
                            <div className="minimap-follower"></div>
                            {mapMarkers.map(m => (
                                <div key={m.id} className="minimap-pothole" style={{ top: m.top, backgroundColor: m.color }}></div>
                            ))}
                        </div>
                    </div>
                    
                    <div className="overlay-jerk">
                        <span className="jerk-label">Peak Jerk:</span>
                        <span className="jerk-value" style={{ color: jerk > 50 ? '#ff4757' : '#2ed573' }}>
                            {jerk.toFixed(1)} m/s³
                        </span>
                    </div>

                    <Canvas shadows camera={{ position: [12, 10, 20], fov: 45 }}>
                        <CinematicEnvironment potholeZ={potholeZ} setPotholeZ={setPotholeZ} />
                        
                        {/* Vehicle 1: Scout (Red) */}
                        <Vehicle 
                            position={[0, 0.5, 0]} 
                            color="#ff4757" 
                            isScout={true} 
                            zVarianceRef={zVarianceRef} 
                        />
                        
                        {/* Vehicle 2: Follower (Blue) trailing 12 units behind */}
                        <Vehicle 
                            position={[0, 0.5, 12]} 
                            color="#3742fa" 
                            isScout={false} 
                            alertData={potholeData}
                            patched={patched}
                        />
                    </Canvas>
                </div>

                <div className="dashboard-panel">
                    <h3>Scout Telemetry</h3>
                    <div className="metric-box">
                        <span className="label">Live Z-Variance</span>
                        <span className="value">{zVarianceRef.current.toFixed(2)} m/s²</span>
                    </div>
                    <div className="metric-box">
                        <span className="label">Comfort Score</span>
                        <span className="value">{v1Comfort.toFixed(0)} / 100</span>
                    </div>

                    {potholeData && (
                        <div className="backend-data-box">
                            <h3>V2V Database State</h3>
                            <p><strong>Status:</strong> {potholeData.status || (patched ? 'Patched' : 'Active')}</p>
                            <p><strong>Severity:</strong> {potholeData.severity}</p>
                            <p><strong>Smooth Passes:</strong> {potholeData.smooth_passes || 0} / 3</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
