FROM node:18-alpine

# Install ffmpeg for video frame extraction
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Build client
COPY client/package*.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# Build server
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
RUN cd server && npx tsc

# Copy client build to server static directory
RUN cp -r client/dist server/public

# Expose port
EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production

WORKDIR /app/server
CMD ["node", "dist/index.js"]
