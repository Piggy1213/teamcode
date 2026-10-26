# TeamCode website. Built from the repo root (see /railway.json).
FROM node:22-alpine
WORKDIR /app
COPY website/package.json website/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY website/ ./
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.js"]
