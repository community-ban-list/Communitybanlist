# Use multi-stage builds to reduce the final image size
# Both stages use Docker Hardened Images, which need a `docker login dhi.io` to pull.

# Stage 1: Build
# The dev variant includes the shell and Yarn needed to install dependencies and build the client.
FROM dhi.io/node:24-dev AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Copy the rest of the source files
COPY scbl-lib ./scbl-lib
COPY client ./client
COPY web-server ./web-server
COPY package.json .

# Install dependencies and build client
RUN yarn install --production --ignore-engines && \
    yarn build-web-server

# Stage 2: Runtime
# The runtime variant has no shell or package manager and runs as the non-root node user.
FROM dhi.io/node:24

WORKDIR /opt/workdir/

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Expose ports
EXPOSE 80

# The runtime image has no shell or curl, so the check is a Node script.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD [ "node", "web-server/healthcheck.js" ]

# Run service
CMD [ "node", "web-server/index.js" ]
