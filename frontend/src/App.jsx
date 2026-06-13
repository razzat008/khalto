import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MainMap from './MainMap';
import RoRDashboard from './RoRDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainMap />} />
        <Route path="/rigsofrod" element={<RoRDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
