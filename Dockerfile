# syntax=docker/dockerfile:1

# ---- build stage: installs all deps and produces dist/ --------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- verify target: one-off acceptance (typecheck + build + vitest) --------
FROM node:20-alpine AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "verify"]

# ---- web target: static SPA served by nginx --------------------------------
FROM nginx:alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
