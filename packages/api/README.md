# ProPR API

The ProPR API provides the backend server for the web-based management interface for monitoring and controlling your ProPR instance.

## Components

- **api**: Express.js backend API with GitHub OAuth authentication
- **client**: React frontend built with Vite and Tailwind CSS

## Setup

### Prerequisites

1. Create a GitHub OAuth App:
   - Go to GitHub Settings > Developer settings > OAuth Apps
   - Click "New OAuth App"
   - Set Authorization callback URL to: `http://localhost:4000/api/auth/github/callback`
   - Save the Client ID and Client Secret

2. Configure environment variables in your `.env` file:
   ```
   # GitHub OAuth Configuration
   GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
   GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
   GH_OAUTH_CALLBACK_URL=http://localhost:4000/api/auth/github/callback
   SESSION_SECRET=your-session-secret-here
   
   # Dashboard Configuration
   DASHBOARD_API_PORT=4000
   FRONTEND_URL=http://localhost:5173
   ```

### Running with Docker Compose

The dashboard is integrated into the main docker-compose setup:

```bash
docker-compose up api
```

### Development

To run the API in development mode:

1. Backend API:
   ```bash
   cd packages/api
   npm install
   npm run dev
   ```

## Features

- **GitHub OAuth Authentication**: Secure login with GitHub
- **System Status Monitoring**: View health status of all ProPR components
- **Queue Statistics**: Monitor task queue metrics
- **Activity Log**: Track recent system activities
- **Performance Metrics**: View processing times and throughput

## API Endpoints

All API endpoints are protected by authentication:

- `GET /api/auth/github` - Initiate GitHub OAuth flow
- `GET /api/auth/github/callback` - OAuth callback
- `GET /api/auth/logout` - Logout user
- `GET /api/auth/user` - Get current user info
- `GET /api/status` - System health status
- `GET /api/queue/stats` - Queue statistics
- `GET /api/activity` - Activity log
- `GET /api/metrics` - Performance metrics
- `GET /api/task/:taskId/history` - Task history

## Security

- Session-based authentication with secure cookies
- All API endpoints require authentication
- CORS configured for frontend origin
- Environment-based session secrets