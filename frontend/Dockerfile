FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL
ARG BUILD_MODE=production
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build -- --mode ${BUILD_MODE}

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
