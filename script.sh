#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $BACKEND_PID $FRONTEND_PID $MOBILE_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID $MOBILE_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "=== Starting Khalto ==="

# Backend
cd "$ROOT/backend"
.venv/bin/python app.py &
BACKEND_PID=$!
echo "  Backend  (PID $BACKEND_PID)  → http://127.0.0.1:5000"

# Frontend
cd "$ROOT/frontend"
npx vite --host &
FRONTEND_PID=$!
echo "  Frontend (PID $FRONTEND_PID) → http://127.0.0.1:5173"

# Mobile
cd "$ROOT/mobile-client"
npx expo start &
MOBILE_PID=$!
echo "  Mobile   (PID $MOBILE_PID)  → expo://"

echo ""
echo "Press Ctrl+C to stop all."
wait
