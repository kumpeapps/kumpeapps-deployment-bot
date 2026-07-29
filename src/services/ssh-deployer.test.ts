import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDockerConfigContent,
  DOCKER_HUB_CONFIG_KEY,
  normalizeDockerRegistryKey
} from "./docker-registry-auth.js";
import {
  buildScreenStartCommand,
  buildVmDeployPollScript,
  buildVmDeployScript
} from "./ssh-deploy-scripts.js";

const paths = {
  remoteDir: "/home/kumpeapps-bot-deploy",
  remoteLogFile: "/home/kumpeapps-bot-deploy/.deploy-kumpeapps-deploy-1.log",
  remoteExitFile: "/home/kumpeapps-bot-deploy/.deploy-kumpeapps-deploy-1.exit",
  remoteScriptFile: "/home/kumpeapps-bot-deploy/.deploy-kumpeapps-deploy-1.sh",
  screenLogFile: "/home/kumpeapps-bot-deploy/.deploy-kumpeapps-deploy-1.screen.log",
  latestScreenLogFile: "/home/kumpeapps-bot-deploy/.deploy-latest.screen.log",
  sessionName: "kumpeapps-deploy-1",
  idleTimeoutSecs: 600,
  maxTimeoutSecs: 3600
};

describe("normalizeDockerRegistryKey", () => {
  it("maps Docker Hub aliases to the config.json key Docker expects", () => {
    for (const alias of ["docker.io", "index.docker.io", "registry-1.docker.io", "https://index.docker.io/v1/"]) {
      assert.equal(normalizeDockerRegistryKey(alias), DOCKER_HUB_CONFIG_KEY);
    }
  });

  it("keeps non-Hub registries as hostnames", () => {
    assert.equal(normalizeDockerRegistryKey("ghcr.io"), "ghcr.io");
    assert.equal(normalizeDockerRegistryKey("https://ghcr.io"), "ghcr.io");
  });
});

describe("buildDockerConfigContent", () => {
  it("stores Hub auth under https://index.docker.io/v1/ even when configured as docker.io", () => {
    const parsed = JSON.parse(
      buildDockerConfigContent([{ registry: "docker.io", username: "alice", password: "secret" }])
    );
    assert.ok(parsed.auths[DOCKER_HUB_CONFIG_KEY]);
    assert.equal(parsed.auths[DOCKER_HUB_CONFIG_KEY].auth, Buffer.from("alice:secret").toString("base64"));
    assert.equal(parsed.auths["docker.io"], undefined);
  });
});

