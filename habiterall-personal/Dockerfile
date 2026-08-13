# Node 22 ships node:sqlite, so there is no native module to compile and no
# build stage needed — the frontend is plain ES modules served statically.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so this layer caches across source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# The database lives on a volume so it survives container rebuilds.
ENV HABITERALL_DB=/data/habiterall.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
