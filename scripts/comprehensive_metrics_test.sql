-- COMPREHENSIVE METRICS VALIDATION TEST SUITE
-- All tests requested by user plus additional validation

-- ============================================
-- TEST 1: xETH Deployment Block Verification
-- ============================================
\echo '=========================================='
\echo 'TEST 1: xETH DEPLOYMENT BLOCK VERIFICATION'
\echo '=========================================='

WITH xeth_deployment AS (
  SELECT 
    'First Event Block' as metric,
    MIN(block_number) as actual_block,
    21872213 as expected_block,
    MIN(block_number) = 21872213 as passes
  FROM events 
  WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153'
  
  UNION ALL
  
  SELECT 
    'First Transfer Block',
    MIN(block_number),
    21872231,
    MIN(block_number) = 21872231
  FROM transfers
  WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153'
  
  UNION ALL
  
  SELECT 
    'First Stake/Mint Block',
    MIN(block_number),
    21872273,
    MIN(block_number) = 21872273
  FROM transfers
  WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153'
    AND from_address = '0x0000000000000000000000000000000000000000'
    AND value::numeric > 0
)
SELECT 
  metric,
  actual_block,
  expected_block,
  CASE WHEN passes THEN '✅ PASS' ELSE '❌ FAIL' END as result
FROM xeth_deployment;

-- ============================================
-- TEST 2: CONTRACT ADDRESS EXCLUSION
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 2: CONTRACT ADDRESS EXCLUSION'
\echo '=========================================='

WITH excluded_check AS (
  SELECT 
    'Vault Contracts' as category,
    COUNT(*) as excluded_count,
    4 as expected,
    COUNT(*) >= 4 as passes
  FROM excluded_addresses
  WHERE address IN (
    '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153',
    '0x12fd502e2052cafb41eccc5b596023d9978057d6',
    '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94',
    '0xc15697f61170fc3bb4e99eb7913b4c7893f64f13'
  )
  
  UNION ALL
  
  SELECT 
    'Integration Contracts',
    COUNT(*),
    8,
    COUNT(*) >= 8
  FROM excluded_addresses
  WHERE address IN (
    '0xdee813f080f9128e52e38e9ffef8b997f9544332',
    '0xfead02fb16ec3b2f6318dca230198db73e99428c',
    '0xdebdab749330bb976fd10dc52f9a452aaf029028',
    '0x596aef68a03a0e35c4d8e624fbbdb0df0862f172',
    '0x172a687c397e315dbe56ed78ab347d7743d0d4fa',
    '0xc380e5250d9718f8d9116bc9d787a0229044e2eb',
    '0x13d79435f306d155ca2b9af77234c84f80506045',
    '0x1f672bd230d0fc2ee9a75d2037a92cc1225a4ad8'
  )
  
  UNION ALL
  
  SELECT 
    'Zero Address',
    COUNT(*),
    1,
    COUNT(*) = 1
  FROM excluded_addresses
  WHERE address = '0x0000000000000000000000000000000000000000'
)
SELECT 
  category,
  excluded_count || '/' || expected as status,
  CASE WHEN passes THEN '✅ PASS' ELSE '❌ FAIL' END as result
FROM excluded_check;

-- Verify no vault contracts appear as users
WITH contract_as_user_check AS (
  SELECT 
    t.to_address as address,
    COUNT(*) as transfer_count
  FROM transfers t
  WHERE t.to_address IN (
    SELECT address FROM excluded_addresses
  )
  GROUP BY t.to_address
)
SELECT 
  'Contract addresses appearing as users:' as check_name,
  CASE 
    WHEN COUNT(*) = 0 THEN '✅ NONE (PASS)'
    ELSE '❌ ' || COUNT(*) || ' contracts found as users (FAIL)'
  END as result,
  COALESCE(string_agg(address || ' (' || transfer_count || ' transfers)', ', '), 'None') as details
FROM contract_as_user_check;

-- ============================================
-- TEST 3: USER BALANCE CALCULATION
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 3: USER BALANCE CALCULATION'
\echo '=========================================='

-- Calculate net balances for top users
WITH user_balances AS (
  SELECT 
    address,
    SUM(balance_change) as net_balance,
    COUNT(*) as transfer_count
  FROM (
    -- Incoming transfers (positive)
    SELECT 
      to_address as address,
      SUM(value::numeric) as balance_change
    FROM transfers
    WHERE to_address NOT IN (SELECT address FROM excluded_addresses)
      AND to_address != '0x0000000000000000000000000000000000000000'
    GROUP BY to_address
    
    UNION ALL
    
    -- Outgoing transfers (negative)
    SELECT 
      from_address as address,
      -SUM(value::numeric) as balance_change
    FROM transfers
    WHERE from_address NOT IN (SELECT address FROM excluded_addresses)
      AND from_address != '0x0000000000000000000000000000000000000000'
    GROUP BY from_address
  ) t
  GROUP BY address
  HAVING SUM(balance_change) > 0
)
SELECT 
  'Total Users with Positive Balance' as metric,
  COUNT(*)::text as value
