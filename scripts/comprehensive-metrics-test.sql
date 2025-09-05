-- Comprehensive Metrics Test for Stream Droplets

-- 1. Verify contract addresses are excluded
SELECT 'Contract Address Exclusion Test' as test;
SELECT 
  'Contracts in balance table' as metric,
  COUNT(*) as count
FROM chain_share_balances
WHERE address IN (
  '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153', -- xETH contract
  '0x12fd502e2052cafb41eccc5b596023d9978057d6', -- xBTC contract
  '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94', -- xUSD contract
  '0xc15697f61170fc3bb4e99eb7913b4c7893f64f13'  -- xEUR contract
);

-- 2. Verify first xETH contract records
SELECT 'First xETH Contract Records' as test;
SELECT 
  MIN(block_number) as first_block,
  COUNT(*) as total_events
FROM events
WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153';

-- 3. Check first stake event
SELECT 'First Stake Event' as test;
SELECT 
  event_name,
  block_number,
  transaction_hash,
  (decoded_data::json)->>'account' as user_address
FROM events
WHERE contract_address = '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153'
  AND event_name = 'Stake'
ORDER BY block_number ASC
LIMIT 1;

-- 4. Verify droplet calculation (1:1 USD ratio)
SELECT 'Droplet Calculation Test' as test;
SELECT 
  dc.user_address,
  dc.amount as droplets_awarded,
  uss.total_usd_value as usd_value,
  dc.amount::numeric = FLOOR(uss.total_usd_value::numeric) as is_1_to_1_ratio
FROM droplets_cache dc
JOIN user_usd_snapshots uss ON dc.user_address = uss.address
  AND DATE(uss.snapshot_time) = dc.snapshot_date
LIMIT 5;

-- 5. Check unique users with balances
SELECT 'Unique Users with Balances' as test;
SELECT 
  'Users with non-zero shares' as metric,
  COUNT(DISTINCT address) as count
FROM chain_share_balances
WHERE shares::numeric > 0;

-- 6. Check daily snapshots
SELECT 'Daily Snapshots' as test;
SELECT 
  DATE(snapshot_time) as snapshot_date,
  COUNT(*) as users_snapshotted,
  SUM(total_usd_value::numeric) as total_usd,
  SUM(droplets_earned::numeric) as total_droplets
FROM user_usd_snapshots
GROUP BY DATE(snapshot_time)
ORDER BY snapshot_date DESC
LIMIT 5;

-- 7. Check excluded addresses
SELECT 'Excluded Addresses' as test;
SELECT 
  'Total excluded addresses' as metric,
  COUNT(*) as count
FROM excluded_addresses;

-- 8. Verify no custody contracts in balances
SELECT 'Custody Contract Check' as test;
SELECT 
  address,
  asset,
  shares
FROM chain_share_balances
WHERE address LIKE '0x000000%' -- Common pattern for system addresses
   OR address IN (
     SELECT address FROM excluded_addresses
   )
LIMIT 5;

-- 9. Top users by USD value
SELECT 'Top Users by USD Value' as test;
SELECT 
  address,
  total_usd_value,
  xeth_usd_value,
  xbtc_usd_value,
  xusd_usd_value,
  xeur_usd_value
FROM user_usd_snapshots
WHERE round_id = (SELECT MAX(round_id) FROM user_usd_snapshots)
ORDER BY total_usd_value DESC
LIMIT 5;

-- 10. Summary statistics
SELECT 'Summary Statistics' as test;
WITH latest_round AS (
  SELECT MAX(round_id) as round_id FROM user_usd_snapshots
)
SELECT 
  'Total unique users' as metric,
  COUNT(DISTINCT address) as value
FROM user_usd_snapshots
WHERE round_id = (SELECT round_id FROM latest_round)
UNION ALL
SELECT 
  'Total USD value locked',
  SUM(total_usd_value::numeric)::text
FROM user_usd_snapshots
WHERE round_id = (SELECT round_id FROM latest_round)
UNION ALL
SELECT 
  'Total droplets awarded today',
  SUM(amount::numeric)::text
FROM droplets_cache
WHERE snapshot_date = CURRENT_DATE;