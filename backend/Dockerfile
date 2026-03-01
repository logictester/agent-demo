FROM node:20-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/. .
COPY frontend /app/frontend
EXPOSE 4000
CMD ["npm", "start"]
