# Use multi-stage builds to reduce the final image size
# Stage 1: Build
FROM debian:13-slim AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Set noninteractive mode for apt to avoid prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, Node.js 14.21.3, and Yarn
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    xz-utils \
    && curl -fsSLO --compressed "https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz" \
    && tar -xJf "node-v14.21.3-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
    && rm "node-v14.21.3-linux-x64.tar.xz" \
    && npm config set scripts-prepend-node-path auto \
    && npm install -g yarn \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy the rest of the source files
COPY scbl-lib ./scbl-lib
COPY client ./client
COPY web-server ./web-server
COPY package.json .

# Install dependencies and build client
RUN yarn install --production --ignore-engines && \
    yarn build-web-server

# Stage 2: Runtime
FROM debian:13-slim

WORKDIR /opt/workdir/

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 14.21.3, pm2, and curl (for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    xz-utils \
    && curl -fsSLO --compressed "https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz" \
    && tar -xJf "node-v14.21.3-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
    && rm "node-v14.21.3-linux-x64.tar.xz" \
    && npm install -g yarn \
    && yarn global add pm2 --ignore-engines \
    && apt-get purge -y --auto-remove xz-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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

# Run service
CMD [ "node", "web-server/index.js" ]
