import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add unstake_events table to track unstakes per round
  await knex.schema.createTable('unstake_events', (table) => {
    table.string('address').notNullable();
    table.string('asset').notNullable();
    table.integer('round').notNullable();
    table.string('amount').notNullable();
    table.integer('block').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.primary(['address', 'asset', 'round']);
    table.index(['round']);
    table.index(['asset']);
  });
  
  // Add pending_amount column to share_events if not exists
  await knex.schema.alterTable('share_events', (table) => {
    table.string('pending_amount').nullable();
    table.integer('round').nullable();
  });
  
  // Add round tracking columns to rounds table
  await knex.schema.alterTable('rounds', (table) => {
    table.string('shares_minted').nullable();
    table.string('yield').nullable();
    table.boolean('is_yield_positive').nullable();
  });
  
  // Add excluded_addresses table for managing excluded addresses
  await knex.schema.createTable('excluded_addresses', (table) => {
    table.string('address').primary();
    table.string('reason').notNullable();
    table.boolean('is_contract').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
  
  // Insert known excluded addresses
  const excludedAddresses = [
    { address: '0x0000000000000000000000000000000000000000', reason: 'Zero address', is_contract: false },
    { address: '0x000000000000000000000000000000000000dead', reason: 'Burn address', is_contract: false },
    // Vault contracts - Ethereum
    { address: '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153', reason: 'xETH Vault Ethereum', is_contract: true },
    { address: '0x12fd502e2052cafb41eccc5b596023d9978057d6', reason: 'xBTC Vault Ethereum', is_contract: true },
    { address: '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94', reason: 'xUSD Vault Ethereum', is_contract: true },
    { address: '0xc15697f61170fc3bb4e99eb7913b4c7893f64f13', reason: 'xEUR Vault Ethereum', is_contract: true },
    // Vault contracts - Sonic
    { address: '0x16af6b1315471dc306d47e9ccefed6e5996285b6', reason: 'xETH Vault Sonic', is_contract: true },
    { address: '0xb88ff15ae5f82c791e637b27337909bcf8065270', reason: 'xBTC Vault Sonic', is_contract: true },
    { address: '0x6202b9f02e30e5e1c62cc01e4305450e5d83b926', reason: 'xUSD Vault Sonic', is_contract: true },
    { address: '0x931383c1bca6a41e931f2519bae8d716857f156c', reason: 'xEUR Vault Sonic', is_contract: true },
  ];
  
  for (const addr of excludedAddresses) {
    await knex('excluded_addresses')
      .insert({
        address: addr.address.toLowerCase(),
        reason: addr.reason,
        is_contract: addr.is_contract,
      })
      .onConflict('address')
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('unstake_events');
  await knex.schema.dropTableIfExists('excluded_addresses');
  
  await knex.schema.alterTable('share_events', (table) => {
    table.dropColumn('pending_amount');
    table.dropColumn('round');
  });
  
  await knex.schema.alterTable('rounds', (table) => {
    table.dropColumn('shares_minted');
    table.dropColumn('yield');
    table.dropColumn('is_yield_positive');
  });
}