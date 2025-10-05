import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';
import { CONTRACTS } from '../../config/contracts';
import { STREAM_VAULT_ABI } from '../../config/abis/streamVault';
import { BlockRange, CONSTANTS } from '../../config/constants';
import { AlchemyService } from '../../utils/AlchemyService';
import EventEmitter from 'events';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('BalanceTracker');

interface BalanceChange {
  address: string;
  asset: string;
  currentShares: bigint; // What's currently in DB
  finalShares: bigint;   // What it will be after all deltas
  lastUpdateBlock: number;
  lastUpdated: Date;
  lastUpdatedDate: string;
}

export class BalanceTracker extends EventEmitter {
  private db = getDb();
  private alchemyService: AlchemyService;
  private balanceCache: Map<string, BalanceChange> = new Map();

  constructor() {
    super();
    this.alchemyService = AlchemyService.getInstance();
  }

  /**
   * Processes daily events from database for multiple chains and updates share balances
   */
  async processEventsFromDatabase(
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info(`Processing events for ${blockRanges.length} chains`);
    
    this.balanceCache.clear();
    
    const ethRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.ETHEREUM);
    
    let totalEventsProcessed = 0;
    
    for (const range of blockRanges) {
      logger.info(`Processing chain ${range.chainId} from block ${range.fromBlock} to ${range.toBlock}`);
      
      const events = await this.db('daily_events')
        .where('chain_id', range.chainId)
        .whereBetween('block_number', [range.fromBlock, range.toBlock])
        .where(builder => {
          builder.whereNull('isIntegrationAddress')
            .orWhere('isIntegrationAddress', 'from')
            .orWhere('isIntegrationAddress', 'to')
            .orWhere('isIntegrationAddress', 'shadow_to')
            .orWhere('isIntegrationAddress', 'shadow_from')
            .orWhere('isIntegrationAddress', 'shadow_pending_to')
            .orWhere('isIntegrationAddress', 'shadow_pending_from')
            .orWhere('isIntegrationAddress', 'silo_pending_from')
            .orWhere('isIntegrationAddress', 'silo_pending_to');
        })
        .orderBy('block_number')
        .orderBy('tx_hash')
        .orderBy('log_index');
      
      logger.info(`Found ${events.length} events for chain ${range.chainId}`);
      
      for (const event of events) {
        await this.processEvent(event);
      }
      
      totalEventsProcessed += events.length;
      logger.info(`Completed processing ${events.length} events for chain ${range.chainId}`);
    }
    
    logger.info(`Processed ${totalEventsProcessed} total events across all chains`);
    
    await this.validateAndCommitBalanceChanges();
    
