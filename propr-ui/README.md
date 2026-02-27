# ProPR Management UI

A web-based management interface for monitoring and managing the ProPR application. This React-based dashboard provides real-time visibility into system status, worker health, and task queue metrics.

## Features

- **System Status Monitoring**: Real-time status of daemon, workers, Redis connection, and GitHub authentication
- **Task Queue Statistics**: Active, waiting, completed, and failed job counts
- **Auto-refresh**: Dashboard updates every 5 seconds
- **Responsive Design**: Works on desktop and mobile devices

## Project Structure

```
propr-ui/
├── src/
│   ├── api/              # API integration layer
│   │   └── proprApi.ts   # Core API functions
│   ├── components/       # React components
│   │   ├── Dashboard.jsx
│   │   ├── SystemStatus.jsx
│   │   └── TaskQueueStats.jsx
│   ├── App.jsx          # Main application component
│   ├── App.css          # Application styles
│   ├── index.css        # Global styles
│   └── main.jsx         # Application entry point
├── public/              # Static assets
├── package.json         # Dependencies and scripts
└── vite.config.js      # Vite configuration
```

## Development

### Prerequisites

- Node.js 16+ 
- npm or yarn

### Installation

```bash
cd propr-ui
npm install
```

### Running the Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:5173`

### Building for Production

```bash
npm run build
```

The production build will be created in the `dist/` directory.

### Preview Production Build

```bash
npm run preview
```

## API Integration

Currently, the application uses mock data to simulate the backend API. The API functions are located in `src/api/proprApi.ts`.

### Future Backend Integration

When the backend API endpoints are ready, update the functions in `proprApi.ts` to make actual HTTP requests:

- `GET /api/system/status` - System status information
- `GET /api/queue/stats` - Queue statistics
- `GET /api/workers/:id` - Worker details
- `GET /api/activity` - Activity feed
- `GET /api/config` - Configuration
- `PUT /api/config` - Update configuration

## Next Steps

This is Part 1 of the ProPR Web Management UI epic. Future enhancements will include:

1. Real-time activity feed
2. Detailed job/task view
3. Manual job submission interface
4. Configuration management page
5. Worker management controls
6. Authentication and authorization
7. WebSocket support for real-time updates

## Tech Stack

- **React** - UI framework
- **Vite** - Build tool and dev server
- **CSS** - Styling (with plans to migrate to a CSS framework)

## Contributing

When adding new features:
1. Create components in the `src/components/` directory
2. Add API functions to `src/api/proprApi.ts`
3. Follow the existing component structure and naming conventions
4. Ensure responsive design for mobile compatibility
