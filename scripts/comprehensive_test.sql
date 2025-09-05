-- Comprehensive System Test Queries
-- Run these after backfill completes

-- 1. Data Collection Verification
SELECT 'Data Collection Status' as test_name;
SELECT 
  'transfers' as table_name, 
  COUNT(*) as record_count,
  COUNT(DISTINCT from_address) as unique_senders,
  COUNT(DISTINCT to_address) as unique_receivers,
  COUNT(DISTINCT contract_address) as unique_contracts
FROM transfers
UNION ALL
SELECT 
  'events',
  COUNT(*),
  COUNT(DISTINCT user_address),
  NULL,
  COUNT(DISTINCT contract_address)
FROM events
UNION ALL
SELECT 
  'unified_share_events',
  COUNT(*),
  COUNT(DISTINCT user_address),
  NULL,
  COUNT(DISTINCT contract_address)
FROM unified_share_events;

-- 2. Contract Coverage
SELECT 'Contract Coverage' as test_name;
SELECT 
  contract_address,
  contract_name,
  chain_id,
  COUNT(DISTINCT t.from_address) as unique_users,
  COUNT(t.id) as total_transfers
FROM transfers t
GROUP BY contract_address, contract_name, chain_id
ORDER BY chain_id, contract_name;

-- 3. Event Types Distribution
SELECT 'Event Types' as test_name;
SELECT 
  event_type,
  COUNT(*) as event_count,
  MIN(block_timestamp) as earliest_event,
  MAX(block_timestamp) as latest_event
FROM events
GROUP BY event_type;

-- 4. Chain Distribution
SELECT 'Chain Distribution' as test_name;
SELECT 
  chain_id,
  COUNT(DISTINCT user_address) as unique_users,
  COUNT(*) as total_events
FROM unified_share_events
GROUP BY chain_id;

-- 5. Balance Snapshots
SELECT 'Balance Snapshots' as test_name;
SELECT 
  DATE(snapshot_timestamp) as snapshot_date,
  COUNT(DISTINCT user_address) as users_with_balances,
  SUM(balance) as total_balance
FROM balance_snapshots
GROUP BY DATE(snapshot_timestamp)
ORDER BY snapshot_date DESC
LIMIT 10;

-- 6. USD Snapshots and Droplets
SELECT 'USD Snapshots' as test_name;
SELECT 
  DATE(snapshot_timestamp) as snapshot_date,
  COUNT(DISTINCT user_address) as active_users,
  SUM(total_usd_value) as total_tvl,
  AVG(total_usd_value) as avg_user_tvl
FROM user_usd_snapshots
GROUP BY DATE(snapshot_timestamp)
ORDER BY snapshot_date DESC
LIMIT 10;

-- 7. Droplet Awards
SELECT 'Droplet Awards' as test_name;
SELECT 
  DATE(awarded_at) as award_date,
  COUNT(DISTINCT user_address) as users_awarded,
  SUM(amount) as total_droplets,
  AVG(amount) as avg_droplets_per_user
FROM droplets_cache
GROUP BY DATE(awarded_at)
ORDER BY award_date DESC
LIMIT 10;

-- 8. Integration Protocols Status
SELECT 'Integration Protocols' as test_name;
SELECT 
  protocol_name,
  integration_type,
  chain_id,
  is_active
FROM integration_protocols
ORDER BY chain_id, integration_type;

-- 9. Integration Events
SELECT 'Integration Events' as test_name;
SELECT 
  ip.protocol_name,
  ie.event_type,
  COUNT(*) as event_count
FROM integration_events ie
JOIN integration_protocols ip ON ie.protocol_id = ip.id
GROUP BY ip.protocol_name, ie.event_type;

-- 10. Integration Positions
SELECT 'Integration Positions' as test_name;
SELECT 
  ip.protocol_name,
  COUNT(DISTINCT ipos.user_address) as unique_users,
  SUM(ipos.share_balance) as total_shares
FROM integration_positions ipos
JOIN integration_protocols ip ON ipos.protocol_id = ip.id
WHERE ipos.is_active = true
GROUP BY ip.protocol_name;

-- 11. Oracle Prices
SELECT 'Oracle Price Data' as test_name;
SELECT 
  asset,
  COUNT(*) as price_records,
  MIN(block_number) as earliest_block,
  MAX(block_number) as latest_block,
  MIN(timestamp) as earliest_time,
  MAX(timestamp) as latest_time
FROM oracle_prices_timeline
GROUP BY asset;

-- 12. System Health Check
SELECT 'System Health' as test_name;
SELECT 
  'Total Users' as metric,
  COUNT(DISTINCT user_address) as value
FROM (
  SELECT from_address as user_address FROM transfers
  UNION
  SELECT to_address FROM transfers
  UNION
  SELECT user_address FROM events
) users
UNION ALL
SELECT 
  'Total Transfers',
  COUNT(*)
FROM transfers
UNION ALL
SELECT 
  'Total Events',
  COUNT(*)
FROM events
UNION ALL
SELECT 
  'Total Droplets Awarded',
  COALESCE(SUM(amount), 0)
FROM droplets_cache;

-- 13. Error Detection
SELECT 'Potential Issues' as test_name;
SELECT 
  'Transfers without events' as issue,
  COUNT(DISTINCT t.transaction_hash) as count
FROM transfers t
LEFT JOIN events e ON t.transaction_hash = e.transaction_hash
WHERE e.id IS NULL
UNION ALL
SELECT 
  'Events without transfers',
  COUNT(DISTINCT e.transaction_hash)
FROM events e
LEFT JOIN transfers t ON e.transaction_hash = t.transaction_hash
WHERE t.id IS NULL;

-- 14. Latest Activity
SELECT 'Latest Activity' as test_name;
SELECT 
  'Latest Transfer' as activity,
  MAX(block_timestamp)::text as timestamp
FROM transfers
UNION ALL
SELECT 
  'Latest Event',
  MAX(block_timestamp)::text
FROM events
UNION ALL
SELECT 
  'Latest Snapshot',
  MAX(snapshot_timestamp)::text
FROM balance_snapshots
UNION ALL
SELECT 
  'Latest Droplet Award',
  MAX(awarded_at)::text
FROM droplets_cache;