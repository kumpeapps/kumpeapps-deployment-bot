/**
 * Pure builders for remote VM deploy shell scripts (no app config / SSH side effects).
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build the shell lines that run an operator-configured post-deploy hook.
 * Runs only when the main compose step exits 0; hook exit code is logged but
 * does not override the deployment result.
 */
function buildPostDeployHookLines(remoteLogFile: string, postDeployHook?: string): string[] {
  if (!postDeployHook) return [];

  return [
    `if [ "$PIPE_EXIT" -eq 0 ]; then`,
    `  echo "--- Running post-deploy hook ---" | tee -a ${shellQuote(remoteLogFile)}`,
    `  { ${postDeployHook}; } 2>&1 | tee -a ${shellQuote(remoteLogFile)}`,
    `  HOOK_EXIT=$?`,
    `  if [ "$HOOK_EXIT" -ne 0 ]; then echo "Post-deploy hook exited $HOOK_EXIT" | tee -a ${shellQuote(remoteLogFile)}; fi`,
    `fi`,
  ];
}

/**
 * Ensure nebula_client is running without pulling or recreating it.
 * App deploys intentionally exclude nebula_client so a compose/env diff cannot bounce the VPN;
 * this step only starts a stopped client (or no-ops if already running / not in compose).
 */
export function buildEnsureNebulaClientLines(remoteLogFile: string): string[] {
  const log = shellQuote(remoteLogFile);

  return [
    `echo "Ensuring nebula_client is running..." | tee -a ${log}`,
    `if docker compose config --services 2>>${log} | grep -qx 'nebula_client'; then`,
    `  if docker compose ps --status running --services 2>>${log} | grep -qx 'nebula_client'; then`,
    `    echo "nebula_client already running" | tee -a ${log}`,
    `  else`,
    `    echo "nebula_client not running — starting without recreate" | tee -a ${log}`,
    `    { docker compose up -d --no-deps --no-recreate nebula_client; } 2>&1 | tee -a ${log}`,
    `    NEBULA_EXIT=\${PIPESTATUS[0]}`,
    `    if [ "$NEBULA_EXIT" -ne 0 ]; then`,
    `      echo "ERROR: failed to start nebula_client (exit $NEBULA_EXIT)" | tee -a ${log}`,
    `      PIPE_EXIT=$NEBULA_EXIT`,
    `    elif ! docker compose ps --status running --services 2>>${log} | grep -qx 'nebula_client'; then`,
    `      echo "ERROR: nebula_client is still not running after up" | tee -a ${log}`,
    `      PIPE_EXIT=1`,
    `    else`,
    `      echo "nebula_client is running" | tee -a ${log}`,
    `    fi`,
    `  fi`,
    `else`,
    `  echo "nebula_client not defined in compose — skipping" | tee -a ${log}`,
    `fi`,
  ];
}

export type VmDeployScriptInput = {
  remoteDir: string;
  remoteLogFile: string;
  remoteExitFile: string;
  /** When set, exported as DOCKER_CONFIG for the whole script (registry auth). */
  dockerConfigDir?: string;
  postDeployHook?: string;
};

/**
 * Shell lines that report whether registry auth is present and whether Docker Hub
 * credentials actually work — without printing secrets.
 */
