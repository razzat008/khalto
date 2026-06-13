import React, { useState, useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sky, Html, Plane, Line, CameraShake, Cylinder, Box } from '@react-three/drei';
import { io } from 'socket.io-client';
import * as THREE from 'three';
import './Simulator.css';

const BACKEND_URL = 'http://127.0.0.1:5000';

// 1. DYNAMIC SCENERY (Trees zooming past)
function Scenery() {
    const treesRef = useRef();
    const treeData = useRef(
        Array.from({ length: 40 }).map((_, i) => ({
            x: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 20),
            z: -200 + Math.random() * 400,
            scale: 0.5 + Math.random() * 1.5,
        }))
    );

    useFrame((state, delta) => {
        if (!treesRef.current) return;
        treesRef.current.children.forEach((tree, i) => {
            tree.position.z += delta * 25; // Speed of the game
            if (tree.position.z > 50) {
                tree.position.z -= 400; // recycle
            }
        });
    });

    return (
        <group ref={treesRef}>
            {treeData.current.map((data, i) => (
                <group key={i} position={[data.x, 0, data.z]} scale={data.scale}>
                    {/* Trunk */}
                    <Cylinder args={[0.2, 0.4, 2]} position={[0, 1, 0]} castShadow>
                        <meshStandardMaterial color="#5c4033" />
                    </Cylinder>
                    {/* Leaves */}
                    <Cylinder args={[0, 1.5, 3]} position={[0, 3, 0]} castShadow>
                        <meshStandardMaterial color="#228b22" />
                    </Cylinder>
                </group>
            ))}
        </group>
    );
}

function MovingRoad() {
    const materialRef = useRef();
    useFrame((state, delta) => {
        if (materialRef.current) materialRef.current.dashOffset -= delta * 15;
    });
    return (
        <Line points={[[0, 0.05, -500], [0, 0.05, 500]]} color="white" lineWidth={5} dashed dashScale={50} dashSize={5} dashRatio={0.5}>
            <lineDashedMaterial ref={materialRef} color="white" dashSize={5} gapSize={5} />
        </Line>
    );
}

// 2. DETAILED LOW-POLY CAR
function Vehicle({ position, color, isScout, zVarianceRef, alertData, patched }) {
    const meshRef = useRef();
    const basePosition = new THREE.Vector3(...position);
    
    useFrame((state, delta) => {
        if (!meshRef.current) return;
        
        if (isScout) {
            const bounce = zVarianceRef.current > 0 ? Math.sin(state.clock.elapsedTime * 40) * (zVarianceRef.current * 0.1) : 0;
            meshRef.current.position.y = basePosition.y + bounce;
            meshRef.current.rotation.x = zVarianceRef.current > 0 ? Math.sin(state.clock.elapsedTime * 25) * 0.1 : 0;
            meshRef.current.rotation.z = zVarianceRef.current > 0 ? Math.sin(state.clock.elapsedTime * 35) * 0.05 : 0;
        } else {
            meshRef.current.position.y = basePosition.y;
        }
    });

    return (
        <group ref={meshRef} position={position}>
            {/* Chassis Body */}
            <Box args={[2.2, 0.8, 4.5]} position={[0, 0.6, 0]} castShadow>
                <meshStandardMaterial color={color} roughness={0.3} metalness={0.6} />
            </Box>
            {/* Cabin */}
            <Box args={[1.8, 0.7, 2.5]} position={[0, 1.35, -0.2]} castShadow>
                <meshStandardMaterial color="#111" roughness={0.1} metalness={0.9} />
            </Box>
            
            {/* Wheels */}
            {[
                [-1.1, 0.4, 1.5], [1.1, 0.4, 1.5],
                [-1.1, 0.4, -1.5], [1.1, 0.4, -1.5]
            ].map((wp, i) => (
                <Cylinder key={i} args={[0.4, 0.4, 0.4, 16]} position={wp} rotation={[0, 0, Math.PI/2]} castShadow>
                    <meshStandardMaterial color="#2d3436" />
                </Cylinder>
            ))}

            {/* Headlights & Tail Lights */}
            <Box args={[0.4, 0.2, 0.1]} position={[-0.8, 0.7, -2.25]}>
                <meshBasicMaterial color="red" />
            </Box>
            <Box args={[0.4, 0.2, 0.1]} position={[0.8, 0.7, -2.25]}>
                <meshBasicMaterial color="red" />
            </Box>
            <Box args={[0.4, 0.2, 0.1]} position={[-0.8, 0.7, 2.25]}>
                <meshBasicMaterial color="#fff" />
            </Box>
            <Box args={[0.4, 0.2, 0.1]} position={[0.8, 0.7, 2.25]}>
                <meshBasicMaterial color="#fff" />
            </Box>

            {!isScout && alertData && (
                <Html position={[0, 4, 0]} center zIndexRange={[100, 0]}>
                    <div className="v2v-hologram">
                        {patched ? '✅ ROAD PATCHED' : `⚠️ POTHOLE AHEAD`}
                    </div>
                </Html>
            )}
            
            <Html position={[0, 2.5, 0]} center>
                <div className="vehicle-label3d">{isScout ? "SCOUT" : "FOLLOWER"}</div>
            </Html>
        </group>
    );
}

