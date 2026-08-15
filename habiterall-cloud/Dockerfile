# Built from the REPO ROOT so the shared workspace is available:
#   docker build -f habiterall-cloud/Dockerfile .
FROM node:26-alpine

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
# The same image runs the app, the migrations and the Authentik bootstrap —
# and carries what that bootstrap has to hand to Authentik. Without the last
# two, configuring Authentik would need a checkout of this repository on the
# server to bind-mount from, and the published image would be a strictly
# lesser way to run this.
COPY habiterall-cloud/scripts ./habiterall-cloud/scripts
COPY habiterall-cloud/blueprints ./habiterall-cloud/blueprints
COPY habiterall-cloud/branding ./habiterall-cloud/branding

WORKDIR /app/habiterall-cloud

# Where the published-image path mounts the volumes Authentik shares, and the
# reason they are created HERE rather than left to compose: Docker seeds an
# empty named volume from whatever is at that path in the image, ownership
# included, and a path the image does not have becomes root-owned — which this
# container, running as `node`, then cannot write. The failure is an EACCES
# from the copy, on a first run only, on the published path only.
RUN mkdir -p /out/blueprints /out/icons /out/images && chown -R node:node /out

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
