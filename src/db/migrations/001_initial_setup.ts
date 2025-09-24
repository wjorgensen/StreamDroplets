import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Share balances - for calculations and reconstruction (consolidated across all chains)
  await knex.schema.createTableIfNotExists('share_balances', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.decimal('shares', 78, 0).notNullable();
    table.decimal('underlying_assets', 78, 0).nullable();
    table.bigInteger('last_update_block').notNullable();
    table.timestamp('last_updated').notNullable();
    table.date('last_updated_date').notNullable(); // Track which date's events last updated this balance
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'asset']);
    table.index(['address']);
    table.index(['asset']);
    table.index(['last_updated_date']);
  });

  // Daily events - blockchain-style audit trail of balance changes
  await knex.schema.createTableIfNotExists('daily_events', (table) => {
    table.bigIncrements('id').primary();
    table.string('from_address', 42).nullable();
    table.string('to_address', 42).nullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.date('event_date').notNullable();
    table.string('event_type', 30).notNullable();
    table.decimal('amount_delta', 78, 0).notNullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.integer('log_index').notNullable();
    table.bigInteger('round').nullable(); // Round number for unstake events (null for other events)
    table.string('isIntegrationAddress', 10).nullable();
    table.string('oft_guid', 66).nullable(); // For tracking OFT cross-chain transfers
    table.integer('dest_chain_id').nullable(); // Destination chain for OFT transfers
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['chain_id', 'tx_hash', 'log_index']);
    table.index(['from_address', 'event_date']);
    table.index(['to_address', 'event_date']);
    table.index(['event_date', 'event_type']);
    table.index(['chain_id', 'block_number']);
    table.index(['round']); // For efficient querying by round
    table.index(['oft_guid']); // For linking OFT sent/received events
  });

  // User daily snapshots - individual user snapshots
  await knex.schema.createTableIfNotExists('user_daily_snapshots', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.date('snapshot_date').notNullable();
    
    table.decimal('total_usd_value', 78, 0).notNullable();
    table.decimal('xeth_shares_total', 78, 0).defaultTo(0);
    table.decimal('xeth_usd_value', 78, 0).defaultTo(0);
    table.decimal('xbtc_shares_total', 78, 0).defaultTo(0);
    table.decimal('xbtc_usd_value', 78, 0).defaultTo(0);
    table.decimal('xusd_shares_total', 78, 0).defaultTo(0);
    table.decimal('xusd_usd_value', 78, 0).defaultTo(0);
    table.decimal('xeur_shares_total', 78, 0).defaultTo(0);
    table.decimal('xeur_usd_value', 78, 0).defaultTo(0);
    
    table.text('integration_breakdown').defaultTo('{}');
    
    table.decimal('daily_droplets_earned', 78, 0).defaultTo(0);
    table.decimal('total_droplets', 78, 0).defaultTo(0);
    
    table.timestamp('snapshot_timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'snapshot_date']);
    table.index(['snapshot_date']);
    table.index(['address']);
    table.index(['total_usd_value']);
  });

  // Daily snapshots - protocol-wide daily snapshots
  await knex.schema.createTableIfNotExists('daily_snapshots', (table) => {
    table.increments('id').primary();
    table.date('snapshot_date').notNullable().unique();
    
    table.decimal('total_protocol_usd', 78, 0).notNullable();
    table.decimal('total_xeth_shares', 78, 0).defaultTo(0);
    table.decimal('total_xeth_usd', 78, 0).defaultTo(0);
    table.decimal('total_xbtc_shares', 78, 0).defaultTo(0);
    table.decimal('total_xbtc_usd', 78, 0).defaultTo(0);
    table.decimal('total_xusd_shares', 78, 0).defaultTo(0);
    table.decimal('total_xusd_usd', 78, 0).defaultTo(0);
    table.decimal('total_xeur_shares', 78, 0).defaultTo(0);
    table.decimal('total_xeur_usd', 78, 0).defaultTo(0);
    
    table.text('total_integration_breakdown').defaultTo('{}');
    table.integer('total_users').notNullable();
    
    table.decimal('daily_protocol_droplets', 78, 0).defaultTo(0);
    table.decimal('total_protocol_droplets', 78, 0).defaultTo(0);
    
    table.decimal('eth_usd_price', 78, 0).nullable();
    table.decimal('btc_usd_price', 78, 0).nullable();
    table.decimal('eur_usd_price', 78, 0).nullable();
    
    table.timestamp('snapshot_timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['snapshot_date']);
  });



  // Block timestamps - for date to block conversion
  await knex.schema.createTableIfNotExists('block_timestamps', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.date('date').notNullable();
    
    table.unique(['chain_id', 'block_number']);
    table.index(['chain_id', 'date']);
    table.index(['chain_id', 'timestamp']);
  });

  
  // Daily integration events - daily events from all integration protocols
  await knex.schema.createTableIfNotExists('daily_integration_events', (table) => {
    table.bigIncrements('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.string('protocol_name', 50).notNullable();
    table.string('protocol_type', 20).notNullable();
    table.string('contract_address', 42).notNullable();
    table.date('event_date').notNullable();
    table.string('event_type', 30).notNullable();
    table.decimal('amount_delta', 78, 0).notNullable();
    table.decimal('shares_delta', 78, 0).nullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.integer('log_index').notNullable();
    table.string('counterparty_address', 42).nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['chain_id', 'tx_hash', 'log_index']);
    table.index(['address', 'event_date']);
    table.index(['event_date', 'protocol_name']);
    table.index(['chain_id', 'block_number']);
    table.index(['contract_address']);
  });

  // Integration balances - current user balances in integrations
  await knex.schema.createTableIfNotExists('integration_balances', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.string('asset', 10).notNullable();
    table.integer('chain_id').notNullable();
    table.string('protocol_name', 50).notNullable();
    table.string('contract_address', 42).notNullable();
    table.decimal('position_shares', 78, 0).notNullable();
    table.decimal('underlying_assets', 78, 0).notNullable();
    table.bigInteger('last_update_block').notNullable();
    table.timestamp('last_updated').notNullable();
    table.date('last_updated_date').notNullable(); // Track which date's events last updated this balance
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'chain_id', 'contract_address']);
    table.index(['address']);
    table.index(['protocol_name']);
    table.index(['chain_id', 'contract_address']);
    table.index(['last_updated_date']);
  });

  // Royco deposits - deposits from Royco API for weiroll wallets
  await knex.schema.createTableIfNotExists('royco_deposits', (table) => {
    table.increments('id').primary();
    table.string('royco_id', 100).notNullable().unique();
    table.string('weiroll_wallet', 42).notNullable();
    table.string('account_address', 42).notNullable();
    table.bigInteger('block_number').notNullable();
    table.decimal('token_amount', 78, 0).notNullable();
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('deposit_timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.index(['account_address']);
    table.index(['weiroll_wallet']);
    table.index(['active']);
    table.index(['block_number']);
  });

  // Price per share cache - stores current PPS for each asset
  await knex.schema.createTableIfNotExists('price_per_share_cache', (table) => {
    table.string('asset', 10).primary();
    table.decimal('current_price_per_share', 78, 0).notNullable();
    table.bigInteger('current_round').notNullable();
    table.bigInteger('last_update_block').notNullable();
    table.timestamp('last_updated').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['asset']);
    table.index(['last_update_block']);
  });

  // Progress cursors - track last processed block and date for each chain
  await knex.schema.createTableIfNotExists('progress_cursors', (table) => {
    table.integer('chain_id').primary();
    table.string('chain_name', 20).notNullable();
    table.bigInteger('last_processed_block').notNullable().defaultTo(0);
    table.date('last_processed_date').nullable();
    table.timestamp('last_updated').defaultTo(knex.fn.now());
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['chain_id']);
    table.index(['last_processed_block']);
    table.index(['last_processed_date']);
  });

  // Insert initial progress cursors for all supported chains
  // Use earliestBlock - 1 as the starting point for each chain
  // Set initial last_processed_date to start the backfill from next day (2025-02-18)
  await knex('progress_cursors')
    .insert([
      { chain_id: 1, chain_name: 'ethereum', last_processed_block: 21870475, last_processed_date: '2025-02-17' }, // ETH earliestBlock - 1
      { chain_id: 146, chain_name: 'sonic', last_processed_block: 8757378, last_processed_date: '2025-02-17' }, // SONIC earliestBlock - 1
      { chain_id: 8453, chain_name: 'base', last_processed_block: 26529546, last_processed_date: '2025-02-17' }, // BASE earliestBlock - 1
      { chain_id: 42161, chain_name: 'arbitrum', last_processed_block: 307879462, last_processed_date: '2025-02-17' }, // ARB earliestBlock - 1
      { chain_id: 43114, chain_name: 'avalanche', last_processed_block: 57581228, last_processed_date: '2025-02-17' }, // AVAX earliestBlock - 1
      { chain_id: 80094, chain_name: 'berachain', last_processed_block: 1362867, last_processed_date: '2025-02-17' }, // BERA earliestBlock - 1
    ])
    .onConflict('chain_id')
    .ignore();

  console.log('StreamDroplets initial setup completed');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('progress_cursors');
  await knex.schema.dropTableIfExists('price_per_share_cache');
  await knex.schema.dropTableIfExists('royco_deposits');
  await knex.schema.dropTableIfExists('integration_balances');
  await knex.schema.dropTableIfExists('daily_integration_events');
  await knex.schema.dropTableIfExists('block_timestamps');
  await knex.schema.dropTableIfExists('daily_snapshots');
  await knex.schema.dropTableIfExists('user_daily_snapshots');
  await knex.schema.dropTableIfExists('daily_events');
  await knex.schema.dropTableIfExists('share_balances');
  
  console.log('StreamDroplets tables dropped');
}
