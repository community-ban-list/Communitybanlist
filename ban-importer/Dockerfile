# Use multi-stage builds to reduce the final image size
# Stage 1: Build
FROM node:14.21.3-slim AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Test to make sure packages are up to date and install dependencies
RUN apt update && apt upgrade -y && \
    npm config set scripts-prepend-node-path auto && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy shared libraries and service files
COPY scbl-lib ./scbl-lib
COPY ban-importer ./ban-importer
COPY package.json .

# Install dependencies
RUN yarn install --production

# Stage 2: Runtime
FROM node:14.21.3-slim

WORKDIR /opt/workdir/

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Install pm2
RUN yarn global add pm2 --ignore-engines

# Add a non-root user and switch to it
RUN useradd --user-group --create-home --shell /bin/false appuser
USER appuser

# Run service
CMD [ "pm2-runtime", "ban-importer/index.js", "--no-autorestart" ]
