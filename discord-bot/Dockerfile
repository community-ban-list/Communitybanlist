# Use multi-stage builds to reduce the final image size
# Both stages use Docker Hardened Images, which need a `docker login dhi.io` to pull.

# When the image's SBOM is generated, also scan the build context. It is declared before the first
# FROM, so it applies to the final image's SBOM.
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true

# Stage 1: Build
# The dev variant includes the shell and Yarn needed to install dependencies.
FROM dhi.io/node:26-dev AS build

WORKDIR /opt/workdir/

# Copy the rest of the source files
# Keep these commands in this order to ensure dependencies are installed correctly.
COPY scbl-lib ./scbl-lib
COPY discord-bot ./discord-bot
COPY package.json .

# Install dependencies
RUN yarn install --production

# Run the tests, so an image that fails them is never built or pushed.
RUN for test in scbl-lib/test/*.js discord-bot/test/*.js; do \
      [ -e "$test" ] || continue; \
      node --experimental-vm-modules "$test" || exit 1; \
    done


# Stage 2: Runtime
# The runtime variant has no shell or package manager and runs as the non-root node user.
FROM dhi.io/node:26

WORKDIR /opt/workdir/

# Copy only the necessary files from the build stage
COPY --from=build /opt/workdir /opt/workdir

# The commit the image was built from, which CI passes in, so the services can say which build is
# running. It is set last, so a new commit does not change any earlier layer.
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}

# Report whether the bot is connected to Discord and the database. The runtime image has no shell
# or curl, so the check is a Node script.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD [ "node", "discord-bot/healthcheck.js" ]

# Run service
CMD [ "node", "discord-bot/index.js" ]
