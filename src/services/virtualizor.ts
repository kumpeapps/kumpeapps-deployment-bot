import { Agent } from "node:https";
import { appConfig } from "../config.js";
import { prisma } from "../db.js";
import {
  recordVirtualizorApiCallAttempt,
  recordVirtualizorApiCallFailure,
  recordVirtualizorApiCallSuccess,
  recordVirtualizorVmReadyTimeout
} from "./virtualizor-health.js";

export type VmEnsureInput = {
  vmHostname: string;
  repositoryFullName: string;
  assignedUsername: string;
  dryRun: boolean;
  environment: "dev" | "stage" | "prod";
  planName?: string;
};

export type VmEnsureResult = {
  vmId: string;
  vmIp: string;
  created: boolean;
};

type VirtualizorListResponse = {
  vs?: Record<string, {
    vpsid?: string | number;
    hostname?: string;
  }>;
};

type VirtualizorCreateResponse = {
  title?: string;
  error?: string[];
  done?: {
    vpsid?: string | number;
    msg?: string;
  };
  vps?: {
    vpsid?: string | number;
    hostname?: string;
  };
  newvs?: {
    vpsid?: string | number;
    [key: string]: any;
  };
  [key: string]: any;
};

type VirtualizorVmDetailResponse = {
  vps?: {
    vpsid?: string | number;
    hostname?: string;
    status?: string | number;
    ips?: string[];
    ip?: string;
    [key: string]: any;
  };
};

type VirtualizorPlanResponse = {
  plans?: Record<string, {
    plid?: string | number;
    plan_name?: string;
    ippoolid?: string; // IP pool ID (often PHP serialized array)
    ippid?: string | number; // IP pool ID
    ips_int?: string | number; // Internal IP pool ID
    disk?: string | number;
    ram?: string | number;
    bandwidth?: string | number;
    num_cores?: string | number;
    [key: string]: any;
  }>;
};

type VirtualizorIpPoolResponse = {
  ips?: Record<string, {
    ipid?: string | number;
    ip?: string;
    vpsid?: string | number;
    ippid?: string | number; // IP pool ID this IP belongs to
    primary?: string | number;
    [key: string]: any;
  }>;
};

