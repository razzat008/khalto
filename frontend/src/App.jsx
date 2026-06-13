import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MainMap from './MainMap';
import RoRDashboard from './RoRDashboard';
import Simulator from './Simulator';
import MapSimulation from './MapSimulation';
import AdminDashboard from './AdminDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainMap />} />
        <Route path="/rigsofrod" element={<RoRDashboard />} />
        <Route path="/simulator" element={<Simulator />} />
        <Route path="/map-simulation" element={<MapSimulation />} />
        <Route path="/admin" element={<AdminDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
