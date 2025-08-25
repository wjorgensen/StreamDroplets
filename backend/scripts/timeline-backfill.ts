#!/usr/bin/env tsx

import { Command } from 'commander';
import { createLogger } from '../src/utils/logger';
import { getDb } from '../src/db/connection';
import { TimelineIndexer } from '../src/indexer/TimelineIndexer';
import { TimelineAccrualEngine } from '../src/accrual/TimelineAccrualEngine';
import { TimelineOracleService } from '../src/oracle/TimelineOracleService';
import { CONSTANTS, AssetType } from '../src/config/constants';

const logger = createLogger('Backfill');

const program = new Command();

program
  .name('timeline-backfill')
  .description('Backfill historical data for Stream Droplets timeline system')
  .version('1.0.0');

program
  .command('oracle-prices')
  .description('Backfill historical oracle prices')
  .option('-a, --asset <asset>', 'Specific asset (xETH, xBTC, xUSD, xEUR)', 'all')
  .option('-f, --from <date>', 'Start date (YYYY-MM-DD)', '2024-01-01')
  .option('-t, --to <date>', 'End date (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
  .action(async (options) => {
    const oracleService = new TimelineOracleService();
    const assets = options.asset === 'all' 
      ? ['xETH', 'xBTC', 'xUSD', 'xEUR'] as AssetType[]
      : [options.asset as AssetType];
    
    const fromDate = new Date(options.from);
    const toDate = new Date(options.to);
    
    logger.info(`Backfilling oracle prices from ${fromDate.toISOString()} to ${toDate.toISOString()}`);
    
    for (const asset of assets) {
      logger.info(`Backfilling ${asset} prices`);
      await oracleService.prefetchPriceHistory(asset, fromDate, toDate);
    }
    
    logger.info('Oracle price backfill completed');
  });

program
  .command('timeline-intervals')
  .description('Build timeline intervals from historical events')
  .option('-a, --asset <asset>', 'Specific asset (xETH, xBTC, xUSD, xEUR)', 'all')
  .option('-c, --chain <chain>', 'Specific chain (1=ETH, 146=Sonic)', 'all')
  .option('-f, --from-block <block>', 'Start block number', '0')
  .option('-t, --to-block <block>', 'End block number', 'latest')
  .action(async (options) => {
    const indexer = new TimelineIndexer();
    const assets = options.asset === 'all'
      ? ['xETH', 'xBTC', 'xUSD', 'xEUR'] as AssetType[]
      : [options.asset as AssetType];
    
    const chains = options.chain === 'all'
      ? [CONSTANTS.CHAIN_IDS.ETHEREUM, CONSTANTS.CHAIN_IDS.SONIC]
      : [parseInt(options.chain)];
    
    const fromBlock = BigInt(options.fromBlock);
    const toBlock = options.toBlock === 'latest' ? undefined : BigInt(options.toBlock);
    
    logger.info(`Building timeline intervals from block ${fromBlock} to ${toBlock || 'latest'}`);
    
    // This would need to be implemented in the indexer
    // For now, just log the parameters
    logger.info(`Assets: ${assets.join(', ')}`);
    logger.info(`Chains: ${chains.join(', ')}`);
  });

program
  .command('droplets-calculation')
  .description('Calculate droplets for historical data')
  .option('-a, --address <address>', 'Specific address (leave empty for all)', '')
  .option('-f, --from <date>', 'Start date (YYYY-MM-DD)', '2024-01-01')
  .option('-t, --to <date>', 'End date (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
  .action(async (options) => {
    const accrualEngine = new TimelineAccrualEngine();
    
    const fromDate = new Date(options.from);
    const toDate = new Date(options.to);
    
    if (options.address) {
      logger.info(`Calculating droplets for ${options.address} from ${fromDate.toISOString()} to ${toDate.toISOString()}`);
      
      // Calculate for specific address
      const result = await accrualEngine.calculateDroplets(options.address);
      logger.info(`Result: ${result.droplets} total droplets`);
      
    } else {
      logger.info(`Recalculating droplets for all addresses from ${fromDate.toISOString()} to ${toDate.toISOString()}`);
      
      // Recalculate for all addresses
      await accrualEngine.recalculateAll(fromDate, toDate);
    }
  });

program
  .command('validate')
  .description('Validate timeline data integrity')
  .action(async () => {
    const accrualEngine = new TimelineAccrualEngine();
    const db = getDb();
    
    logger.info('Validating timeline data integrity');
    
    // Check for timeline gaps
    const timelineValid = await accrualEngine.validateTimeline();
    
    if (!timelineValid) {
      logger.error('Timeline validation failed - found gaps');
      process.exit(1);
    }
    
    // Check oracle price coverage
    const oracleService = new TimelineOracleService();
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    
    for (const asset of assets) {
      const isValid = await oracleService.validatePriceStaleness(asset);
      if (!isValid) {
        logger.warn(`Oracle prices for ${asset} may be stale`);
      }
    }
    
    logger.info('Validation completed successfully');
  });

program
  .command('stats')
  .description('Show timeline statistics')
  .action(async () => {
    const db = getDb();
    
    logger.info('Timeline Statistics:');
    
    // Count intervals
    const intervalCount = await db('timeline_intervals').count('id as count');
    logger.info(`Total timeline intervals: ${intervalCount[0].count}`);
    
    // Count integrations
    const integrationCount = await db('droplets_integration').count('id as count');
    logger.info(`Total droplet calculations: ${integrationCount[0].count}`);
    
    // Count oracle prices
    const priceCount = await db('oracle_prices_timeline').count('id as count');
    logger.info(`Total oracle price points: ${priceCount[0].count}`);
    
    // Show rate configuration
    const rates = await db('rate_configuration')
      .where('is_active', true)
      .orderBy('effective_from');
    
    logger.info(`Active rates: ${rates.length}`);
    rates.forEach(rate => {
      logger.info(`  ${rate.effective_from.toISOString()}: ${rate.rate_per_usd_second} droplets/USD/second`);
    });
  });

// Error handling
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the CLI
program.parse();
