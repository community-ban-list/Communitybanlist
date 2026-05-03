# Use multi-stage builds to reduce the final image size
# Stage 1: Build
FROM debian:13-slim AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Set noninteractive mode for apt to avoid prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, download Node.js 14.21.3, and set up yarn
RUN apt-get update && apt-get upgrade \
    && apt-get install -y --no-install-recommends \
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


# Copy the rest of the source files
# Keep these commands in this order to ensure dependencies are installed correctly.
COPY scbl-lib ./scbl-lib
COPY ban-importer ./ban-importer
COPY package.json .

# Install dependencies
RUN yarn install --production --ignore-engines


# Stage 2: Runtime
FROM debian:13-slim

WORKDIR /opt/workdir/

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 14.21.3 on the runtime image and install pm2 globally
RUN apt-get update && apt-get upgrade \
    && apt-get install -y --no-install-recommends \
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

# Run service (Added 'node' explicit invocation as debian:13 lacks the node image's entrypoint script)
CMD [ "node", "ban-importer/index.js", "--no-autorestart" ]
