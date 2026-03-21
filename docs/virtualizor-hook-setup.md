# Virtualizor Hook Setup Guide

## Overview

The Virtualizor VM deletion hook automatically notifies the deployment bot when a VM is deleted in Virtualizor, allowing the bot to clean up its database records accordingly.

## How Virtualizor Hooks Work

Virtualizor hooks are PHP files placed in `/usr/local/virtualizor/hooks/` that define functions called by Virtualizor at specific lifecycle events. For VM deletion, Virtualizor provides:

- **`after_deletevps.php`** - Runs on the **slave server** where the VM was located (after VM deletion on that server)
- **`deletevs.php`** - Runs on the **MASTER server** after VM is fully deleted from the system (this is what we use)

The hook receives a `$vps` parameter containing VM data including `vpsid` (the Virtualizor VM ID).

Reference: [Virtualizor Hooks Documentation](https://www.virtualizor.com/docs/developers/hooks/)

## Architecture

**Virtualizor Master** → **`deletevs.php` Hook Function** → **Deployment Bot Webhook** → **Database Cleanup**

## Installation Steps

### 1. Configure Environment Variables

Set this environment variable in your deployment bot's `.env` file:

```bash
# Webhook secret for authenticating Virtualizor callbacks
VIRTUALIZOR_WEBHOOK_SECRET=your-secure-random-token-here
```

Generate a secure random token:
```bash
openssl rand -base64 32
```

### 2. Configure the Hook Script

Edit the hook script at `scripts/deletevs.php` and update the configuration constants at the top:

```php
define('DEPLOYMENT_BOT_WEBHOOK_URL', 'https://your-bot-domain.com/virtualizor/webhook/vm-deleted');
define('DEPLOYMENT_BOT_WEBHOOK_SECRET', 'your-webhook-secret-here');
```

**Important**: Use the SAME secret you configured in step 1.

### 3. Install the Hook on Virtualizor Master Server

Copy the configured hook script to your Virtualizor **MASTER** server:

```bash
# Copy the script to Virtualizor hooks directory
sudo cp scripts/deletevs.php /usr/local/virtualizor/hooks/deletevs.php

# Set proper permissions
sudo chmod 644 /usr/local/virtualizor/hooks/deletevs.php
sudo chown root:root /usr/local/virtualizor/hooks/deletevs.php
```

**Note**: The file MUST be named `deletevs.php` - this is the filename Virtualizor looks for.

### 4. Verify Installation

Check that the hook file exists and is readable:

```bash
ls -l /usr/local/virtualizor/hooks/deletevs.php
cat /usr/local/virtualizor/hooks/deletevs.php | grep "function __deletevs"
```

You should see the function definition: `function __deletevs($vps) {`

### 5. Test the Hook

Before relying on automatic triggering, test the hook manually:

```bash
# Create test script
cat > /tmp/test-deletevs.php << 'EOF'
<?php
require_once('/usr/local/virtualizor/hooks/deletevs.php');

$test_vps = array(
    'vpsid' => '999999',
    'vps_name' => 'test-vm',
    'hostname' => 'test.example.com'
);

echo "Testing deletevs hook...\n";
__deletevs($test_vps);
echo "Check syslog for results: sudo tail -20 /var/log/syslog | grep deletevs\n";
?>
EOF

# Run the test
sudo php /tmp/test-deletevs.php

# Check logs
sudo tail -20 /var/log/syslog | grep "Virtualizor Hook"
```

**Expected log output:**
- `"Virtualizor Hook (deletevs): Hook triggered"`
- `"Virtualizor Hook (deletevs): Processing deletion for vpsid: 999999"`
- Either success or error message about webhook delivery

**If you don't see "Hook triggered"**: The function isn't being called. Check PHP syntax.

**If you see configuration error**: Edit the hook file and set real values for URL and secret.

**If you see network errors**: Check connectivity from Virtualizor server to bot.

### 6. No Additional Configuration Needed

Unlike some other systems, Virtualizor automatically loads and executes hook files from the hooks directory. There's no need to register or enable the hook through the admin panel - it will be called automatically when a VM is deleted.

## Testing

### Manual Test of the Webhook Endpoint

You can test the webhook endpoint directly without triggering a real VM deletion:

```bash
curl -X POST https://your-bot-domain.com/virtualizor/webhook/vm-deleted \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secure-random-token-here" \
  -d '{
    "vpsid": "12345",
    "virtualizorVmId": "12345",
    "event": "vm_deleted",
    "timestamp": "2026-03-19T12:00:00Z",
    "source": "virtualizor_deletevs_hook"
  }'
```

Expected response (if VM found):
```json
{
  "acknowledged": true,
  "found": true,
  "deleted": {
    "vmId": 123,
    "repository": "owner/repo",
    "vmHostname": "example-vm.local",
    "caddyCleanup": "Removed 2 Caddy file(s) and reloaded"
  }
}
```

Or if VM not found:
```json
{
  "acknowledged": true,
  "found": false
}
```

**Note**: The `caddyCleanup` field shows the result of Caddy config removal:
- Success: `"Removed N Caddy file(s) and reloaded"`
- No files: `"No Caddy config found for this deployment"`
- Error: `"Error: <error message>"`
- Missing environment: `null` (no cleanup attempted)

### Test the Hook Function

Create a test script on your Virtualizor master server to verify the hook function works:

```php
<?php
// test-deletevs-hook.php
include '/usr/local/virtualizor/hooks/deletevs.php';

// Simulate a VPS deletion event
$test_vps = array(
    'vpsid' => '99999',
    'vps_name' => 'test-vm',
    'hostname' => 'test-vm.example.com'
);

echo "Testing deletevs hook with vpsid 99999...\n";
__deletevs($test_vps);
echo "Test complete. Check logs for results.\n";
?>
```

Run the test:
```bash
sudo php /path/to/test-deletevs-hook.php
```

### Check Logs

Monitor the deployment bot logs for webhook events:

```bash
docker compose logs -f bot | grep "Virtualizor"
```

Look for log entries like:
- `Processing Virtualizor VM deletion webhook`
- `VM deleted from database via Virtualizor webhook`

Check Virtualizor system logs (usually `/var/log/syslog` or `/var/log/messages`):

```bash
sudo grep "Virtualizor Hook (deletevs)" /var/log/syslog
```

Look for:
- `Successfully notified deployment bot of VM deletion`
- `Failed to notify deployment bot` (if there are issues)

## Security Considerations

1. **Secret Token**: Use a strong, randomly generated token for `VIRTUALIZOR_WEBHOOK_SECRET`
2. **HTTPS Only**: Always use HTTPS for the webhook URL in production
3. **Network Security**: Consider restricting webhook endpoint access to Virtualizor server IPs via firewall rules
4. **Token Rotation**: Periodically rotate the webhook secret and update both the bot and hook script

## Troubleshooting

### Hook Not Executing

**Symptoms**: VM deletions in Virtualizor don't trigger webhook calls to the bot.

**Checks**:
1. Verify the hook file exists: `ls -l /usr/local/virtualizor/hooks/deletevs.php`
2. Check file permissions (should be readable by Virtualizor process):
   ```bash
   sudo chmod 644 /usr/local/virtualizor/hooks/deletevs.php
   ```
3. Verify PHP syntax is valid:
   ```bash
   php -l /usr/local/virtualizor/hooks/deletevs.php
   ```
4. Check the function name is exactly `__deletevs` (with two underscores)
5. Test with the PHP test script shown above

### Configuration Not Set Error

**Symptoms**: Logs show "Webhook not configured" message.

**Solution**: Edit `/usr/local/virtualizor/hooks/deletevs.php` and update the `define()` constants:
```php
define('DEPLOYMENT_BOT_WEBHOOK_URL', 'https://your-actual-bot-url.com/virtualizor/webhook/vm-deleted');
define('DEPLOYMENT_BOT_WEBHOOK_SECRET', 'your-actual-secret-token');
```

### Authentication Failures

**Symptoms**: Bot logs show "Rejected unauthorized Virtualizor webhook".

**Checks**:
1. Verify `DEPLOYMENT_BOT_WEBHOOK_SECRET` in `deletevs.php` matches `VIRTUALIZOR_WEBHOOK_SECRET` in bot's `.env`
2. Check for whitespace or newline characters in the secret strings
3. Verify the Authorization header format is correct: `Bearer <secret>`
4. Test manually with curl to isolate the issue

### VM Not Found in Database

**Symptoms**: Webhook returns `{"found": false}`.

This is expected behavior if:
- The VM was manually deleted from the bot database
- The VM was created outside the bot's control
- The `virtualizorVmId` in the database doesn't match the Virtualizor `vpsid`

**Check**: Query the bot database to see if the VM exists:
```sql
SELECT * FROM vms WHERE virtualizorVmId = 'your-vpsid';
```

The webhook will log a warning but return success (200) to avoid retry loops.

### Network Issues

**Symptoms**: Hook logs show "Failed to notify deployment bot" with curl errors.

**Checks**:
1. Verify the webhook URL is accessible from Virtualizor master server:
   ```bash
   curl -I https://your-bot-domain.com/virtualizor/webhook/vm-deleted
   ```
2. Check SSL certificate is valid and trusted
3. Verify firewall rules allow outbound HTTPS from Virtualizor master
4. Check DNS resolution: `nslookup your-bot-domain.com`
5. Review bot firewall rules if webhook endpoint is IP-restricted

### cURL Not Available

**Symptoms**: Hook fails with "Failed to initialize cURL".

**Solution**: Install cURL PHP extension on Virtualizor master:
```bash
# For CentOS/RHEL
sudo yum install php-curl

# For Debian/Ubuntu  
sudo apt-get install php-curl

# Restart web server
sudo systemctl restart httpd   # or apache2
```

### Caddy Cleanup Failures

**Symptoms**: VM deletion succeeds but Caddy configs remain.

**Checks**:
1. Verify bot can SSH to Caddy server:
   ```bash
   ssh -i /path/to/key -p <port> user@caddy-server
   ```
2. Check VM metadata contains environment:
   ```sql
   SELECT metadata FROM vms WHERE virtualizorVmId = 'your-vpsid';
   ```
3. Verify deployment config exists:
   ```sql
   SELECT * FROM deployment_configs 
   WHERE repositoryId = X AND environment = 'prod';
   ```
4. Check bot logs for Caddy cleanup errors:
   ```bash
   docker compose logs bot | grep "Caddy config cleanup"
   ```

**Note**: Caddy cleanup is non-blocking - VM deletion succeeds even if Caddy cleanup fails. Manual cleanup may be needed:
```bash
ssh user@caddy-server "rm -f /path/to/config/example.com.caddy && sudo docker exec caddy caddy reload"
```

## Webhook Payload

The hook function sends this JSON payload to the deployment bot:

```json
{
  "vpsid": "12345",
  "virtualizorVmId": "12345",
  "event": "vm_deleted",
  "timestamp": "2026-03-19T12:00:00Z",
  "source": "virtualizor_deletevs_hook",
  "vps_name": "example-vm",
  "hostname": "example-vm.example.com"
}
```

**Fields**:
- `vpsid` - The Virtualizor VPS ID (number)
- `virtualizorVmId` - String version of the VPS ID (used for database lookup)
- `event` - Always "vm_deleted"
- `timestamp` - ISO 8601 timestamp when hook was triggered
- `source` - Identifies this came from the deletevs hook
- `vps_name` - VM name from Virtualizor (if available)
- `hostname` - VM hostname from Virtualizor (if available)

## How It Works

1. **Admin deletes VM in Virtualizor** (via web UI or API)
2. **Virtualizor deletes the VM** from the hypervisor
3. **Virtualizor calls `__deletevs()` function** and passes `$vps` array
4. **Hook extracts `vpsid`** from the `$vps` parameter
5. **Hook makes HTTPS POST** to deployment bot webhook endpoint
6. **Bot receives webhook**, authenticates via Bearer token
7. **Bot queries database** for VM with matching `virtualizorVmId`
8. **Bot performs Caddy cleanup**:
   - Extracts environment from VM metadata
   - Finds latest successful deployment for repo + environment
   - Gets Caddy file names from deployment config
   - Removes those files from Caddy server (e.g., `example.com.caddy`)
   - Reloads Caddy to apply changes
9. **Bot deletes VM record** from database and returns response
10. **Hook logs result** to syslog

## Maintenance

### Monitoring

Monitor webhook success rate:
- Check bot logs regularly: `docker compose logs bot | grep "Virtualizor"`
- Monitor Virtualizor master syslog: `sudo grep "deletevs" /var/log/syslog`
- Set up alerts for repeated failures
- Track VM count discrepancies between Virtualizor and bot database

### Updating the Hook

When updating the hook script:

1. **Edit the hook file** with your changes
2. **Test syntax**: `php -l scripts/deletevs.php`
3. **Copy to Virtualizor master**:
   ```bash
   sudo cp scripts/deletevs.php /usr/local/virtualizor/hooks/deletevs.php
   ```
4. **Test with manual webhook call** (see Testing section)
5. **Delete a test VM** in Virtualizor to verify end-to-end
6. **Monitor logs** for successful webhook delivery

No server restart is needed - hooks are loaded on-demand by Virtualizor.

### Secret Rotation

To rotate the webhook secret:

1. **Generate new secret**: `openssl rand -base64 32`
2. **Update bot `.env`**: Set new `VIRTUALIZOR_WEBHOOK_SECRET`
3. **Restart bot**: `docker compose restart bot`
4. **Update hook file**: Edit `DEPLOYMENT_BOT_WEBHOOK_SECRET` in `deletevs.php`
5. **Copy to master**: `sudo cp ... /usr/local/virtualizor/hooks/deletevs.php`
6. **Test**: Delete a test VM and verify webhook succeeds

## Related Documentation

- [Virtualizor Hooks Documentation](https://www.virtualizor.com/docs/developers/hooks/)
- [Virtualizor Hook Debugging Guide](./virtualizor-hook-debugging.md) - **Troubleshooting if hook not triggering**
- [Deployment Bot User Guide](./user-guide.md)
- [Operator Runbook](./operator-runbook.md)
