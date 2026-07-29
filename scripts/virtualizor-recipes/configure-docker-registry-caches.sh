#!/bin/bash
# Virtualizor Recipe: Configure Docker Hub registry-mirrors + insecure-registries
# for KumpeApps pull-through caches on the bot host.
#
# Runs automatically as root on new VMs (no arguments required).
# Edit BOT_CACHE_IP below before installing this recipe in Virtualizor.
#
# Hub images (busybox, etc.) use registry-mirrors — do NOT pull host:5000/library/...
# GHCR images are rewritten by the bot to BOT:5001/... and need insecure-registries.
#
# Safe to re-run on existing VMs.

set -euo pipefail

# --- edit once when installing the recipe in Virtualizor ---
BOT_CACHE_IP="172.16.20.11"
HUB_CACHE_PORT="5000"
GHCR_CACHE_PORT="5001"
DAEMON_JSON="/etc/docker/daemon.json"
# -----------------------------------------------------------

if [[ -z "${BOT_CACHE_IP}" || "${BOT_CACHE_IP}" == "CHANGE_ME" ]]; then
  echo "ERROR: set BOT_CACHE_IP at the top of this recipe script" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed on this VM" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to merge daemon.json" >&2
  exit 1
fi

HUB_MIRROR_URL="http://${BOT_CACHE_IP}:${HUB_CACHE_PORT}"
HUB_HOST="${BOT_CACHE_IP}:${HUB_CACHE_PORT}"
GHCR_HOST="${BOT_CACHE_IP}:${GHCR_CACHE_PORT}"

mkdir -p "$(dirname "${DAEMON_JSON}")"

if [[ -f "${DAEMON_JSON}" ]]; then
  EXISTING="$(cat "${DAEMON_JSON}")"
else
  EXISTING="{}"
fi

TMP_JSON="$(mktemp)"
TMP_FLAG="$(mktemp)"
trap 'rm -f "${TMP_JSON}" "${TMP_FLAG}"' EXIT

EXISTING="${EXISTING}" HUB_MIRROR_URL="${HUB_MIRROR_URL}" HUB_HOST="${HUB_HOST}" GHCR_HOST="${GHCR_HOST}" \
  python3 - "${TMP_JSON}" "${TMP_FLAG}" <<'PY'
import json, os, sys

out_json, out_flag = sys.argv[1], sys.argv[2]
existing = os.environ["EXISTING"].strip() or "{}"
hub_mirror = os.environ["HUB_MIRROR_URL"].rstrip("/")
hub_host = os.environ["HUB_HOST"]
ghcr_host = os.environ["GHCR_HOST"]

try:
    data = json.loads(existing)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}

changed = False

# Docker Hub pull-through only works as registry-mirrors (not direct host:port pulls).
mirrors = data.get("registry-mirrors") or []
if not isinstance(mirrors, list):
    mirrors = []
normalized = [str(m).rstrip("/") for m in mirrors]
if hub_mirror not in normalized:
    data["registry-mirrors"] = [hub_mirror]
    changed = True
else:
    data["registry-mirrors"] = [str(m).rstrip("/") for m in mirrors]

insecure = data.get("insecure-registries") or []
if not isinstance(insecure, list):
    insecure = []
for host in (hub_host, ghcr_host):
    if host not in insecure:
        insecure.append(host)
        changed = True
data["insecure-registries"] = insecure

with open(out_json, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(data, indent=2) + "\n")
with open(out_flag, "w", encoding="utf-8") as fh:
    fh.write("1" if changed else "0")
PY

install -m 644 "${TMP_JSON}" "${DAEMON_JSON}"
CHANGED="$(cat "${TMP_FLAG}")"

echo "Configured registry-mirrors: ${HUB_MIRROR_URL}"
echo "Configured insecure-registries: ${HUB_HOST}, ${GHCR_HOST}"
echo "Wrote ${DAEMON_JSON}"

if [[ "${CHANGED}" == "1" ]]; then
  echo "Restarting docker to apply daemon.json..."
  systemctl restart docker
else
  echo "daemon.json already up to date; docker restart skipped"
fi

docker info --format 'Registry Mirrors: {{json .RegistryConfig.Mirrors}}' || true
docker info --format 'Insecure registry hosts: {{range $k,$v := .RegistryConfig.IndexConfigs}}{{if not $v.Secure}}{{$k}} {{end}}{{end}}' || true
echo "Done."
