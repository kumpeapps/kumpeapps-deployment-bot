#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_API_TOKEN:-${ADMIN_TOKEN:-}}"
RUN_OPTIONAL_EXTENDED="${SMOKE_EXTENDED:-false}"

echo "[smoke] base url: ${BASE_URL}"

check_http_200() {
  local name="$1"
  local url="$2"
  local out
  out="$(curl -fsS "$url")"
  if [[ -z "$out" ]]; then
    echo "[smoke] ${name}: empty response"
    return 1
  fi
  echo "[smoke] ${name}: ok"
}

check_contains() {
  local name="$1"
  local content="$2"
  local needle="$3"
  if [[ "$content" != *"$needle"* ]]; then
    echo "[smoke] ${name}: expected to contain '${needle}'"
    return 1
  fi
  echo "[smoke] ${name}: contains '${needle}'"
}

health_json="$(curl -fsS "${BASE_URL}/health")"
check_contains "health" "$health_json" '"status":"ok"'

health_db_json="$(curl -fsS "${BASE_URL}/health/db")"
check_contains "health/db" "$health_db_json" '"status":"ok"'

metrics_text="$(curl -fsS "${BASE_URL}/metrics")"
check_contains "metrics" "$metrics_text" "system_alert_requires_attention_flag"

register_payload="{\"githubUsername\":\"smoke-user-$(date +%s)\"}"
register_json="$(curl -fsS -X POST "${BASE_URL}/api/register" -H "content-type: application/json" -d "$register_payload")"
check_contains "register" "$register_json" '"status":"pending"'

if [[ -n "$ADMIN_TOKEN" ]]; then
  queue_stats_json="$(curl -fsS "${BASE_URL}/api/admin/queue-stats" -H "x-admin-token: ${ADMIN_TOKEN}")"
  check_contains "admin queue stats" "$queue_stats_json" '"current"'

  queue_alerts_json="$(curl -fsS "${BASE_URL}/api/admin/queue-alerts?limit=5" -H "x-admin-token: ${ADMIN_TOKEN}")"
  check_contains "admin queue alerts" "$queue_alerts_json" '"recent"'

  audit_json="$(curl -fsS "${BASE_URL}/api/admin/audit-events?limit=5" -H "x-admin-token: ${ADMIN_TOKEN}")"
  check_contains "admin audit events" "$audit_json" '"events"'
else
  echo "[smoke] ADMIN_API_TOKEN not set; skipping admin-protected checks"
fi

if [[ "$RUN_OPTIONAL_EXTENDED" == "true" ]]; then
  echo "[smoke] running optional extended checks"

  if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
    echo "[smoke] WEBHOOK_SECRET missing; skipping webhook receive check"
  else
    payload='{"zen":"Keep it logically awesome."}'
    signature="$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')"
    webhook_resp="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/github/webhook" \
      -H "content-type: application/json" \
      -H "x-github-event: ping" \
      -H "x-github-delivery: smoke-$(date +%s)" \
      -H "x-hub-signature-256: sha256=${signature}" \
      -d "$payload")"
    if [[ "$webhook_resp" != "202" && "$webhook_resp" != "200" ]]; then
      echo "[smoke] webhook receive failed with status ${webhook_resp}"
      exit 1
    fi
    echo "[smoke] webhook receive: ok (${webhook_resp})"
  fi
fi

echo "[smoke] completed successfully"
