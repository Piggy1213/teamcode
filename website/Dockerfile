# TeamCode download website. Built from the repo root (see /railway.json); it has no npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY website/ ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
