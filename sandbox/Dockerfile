# CodeForge Sandbox - Multi-language isolated execution environment
FROM python:3.11-slim

# Install system dependencies and language runtimes
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools
    build-essential \
    gcc \
    g++ \
    # Node.js setup
    curl \
    gnupg \
    # Java
    default-jdk \
    # Other utilities
    time \
    procps \
    # For healthcheck
    ca-certificates \
    # Chromium + WebGL deps for browser code validation (GLSL, DOM, Canvas)
    chromium \
    libegl1 \
    libgbm1 \
    libgles2 \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install TypeScript, esbuild, puppeteer-core (uses system Chromium)
RUN npm install -g typescript ts-node @types/node esbuild puppeteer-core

# Chromium env for puppeteer-core, NODE_PATH so Node finds global modules
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/lib/node_modules

# Install Go
RUN curl -OL https://go.dev/dl/go1.22.10.linux-amd64.tar.gz \
    && tar -C /usr/local -xzf go1.22.10.linux-amd64.tar.gz \
    && rm go1.22.10.linux-amd64.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# Install common Python packages (headless matplotlib)
RUN pip install --no-cache-dir \
    # Testing
    pytest==8.0.2 \
    pytest-asyncio==0.23.5 \
    # HTTP
    requests==2.31.0 \
    httpx==0.27.0 \
    aiohttp==3.9.3 \
    # Web frameworks
    flask==3.0.2 \
    fastapi==0.110.0 \
    uvicorn==0.27.1 \
    # Database
    sqlalchemy==2.0.27 \
    # Data science (headless)
    numpy==1.26.4 \
    pandas==2.2.0 \
    scipy==1.12.0 \
    scikit-learn==1.4.1.post1 \
    # Visualization (headless backend)
    matplotlib==3.8.3 \
    seaborn==0.13.2 \
    plotly==5.19.0 \
    # Utilities
    pydantic==2.6.1 \
    python-dotenv==1.0.1 \
    pillow==10.2.0 \
    beautifulsoup4==4.12.3 \
    lxml==5.1.0 \
    pyyaml==6.0.1 \
    toml==0.10.2 \
    # Async
    aiofiles==23.2.1 \
    # Crypto
    cryptography==42.0.4 \
    pyjwt==2.8.0

# Set matplotlib to use non-interactive backend
ENV MPLBACKEND=Agg

# Create sandbox user for security
RUN useradd -m -s /bin/bash sandbox && \
    mkdir -p /home/sandbox/code && \
    mkdir -p /home/sandbox/output && \
    chown -R sandbox:sandbox /home/sandbox

# Create app directory for the executor service
WORKDIR /app

# Copy executor service files
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY executor.py /app/
COPY browser_validator.js /app/

# Give sandbox user write access to /tmp and /app for execution
RUN chmod 1777 /tmp && chown -R sandbox:sandbox /app

# Switch to non-root user for security
USER sandbox

# Expose port
EXPOSE 8080

# Run executor service
CMD ["uvicorn", "executor:app", "--host", "0.0.0.0", "--port", "8080"]
