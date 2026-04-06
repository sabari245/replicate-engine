FROM oven/bun:1.2.8-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    git \
    vim \
    nano \
    python3 \
    python3-pip \
    nodejs \
    npm \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install

COPY prompts/ /workspace/prompts/
COPY agent.ts ./
COPY capture.ts ./

ENV HOME=/root
ENV WORKSPACE_DIR=/workspace/output
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium

ENTRYPOINT ["bun", "run", "agent.ts"]
