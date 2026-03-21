# Virtualizor Hook Debugging Guide

## Quick Diagnostics

Run these commands on your **Virtualizor MASTER server** to diagnose why the hook isn't triggering:

### 1. Verify Hook File Exists

```bash
ls -la /usr/local/virtualizor/hooks/deletevs.php
```

**Expected output:**
```
-rw-r--r-- 1 root root 3500 Mar 19 12:00 /usr/local/virtualizor/hooks/deletevs.php
```

If file not found:
```bash
# Copy from your repo
sudo cp /path/to/scripts/deletevs.php /usr/local/virtualizor/hooks/deletevs.php
sudo chmod 644 /usr/local/virtualizor/hooks/deletevs.php
sudo chown root:root /usr/local/virtualizor/hooks/deletevs.php
```

### 2. Check PHP Syntax

```bash
php -l /usr/local/virtualizor/hooks/deletevs.php
```

**Expected output:**
```
No syntax errors detected in /usr/local/virtualizor/hooks/deletevs.php
```

If syntax errors, fix them before proceeding.

### 3. Verify Configuration is Set

```bash
grep -E "DEPLOYMENT_BOT_WEBHOOK_URL|DEPLOYMENT_BOT_WEBHOOK_SECRET" /usr/local/virtualizor/hooks/deletevs.php
```

**Should show:**
```php
define('DEPLOYMENT_BOT_WEBHOOK_URL', 'https://your-actual-domain.com/virtualizor/webhook/vm-deleted');
define('DEPLOYMENT_BOT_WEBHOOK_SECRET', 'your-actual-secret-token');
```

If still showing placeholder values, edit the file:
```bash
sudo nano /usr/local/virtualizor/hooks/deletevs.php
```

### 4. Test Hook Function Manually

Create a test script:

```bash
cat > /tmp/test-deletevs.php << 'EOF'
<?php
// Load the hook file
require_once('/usr/local/virtualizor/hooks/deletevs.php');

// Simulate a VM deletion event
$test_vps = array(
    'vpsid' => '999999',
    'vps_name' => 'test-hook-vm',
    'hostname' => 'test-hook.example.com'
);

echo "Testing deletevs hook with vpsid 999999...\n";
echo "Check your bot logs and syslog for results.\n\n";

// Call the hook function
__deletevs($test_vps);

echo "Test complete.\n";
echo "Expected log entry: 'Virtualizor Hook (deletevs)' in /var/log/syslog or /var/log/messages\n";
?>
EOF

sudo php /tmp/test-deletevs.php
```

**Check for log output:**
```bash
sudo tail -20 /var/log/syslog | grep "Virtualizor Hook"
# OR on CentOS/RHEL:
sudo tail -20 /var/log/messages | grep "Virtualizor Hook"
```

**Expected log entries:**
- Success: `"Successfully notified deployment bot of VM deletion (vpsid: 999999, status: 200)"`
- Config error: `"Webhook not configured. Please update..."`
- Network error: `"Failed to notify deployment bot (vpsid: 999999, status: 0, curl_error: ...)"`

### 5. Check Virtualizor Hook System

Verify Virtualizor can load hooks:

```bash
# Check if hooks directory exists and is readable
ls -la /usr/local/virtualizor/hooks/

# Look for other hook files
ls -1 /usr/local/virtualizor/hooks/*.php
```

### 6. Test with Real VM Deletion

**Important**: This will actually delete a VM!

1. Create a test VM in Virtualizor
2. Note the VM ID (vpsid)
3. Watch the logs in real-time:
   ```bash
   # Terminal 1: Watch syslog
   sudo tail -f /var/log/syslog | grep "deletevs"
   
   # Terminal 2: Watch bot logs
   docker compose logs -f bot | grep "Virtualizor"
   ```
4. Delete the test VM via Virtualizor web UI
5. Watch for log entries

## Common Issues & Solutions

### Issue 1: Hook File Not Being Called

**Symptoms**: No log entries when deleting VMs, even after manual test works.

**Possible causes:**

1. **Wrong hook type**: `deletevs` runs on MASTER server only. If you're deleting from a slave/compute node, the hook might not fire.
   
   **Solution**: Verify you're deleting from the master, or use `after_deletevps` on slave nodes.

2. **Virtualizor version**: Hooks were added in specific versions. Check your version:
   ```bash
   cat /usr/local/virtualizor/version.txt
   ```
   
   `deletevs` hook requires Virtualizor 2.9.9+ per the docs.

3. **Hook loading disabled**: Check Virtualizor configuration.

### Issue 2: Configuration Not Set Error

**Symptoms**: Log shows "Webhook not configured"

**Solution**: Edit the hook file and set real values:
```bash
sudo nano /usr/local/virtualizor/hooks/deletevs.php
```

Update these lines:
```php
define('DEPLOYMENT_BOT_WEBHOOK_URL', 'https://bot.yourdomain.com/virtualizor/webhook/vm-deleted');
define('DEPLOYMENT_BOT_WEBHOOK_SECRET', 'put-your-actual-secret-here');
```

### Issue 3: Network/cURL Errors

**Symptoms**: Log shows "Failed to notify deployment bot" with curl_error

**Common curl errors:**

- `"Could not resolve host"`: DNS issue
  ```bash
  # Test DNS resolution
  nslookup bot.yourdomain.com
  ```

- `"Connection refused"`: Bot not running or firewall blocking
  ```bash
  # Test connectivity
  curl -I https://bot.yourdomain.com/virtualizor/webhook/vm-deleted
  ```

