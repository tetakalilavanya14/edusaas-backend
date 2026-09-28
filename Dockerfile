# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate the database client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source code
COPY . .

# Drop dev dependencies
RUN npm prune --omit=dev


# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install runtime tools:
# - docker-cli: required by codingAssessment/dockerService.js
# - python3 + pip: required to install Semgrep CE
RUN apk add --no-cache \
    docker-cli \
    git \
    python3 \
    py3-pip \
    && python3 -m pip install \
        --no-cache-dir \
        --break-system-packages \
        semgrep==1.176.1 \
    && semgrep --version \
    && docker --version

# Copy production application
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/worker.js ./worker.js

# Runtime directories
RUN mkdir -p uploads \
    && chown -R node:node /app

USER node

EXPOSE 5000

CMD ["node", "server.js"]