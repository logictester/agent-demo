FROM node:20-alpine

# Build frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/. .
RUN npm run build

# Install backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/. .

EXPOSE 4000
CMD ["npm", "start"]
