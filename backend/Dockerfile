# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies with clean install
RUN npm ci --only=production && \
    npm cache clean --force

# Copy TypeScript config and source files
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Install dev dependencies for building, then build and remove them
RUN npm ci && \
    npm run build && \
    npm prune --production

# Expose the port
EXPOSE ${PORT:-8080}

# Set production environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/v1/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)}).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "dist/scripts/railway-simple.js"]