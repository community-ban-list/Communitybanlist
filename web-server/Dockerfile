FROM debian:latest
FROM node:14.21.3-slim

WORKDIR /opt/workdir/

# Copy shared libraries
COPY scbl-lib ./scbl-lib

# Copy the service across
COPY client ./client
COPY web-server ./web-server

# Copy main package.json
COPY package.json .

# Install dependencies
# RUN yarn install --production --ignore-engines
RUN yarn install --production

# Install pm2
RUN yarn global add pm2

# Build client
RUN yarn build-web-server

# Expose ports
EXPOSE 80

# Run service with pm2
CMD [ "pm2-runtime", "web-server/index.js" ]
