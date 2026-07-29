import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { appConfig } from "../config.js";
import { recordSshCommandAttempt, recordSshCommandFinalFailure, recordSshCommandSuccess } from "./ssh-health.js";
import {
  buildScreenStartCommand,
  buildVmDeployPollScript,
  buildVmDeployScript
} from "./ssh-deploy-scripts.js";
import { buildDockerConfigContent } from "./docker-registry-auth.js";
import { insecureRegistryHostsFromDockerInfo, registryMirrorsFromDockerInfo } from "./docker-registry-mirror.js";

export {
  buildEnsureNebulaClientLines,
  buildScreenStartCommand,
  buildVmDeployPollScript,
  buildVmDeployScript
} from "./ssh-deploy-scripts.js";
export type { VmDeployPollScriptInput, VmDeployScriptInput } from "./ssh-deploy-scripts.js";

export type VmDeployInput = {
  vmHostname: string;
  vmIp: string;
  composeConfig: string;
  envValues: Record<string, string>;
  registryLogins?: Array<{
    registry: string;
    username: string;
    password: string;
  }>;
  dryRun: boolean;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  remoteBaseDir: string;
  /** Shell command to run on the VM after a successful docker compose up -d (e.g. restart a separate Nebula service). */
  postDeployHook?: string;
};

export type CaddyDeployInput = {
  caddyHost: string;
  caddyConfig: Record<string, string>;
  domains: string[];
  dryRun: boolean;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  remoteConfigDir: string;
  validateCommand?: string;
  reloadCommand: string;
  // Added for unique file naming
  repositoryOwner: string;
  repositoryName: string;
  environment: string;
};

const execFileAsync = promisify(execFile);

type RemoteCommandOptions = {
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  host: string;
};

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as { code?: string; message?: string };
  if (err.code === "ETIMEDOUT") {
    return true;
  }

  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return message.includes("timed out") || message.includes("timeout");
}

function envFileContent(envValues: Record<string, string>): string {
  return Object.entries(envValues)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}

