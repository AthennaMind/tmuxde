FROM node:26.11.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git tmux python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
ENV NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /workspace
CMD ["pnpm", "--version"]
