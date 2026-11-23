#!/usr/bin/env bash
# OCI Ubuntu VM にアプリを導入する。root または sudo で実行する。
# 使い方: sudo bash setup.sh <ドメイン> [certbot通知メール]
set -euo pipefail

DOMAIN="${1:?使い方: sudo bash setup.sh <ドメイン> [メールアドレス]}"
EMAIL="${2:-admin@${DOMAIN}}"
APP_DIR=/opt/receipt-expiry
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo 'root または sudo で実行してください。' >&2
  exit 1
fi

read -rsp 'Gemini API キー（共通キー）: ' API_KEY
echo
if [ -z "$API_KEY" ]; then
  echo 'APIキーが空です。BYOK のみで運用する場合はダミーを入力してください。' >&2
  exit 1
fi

read -rsp 'VAPID 公開鍵（プッシュ通知用、未設定なら空欄）: ' VAPID_PUBLIC_KEY
echo
read -rsp 'VAPID 秘密鍵（プッシュ通知用、未設定なら空欄）: ' VAPID_PRIVATE_KEY
echo
if [[ -n "$VAPID_PUBLIC_KEY" && -z "$VAPID_PRIVATE_KEY" ]] || [[ -z "$VAPID_PUBLIC_KEY" && -n "$VAPID_PRIVATE_KEY" ]]; then
  echo 'VAPID 公開鍵と秘密鍵は両方入力してください。' >&2
  exit 1
fi

apt-get update
apt-get install -y curl ca-certificates nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR"
cp -r "$REPO_ROOT/public" "$REPO_ROOT/functions" "$REPO_ROOT/oci" "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$APP_DIR/"

install -m 600 /dev/null /etc/receipt-expiry.env
escape_env() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}
{
  printf 'GEMINI_API_KEY="%s"\n' "$(escape_env "$API_KEY")"
  printf 'VAPID_PUBLIC_KEY="%s"\n' "$(escape_env "$VAPID_PUBLIC_KEY")"
  printf 'VAPID_PRIVATE_KEY="%s"\n' "$(escape_env "$VAPID_PRIVATE_KEY")"
  printf 'DATA_DIR=/var/lib/receipt-expiry\n'
} > /etc/receipt-expiry.env
mkdir -p /var/lib/receipt-expiry
chown www-data:www-data /var/lib/receipt-expiry

# web-push は本番依存。Playwright は dev なので omit=dev で十分。
(cd "$APP_DIR" && npm ci --omit=dev)

install -m 644 "$APP_DIR/oci/receipt-expiry.service" /etc/systemd/system/receipt-expiry.service
sed "s/YOUR_DOMAIN/${DOMAIN}/g" "$APP_DIR/oci/nginx.conf" > /etc/nginx/sites-available/receipt-expiry
ln -sfn /etc/nginx/sites-available/receipt-expiry /etc/nginx/sites-enabled/receipt-expiry
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl daemon-reload
systemctl enable --now receipt-expiry
if [[ -z "$VAPID_PUBLIC_KEY" ]]; then
  echo 'VAPID 鍵が未設定のため、プッシュ通知は無効です。' >&2
fi
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
fi

certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

systemctl status receipt-expiry --no-pager
echo
echo "完了: https://${DOMAIN}/"
echo "ログ: journalctl -u receipt-expiry -f"
