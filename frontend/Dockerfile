# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build arguments for environment variables
ARG VITE_API_URL=
ARG VITE_WS_URL=

ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}

# Build the app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy custom nginx config
COPY --from=builder /app/dist /usr/share/nginx/html

# Create nginx config for SPA routing
# КАО#SG1-selfxss — derive a trustworthy forwarded proto for the backend so it
# can set the session cookie's Secure flag correctly: pass through an upstream
# proxy/LB value when present, else fall back to this server's $scheme. The map
# lives at http context (conf.d/*.conf is included inside http {}).
RUN echo 'map $http_x_forwarded_proto $forwarded_proto { default $http_x_forwarded_proto; "" $scheme; } \
    server { \
    listen 80; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    client_max_body_size 10M; \
    add_header X-Content-Type-Options "nosniff" always; \
    add_header X-Frame-Options "DENY" always; \
    add_header Content-Security-Policy "default-src '"'"'self'"'"'; script-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"' https://fonts.googleapis.com; style-src-elem '"'"'self'"'"' '"'"'unsafe-inline'"'"' https://fonts.googleapis.com; font-src '"'"'self'"'"' https://fonts.gstatic.com; connect-src '"'"'self'"'"' ws: wss:; img-src '"'"'self'"'"' data: blob:; frame-src '"'"'self'"'"' blob:" always; \
    add_header Referrer-Policy "strict-origin-when-cross-origin" always; \
    location = /sandbox-frame.html { \
        add_header X-Content-Type-Options "nosniff" always; \
        add_header Cache-Control "no-cache"; \
        add_header Content-Security-Policy "default-src * data: blob: '"'"'unsafe-inline'"'"' '"'"'unsafe-eval'"'"'; script-src * '"'"'unsafe-inline'"'"' '"'"'unsafe-eval'"'"'; style-src * '"'"'unsafe-inline'"'"'; img-src * data: blob:; font-src * data:; connect-src * ws: wss:; frame-src * blob: data:;" always; \
    } \
    location = /sandbox-tab.html { \
        add_header X-Content-Type-Options "nosniff" always; \
        add_header Cache-Control "no-cache"; \
        add_header Content-Security-Policy "default-src * data: blob: '"'"'unsafe-inline'"'"' '"'"'unsafe-eval'"'"'; script-src * '"'"'unsafe-inline'"'"' '"'"'unsafe-eval'"'"'; style-src * '"'"'unsafe-inline'"'"'; img-src * data: blob:; font-src * data:; connect-src * ws: wss:; frame-src * blob: data:;" always; \
    } \
    location / { \
        try_files $uri $uri/ /index.html; \
        add_header Cache-Control "no-cache, no-store, must-revalidate"; \
    } \
    location /assets { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
    location /api { \
        proxy_pass http://backend:8000; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-Proto $forwarded_proto; \
        proxy_read_timeout 300s; \
        proxy_connect_timeout 60s; \
        proxy_send_timeout 300s; \
    } \
    location /ws { \
        proxy_pass http://backend:8000; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Forwarded-Proto $forwarded_proto; \
        proxy_read_timeout 86400s; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
