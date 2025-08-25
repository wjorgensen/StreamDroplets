import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add new timeline-based tables for USD-denominated per-second calculations
  
  // Price snapshots table - stores USD prices at change points
  await knex.schema.createTable('price_snapshots', (table) => {
    table.increments('id').primary();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.decimal('price_usd', 78, 0).notNullable(); // 8 decimals like Chainlink
    table.integer('oracle_scale').defaultTo(8);
    table.string('oracle_source', 50).notNullable(); // 'chainlink', 'fallback'
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['asset', 'block_number', 'chain_id']);
    table.index(['asset', 'timestamp']);
    table.index(['timestamp']);
  });
  
  // Timeline intervals table - tracks constant periods between events
  await knex.schema.createTable('timeline_intervals', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.timestamp('start_time').notNullable();
    table.timestamp('end_time').nullable();
    table.decimal('shares', 78, 0).notNullable();
    table.decimal('pps', 78, 0).notNullable();
    table.integer('pps_scale').notNullable();
    table.decimal('price_usd', 78, 0).notNullable();
    table.integer('price_scale').defaultTo(8);
    table.decimal('usd_exposure', 78, 0).nullable(); // Pre-calculated for optimization
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['address', 'asset']);
    table.index(['start_time', 'end_time']);
    table.index(['asset', 'start_time']);
  });
  
  // Droplets integration table - stores calculated droplets per interval
  await knex.schema.createTable('droplets_integration', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('interval_id').notNullable();
    table.timestamp('start_time').notNullable();
    table.timestamp('end_time').notNullable();
    table.decimal('droplets_earned', 78, 0).notNullable();
    table.decimal('rate_used', 78, 0).notNullable(); // droplets_per_usd_second
    table.timestamp('calculated_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset', 'interval_id']);
    table.index(['address', 'asset', 'start_time']);
    table.index(['calculated_at']);
  });
  
  // Enhanced oracle prices with historical data
  await knex.schema.createTable('oracle_prices_timeline', (table) => {
    table.increments('id').primary();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.decimal('price_usd', 78, 0).notNullable();
    table.string('chainlink_round_id', 50).nullable();
    table.bigInteger('updated_at_block').nullable();
    table.timestamp('oracle_updated_at').nullable();
    table.string('source', 50).defaultTo('chainlink'); // 'chainlink', 'fallback', 'historical'
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['asset', 'chain_id', 'block_number']);
    table.index(['asset', 'timestamp']);
    table.index(['timestamp']);
  });
  
  // Rate configuration table for time-varying rates
  await knex.schema.createTable('rate_configuration', (table) => {
    table.increments('id').primary();
    table.timestamp('effective_from').notNullable();
    table.timestamp('effective_to').nullable();
    table.decimal('rate_per_usd_second', 78, 0).notNullable();
    table.string('description', 255).nullable();
    table.boolean('is_active').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.index(['effective_from', 'effective_to']);
  });
  
  // Insert default rate
  await knex('rate_configuration').insert({
    effective_from: new Date('2024-01-01T00:00:00Z'),
    rate_per_usd_second: '1000000000000000000', // 1e18
    description: 'Default rate: 1 droplet per USD per second',
    is_active: true,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rate_configuration');
  await knex.schema.dropTableIfExists('oracle_prices_timeline');
  await knex.schema.dropTableIfExists('droplets_integration');
  await knex.schema.dropTableIfExists('timeline_intervals');
  await knex.schema.dropTableIfExists('price_snapshots');
}
