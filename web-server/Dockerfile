# Use multi-stage builds to reduce the final image size
# Stage 1: Build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true
FROM node:14.21.3-slim AS build

WORKDIR /opt/workdir/

# Test to make sure packages are up to date and install dependencies
RUN apt update && apt upgrade -y && \
    npm config set scripts-prepend-node-path auto && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy shared libraries and service files
COPY scbl-lib ./scbl-lib
COPY client ./client
COPY web-server ./web-server
COPY package.json .

# Install dependencies and build client
RUN yarn install --production && \
    yarn build-web-server

# Stage 2: Runtime
FROM node:14.21.3-slim

WORKDIR /opt/workdir/

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Install pm2
RUN yarn global add pm2

# Add a non-root user and switch to it
RUN useradd --user-group --create-home --shell /bin/false appuser
USER appuser

# Expose ports
EXPOSE 80

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:80/health || exit 1

# Run service with pm2
CMD [ "pm2-runtime", "web-server/index.js" ]
