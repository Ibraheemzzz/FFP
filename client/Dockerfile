FROM node:22-alpine
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY client/ ./client/

EXPOSE 4000
ENV PORT=4000
ENV API_BASE_URL=http://service:3000

CMD ["npx", "tsx", "client/server.ts"]
