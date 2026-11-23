# RAY cloud hub — always-on container for Google Cloud Run (or any Docker host).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY . .
RUN npx vite build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.ts ./
COPY server ./server
COPY src/types ./src/types
COPY extension ./extension
EXPOSE 8080
ENV PORT=8080
CMD ["npx", "tsx", "server.ts"]