export function buildRegistryAuthDiagnosticLines(remoteLogFile: string): string[] {
  const log = shellQuote(remoteLogFile);

  return [
    `echo "Checking registry auth..." | tee -a ${log}`,
    `if [ -z "\${DOCKER_CONFIG:-}" ] || [ ! -f "\$DOCKER_CONFIG/config.json" ]; then`,
    `  echo "WARNING: no Docker registry auth config on VM (anonymous pulls; Hub 429s likely)" | tee -a ${log}`,
    `else`,
    `  echo "DOCKER_CONFIG_FILE=\$DOCKER_CONFIG/config.json" | tee -a ${log}`,
    // Prefer python3 (common on deploy VMs); fall back to grep for keys only.
    `  if command -v python3 >/dev/null 2>&1; then`,
    `    python3 - <<'PY' 2>&1 | tee -a ${log}`,
    `import json, base64, os, ssl, urllib.error, urllib.request`,
    `cfg_path = os.path.join(os.environ["DOCKER_CONFIG"], "config.json")`,
    `auths = json.load(open(cfg_path)).get("auths") or {}`,
    `keys = sorted(auths.keys())`,
    `print("registry_auth_keys=" + (",".join(keys) if keys else "(none)"))`,
    `hub_key = "https://index.docker.io/v1/"`,
    `if hub_key not in auths:`,
    `    print("WARNING: Docker Hub auth key missing — expected https://index.docker.io/v1/ (aliases like docker.io are normalized by the bot)")`,
    `else:`,
    `    try:`,
    `        user_pass = base64.b64decode(auths[hub_key]["auth"]).decode("utf-8")`,
    `        username = user_pass.split(":", 1)[0]`,
    `        print("Docker Hub username=" + username)`,
    `        req = urllib.request.Request(`,
    `            "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/busybox:pull"`,
    `        )`,
    `        token = base64.b64encode(user_pass.encode("utf-8")).decode("ascii")`,
    `        req.add_header("Authorization", "Basic " + token)`,
    `        ctx = ssl.create_default_context()`,
    `        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:`,
    `            data = json.load(resp)`,
    `        if data.get("token") or data.get("access_token"):`,
    `            print("Docker Hub login OK")`,
    `        else:`,
    `            print("Docker Hub login FAILED: token response missing token")`,
    `    except urllib.error.HTTPError as exc:`,
    `        print(f"Docker Hub login FAILED: HTTP {exc.code}")`,
    `    except Exception as exc:`,
    `        print(f"Docker Hub login FAILED: {exc}")`,
    `PY`,
    `  else`,
    `    echo "registry_auth_keys=$(grep -oE '"[^"]+": \\{[^}]*"auth"' "\$DOCKER_CONFIG/config.json" | sed 's/": {.*"auth//' | tr -d '"' | paste -sd, - || echo '(parse failed)')" | tee -a ${log}`,
    `    if grep -q 'https://index.docker.io/v1/' "\$DOCKER_CONFIG/config.json"; then`,
    `      echo "Docker Hub auth key present (python3 unavailable — could not verify login)" | tee -a ${log}`,
    `    else`,
    `      echo "WARNING: Docker Hub auth key missing — expected https://index.docker.io/v1/" | tee -a ${log}`,
    `    fi`,
    `  fi`,
    `fi`,
  ];
}

/**
 * Build the remote bash script that runs inside a detached screen session.
 * Exports DOCKER_CONFIG once (never as a bare assignment after `timeout`), keeps a
 * persistent `.deploy-latest.log`, and retries compose pull with backoff for Hub 429s.
 */
