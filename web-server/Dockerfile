# Use multi-stage builds to reduce the final image size
# Stage 1: Build
FROM node:14.21.3-slim AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Set noninteractive mode for apt to avoid prompts
ENV DEBIAN_FRONTEND=noninteractive

# Use archive.debian.org for EOL distros, but consider upgrading Node version!
RUN set -eux; \
    sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends curl && \
    npm config set scripts-prepend-node-path auto && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN yarn install --production --ignore-engines

# Copy the rest of the source files
COPY scbl-lib ./scbl-lib
COPY client ./client
COPY web-server ./web-server
COPY package.json .

# Install dependencies and build client
RUN yarn install --production --ignore-engines && \
    yarn build-web-server

# Stage 2: Runtime
FROM node:14.21.3-slim

WORKDIR /opt/workdir/

ENV DEBIAN_FRONTEND=noninteractive

# Use archive.debian.org for EOL distros, but consider upgrading Node version!
RUN set -eux; \
    sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pm2 globally
RUN yarn global add pm2 --ignore-engines

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Add a non-root user and switch to it
RUN useradd --user-group --create-home --shell /bin/false appuser
USER appuser

# Expose ports
EXPOSE 80

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:80/health-check || exit 1

# Run service with pm2
CMD [ "pm2-runtime", "web-server/index.js" ]