async function fetchVirtualizorJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.VIRTUALIZOR_API_TIMEOUT_MS);

  // Log API call for debugging (without exposing credentials in production logs)
  const debugUrl = url.replace(/adminapikey=[^&]+/, 'adminapikey=***').replace(/adminapipass=[^&]+/, 'adminapipass=***');
  console.log(`[Virtualizor API] ${init?.method ?? 'GET'} ${debugUrl}`);

  // Create agent for insecure SSL if needed (self-signed certificates)
  const fetchOptions: RequestInit = {
    ...init,
    signal: controller.signal,
    headers: {
      'Accept': 'application/json',
      ...(init?.headers ?? {})
    }
  };

  if (appConfig.VIRTUALIZOR_API_INSECURE) {
    // @ts-expect-error - Node.js fetch accepts agent but TypeScript doesn't know about it
    fetchOptions.agent = new Agent({ rejectUnauthorized: false });
  }

  try {
    recordVirtualizorApiCallAttempt();
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Virtualizor API request failed with status ${response.status}: ${text.substring(0, 200)}`);
    }

    const text = await response.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (parseError) {
      throw new Error(`Virtualizor API returned non-JSON response: ${text.substring(0, 500)}`);
    }
    
    recordVirtualizorApiCallSuccess();
    return data;
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.toLowerCase().includes("timed out"));
    recordVirtualizorApiCallFailure({ timedOut });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function baseApiUrl(): string {
  return appConfig.VIRTUALIZOR_API_URL.replace(/\/$/, "");
}

function apiParams(): string {
  return `adminapikey=${encodeURIComponent(appConfig.VIRTUALIZOR_API_KEY)}&adminapipass=${encodeURIComponent(appConfig.VIRTUALIZOR_API_PASS)}&api=json`;
}

function listUrl(): string {
  return `${baseApiUrl()}/index.php?act=vs&${apiParams()}`;
}

function createUrl(): string {
  return `${baseApiUrl()}/index.php?act=addvs&${apiParams()}`;
}

function vmDetailUrl(vmId: string): string {
  return `${baseApiUrl()}/index.php?act=vpsmanage&svs=${encodeURIComponent(vmId)}&${apiParams()}`;
}

function planDetailsUrl(planId: string): string {
  return `${baseApiUrl()}/index.php?act=plans&${apiParams()}`;
}

function ipPoolUrl(poolId?: string): string {
  const params = apiParams();
  // If poolId provided, add it as ippid parameter per Virtualizor API docs
  if (poolId) {
    return `${baseApiUrl()}/index.php?act=ips&ippid=${encodeURIComponent(poolId)}&${params}`;
  }
  return `${baseApiUrl()}/index.php?act=ips&${params}`;
}

function editUrl(vmId: string): string {
  return `${baseApiUrl()}/index.php?act=editvm&${apiParams()}`;
}

async function pollVmReady(vmId: string, knownIp?: string): Promise<string> {
  const deadline = Date.now() + appConfig.VIRTUALIZOR_VM_READY_TIMEOUT_MS;
  const interval = appConfig.VIRTUALIZOR_VM_READY_POLL_INTERVAL_MS;
  let pollCount = 0;
  let vmIp: string | undefined = knownIp;

  while (Date.now() < deadline) {
    pollCount++;
    const data = await fetchVirtualizorJson<VirtualizorVmDetailResponse>(vmDetailUrl(vmId));
    const status = data.vps?.status;
    const hostname = data.vps?.hostname;
    
    // Extract IP address if available
    if (!vmIp && data.vps) {
      vmIp = data.vps.ip || (data.vps.ips && data.vps.ips[0]);
    }
    
    // Log detailed response on first poll for debugging
    if (pollCount === 1) {
      console.log(`[Virtualizor API] First poll response - VM IP: ${vmIp}, status: ${status}`);
    }
    
    // Log status every 6th poll (every 30 seconds with 5s interval) to reduce noise
    if (pollCount % 6 === 1) {
      console.log(`[Virtualizor API] Polling VM ${vmId} (${hostname}): ip=${vmIp}, status=${status}, poll=${pollCount}`);
    }
    
    // Check if VM is ready via SSH connectivity test
    if (vmIp) {
      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        
        // Remove old host key if IP is reused from a destroyed VM
        // This prevents "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED" errors
        const knownHostsFile = appConfig.SSH_KNOWN_HOSTS_PATH;
        try {
          await execAsync(`ssh-keygen -R ${vmIp} -f ${knownHostsFile} 2>/dev/null || true`);
          console.log(`[Virtualizor API] Cleared old host key for ${vmIp} from known_hosts`);
        } catch (keygenError) {
          // Non-fatal, continue with SSH test
          console.log(`[Virtualizor API] Could not clear host key (non-fatal): ${keygenError}`);
        }
        
        // Test SSH connectivity with a quick timeout using configured key
        // Use StrictHostKeyChecking=accept-new to accept new keys but not changed keys
        // Also set UserKnownHostsFile to ensure we're using the right file
        const sshKeyPath = appConfig.VM_SSH_KEY_PATH;
        const sshPort = appConfig.VM_SSH_PORT;
        const sshCommand = `ssh -i ${sshKeyPath} -p ${sshPort} -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsFile} ${appConfig.VM_SSH_USER}@${vmIp} 'echo ok'`;
        
        // Log the exact command on first few attempts
        if (pollCount <= 3) {
          console.log(`[Virtualizor API] SSH command (poll ${pollCount}): ${sshCommand}`);
        }
        
        const { stdout, stderr } = await execAsync(sshCommand, { timeout: 10000 });
        
        if (stdout.trim() === 'ok') {
          console.log(`[Virtualizor API] ✅ VM ${vmId} (${vmIp}) is SSH accessible after ${pollCount} polls`);
          return vmIp;
        } else {
          console.log(`[Virtualizor API] SSH test unexpected output: stdout="${stdout.trim()}", stderr="${stderr.trim()}"`);
        }
      } catch (sshError) {
        // SSH not ready yet, continue polling
        const errorMsg = sshError instanceof Error ? sshError.message : String(sshError);
        
        if (pollCount % 12 === 1) { // Log every minute
          console.log(`[Virtualizor API] ⏳ VM ${vmId} (${vmIp}) SSH not yet accessible (attempt ${pollCount}): ${errorMsg.substring(0, 200)}`);
        }
        
        // Log first few failures with full details for debugging
        if (pollCount <= 3) {
          console.log(`[Virtualizor API] SSH test failed (poll ${pollCount}):`, errorMsg);
        }
      }
    } else {
      // IP not yet available
      if (pollCount % 6 === 1) {
        console.log(`[Virtualizor API] ⏳ VM ${vmId} waiting for IP assignment (poll ${pollCount})`);
      }
    }
    
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }

  recordVirtualizorVmReadyTimeout();
  throw new Error(`VM ${vmId} did not become SSH accessible within ${appConfig.VIRTUALIZOR_VM_READY_TIMEOUT_MS}ms. Last known IP: ${vmIp || 'unknown'}`);
}

function parsePhpSerializedArray(serialized: any): string | null {
  // Parse PHP serialized array like: a:1:{i:0;s:1:"2";}
  // This extracts the first string value from the serialized array
  if (typeof serialized !== 'string') return null;
  
  // Match pattern like s:1:"2" or s:2:"10" (string of length N with value)
  const match = serialized.match(/s:\d+:"(\d+)"/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

async function getPlanDetails(planId: string): Promise<{ ippid?: string; plan?: any }> {
  const data = await fetchVirtualizorJson<VirtualizorPlanResponse>(planDetailsUrl(planId));
  if (data.plans) {
    const plan = data.plans[planId];
    if (plan) {
      console.log(`[Virtualizor API] Plan ${planId} full details:`, JSON.stringify(plan));
      
      // Check multiple possible IP pool field names
      // ippoolid is often a PHP serialized array: a:1:{i:0;s:1:"2";}
      let ippid: string | null | undefined = null;
      
      if (plan.ippoolid) {
        ippid = parsePhpSerializedArray(plan.ippoolid);
        console.log(`[Virtualizor API] Parsed ippoolid "${plan.ippoolid}" -> ${ippid}`);
      }
      
      // Fallback to other fields only if ippoolid didn't work
      if (!ippid) {
        ippid = plan.ippid || plan.ips_int || plan.ip_pool_id || plan.pool_id;
      }
      
      if (ippid) {
        console.log(`[Virtualizor API] Plan ${planId} IP pool ID: ${ippid}`);
      } else {
        console.log(`[Virtualizor API] WARNING: Plan ${planId} has no IP pool ID (ippoolid, ippid, ips_int, ip_pool_id, pool_id)`);
      }
      return { ippid: ippid ? String(ippid) : undefined, plan };
    }
  }
  return {};
}

async function getAvailableIp(ipPoolId?: string): Promise<string | null> {
  // Try to fetch IPs from the specific pool first if poolId is provided
  const data = await fetchVirtualizorJson<VirtualizorIpPoolResponse>(ipPoolUrl(ipPoolId));
  
  console.log(`[Virtualizor API] IP pool response structure:`, Object.keys(data));
  
  if (data.ips) {
    const ipCount = Object.keys(data.ips).length;
    console.log(`[Virtualizor API] Total IPs in response: ${ipCount}`);
    
    // Log first few IPs for debugging
    const sampleIps = Object.entries(data.ips).slice(0, 3);
    console.log(`[Virtualizor API] Sample IPs (first 3):`, JSON.stringify(sampleIps));
    
    let checkedCount = 0;
    let unassignedCount = 0;
    let poolMatchCount = 0;
    
    for (const [ipid, ipInfo] of Object.entries(data.ips)) {
      checkedCount++;
      
      // Check if IP is unassigned (vpsid is 0 or empty) and matches the pool if specified
      const isUnassigned = !ipInfo.vpsid || ipInfo.vpsid === "0" || ipInfo.vpsid === 0;
      const matchesPool = !ipPoolId || String(ipInfo.ippid ?? "") === ipPoolId;
      
      if (isUnassigned) unassignedCount++;
      if (matchesPool) poolMatchCount++;
      
      if (isUnassigned && matchesPool && ipInfo.ip) {
        console.log(`[Virtualizor API] Found available IP: ${ipInfo.ip} (ipid: ${ipid}, pool: ${ipInfo.ippid})`); 
        return ipInfo.ip; // Return the IP address as required by Virtualizor API
      }
    }
    
    console.log(`[Virtualizor API] Search summary: checked=${checkedCount}, unassigned=${unassignedCount}, poolMatch=${poolMatchCount}, targetPool=${ipPoolId}`);
  }
  console.log(`[Virtualizor API] No available IPs found in pool ${ipPoolId || 'any'}`);
  return null;
}

function parseVmIdFromCreateResponse(data: VirtualizorCreateResponse): string | null {
  // Log the entire response structure for debugging
  console.log(`[Virtualizor API] Parsing create response structure:`, Object.keys(data));
  console.log(`[Virtualizor API] Full response (first 5000 chars):`, JSON.stringify(data).substring(0, 5000));
  
  // FIRST: Check for API errors - these contain the actual validation failures
  if (data.error) {
    console.log(`[Virtualizor API] error field type:`, typeof data.error, Array.isArray(data.error) ? `(array, length: ${data.error.length})` : '(not array)');
    console.log(`[Virtualizor API] error field content:`, JSON.stringify(data.error));
    
    if (Array.isArray(data.error) && data.error.length > 0) {
      console.error(`[Virtualizor API] Virtualizor returned validation errors:`, data.error);
      throw new Error(`Virtualizor API validation failed: ${data.error.join(', ')}`);
    } else if (typeof data.error === 'object' && data.error !== null) {
      // Error might be an object with keys
      const errorMessages = Object.values(data.error).filter(v => v);
      if (errorMessages.length > 0) {
        console.error(`[Virtualizor API] Virtualizor returned validation errors:`, errorMessages);
        throw new Error(`Virtualizor API validation failed: ${JSON.stringify(errorMessages)}`);
      }
    }
  } else {
    console.log(`[Virtualizor API] No error field in response`);
  }
  
  // Check done.msg for success/error messages
  if (data.done && typeof data.done === 'object') {
    console.log(`[Virtualizor API] done object:`, JSON.stringify(data.done));
  }
  
  // Check newvs field (this is what Virtualizor API actually returns on success)
  console.log(`[Virtualizor API] newvs field type:`, typeof data.newvs);
  console.log(`[Virtualizor API] newvs exists:`, data.newvs !== undefined);
  console.log(`[Virtualizor API] newvs value:`, JSON.stringify(data.newvs).substring(0, 1000));
  
  if (data.newvs && typeof data.newvs === 'object') {
    const newvsKeys = Object.keys(data.newvs);
    console.log(`[Virtualizor API] newvs keys (${newvsKeys.length}):`, newvsKeys.slice(0, 10)); // First 10 keys
    console.log(`[Virtualizor API] newvs.vpsid value:`, data.newvs.vpsid, `(type: ${typeof data.newvs.vpsid})`);
    if (data.newvs.vpsid !== undefined && data.newvs.vpsid !== "" && data.newvs.vpsid !== "0") {
      console.log(`[Virtualizor API] Found vpsid in newvs:`, data.newvs.vpsid);
      return String(data.newvs.vpsid);
    } else {
      console.log(`[Virtualizor API] newvs exists but vpsid is invalid or empty`);
    }
  }
  
  // If response has "title" it means we got the form page, not a successful creation
  if (data.title && !data.done && (!data.newvs || !data.newvs.vpsid)) {
    console.error(`[Virtualizor API] Received form page instead of creation response. This usually means missing/invalid parameters.`);
    console.error(`[Virtualizor API] Full response (first 2000 chars):`, JSON.stringify(data).substring(0, 2000));
    throw new Error(`Virtualizor returned the form page instead of creating VM. Check that all required parameters (server ID, plan ID, OS ID, user ID) are valid.`);
  }
  
  // Check other possible locations
  if (data.done?.vpsid !== undefined) {
    return String(data.done.vpsid);
  }
  if (data.vps?.vpsid !== undefined) {
    return String(data.vps.vpsid);
  }
  
  return null;
}

/**
 * Update VM hostname via Virtualizor API
 * @param vmId - Virtualizor VM ID
 * @param newHostname - New hostname to set
 */
async function updateVmHostname(vmId: string, newHostname: string): Promise<void> {
  console.log(`[Virtualizor API] Updating hostname for VM ${vmId} to ${newHostname}`);
  
  const url = editUrl(vmId);
  const formData = new URLSearchParams();
  formData.append('updatevm', '1');
  formData.append('vpsid', vmId);
  formData.append('hostname', newHostname);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    
    if (!response.ok) {
      throw new Error(`Virtualizor API returned HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    // Check for API errors
    if (data.error) {
      const errorMessages = Array.isArray(data.error) 
        ? data.error.join(', ') 
        : JSON.stringify(data.error);
      throw new Error(`Virtualizor API error: ${errorMessages}`);
    }
    
    console.log(`[Virtualizor API] Successfully updated hostname for VM ${vmId} to ${newHostname}`);
  } catch (error) {
    console.error(`[Virtualizor API] Failed to update hostname for VM ${vmId}:`, error);
    throw error;
  }
}

