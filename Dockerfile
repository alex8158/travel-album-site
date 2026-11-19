FROM node:24-alpine

# Install ffmpeg for video frame extraction
RUN apk add --no-cache ffmpeg
# better-sqlite3 11.10.0 has no Node 24 prebuilt binary: build tools for node-gyp
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Build client
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# Build server
COPY server/package*.json ./server/
# Full install: typescript is a devDependency and is needed for the build (with --omit=dev, `npx tsc`
# fetched the unrelated npm package "tsc" and the build failed, also on node:18-alpine).
# --foreground-scripts only makes install scripts (better-sqlite3) visible in the build log.
RUN cd server && npm ci --foreground-scripts
COPY server/ ./server/
RUN cd server && npx tsc && npm prune --omit=dev

# Copy client build to server static directory
RUN cp -r client/dist server/public

# Expose port
EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production

WORKDIR /app/server
CMD ["node", "dist/index.js"]
