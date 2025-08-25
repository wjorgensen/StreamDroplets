#!/usr/bin/env node

/**
 * Stream Droplets CLI
 * Production-ready command-line interface for managing the indexer system
 */

import { Command } from 'commander';
import { createLogger } from '../utils/logger';
import { getOrchestrator } from '../services/IndexerOrchestrator';
import { BackfillService } from '../services/BackfillService';
import { getDb } from '../db/connection';
import { AccrualEngine } from '../accrual/AccrualEngine';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

const logger = createLogger('CLI');
const program = new Command();

program
  .name('stream-droplets')
  .description('Stream Droplets Tracker CLI')
  .version('1.0.0');

// Indexer commands
const indexer = program
  .command('indexer')
  .description('Manage blockchain indexers');

indexer
  .command('start')
  .description('Start all indexers')
  .option('--chain <chain>', 'Start specific chain only')
  .action(async (options) => {
    const spinner = ora('Starting indexers...').start();
    
    try {
      const orchestrator = getOrchestrator();
      await orchestrator.start();
      
      spinner.succeed(chalk.green('✅ Indexers started successfully'));
      
      // Show status
      const status = orchestrator.getStatus();
      console.log(chalk.cyan('\n📊 Indexer Status:'));
      
      const table = new Table({
        head: ['Chain', 'Status', 'Blocks', 'Events', 'Errors'],
      });
      
      for (const [chain, info] of Object.entries(status.indexers)) {
        table.push([
          chain,
          info.status === 'running' ? chalk.green(info.status) : chalk.red(info.status),
          info.metrics.blocksProcessed,
          info.metrics.eventsProcessed,
          info.metrics.errors,
        ]);
      }
      
      console.log(table.toString());
    } catch (error) {
      spinner.fail(chalk.red('Failed to start indexers'));
      console.error(error);
      process.exit(1);
    }
  });

indexer
  .command('stop')
  .description('Stop all indexers')
  .action(async () => {
    const spinner = ora('Stopping indexers...').start();
    
    try {
      const orchestrator = getOrchestrator();
      await orchestrator.stop();
      spinner.succeed(chalk.green('✅ Indexers stopped'));
    } catch (error) {
      spinner.fail(chalk.red('Failed to stop indexers'));
      console.error(error);
      process.exit(1);
    }
  });

indexer
  .command('status')
  .description('Show indexer status')
  .action(async () => {
    try {
      const orchestrator = getOrchestrator();
      const status = orchestrator.getStatus();
      
      if (!status.running) {
        console.log(chalk.yellow('⚠️  Indexers not running'));
        return;
      }
      
      console.log(chalk.cyan('\n📊 Indexer Status:'));
      console.log(chalk.gray(`Started: ${status.startTime}`));
      
      const table = new Table({
        head: ['Chain', 'Status', 'Blocks', 'Events', 'Last Block', 'Errors'],
      });
      
      for (const [chain, info] of Object.entries(status.indexers)) {
        table.push([
          chain,
          info.status === 'running' ? chalk.green(info.status) : chalk.red(info.status),
          info.metrics.blocksProcessed.toLocaleString(),
          info.metrics.eventsProcessed.toLocaleString(),
          info.metrics.lastBlockProcessed.toLocaleString(),
          info.metrics.errors > 0 ? chalk.red(info.metrics.errors.toString()) : '0',
        ]);
      }
      
      console.log(table.toString());
    } catch (error) {
      console.error(chalk.red('Failed to get status:'), error);
      process.exit(1);
    }
  });

// Backfill commands
const backfill = program
  .command('backfill')
  .description('Manage historical data backfilling');

backfill
  .command('run')
  .description('Run historical backfill')
  .option('--chain <chain>', 'Backfill specific chain')
  .option('--asset <asset>', 'Backfill specific asset')
  .option('--from-block <block>', 'Start from block number')
  .option('--to-block <block>', 'End at block number')
  .option('--clear', 'Clear existing data before backfill')
  .action(async (options) => {
    const spinner = ora('Starting backfill...').start();
    
    try {
      const backfillService = new BackfillService({
        chain: options.chain,
        asset: options.asset,
        fromBlock: options.fromBlock ? parseInt(options.fromBlock) : undefined,
        toBlock: options.toBlock ? parseInt(options.toBlock) : undefined,
        clearData: options.clear || false,
      });
      
      // Track progress
      backfillService.on('progress', (progress) => {
        spinner.text = `Backfilling: ${progress.blocksProcessed} blocks, ${progress.eventsProcessed} events`;
      });
      
      await backfillService.run();
      
      spinner.succeed(chalk.green('✅ Backfill completed'));
      
      // Show summary
      const summary = backfillService.getSummary();
      console.log(chalk.cyan('\n📊 Backfill Summary:'));
      console.log(`  Blocks processed: ${summary.blocksProcessed.toLocaleString()}`);
      console.log(`  Events processed: ${summary.eventsProcessed.toLocaleString()}`);
      console.log(`  Unique users: ${summary.uniqueUsers}`);
      console.log(`  Duration: ${summary.duration}ms`);
    } catch (error) {
      spinner.fail(chalk.red('Backfill failed'));
      console.error(error);
      process.exit(1);
    }
  });

