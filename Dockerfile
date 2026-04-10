# -- Build stage --
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# -- Runtime stage --
FROM node:20-slim
WORKDIR /app

# Install Bitwarden CLI globally
RUN npm install -g @bitwarden/cli

# Copy compiled output and production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ ./dist/

# Default env
ENV MCP_TRANSPORT=http
ENV MCP_PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