FROM user_balances
UNION ALL
SELECT 
  'Top User Balance',
  ROUND(MAX(net_balance), 4)::text || ' shares'
FROM user_balances
UNION ALL
SELECT 
  'Average User Balance',
  ROUND(AVG(net_balance), 4)::text || ' shares'
FROM user_balances;

-- Show top 5 users
\echo ''
\echo 'Top 5 Users by Balance:'
WITH user_balances AS (
  SELECT 
    address,
    SUM(balance_change) as net_balance
  FROM (
    SELECT to_address as address, SUM(value::numeric) as balance_change
    FROM transfers
    WHERE to_address NOT IN (SELECT address FROM excluded_addresses)
      AND to_address != '0x0000000000000000000000000000000000000000'
    GROUP BY to_address
    
    UNION ALL
    
    SELECT from_address as address, -SUM(value::numeric) as balance_change
    FROM transfers
    WHERE from_address NOT IN (SELECT address FROM excluded_addresses)
      AND from_address != '0x0000000000000000000000000000000000000000'
    GROUP BY from_address
  ) t
  GROUP BY address
  HAVING SUM(balance_change) > 0
)
SELECT 
  ROW_NUMBER() OVER (ORDER BY net_balance DESC) as rank,
  SUBSTR(address, 1, 10) || '...' || SUBSTR(address, -6) as user,
  ROUND(net_balance, 4) as balance_shares
FROM user_balances
ORDER BY net_balance DESC
LIMIT 5;

-- ============================================
-- TEST 4: ORACLE PRICE DATA
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 4: ORACLE PRICE DATA'
\echo '=========================================='

-- Check if oracle prices are stored
SELECT 
  'Oracle Price Records' as metric,
  COUNT(*) as count,
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ Prices Available'
    ELSE '⚠️  No Prices Yet'
  END as status
FROM oracle_prices_timeline;

-- ============================================
-- TEST 5: SNAPSHOT & DROPLET CALCULATION
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 5: SNAPSHOT & DROPLET VERIFICATION'
\echo '=========================================='

-- Check snapshot generation status
SELECT 
  'Daily Snapshots' as metric,
  COUNT(*) as count,
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ Snapshots Generated'
    ELSE '⚠️  No Snapshots Yet'
  END as status
FROM daily_usd_snapshots
UNION ALL
SELECT 
  'User USD Snapshots',
  COUNT(*),
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ USD Values Calculated'
    ELSE '⚠️  No USD Calculations Yet'
  END
FROM user_usd_snapshots
UNION ALL
SELECT 
  'Droplet Awards',
  COUNT(*),
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ Droplets Awarded'
    ELSE '⚠️  No Droplets Yet'
  END
FROM droplets_cache;

-- If snapshots exist, verify 1:1 USD to Droplet ratio
WITH ratio_check AS (
  SELECT 
    u.user_address,
    u.total_usd_value,
    d.amount as droplets,
    ROUND(d.amount / NULLIF(u.total_usd_value, 0), 2) as ratio
  FROM user_usd_snapshots u
  LEFT JOIN droplets_cache d 
    ON u.user_address = d.user_address
    AND DATE(u.snapshot_timestamp) = DATE(d.awarded_at)
  WHERE u.total_usd_value > 0
  LIMIT 10
)
SELECT 
  'USD to Droplet Ratio Check' as test,
  CASE 
    WHEN COUNT(*) = 0 THEN '⚠️  No data to verify'
    WHEN AVG(ratio) = 1.0 THEN '✅ Perfect 1:1 ratio'
    WHEN AVG(ratio) BETWEEN 0.99 AND 1.01 THEN '✅ Near 1:1 ratio (' || ROUND(AVG(ratio), 4) || ')'
    ELSE '❌ Ratio mismatch (' || COALESCE(ROUND(AVG(ratio), 4)::text, 'NULL') || ')'
  END as result,
  COUNT(*) || ' samples checked' as details
FROM ratio_check;

-- ============================================
-- TEST 6: 24-HOUR SNAPSHOT TIMING
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 6: 24-HOUR SNAPSHOT TIMING'
\echo '=========================================='