function commonSshArgs(input: { sshKeyPath: string; sshPort: number }): string[] {
  return [
    "-i",
    input.sshKeyPath,
    "-p",
    String(input.sshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${appConfig.SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    `StrictHostKeyChecking=${appConfig.SSH_STRICT_HOST_KEY_CHECKING}`,
    "-o",
    `UserKnownHostsFile=${appConfig.SSH_KNOWN_HOSTS_PATH}`
  ];
}

function commonScpArgs(input: { sshKeyPath: string; sshPort: number }): string[] {
  return [
    "-i",
    input.sshKeyPath,
    "-P", // SCP uses uppercase -P for port
    String(input.sshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${appConfig.SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    `StrictHostKeyChecking=${appConfig.SSH_STRICT_HOST_KEY_CHECKING}`,
    "-o",
    `UserKnownHostsFile=${appConfig.SSH_KNOWN_HOSTS_PATH}`
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function runCommand(command: string, args: string[], timeoutMs?: number): Promise<{ stdout: string }> {
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = appConfig.SSH_COMMAND_RETRIES + 1;
  const resolvedTimeout = timeoutMs ?? appConfig.SSH_CONNECT_TIMEOUT_SECONDS * 1000;

  while (attempt < maxAttempts) {
    recordSshCommandAttempt({ isRetry: attempt > 0 });
    try {
      const { stdout } = await execFileAsync(command, args, {
        maxBuffer: 1024 * 1024,
        timeout: resolvedTimeout
      });
      recordSshCommandSuccess();
      return { stdout };
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  recordSshCommandFinalFailure({
    timedOut: isTimeoutError(lastError)
  });

  if (lastError instanceof Error) {
    const maybeStdout = "stdout" in lastError ? String((lastError as { stdout?: unknown }).stdout ?? "") : "";
    const maybeStderr = "stderr" in lastError ? String((lastError as { stderr?: unknown }).stderr ?? "") : "";
    
    // Build detailed error message with both stdout and stderr
    let errorMessage = lastError.message;
    if (maybeStdout.trim()) {
      errorMessage += ` | stdout: ${maybeStdout.trim()}`;
    }
    if (maybeStderr.trim()) {
      errorMessage += ` | stderr: ${maybeStderr.trim()}`;
    }
    
    throw new Error(errorMessage);
  }

  throw new Error("Command execution failed");
}

async function runRemoteSsh(input: RemoteCommandOptions, remoteCommand: string, timeoutMs?: number): Promise<{ stdout: string }> {
  return runCommand("ssh", [...commonSshArgs({ sshKeyPath: input.sshKeyPath, sshPort: input.sshPort }), `${input.sshUser}@${input.host}`, remoteCommand], timeoutMs);
}

async function copyToRemote(input: RemoteCommandOptions, localPath: string, remotePath: string): Promise<void> {
  await runCommand("scp", [...commonScpArgs({ sshKeyPath: input.sshKeyPath, sshPort: input.sshPort }), localPath, `${input.sshUser}@${input.host}:${remotePath}`]);
}

/**
 * Probe docker RegistryConfig via `docker info` (no sudo / daemon.json access required).
 * Returns empty sets on failure so callers skip mirror usage (safe fallback).
 */
export async function probeVmDockerRegistryConfig(input: {
  vmIp: string;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  dryRun?: boolean;
}): Promise<{ insecureHosts: Set<string>; registryMirrors: string[] }> {
  if (input.dryRun) {
    return { insecureHosts: new Set(), registryMirrors: [] };
  }

  try {
    const { stdout } = await runRemoteSsh(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.vmIp
      },
      "docker info --format '{{json .RegistryConfig}}' 2>/dev/null || echo '{}'"
    );
    const raw = stdout.trim() || "{}";
    return {
      insecureHosts: insecureRegistryHostsFromDockerInfo(raw),
      registryMirrors: registryMirrorsFromDockerInfo(raw)
    };
  } catch {
    return { insecureHosts: new Set(), registryMirrors: [] };
  }
}

/** @deprecated Use probeVmDockerRegistryConfig */
export async function probeVmInsecureRegistryHosts(input: {
  vmIp: string;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  dryRun?: boolean;
}): Promise<Set<string>> {
  const { insecureHosts } = await probeVmDockerRegistryConfig(input);
  return insecureHosts;
}

export async function deployComposeToVm(input: VmDeployInput): Promise<string> {
  if (input.dryRun) {
    return "(dry run — no SSH commands executed)";
  }

  const workDir = await mkdtemp(join(tmpdir(), "kumpeapps-vm-deploy-"));
  const composePath = join(workDir, "docker-compose.yml");
  const envPath = join(workDir, ".env");
  const remoteDir = input.remoteBaseDir;
  const dockerConfigPath = join(workDir, "docker-config.json");
  const hasRegistryLogins = (input.registryLogins?.length ?? 0) > 0;

  try {
    await writeFile(composePath, input.composeConfig, "utf8");
    await writeFile(envPath, envFileContent(input.envValues), "utf8");
    if (hasRegistryLogins && input.registryLogins) {
      await writeFile(dockerConfigPath, buildDockerConfigContent(input.registryLogins), "utf8");
    }

    await runRemoteSsh(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.vmIp
      },
      `mkdir -p ${remoteDir}`
    );

    // Check if this is a new deployment (no existing docker-compose.yml)
    let isNewDeployment = false;
    try {
      await runRemoteSsh(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.vmIp
        },
        `test -f ${remoteDir}/docker-compose.yml`
      );
    } catch {
      isNewDeployment = true;
    }

    await copyToRemote(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.vmIp
      },
      composePath,
      `${remoteDir}/docker-compose.yml`
    );
    await copyToRemote(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.vmIp
      },
      envPath,
      `${remoteDir}/.env`
    );

    if (hasRegistryLogins) {
      await runRemoteSsh(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.vmIp
        },
        `mkdir -p ${remoteDir}/.docker`
      );

      await copyToRemote(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.vmIp
        },
        dockerConfigPath,
        `${remoteDir}/.docker/config.json`
      );
    }

    const dockerConfigDir = hasRegistryLogins ? `${remoteDir}/.docker` : undefined;

    // Build a deploy script that runs docker compose pull + up -d inside a screen session.
    // Running inside screen means the docker commands survive SSH disconnects; we then poll
    // via a separate SSH connection until the screen session finishes.
    // Use a timestamp-suffixed session name so concurrent deployments on the same VM
    // don't collide with each other or accidentally terminate each other's sessions.
    const sessionName = `kumpeapps-deploy-${Date.now()}`;
    const remoteLogFile = `${remoteDir}/.deploy-${sessionName}.log`;
    const remoteExitFile = `${remoteDir}/.deploy-${sessionName}.exit`;
    const remoteScriptFile = `${remoteDir}/.deploy-${sessionName}.sh`;
    const remoteScreenLogFile = `${remoteDir}/.deploy-${sessionName}.screen.log`;
    const latestScreenLogFile = `${remoteDir}/.deploy-latest.screen.log`;
    const scriptLocalPath = join(workDir, "deploy.sh");
    const idleTimeoutSecs = appConfig.SSH_DOCKER_COMMAND_TIMEOUT_SECONDS;
    const maxTimeoutSecs = Math.max(idleTimeoutSecs, appConfig.SSH_DOCKER_DEPLOY_MAX_SECONDS);

    const deployScript = buildVmDeployScript({
      remoteDir,
      remoteLogFile,
      remoteExitFile,
      dockerConfigDir,
      postDeployHook: input.postDeployHook
    });

    await writeFile(scriptLocalPath, deployScript, "utf8");

    // Ensure screen is available on the remote VM
    await runRemoteSsh(
      { sshUser: input.sshUser, sshKeyPath: input.sshKeyPath, sshPort: input.sshPort, host: input.vmIp },
      `which screen 2>/dev/null || apt-get install -y screen 2>/dev/null || yum install -y screen 2>/dev/null || apk add screen 2>/dev/null || { echo "ERROR: screen could not be installed"; exit 1; }`
    );

    // Upload and prepare the deploy script
    await copyToRemote(
      { sshUser: input.sshUser, sshKeyPath: input.sshKeyPath, sshPort: input.sshPort, host: input.vmIp },
      scriptLocalPath,
      remoteScriptFile
    );
    await runRemoteSsh(
      { sshUser: input.sshUser, sshKeyPath: input.sshKeyPath, sshPort: input.sshPort, host: input.vmIp },
      `chmod +x ${shellQuote(remoteScriptFile)}`
    );

    // Kill any lingering prior session then start a new detached screen session (with logfile).
    await runRemoteSsh(
      { sshUser: input.sshUser, sshKeyPath: input.sshKeyPath, sshPort: input.sshPort, host: input.vmIp },
      buildScreenStartCommand(
        sessionName,
        remoteScriptFile,
        remoteExitFile,
        remoteScreenLogFile,
        latestScreenLogFile
      )
    );

    // Poll until the exit file appears. While the screen session is alive (slow pulls),
    // keep waiting up to maxTimeoutSecs; only idle-timeout when progress has stopped.
    const pollScript = buildVmDeployPollScript({
      remoteLogFile,
      remoteExitFile,
      remoteScriptFile,
      screenLogFile: remoteScreenLogFile,
      latestScreenLogFile,
      sessionName,
      idleTimeoutSecs,
      maxTimeoutSecs
    });

    const { stdout } = await runRemoteSsh(
      { sshUser: input.sshUser, sshKeyPath: input.sshKeyPath, sshPort: input.sshPort, host: input.vmIp },
      pollScript,
      (maxTimeoutSecs + 60) * 1000
    );

    // For new deployments, enable and start the systemctl service so it is registered for
    // auto-restart and survives reboots. For existing deployments, `docker compose up -d`
    // above has already updated and started the containers; running `systemctl restart`
    // again would cause an unnecessary second outage window.
    if (isNewDeployment) {
      const { appConfig } = await import("../config.js");
      const serviceName = appConfig.DEPLOYMENT_SERVICE_NAME;
      const enableCmd = `sudo systemctl enable ${serviceName} --now`;

      console.log(`[SSH Deployer] New deployment — enabling systemctl service: ${enableCmd}`);

      try {
        const systemctlResult = await runRemoteSsh(
          {
            sshUser: input.sshUser,
            sshKeyPath: input.sshKeyPath,
            sshPort: input.sshPort,
            host: input.vmIp
          },
          enableCmd
        );
        console.log(`[SSH Deployer] systemctl enable succeeded: ${systemctlResult.stdout || '(no output)'}`);
      } catch (err) {
        // Log but don't fail deployment if systemctl command fails
        console.warn(`[SSH Deployer] systemctl enable failed (non-fatal): ${err}`);
      }
    }

    return stdout.trim() || "docker compose up completed";
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function compensateComposeOnVm(input: {
  vmHostname: string;
  vmIp: string;
  dryRun: boolean;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  remoteBaseDir: string;
}): Promise<string> {
  if (input.dryRun) {
    return "(dry run - compose compensation skipped)";
  }

  const remoteDir = input.remoteBaseDir;
  const { stdout } = await runRemoteSsh(
    {
      sshUser: input.sshUser,
      sshKeyPath: input.sshKeyPath,
      sshPort: input.sshPort,
      host: input.vmIp
    },
    `cd ${remoteDir} && docker compose down`
  );

  return stdout.trim() || "docker compose down completed";
}

/**
 * Generate unique Caddy config file name for multi-repo deployments
 * Format: {owner}-{repo}-{env}.caddy (all lowercase)
 * Example: kumpeapps-myapp-dev.caddy
 */
function generateCaddyFileName(
  owner: string, 
  repo: string, 
  environment: string
): string {
  const sanitize = (str: string) => str.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `${sanitize(owner)}-${sanitize(repo)}-${sanitize(environment)}.caddy`;
}

export async function deployCaddyConfig(input: CaddyDeployInput): Promise<{ message: string; deployedFiles: string[] }> {
  if (input.dryRun) {
    return {
      message: "(dry run — no SSH commands executed)",
      deployedFiles: Object.keys(input.caddyConfig).map(() =>
        generateCaddyFileName(input.repositoryOwner, input.repositoryName, input.environment)
      )
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), "kumpeapps-caddy-deploy-"));
  const remoteDir = input.remoteConfigDir;
  const backupDir = `/tmp/kumpeapps-caddy-backup-${Date.now()}`;
  const backupPlan: Array<{ targetPath: string; backupPath: string; hadOriginal: boolean }> = [];
  const deployedFiles: string[] = [];

  try {
    await runRemoteSsh(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.caddyHost
      },
      `mkdir -p ${remoteDir}`
    );
    await runRemoteSsh(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.caddyHost
      },
      `mkdir -p ${shellQuote(backupDir)}`
    );

    let fileIndex = 0;
    for (const [, content] of Object.entries(input.caddyConfig)) {
      // Generate unique file name to avoid conflicts between repos
      const uniqueFileName = generateCaddyFileName(
        input.repositoryOwner,
        input.repositoryName,
        input.environment
      );
      deployedFiles.push(uniqueFileName);

      const targetPath = `${remoteDir}/${uniqueFileName}`;
      const backupPath = `${backupDir}/file-${fileIndex}`;
      fileIndex += 1;

      const existsResult = await runRemoteSsh(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.caddyHost
        },
        `if [ -f ${shellQuote(targetPath)} ]; then cp ${shellQuote(targetPath)} ${shellQuote(backupPath)} && echo 1; else echo 0; fi`
      );

      const hadOriginal = existsResult.stdout.trim().endsWith("1");
      backupPlan.push({ targetPath, backupPath, hadOriginal });

      const localPath = join(workDir, uniqueFileName);
      await writeFile(localPath, content, "utf8");
      await copyToRemote(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.caddyHost
        },
        localPath,
        targetPath
      );
    }

    try {
      if (input.validateCommand && input.validateCommand.trim().length > 0) {
        await runRemoteSsh(
          {
            sshUser: input.sshUser,
            sshKeyPath: input.sshKeyPath,
            sshPort: input.sshPort,
            host: input.caddyHost
          },
          input.validateCommand
        );
      }

      const { stdout } = await runRemoteSsh(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.caddyHost
        },
        input.reloadCommand
      );
      return {
        message: stdout.trim() || "caddy reload completed",
        deployedFiles
      };
    } catch (error) {
      let rollbackError: unknown = null;

      try {
        for (const item of backupPlan) {
          if (item.hadOriginal) {
            await runRemoteSsh(
              {
                sshUser: input.sshUser,
                sshKeyPath: input.sshKeyPath,
                sshPort: input.sshPort,
                host: input.caddyHost
              },
              `cp ${shellQuote(item.backupPath)} ${shellQuote(item.targetPath)}`
            );
          } else {
            await runRemoteSsh(
              {
                sshUser: input.sshUser,
                sshKeyPath: input.sshKeyPath,
                sshPort: input.sshPort,
                host: input.caddyHost
              },
              `rm -f ${shellQuote(item.targetPath)}`
            );
          }
        }

        await runRemoteSsh(
          {
            sshUser: input.sshUser,
            sshKeyPath: input.sshKeyPath,
            sshPort: input.sshPort,
            host: input.caddyHost
          },
          input.reloadCommand
        );
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }

      const baseMessage = error instanceof Error ? error.message : "caddy apply failed";
      if (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
        throw new Error(`${baseMessage}; rollback failed: ${rollbackMessage}`);
      }

      throw new Error(`${baseMessage}; rollback restored previous caddy files`);
    }
  } finally {
    try {
      await runRemoteSsh(
        {
          sshUser: input.sshUser,
          sshKeyPath: input.sshKeyPath,
          sshPort: input.sshPort,
          host: input.caddyHost
        },
        `rm -rf ${shellQuote(backupDir)}`
      );
    } catch {
      // Best effort cleanup.
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function removeCaddyConfig(input: {
  caddyHost: string;
  fileNames: string[];
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  remoteConfigDir: string;
  reloadCommand: string;
}): Promise<string> {
  if (input.fileNames.length === 0) {
    return "No files to remove";
  }

  try {
    // Remove each Caddy config file
    for (const fileName of input.fileNames) {
      const targetPath = `${input.remoteConfigDir}/${fileName}`;
      
      try {
        await runRemoteSsh(
          {
            sshUser: input.sshUser,
            sshKeyPath: input.sshKeyPath,
            sshPort: input.sshPort,
            host: input.caddyHost
          },
          `rm -f ${shellQuote(targetPath)}`
        );
      } catch (error) {
        // Log but don't fail if file doesn't exist
        console.warn(`Failed to remove Caddy file ${fileName}:`, error);
      }
    }

    // Reload Caddy to apply changes
    const { stdout } = await runRemoteSsh(
      {
        sshUser: input.sshUser,
        sshKeyPath: input.sshKeyPath,
        sshPort: input.sshPort,
        host: input.caddyHost
      },
      input.reloadCommand
    );

    return stdout.trim() || `Removed ${input.fileNames.length} Caddy file(s) and reloaded`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to cleanup Caddy config: ${message}`);
  }
}

