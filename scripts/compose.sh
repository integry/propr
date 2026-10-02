#!/bin/bash

set -e

COMMAND=$1

case $COMMAND in
  up)
    echo "Starting up Docker Compose environment..."
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d --remove-orphans
    echo "Environment is up and running."
    ;;
  dev)
    echo "Starting up Docker Compose environment in development mode..."
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d --remove-orphans
    echo "Development environment is up and running."
    ;;
  down)
    echo "Stopping Docker Compose environment..."
    docker compose down --remove-orphans
    echo "Environment is stopped."
    ;;
  logs)
    echo "Tailing logs..."
    docker compose logs -f
    ;;
  build)
    echo "Forcing a rebuild of all images..."
    docker compose build --no-cache
    echo "Images rebuilt."
    ;;
  *)
    echo "Usage: $0 {up|dev|down|logs|build}"
    exit 1
    ;;
esac
