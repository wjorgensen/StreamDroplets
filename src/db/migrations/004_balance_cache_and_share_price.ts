import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add share_price columns to timeline_intervals (usd_exposure already exists from migration 002)
  await knex.schema.alterTable('timeline_intervals', (table) => {
    table.string('share_price', 78).nullable();
    table.integer('share_price_scale').defaultTo(18);
  });
  
  // Create balance_cache table for historical balance queries
  await knex.schema.createTable('balance_cache', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.string('block_number', 78).notNullable();
    table.string('balance', 78).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Composite unique index for preventing duplicates
    table.unique(['address', 'asset', 'chain_id', 'block_number']);
    
    // Index for efficient queries
    table.index(['address', 'asset', 'chain_id']);
    table.index('block_number');
  });
  
  // Create vault_states table for PPS caching
  await knex.schema.createTable('vault_states', (table) => {
    table.increments('id').primary();
    table.string('asset', 10).notNullable();
    table.string('block_number', 78).notNullable();
    table.string('pps', 78).nullable();
    table.integer('round').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Unique constraint
    table.unique(['asset', 'block_number']);
    
    // Index for efficient queries
    table.index(['asset', 'block_number']);
  });
  
  // Note: chain_configurations table doesn't exist yet in this migration
}

export async function down(knex: Knex): Promise<void> {
  // Drop the new tables
  await knex.schema.dropTableIfExists('vault_states');
  await knex.schema.dropTableIfExists('balance_cache');
  
  // Remove the new columns from timeline_intervals
  await knex.schema.alterTable('timeline_intervals', (table) => {
    table.dropColumn('share_price');
    table.dropColumn('share_price_scale');
    // usd_exposure is managed by migration 002
  });
}