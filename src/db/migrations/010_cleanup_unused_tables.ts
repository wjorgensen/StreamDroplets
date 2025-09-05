import { Knex } from 'knex';

/**
 * Migration to clean up unused tables from legacy architecture
 * Removes 15 tables that are no longer needed after moving to daily snapshot system
 */
export async function up(knex: Knex): Promise<void> {
  console.log('Starting cleanup of unused tables...');
  
  // Drop unused round-based tables
  await knex.schema.dropTableIfExists('rounds');
  console.log('Dropped: rounds');
  
  await knex.schema.dropTableIfExists('round_snapshot_jobs');
  console.log('Dropped: round_snapshot_jobs');
  
  // Drop duplicate staking tables
  await knex.schema.dropTableIfExists('stakes');
  console.log('Dropped: stakes');
  
  await knex.schema.dropTableIfExists('unstakes');
  console.log('Dropped: unstakes');
  
  await knex.schema.dropTableIfExists('unstake_events');
  console.log('Dropped: unstake_events');
  
  // Drop duplicate event tables
  await knex.schema.dropTableIfExists('share_events');
  console.log('Dropped: share_events');
  
  await knex.schema.dropTableIfExists('share_transfers');
  console.log('Dropped: share_transfers');
  
  await knex.schema.dropTableIfExists('unified_share_events');
  console.log('Dropped: unified_share_events');
  
  // Drop unused balance tracking tables
  await knex.schema.dropTableIfExists('current_balances');
  console.log('Dropped: current_balances');
  
  await knex.schema.dropTableIfExists('balance_cache');
  console.log('Dropped: balance_cache');
  
  // Drop unused configuration tables
  await knex.schema.dropTableIfExists('chain_asset_mapping');
  console.log('Dropped: chain_asset_mapping');
  
  await knex.schema.dropTableIfExists('chain_configurations');
  console.log('Dropped: chain_configurations');
  
  await knex.schema.dropTableIfExists('rate_configuration');
  console.log('Dropped: rate_configuration');
  
  // Drop unused vault tables
  await knex.schema.dropTableIfExists('vault_states');
  console.log('Dropped: vault_states');
  
  await knex.schema.dropTableIfExists('vault_exchange_rates');
  console.log('Dropped: vault_exchange_rates');
  
  // Drop pending transactions table
  await knex.schema.dropTableIfExists('pending_transactions');
  console.log('Dropped: pending_transactions');
  
  console.log('Cleanup completed! Reduced from 45 to 30 tables.');
}

export async function down(_knex: Knex): Promise<void> {
  // Note: This migration is not reversible as it removes legacy tables
  // The original table structures would need to be recreated from their
  // respective migration files if needed
  console.log('Warning: This cleanup migration cannot be reversed.');
  console.log('Legacy tables would need to be recreated from original migrations.');
}