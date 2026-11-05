# Stage 1: Build the Docusaurus static site
FROM node:22-slim as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Docusaurus build command
RUN npm run build

# Stage 2: Serve the app with a lightweight server
FROM node:22-slim
WORKDIR /app
# Docusaurus builds to a 'build' directory by default
COPY --from=build /app/build /app/build
COPY serve.json /app/serve.json
RUN npm install -g serve@14.2.6
EXPOSE 3000

# Serve the 'build' directory on port 3000. Docusaurus emits a real index.html per
# route, so serve them directly (no --single SPA fallback, which answers every path
# with the homepage) and let unknown paths get build/404.html with status 404.
# serve resolves --config relative to the served directory, hence ../serve.json.
# scripts/check-docs-static-serving.mjs runs this exact command against a fresh build.
CMD ["serve", "build", "--config", "../serve.json", "-l", "tcp://0.0.0.0:3000"]
