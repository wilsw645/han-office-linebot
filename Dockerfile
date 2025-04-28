# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install app dependencies
RUN npm install --production

# Bundle app source
COPY . .

# Make port 3001 available to the world outside this container
# (server.js defaults to 3001 if PORT env var isn't set)
EXPOSE 3001

# Define the command to run your app using CMD which defines your runtime
CMD [ "npm", "start" ]