/**
 * Resolve plan ID for a given environment, considering:
 * 1. Named plan from database if planName is provided
 * 2. Environment-specific env vars (VIRTUALIZOR_DEV_PLAN, etc.)
 * 3. Fall back to VIRTUALIZOR_DEFAULT_PLAN
 */
async function resolvePlanId(environment: "dev" | "stage" | "prod", planName?: string): Promise<string> {
  // If plan name is provided, look it up in database
  if (planName) {
    const plan = await prisma.plan.findUnique({
      where: { name: planName }
    });

    if (!plan) {
      throw new Error(`Plan '${planName}' not found in database`);
    }

    // Get environment-specific plan ID from the plan record
    const planIdField = {
      dev: plan.devPlanId,
      stage: plan.stagePlanId,
      prod: plan.prodPlanId
    }[environment];

    if (!planIdField) {
      throw new Error(`Plan '${planName}' has no plan ID configured for ${environment} environment`);
    }

    return planIdField;
  }

  // No plan name provided, use environment-specific env vars
  const envSpecificPlan = {
    dev: appConfig.VIRTUALIZOR_DEV_PLAN,
    stage: appConfig.VIRTUALIZOR_STAGE_PLAN,
    prod: appConfig.VIRTUALIZOR_PROD_PLAN
  }[environment];

  if (envSpecificPlan) {
    return envSpecificPlan;
  }

  // Fall back to default plan
  if (!appConfig.VIRTUALIZOR_DEFAULT_PLAN) {
    throw new Error("No plan ID configured: VIRTUALIZOR_DEFAULT_PLAN is required when no environment-specific or named plan is available");
  }

  return appConfig.VIRTUALIZOR_DEFAULT_PLAN;
}

