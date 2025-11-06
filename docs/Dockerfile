# Stage 1: Build the Docusaurus static site
FROM node:20-slim as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Docusaurus build command
RUN npm run build

# Stage 2: Serve the app with a lightweight server
FROM node:20-slim
WORKDIR /app
# Docusaurus builds to a 'build' directory by default
COPY --from=build /app/build /app/build
RUN npm install -g serve
EXPOSE 3000

# Serve the 'build' directory on port 3000
CMD ["serve", "-s", "build", "-l", "tcp://0.0.0.0:3000"]