// 3. CINEMATIC ENVIRONMENT WITH CAMERA SHAKE
function CinematicEnvironment({ potholeZ, setPotholeZ, zVarianceRef }) {
    useFrame((state, delta) => {
        if (potholeZ >= -150 && potholeZ < 50) {
            setPotholeZ(potholeZ + delta * 35); // 35 units/sec
        }
    });

    return (
        <>
            {/* Camera Shake activates when zVariance is high */}
            <CameraShake 
                maxYaw={0.05} maxPitch={0.05} maxRoll={0.05} 
                yawFrequency={0.2} pitchFrequency={0.2} rollFrequency={0.2} 
                intensity={zVarianceRef.current > 0 ? 1 : 0} 
            />
            
            <Sky distance={450000} sunPosition={[5, 1, -10]} inclination={0.2} azimuth={0.25} />
            <ambientLight intensity={0.4} />
            <directionalLight castShadow position={[20, 30, 10]} intensity={2} shadow-mapSize={[1024, 1024]} />
            
            <Plane args={[24, 1000]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <meshStandardMaterial color="#2d3436" roughness={0.8} />
            </Plane>
            <MovingRoad />
            <Scenery />
            
            {/* Pothole Crater */}
            <group position={[0, 0.02, potholeZ]}>
                <mesh rotation={[-Math.PI/2, 0, 0]}>
                    <circleGeometry args={[2, 32]} />
                    <meshBasicMaterial color="#111" />
                </mesh>
                <mesh position={[0, 0, 0]} rotation={[-Math.PI/2, 0, 0]}>
                    <ringGeometry args={[1.8, 2.2, 32]} />
                    <meshBasicMaterial color="#333" />
                </mesh>
            </group>
        </>
    );
}

// 4. CARTOON CITY MAP SVG
function CartoonMap({ progress, potholeMarker, patched }) {
    // Progress is 0 to 1
    const pathRef = useRef(null);
    const [scoutPos, setScoutPos] = useState({ x: 50, y: 250 });
    const [followerPos, setFollowerPos] = useState({ x: 50, y: 280 });

    useEffect(() => {
        if (pathRef.current) {
            const length = pathRef.current.getTotalLength();
            // Scout is slightly ahead of Follower
            const sDist = Math.max(0, Math.min(length, progress * length));
            const fDist = Math.max(0, sDist - 30); // 30 units behind
            
            const sp = pathRef.current.getPointAtLength(sDist);
            const fp = pathRef.current.getPointAtLength(fDist);
            setScoutPos(sp);
            setFollowerPos(fp);
        }
    }, [progress]);

    return (
        <div className="overlay-cartoon-map">
            <svg viewBox="0 0 300 300" width="100%" height="100%">
                {/* Grass Background */}
                <rect width="300" height="300" fill="#a8e6cf" rx="15" />
                
                {/* City Blocks (Buildings) */}
                <rect x="20" y="20" width="60" height="60" fill="#dcdde1" rx="5" />
                <rect x="120" y="20" width="160" height="60" fill="#dcdde1" rx="5" />
                <rect x="20" y="120" width="60" height="60" fill="#dcdde1" rx="5" />
                <rect x="180" y="120" width="100" height="160" fill="#dcdde1" rx="5" />
                <rect x="20" y="220" width="60" height="60" fill="#dcdde1" rx="5" />

                {/* Cartoon Road Path */}
                <path 
                    ref={pathRef}
                    d="M 50 300 L 50 150 C 50 100, 150 150, 150 100 L 150 0" 
                    fill="none" 
                    stroke="#7f8fa6" 
                    strokeWidth="30" 
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path 
                    d="M 50 300 L 50 150 C 50 100, 150 150, 150 100 L 150 0" 
                    fill="none" 
                    stroke="#f5f6fa" 
                    strokeWidth="4" 
                    strokeDasharray="10 10" 
                />

                {/* Vehicles */}
                <circle cx={followerPos.x} cy={followerPos.y} r="8" fill="#3742fa" stroke="white" strokeWidth="2" />
                <circle cx={scoutPos.x} cy={scoutPos.y} r="8" fill="#ff4757" stroke="white" strokeWidth="2" />

                {/* Pothole Marker */}
                {potholeMarker && (
                    <g transform={`translate(${potholeMarker.x}, ${potholeMarker.y})`}>
                        {patched ? (
                            <text x="-12" y="8" fontSize="24">🩹</text>
                        ) : (
                            <>
                                <circle cx="0" cy="0" r="14" fill="#ff4757" />
                                <text x="-8" y="6" fontSize="18" fill="white" fontWeight="bold">!</text>
                            </>
                        )}
                    </g>
                )}
            </svg>
        </div>
    );
}

export default function Simulator() {
    const [socket, setSocket] = useState(null);
    const [potholeData, setPotholeData] = useState(null);
    const [patched, setPatched] = useState(false);
    
    const zVarianceRef = useRef(0.0);
    const [v1Comfort, setV1Comfort] = useState(100);
    const [jerk, setJerk] = useState(0.0);
    
    const [potholeZ, setPotholeZ] = useState(50); // Offscreen positive
    const [mapProgress, setMapProgress] = useState(0.1);
    const [potholeMarker, setPotholeMarker] = useState(null);

    useEffect(() => {
        const newSocket = io(BACKEND_URL);
        setSocket(newSocket);

        newSocket.on('pothole_alert', (data) => {
            setPotholeData(data);
        });

        newSocket.on('pothole_patched', (data) => {
            setPatched(true);
            setPotholeData(data);
            setTimeout(() => setPotholeData(null), 4000);
        });

        return () => newSocket.close();
    }, []);

    // Cinematic Engine Tick
    useEffect(() => {
        let animationFrame;
        const tick = () => {
            if (potholeZ > -150 && potholeZ < 50) {
                // Map progress is tied to pothole moving towards Scout.
                // Total cinematic span: starts at -150, hits scout at 0.
                // Let's just linearly increase map progress when cinematic is active
                setMapProgress(prev => Math.min(0.9, prev + 0.003));
            }
            animationFrame = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(animationFrame);
    }, [potholeZ]);

    // Hit Detection
    useEffect(() => {
        if (potholeZ > -1.0 && potholeZ < 1.0 && zVarianceRef.current === 0.0) {
            triggerPotholeHit();
        }
    }, [potholeZ]);

    const triggerPotholeHit = async () => {
        zVarianceRef.current = 25.5; // Big impact!
        setV1Comfort(15);
        setJerk(285.4);
        
        // Stamp map
        // To find exact SVG coordinate, we guess based on mapProgress.
        // Approx coordinates for the curve middle:
        setPotholeMarker({ x: 90, y: 125 });

        try {
            await fetch(`${BACKEND_URL}/api/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    lat: 27.7172, lng: 85.3240, speed: 10.0, timestamp: Date.now(),
                    samples: { svm: [], x: [], y: [], z: [], z_variance: 25.5 },
                    vehicle_class: "Simulated Scout"
                }])
            });
        } catch (e) { }
        
        setTimeout(() => { 
            zVarianceRef.current = 0.0; 
            setV1Comfort(98); 
            setJerk(1.2);
        }, 1200);
    };

    const runCinematicSimulation = () => {
        setPotholeData(null);
        setPatched(false);
        setPotholeMarker(null);
        setMapProgress(0.1); // reset map
        setPotholeZ(-150); // spawn far away
    };

    const runCinematicPatch = async () => {
        setPotholeZ(-150);
        setMapProgress(0.1);
        
        setTimeout(async () => {
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
        }, 3000);
    };

    return (
        <div className="simulator-container game-ui">
            <div className="simulator-header">
                <h1>Khalto: The Game</h1>
                <p>Full 3D V2V Simulation with physics-based camera shake and low-poly graphics.</p>
                <div className="sim-controls">
                    <button onClick={runCinematicSimulation} className="btn-primary">PLAY ENCOUNTER</button>
                    <button onClick={runCinematicPatch} className="btn-secondary">SIMULATE PATCH</button>
                </div>
            </div>

            <div className="simulator-main">
                <div className="road-view 3d-view">
                    
                    {/* NEW CARTOON MAP */}
                    <CartoonMap progress={mapProgress} potholeMarker={potholeMarker} patched={patched} />
                    
                    {/* HUD JERK METER */}
                    <div className="hud-jerk">
                        <span>IMPACT JERK</span>
                        <div className="jerk-value" style={{ color: jerk > 100 ? '#ff4757' : '#2ed573' }}>
                            {jerk.toFixed(1)} <small>m/s³</small>
                        </div>
                    </div>

                    <Canvas shadows camera={{ position: [14, 12, 22], fov: 50 }}>
                        <CinematicEnvironment potholeZ={potholeZ} setPotholeZ={setPotholeZ} zVarianceRef={zVarianceRef} />
                        
                        <Vehicle position={[0, 0, 0]} color="#ff4757" isScout={true} zVarianceRef={zVarianceRef} />
                        <Vehicle position={[0, 0, 16]} color="#3742fa" isScout={false} alertData={potholeData} patched={patched} />
                    </Canvas>
                </div>

                <div className="dashboard-panel futuristic-panel">
                    <h3>LIVE TELEMETRY</h3>
                    <div className="metric-box">
                        <span className="label">Z-VARIANCE</span>
                        <span className="value">{zVarianceRef.current.toFixed(2)}</span>
                    </div>
                    <div className="metric-box">
                        <span className="label">COMFORT SCORE</span>
                        <span className="value">{v1Comfort.toFixed(0)}</span>
                    </div>

                    {potholeData && (
                        <div className="backend-data-box">
                            <h3>V2V NETWORK</h3>
                            <p><strong>STATUS:</strong> {potholeData.status || (patched ? 'PATCHED' : 'ACTIVE')}</p>
                            <p><strong>SEVERITY:</strong> {potholeData.severity}</p>
                            <p><strong>SMOOTH PASSES:</strong> {potholeData.smooth_passes || 0}/3</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