/**
 * Resolve plan ID and display name for use in approval requests and VM creation
 * Returns both the Virtualizor plan ID and a human-readable name
 */
async function resolvePlanDetails(
  environment: "dev" | "stage" | "prod", 
  planName?: string
): Promise<{ planId: string; planDisplayName: string; ram?: string; disk?: string; cores?: string }> {
  // First get the plan ID
  const planId = await resolvePlanId(environment, planName);
  
  // If a custom plan name was provided, use it as the display name
  if (planName) {
    // Still fetch details from Virtualizor for specs
    try {
      const { plan } = await getPlanDetails(planId);
      return {
        planId,
        planDisplayName: planName,
        ram: plan?.ram ? String(plan.ram) : undefined,
        disk: plan?.disk ? String(plan.disk) : undefined,
        cores: plan?.num_cores ? String(plan.num_cores) : undefined
      };
    } catch (err) {
      console.warn(`[Virtualizor] Failed to fetch plan details for ${planId}: ${err}`);
      return { planId, planDisplayName: planName };
    }
  }
  
  // Otherwise, fetch the plan name from Virtualizor API
  try {
    const { plan } = await getPlanDetails(planId);
    if (plan?.plan_name) {
      return {
        planId,
        planDisplayName: plan.plan_name,
        ram: plan.ram ? String(plan.ram) : undefined,
        disk: plan.disk ? String(plan.disk) : undefined,
        cores: plan.num_cores ? String(plan.num_cores) : undefined
      };
    }
  } catch (err) {
    console.warn(`[Virtualizor] Failed to fetch plan details for ${planId}: ${err}`);
  }
  
  // Fallback: use the plan ID as the display name
  return { planId, planDisplayName: `Plan ${planId}` };
}

