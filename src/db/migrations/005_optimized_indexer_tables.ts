import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Create transfers table for Alchemy getAssetTransfers data
  await knex.schema.createTable('transfers', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('transaction_hash').notNullable();
    table.integer('block_number').notNullable();
    table.string('from_address');
    table.string('to_address');
    table.string('value');
    table.string('asset');
    table.string('category');
    table.jsonb('raw_contract');
    table.jsonb('metadata');
    table.string('status');
    table.string('gas_used');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['chain_id', 'contract_address']);
    table.index(['chain_id', 'block_number']);
    table.index(['from_address']);
    table.index(['to_address']);
    table.unique(['chain_id', 'transaction_hash', 'contract_address']);
  });

  // Create events table for decoded event logs
  await knex.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('transaction_hash').notNullable();
    table.integer('block_number').notNullable();
    table.integer('log_index').notNullable();
    table.string('event_name');
    table.jsonb('topics');
    table.text('data');
    table.jsonb('decoded_data');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['chain_id', 'contract_address']);
    table.index(['chain_id', 'block_number']);
    table.index(['event_name']);
    table.unique(['chain_id', 'transaction_hash', 'log_index']);
  });

  // Create stakes table for Stake events
  await knex.schema.createTable('stakes', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('account').notNullable();
    table.string('amount').notNullable();
    table.integer('round').notNullable();
    table.integer('block_number').notNullable();
    table.string('transaction_hash').notNullable();
    table.timestamp('timestamp').notNullable();
    
    // Indexes
    table.index(['chain_id', 'contract_address', 'account']);
    table.index(['chain_id', 'contract_address', 'round']);
    table.unique(['chain_id', 'transaction_hash', 'account']);
  });

  // Create unstakes table for Unstake events
  await knex.schema.createTable('unstakes', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('account').notNullable();
    table.string('amount').notNullable();
    table.integer('round').notNullable();
    table.integer('block_number').notNullable();
    table.string('transaction_hash').notNullable();
    table.timestamp('timestamp').notNullable();
    
    // Indexes
    table.index(['chain_id', 'contract_address', 'account']);
    table.index(['chain_id', 'contract_address', 'round']);
    table.unique(['chain_id', 'transaction_hash', 'account']);
  });

  // Create rounds table for RoundRolled events (skip if exists)
  const roundsExists = await knex.schema.hasTable('rounds');
  if (!roundsExists) {
    await knex.schema.createTable('rounds', (table) => {
      table.increments('id').primary();
      table.integer('chain_id').notNullable();
      table.string('contract_address').notNullable();
      table.integer('round').notNullable();
      table.string('price_per_share').notNullable();
      table.string('shares_minted');
      table.string('wrapped_tokens_minted');
      table.string('wrapped_tokens_burned');
      table.string('yield_amount');
      table.boolean('is_yield_positive');
      table.integer('block_number').notNullable();
      table.string('transaction_hash').notNullable();
      table.timestamp('timestamp').notNullable();
      
      // Indexes
      table.unique(['chain_id', 'contract_address', 'round']);
      table.index(['chain_id', 'contract_address']);
    });
  }

  // Create share_transfers table for Transfer events
  await knex.schema.createTable('share_transfers', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('from_address').notNullable();
    table.string('to_address').notNullable();
    table.string('value').notNullable();
    table.integer('block_number').notNullable();
    table.string('transaction_hash').notNullable();
    table.integer('log_index');
    table.timestamp('timestamp').notNullable();
    
    // Indexes
    table.index(['chain_id', 'contract_address']);
    table.index(['from_address']);
    table.index(['to_address']);
    table.unique(['chain_id', 'transaction_hash', 'log_index']);
  });

  // Create cross_chain_transfers table for OFT events
  await knex.schema.createTable('cross_chain_transfers', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('event_type').notNullable(); // OFTSent or OFTReceived
    table.string('guid');
    table.integer('endpoint_id');
    table.string('account').notNullable();
    table.string('amount').notNullable();
    table.integer('block_number').notNullable();
    table.string('transaction_hash').notNullable();
    table.integer('log_index');
    table.timestamp('timestamp').notNullable();
    
    // Indexes
    table.index(['chain_id', 'contract_address']);
    table.index(['account']);
    table.index(['guid']);
    table.unique(['chain_id', 'transaction_hash', 'log_index']);
  });

  // Create pending_transactions table for real-time monitoring
  await knex.schema.createTable('pending_transactions', (table) => {
    table.increments('id').primary();
    table.integer('chain_id').notNullable();
    table.string('contract_address').notNullable();
    table.string('transaction_hash').notNullable();
    table.string('from_address');
    table.string('to_address');
    table.string('value');
    table.string('gas_price');
    table.integer('nonce');
    table.text('input_data');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['chain_id', 'contract_address']);
    table.unique(['chain_id', 'transaction_hash']);
  });

  // Update cursors table to support per-contract tracking
  const hasContractColumn = await knex.schema.hasColumn('cursors', 'contract');
  if (!hasContractColumn) {
    await knex.schema.alterTable('cursors', (table) => {
      table.string('contract').defaultTo('stream_vault');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Drop all new tables
  await knex.schema.dropTableIfExists('pending_transactions');
  await knex.schema.dropTableIfExists('cross_chain_transfers');
  await knex.schema.dropTableIfExists('share_transfers');
  await knex.schema.dropTableIfExists('rounds');
  await knex.schema.dropTableIfExists('unstakes');
  await knex.schema.dropTableIfExists('stakes');
  await knex.schema.dropTableIfExists('events');
  await knex.schema.dropTableIfExists('transfers');
  
  // Revert cursors table changes
  const hasContractColumn = await knex.schema.hasColumn('cursors', 'contract');
  if (hasContractColumn) {
    await knex.schema.alterTable('cursors', (table) => {
      table.dropColumn('contract');
    });
  }
}