describe("buildVmDeployScript", () => {
  it("writes a start marker to the log before any docker compose commands", () => {
    const script = buildVmDeployScript(paths);
    const startIdx = script.indexOf("deploy started");
    const composeIdx = script.indexOf("docker compose config");
    assert.ok(startIdx >= 0, "expected deploy started log marker");
    assert.ok(composeIdx > startIdx, "log marker must precede docker compose config");
  });

  it("installs an EXIT trap that writes exit file and copies a persistent latest log", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /trap write_exit EXIT/);
    assert.match(script, /write_exit\(\)/);
    assert.ok(script.includes(paths.remoteExitFile));
    assert.match(script, /\.deploy-latest\.log/);
    assert.match(script, /cp -f/);
  });

  it("does not wrap compose config in timeout (avoids DOCKER_CONFIG assignment bugs)", () => {
    const script = buildVmDeployScript({
      ...paths,
      dockerConfigDir: "/home/kumpeapps-bot-deploy/.docker"
    });
    assert.match(script, /export DOCKER_CONFIG='\/home\/kumpeapps-bot-deploy\/\.docker'/);
    assert.equal(script.includes("CONFIG_TIMEOUT"), false);
    assert.equal(script.includes("timeout 60"), false);
    assert.match(script, /docker compose config --services/);
  });

  it("excludes nebula_client from app pull/up but still ensures it is running", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /grep -v '\^nebula_client\$'/);
    assert.match(script, /docker compose up -d --no-deps \$APP_SERVICES/);
    assert.equal(script.includes("--pull never"), false);
    assert.match(script, /Ensuring nebula_client is running/);
    assert.match(script, /docker compose up -d --no-deps --no-recreate nebula_client/);
    const excludeIdx = script.indexOf("grep -v '^nebula_client$'");
    const ensureIdx = script.indexOf("Ensuring nebula_client is running");
    assert.ok(excludeIdx >= 0 && ensureIdx > excludeIdx, "ensure step must run after app services");
  });

  it("fails the deploy when compose config yields no app services (unless only nebula_client)", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /ALL_SERVICES=/);
    assert.match(script, /CONFIG_EXIT/);
    assert.match(script, /docker compose config --services failed/);
    assert.match(script, /no app services resolved/);
    assert.match(script, /only nebula_client/);
  });

  it("always pulls then ups, and fails if either pull or up fails", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /PULL_EXIT=/);
    assert.match(script, /UP_EXIT=/);
    assert.equal(script.includes("--pull never"), false);
    assert.match(script, /docker compose pull \$APP_SERVICES/);
    assert.match(script, /docker compose up -d --no-deps \$APP_SERVICES/);
    assert.match(script, /compose pull\/up failed/);
  });

  it("logs registry auth status so operators can tell if Docker Hub login applied", () => {
    const script = buildVmDeployScript({
      ...paths,
      dockerConfigDir: "/home/kumpeapps-bot-deploy/.docker"
    });
    assert.match(script, /registry_auth_keys=/);
    assert.match(script, /Docker Hub login/);
    assert.match(script, /index\.docker\.io\/v1/);
  });

  it("warns when DOCKER_CONFIG is unset so anonymous Hub pulls are obvious", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /DOCKER_CONFIG=\(default\)/);
    assert.match(script, /no Docker registry auth config/);
  });

  it("retries compose pull with backoff to survive Docker Hub 429s", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /PULL_ATTEMPT=/);
    assert.match(script, /PULL_MAX_ATTEMPTS=/);
    assert.match(script, /sleep "\$PULL_SLEEP"/);
    assert.match(script, /rate-limit\/429 backoff/);
  });

  it("exports a sane PATH so docker is found inside screen", () => {
    const script = buildVmDeployScript(paths);
    assert.match(script, /export PATH="\/usr\/local\/sbin:/);
    assert.match(script, /command -v docker/);
  });
});

describe("buildScreenStartCommand", () => {
  it("enables screen logfile capture and verifies the session or exit file", () => {
    const cmd = buildScreenStartCommand(
      paths.sessionName,
      paths.remoteScriptFile,
      paths.remoteExitFile,
      paths.screenLogFile,
      paths.latestScreenLogFile
    );
    assert.match(cmd, /screen -L -Logfile/);
    assert.ok(cmd.includes(paths.screenLogFile));
    assert.ok(cmd.includes(paths.latestScreenLogFile));
    assert.match(cmd, /-dmS kumpeapps-deploy-1 \/bin\/bash/);
    assert.ok(cmd.includes(paths.remoteScriptFile));
    assert.match(cmd, /screen -ls/);
    assert.ok(cmd.includes(paths.remoteExitFile));
    assert.match(cmd, /failed to start/);
  });
});

describe("buildVmDeployPollScript", () => {
  it("keeps waiting while the screen session is alive so slow image pulls do not time out", () => {
    const script = buildVmDeployPollScript(paths);
    assert.match(script, /screen -ls/);
    assert.match(script, /IDLE_SECS/);
    assert.ok(script.includes(String(paths.idleTimeoutSecs)));
    assert.ok(script.includes(String(paths.maxTimeoutSecs)));
    assert.match(script, /grep -F/);
    assert.match(script, /IDLE_SECS=0/);
  });

  it("emits deploy and screen log diagnostics on timeout", () => {
    const script = buildVmDeployPollScript(paths);
    assert.match(script, /Timed out after/);
    assert.match(script, /--- screen sessions ---/);
    assert.match(script, /--- deploy artifacts ---/);
    assert.match(script, /--- deploy log ---/);
    assert.match(script, /--- screen log ---/);
    assert.ok(script.includes(paths.remoteLogFile));
    assert.ok(script.includes(paths.screenLogFile));
    assert.ok(script.includes(paths.latestScreenLogFile));
  });

  it("returns the remote exit code, prints both logs, and keeps latest screen log", () => {
    const script = buildVmDeployPollScript(paths);
    assert.match(script, /EXIT_CODE=\$\(cat/);
    assert.match(script, /--- screen log ---/);
    assert.match(script, /cp -f/);
    assert.match(script, /\.deploy-latest\.screen\.log/);
    assert.match(script, /rm -f/);
    assert.ok(script.includes(paths.remoteScriptFile));
  });
});
