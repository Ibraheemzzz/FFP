FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install dependencies deterministically via npm ci
RUN npm ci

# Copy client source code
COPY src/ ./src/

ENV API_BASE_URL=http://service:3000

# Default execution: run the automated guided demo scenario once and exit
CMD ["npm", "run", "demo"]
