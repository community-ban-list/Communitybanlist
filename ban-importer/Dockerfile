# Use multi-stage builds to reduce the final image size
# Stage 1: Build
FROM node:14.21.3-slim AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Set noninteractive mode for apt to avoid prompts
ENV DEBIAN_FRONTEND=noninteractive

# Use apt-get (recommended for scripts) and minimal install
RUN set -eux; \
    sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get upgrade -y && \
    npm config set scripts-prepend-node-path auto && \
    apt-get clean && rm -rf /var/lib/apt/lists/*


COPY package.json .

# Install dependencies
RUN yarn install --production --ignore-engines

# Copy the rest of the source files
COPY scbl-lib ./scbl-lib
COPY ban-importer ./ban-importer

# Stage 2: Runtime
FROM node:14.21.3-slim

WORKDIR /opt/workdir/

ENV DEBIAN_FRONTEND=noninteractive

# Install pm2 globally
RUN yarn global add pm2 --ignore-engines

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Add a non-root user and switch to it
RUN useradd --user-group --create-home --shell /bin/false appuser
USER appuser

# Run service
CMD [ "pm2-runtime", "ban-importer/index.js", "--no-autorestart" ]
