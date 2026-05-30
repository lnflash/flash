#!/bin/bash
# Flash Dev Environment Setup
# Usage: ./dev/setup.sh
#
# This script validates your environment, installs dependencies,
# configures credentials, and starts the development server.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Flash Backend — Development Environment Setup"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. Check Node.js version ──────────────────────────
echo "Checking prerequisites..."

NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_VERSION" == "none" ]]; then
  fail "Node.js is not installed. Install via nvm: https://github.com/nvm-sh/nvm"
fi

NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" != "20" ]]; then
  warn "Node.js $NODE_VERSION detected — Flash requires Node 20.x"
  if command -v nvm &>/dev/null || [ -f "$HOME/.nvm/nvm.sh" ]; then
    echo "  Attempting: nvm use 20..."
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    nvm use 20 2>/dev/null || nvm install 20
    info "Now using $(node --version)"
  else
    fail "Please install Node 20.x. Recommended: use nvm (https://github.com/nvm-sh/nvm)"
  fi
else
  info "Node.js $NODE_VERSION"
fi

# ── 2. Check yarn ─────────────────────────────────────
if ! command -v yarn &>/dev/null; then
  fail "yarn is not installed. Run: corepack enable && corepack prepare yarn@1 --activate"
fi
info "yarn $(yarn --version)"

# ── 3. Check Docker ───────────────────────────────────
if ! command -v docker &>/dev/null; then
  fail "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
fi
if ! docker info &>/dev/null 2>&1; then
  fail "Docker daemon is not running. Please start Docker Desktop."
fi
info "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ── 4. Check direnv (optional but recommended) ───────
if command -v direnv &>/dev/null; then
  info "direnv $(direnv --version)"
else
  warn "direnv not found (optional but recommended). Install: https://direnv.net"
fi

echo ""

# ── 5. Configure Ibex credentials ────────────────────
echo "Checking Ibex credentials..."

if [ -f .env.local ] && grep -q "IBEX_PASSWORD" .env.local 2>/dev/null; then
  info "Ibex credentials found in .env.local"
else
  echo ""
  echo "Flash requires Ibex sandbox credentials to connect to the payment backend."
  echo "If you don't have credentials, ask your team lead."
  echo ""
  read -rp "Ibex email (or press Enter to skip): " IBEX_EMAIL
  if [ -n "$IBEX_EMAIL" ]; then
    read -rsp "Ibex password: " IBEX_PASSWORD
    echo ""
    cat > .env.local << EOF
export IBEX_EMAIL='${IBEX_EMAIL}'
export IBEX_PASSWORD='${IBEX_PASSWORD}'
EOF
    info "Credentials saved to .env.local (git-ignored)"
  else
    warn "Skipped — you'll need to create .env.local with IBEX_EMAIL and IBEX_PASSWORD before starting"
  fi
fi

# ── 6. Configure app overrides ───────────────────────
echo ""
echo "Checking app config overrides..."

CONFIG_DIR="${CONFIG_PATH:-$HOME/.config/flash}"
OVERRIDES="$CONFIG_DIR/dev-overrides.yaml"

if [ -f "$OVERRIDES" ]; then
  info "Config overrides found at $OVERRIDES"
else
  mkdir -p "$CONFIG_DIR"
  # Read from .env.local if it exists
  if [ -f .env.local ]; then
    source .env.local 2>/dev/null || true
  fi
  if [ -n "${IBEX_EMAIL:-}" ] && [ -n "${IBEX_PASSWORD:-}" ]; then
    cat > "$OVERRIDES" << EOF
ibex:
  email: ${IBEX_EMAIL}
  password: ${IBEX_PASSWORD}
EOF
    info "Generated $OVERRIDES with Ibex credentials"
  else
    warn "Could not generate overrides — run ./dev/config/set-overrides.sh manually"
  fi
fi

echo ""

# ── 7. Install dependencies ──────────────────────────
echo "Installing Node.js dependencies..."
yarn install --ignore-engines 2>&1 | tail -3
info "Dependencies installed"

echo ""

# ── 8. Start Docker dependencies ─────────────────────
echo "Starting Docker dependencies..."
docker compose up bats-deps -d 2>&1 | grep -E '(Created|Started|Running)' || true
info "Docker dependencies running"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ Setup complete!"
echo ""
echo "  Start the dev server:  make start"
echo "  GraphQL playground:    http://localhost:4002/graphql"
echo "  Admin playground:      http://localhost:4002/admin/graphql"
echo "  Test login:            phone: +16505554328  code: 000000"
echo ""
echo "  Stop everything:       make clean-deps"
echo "  Run tests:             make test"
echo "═══════════════════════════════════════════════════"
echo ""
