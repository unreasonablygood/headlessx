FROM node:22-slim AS base

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY nx.json ./

# Copy Web app
COPY apps/web ./apps/web

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build the Web app
WORKDIR /app
RUN pnpm exec nx run headlessx-web:build

# Production credential readers require the fixed root-owned 0400 mount.
USER root

# Start the Web app
WORKDIR /app/apps/web
CMD ["pnpm", "start"]
