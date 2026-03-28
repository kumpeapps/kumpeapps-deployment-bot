-- Check what config is actually stored in the database
-- Replace 'your-repo-name' and 'stage' with your actual values

SELECT 
  id,
  environment,
  configPath,
  lastSeenCommitSha,
  updatedAt,
  parsedJson->>'env_mappings' as env_mappings
FROM "DeploymentConfig"
WHERE 
  repositoryId IN (
    SELECT id FROM "Repository" 
    WHERE name = 'your-repo-name'  -- Replace with your repo name
  )
  AND environment = 'stage';  -- Replace with your environment
