# Always-on TeamCode workspace server for remote teams. Built from the repo root (see server/railway.json).
FROM node:22-alpine
# git powers the server's 3-way merge of concurrent edits.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/ ./server/
ENV TEAMCODE_DATA=/data
EXPOSE 4477
CMD ["node", "server/standalone.js"]
