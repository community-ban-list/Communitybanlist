# Use multi-stage builds to reduce the final image size
# Both stages use Docker Hardened Images, which need a `docker login dhi.io` to pull.

# When the image's SBOM is generated, also scan the build context. It is declared before the first
# FROM, so it applies to the final image's SBOM.
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

# Stage 1: Build
# The dev variant includes the shell and Yarn needed to install dependencies and build the client.
FROM dhi.io/node:26-dev AS build

WORKDIR /opt/workdir/

# Copy the rest of the source files
COPY scbl-lib ./scbl-lib
COPY client ./client
COPY web-server ./web-server
COPY package.json .

# Install dependencies and build client
RUN yarn install --production && \
    yarn build-web-server

# Run the tests, so an image that fails them is never built or pushed.
COPY scripts/run-tests.mjs ./scripts/
RUN node scripts/run-tests.mjs scbl-lib web-server

# Stage 2: Runtime
# The runtime variant has no shell or package manager and runs as the non-root node user.
FROM dhi.io/node:26

WORKDIR /opt/workdir/

# The web server serves the site only when NODE_ENV is exactly production
# (web-server/src/production.js).
ENV NODE_ENV=production

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# The commit the image was built from, which CI passes in, so the services can say which build is
# running. It is set last, so a new commit does not change any earlier layer.
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}

# Expose ports
EXPOSE 80

# The runtime image has no shell or curl, so the check is a Node script.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD [ "node", "web-server/healthcheck.js" ]

# Run service
CMD [ "node", "web-server/index.js" ]
