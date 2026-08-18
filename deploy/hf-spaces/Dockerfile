# EdgeRunner Free Persistent Compute Node for Hugging Face Spaces
# 100% Free: 2 vCPU + 16 GB RAM + 50 GB Storage (No credit card required)

FROM python:3.11-slim

# Install system dependencies, C/C++ compilers, Node.js, and media utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    curl \
    git \
    ffmpeg \
    nodejs \
    npm \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Set up non-root user (Hugging Face standard UID 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    EDGERUNNER_WORKSPACE=/home/user/workspace

WORKDIR $HOME/app

# Copy backend requirements and install dependencies
COPY --chown=user:user backend/requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy backend application code
COPY --chown=user:user backend/app ./app

# Create workspace directory
RUN mkdir -p $HOME/workspace

# Expose default Hugging Face Space port
EXPOSE 7860

# Launch EdgeRunner backend server
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
