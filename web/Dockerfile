# Build context is the REPO ROOT (see docker-compose.yml): the SPA imports ../shared/types.
FROM node:22-slim AS build
WORKDIR /app
COPY web/package*.json web/
RUN cd web && npm ci
COPY web web
COPY shared shared
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN cd web && npm run build
FROM nginx:1.27-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
RUN printf 'server{listen 80;root /usr/share/nginx/html;add_header X-Content-Type-Options nosniff always;add_header X-Frame-Options DENY always;add_header Referrer-Policy no-referrer always;location /{try_files $uri /index.html;}}' > /etc/nginx/conf.d/default.conf
