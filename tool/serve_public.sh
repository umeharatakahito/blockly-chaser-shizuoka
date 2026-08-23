#!/bin/bash
#
# サーバーを起動し、Cloudflare Tunnel で公開する。
#
#   ./tool/serve_public.sh
#
# ADMIN_KEY を指定しない場合は自動生成する。
# 大会をまたいで同じ合言葉を使いたい場合は環境変数で渡す。
#
#   ADMIN_KEY=好きな合言葉 ./tool/serve_public.sh
#
# 終了は Ctrl+C。サーバーとトンネルの両方が止まる。

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3100}"

if [ -z "${ADMIN_KEY:-}" ]; then
  ADMIN_KEY=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  echo "ADMIN_KEY を自動生成しました。"
fi
export ADMIN_KEY PORT

LOG_DIR=$(mktemp -d)
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

cleanup() {
  echo ""
  echo "停止します..."
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "停止しました。公開URLは無効になりました。"
}
trap cleanup EXIT INT TERM

# --- サーバー ---
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "エラー: ポート $PORT は既に使われています。" >&2
  echo "  使用中のプロセス: $(lsof -ti:"$PORT" | tr '\n' ' ')" >&2
  echo "  別のポートを使う場合: PORT=3200 $0" >&2
  exit 1
fi

echo "サーバーを起動しています (ポート $PORT)..."
node ./bin/www > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  sleep 1
  if curl -sf -m 3 -o /dev/null "http://localhost:$PORT/"; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "エラー: サーバーが起動できませんでした。" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  if [ "$i" -eq 30 ]; then echo "エラー: サーバーの応答がありません。" >&2; exit 1; fi
done
echo "  起動しました"

# --- トンネル ---
echo "Cloudflare Tunnel を開いています..."
cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for i in $(seq 1 60); do
  sleep 1
  PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "エラー: トンネルを開けませんでした。" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
done

if [ -z "$PUBLIC_URL" ]; then
  echo "エラー: 公開URLを取得できませんでした。" >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '取得できません')

cat <<MSG

============================================================
  公開URL (参加者に伝える)
    $PUBLIC_URL

  会場LAN内から
    http://$LAN_IP:$PORT/

  運営用の合言葉 (参加者には渡さない)
    $ADMIN_KEY

    対戦表の管理  $PUBLIC_URL/tournament/admin
    動画の管理    $PUBLIC_URL/movies/admin
============================================================

このURLは cloudflared を止めるまで有効です。
Mac がスリープすると切れるので、長時間動かす場合は別のターミナルで
  caffeinate -s -w $$
を実行しておいてください。

試合ができるか確認する場合は、別のターミナルで
  node tool/tunnel_check.js $PUBLIC_URL

終了するには Ctrl+C を押してください。
MSG

wait "$TUNNEL_PID"