- `"SSL certificate problem"`: Certificate invalid
  ```bash
  # Test with verbose output
  curl -v https://bot.yourdomain.com/virtualizor/webhook/vm-deleted
  ```
  
  **Quick fix** (not recommended for production):
  ```php
  // In deletevs.php, temporarily disable SSL verification:
  CURLOPT_SSL_VERIFYPEER => false,
  CURLOPT_SSL_VERIFYHOST => 0
  ```

- `"Timeout"`: Network latency or bot slow to respond
  ```php
  // Increase timeout in deletevs.php:
  CURLOPT_TIMEOUT => 30,  // Instead of 10
  ```

### Issue 4: Authentication Failures

**Symptoms**: Bot logs show "Rejected unauthorized Virtualizor webhook"

**Solution**: Verify secrets match:

1. Check hook secret:
   ```bash
   grep "DEPLOYMENT_BOT_WEBHOOK_SECRET" /usr/local/virtualizor/hooks/deletevs.php
   ```

2. Check bot secret:
   ```bash
   grep "VIRTUALIZOR_WEBHOOK_SECRET" /path/to/bot/.env
   ```

3. Ensure they match exactly (no extra spaces, newlines, or quotes)

### Issue 5: PHP cURL Extension Missing

**Symptoms**: Log shows "Failed to initialize cURL"

**Solution**: Install PHP cURL extension:

```bash
# CentOS/RHEL
sudo yum install php-curl
sudo systemctl restart httpd

# Debian/Ubuntu
sudo apt-get install php-curl
sudo systemctl restart apache2

# Verify installation
php -m | grep curl
```

### Issue 6: Wrong VPS Data Format

**Symptoms**: Log shows "Missing vpsid in $vps parameter"

**Debug**: Add verbose logging to see what $vps contains:

```php
// Add at the start of __deletevs() function:
error_log("Virtualizor Hook (deletevs): Received vps data: " . print_r($vps, true));
```

Then delete a VM and check what data structure Virtualizor actually passes.

## Advanced Debugging

### Enable Verbose Logging

Edit `/usr/local/virtualizor/hooks/deletevs.php` and add debug output:

```php
function __deletevs($vps) {
    // Add at the very start
    error_log("=== Virtualizor deletevs hook called ===");
    error_log("VPS data: " . json_encode($vps));
    
    // Your existing code...
    
    // Before the cURL call
    error_log("About to POST to: " . DEPLOYMENT_BOT_WEBHOOK_URL);
    error_log("Payload: " . $jsonPayload);
    
    // After the cURL call
    error_log("Response code: " . $httpCode);
    error_log("Response body: " . $response);
    error_log("=== Hook completed ===");
}
```

### Monitor Hook Execution in Real-Time

```bash
# Watch all hook activity
sudo tail -f /var/log/syslog | grep -i "virtualizor"

# Watch only deletevs hook
sudo tail -f /var/log/syslog | grep "deletevs"

# Watch bot webhook endpoint
docker compose logs -f bot | grep "webhook/vm-deleted"
```

### Verify Webhook Endpoint Directly

Test the bot endpoint from Virtualizor server:

```bash
curl -X POST https://bot.yourdomain.com/virtualizor/webhook/vm-deleted \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{
    "vpsid": "999999",
    "virtualizorVmId": "999999",
    "event": "vm_deleted",
    "timestamp": "2026-03-19T12:00:00Z",
    "source": "test"
  }'
```

Expected response:
```json
{"acknowledged": true, "found": false}
```

## Checklist

Before opening a support ticket, verify:

- [ ] Hook file exists at `/usr/local/virtualizor/hooks/deletevs.php`
- [ ] PHP syntax is valid (`php -l deletevs.php`)
- [ ] Configuration values are set (not placeholder values)
- [ ] Manual test script works and logs appear
- [ ] Bot is running and accessible from Virtualizor server
- [ ] Secrets match between hook and bot
- [ ] PHP cURL extension is installed
- [ ] You're deleting VMs from the MASTER server, not slaves
- [ ] Virtualizor version is 2.9.9 or higher

## Getting Help

If hook still doesn't work after checking everything:

1. **Collect diagnostic info:**
   ```bash
   # Save this output
   echo "=== System Info ===" > /tmp/hook-debug.txt
   cat /usr/local/virtualizor/version.txt >> /tmp/hook-debug.txt
   echo "" >> /tmp/hook-debug.txt
   echo "=== PHP Version ===" >> /tmp/hook-debug.txt
   php -v >> /tmp/hook-debug.txt
   echo "" >> /tmp/hook-debug.txt
   echo "=== PHP Modules ===" >> /tmp/hook-debug.txt
   php -m >> /tmp/hook-debug.txt
   echo "" >> /tmp/hook-debug.txt
   echo "=== Hook File ===" >> /tmp/hook-debug.txt
   ls -la /usr/local/virtualizor/hooks/deletevs.php >> /tmp/hook-debug.txt
   echo "" >> /tmp/hook-debug.txt
   echo "=== Recent Logs ===" >> /tmp/hook-debug.txt
   sudo grep -i "deletevs" /var/log/syslog | tail -20 >> /tmp/hook-debug.txt
   
   cat /tmp/hook-debug.txt
   ```

2. **Test manual execution output:**
   ```bash
   sudo php /tmp/test-deletevs.php 2>&1 | tee /tmp/manual-test.txt
   ```

3. **Share the output** with your support team along with bot logs.