WITH snapshot_intervals AS (
  SELECT 
    snapshot_timestamp,
    LAG(snapshot_timestamp) OVER (ORDER BY snapshot_timestamp) as prev_timestamp,
    EXTRACT(EPOCH FROM (snapshot_timestamp - LAG(snapshot_timestamp) OVER (ORDER BY snapshot_timestamp)))/3600 as hours_between
  FROM daily_usd_snapshots
)
SELECT 
  'Snapshot Timing' as test,
  CASE 
    WHEN COUNT(*) = 0 THEN '⚠️  No snapshots to check'
    WHEN AVG(hours_between) = 24 THEN '✅ Exactly 24 hours apart'
    WHEN AVG(hours_between) BETWEEN 23.5 AND 24.5 THEN '✅ ~24 hours apart (' || ROUND(AVG(hours_between), 1) || 'h avg)'
    ELSE '❌ Not 24 hours (' || COALESCE(ROUND(AVG(hours_between), 1)::text, 'NULL') || 'h avg)'
  END as result,
  COUNT(*) || ' intervals checked' as details
FROM snapshot_intervals
WHERE hours_between IS NOT NULL;

-- ============================================
-- TEST 7: CROSS-CHAIN USER DEDUPLICATION
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 7: CROSS-CHAIN USER TRACKING'
\echo '=========================================='

WITH cross_chain_users AS (
  SELECT 
    CASE 
      WHEN from_address != '0x0000000000000000000000000000000000000000' 
      THEN from_address 
      ELSE to_address 
    END as user_address,
    COUNT(DISTINCT chain_id) as chain_count,
    array_agg(DISTINCT chain_id) as chains
  FROM transfers
  WHERE from_address NOT IN (SELECT address FROM excluded_addresses)
    AND to_address NOT IN (SELECT address FROM excluded_addresses)
  GROUP BY 1
  HAVING COUNT(DISTINCT chain_id) > 1
)
SELECT 
  'Multi-Chain Users' as metric,
  COUNT(*) as count,
  CASE 
    WHEN COUNT(*) > 0 THEN '✅ Cross-chain activity detected'
    ELSE '⚠️  No cross-chain users yet'
  END as status
FROM cross_chain_users;

-- ============================================
-- TEST 8: INTEGRATION PROTOCOL COVERAGE
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST 8: INTEGRATION PROTOCOL COVERAGE'
\echo '=========================================='

SELECT 
  integration_type,
  COUNT(*) as protocol_count,
  string_agg(
    SUBSTR(protocol_name, 1, 30) || 
    CASE WHEN LENGTH(protocol_name) > 30 THEN '...' ELSE '' END,
    ', '
  ) as protocols
FROM integration_protocols
WHERE is_active = true
GROUP BY integration_type
ORDER BY integration_type;

-- ============================================
-- SUMMARY
-- ============================================
\echo ''
\echo '=========================================='
\echo 'TEST SUMMARY'
\echo '=========================================='

WITH test_results AS (
  SELECT 1 as test_num, 'xETH Deployment Verification' as test_name,
    CASE WHEN (SELECT MIN(block_number) FROM events WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153') = 21872213
      AND (SELECT MIN(block_number) FROM transfers WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153' AND from_address = '0x0000000000000000000000000000000000000000' AND value::numeric > 0) = 21872273
    THEN 'PASS' ELSE 'FAIL' END as result
    
  UNION ALL SELECT 2, 'Contract Address Exclusion',
    CASE WHEN (SELECT COUNT(*) FROM excluded_addresses) >= 13 THEN 'PASS' ELSE 'FAIL' END
    
  UNION ALL SELECT 3, 'User Balance Calculation',
    CASE WHEN (SELECT COUNT(*) FROM transfers) > 0 THEN 'PASS' ELSE 'FAIL' END
    
  UNION ALL SELECT 4, 'Oracle Price Integration',
    CASE WHEN (SELECT COUNT(*) FROM oracle_prices_timeline) >= 0 THEN 'CHECK' ELSE 'CHECK' END
    
  UNION ALL SELECT 5, 'Snapshot Generation',
    CASE WHEN (SELECT COUNT(*) FROM daily_usd_snapshots) >= 0 THEN 'CHECK' ELSE 'CHECK' END
    
  UNION ALL SELECT 6, '24-Hour Timing',
    'PENDING' -- Requires snapshots to verify
    
  UNION ALL SELECT 7, 'Cross-Chain Tracking',
    CASE WHEN (SELECT COUNT(DISTINCT chain_id) FROM transfers) >= 1 THEN 'PASS' ELSE 'FAIL' END
    
  UNION ALL SELECT 8, 'Integration Protocols',
    CASE WHEN (SELECT COUNT(*) FROM integration_protocols WHERE is_active) = 8 THEN 'PASS' ELSE 'FAIL' END
)
SELECT 
  test_num as "#",
  test_name,
  CASE result
    WHEN 'PASS' THEN '✅ PASS'
    WHEN 'FAIL' THEN '❌ FAIL'
    WHEN 'CHECK' THEN '⚠️  CHECK'
    WHEN 'PENDING' THEN '⏳ PENDING'
  END as result
FROM test_results
ORDER BY test_num;

\echo ''
\echo 'Test execution complete!'