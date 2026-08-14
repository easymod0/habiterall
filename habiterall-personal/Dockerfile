# Built from the REPO ROOT so the shared workspace is available:
#   docker build -f habiterall-personal/Dockerfile .
#
# Node 22 ships node:sqlite, so there is no native module to compile and no
# build stage — the frontend is plain ES modules served statically.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Workspace manifests first, so the dependency layer caches across source
# edits. The shared workspace's own sources are copied before `npm ci` so npm
# can link it into node_modules as a real workspace package.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY habiterall-personal/package.json ./habiterall-personal/
COPY shared/src ./shared/src
COPY shared/public ./shared/public

# Both workspaces must be named: installing only habiterall-personal pulls its
# external deps but does NOT link the local @habiterall/shared package.
RUN npm ci --omit=dev \
      --workspace habiterall-personal \
      --workspace @habiterall/shared \
      --include-workspace-root

COPY habiterall-personal/src ./habiterall-personal/src
COPY habiterall-personal/public ./habiterall-personal/public
COPY habiterall-personal/scripts ./habiterall-personal/scripts

WORKDIR /app/habiterall-personal

# The database lives on a volume so it survives container rebuilds.
ENV HABITERALL_DB=/data/habiterall.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
