#!/usr/bin/env bash
# RAY on an Oracle Cloud "Always Free" VM (Ubuntu 22.04 / 24.04, Arm A1 or AMD Micro).
# Always on, no sleeping, data kept on the VM's disk, free HTTPS.
#
# On the VM (as the default "ubuntu" user):
#   git clone https://github.com/revanthshankars-dotcom/ray-agent.git && bash ray-agent/deploy/oracle/setup.sh [your.domain]
# Without a domain RAY gets https://<ip-with-dashes>.sslip.io (free, automatic).
# Re-running is safe: it updates the code and keeps /etc/ray/ray.env and RAY's data.
set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${RAY_REPO_URL:-https://github.com/revanthshankars-dotcom/ray-agent.git}"
BRANCH="${RAY_BRANCH:-main}"
APP_DIR=/opt/ray
ENV_FILE=/etc/ray/ray.env
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "System packages"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  say "Caddy (free automatic HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

say "RAY user and code"
id ray >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /var/lib/ray --shell /usr/sbin/nologin ray
if [ -d "$APP_DIR/.git" ]; then
  sudo -u ray git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u ray git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  sudo mkdir -p "$APP_DIR"
  sudo chown ray:ray "$APP_DIR"
  sudo -u ray git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
sudo -u ray bash -c "cd '$APP_DIR' && npm ci --legacy-peer-deps --include=dev --no-audit --no-fund && npx vite build"

say "Address"
IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || true)"
if [ -z "$DOMAIN" ]; then
  [ -n "$IP" ] || { echo "Could not find the public IP — run again with your domain: bash setup.sh ray.example.com"; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi
echo "RAY will be at https://$DOMAIN"

say "Settings ($ENV_FILE)"
sudo mkdir -p /etc/ray
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" >/dev/null <<EOF
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://$DOMAIN
# Keeps pairing and encrypted logins valid across restarts. Copy the value from Render if you are moving.
RELAY_MASTER_SECRET=$(openssl rand -hex 32)
RAY_TZ_OFFSET_MINUTES=330
# ---- add the same keys you have in Render (one per line, no quotes) ----
# GEMINI_API_KEY=
# GROQ_API_KEY=
# OPENROUTER_API_KEY=
# CLOUDFLARE_API_TOKEN=
# CLOUDFLARE_ACCOUNT_ID=
# GOOGLE_OAUTH_CLIENT_ID=
# GOOGLE_OAUTH_CLIENT_SECRET=
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM_NUMBER=
# RAY_USER_PHONE=
EOF
else
  sudo sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$DOMAIN#" "$ENV_FILE"
fi
sudo chmod 600 "$ENV_FILE"

say "Service (starts on boot, restarts itself)"
sudo tee /etc/systemd/system/ray.service >/dev/null <<EOF
[Unit]
Description=RAY assistant hub
After=network-online.target
Wants=network-online.target

[Service]
User=ray
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

say "Nightly update (03:30)"
sudo tee /usr/local/bin/ray-update >/dev/null <<EOF
#!/usr/bin/env bash
set -e
cd $APP_DIR
sudo -u ray git fetch --quiet origin $BRANCH
if [ "\$(sudo -u ray git rev-parse HEAD)" != "\$(sudo -u ray git rev-parse origin/$BRANCH)" ]; then
  sudo -u ray git reset --hard --quiet origin/$BRANCH
  sudo -u ray bash -c 'npm ci --legacy-peer-deps --include=dev --no-audit --no-fund && npx vite build'
  systemctl restart ray
fi
EOF
sudo chmod 755 /usr/local/bin/ray-update
sudo tee /etc/systemd/system/ray-update.service >/dev/null <<'EOF'
[Unit]
Description=Update RAY from git
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ray-update
EOF
sudo tee /etc/systemd/system/ray-update.timer >/dev/null <<'EOF'
[Unit]
Description=Nightly RAY update
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

say "Firewall (Oracle's Ubuntu image blocks 80/443 by default)"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport "$p" -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now ray ray-update.timer
sudo systemctl restart ray caddy

say "Done"
cat <<EOF
RAY:      https://$DOMAIN   (first HTTPS certificate can take a minute)
Logs:     sudo journalctl -u ray -f
Settings: sudo nano $ENV_FILE   then   sudo systemctl restart ray

Still to do (see deploy/oracle/README.md):
  1. Oracle console → your VCN → Security List → add Ingress rules for TCP 80 and 443 from 0.0.0.0/0.
  2. Put your API keys in $ENV_FILE (same as Render) and restart.
  3. Google OAuth: add https://$DOMAIN/api/accounts/google/callback as a redirect URI.
  4. Reinstall the PC and phone bridges from https://$DOMAIN so they connect here.
EOF
