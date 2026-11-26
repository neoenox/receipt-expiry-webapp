#!/usr/bin/env bash
# Cloudflare Pages へ Direct Upload でデプロイする。
# 事前準備: npx wrangler@4 login  または CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定
set -euo pipefail

PROJECT_NAME="${1:-receipt-expiry-pwa}"
cd "$(dirname "$0")"

# Node 26 では wrangler@latest の依存が壊れるため v4 に固定する。
WRANGLER=(npx --yes wrangler@4)

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  AUTH_CHECK="$("${WRANGLER[@]}" whoami 2>&1 || true)"
  if grep -qiE 'not authenticated|not logged in' <<<"$AUTH_CHECK"; then
    echo "ERROR: Cloudflare に認証されていません。" >&2
    echo "  npx wrangler@4 login" >&2
    echo "  または CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定してください。" >&2
    exit 1
  fi
fi

# 既存プロジェクトは再利用する。
if ! CREATE_OUTPUT="$("${WRANGLER[@]}" pages project create "$PROJECT_NAME" --production-branch main 2>&1)"; then
  if grep -qiE 'already exist' <<<"$CREATE_OUTPUT"; then
    echo "プロジェクト ${PROJECT_NAME} は既に存在します。再利用します。"
  else
    echo "$CREATE_OUTPUT" >&2
    exit 1
  fi
fi

"${WRANGLER[@]}" pages deploy public --project-name="$PROJECT_NAME" --branch=main

if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  printf '%s' "$GEMINI_API_KEY" | "${WRANGLER[@]}" pages secret put GEMINI_API_KEY --project-name="$PROJECT_NAME"
else
  echo "共有キーを設定する場合は次を実行してください:"
  echo "  npx wrangler@4 pages secret put GEMINI_API_KEY --project-name=${PROJECT_NAME}"
fi

# リマインダ送信専用 Worker (Cron) をデプロイする。
"${WRANGLER[@]}" deploy --config wrangler.notify.toml

if [[ -n "${VAPID_PUBLIC_KEY:-}" ]]; then
  printf '%s' "$VAPID_PUBLIC_KEY" | "${WRANGLER[@]}" secret put VAPID_PUBLIC_KEY --config wrangler.notify.toml
fi
if [[ -n "${VAPID_PRIVATE_KEY:-}" ]]; then
  printf '%s' "$VAPID_PRIVATE_KEY" | "${WRANGLER[@]}" secret put VAPID_PRIVATE_KEY --config wrangler.notify.toml
else
  echo "プッシュ通知を使う場合は次を実行してください:"
  echo "  npx wrangler@4 secret put VAPID_PUBLIC_KEY --config wrangler.notify.toml"
  echo "  npx wrangler@4 secret put VAPID_PRIVATE_KEY --config wrangler.notify.toml"
fi

echo
echo "デプロイ完了: https://${PROJECT_NAME}.pages.dev"
