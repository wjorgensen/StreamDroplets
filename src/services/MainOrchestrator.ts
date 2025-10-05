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
import { DEPLOYMENT_INFO, getSupportedChainIds, getChainIdToNetworkNameMapping, CONTRACTS } from '../config/contracts';
import { BlockRange, CONSTANTS } from '../config/constants';
import { dateStringToEndOfDayISO } from '../utils/dateUtils';
import { STREAM_VAULT_ABI } from '../config/abis/streamVault';
import { withAlchemyRetry } from '../utils/retryUtils';

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
    this.dailySnapshotService = new DailySnapshotService();
  }

  /**
   * Starts the orchestration service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MainOrchestrator is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting StreamDroplets MainOrchestrator');

    try {
      logger.info('Initializing AlchemyService...');
      this.alchemyService = AlchemyService.getInstance();
      logger.info('AlchemyService initialized successfully');
      
      const partiallyProcessedDay = await this.detectPartiallyProcessedDay();
      if (partiallyProcessedDay) {
        logger.warn(`Detected partially processed day: ${partiallyProcessedDay}`);
        logger.info('Starting automatic recovery process...');
        await this.cleanupPartiallyProcessedDay(partiallyProcessedDay);
        logger.info(`Recovery completed for ${partiallyProcessedDay}. Backfill will resume from this date.`);
      }
      
      await this.runBackfill();
      
      await this.startRealtimeProcessing();
      
    } catch (error) {
      logger.error('MainOrchestrator failed to start:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stops the orchestration service
   */
  stop(): void {
    this.isRunning = false;
    logger.info('MainOrchestrator stopped');
  }

  /**
   * Runs historical backfill from cursor dates to latest block
   */
  private async runBackfill(): Promise<void> {
    logger.info('Starting historical backfill process...');
    
    const earliestCursorDate = await this.getEarliestCursorDate();
    logger.info(`Earliest cursor date found: ${earliestCursorDate}`);
    
    const lastProcessedDate = new Date(earliestCursorDate + 'T00:00:00.000Z');
    const startDate = new Date(lastProcessedDate);
    startDate.setDate(startDate.getDate() + 1);
    
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0);
    
    logger.info(`Backfill will process from ${startDate.toISOString().split('T')[0]} to ${currentDate.toISOString().split('T')[0]}`);
    
    const processingDate = new Date(startDate);
    const currentDateUTC = new Date(currentDate);
    let dayCount = 0;
    
    while (processingDate < currentDateUTC && this.isRunning) {
      const dateString = processingDate.toISOString().split('T')[0];
      
      try {
        const { blockRanges, endBlocks } = await this.calculateBlockRanges(processingDate);
        
        if (blockRanges.length === 0) {
          processingDate.setDate(processingDate.getDate() + 1);
          continue;
        }
        
        await this.dailySnapshotService.processDailySnapshot(dateString, blockRanges);
        
        await this.updateProgressCursors(blockRanges, dateString);
        
        await this.storeBlockTimestamps(dateString, endBlocks);
        
        dayCount++;
        
      } catch (error) {
        logger.error(`CRITICAL: Failed to process ${dateString} - stopping backfill:`, error);
        throw error;
      }
      
      processingDate.setDate(processingDate.getDate() + 1);
    }
    
    this.backfillComplete = true;
    logger.info(`Historical backfill completed! Processed ${dayCount} days`);
  }


  /**
   * Calculates block ranges for a specific date
   */
  private async calculateBlockRanges(processingDate: Date): Promise<{blockRanges: BlockRange[], endBlocks: Record<number, {block: number, timestamp: Date}>}> {
    const dateString = processingDate.toISOString().split('T')[0];
    const blockRanges: BlockRange[] = [];
    
    logger.info(`=== BLOCK RANGE CALCULATION FOR ${dateString} ===`);
    logger.info(`Processing date: ${processingDate.toISOString()}`);
    
    const endOfDayISO = dateStringToEndOfDayISO(dateString);
    const chainIdToNetwork = getChainIdToNetworkNameMapping();
    const cursors = await this.getProgressCursors();
    
    logger.info(`Date string: ${dateString}`);
    logger.info(`End of day ISO: ${endOfDayISO}`);
    logger.info(`End of day timestamp: ${new Date(endOfDayISO).getTime() / 1000}`);
    
    const activeNetworkNames: string[] = [];
    const startingBlocks: Record<string, number> = {};
    
    for (const cursor of cursors) {
      const networkName = chainIdToNetwork[cursor.chain_id];
      if (!networkName) continue;
      
      const deploymentInfo = Object.values(DEPLOYMENT_INFO.CHAIN_DEPLOYMENTS).find(info => info.chainId === cursor.chain_id);
      if (!deploymentInfo) {
        logger.warn(`No deployment info found for chain ${cursor.chain_id}, skipping`);
        continue;
      }
      
      if (dateString >= deploymentInfo.earliestDate) {
        activeNetworkNames.push(networkName);
        startingBlocks[networkName] = cursor.last_processed_block;
        logger.info(`Network ${networkName} (chain ${cursor.chain_id}) is active - deployment: ${deploymentInfo.earliestDate}`);
      } else {
        logger.info(`Skipping network ${networkName} (chain ${cursor.chain_id}) - processing date ${dateString} is before deployment date ${deploymentInfo.earliestDate}`);
      }
    }
    
    logger.info(`Active networks for ${dateString}: ${activeNetworkNames.join(', ')}`);
    logger.info(`Starting blocks: ${JSON.stringify(startingBlocks)}`);
    
    if (activeNetworkNames.length === 0) {
      logger.info(`No active networks for ${dateString}, skipping block fetch`);
      return { blockRanges: [], endBlocks: {} };
    }
    
    logger.info(`Calling blocksBeforeTimestamp with timestamp: ${endOfDayISO}`);
    const endBlocks = await blocksBeforeTimestamp(endOfDayISO, activeNetworkNames, { startingBlocks });
    logger.info(`End blocks retrieved: ${JSON.stringify(endBlocks)}`);
    
    for (const [networkName, endBlock] of Object.entries(endBlocks)) {
      const startBlock = startingBlocks[networkName];
      if (startBlock && endBlock === startBlock) {
        const error = `CRITICAL BUG: End block ${endBlock} equals start block ${startBlock} for ${networkName}. This means no time has passed between timestamps, indicating a date calculation error.`;
        logger.error(error);
        throw new Error(error);
      }
    }
    
    logger.info(`Chain ID to network mapping: ${JSON.stringify(chainIdToNetwork)}`);
    
    const supportedChainIds = getSupportedChainIds();
    logger.info(`Supported chain IDs: ${supportedChainIds.join(', ')}`);
    
    const cursorMap = new Map(cursors.map(c => [c.chain_id, c]));
    logger.info(`Progress cursors found for chains: ${cursors.map(c => `${c.chain_id}(${c.chain_name})`).join(', ')}`);

    const endBlocksForStorage: Record<number, {block: number, timestamp: Date}> = {};
    const endOfDay = new Date(endOfDayISO);
    
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
        logger.info(`ℹ️ No end block found for chain ${chainId} (${cursor.chain_name}) - network: ${networkName} (chain not active on ${dateString})`);
        continue;
      }
      
      const endBlock = endBlocks[networkName];
      logger.info(`✓ End block found: ${endBlock} for network ${networkName}`);
      endBlocksForStorage[chainId] = { block: endBlock, timestamp: endOfDay };
      
      const deploymentInfo = Object.values(DEPLOYMENT_INFO.CHAIN_DEPLOYMENTS).find(info => info.chainId === chainId);
      if (!deploymentInfo) {
        logger.warn(`❌ No deployment info found for chain ${chainId}`);
        continue;
      }
      logger.info(`✓ Deployment info: earliest date=${deploymentInfo.earliestDate}, earliest block=${deploymentInfo.earliestBlock}`);
      
      let lastProcessedBlock = cursor.last_processed_block;
      logger.info(`Initial last processed block: ${lastProcessedBlock} (type: ${typeof lastProcessedBlock})`);
      
      lastProcessedBlock = Number(lastProcessedBlock);
      logger.info(`Converted to number: ${lastProcessedBlock}`);
      
      if (lastProcessedBlock < deploymentInfo.earliestBlock) {
        lastProcessedBlock = deploymentInfo.earliestBlock - 1;
        logger.info(`Adjusted last processed block to ${lastProcessedBlock} (deployment earliest - 1)`);
      }
      
      const fromBlock = lastProcessedBlock + 1;
      logger.info(`Calculated fromBlock: ${fromBlock} (should be ${lastProcessedBlock} + 1)`);
      
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
        dateString,
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
   * Gets progress cursors for all chains
   */
  private async getProgressCursors(): Promise<ProgressCursor[]> {
    return await this.db('progress_cursors')
      .select('*')
      .orderBy('chain_id');
  }

  /**
   * Formats a date value to YYYY-MM-DD string
   */
  private formatDateForProcessing(dateValue: any): string {
    if (dateValue instanceof Date) {
      return dateValue.toISOString().split('T')[0];
    }
    if (typeof dateValue === 'string') {
      const parsed = new Date(dateValue);
      return parsed.toISOString().split('T')[0];
    }
    throw new Error(`Invalid date value: ${dateValue}`);
  }

  /**
   * Gets the earliest last_processed_date from all cursors
   */
  private async getEarliestCursorDate(): Promise<string> {
    const result = await this.db('progress_cursors')
      .whereNotNull('last_processed_date')
      .orderBy('last_processed_date', 'asc')
      .select('last_processed_date')
      .first();
    
    if (!result) {
      logger.warn('No cursor dates found, falling back to hardcoded start date');
      return DEPLOYMENT_INFO.OVERALL_START_DATE;
    }
    
    return this.formatDateForProcessing(result.last_processed_date);
  }

  /**
   * Updates progress cursors after successful processing
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
   * Stores block timestamps for the processed date
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
   * Gets the latest block numbers for all chains
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
   * Detects if there's a partially processed day
   */
  private async detectPartiallyProcessedDay(): Promise<string | null> {
    logger.info('Checking for partially processed days...');
    
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
   * Cleans up partially processed data for a specific date
   */
  private async cleanupPartiallyProcessedDay(dateString: string): Promise<void> {
    logger.info(`Starting cleanup of partially processed day: ${dateString}`);
    
    await this.db.transaction(async (trx) => {
      await this.resetBalancesToPreviousDay(dateString, trx);
      
      const deletedEvents = await trx('daily_events')
        .where('event_date', dateString)
        .del();
      logger.info(`Deleted ${deletedEvents} daily_events records for ${dateString}`);
      
      const deletedIntegrationEvents = await trx('daily_integration_events')
        .where('event_date', dateString)
        .del();
      logger.info(`Deleted ${deletedIntegrationEvents} daily_integration_events records for ${dateString}`);
      
      const deletedUserSnapshots = await trx('user_daily_snapshots')
        .where('snapshot_date', dateString)
        .del();
      logger.info(`Deleted ${deletedUserSnapshots} user_daily_snapshots records for ${dateString}`);
      
      const deletedProtocolSnapshot = await trx('daily_snapshots')
        .where('snapshot_date', dateString)
        .del();
      logger.info(`Deleted ${deletedProtocolSnapshot} daily_snapshots record for ${dateString}`);
    });
    
    logger.info(`Cleanup completed for ${dateString}`);
  }

  /**
   * Resets share_balances and integration_balances back to their previous day's state
   */
  private async resetBalancesToPreviousDay(dateString: string, trx?: any): Promise<void> {
    logger.info(`Resetting balances to previous day state for date: ${dateString}`);
    
    const currentDate = new Date(dateString);
    const previousDate = new Date(currentDate);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateString = previousDate.toISOString().split('T')[0];
    
    logger.info(`Previous day: ${previousDateString}`);
    
    const db = trx || this.db;
    
    const eventsExist = await db('daily_events')
      .where('event_date', dateString)
      .first();
    
    const shareBalancesToReset: any[] = await db('share_balances')
      .where('last_updated_date', dateString)
      .select('*');

    logger.info(`Found ${shareBalancesToReset.length} share_balances marked with ${dateString}`);

    if (eventsExist && shareBalancesToReset.length === 0) {
      logger.warn(`Found events for ${dateString} but no share_balances were updated. Assuming processing halted before BalanceTracker stage.`);
    }

    let shareDeltas = new Map<string, bigint>();
    if (shareBalancesToReset.length > 0) {
      shareDeltas = await this.computeShareDeltasForDate(dateString, db);
    }

    if (shareBalancesToReset.length > 0) {
      const balanceIds = shareBalancesToReset.map((balance: any) => balance.id);
      const addresses = [...new Set(shareBalancesToReset.map((balance: any) => balance.address.toLowerCase()))];

      logger.info(`Deleting ${balanceIds.length} share_balances to restore previous snapshot state`);
      await db('share_balances')
        .whereIn('id', balanceIds)
        .del();

      let snapshotMap = new Map<string, any>();

      if (addresses.length > 0) {
        const previousSnapshots = await db('user_daily_snapshots')
          .where('snapshot_date', previousDateString)
          .whereIn('address', addresses);

        snapshotMap = new Map(previousSnapshots.map((snapshot: any) => [snapshot.address.toLowerCase(), snapshot]));
      }

      for (const balance of shareBalancesToReset) {
        const snapshot = snapshotMap.get(balance.address.toLowerCase());

        if (snapshot) {
          const assetKey = `${balance.asset.toLowerCase()}_shares_total`;
          const previousShares = BigInt(snapshot[assetKey] || '0');

          await db('share_balances').insert({
            address: balance.address.toLowerCase(),
            asset: balance.asset,
            shares: previousShares.toString(),
            underlying_assets: balance.underlying_assets || null,
            last_update_block: balance.last_update_block,
            last_updated: new Date(snapshot.snapshot_timestamp),
            last_updated_date: previousDateString,
          });

          logger.info(`Rebuilt share_balance for ${balance.address} ${balance.asset} -> ${previousShares.toString()} from snapshot ${previousDateString}`);
        } else {
          logger.info(`No snapshot found for ${balance.address} ${balance.asset}; skipping balance reconstruction`);
        }
      }
    }

    if (shareBalancesToReset.length > 0) {
      await this.validateShareBalanceReconstruction(previousDateString, dateString, shareDeltas, db);
    } else {
      logger.info(`Skipping share balance reconstruction validation for ${dateString} (no share balances were updated).`);
    }
    
    const integrationBalancesToReset = await db('integration_balances')
      .where('last_updated_date', dateString);
    
    logger.info(`Found ${integrationBalancesToReset.length} integration_balances to reset`);
    
    for (const balance of integrationBalancesToReset) {
      const previousSnapshot = await db('user_daily_snapshots')
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
        
        await db('integration_balances')
          .where('id', balance.id)
          .update({
            position_shares: previousIntegrationBalance,
            last_updated_date: previousDateString,
            last_updated: new Date(previousSnapshot.snapshot_timestamp),
          });
        
        logger.info(`Reset integration_balance for ${balance.address} ${balance.protocol_name}: ${balance.position_shares} -> ${previousIntegrationBalance}`);
      } else {
        await db('integration_balances')
          .where('id', balance.id)
          .del();
        
        logger.info(`Deleted integration_balance for new user ${balance.address} ${balance.protocol_name}`);
      }
    }
    
    logger.info(`Balance reset completed for ${dateString}`);
  }

  private async computeShareDeltasForDate(dateString: string, db: any): Promise<Map<string, bigint>> {
    logger.info(`Computing share balance deltas for ${dateString}`);

    const events = await db('daily_events')
      .where('event_date', dateString)
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    const deltas = new Map<string, bigint>();

    const applyDelta = (address: string | null, asset: string, delta: bigint) => {
      if (!address || !asset || delta === 0n) {
        return;
      }

      const normalizedAddress = address.toLowerCase();
      const key = `${normalizedAddress}:${asset}`;
      const existing = deltas.get(key) || 0n;
      deltas.set(key, existing + delta);
    };

    for (const event of events) {
      const {
        event_type: eventType,
        from_address: rawFrom,
        to_address: rawTo,
        amount_delta: amountDeltaRaw,
        asset,
        isIntegrationAddress,
        round,
      } = event;

      const fromAddress = rawFrom ? rawFrom.toLowerCase() : null;
      const toAddress = rawTo ? rawTo.toLowerCase() : null;
      const amountDeltaString = amountDeltaRaw?.toString();

      if (!asset || !amountDeltaString) {
        continue;
      }

      if (isIntegrationAddress) {
        const delta = BigInt(amountDeltaString);

        switch (isIntegrationAddress) {
          case 'from':
          case 'silo_pending_from':
            if (toAddress) {
              applyDelta(toAddress, asset, delta);
            }
            break;
          case 'to':
          case 'silo_pending_to':
            if (fromAddress) {
              applyDelta(fromAddress, asset, -delta);
            }
            break;
          case 'shadow_to':
          case 'shadow_pending_to':
            if (fromAddress) {
              applyDelta(fromAddress, asset, -delta);
            }
            break;
          case 'shadow_from':
          case 'shadow_pending_from':
            if (toAddress) {
              applyDelta(toAddress, asset, delta);
            }
            break;
          case 'siloRouter':
            break;
        }

        continue;
      }

      switch (eventType) {
        case 'redeem': {
          if (fromAddress) {
            applyDelta(fromAddress, asset, BigInt(amountDeltaString));
          }
          break;
        }
        case 'unstake': {
          if (fromAddress) {
            const sharesDelta = await this.calculateUnstakeShareDelta(asset, amountDeltaString, round);
            applyDelta(fromAddress, asset, sharesDelta);
          }
          break;
        }
        case 'transfer': {
          const transferAmount = BigInt(amountDeltaString);
          if (fromAddress) {
            applyDelta(fromAddress, asset, -transferAmount);
          }
          if (toAddress) {
            applyDelta(toAddress, asset, transferAmount);
          }
          break;
        }
        default:
          break;
      }
    }

    logger.info(`Computed ${deltas.size} share delta entries for ${dateString}`);
    return deltas;
  }

  private async calculateUnstakeShareDelta(asset: string, amountDelta: string, round: any): Promise<bigint> {
    if (round === null || round === undefined) {
      return BigInt(amountDelta);
    }

    const roundBigInt = typeof round === 'bigint' ? round : BigInt(round);
    const { pricePerShare, ppsScale } = await this.getPricePerShare(asset, roundBigInt);

    const unsignedAmount = amountDelta.startsWith('-') ? amountDelta.slice(1) : amountDelta;
    const underlyingAssets = BigInt(unsignedAmount);
    const ppsScaleFactor = 10n ** ppsScale;

    const sharesAmount = (underlyingAssets * ppsScaleFactor) / pricePerShare;
    return amountDelta.startsWith('-') ? -sharesAmount : sharesAmount;
  }

  private async validateShareBalanceReconstruction(
    previousDateString: string,
    dateString: string,
    shareDeltas: Map<string, bigint>,
    db: any,
  ): Promise<void> {
    if (shareDeltas.size === 0) {
      logger.info(`No share deltas detected for ${dateString}; skipping validation.`);
      return;
    }

    const deltaPairs = Array.from(shareDeltas.keys()).map((key) => {
      const [address, asset] = key.split(':');
      return [address, asset] as [string, string];
    });

    let currentBalances: any[] = [];
    if (deltaPairs.length > 0) {
      currentBalances = await db('share_balances')
        .whereIn(['address', 'asset'], deltaPairs)
        .select('address', 'asset', 'shares');
    }

    const balanceMap = new Map<string, bigint>();
    for (const balance of currentBalances) {
      const key = `${balance.address.toLowerCase()}:${balance.asset}`;
      balanceMap.set(key, BigInt(balance.shares));
    }

    const negativeFindings: Array<{ address: string; asset: string; delta: bigint; reconstructed: bigint }> = [];

    for (const [key, delta] of shareDeltas.entries()) {
      const [address, asset] = key.split(':');
      const reconstructedShares = balanceMap.get(key) || 0n;

      if (reconstructedShares + delta < 0n) {
        negativeFindings.push({
          address,
          asset,
          delta,
          reconstructed: reconstructedShares,
        });
      }
    }

    if (negativeFindings.length > 0) {
      const details = negativeFindings
        .map((finding) => `address=${finding.address}, asset=${finding.asset}, delta=${finding.delta.toString()}, reconstructedShares=${finding.reconstructed.toString()}`)
        .join('; ');
      const errorMsg = `Negative balance risk detected while rolling back ${dateString} (previous day ${previousDateString}): ${details}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    logger.info(`Validated ${shareDeltas.size} share deltas for ${dateString}; no negative balances detected after reconstruction.`);
  }

  private async getPricePerShare(assetSymbol: string, round: bigint): Promise<{ pricePerShare: bigint; ppsScale: bigint }> {
    const contractConfig = CONTRACTS[assetSymbol as keyof typeof CONTRACTS];
    if (!contractConfig) {
      throw new Error(`No contract config found for asset ${assetSymbol}`);
    }

    if (!this.alchemyService) {
      this.alchemyService = AlchemyService.getInstance();
    }

    const viemEthClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);

    const pricePerShareRound = round > 1n ? round - 1n : 1n;

    const pricePerShare = await withAlchemyRetry(async () => {
      return await viemEthClient.readContract({
        address: contractConfig.ethereum as `0x${string}`,
        abi: STREAM_VAULT_ABI,
        functionName: 'roundPricePerShare',
        args: [pricePerShareRound],
      }) as bigint;
    }, `${assetSymbol} vault price per share for round ${pricePerShareRound}`);

    return {
      pricePerShare,
      ppsScale: contractConfig.ppsScale,
    };
  }

  /**
   * Starts real-time processing
   */
  private async startRealtimeProcessing(): Promise<void> {
    logger.info('Starting real-time processing mode...');
    
    await this.checkAndRunLiveFill();
    
    const checkInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(checkInterval);
        return;
      }
      
      const now = new Date();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      if (hours === CONSTANTS.LIVE_FILL_TIME.HOURS && minutes === CONSTANTS.LIVE_FILL_TIME.MINUTES) {
        try {
          await this.checkAndRunLiveFill();
        } catch (error) {
          logger.error('Error during scheduled live fill:', error);
        }
      }
    }, 1000);
    
    logger.info('Real-time processing loop started');
  }

  /**
   * Checks if live fill needs to run and executes it
   */
  private async checkAndRunLiveFill(): Promise<void> {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayString = yesterday.toISOString().split('T')[0];
    
    const existingSnapshot = await this.db('daily_snapshots')
      .where('snapshot_date', yesterdayString)
      .first();
    
    if (existingSnapshot) {
      return;
    }
    
    await this.runLiveFill(yesterdayString);
  }

  /**
   * Runs live fill for a specific date
   * Live fill is essentially backfill for yesterday's date, so it uses the same block range calculation
   */
  private async runLiveFill(dateString: string): Promise<void> {
    logger.info(`Starting live fill for date: ${dateString}`);
    
    try {
      await this.validateBackfillStatus(dateString);
      
      const processingDate = new Date(dateString + 'T00:00:00.000Z');
      const { blockRanges, endBlocks } = await this.calculateBlockRanges(processingDate);
      
      if (blockRanges.length === 0) {
        logger.warn(`No block ranges found for live fill on ${dateString}, skipping`);
        return;
      }
      
      await this.dailySnapshotService.processDailySnapshot(dateString, blockRanges);
      
      await this.updateProgressCursors(blockRanges, dateString);
      
      await this.storeBlockTimestamps(dateString, endBlocks);
      
      logger.info(`Live fill completed successfully for ${dateString}`);
      
    } catch (error) {
      logger.error(`Live fill failed for ${dateString}:`, error);
      throw error;
    }
  }

  /**
   * Validates that backfill is up to date
   */
  private async validateBackfillStatus(targetDateString: string): Promise<void> {
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
    
    if (daysDifference > 1) {
      logger.warn(`Gap detected between last snapshot (${lastSnapshot.snapshot_date}) and target date (${targetDateString}). Running backfill to catch up...`);
      await this.runBackfill();
    }
  }


  /**
   * Gets system status
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
