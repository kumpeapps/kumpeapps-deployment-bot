<?php
/**
 * Virtualizor Hook: deletevs.php
 * 
 * Installation Instructions:
 * 1. Copy this file to /usr/local/virtualizor/hooks/deletevs.php on your Virtualizor MASTER server
 * 2. Set the webhook URL and secret in the configuration constants below
 * 3. Make sure the Virtualizor master server can reach your deployment bot URL
 * 
 * Hook Documentation: https://www.virtualizor.com/docs/developers/hooks/
 * 
 * This hook is executed on the MASTER server after a VPS is deleted successfully.
 * It sends a webhook to the deployment bot to remove the VM from its database.
 * 
 * The $vps parameter contains the VPS data including:
 * - vpsid: The Virtualizor VM ID
 * - vps_name: The VM hostname
 * - And other VPS attributes
 */

// ============================================================================
// CONFIGURATION - Update these values for your deployment
// ============================================================================
define('DEPLOYMENT_BOT_WEBHOOK_URL', 'https://your-bot-domain.com/virtualizor/webhook/vm-deleted');
define('DEPLOYMENT_BOT_WEBHOOK_SECRET', 'your-webhook-secret-here');
// ============================================================================

/**
 * Hook function called by Virtualizor when a VPS is deleted
 * 
 * @param array $vps The VPS data from Virtualizor
 */
function __deletevs($vps) {
    // Log that hook was called (helps verify hook is actually triggered)
    error_log("Virtualizor Hook (deletevs): Hook triggered");
    
    // Validate configuration
    if (DEPLOYMENT_BOT_WEBHOOK_URL === 'https://your-bot-domain.com/virtualizor/webhook/vm-deleted' ||
        DEPLOYMENT_BOT_WEBHOOK_SECRET === 'your-webhook-secret-here') {
        error_log("Virtualizor Hook (deletevs): Webhook not configured. Please update DEPLOYMENT_BOT_WEBHOOK_URL and DEPLOYMENT_BOT_WEBHOOK_SECRET in deletevs.php");
        return;
    }
    
    // Extract VM ID
    $vpsid = isset($vps['vpsid']) ? $vps['vpsid'] : null;
    
    if (empty($vpsid)) {
        error_log("Virtualizor Hook (deletevs): Missing vpsid in \$vps parameter. Received data: " . json_encode($vps));
        return;
    }
    
    error_log("Virtualizor Hook (deletevs): Processing deletion for vpsid: $vpsid");
    
    // Prepare webhook payload
    $payload = array(
        'vpsid' => $vpsid,
        'virtualizorVmId' => (string)$vpsid,
        'event' => 'vm_deleted',
        'timestamp' => date('c'),
        'source' => 'virtualizor_deletevs_hook',
        'vps_name' => isset($vps['vps_name']) ? $vps['vps_name'] : null,
        'hostname' => isset($vps['hostname']) ? $vps['hostname'] : null
    );
    
    // Convert payload to JSON
    $jsonPayload = json_encode($payload);
    
    // Initialize cURL session
    $ch = curl_init(DEPLOYMENT_BOT_WEBHOOK_URL);
    
    if ($ch === false) {
        error_log("Virtualizor Hook (deletevs): Failed to initialize cURL for vpsid: $vpsid");
        return;
    }
    
    // Set cURL options
    curl_setopt_array($ch, array(
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $jsonPayload,
        CURLOPT_HTTPHEADER => array(
            'Content-Type: application/json',
            'Content-Length: ' . strlen($jsonPayload),
            'Authorization: Bearer ' . DEPLOYMENT_BOT_WEBHOOK_SECRET
        ),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        // Use Debian's CA certificate bundle path
        CURLOPT_CAINFO => '/etc/ssl/certs/ca-certificates.crt'
    ));
    
    // Execute the request
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    
    // Close cURL session
    curl_close($ch);
    
    // Log the result
    if ($httpCode >= 200 && $httpCode < 300) {
        error_log("Virtualizor Hook (deletevs): Successfully notified deployment bot of VM deletion (vpsid: $vpsid, status: $httpCode)");
    } else {
        error_log("Virtualizor Hook (deletevs): Failed to notify deployment bot (vpsid: $vpsid, status: $httpCode, curl_error: $curlError, response: $response)");
    }
}
?>
