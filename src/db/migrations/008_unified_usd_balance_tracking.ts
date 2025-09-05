import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Create table for tracking shares by chain (intermediate data)
  await knex.schema.createTable('chain_share_balances', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable(); // xETH, xBTC, xUSD, xEUR
    table.integer('chain_id').notNullable();
    table.decimal('shares', 78, 0).notNullable();
    table.bigInteger('last_block').notNullable();
    table.timestamp('last_updated').notNullable();
    
    table.unique(['address', 'asset', 'chain_id']);
    table.index(['address']);
    table.index(['last_updated']);
  });

  // Create the main USD balance table - ONE entry per user per round
  await knex.schema.createTable('user_usd_snapshots', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.integer('round_id').notNullable();
    
    // Total USD value across ALL assets and ALL chains
    table.decimal('total_usd_value', 78, 0).notNullable();
    
    // Breakdown by asset (for transparency/debugging)
    table.decimal('xeth_shares_total', 78, 0).defaultTo(0);
    table.decimal('xeth_usd_value', 78, 0).defaultTo(0);
    table.decimal('xbtc_shares_total', 78, 0).defaultTo(0);
    table.decimal('xbtc_usd_value', 78, 0).defaultTo(0);
    table.decimal('xusd_shares_total', 78, 0).defaultTo(0);
    table.decimal('xusd_usd_value', 78, 0).defaultTo(0);
    table.decimal('xeur_shares_total', 78, 0).defaultTo(0);
    table.decimal('xeur_usd_value', 78, 0).defaultTo(0);
    
    // Disqualification flags
    table.boolean('had_unstake').defaultTo(false); // Unstaked on Ethereum
    table.boolean('is_excluded').defaultTo(false); // Address is in exclusion list
    
    // Droplets for this round
    table.decimal('droplets_earned', 78, 0).defaultTo(0);
    
    table.timestamp('snapshot_time').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'round_id']);
    table.index(['round_id']);
    table.index(['address']);
    table.index(['snapshot_time']);
  });

  // Create table for tracking round snapshots (when to calculate)
  await knex.schema.createTable('round_snapshot_jobs', (table) => {
    table.increments('id').primary();
    table.integer('round_id').notNullable();
    table.string('status', 20).notNullable(); // 'pending', 'processing', 'completed', 'failed'
    table.timestamp('round_start').notNullable();
    table.timestamp('round_end').nullable();
    
    // Price per share from Ethereum for each asset
    table.decimal('xeth_pps', 78, 0).nullable();
    table.decimal('xbtc_pps', 78, 0).nullable();
    table.decimal('xusd_pps', 78, 0).nullable();
    table.decimal('xeur_pps', 78, 0).nullable();
    
    // Oracle prices at round start
    table.decimal('eth_usd_price', 78, 0).nullable();
    table.decimal('btc_usd_price', 78, 0).nullable();
    table.decimal('usd_usd_price', 78, 0).defaultTo('1000000000000000000'); // Always 1.0
    table.decimal('eur_usd_price', 78, 0).nullable();
    
    table.integer('users_processed').defaultTo(0);
    table.decimal('total_droplets_awarded', 78, 0).defaultTo(0);
    
    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    table.text('error_message').nullable();
    
    table.unique(['round_id']);
    table.index(['status']);
    table.index(['round_start']);
  });

  // Create a simplified leaderboard table
  await knex.schema.createTable('droplets_leaderboard', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.decimal('total_droplets', 78, 0).notNullable();
    table.integer('last_round_calculated').notNullable();
    table.integer('rounds_participated').defaultTo(0);
    table.decimal('average_usd_per_round', 78, 0).defaultTo(0);
    table.timestamp('first_seen').notNullable();
    table.timestamp('last_updated').notNullable();
    
    table.unique(['address']);
    table.index(['total_droplets']);
    table.index(['last_updated']);
  });

  // Create events table for tracking all chain events in one place
  await knex.schema.createTable('unified_share_events', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.string('event_type', 30).notNullable(); // 'transfer', 'stake', 'unstake', 'bridge_out', 'bridge_in'
    table.decimal('shares_delta', 78, 0).notNullable(); // Can be negative
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.integer('log_index').notNullable();
    
    // For tracking which round this belongs to
    table.integer('round_id').nullable();
    
    table.unique(['chain_id', 'tx_hash', 'log_index']);
    table.index(['address', 'timestamp']);
    table.index(['chain_id', 'block_number']);
    table.index(['round_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('unified_share_events');
  await knex.schema.dropTableIfExists('droplets_leaderboard');
  await knex.schema.dropTableIfExists('round_snapshot_jobs');
  await knex.schema.dropTableIfExists('user_usd_snapshots');
  await knex.schema.dropTableIfExists('chain_share_balances');
}