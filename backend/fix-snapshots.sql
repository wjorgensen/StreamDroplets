-- Create balance snapshots from share events
INSERT INTO balance_snapshots (address, asset, round_id, shares_at_start, had_unstake_in_round)
SELECT DISTINCT 
  se.address,
  se.asset,
  r.round_id,
  COALESCE(
    (SELECT SUM(
      CASE 
        WHEN event_type = 'stake' THEN CAST(shares_delta AS NUMERIC)
        WHEN event_type = 'unstake' THEN CAST(shares_delta AS NUMERIC)
        ELSE 0
      END
    )
    FROM share_events se2
    WHERE se2.address = se.address 
      AND se2.asset = se.asset
      AND se2.round < r.round_id
    ), 0
  ) as shares_at_start,
  EXISTS (
    SELECT 1 FROM unstake_events ue 
    WHERE ue.address = se.address 
      AND ue.asset = se.asset 
      AND ue.round = r.round_id
  ) as had_unstake_in_round
FROM share_events se
CROSS JOIN rounds r
WHERE r.asset = se.asset
  AND se.address NOT IN (SELECT address FROM excluded_addresses)
  AND r.round_id <= (SELECT MAX(round) FROM share_events WHERE address = se.address AND asset = se.asset)
ON CONFLICT (address, asset, round_id) DO NOTHING;

-- Update current balances
INSERT INTO current_balances (address, asset, chain_id, shares, last_update_block)
SELECT 
  address,
  asset,
  1 as chain_id,
  SUM(
    CASE 
      WHEN event_type = 'stake' THEN CAST(shares_delta AS NUMERIC)
      WHEN event_type = 'unstake' THEN CAST(shares_delta AS NUMERIC)
      ELSE 0
    END
  ) as shares,
  MAX(block) as last_update_block
FROM share_events
WHERE address NOT IN (SELECT address FROM excluded_addresses)
GROUP BY address, asset
HAVING SUM(
  CASE 
    WHEN event_type IN ('stake', 'redeem') THEN CAST(shares_delta AS NUMERIC)
    WHEN event_type = 'unstake' THEN CAST(shares_delta AS NUMERIC)
    ELSE 0
  END
) > 0
ON CONFLICT (address, asset, chain_id) 
DO UPDATE SET 
  shares = EXCLUDED.shares,
  last_update_block = EXCLUDED.last_update_block;

SELECT 'Created snapshots for ' || COUNT(DISTINCT address) || ' users' as status
FROM balance_snapshots;
