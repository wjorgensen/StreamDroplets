import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Create new table for daily snapshots (replaces round-based snapshots)
  await knex.schema.createTable('daily_usd_snapshots', (table) => {
    table.increments('id').primary();
    table.string('address', 42).notNullable();
    table.date('snapshot_date').notNullable(); // The day of the snapshot (YYYY-MM-DD)
    
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
    
    // Integration USD value
    table.decimal('integration_usd_value', 78, 0).defaultTo(0);
    
    // Disqualification flags
    table.boolean('had_unstake').defaultTo(false); // Unstaked during the day
    table.boolean('is_excluded').defaultTo(false); // Address is in exclusion list
    
    // Droplets for this day (1 per USD)
    table.decimal('droplets_earned', 78, 0).defaultTo(0);
    
    table.timestamp('snapshot_timestamp').notNullable(); // Exact time of snapshot
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.unique(['address', 'snapshot_date']);
    table.index(['snapshot_date']);
    table.index(['address']);
    table.index(['snapshot_timestamp']);
  });

  // Create table for tracking daily snapshot jobs
  await knex.schema.createTable('daily_snapshot_jobs', (table) => {
    table.increments('id').primary();
    table.date('snapshot_date').notNullable().unique();
    table.string('status', 20).notNullable(); // 'pending', 'processing', 'completed', 'failed'
    table.timestamp('period_start').notNullable(); // Start of 24-hour period
    table.timestamp('period_end').notNullable(); // End of 24-hour period
    
    // Latest PPS from Ethereum for each asset (at snapshot time)
    table.decimal('xeth_pps', 78, 0).nullable();
    table.decimal('xbtc_pps', 78, 0).nullable();
    table.decimal('xusd_pps', 78, 0).nullable();
    table.decimal('xeur_pps', 78, 0).nullable();
    
    // Oracle prices at snapshot time
    table.decimal('eth_usd_price', 78, 0).nullable();
    table.decimal('btc_usd_price', 78, 0).nullable();
    table.decimal('usd_usd_price', 78, 0).defaultTo('1000000000000000000'); // Always 1.0
    table.decimal('eur_usd_price', 78, 0).nullable();
    
    table.integer('users_processed').defaultTo(0);
    table.decimal('total_droplets_awarded', 78, 0).defaultTo(0);
    
    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    table.text('error_message').nullable();
    
    table.index(['snapshot_date']);
    table.index(['status']);
  });

  // Update droplets_leaderboard to track daily accrual
  await knex.schema.alterTable('droplets_leaderboard', (table) => {
    table.integer('days_participated').defaultTo(0);
    table.date('last_snapshot_date').nullable();
    table.decimal('average_daily_usd', 78, 0).defaultTo(0);
  });

  // Create a table to track the last processed timestamp
  await knex.schema.createTable('system_state', (table) => {
    table.string('key', 50).primary();
    table.text('value').notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Initialize the last processed date
  await knex('system_state').insert({
    key: 'last_snapshot_date',
    value: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Yesterday
    updated_at: knex.fn.now()
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('system_state');
  
  await knex.schema.alterTable('droplets_leaderboard', (table) => {
    table.dropColumn('days_participated');
    table.dropColumn('last_snapshot_date');
    table.dropColumn('average_daily_usd');
  });
  
  await knex.schema.dropTableIfExists('daily_snapshot_jobs');
  await knex.schema.dropTableIfExists('daily_usd_snapshots');
}