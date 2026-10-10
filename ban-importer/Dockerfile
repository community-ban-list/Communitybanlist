# Use multi-stage builds to reduce the final image size
# Both stages use Docker Hardened Images, which need a `docker login dhi.io` to pull.

# Stage 1: Build
# The dev variant includes the shell and Yarn needed to install dependencies.
FROM dhi.io/node:24-dev AS build
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

WORKDIR /opt/workdir/

# Copy the rest of the source files
# Keep these commands in this order to ensure dependencies are installed correctly.
COPY scbl-lib ./scbl-lib
COPY ban-importer ./ban-importer
COPY package.json .

# Install dependencies
RUN yarn install --production


# Stage 2: Runtime
# The runtime variant has no shell or package manager and runs as the non-root node user.
FROM dhi.io/node:24

WORKDIR /opt/workdir/

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# Run service
CMD [ "node", "ban-importer/index.js" ]
