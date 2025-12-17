# Stage 1: Build the React app
# NOTE: This Dockerfile should be built from the monorepo root with context set to include packages/shared
# Example: docker build -f gitfix-ui/Dockerfile .
FROM node:20-slim AS build

ARG VITE_API_BASE_URL
ARG VITE_OAUTH_API_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_OAUTH_API_URL=$VITE_OAUTH_API_URL

WORKDIR /app

# Copy root package files for workspace resolution
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY gitfix-ui/package*.json ./gitfix-ui/

RUN npm install

# Copy shared package source and build it
COPY packages/shared ./packages/shared
RUN cd packages/shared && npm run build

# Copy UI source and build it
COPY gitfix-ui ./gitfix-ui
RUN cd gitfix-ui && npm run build

# Stage 2: Serve the app with a lightweight server
FROM node:20-slim
WORKDIR /app
COPY --from=build /app/gitfix-ui/dist /app/dist
COPY gitfix-ui/serve.json /app/serve.json
RUN npm install -g serve
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:5173", "-c", "../serve.json"]
