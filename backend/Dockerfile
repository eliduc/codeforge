FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create non-root user
RUN useradd -m appuser && chown -R appuser:appuser /app

# Pre-create Visual Review storage root and hand it to appuser BEFORE we drop
# privileges. Without this, the first capture inside the container hits
# `[Errno 13] Permission denied: '/var/lib/codeforge'` because the dir either
# doesn't exist or is root-owned from the bind mount. `mkdir -p` is idempotent
# and harmless if a docker-compose volume later mounts over it.
RUN mkdir -p /var/lib/codeforge/screenshots \
    && chown -R appuser:appuser /var/lib/codeforge \
    && chmod -R 0755 /var/lib/codeforge

USER appuser

# Expose port
EXPOSE 8000

# Run application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