export function buildVmDeployScript(input: VmDeployScriptInput): string {
  const log = shellQuote(input.remoteLogFile);
  const exitFile = shellQuote(input.remoteExitFile);
  const dir = shellQuote(input.remoteDir);
  const latestLog = shellQuote(`${input.remoteDir}/.deploy-latest.log`);
  const postDeployHookLines = buildPostDeployHookLines(input.remoteLogFile, input.postDeployHook);
  const ensureNebulaLines = buildEnsureNebulaClientLines(input.remoteLogFile);
  const registryAuthDiagLines = buildRegistryAuthDiagnosticLines(input.remoteLogFile);

  const dockerConfigExport = input.dockerConfigDir
    ? [
        `export DOCKER_CONFIG=${shellQuote(input.dockerConfigDir)}`,
        `echo "DOCKER_CONFIG=$DOCKER_CONFIG" | tee -a ${log}`,
      ]
    : [`echo "DOCKER_CONFIG=(default)" | tee -a ${log}`];

  return [
    "#!/bin/bash",
    "set -o pipefail",
    // screen sessions often get a minimal PATH; ensure docker is reachable.
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    `cd ${dir}`,
    `rm -f ${exitFile} ${log}`,
    "PIPE_EXIT=1",
    `write_exit() { echo "$PIPE_EXIT" > ${exitFile}; cp -f ${log} ${latestLog} 2>/dev/null || true; }`,
    "trap write_exit EXIT",
    `echo "=== deploy started $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" > ${log}`,
    `echo "remote_dir=${dir}" | tee -a ${log}`,
    `echo "PATH=$PATH" | tee -a ${log}`,
    `command -v docker | tee -a ${log}`,
    `docker version --format '{{.Server.Version}}' 2>&1 | tee -a ${log} || true`,
    ...dockerConfigExport,
    ...registryAuthDiagLines,
    `echo "Resolving compose services (excluding nebula_client)..." | tee -a ${log}`,
    // No `timeout` wrapper here: pairing timeout with env assignments previously caused
    // instant failure (timeout treated DOCKER_CONFIG=… as the command). Config is fast;
    // hung docker is surfaced by the poller's idle/max limits instead.
    `ALL_SERVICES_RAW=$(docker compose config --services 2>>${log}) && CONFIG_EXIT=0 || CONFIG_EXIT=$?`,
    `if [ "$CONFIG_EXIT" -ne 0 ]; then`,
    `  echo "ERROR: docker compose config --services failed (exit $CONFIG_EXIT)" | tee -a ${log}`,
    `  PIPE_EXIT=$CONFIG_EXIT`,
    `  exit $PIPE_EXIT`,
    `fi`,
    `ALL_SERVICES=$(printf '%s\\n' "$ALL_SERVICES_RAW" | tr '\\n' ' ' | xargs || true)`,
    `APP_SERVICES=$(printf '%s\\n' "$ALL_SERVICES_RAW" | grep -v '^nebula_client$' | tr '\\n' ' ' | xargs || true)`,
    `echo "ALL_SERVICES=$ALL_SERVICES" | tee -a ${log}`,
    `echo "APP_SERVICES=$APP_SERVICES" | tee -a ${log}`,
    `if [ -n "$APP_SERVICES" ]; then`,
    // Docker Hub anonymous pulls often 429; retry with backoff before giving up.
    // Prefer authenticating via registry_auth for docker.io to raise Hub rate limits.
    `  PULL_MAX_ATTEMPTS=5`,
    `  PULL_SLEEP=15`,
    `  PULL_ATTEMPT=1`,
    `  PULL_EXIT=1`,
    `  while [ "$PULL_ATTEMPT" -le "$PULL_MAX_ATTEMPTS" ]; do`,
    `    echo "Pulling: $APP_SERVICES (attempt $PULL_ATTEMPT/$PULL_MAX_ATTEMPTS)" | tee -a ${log}`,
    `    { docker compose pull $APP_SERVICES; } 2>&1 | tee -a ${log}`,
    `    PULL_EXIT=\${PIPESTATUS[0]}`,
    `    if [ "$PULL_EXIT" -eq 0 ]; then`,
    `      break`,
    `    fi`,
    `    if [ "$PULL_ATTEMPT" -ge "$PULL_MAX_ATTEMPTS" ]; then`,
    `      echo "ERROR: compose pull failed after $PULL_MAX_ATTEMPTS attempts (exit $PULL_EXIT)" | tee -a ${log}`,
    `      break`,
    `    fi`,
    `    echo "Pull failed (exit $PULL_EXIT) — retrying pull after \${PULL_SLEEP}s (rate-limit/429 backoff)" | tee -a ${log}`,
    `    sleep "$PULL_SLEEP"`,
    `    PULL_SLEEP=$((PULL_SLEEP * 2))`,
    `    PULL_ATTEMPT=$((PULL_ATTEMPT + 1))`,
    `  done`,
    `  echo "Starting: $APP_SERVICES (pull exit=$PULL_EXIT)" | tee -a ${log}`,
    `  { docker compose up -d --no-deps $APP_SERVICES; } 2>&1 | tee -a ${log}`,
    `  UP_EXIT=\${PIPESTATUS[0]}`,
    `  if [ "$PULL_EXIT" -ne 0 ] || [ "$UP_EXIT" -ne 0 ]; then`,
    `    echo "ERROR: compose pull/up failed (pull=$PULL_EXIT up=$UP_EXIT)" | tee -a ${log}`,
    `    PIPE_EXIT=1`,
    `  else`,
    `    PIPE_EXIT=0`,
    `  fi`,
    `elif [ "$ALL_SERVICES" = "nebula_client" ]; then`,
    `  echo "Compose has only nebula_client — skipping app pull/up" | tee -a ${log}`,
    `  PIPE_EXIT=0`,
    `else`,
    `  echo "ERROR: no app services resolved from compose config (ALL_SERVICES='$ALL_SERVICES')" | tee -a ${log}`,
    `  PIPE_EXIT=1`,
    `  exit $PIPE_EXIT`,
    `fi`,
    `if [ "$PIPE_EXIT" -eq 0 ]; then`,
    `  docker image prune -f 2>&1 | tee -a ${log}`,
    `fi`,
    ...ensureNebulaLines,
    ...postDeployHookLines,
    `exit $PIPE_EXIT`,
  ].join("\n");
}

/**
 * Start (or replace) a detached screen session running the deploy script via /bin/bash,
 * with GNU screen output logging so the session transcript survives after exit.
 */
export function buildScreenStartCommand(
  sessionName: string,
  remoteScriptFile: string,
  remoteExitFile: string,
  screenLogFile: string,
  latestScreenLogFile: string
): string {
  const script = shellQuote(remoteScriptFile);
  const exitFile = shellQuote(remoteExitFile);
  const session = shellQuote(sessionName);
  const screenLog = shellQuote(screenLogFile);
  const latestScreenLog = shellQuote(latestScreenLogFile);
  return [
    `screen -S ${sessionName} -X quit 2>/dev/null || true`,
    `rm -f ${screenLog}`,
    // -L/-Logfile capture everything printed in the screen window (survives session exit).
    `screen -L -Logfile ${screenLog} -dmS ${sessionName} /bin/bash ${script}`,
    "sleep 1",
    `if screen -ls 2>/dev/null | grep -F ${session} >/dev/null; then`,
    "  :",
    `elif [ -f ${exitFile} ]; then`,
    "  :",
    "else",
    `  echo "ERROR: screen session ${sessionName} failed to start" >&2`,
    "  screen -ls >&2 || true",
    `  if [ -f ${screenLog} ]; then echo '--- screen log ---' >&2; cat ${screenLog} >&2; fi`,
    "  exit 1",
    "fi",
    // Soft-link/copy path name for operators; refreshed again when polling finishes.
    `cp -f ${screenLog} ${latestScreenLog} 2>/dev/null || true`,
  ].join("\n");
}

