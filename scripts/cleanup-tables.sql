-- Table Cleanup Script - Remove unused legacy tables
-- WARNING: This will permanently delete these tables and their data

-- 1. Legacy Round-based tables (old architecture)
DROP TABLE IF EXISTS stakes CASCADE;
DROP TABLE IF EXISTS unstakes CASCADE;
DROP TABLE IF EXISTS unstake_events CASCADE;
DROP TABLE IF EXISTS rounds CASCADE;
DROP TABLE IF EXISTS round_snapshot_jobs CASCADE;
DROP TABLE IF EXISTS balance_cache CASCADE;
DROP TABLE IF EXISTS pending_transactions CASCADE;

-- 2. Redundant share tracking (duplicated by other tables)
DROP TABLE IF EXISTS share_events CASCADE;
DROP TABLE IF EXISTS share_transfers CASCADE;
DROP TABLE IF EXISTS unified_share_events CASCADE;
DROP TABLE IF EXISTS current_balances CASCADE;

-- 3. Unused configuration tables
DROP TABLE IF EXISTS chain_asset_mapping CASCADE;
DROP TABLE IF EXISTS chain_configurations CASCADE;
DROP TABLE IF EXISTS rate_configuration CASCADE;

-- 4. Unused vault tracking (replaced by simpler approach)
DROP TABLE IF EXISTS vault_states CASCADE;
DROP TABLE IF EXISTS vault_exchange_rates CASCADE;

-- These tables would reduce from 45 to 26 tables
-- Keeping:
-- Core: transfers, events, chain_share_balances
-- Droplets: daily_usd_snapshots, user_usd_snapshots, droplets_cache, droplets_integration, droplets_leaderboard
-- Integrations: integration_protocols, integration_positions, integration_events, integration_cursors, integration_droplets_cache
-- Cross-chain: bridge_events, cross_chain_transfers, multi_chain_balances
-- Oracle: oracle_prices, oracle_prices_timeline, price_snapshots
-- Snapshots: balance_snapshots, daily_snapshot_jobs, timeline_intervals
-- System: config, excluded_addresses, system_state, cursors, knex_migrations, knex_migrations_lock, lp_pool_reserves