// Database commands
const db = program
  .command('db')
  .description('Database management');

db
  .command('migrate')
  .description('Run database migrations')
  .action(async () => {
    const spinner = ora('Running migrations...').start();
    
    try {
      const database = getDb();
      await database.migrate.latest();
      spinner.succeed(chalk.green('✅ Migrations completed'));
    } catch (error) {
      spinner.fail(chalk.red('Migration failed'));
      console.error(error);
      process.exit(1);
    }
  });

db
  .command('stats')
  .description('Show database statistics')
  .action(async () => {
    try {
      const database = getDb();
      
      const [
        shareEvents,
        rounds,
        snapshots,
        users,
        excluded,
      ] = await Promise.all([
        database('share_events').count('* as count').first(),
        database('rounds').count('* as count').first(),
        database('balance_snapshots').count('* as count').first(),
        database('share_events').countDistinct('address as count').first(),
        database('excluded_addresses').count('* as count').first(),
      ]);
      
      console.log(chalk.cyan('\n📊 Database Statistics:'));
      
      const table = new Table();
      table.push(
        ['Share Events', shareEvents?.count || 0],
        ['Rounds', rounds?.count || 0],
        ['Balance Snapshots', snapshots?.count || 0],
        ['Unique Users', users?.count || 0],
        ['Excluded Addresses', excluded?.count || 0],
      );
      
      console.log(table.toString());
    } catch (error) {
      console.error(chalk.red('Failed to get stats:'), error);
      process.exit(1);
    }
  });

// Droplets commands
const droplets = program
  .command('droplets')
  .description('Droplets calculation and management');

droplets
  .command('calculate <address>')
  .description('Calculate droplets for an address')
  .option('--asset <asset>', 'Calculate for specific asset')
  .action(async (address, options) => {
    const spinner = ora('Calculating droplets...').start();
    
    try {
      const engine = new AccrualEngine();
      
      if (options.asset) {
        const droplets = await engine.calculateDropletsForAsset(address, options.asset);
        spinner.succeed(chalk.green('✅ Calculation complete'));
        
        console.log(chalk.cyan(`\n💧 Droplets for ${address}:`));
        console.log(`  ${options.asset}: ${droplets.toString()}`);
      } else {
        const result = await engine.calculateDroplets(address);
        spinner.succeed(chalk.green('✅ Calculation complete'));
        
        console.log(chalk.cyan(`\n💧 Droplets for ${address}:`));
        console.log(`  Total: ${result.droplets}`);
        console.log(chalk.gray('\n  Breakdown:'));
        
        const table = new Table();
        for (const [asset, amount] of Object.entries(result.breakdown)) {
          table.push([asset, amount]);
        }
        console.log(table.toString());
      }
    } catch (error) {
      spinner.fail(chalk.red('Calculation failed'));
      console.error(error);
      process.exit(1);
    }
  });

droplets
  .command('leaderboard')
  .description('Show droplets leaderboard')
  .option('--limit <n>', 'Number of entries', '10')
  .action(async (options) => {
    const spinner = ora('Loading leaderboard...').start();
    
    try {
      const engine = new AccrualEngine();
      const leaderboard = await engine.getLeaderboard(parseInt(options.limit));
      
      spinner.succeed(chalk.green('✅ Leaderboard loaded'));
      
      console.log(chalk.cyan('\n🏆 Droplets Leaderboard:'));
      
      const table = new Table({
        head: ['Rank', 'Address', 'Droplets'],
      });
      
      for (const entry of leaderboard) {
        table.push([
          entry.rank,
          `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`,
          parseInt(entry.droplets).toLocaleString(),
        ]);
      }
      
      console.log(table.toString());
    } catch (error) {
      spinner.fail(chalk.red('Failed to load leaderboard'));
      console.error(error);
      process.exit(1);
    }
  });

droplets
  .command('recalculate')
  .description('Recalculate all droplets')
  .option('--confirm', 'Confirm recalculation')
  .action(async (options) => {
    if (!options.confirm) {
      console.log(chalk.yellow('⚠️  This will recalculate droplets for all users.'));
      console.log(chalk.yellow('   Use --confirm to proceed.'));
      return;
    }
    
    const spinner = ora('Recalculating all droplets...').start();
    
    try {
      const engine = new AccrualEngine();
      await engine.recalculateAll();
      spinner.succeed(chalk.green('✅ Recalculation complete'));
    } catch (error) {
      spinner.fail(chalk.red('Recalculation failed'));
      console.error(error);
      process.exit(1);
    }
  });

// API commands
const api = program
  .command('api')
  .description('API server management');

api
  .command('start')
  .description('Start API server')
  .action(async () => {
    try {
      console.log(chalk.cyan('🚀 Starting API server...'));
      const { startServer } = await import('../api/server');
      await startServer();
    } catch (error) {
      console.error(chalk.red('Failed to start API:'), error);
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);