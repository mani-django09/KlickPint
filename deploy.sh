#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  KlickPint — VPS Deployment Script (Ubuntu/Debian)
#  Run as: bash deploy.sh
# ═══════════════════════════════════════════════════════════

set -e  # Exit on any error

APP_DIR="/var/www/klickpint"
APP_NAME="klickpint"
LOG_DIR="/var/log/klickpint"
DOMAIN="klickpint.online"
PORT=3020

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════╗"
echo "║     KlickPint — VPS Deployer         ║"
echo "║     Port: ${PORT}   Domain: ${DOMAIN}  ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── STEP 1: System packages ─────────────────────────────────
echo -e "${YELLOW}[1/7] Installing system packages...${NC}"
apt-get update -qq
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw

# ── STEP 2: Node.js 20 LTS ─────────────────────────────────
echo -e "${YELLOW}[2/7] Installing Node.js 20 LTS...${NC}"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v) | npm: $(npm -v)"

# ── STEP 3: PM2 ─────────────────────────────────────────────
echo -e "${YELLOW}[3/7] Installing PM2...${NC}"
npm install -g pm2 --quiet
pm2 install pm2-logrotate 2>/dev/null || true

# ── STEP 4: App directory & files ───────────────────────────
echo -e "${YELLOW}[4/7] Setting up app directory...${NC}"
mkdir -p "$APP_DIR" "$LOG_DIR"

# Copy project files (run this script from project root)
cp -r . "$APP_DIR/"
cd "$APP_DIR"

# Create .env from example if it doesn't exist
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/PORT=.*/PORT=${PORT}/" .env
  echo "  Created .env with PORT=${PORT}"
fi

# Install dependencies
echo "  Installing npm dependencies..."
npm install --production --quiet

# ── STEP 5: Firewall ─────────────────────────────────────────
echo -e "${YELLOW}[5/7] Configuring firewall...${NC}"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "  UFW enabled — SSH, HTTP, HTTPS allowed"

# ── STEP 6: Nginx config ─────────────────────────────────────
echo -e "${YELLOW}[6/7] Configuring Nginx...${NC}"
cp "$APP_DIR/nginx.conf" "/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default

# Test Nginx config (without SSL first — use HTTP placeholder)
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF

nginx -t && systemctl reload nginx
echo "  Nginx configured (HTTP) — run certbot after DNS is pointed"

# ── STEP 7: Start app with PM2 ───────────────────────────────
echo -e "${YELLOW}[7/7] Starting app with PM2...${NC}"
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅  KlickPint deployed successfully!                ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  App running at : http://127.0.0.1:${PORT}             ║${NC}"
echo -e "${GREEN}║  Public URL     : http://${DOMAIN}          ║${NC}"
echo -e "${GREEN}║  PM2 status     : pm2 status                         ║${NC}"
echo -e "${GREEN}║  View logs      : pm2 logs klickpint                 ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  NEXT: Run certbot for HTTPS (free SSL):             ║${NC}"
echo -e "${GREEN}║  certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
