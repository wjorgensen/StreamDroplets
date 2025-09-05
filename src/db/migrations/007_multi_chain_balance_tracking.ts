import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add chain_id to share_events if not already there
  const shareEventsColumns = await knex.raw(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'share_events' 
    AND column_name = 'chain_id'
  `);
  
  if (shareEventsColumns.rows.length === 0) {
    await knex.schema.alterTable('share_events', (table) => {
      // Chain ID already exists in the table
      // Just ensure index is present
      table.index(['chain_id', 'address', 'asset']);
    });
  }

  // Create a new table for multi-chain balance aggregation
  await knex.schema.createTable('multi_chain_balances', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.integer('round_id').notNullable();
    table.decimal('shares', 78, 0).notNullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset', 'chain_id', 'round_id']);
    table.index(['address', 'asset', 'round_id']);
    table.index(['chain_id']);
  });

  // Create aggregated balance view for easier querying
  await knex.raw(`
    CREATE OR REPLACE VIEW aggregated_round_balances AS
    SELECT 
      address,
      asset,
      round_id,
      SUM(shares) as total_shares,
      MAX(timestamp) as last_updated
    FROM multi_chain_balances
    GROUP BY address, asset, round_id
  `);

  // Add helper table to track which chains have which assets
  await knex.schema.createTable('chain_asset_mapping', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('asset', 10).notNullable();
    table.string('contract_type', 20).notNullable(); // 'vault' or 'oft'
    table.string('contract_address', 42).notNullable();
    table.boolean('is_active').defaultTo(true);
    
    table.unique(['chain_id', 'asset']);
    table.index(['asset']);
  });

  // Note: Chain asset mappings would be populated from environment variables
  // This is handled by the application at runtime
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP VIEW IF EXISTS aggregated_round_balances');
  await knex.schema.dropTableIfExists('chain_asset_mapping');
  await knex.schema.dropTableIfExists('multi_chain_balances');
}