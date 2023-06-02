FROM node:14.21.3

WORKDIR /usr/src/

# Copy shared libraries
COPY scbl-lib ./scbl-lib

# Copy the service across
COPY ban-importer ./ban-importer

# Copy main package.json
COPY package.json .

# Install dependencies
RUN yarn install --production

# Install pm2
RUN yarn global add pm2

# Run servicce
CMD [ "pm2-runtime", "ban-importer/index.js" "--no-autorestart"]