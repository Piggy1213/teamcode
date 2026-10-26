# TeamCode website: landing page, accounts, downloads, app updates and cloud team workspaces (/team).
# Built from the repo root (see /railway.json) because it also runs the team server in server/.
FROM node:22-alpine
# git: three-way merge of concurrent edits. su-exec: drop to the unprivileged user after fixing volume ownership.
RUN apk add --no-cache git su-exec
WORKDIR /app
COPY website/package.json website/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./server/
COPY website/ ./website/
RUN chmod +x website/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/website/docker-entrypoint.sh"]
CMD ["node", "website/server.js"]