    if (ethRange) {
      logger.info(`Updating underlying assets using ETH block ${ethRange.toBlock}`);
      await this.updateUnderlyingAssets(ethRange.toBlock);
    } else {
      logger.info('No ETH range available, using cached price per share from database');
      await this.updateUnderlyingAssetsFromDB();
    }
  }
  
  /**
   * Processes a single event from daily_events table and updates share balances
   */
  private async processEvent(event: any): Promise<void> {
    const { event_type, from_address, to_address, amount_delta, asset, chain_id, block_number, timestamp, event_date, isIntegrationAddress, round } = event;
    
    if (isIntegrationAddress) {
      await this.processIntegrationEvent(event);
      return;
    }
    
    switch (event_type) {
      case 'redeem':
        if (from_address) {
          await this.updateShareBalance(from_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
        
      case 'unstake':
        if (from_address) {
          logger.info(`Processing unstake event with underlying assets conversion`, {
            user: from_address,
            asset,
            underlyingAssets: amount_delta,
            round: round.toString(),
            chainId: chain_id
          });
          
          const { pricePerShare, ppsScale } = await this.getPricePerShare(asset, BigInt(round));
          
          const underlyingAssets = BigInt(amount_delta.toString().replace('-', ''));
          const ppsScaleFactor = 10n ** ppsScale; 
          const sharesAmount = (underlyingAssets * ppsScaleFactor) / pricePerShare;
          const sharesDelta = `-${sharesAmount.toString()}`;
          
          logger.info(`Converted underlying assets to shares`, {
            underlyingAssets: underlyingAssets.toString(),
            pricePerShare: pricePerShare.toString(),
            ppsScale: ppsScale.toString(),
            calculatedShares: sharesAmount.toString(),
            sharesDelta
          });
          
          await this.updateShareBalance(from_address, asset, sharesDelta, block_number, timestamp, event_date);
        }
        break;
        
      case 'transfer':
        if (from_address && to_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;

    }
  }

  /**
   * Processes integration events with special balance update rules
   */
  private async processIntegrationEvent(event: any): Promise<void> {
    const { event_type, from_address, to_address, amount_delta, asset, block_number, timestamp, event_date, isIntegrationAddress } = event;
    
    if (event_type !== 'transfer') {
      return;
    }
    
    switch (isIntegrationAddress) {
      case 'from':
      case 'silo_pending_from':
        if (to_address) {
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
        
      case 'to':
      case 'silo_pending_to':
        if (from_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
        }
        break;
        
      case 'shadow_to':
      case 'shadow_pending_to':
        if (from_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
        }
        break;
        
      case 'shadow_from':
      case 'shadow_pending_from':
        if (to_address) {
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
        
      case 'siloRouter':
        break;
    }
  }

  /**
   * Updates share balance for a user based on amount delta
   */
  private async updateShareBalance(
    userAddress: string,
    asset: string,
    amountDelta: string,
    blockNumber: number,
    timestamp: Date,
    eventDate?: string
  ): Promise<void> {
    const cacheKey = `${userAddress}:${asset}`;
    const deltaAmount = BigInt(amountDelta);
    const updateDate = eventDate || timestamp.toISOString().split('T')[0];
    
    let balanceChange = this.balanceCache.get(cacheKey);
    
    if (!balanceChange) {
      const currentBalance = await this.db('share_balances')
        .where({
          address: userAddress,
          asset: asset,
        })
        .first();
      
      const currentShares = currentBalance ? BigInt(currentBalance.shares) : 0n;
      
      balanceChange = {
        address: userAddress,
        asset: asset,
        currentShares: currentShares,
        finalShares: currentShares,
        lastUpdateBlock: blockNumber,
        lastUpdated: timestamp,
        lastUpdatedDate: updateDate,
      };
      
      this.balanceCache.set(cacheKey, balanceChange);
    }
    
    balanceChange.finalShares += deltaAmount;
    
    if (blockNumber > balanceChange.lastUpdateBlock) {
      balanceChange.lastUpdateBlock = blockNumber;
      balanceChange.lastUpdated = timestamp;
      balanceChange.lastUpdatedDate = updateDate;
    }
  }

  /**
   * Validates all cached balance changes and commits them to database
   */
  private async validateAndCommitBalanceChanges(): Promise<void> {
    logger.info(`Validating ${this.balanceCache.size} cached balance changes`);
    
    const negativeBalances: BalanceChange[] = [];
    
    for (const balanceChange of this.balanceCache.values()) {
      if (balanceChange.finalShares < 0n) {
        negativeBalances.push(balanceChange);
        logger.error(`CRITICAL: Negative balance detected after processing all events. User: ${balanceChange.address}, Asset: ${balanceChange.asset}, Current: ${balanceChange.currentShares}, Final: ${balanceChange.finalShares}`);
      }
    }
    
    if (negativeBalances.length > 0) {
      const errorMsg = `Found ${negativeBalances.length} negative balances after processing all daily events. This indicates missing transfers or incorrect event ordering.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    logger.info(`All balance changes are valid, committing to database`);
    
    let updatedCount = 0;
    let insertedCount = 0;
    let deletedCount = 0;
    
    for (const balanceChange of this.balanceCache.values()) {
      const { address, asset, currentShares, finalShares, lastUpdateBlock, lastUpdated, lastUpdatedDate } = balanceChange;
      
      if (finalShares === 0n) {
        if (currentShares > 0n) {
          const deleteResult = await this.db('share_balances')
            .where({
              address: address,
              asset: asset,
            })
            .delete();
          
          if (deleteResult > 0) {
            deletedCount++;
          }
        }
      } else {
        if (currentShares > 0n) {
          await this.db('share_balances')
            .where({
              address: address,
              asset: asset,
            })
            .update({
              shares: finalShares.toString(),
              last_update_block: lastUpdateBlock,
              last_updated: lastUpdated,
              last_updated_date: lastUpdatedDate,
            });
          updatedCount++;
        } else {
          await this.db('share_balances').insert({
            address: address,
            asset: asset,
            shares: finalShares.toString(),
            underlying_assets: null,
            last_update_block: lastUpdateBlock,
            last_updated: lastUpdated,
            last_updated_date: lastUpdatedDate,
          });
          insertedCount++;
        }
      }
    }
    
    logger.info(`Balance changes committed: ${updatedCount} updated, ${insertedCount} inserted, ${deletedCount} deleted`);
    
    this.balanceCache.clear();
  }

  /**
   * Gets price per share for a specific asset and round from vault contract
   * Note: Always uses round - 1 because the current round's price per share is not finalized
   */
  private async getPricePerShare(
    assetSymbol: string, 
    round: bigint, 
  ): Promise<{ pricePerShare: bigint; ppsScale: bigint }> {
    const contractConfig = CONTRACTS[assetSymbol as keyof typeof CONTRACTS];
    if (!contractConfig) {
      throw new Error(`No contract config found for asset ${assetSymbol}`);
    }

    const viemEthClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
    
    const pricePerShareRound = round > 1n ? round - 1n : 1n;
    
    const pricePerShare = await withAlchemyRetry(async () => {
      const params: any = {
        address: contractConfig.ethereum as `0x${string}`,
        abi: STREAM_VAULT_ABI,
        functionName: 'roundPricePerShare',
        args: [pricePerShareRound]
      };
      
      return await viemEthClient.readContract(params) as bigint;
    }, `${assetSymbol} vault price per share for round ${pricePerShareRound}`);
    
    logger.info(`${assetSymbol} price per share for round ${pricePerShareRound} (current round: ${round}): ${pricePerShare.toString()} (scale: ${contractConfig.ppsScale.toString()})`);
    
    return {
      pricePerShare,
      ppsScale: contractConfig.ppsScale
    };
  }

  /**
   * Updates underlying asset values for all share balances from vault contracts
   */
  private async updateUnderlyingAssets(blockNumber: number): Promise<void> {
    logger.info(`Updating underlying assets at ETH block ${blockNumber}`);
    
    try {
      const viemEthClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
      
      for (const [assetSymbol, contractConfig] of Object.entries(CONTRACTS)) {
        logger.info(`Processing ${assetSymbol} vault at ${contractConfig.ethereum}`);
        
        try {
          const currentRound = await withAlchemyRetry(async () => {
            return await viemEthClient.readContract({
              address: contractConfig.ethereum as `0x${string}`,
              abi: STREAM_VAULT_ABI,
              functionName: 'round',
              blockNumber: BigInt(blockNumber)
            }) as bigint;
          }, `${assetSymbol} vault round at block ${blockNumber}`);
          
          logger.info(`${assetSymbol} current round: ${currentRound.toString()}`);
          
          const { pricePerShare, ppsScale } = await this.getPricePerShare(assetSymbol, currentRound);
          
          const shareBalances = await this.db('share_balances')
            .where('asset', assetSymbol)
            .whereNotNull('shares');
          
          for (const balance of shareBalances) {
            const shares = BigInt(balance.shares);
            const ppsScaleFactor = 10n ** ppsScale;
            const underlyingAssets = (shares * pricePerShare) / ppsScaleFactor;
            
            await this.db('share_balances')
              .where('id', balance.id)
              .update({
                underlying_assets: underlyingAssets.toString(),
              });
          }
          
          logger.info(`Updated ${shareBalances.length} ${assetSymbol} share balances with underlying assets`);
          
          await this.db('price_per_share_cache')
            .insert({
              asset: assetSymbol,
              current_price_per_share: pricePerShare.toString(),
              current_round: currentRound.toString(),
              last_update_block: blockNumber,
              last_updated: new Date(),
            })
            .onConflict('asset')
            .merge({
              current_price_per_share: pricePerShare.toString(),
              current_round: currentRound.toString(),
              last_update_block: blockNumber,
              last_updated: new Date(),
            });
          
        } catch (error) {
          const errorMessage = (error as Error).message;
          
          if (errorMessage.includes('returned no data ("0x")') || 
              errorMessage.includes('contract does not have the function') ||
              errorMessage.includes('address is not a contract')) {
            logger.warn(`${assetSymbol} vault skipped because contract is not deployed`);
            continue;
          }
          
          logger.error(`Error processing ${assetSymbol} vault:`, error);
          throw error;
        }
      }
      
      logger.info('Completed updating underlying assets for all vaults');
    } catch (error) {
      logger.error('Error updating underlying assets:', error);
      throw error;
    }
  }

  /**
   * Updates underlying asset values using cached price per share
   */
  private async updateUnderlyingAssetsFromDB(): Promise<void> {
    logger.info('Updating underlying assets using cached price per share from database');
    
    try {
      const cachedPpsData = await this.db('price_per_share_cache')
        .select('asset', 'current_price_per_share');
      
      if (cachedPpsData.length === 0) {
        logger.warn('No cached price per share data found - this should not happen after initial ETH processing');
        return;
      }
      
      for (const ppsData of cachedPpsData) {
        const assetSymbol = ppsData.asset;
        const pricePerShare = BigInt(ppsData.current_price_per_share);
        const contractConfig = CONTRACTS[assetSymbol as keyof typeof CONTRACTS];
        
        if (!contractConfig) {
          logger.warn(`No contract config found for asset ${assetSymbol}`);
          continue;
        }
        
        logger.info(`Processing ${assetSymbol} with cached PPS: ${pricePerShare.toString()}`);
        
        const shareBalances = await this.db('share_balances')
          .where('asset', assetSymbol)
          .whereNotNull('shares');
        
        for (const balance of shareBalances) {
          const shares = BigInt(balance.shares);
          const ppsScaleFactor = 10n ** contractConfig.ppsScale;
          const underlyingAssets = (shares * pricePerShare) / ppsScaleFactor;
          
          await this.db('share_balances')
            .where('id', balance.id)
            .update({
              underlying_assets: underlyingAssets.toString(),
            });
        }
        
        logger.info(`Updated ${shareBalances.length} ${assetSymbol} share balances with cached underlying assets`);
      }
      
      logger.info('Completed updating underlying assets using cached data');
    } catch (error) {
      logger.error('Error updating underlying assets from DB:', error);
      throw error;
    }
  }

}
