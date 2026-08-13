# Built from the REPO ROOT so the shared workspace is available:
#   docker build -f habiterall-cloud/Dockerfile .
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Workspace manifests first, so the dependency layer caches across source
# edits. The shared workspace's own sources are copied before `npm ci` so npm
# can link it into node_modules as a real workspace package.
# No trailing `*` on the lockfile: the glob makes it optional, so a missing
# lockfile silently produces an image where `npm ci` fails at build time with
# a confusing "can only install with an existing package-lock.json".
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY habiterall-cloud/package.json ./habiterall-cloud/
COPY shared/src ./shared/src
COPY shared/public ./shared/public

# Both workspaces must be named: installing only habiterall-cloud pulls its
# external deps but does NOT link the local @habiterall/shared package.
RUN npm ci --omit=dev \
      --workspace habiterall-cloud \
      --workspace @habiterall/shared \
      --include-workspace-root

COPY habiterall-cloud/src ./habiterall-cloud/src
COPY habiterall-cloud/public ./habiterall-cloud/public

WORKDIR /app/habiterall-cloud

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
