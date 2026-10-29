#!/usr/bin/env bash
# Self-hosted LiveKit for Summoners on an Ubuntu 24.04 box with a public IP (the trackaa Linode).
# Installs the livekit-server binary and Caddy, generates one API key pair, writes config and a
# systemd unit, terminates TLS on $HOST with Caddy (Let's Encrypt), opens the firewall for signaling
# and WebRTC media, and starts everything. Idempotent: re-running keeps the existing keys.
#
#   ssh -i ~/.ssh/trackaa_origin root@50.116.30.232 'bash -s 50-116-30-232.sslip.io' < deploy/livekit-linode.sh
#
# The hostname must resolve to this box. 50-116-30-232.sslip.io does without any DNS work; a real
# name (livekit.greg.kitchen, DNS-only A record to 50.116.30.232) is nicer and can replace it later
# by re-running with that name.
set -euo pipefail
HOST="${1:?usage: livekit-linode.sh <public-hostname>}"
export DEBIAN_FRONTEND=noninteractive

if ! command -v livekit-server >/dev/null 2>&1; then
  curl -sSL https://get.livekit.io | bash
fi
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq caddy
fi

mkdir -p /etc/livekit
if [ ! -f /etc/livekit/keys.env ]; then
  OUT="$(livekit-server generate-keys)"
  KEY="$(printf '%s\n' "$OUT" | awk '/API Key/ {print $NF}')"
  SECRET="$(printf '%s\n' "$OUT" | awk '/API Secret/ {print $NF}')"
  ( umask 077; printf 'LIVEKIT_URL=wss://%s\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$HOST" "$KEY" "$SECRET" > /etc/livekit/keys.env )
fi
# shellcheck disable=SC1091
. /etc/livekit/keys.env
sed -i "s#^LIVEKIT_URL=.*#LIVEKIT_URL=wss://${HOST}#" /etc/livekit/keys.env

( umask 077; cat > /etc/livekit/livekit.yaml <<EOF
# Signaling only on loopback; Caddy fronts it with TLS. Media goes straight to the public IP.
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
room:
  auto_create: true
  empty_timeout: 600
logging:
  level: info
EOF
)

cat > /etc/systemd/system/livekit.service <<'EOF'
[Unit]
Description=LiveKit server (Summoners)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
${HOST} {
	reverse_proxy 127.0.0.1:7880
}
EOF

ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 7881/tcp >/dev/null
ufw allow 50000:50200/udp >/dev/null

systemctl daemon-reload
systemctl enable --now livekit >/dev/null
systemctl restart livekit
systemctl enable --now caddy >/dev/null
systemctl restart caddy
sleep 3
echo "livekit: $(systemctl is-active livekit)  caddy: $(systemctl is-active caddy)  signaling: $(curl -s --max-time 5 http://127.0.0.1:7880 || echo down)"
echo "keys: /etc/livekit/keys.env (pull them with scripts/pull-livekit-keys.sh)"
