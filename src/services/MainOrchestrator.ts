/**
 * Main Orchestrator Service
 * 
 * The primary entry point for the StreamDroplets indexing system.
 * Handles:
 * 1. Historical backfill from earliest deployment date
 * 2. Real-time daily snapshots at midnight UTC
 * 3. Progress tracking via database cursors
 * 4. Block range calculation for multi-chain processing
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { DailySnapshotService } from './DailySnapshotService';
import { AlchemyService } from '../utils/AlchemyService';
import { blocksBeforeTimestamp } from '../utils/blockTime';
import { DEPLOYMENT_INFO, getSupportedChainIds, getSupportedNetworkNames, getChainIdToNetworkNameMapping } from '../config/contracts';
import { BlockRange, CONSTANTS } from '../config/constants';
import { dateStringToEndOfDayISO } from '../utils/dateUtils';

const logger = createLogger('MainOrchestrator');

interface ProgressCursor {
  chain_id: number;
  chain_name: string;
  last_processed_block: number;
  last_processed_date: string | null;
  last_updated: Date;
}

interface ChainLatestBlock {
  chainId: number;
  latestBlock: number;
}

export class MainOrchestrator {
  private db = getDb();
  private alchemyService!: AlchemyService;
  private dailySnapshotService: DailySnapshotService;
  private isRunning = false;
  private backfillComplete = false;

  constructor() {
    // AlchemyService will be initialized in start() method
    this.dailySnapshotService = new DailySnapshotService();
  }

  /**
   * Main entry point - starts the orchestration service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MainOrchestrator is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting StreamDroplets MainOrchestrator');

    try {
      // Step 1: Initialize AlchemyService to setup all chain connections
      logger.info('Initializing AlchemyService...');
      this.alchemyService = AlchemyService.getInstance();
      logger.info('AlchemyService initialized successfully');
      
      // Step 2: Check for and recover from partial processing
      const partiallyProcessedDay = await this.detectPartiallyProcessedDay();
      if (partiallyProcessedDay) {
        logger.warn(`Detected partially processed day: ${partiallyProcessedDay}`);
        logger.info('Starting automatic recovery process...');
        await this.cleanupPartiallyProcessedDay(partiallyProcessedDay);
        logger.info(`Recovery completed for ${partiallyProcessedDay}. Backfill will resume from this date.`);
      }
      
      // Step 3: Run historical backfill
      await this.runBackfill();
      
      // Step 4: Start real-time processing
      await this.startRealtimeProcessing();
      
    } catch (error) {
      logger.error('MainOrchestrator failed to start:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the orchestration service
   */
  stop(): void {
    this.isRunning = false;
    logger.info('MainOrchestrator stopped');
  }

  /**
   * Run historical backfill from cursor dates to latest block
   */
  private async runBackfill(): Promise<void> {
    logger.info('Starting historical backfill process...');
    
    // Get the earliest last_processed_date from cursors to determine where to start
    const earliestCursorDate = await this.getEarliestCursorDate();
    logger.info(`Earliest cursor date found: ${earliestCursorDate}`);
    
    // Start from the day after the last processed date
    const lastProcessedDate = new Date(earliestCursorDate + 'T00:00:00.000Z');
    const startDate = new Date(lastProcessedDate);
    startDate.setDate(startDate.getDate() + 1); // Start from next day
    
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0); // Set to midnight UTC
    
    logger.info(`Backfill will process from ${startDate.toISOString().split('T')[0]} to ${currentDate.toISOString().split('T')[0]}`);
    
    // Processing in UTC - no timezone conversions needed
    const processingDate = new Date(startDate);
    const currentDateUTC = new Date(currentDate);
    let dayCount = 0;
    
    while (processingDate < currentDateUTC && this.isRunning) {
      const dateString = processingDate.toISOString().split('T')[0];
      
      try {
        // Get block ranges for this day
        const { blockRanges, endBlocks } = await this.calculateBlockRanges(processingDate);
        
        if (blockRanges.length === 0) {
          processingDate.setDate(processingDate.getDate() + 1);
          continue;
        }
        
        // Process the day using DailySnapshotService
        await this.dailySnapshotService.processDailySnapshot(dateString, blockRanges);
        
        // Update progress cursors
        await this.updateProgressCursors(blockRanges, dateString);
        
        // Store block timestamps for this date
        await this.storeBlockTimestamps(dateString, endBlocks);
        
        dayCount++;
        
      } catch (error) {
        logger.error(`CRITICAL: Failed to process ${dateString} - stopping backfill:`, error);
        // Stop backfill execution - all days must be processed sequentially
        throw error;
      }
      
      // Move to next day
      processingDate.setDate(processingDate.getDate() + 1);
    }
    
    this.backfillComplete = true;
    logger.info(`Historical backfill completed! Processed ${dayCount} days`);
  }


  /**
   * Calculate block ranges for a specific date
   */
  private async calculateBlockRanges(processingDate: Date): Promise<{blockRanges: BlockRange[], endBlocks: Record<number, {block: number, timestamp: Date}>}> {
    const dateString = processingDate.toISOString().split('T')[0];
    const blockRanges: BlockRange[] = [];
    
    logger.info(`=== BLOCK RANGE CALCULATION FOR ${dateString} ===`);
    logger.info(`Processing date: ${processingDate.toISOString()}`);
    
    // Get the latest blocks for all chains at 11:59:59 PM UTC for this date
    const endOfDayISO = dateStringToEndOfDayISO(dateString);
    const networkNames = getSupportedNetworkNames();
    
    logger.info(`Date string: ${dateString}`);
    logger.info(`End of day ISO: ${endOfDayISO}`);
    logger.info(`End of day timestamp: ${new Date(endOfDayISO).getTime() / 1000}`);
    logger.info(`Network names: ${networkNames.join(', ')}`);
    
    // Create starting blocks mapping from progress cursors for binary search
    const startingBlocks: Record<string, number> = {};
    const chainIdToNetwork = getChainIdToNetworkNameMapping();
    const cursors = await this.getProgressCursors();
    
    for (const cursor of cursors) {
      const networkName = chainIdToNetwork[cursor.chain_id];
      if (networkName) {
        // Use last processed block as starting point for binary search
        startingBlocks[networkName] = cursor.last_processed_block;
        logger.info(`Starting block for ${networkName}: ${cursor.last_processed_block}`);
      }
    }
    
    logger.info(`Calling blocksBeforeTimestamp with timestamp: ${endOfDayISO}`);
    const endBlocks = await blocksBeforeTimestamp(endOfDayISO, networkNames, { startingBlocks });
    logger.info(`End blocks retrieved: ${JSON.stringify(endBlocks)}`);
    
    // CRITICAL: If any end block equals a starting block, this indicates a bug
    for (const [networkName, endBlock] of Object.entries(endBlocks)) {
      const startBlock = startingBlocks[networkName];
      if (startBlock && endBlock === startBlock) {
        const error = `CRITICAL BUG: End block ${endBlock} equals start block ${startBlock} for ${networkName}. This means no time has passed between timestamps, indicating a date calculation error.`;
        logger.error(error);
        throw new Error(error);
      }
    }
    
    logger.info(`Chain ID to network mapping: ${JSON.stringify(chainIdToNetwork)}`);
    
    // Get all supported chain IDs
    const supportedChainIds = getSupportedChainIds();
    logger.info(`Supported chain IDs: ${supportedChainIds.join(', ')}`);
    
    // Create cursor map from already fetched cursors
    const cursorMap = new Map(cursors.map(c => [c.chain_id, c]));
    logger.info(`Progress cursors found for chains: ${cursors.map(c => `${c.chain_id}(${c.chain_name})`).join(', ')}`);

    const endBlocksForStorage: Record<number, {block: number, timestamp: Date}> = {};
    const endOfDay = new Date(endOfDayISO);
    
    // Loop through all supported chain IDs
    for (const chainId of supportedChainIds) {
      logger.info(`\n--- Processing chain ${chainId} ---`);
      
      const cursor = cursorMap.get(chainId);
      if (!cursor) {
        logger.warn(`❌ No progress cursor found for chain ${chainId}`);
        continue;
      }
      logger.info(`✓ Progress cursor found: chain=${cursor.chain_id}, name=${cursor.chain_name}, last_block=${cursor.last_processed_block}`);
      
      const networkName = chainIdToNetwork[chainId];
      if (!networkName) {
        logger.warn(`❌ No network name found for chain ${chainId}`);
        continue;
      }
      logger.info(`✓ Network name found: ${networkName}`);
      
      if (!endBlocks[networkName]) {
        logger.warn(`❌ No end block found for chain ${chainId} (${cursor.chain_name}) - network: ${networkName}`);
        logger.warn(`Available networks in endBlocks: ${Object.keys(endBlocks).join(', ')}`);
        continue;
      }
      
      const endBlock = endBlocks[networkName];
      logger.info(`✓ End block found: ${endBlock} for network ${networkName}`);
      endBlocksForStorage[chainId] = { block: endBlock, timestamp: endOfDay };
      
      // Get deployment info for this chain
      const deploymentInfo = Object.values(DEPLOYMENT_INFO.CHAIN_DEPLOYMENTS).find(info => info.chainId === chainId);
      if (!deploymentInfo) {
        logger.warn(`❌ No deployment info found for chain ${chainId}`);
        continue;
      }
      logger.info(`✓ Deployment info: earliest date=${deploymentInfo.earliestDate}, earliest block=${deploymentInfo.earliestBlock}`);
      
      // Check if we're before the deployment date for this chain
      if (dateString < deploymentInfo.earliestDate) {
        logger.info(`❌ Skipping chain ${chainId}: processing date ${dateString} is before deployment date ${deploymentInfo.earliestDate}`);
        continue;
      }
      logger.info(`✓ Processing date ${dateString} >= deployment date ${deploymentInfo.earliestDate}`);
      
      let lastProcessedBlock = cursor.last_processed_block;
      logger.info(`Initial last processed block: ${lastProcessedBlock} (type: ${typeof lastProcessedBlock})`);
      
      // Ensure lastProcessedBlock is a number
      lastProcessedBlock = Number(lastProcessedBlock);
      logger.info(`Converted to number: ${lastProcessedBlock}`);
      
      // If last processed block is below the chain's earliest block, set it to earliestBlock - 1
      if (lastProcessedBlock < deploymentInfo.earliestBlock) {
        lastProcessedBlock = deploymentInfo.earliestBlock - 1;
        logger.info(`Adjusted last processed block to ${lastProcessedBlock} (deployment earliest - 1)`);
      }
      
      // Calculate fromBlock as lastProcessedBlock + 1
      const fromBlock = lastProcessedBlock + 1;
      logger.info(`Calculated fromBlock: ${fromBlock} (should be ${lastProcessedBlock} + 1)`);
      
      // CRITICAL: fromBlock should never be > endBlock if we're processing the next day
      if (fromBlock > endBlock) {
        const error = `CRITICAL BUG: fromBlock ${fromBlock} > endBlock ${endBlock} for chain ${chainId}. This indicates a date calculation or block retrieval error.`;
        logger.error(error);
        logger.error(`Details: cursor=${cursor.last_processed_block}, dateString=${dateString}, networkName=${networkName}`);
        throw new Error(error);
      }
      
      const blockRange: BlockRange = {
        chainId,
        fromBlock,
        toBlock: endBlock,
      };
      
      logger.info(`✅ Created block range for chain ${chainId}: ${fromBlock} to ${endBlock}`);
      blockRanges.push(blockRange);
    }
    
    logger.info(`\n=== FINAL RESULTS ===`);
    logger.info(`Block ranges created: ${blockRanges.length}`);
    blockRanges.forEach((range, i) => {
      logger.info(`  ${i+1}. Chain ${range.chainId}: blocks ${range.fromBlock}-${range.toBlock}`);
    });
    
    return { blockRanges, endBlocks: endBlocksForStorage };
  }

  /**
   * Get progress cursors for all chains
   */
  private async getProgressCursors(): Promise<ProgressCursor[]> {
    return await this.db('progress_cursors')
      .select('*')
      .orderBy('chain_id');
  }

  /**
   * Format a date value to YYYY-MM-DD string for consistent processing
   */
  private formatDateForProcessing(dateValue: any): string {
    if (dateValue instanceof Date) {
      return dateValue.toISOString().split('T')[0];
    }
    if (typeof dateValue === 'string') {
      // If it's already a string, ensure it's in YYYY-MM-DD format
      const parsed = new Date(dateValue);
      return parsed.toISOString().split('T')[0];
    }
    throw new Error(`Invalid date value: ${dateValue}`);
  }

  /**
   * Get the earliest last_processed_date from all cursors to determine backfill start point
   */
  private async getEarliestCursorDate(): Promise<string> {
    const result = await this.db('progress_cursors')
      .whereNotNull('last_processed_date')
      .orderBy('last_processed_date', 'asc')
      .select('last_processed_date')
      .first();
    
    if (!result) {
      // Fallback to hardcoded date if no cursor dates exist (shouldn't happen with updated migration)
      logger.warn('No cursor dates found, falling back to hardcoded start date');
      return DEPLOYMENT_INFO.OVERALL_START_DATE;
    }
    
    // Ensure we return a string in YYYY-MM-DD format
    return this.formatDateForProcessing(result.last_processed_date);
  }

  /**
   * Update progress cursors after successful processing
   */
  private async updateProgressCursors(blockRanges: BlockRange[], dateString: string): Promise<void> {
    for (const range of blockRanges) {
      await this.db('progress_cursors')
        .where('chain_id', range.chainId)
        .update({
          last_processed_block: range.toBlock,
          last_processed_date: dateString,
          last_updated: new Date(),
        });
      
    }
  }

  /**
   * Store block timestamps for the processed date
   */
  private async storeBlockTimestamps(dateString: string, endBlocks: Record<number, {block: number, timestamp: Date}>): Promise<void> {
    const blockTimestamps = Object.entries(endBlocks).map(([chainId, {block, timestamp}]) => ({
      chain_id: parseInt(chainId),
      block_number: block,
      timestamp,
      date: dateString,
    }));

    if (blockTimestamps.length > 0) {
      await this.db('block_timestamps')
        .insert(blockTimestamps)
        .onConflict(['chain_id', 'block_number'])
        .merge();
      
    }
  }

  /**
   * Get the latest block numbers for all chains
   */
  private async getLatestBlocks(): Promise<ChainLatestBlock[]> {
    const supportedChains = getSupportedChainIds();
    const latestBlocks: ChainLatestBlock[] = [];
    
    for (const chainId of supportedChains) {
      try {
        const alchemy = this.alchemyService.getAlchemyInstance(chainId);
        const latestBlock = await alchemy.core.getBlockNumber();
        
        latestBlocks.push({
          chainId,
          latestBlock,
        });
      } catch (error) {
        logger.error(`Failed to get latest block for chain ${chainId}:`, error);
      }
    }
    
    return latestBlocks;
  }


  /**
   * Detect if there's a partially processed day (events exist but no snapshot)
   */
  private async detectPartiallyProcessedDay(): Promise<string | null> {
    logger.info('Checking for partially processed days...');
    
    // Look for daily_events without corresponding daily_snapshots
    const partialEventDay = await this.db('daily_events')
      .select('event_date')
      .whereNotExists(function() {
        this.select('*')
          .from('daily_snapshots')
          .whereRaw('daily_snapshots.snapshot_date = daily_events.event_date');
      })
      .orderBy('event_date')
      .first();
    
    if (partialEventDay) {
      const dateString = this.formatDateForProcessing(partialEventDay.event_date);
      logger.warn(`Found partially processed day from daily_events: ${dateString}`);
      return dateString;
    }
    
    // Look for daily_integration_events without corresponding daily_snapshots
    const partialIntegrationDay = await this.db('daily_integration_events')
      .select('event_date')
      .whereNotExists(function() {
        this.select('*')
          .from('daily_snapshots')
          .whereRaw('daily_snapshots.snapshot_date = daily_integration_events.event_date');
      })
      .orderBy('event_date')
      .first();
    
    if (partialIntegrationDay) {
      const dateString = this.formatDateForProcessing(partialIntegrationDay.event_date);
      logger.warn(`Found partially processed day from daily_integration_events: ${dateString}`);
      return dateString;
    }
    
    logger.info('No partially processed days found');
    return null;
  }

  /**
   * Clean up partially processed data for a specific date
   */
  private async cleanupPartiallyProcessedDay(dateString: string): Promise<void> {
    logger.info(`Starting cleanup of partially processed day: ${dateString}`);
    
    // Step 1: Reset balances that were updated on this date back to previous day's values
    await this.resetBalancesToPreviousDay(dateString);
    
    // Step 2: Delete daily events for this date
    const deletedEvents = await this.db('daily_events')
      .where('event_date', dateString)
      .del();
    logger.info(`Deleted ${deletedEvents} daily_events records for ${dateString}`);
    
    // Step 3: Delete daily integration events for this date
    const deletedIntegrationEvents = await this.db('daily_integration_events')
      .where('event_date', dateString)
      .del();
    logger.info(`Deleted ${deletedIntegrationEvents} daily_integration_events records for ${dateString}`);
    
    // Step 4: Delete any user daily snapshots for this date (in case they were partially created)
    const deletedUserSnapshots = await this.db('user_daily_snapshots')
      .where('snapshot_date', dateString)
      .del();
    logger.info(`Deleted ${deletedUserSnapshots} user_daily_snapshots records for ${dateString}`);
    
    // Step 5: Delete any protocol snapshot for this date (in case it was partially created)
    const deletedProtocolSnapshot = await this.db('daily_snapshots')
      .where('snapshot_date', dateString)
      .del();
    logger.info(`Deleted ${deletedProtocolSnapshot} daily_snapshots record for ${dateString}`);
    
    logger.info(`Cleanup completed for ${dateString}`);
  }

  /**
   * Reset share_balances and integration_balances back to their previous day's state
   */
  private async resetBalancesToPreviousDay(dateString: string): Promise<void> {
    logger.info(`Resetting balances to previous day state for date: ${dateString}`);
    
    // Get previous day
    const currentDate = new Date(dateString);
    const previousDate = new Date(currentDate);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateString = previousDate.toISOString().split('T')[0];
    
    logger.info(`Previous day: ${previousDateString}`);
    
    // Reset share_balances that were last updated on the partial day
    const shareBalancesToReset = await this.db('share_balances')
      .where('last_updated_date', dateString);
    
    logger.info(`Found ${shareBalancesToReset.length} share_balances to reset`);
    
    for (const balance of shareBalancesToReset) {
      // Get the user's snapshot from the previous day to restore balance
      const previousSnapshot = await this.db('user_daily_snapshots')
        .where('address', balance.address)
        .where('snapshot_date', previousDateString)
        .first();
      
      if (previousSnapshot) {
        const assetKey = `${balance.asset.toLowerCase()}_shares_total`;
        const previousShares = previousSnapshot[assetKey] || '0';
        
        // Update the balance back to previous day's value
        await this.db('share_balances')
          .where('id', balance.id)
          .update({
            shares: previousShares,
            last_updated_date: previousDateString,
            last_updated: new Date(previousSnapshot.snapshot_timestamp),
            // Keep the same last_update_block - we'll get a proper one when reprocessing
          });
        
        logger.info(`Reset share_balance for ${balance.address} ${balance.asset}: ${balance.shares} -> ${previousShares}`);
      } else {
        // No previous snapshot exists - this user must be new, delete the balance
        await this.db('share_balances')
          .where('id', balance.id)
          .del();
        
        logger.info(`Deleted share_balance for new user ${balance.address} ${balance.asset}`);
      }
    }
    
    // Reset integration_balances that were last updated on the partial day
    const integrationBalancesToReset = await this.db('integration_balances')
      .where('last_updated_date', dateString);
    
    logger.info(`Found ${integrationBalancesToReset.length} integration_balances to reset`);
    
    for (const balance of integrationBalancesToReset) {
      // Get the user's snapshot from the previous day to restore integration breakdown
      const previousSnapshot = await this.db('user_daily_snapshots')
        .where('address', balance.address)
        .where('snapshot_date', previousDateString)
        .first();
      
      if (previousSnapshot) {
        let previousIntegrationBalance = '0';
        
        try {
          const integrationBreakdown = JSON.parse(previousSnapshot.integration_breakdown || '{}');
          const protocolBreakdown = integrationBreakdown[balance.protocol_name] || {};
          previousIntegrationBalance = protocolBreakdown[balance.asset] || '0';
        } catch (error) {
          logger.warn(`Failed to parse integration breakdown for ${balance.address}: ${error}`);
          previousIntegrationBalance = '0';
        }
        
        // Update the balance back to previous day's value
        await this.db('integration_balances')
          .where('id', balance.id)
          .update({
            position_shares: previousIntegrationBalance,
            last_updated_date: previousDateString,
            last_updated: new Date(previousSnapshot.snapshot_timestamp),
            // Keep the same last_update_block - we'll get a proper one when reprocessing
          });
        
        logger.info(`Reset integration_balance for ${balance.address} ${balance.protocol_name}: ${balance.position_shares} -> ${previousIntegrationBalance}`);
      } else {
        // No previous snapshot exists - this user must be new, delete the balance
        await this.db('integration_balances')
          .where('id', balance.id)
          .del();
        
        logger.info(`Deleted integration_balance for new user ${balance.address} ${balance.protocol_name}`);
      }
    }
    
    logger.info(`Balance reset completed for ${dateString}`);
  }

  /**
   * Start real-time processing (snapshots at configured time in UTC)
   */
  private async startRealtimeProcessing(): Promise<void> {
    logger.info('Starting real-time processing mode...');
    
    // Run initial check to see if we need to process yesterday
    await this.checkAndRunLiveFill();
    
    // Start the timer loop that checks every second for the configured live fill time UTC
    const checkInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(checkInterval);
        return;
      }
      
      const now = new Date();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      // Check if it's the configured live fill time UTC
      if (hours === CONSTANTS.LIVE_FILL_TIME.HOURS && minutes === CONSTANTS.LIVE_FILL_TIME.MINUTES) {
        try {
          await this.checkAndRunLiveFill();
        } catch (error) {
          logger.error('Error during scheduled live fill:', error);
        }
      }
    }, 1000); // Check every second
    
    logger.info('Real-time processing loop started');
  }

  /**
   * Check if live fill needs to run and execute it
   */
  private async checkAndRunLiveFill(): Promise<void> {
    const now = new Date();
    // Get yesterday's date in UTC
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0); // Set to midnight UTC
    const yesterdayString = yesterday.toISOString().split('T')[0];
    
    
    // Check if this date is already processed
    const existingSnapshot = await this.db('daily_snapshots')
      .where('snapshot_date', yesterdayString)
      .first();
    
    if (existingSnapshot) {
      return;
    }
    
    // Run live fill for yesterday
    await this.runLiveFill(yesterdayString);
  }

  /**
   * Run live fill for a specific date (assumes backfill is complete)
   */
  private async runLiveFill(dateString: string): Promise<void> {
    logger.info(`Starting live fill for date: ${dateString}`);
    
    try {
      // Step 1: Validate that backfill is up to date
      await this.validateBackfillStatus(dateString);
      
      // Step 2: Calculate block ranges for all active chains
      const processingDate = new Date(dateString + 'T00:00:00.000Z');
      const { blockRanges, endBlocks } = await this.calculateLiveFillBlockRanges(processingDate);
      
      if (blockRanges.length === 0) {
        logger.warn(`No block ranges found for live fill on ${dateString}, skipping`);
        return;
      }
      
      
      // Step 3: Process the day using DailySnapshotService
      await this.dailySnapshotService.processDailySnapshot(dateString, blockRanges);
      
      // Step 4: Update progress cursors
      await this.updateProgressCursors(blockRanges, dateString);
      
      // Step 5: Store block timestamps for this date
      await this.storeBlockTimestamps(dateString, endBlocks);
      
      logger.info(`Live fill completed successfully for ${dateString}`);
      
    } catch (error) {
      logger.error(`Live fill failed for ${dateString}:`, error);
      throw error;
    }
  }

  /**
   * Validate that backfill is up to date (last snapshot should be 2 days ago)
   */
  private async validateBackfillStatus(targetDateString: string): Promise<void> {
    // Get the most recent snapshot date
    const lastSnapshot = await this.db('daily_snapshots')
      .select('snapshot_date')
      .orderBy('snapshot_date', 'desc')
      .first();
    
    if (!lastSnapshot) {
      logger.warn('No previous snapshots found, running backfill...');
      await this.runBackfill();
      return;
    }
    
    const lastSnapshotDate = new Date(lastSnapshot.snapshot_date);
    const targetDate = new Date(targetDateString);
    const daysDifference = Math.floor((targetDate.getTime() - lastSnapshotDate.getTime()) / (1000 * 60 * 60 * 24));
    
    
    // If the gap is more than 1 day, we need to run backfill to catch up
    if (daysDifference > 1) {
      logger.warn(`Gap detected between last snapshot (${lastSnapshot.snapshot_date}) and target date (${targetDateString}). Running backfill to catch up...`);
      await this.runBackfill();
    }
  }

  /**
   * Calculate block ranges for live fill (all chains assumed active)
   */
  private async calculateLiveFillBlockRanges(processingDate: Date): Promise<{blockRanges: BlockRange[], endBlocks: Record<number, {block: number, timestamp: Date}>}> {
    const dateString = processingDate.toISOString().split('T')[0];
    const blockRanges: BlockRange[] = [];
    
    // Get the latest blocks for all chains at 11:59:59 PM UTC for this date
    const endOfDayISO = dateStringToEndOfDayISO(dateString);
    const networkNames = getSupportedNetworkNames();
    
    // Get progress cursors for all chains
    const cursors = await this.getProgressCursors();
    
    // Create starting blocks mapping from progress cursors for binary search
    const startingBlocks: Record<string, number> = {};
    const chainIdToNetwork = getChainIdToNetworkNameMapping();
    
    for (const cursor of cursors) {
      const networkName = chainIdToNetwork[cursor.chain_id];
      if (networkName) {
        // Use last processed block as starting point for binary search
        startingBlocks[networkName] = cursor.last_processed_block;
      }
    }
    
    const endBlocks = await blocksBeforeTimestamp(endOfDayISO, networkNames, { startingBlocks });
    
    // Get all supported chain IDs
    const supportedChainIds = getSupportedChainIds();
    const cursorMap = new Map(cursors.map(c => [c.chain_id, c]));

    const endBlocksForStorage: Record<number, {block: number, timestamp: Date}> = {};
    const endOfDay = new Date(endOfDayISO);
    
    // For live fill, assume all chains are active
    for (const chainId of supportedChainIds) {
      const cursor = cursorMap.get(chainId);
      if (!cursor) {
        logger.warn(`No progress cursor found for chain ${chainId} during live fill`);
        continue;
      }
      
      const networkName = chainIdToNetwork[chainId];
      if (!networkName || !endBlocks[networkName]) {
        logger.warn(`No end block found for chain ${chainId} (${cursor.chain_name}) during live fill`);
        continue;
      }
      
      const endBlock = endBlocks[networkName];
      endBlocksForStorage[chainId] = { block: endBlock, timestamp: endOfDay };
      
      // Get deployment info for this chain
      const deploymentInfo = Object.values(DEPLOYMENT_INFO.CHAIN_DEPLOYMENTS).find(info => info.chainId === chainId);
      if (!deploymentInfo) {
        logger.warn(`No deployment info found for chain ${chainId} during live fill`);
        continue;
      }
      
      let lastProcessedBlock = cursor.last_processed_block;
      
      // If last processed block is below the chain's earliest block, set it to earliestBlock - 1
      if (lastProcessedBlock < deploymentInfo.earliestBlock) {
        lastProcessedBlock = deploymentInfo.earliestBlock - 1;
      }
      
      // For live fill, start from last processed block + 1
      const fromBlock = lastProcessedBlock + 1;
      
      // CRITICAL: fromBlock should never be > endBlock in live fill
      if (fromBlock > endBlock) {
        const error = `CRITICAL BUG in live fill: fromBlock ${fromBlock} > endBlock ${endBlock} for chain ${chainId}. This indicates a date calculation or block retrieval error.`;
        logger.error(error);
        throw new Error(error);
      }
      
      const blockRange: BlockRange = {
        chainId,
        fromBlock,
        toBlock: endBlock,
      };
      
      blockRanges.push(blockRange);
    }
    
    return { blockRanges, endBlocks: endBlocksForStorage };
  }

  /**
   * Get system status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    backfillComplete: boolean;
    currentProgress: any;
    latestBlocks: ChainLatestBlock[];
  }> {
    const cursors = await this.getProgressCursors();
    const latestBlocks = await this.getLatestBlocks();
    
    return {
      isRunning: this.isRunning,
      backfillComplete: this.backfillComplete,
      currentProgress: cursors,
      latestBlocks,
    };
  }
}
