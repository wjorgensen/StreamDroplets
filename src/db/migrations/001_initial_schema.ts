import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Rounds table - canonical from Ethereum
  await knex.schema.createTable('rounds', (table) => {
    table.increments('id').primary();
    table.integer('round_id').notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.bigInteger('start_block').notNullable();
    table.timestamp('start_ts').notNullable();
    table.timestamp('end_ts').nullable();
    table.decimal('pps', 78, 0).notNullable(); // Store as string for precision
    table.integer('pps_scale').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['round_id', 'asset', 'chain_id']);
    table.index(['asset', 'round_id']);
    table.index(['start_ts']);
  });
  
  // Share events table
  await knex.schema.createTable('share_events', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('address', 42).notNullable();
    table.string('event_type', 20).notNullable();
    table.decimal('shares_delta', 78, 0).notNullable();
    table.bigInteger('block').notNullable();
    table.timestamp('timestamp').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.integer('log_index').notNullable();
    table.integer('round_id').nullable();
    table.string('event_classification', 20).notNullable();
    table.string('asset', 10).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['tx_hash', 'log_index']);
    table.index(['address', 'asset']);
    table.index(['block']);
    table.index(['timestamp']);
    table.index(['event_classification']);
  });
  
  // Balance snapshots table
  await knex.schema.createTable('balance_snapshots', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('round_id').notNullable();
    table.decimal('shares_at_start', 78, 0).notNullable();
    table.boolean('had_unstake_in_round').defaultTo(false);
    table.boolean('had_transfer_in_round').defaultTo(false);
    table.boolean('had_bridge_in_round').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset', 'round_id']);
    table.index(['address', 'asset']);
    table.index(['round_id']);
  });
  
  // Oracle prices table
  await knex.schema.createTable('oracle_prices', (table) => {
    table.increments('id').primary();
    table.string('asset', 10).notNullable();
    table.integer('round_id').notNullable();
    table.decimal('price_usd', 78, 0).notNullable();
    table.bigInteger('oracle_block').notNullable();
    table.timestamp('oracle_timestamp').notNullable();
    table.string('chainlink_round_id', 50).nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['asset', 'round_id']);
    table.index(['asset']);
    table.index(['round_id']);
  });
  
  // Droplets cache table
  await knex.schema.createTable('droplets_cache', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('last_round_calculated').notNullable();
    table.decimal('droplets_total', 78, 0).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset']);
    table.index(['address']);
    table.index(['updated_at']);
  });
  
  // Bridge events table
  await knex.schema.createTable('bridge_events', (table) => {
    table.increments('id').primary();
    table.integer('src_chain').notNullable();
    table.integer('dst_chain').notNullable();
    table.string('burn_tx', 66).notNullable();
    table.string('mint_tx', 66).nullable();
    table.string('address', 42).notNullable();
    table.decimal('shares', 78, 0).notNullable();
    table.timestamp('burn_timestamp').notNullable();
    table.timestamp('mint_timestamp').nullable();
    table.string('status', 20).notNullable(); // 'pending', 'completed', 'failed'
    table.string('asset', 10).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['burn_tx']);
    table.index(['address', 'asset']);
    table.index(['status']);
    table.index(['burn_timestamp']);
  });
  
  // Cursors table for tracking indexer progress
  await knex.schema.createTable('cursors', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address', 42).notNullable();
    table.bigInteger('last_safe_block').notNullable();
    table.string('last_tx_hash', 66).nullable();
    table.integer('last_log_index').nullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['chain_id', 'contract_address']);
  });
  
  // Config table
  await knex.schema.createTable('config', (table) => {
    table.increments('id').primary();
    table.string('key', 100).notNullable().unique();
    table.text('value').notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
  
  // Current balances view (helper table)
  await knex.schema.createTable('current_balances', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.decimal('shares', 78, 0).notNullable();
    table.bigInteger('last_update_block').notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset', 'chain_id']);
    table.index(['address', 'asset']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('current_balances');
  await knex.schema.dropTableIfExists('config');
  await knex.schema.dropTableIfExists('cursors');
  await knex.schema.dropTableIfExists('bridge_events');
  await knex.schema.dropTableIfExists('droplets_cache');
  await knex.schema.dropTableIfExists('oracle_prices');
  await knex.schema.dropTableIfExists('balance_snapshots');
  await knex.schema.dropTableIfExists('share_events');
  await knex.schema.dropTableIfExists('rounds');
}