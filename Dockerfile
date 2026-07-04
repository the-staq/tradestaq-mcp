# Dockerfile for Glama introspection / MCP hosting.
# Builds the stdio MCP server from source and runs it.
FROM node:20-slim

WORKDIR /app

# Install deps (including dev deps for the TypeScript build)
COPY package.json package-lock.json ./
RUN npm ci

# Build
COPY . .
RUN npm run build

# Run the stdio MCP server (responds to tools/list introspection with no auth required)
CMD ["node", "dist/index.js"]