async function ensureViaApi(input: VmEnsureInput): Promise<VmEnsureResult> {
  if (!appConfig.VIRTUALIZOR_API_URL || !appConfig.VIRTUALIZOR_API_KEY || !appConfig.VIRTUALIZOR_API_PASS) {
    throw new Error("VIRTUALIZOR_API_URL, VIRTUALIZOR_API_KEY, and VIRTUALIZOR_API_PASS are required in api mode");
  }

  // Check database first - DB is source of truth for VM assignments
  const [owner, name] = input.repositoryFullName.split('/');
  const repository = await prisma.repository.findUnique({ 
    where: { owner_name: { owner, name } } 
  });
  
  if (repository) {
    const existingVm = await prisma.vm.findUnique({
      where: {
        repositoryId_environment: {
          repositoryId: repository.id,
          environment: input.environment
        }
      }
    });
    
    if (existingVm) {
      const vmId = existingVm.virtualizorVmId;
      
      if (!vmId) {
        throw new Error(`VM record exists in database but has no Virtualizor VM ID. Manual intervention required.`);
      }
      
      const metadata = existingVm.metadata as any;
      let vmIp = metadata?.ip;
      
      // Check if hostname has changed and needs to be updated in Virtualizor
      if (existingVm.vmHostname !== input.vmHostname) {
        console.log(`[Virtualizor API] Hostname changed from ${existingVm.vmHostname} to ${input.vmHostname}, updating...`);
        try {
          // Update hostname in Virtualizor via API
          await updateVmHostname(vmId, input.vmHostname);
          
          // Update hostname in database
          await prisma.vm.update({
            where: { id: existingVm.id },
            data: { vmHostname: input.vmHostname }
          });
          console.log(`[Virtualizor API] Successfully updated hostname for VM ${vmId}`);
        } catch (err) {
          console.warn(`[Virtualizor API] Failed to update hostname in Virtualizor (non-fatal): ${err}`);
          // Update database anyway
          await prisma.vm.update({
            where: { id: existingVm.id },
            data: { vmHostname: input.vmHostname }
          });
        }
      }
      
      // If IP missing in DB, query Virtualizor to get it
      if (!vmIp) {
        console.log(`[Virtualizor API] VM ${vmId} in DB missing IP, querying Virtualizor...`);
        const details = await fetchVirtualizorJson<VirtualizorVmDetailResponse>(vmDetailUrl(vmId));
        vmIp = details.vps?.ip || (details.vps?.ips && details.vps.ips[0]);
        
        if (!vmIp) {
          console.log(`[Virtualizor API] VM ${vmId} has no IP in Virtualizor, polling for readiness...`);
          vmIp = await pollVmReady(vmId);
        }
        
        // Update database with IP
        await prisma.vm.update({
          where: { id: existingVm.id },
          data: {
            metadata: {
              ...metadata,
              ip: vmIp,
              updatedAt: new Date().toISOString()
            }
          }
        });
        console.log(`[Virtualizor API] Updated DB with VM ${vmId} IP ${vmIp}`);
      }
      
      console.log(`[Virtualizor API] Using existing VM ${vmId} at ${vmIp} from database`);
      return { vmId, vmIp, created: false };
    }
  } else {
    throw new Error(`Repository ${input.repositoryFullName} not found in database. Please ensure the GitHub App is installed on this repository first.`);
  }
  
  // Check if VM already exists in Virtualizor but not in our DB
  // This prevents creating duplicate VMs or taking over someone else's VM
  const data = await fetchVirtualizorJson<VirtualizorListResponse>(listUrl());
  if (data.vs) {
    for (const [vpsid, vm] of Object.entries(data.vs)) {
      if (vm.hostname === input.vmHostname) {
        throw new Error(`VM ${input.vmHostname} already exists in Virtualizor (ID: ${vpsid}) but not assigned to this repository in database. Manual intervention required.`);
      }
    }
  }

  if (!appConfig.VIRTUALIZOR_CREATE_ENABLED) {
    throw new Error("VM not found in Virtualizor API mode and VIRTUALIZOR_CREATE_ENABLED=false");
  }

  // Resolve plan ID based on environment and optional plan name
  const planId = await resolvePlanId(input.environment, input.planName);

  // Validate required parameters per Virtualizor API docs
  if (!appConfig.VIRTUALIZOR_DEFAULT_OS) {
    throw new Error("VIRTUALIZOR_DEFAULT_OS is required for VM creation (osid parameter)"); 
  }
  if (!appConfig.VIRTUALIZOR_VM_USER_EMAIL) {
    throw new Error("VIRTUALIZOR_VM_USER_EMAIL is required for VM creation (user_email parameter)");
  }
  if (!appConfig.VIRTUALIZOR_VM_USER_PASS) {
    throw new Error("VIRTUALIZOR_VM_USER_PASS is required for VM creation (user_pass parameter)");
  }
  if (!appConfig.VIRTUALIZOR_VM_ROOT_PASS) {
    throw new Error("VIRTUALIZOR_VM_ROOT_PASS is required for VM creation (rootpass parameter)");
  }

  // Select server based on environment
  const serverByEnv = {
    dev: appConfig.VIRTUALIZOR_DEV_SERVER,
    stage: appConfig.VIRTUALIZOR_STAGE_SERVER,
    prod: appConfig.VIRTUALIZOR_PROD_SERVER
  };
  const serverId = serverByEnv[input.environment];

  // Get plan details to find IP pool
  console.log(`[Virtualizor API] Fetching plan ${planId} details...`);
  const { ippid, plan } = await getPlanDetails(planId);
  
  if (!plan) {
    throw new Error(`Plan ${planId} not found in Virtualizor`);
  }
  
  // Get an available IP from the pool
  console.log(`[Virtualizor API] Finding available IP in pool ${ippid || 'default'}...`);
  const ipAddress = await getAvailableIp(ippid);
  if (!ipAddress) {
    throw new Error(`No available IPs found in pool ${ippid || 'default'}. Cannot create VM without an IP address.`);
  }

  // Build form data for Virtualizor addvs API per https://www.virtualizor.com/docs/admin-api/create-vps/
  // Note: act=addvs is in URL, not body
  const formData = new URLSearchParams();
  
  // Required parameters per API documentation
  formData.append("virt", "proxk"); // Virtualization type (Proxmox KVM) - REQUIRED
  formData.append("node_select", "0"); // Server selection - REQUIRED (0 = auto or with slave_server)
  
  // Server selection: slave_server is optional, only include if we have a specific non-zero server
  // Server ID "0" means auto-select, so don't include slave_server parameter in that case
  if (serverId && serverId !== "0") {
    formData.append("slave_server", serverId); // Specific slave server ID
  }
  
  formData.append("user_email", appConfig.VIRTUALIZOR_VM_USER_EMAIL); // User email - REQUIRED
  formData.append("user_pass", appConfig.VIRTUALIZOR_VM_USER_PASS); // User password - REQUIRED
  formData.append("hostname", input.vmHostname); // VPS hostname - REQUIRED (not hname!)
  formData.append("rootpass", appConfig.VIRTUALIZOR_VM_ROOT_PASS); // Root password - REQUIRED
  formData.append("osid", appConfig.VIRTUALIZOR_DEFAULT_OS); // OS template ID - REQUIRED
  formData.append("ips[]", ipAddress); // IP address (not ID!) - REQUIRED
  
  // Resource parameters - all REQUIRED
  formData.append("space", String(plan.space || 10)); // Disk space in GB - REQUIRED
  formData.append("ram", String(plan.ram || 1024)); // RAM in MB - REQUIRED
  formData.append("bandwidth", String(plan.bandwidth || 0)); // Bandwidth (0=unlimited) - REQUIRED
  formData.append("cores", String(plan.cores || plan.num_cores || 1)); // CPU cores - REQUIRED
  
  // Proxmox KVM required parameters - use values from plan
  formData.append("bus_driver", String(plan.bus_driver || "virtio")); // Bus driver for Proxmox KVM - REQUIRED
  formData.append("bus_driver_num", String(plan.bus_driver_num || "0")); // Bus driver number - REQUIRED
  
  // NIC type (network interface controller) - recommended for Proxmox KVM
  if (plan.nic_type) {
    formData.append("nic_type", String(plan.nic_type));
  }
  
  // Optional but recommended parameters
  if (plan.network_speed) formData.append("network_speed", String(plan.network_speed));
  if (plan.upload_speed) formData.append("upload_speed", String(plan.upload_speed));
  if (plan.cpu) formData.append("cpu", String(plan.cpu));
  
  // Optional parameters
  if (planId) {
    formData.append("plid", planId); // Plan ID (optional)
  }
  if (appConfig.VIRTUALIZOR_DEFAULT_USER) {
    formData.append("uid", appConfig.VIRTUALIZOR_DEFAULT_USER); // User ID (optional)
  }
  
  // Allow password authentication - override plan's disable_password setting
  // This allows the bot to create VMs without SSH key setup
  formData.append("disable_password", "0");
  
  // Add deployment metadata to VM notes
  const notes = `Bot-deployed VM\nRepository: ${input.repositoryFullName}\nEnvironment: ${input.environment}\nUser: ${input.assignedUsername}\nCreated: ${new Date().toISOString()}`;
  formData.append("notes", notes);
  
  // Submission flag - tells Virtualizor to actually create the VPS
  formData.append("addvps", "1");

  console.log(`[Virtualizor API] Creating VM with params:`, {
    hostname: input.vmHostname,
    environment: input.environment,
    plan: appConfig.VIRTUALIZOR_DEFAULT_PLAN,
    os: appConfig.VIRTUALIZOR_DEFAULT_OS,
    region: appConfig.VIRTUALIZOR_DEFAULT_REGION || 'none',
    server: serverId || 'none',
    user: appConfig.VIRTUALIZOR_DEFAULT_USER || 'none'
  });
  console.log(`[Virtualizor API] Form data:`, formData.toString().replace(/adminapikey=[^&]+/, 'adminapikey=***').replace(/adminapipass=[^&]+/, 'adminapipass=***'));

  const created = await fetchVirtualizorJson<VirtualizorCreateResponse>(createUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: formData.toString()
  });

  console.log(`[Virtualizor API] Create response:`, JSON.stringify(created).substring(0, 500));

  const createdVmId = parseVmIdFromCreateResponse(created);
  if (createdVmId) {
    // Poll for VM readiness and get confirmed IP
    const confirmedIp = await pollVmReady(createdVmId, ipAddress);
    
    // Persist VM to database - repository must already exist from GitHub App installation
    const [owner, name] = input.repositoryFullName.split('/');
    const repository = await prisma.repository.findUnique({ 
      where: { owner_name: { owner, name } } 
    });
    
    if (!repository) {
      throw new Error(`Repository ${input.repositoryFullName} not found in database after VM creation. Please ensure the GitHub App is installed on this repository.`);
    }
    
    // Ensure user exists
    await prisma.user.upsert({
      where: { githubUsername: input.assignedUsername },
      update: {},
      create: {
        githubUsername: input.assignedUsername
      }
    });
    
    await prisma.vm.create({
      data: {
        vmHostname: input.vmHostname,
        environment: input.environment,
        virtualizorVmId: createdVmId,
        state: "running",
        metadata: {
          ip: confirmedIp,
          assignedUsername: input.assignedUsername,
          createdAt: new Date().toISOString()
        },
        repository: {
          connect: { id: repository.id }
        },
        user: {
          connect: { githubUsername: input.assignedUsername }
        }
      }
    });
    
    console.log(`[Virtualizor API] VM ${createdVmId} created and persisted to database with IP ${confirmedIp}`);
    return { vmId: createdVmId, vmIp: confirmedIp, created: true };
  }

  const afterCreate = await fetchVirtualizorJson<VirtualizorListResponse>(listUrl());
  if (afterCreate.vs) {
    for (const [vpsid, vm] of Object.entries(afterCreate.vs)) {
      if (vm.hostname === input.vmHostname) {
        const vmId = String(vm.vpsid ?? vpsid);
        const confirmedIp = await pollVmReady(vmId, ipAddress);
        
        // Persist VM to database - repository must already exist from GitHub App installation
        const [owner, name] = input.repositoryFullName.split('/');
        const repository = await prisma.repository.findUnique({ 
          where: { owner_name: { owner, name } } 
        });
        
        if (!repository) {
          throw new Error(`Repository ${input.repositoryFullName} not found in database after VM creation. Please ensure the GitHub App is installed on this repository.`);
        }
        
        // Ensure user exists
        await prisma.user.upsert({
          where: { githubUsername: input.assignedUsername },
          update: {},
          create: {
            githubUsername: input.assignedUsername
          }
        });
        
        await prisma.vm.create({
          data: {
            vmHostname: input.vmHostname,
            environment: input.environment,
            virtualizorVmId: vmId,
            state: "running",
            metadata: {
              ip: confirmedIp,
              assignedUsername: input.assignedUsername,
              createdAt: new Date().toISOString()
            },
            repository: {
              connect: { id: repository.id }
            },
            user: {
              connect: { githubUsername: input.assignedUsername }
            }
          }
        });
        
        console.log(`[Virtualizor API] VM ${vmId} created and persisted to database with IP ${confirmedIp}`);
        return { vmId, vmIp: confirmedIp, created: true };
      }
    }
  }

  throw new Error("Virtualizor VM create call succeeded but returned no VM id");
}

export { resolvePlanDetails };

export async function ensureVirtualizorVm(input: VmEnsureInput): Promise<VmEnsureResult> {
  if (input.dryRun || appConfig.VIRTUALIZOR_MODE === "dryrun") {
    return {
      vmId: `dryrun-${input.vmHostname}`,
      vmIp: '127.0.0.1',
      created: true
    };
  }

  if (appConfig.VIRTUALIZOR_MODE === "manual") {
    return {
      vmId: `manual-${input.vmHostname}`,
      vmIp: '127.0.0.1',
      created: false
    };
  }

  if (appConfig.VIRTUALIZOR_MODE === "api") {
    return ensureViaApi(input);
  }

  throw new Error("Unsupported Virtualizor mode");
}
