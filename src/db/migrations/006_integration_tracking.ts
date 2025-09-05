import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Integration protocols table - defines all integrated protocols
  await knex.schema.createTable('integration_protocols', (table) => {
    table.increments('id').primary();
    table.string('protocol_name', 100).notNullable();
    table.string('integration_type', 50).notNullable(); // 'lp', 'vault', 'lending'
    table.integer('chain_id').notNullable();
    table.string('contract_address', 42).notNullable();
    table.string('underlying_asset', 10).notNullable(); // 'xUSD', 'xETH', etc
    table.jsonb('metadata').nullable(); // Additional protocol-specific data
    table.boolean('is_active').defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['chain_id', 'contract_address']);
    table.index(['protocol_name']);
    table.index(['is_active']);
  });

  // Integration positions table - tracks user positions in integrated protocols
  await knex.schema.createTable('integration_positions', (table) => {
    table.increments('id').primary();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.string('user_address', 42).notNullable();
    table.decimal('position_shares', 78, 0).notNullable(); // LP tokens, vault shares, aTokens, etc
    table.decimal('underlying_amount', 78, 0).notNullable(); // Amount of underlying xUSD
    table.decimal('usd_value', 78, 0).notNullable(); // USD value for droplet calculation
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.timestamp('last_updated').defaultTo(knex.fn.now());
    
    table.index(['protocol_id', 'user_address']);
    table.index(['user_address']);
    table.index(['timestamp']);
  });

  // Integration events table - tracks all integration protocol events
  await knex.schema.createTable('integration_events', (table) => {
    table.increments('id').primary();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.string('event_type', 50).notNullable(); // 'deposit', 'withdraw', 'mint', 'burn', 'transfer'
    table.string('user_address', 42).notNullable();
    table.decimal('shares_delta', 78, 0).notNullable(); // Change in position shares
    table.decimal('underlying_delta', 78, 0).nullable(); // Change in underlying amount
    table.jsonb('event_data').nullable(); // Raw event data for debugging
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.string('tx_hash', 66).notNullable();
    table.integer('log_index').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['tx_hash', 'log_index']);
    table.index(['protocol_id']);
    table.index(['user_address']);
    table.index(['event_type']);
    table.index(['timestamp']);
  });

  // LP pool reserves table - tracks AMM pool reserves for LP calculations
  await knex.schema.createTable('lp_pool_reserves', (table) => {
    table.increments('id').primary();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.decimal('reserve0', 78, 0).notNullable();
    table.decimal('reserve1', 78, 0).notNullable();
    table.decimal('total_supply', 78, 0).notNullable(); // Total LP tokens
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['protocol_id']);
    table.index(['timestamp']);
  });

  // Vault exchange rates table - tracks vault share to asset conversion rates
  await knex.schema.createTable('vault_exchange_rates', (table) => {
    table.increments('id').primary();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.decimal('exchange_rate', 78, 0).notNullable(); // Share to asset rate
    table.integer('rate_scale').notNullable(); // Decimals for the rate
    table.decimal('total_assets', 78, 0).nullable();
    table.decimal('total_supply', 78, 0).nullable();
    table.bigInteger('block_number').notNullable();
    table.timestamp('timestamp').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index(['protocol_id']);
    table.index(['timestamp']);
  });

  // Integration droplets cache - caches droplet calculations for integration positions
  await knex.schema.createTable('integration_droplets_cache', (table) => {
    table.increments('id').primary();
    table.string('user_address', 42).notNullable();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.integer('last_round_calculated').notNullable();
    table.decimal('droplets_total', 78, 0).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['user_address', 'protocol_id']);
    table.index(['user_address']);
    table.index(['updated_at']);
  });

  // Add integration tracking cursors
  await knex.schema.createTable('integration_cursors', (table) => {
    table.increments('id').primary();
    table.integer('protocol_id').notNullable().references('id').inTable('integration_protocols');
    table.bigInteger('last_block').notNullable();
    table.string('last_tx_hash', 66).nullable();
    table.integer('last_log_index').nullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['protocol_id']);
  });

  // Insert initial integration protocols (excluding Royco as requested)
  await knex('integration_protocols').insert([
    // Shadow Exchange - Pool A (xUSD/HLP0)
    {
      protocol_name: 'Shadow Exchange Pool A',
      integration_type: 'lp',
      chain_id: 146, // Sonic
      contract_address: '0xdEE813F080f9128e52E38E9Ffef8B997F9544332'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        pair: 'xUSD/HLP0',
        token0: 'xUSD',
        token1: 'HLP0'
      }),
      is_active: true
    },
    // Shadow Exchange - Pool B (xUSD/aSonUSDC)
    {
      protocol_name: 'Shadow Exchange Pool B',
      integration_type: 'lp',
      chain_id: 146, // Sonic
      contract_address: '0xFEAd02Fb16eC3B2F6318dCa230198dB73E99428C'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        pair: 'xUSD/aSonUSDC',
        token0: 'xUSD',
        token1: 'aSonUSDC'
      }),
      is_active: true
    },
    // Euler Vault
    {
      protocol_name: 'Euler xUSD Vault',
      integration_type: 'vault',
      chain_id: 146, // Sonic
      contract_address: '0xdEBdAB749330bb976fD10dc52f9A452aaF029028'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        vaultType: 'ERC4626',
        shareToken: 'Euler xUSD Shares'
      }),
      is_active: true
    },
    // Silo Finance - Sonic Market 118
    {
      protocol_name: 'Silo V2 Sonic Market 118',
      integration_type: 'vault',
      chain_id: 146, // Sonic
      contract_address: '0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        vaultType: 'ERC4626',
        marketId: 118,
        pair: 'xUSD-scUSD'
      }),
      is_active: true
    },
    // Silo Finance - Sonic Market 112
    {
      protocol_name: 'Silo V2 Sonic Market 112',
      integration_type: 'vault',
      chain_id: 146, // Sonic
      contract_address: '0x172a687c397E315DBE56ED78aB347D7743D0D4fa'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        vaultType: 'ERC4626',
        marketId: 112,
        pair: 'xUSD-USDC'
      }),
      is_active: true
    },
    // Silo Finance - Avalanche Market 129
    {
      protocol_name: 'Silo V2 Avalanche Market 129',
      integration_type: 'vault',
      chain_id: 43114, // Avalanche
      contract_address: '0xc380E5250d9718f8d9116Bc9d787A0229044e2EB'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        vaultType: 'ERC4626',
        marketId: 129,
        pair: 'xUSD-USDC'
      }),
      is_active: true
    },
    // Enclabs Core Pool
    {
      protocol_name: 'Enclabs Core Pool',
      integration_type: 'lending',
      chain_id: 146, // Sonic
      contract_address: '0x13d79435F306D155CA2b9Af77234c84f80506045'.toLowerCase(),
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        marketType: 'cToken',
        symbol: 'vxUSD_Core',
        underlyingAddress: '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926'
      }),
      is_active: true
    },
    // Stability.market
    // Note: Disabled for now as it shares the same contract address as Shadow LP
    {
      protocol_name: 'Stability Stream Market',
      integration_type: 'lending', 
      chain_id: 146, // Sonic
      contract_address: '0x0000000000000000000000000000000000000002'.toLowerCase(), // Placeholder until we get unique address
      underlying_asset: 'xUSD',
      metadata: JSON.stringify({
        marketType: 'aave',
        poolAddress: '0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8',
        aTokenAddress: '0x13d79435F306D155CA2b9Af77234c84f80506045',
        note: 'Disabled - shares same address as Shadow LP, need unique identifier'
      }),
      is_active: false
    }
  ]);

  // Add all integration contract addresses to excluded_addresses table
  const integrationAddresses = await knex('integration_protocols').select('contract_address');
  const excludedEntries = integrationAddresses.map(row => ({
    address: row.contract_address.toLowerCase(),
    reason: 'Integration Protocol Contract',
    is_contract: true,
    created_at: knex.fn.now()
  }));
  
  if (excludedEntries.length > 0) {
    await knex('excluded_addresses').insert(excludedEntries).onConflict('address').ignore();
  }

  // Also add LP pair addresses and pool addresses to exclusion list
  const additionalExclusions = [
    { address: '0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8'.toLowerCase(), reason: 'Stability Pool Contract' },
    // Add more protocol-specific addresses that shouldn't earn droplets
  ];
  
  await knex('excluded_addresses').insert(additionalExclusions).onConflict('address').ignore();
}

export async function down(knex: Knex): Promise<void> {
  // Remove excluded addresses that were added for integrations
  await knex('excluded_addresses')
    .where('reason', 'LIKE', '%Integration%')
    .orWhere('reason', 'LIKE', '%Pool Contract%')
    .delete();

  // Drop tables in reverse order of dependencies
  await knex.schema.dropTableIfExists('integration_cursors');
  await knex.schema.dropTableIfExists('integration_droplets_cache');
  await knex.schema.dropTableIfExists('vault_exchange_rates');
  await knex.schema.dropTableIfExists('lp_pool_reserves');
  await knex.schema.dropTableIfExists('integration_events');
  await knex.schema.dropTableIfExists('integration_positions');
  await knex.schema.dropTableIfExists('integration_protocols');
}