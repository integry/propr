# GitFix Web UI Integration Guide

This document outlines how to integrate the React-based web UI with the GitFix backend.

## Overview

The GitFix Web Management UI is located in the `gitfix-ui/` directory. It's a React application built with Vite that provides a dashboard for monitoring and managing the GitFix system.

## Current Status

### Completed (Issue #46)
- ✅ React application initialized with Vite
- ✅ Project structure created with api/ and components/ directories
- ✅ Dashboard component with layout for status and stats
- ✅ SystemStatus component showing daemon, workers, Redis, and GitHub auth status
- ✅ TaskQueueStats component displaying queue metrics
- ✅ Mock API layer for development
- ✅ Basic styling and responsive design
- ✅ Auto-refresh functionality (5-second intervals)

## Backend API Requirements

To connect the frontend with the GitFix backend, the following API endpoints need to be implemented:

### 1. System Status Endpoint
```
GET /api/system/status
Response:
{
  "daemon": "Running" | "Stopped",
  "workers": [
    { "id": 1, "status": "active" | "idle" | "error" }
  ],
  "redis": "Connected" | "Disconnected", 
  "githubAuth": "Authenticated" | "Failed"
}
```

### 2. Queue Statistics Endpoint
```
GET /api/queue/stats
Response:
{
  "active": number,
  "waiting": number,
  "completed": number,  // last 24 hours
  "failed": number
}
```

## Running the UI

### Development Mode
```bash
cd gitfix-ui
npm install
npm run dev
```
Access at: http://localhost:5173

### Production Build
```bash
cd gitfix-ui
npm run build
```
Static files will be in `gitfix-ui/dist/`

## Integration Steps

1. **Add Express Server**: Create an Express server in the main GitFix application to serve the API endpoints and the built React app.

2. **Implement API Endpoints**: Add routes to expose system status and queue statistics from the existing services.

3. **CORS Configuration**: Configure CORS if running the UI and backend on different ports during development.

4. **Update API Functions**: Replace mock functions in `gitfix-ui/src/api/gitfixApi.js` with actual HTTP requests.

5. **Authentication**: Add authentication middleware to protect the API endpoints and UI access.

## Future Enhancements

The following features are planned for future issues:
- Real-time updates via WebSocket
- Activity feed showing recent operations
- Manual job submission interface
- Configuration management UI
- Detailed worker and job views
- Authentication and role-based access control

## Technical Notes

- The UI uses polling (5-second intervals) for updates. This can be replaced with WebSocket for real-time updates.
- Mock data includes randomization to simulate live changes during development.
- The UI is built as a static SPA and can be served from any web server or CDN.
- All API calls are centralized in `gitfixApi.js` for easy maintenance.