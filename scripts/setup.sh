#!/usr/bin/env bash
set -euo pipefail

echo "Setting up mtmux..."

# Copy env file if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# Install dependencies
echo "Installing dependencies..."
pnpm install

echo "Setup complete! Run 'pnpm dev' to start development."