export type VmDeployPollScriptInput = {
  remoteLogFile: string;
  remoteExitFile: string;
  remoteScriptFile: string;
  screenLogFile: string;
  latestScreenLogFile: string;
  sessionName: string;
  /** Seconds with no screen session / no log growth before treating the deploy as stuck. */
  idleTimeoutSecs: number;
  /** Absolute ceiling while a live screen session may continue pulling large images. */
  maxTimeoutSecs: number;
  /** @deprecated Use idleTimeoutSecs / maxTimeoutSecs. Kept for older call sites. */
  pollTimeoutSecs?: number;
};

/**
 * Poll for the deploy exit file.
 * While the screen session is alive (e.g. a long image pull), keep waiting up to maxTimeoutSecs.
 * If the session dies without an exit file, fail after idleTimeoutSecs of no progress.
 * Preserves `.deploy-latest.log` and `.deploy-latest.screen.log` for SSH debugging.
 */
export function buildVmDeployPollScript(input: VmDeployPollScriptInput): string {
  const log = shellQuote(input.remoteLogFile);
  const exitFile = shellQuote(input.remoteExitFile);
  const script = shellQuote(input.remoteScriptFile);
  const screenLog = shellQuote(input.screenLogFile);
  const latestScreenLog = shellQuote(input.latestScreenLogFile);
  const session = shellQuote(input.sessionName);
  const { sessionName } = input;
  const idleTimeoutSecs = Math.max(60, input.idleTimeoutSecs);
  const maxTimeoutSecs = Math.max(idleTimeoutSecs, input.maxTimeoutSecs);

  return [
    "ELAPSED=0",
    "IDLE_SECS=0",
    "LAST_LOG_SIZE=-1",
    `while [ ! -f ${exitFile} ] && [ "$ELAPSED" -lt ${maxTimeoutSecs} ]; do`,
    "  sleep 5",
    "  ELAPSED=$((ELAPSED + 5))",
    `  if screen -ls 2>/dev/null | grep -F ${session} >/dev/null; then`,
    "    IDLE_SECS=0",
    `  elif [ -f ${log} ]; then`,
    `    LOG_SIZE=$(wc -c < ${log} 2>/dev/null || echo 0)`,
    `    if [ "$LOG_SIZE" != "$LAST_LOG_SIZE" ]; then`,
    "      LAST_LOG_SIZE=$LOG_SIZE",
    "      IDLE_SECS=0",
    "    else",
    "      IDLE_SECS=$((IDLE_SECS + 5))",
    "    fi",
    "  else",
    "    IDLE_SECS=$((IDLE_SECS + 5))",
    "  fi",
    `  if [ "$IDLE_SECS" -ge ${idleTimeoutSecs} ]; then`,
    "    break",
    "  fi",
    "done",
    // Always refresh the durable screen transcript for operators.
    `cp -f ${screenLog} ${latestScreenLog} 2>/dev/null || true`,
    `if [ -f ${exitFile} ]; then`,
    `  EXIT_CODE=$(cat ${exitFile})`,
    `  echo '--- deploy log ---'`,
    `  cat ${log} 2>/dev/null || true`,
    `  echo '--- screen log ---'`,
    `  cat ${screenLog} 2>/dev/null || echo '(no screen log)'`,
    // Remove per-run artifacts; keep .deploy-latest.log and .deploy-latest.screen.log.
    `  rm -f ${script} ${log} ${exitFile} ${screenLog}`,
    `  exit "$EXIT_CODE"`,
    "else",
    `  printf 'Timed out after %ds (idle %ds / max %ds) — docker compose may still be running in screen session: %s\\n' "$ELAPSED" "$IDLE_SECS" ${maxTimeoutSecs} ${sessionName}`,
    `  echo '--- screen sessions ---'`,
    "  screen -ls 2>&1 || true",
    `  echo '--- deploy artifacts ---'`,
    `  ls -la ${script} ${log} ${exitFile} ${screenLog} 2>&1 || true`,
    `  echo '--- deploy log ---'`,
    `  if [ -f ${log} ]; then cat ${log}; else echo '(no log file — deploy script may not have started)'; fi`,
    `  echo '--- screen log ---'`,
    `  if [ -f ${screenLog} ]; then cat ${screenLog}; else echo '(no screen log)'; fi`,
    "  exit 1",
    "fi",
  ].join("\n");
}
