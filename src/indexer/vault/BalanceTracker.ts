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
   * Then updates underlying assets using price per share from ETH vault contracts
   */
  async processEventsFromDatabase(
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info(`Processing events for ${blockRanges.length} chains`);
    
    // Initialize balance cache for this processing session
    this.balanceCache.clear();
    
    // Find ETH chain block range to use for PPS calculations
    const ethRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.ETHEREUM);
    
    let totalEventsProcessed = 0;
    
    // Process each chain's events
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
            .orWhere('isIntegrationAddress', 'shadow_from');
        })
        .orderBy('block_number')
        .orderBy('tx_hash')
        .orderBy('log_index');
      
      logger.info(`Found ${events.length} events for chain ${range.chainId}`);
      
      // Process each event
      for (const event of events) {
        await this.processEvent(event);
      }
      
      totalEventsProcessed += events.length;
      logger.info(`Completed processing ${events.length} events for chain ${range.chainId}`);
    }
    
    logger.info(`Processed ${totalEventsProcessed} total events across all chains`);
    
    // Validate all balance changes before committing
    await this.validateAndCommitBalanceChanges();
    
    // Update underlying assets using ETH block if available, otherwise use cached PPS
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
    
    // Handle integration events with special rules
    if (isIntegrationAddress) {
      await this.processIntegrationEvent(event);
      return;
    }
    
    // Handle normal events
    switch (event_type) {
      case 'redeem':
        if (from_address) {
          await this.updateShareBalance(from_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
        
      case 'unstake':
        if (from_address) {
          // For unstake events, we need to convert underlying asset amount back to shares
          if (round !== null && round !== undefined) {
            logger.info(`Processing unstake event with underlying assets conversion`, {
              user: from_address,
              asset,
              underlyingAssets: amount_delta,
              round: round.toString(),
              chainId: chain_id
            });
            
            // Get price per share for the round when this unstake happened
            const { pricePerShare, ppsScale } = await this.getPricePerShare(asset, BigInt(round));
            
            // Convert underlying asset amount back to shares
            const underlyingAssets = BigInt(amount_delta.toString().replace('-', '')); // Remove negative sign
            const ppsScaleFactor = 10n ** ppsScale; 
            const sharesAmount = (underlyingAssets * ppsScaleFactor) / pricePerShare;
            const sharesDelta = `-${sharesAmount.toString()}`; // Make it negative for balance deduction
            
            logger.info(`Converted underlying assets to shares`, {
              underlyingAssets: underlyingAssets.toString(),
              pricePerShare: pricePerShare.toString(),
              ppsScale: ppsScale.toString(),
              calculatedShares: sharesAmount.toString(),
              sharesDelta
            });
            
            await this.updateShareBalance(from_address, asset, sharesDelta, block_number, timestamp, event_date);
          } else {
            // Fallback to treating as share amount if no round information (legacy events or data migration)
            logger.warn(`Unstake event without round information, treating as shares`, {
              user: from_address,
              asset,
              amount_delta,
              round: round,
              chainId: chain_id
            });
            await this.updateShareBalance(from_address, asset, amount_delta, block_number, timestamp, event_date);
          }
        }
        break;
        
      case 'transfer':
        if (from_address && to_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;

      case 'oft_sent':
        // OFT sent event - tokens are burned from sender's balance
        if (from_address) {
          await this.updateShareBalance(from_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;

      case 'oft_received':
        // OFT received event - tokens are minted to recipient's balance  
        if (to_address) {
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
      return; // Only process transfer events for integrations
    }
    
    switch (isIntegrationAddress) {
      case 'from':
        if (to_address) {
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
        
      case 'to':
        if (from_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
        }
        break;
        
      case 'shadow_to':
        // Shadow contract is receiving tokens - subtract from user balance
        if (from_address) {
          await this.updateShareBalance(from_address, asset, `-${amount_delta}`, block_number, timestamp, event_date);
        }
        break;
        
      case 'shadow_from':
        // Shadow contract is sending tokens - add to user balance  
        if (to_address) {
          await this.updateShareBalance(to_address, asset, amount_delta, block_number, timestamp, event_date);
        }
        break;
    }
  }

  /**
   * Updates share balance for a user based on amount delta (consolidated across all chains)
   * Now uses in-memory cache to accumulate changes before database commit
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
    
    // Get or create cache entry
    let balanceChange = this.balanceCache.get(cacheKey);
    
    if (!balanceChange) {
      // Load current balance from database
      const currentBalance = await this.db('share_balances')
        .where({
          address: userAddress,
          asset: asset,
        })
        .first();
      
      const currentShares = currentBalance ? BigInt(currentBalance.shares) : 0n;
      
      // Initialize cache entry
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
    
    // Apply the delta to the final shares
    balanceChange.finalShares += deltaAmount;
    
    // Update metadata with latest event info
    if (blockNumber > balanceChange.lastUpdateBlock) {
      balanceChange.lastUpdateBlock = blockNumber;
      balanceChange.lastUpdated = timestamp;
      balanceChange.lastUpdatedDate = updateDate;
    }
  }

  /**
   * Validates all cached balance changes and commits them to database if no negative balances found
   */
  private async validateAndCommitBalanceChanges(): Promise<void> {
    logger.info(`Validating ${this.balanceCache.size} cached balance changes`);
    
    const negativeBalances: BalanceChange[] = [];
    
    // Check for negative final balances
    for (const balanceChange of this.balanceCache.values()) {
      if (balanceChange.finalShares < 0n) {
        negativeBalances.push(balanceChange);
        logger.error(`CRITICAL: Negative balance detected after processing all events. User: ${balanceChange.address}, Asset: ${balanceChange.asset}, Current: ${balanceChange.currentShares}, Final: ${balanceChange.finalShares}`);
      }
    }
    
    // If any negative balances found, throw error
    if (negativeBalances.length > 0) {
      const errorMsg = `Found ${negativeBalances.length} negative balances after processing all daily events. This indicates missing transfers or incorrect event ordering.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    // All balances are valid, commit changes to database
    logger.info(`All balance changes are valid, committing to database`);
    
    let updatedCount = 0;
    let insertedCount = 0;
    let deletedCount = 0;
    
    for (const balanceChange of this.balanceCache.values()) {
      const { address, asset, currentShares, finalShares, lastUpdateBlock, lastUpdated, lastUpdatedDate } = balanceChange;
      
      if (finalShares === 0n) {
        // Delete zero balances
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
        // Update or insert non-zero balances
        if (currentShares > 0n) {
          // Update existing balance
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
          // Insert new balance
          await this.db('share_balances').insert({
            address: address,
            asset: asset,
            shares: finalShares.toString(),
            underlying_assets: null, // Will be calculated later by updateUnderlyingAssets
            last_update_block: lastUpdateBlock,
            last_updated: lastUpdated,
            last_updated_date: lastUpdatedDate,
          });
          insertedCount++;
        }
      }
    }
    
    logger.info(`Balance changes committed: ${updatedCount} updated, ${insertedCount} inserted, ${deletedCount} deleted`);
    
    // Clear cache after successful commit
    this.balanceCache.clear();
  }

  /**
   * Gets price per share for a specific asset and round from the vault contract on Ethereum
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
    
    // Get price per share for the specified round with retry logic
    const pricePerShare = await withAlchemyRetry(async () => {
      const params: any = {
        address: contractConfig.ethereum as `0x${string}`,
        abi: STREAM_VAULT_ABI,
        functionName: 'roundPricePerShare',
        args: [round]
      };
      
      return await viemEthClient.readContract(params) as bigint;
    }, `${assetSymbol} vault price per share for round ${round}`);
    
    logger.info(`${assetSymbol} price per share for round ${round}: ${pricePerShare.toString()} (scale: ${contractConfig.ppsScale.toString()})`);
    
    return {
      pricePerShare,
      ppsScale: contractConfig.ppsScale
    };
  }

  /**
   * Updates underlying asset values for all share balances by fetching price per share from vault contracts
   */
  private async updateUnderlyingAssets(blockNumber: number): Promise<void> {
    logger.info(`Updating underlying assets at ETH block ${blockNumber}`);
    
    try {
      // Get viem client for Ethereum
      const viemEthClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
      
      // Process each vault asset
      for (const [assetSymbol, contractConfig] of Object.entries(CONTRACTS)) {
        logger.info(`Processing ${assetSymbol} vault at ${contractConfig.ethereum}`);
        
        try {
          // Get current round at block from vault with retry logic
          const currentRound = await withAlchemyRetry(async () => {
            return await viemEthClient.readContract({
              address: contractConfig.ethereum as `0x${string}`,
              abi: STREAM_VAULT_ABI,
              functionName: 'round',
              blockNumber: BigInt(blockNumber)
            }) as bigint;
          }, `${assetSymbol} vault round at block ${blockNumber}`);
          
          logger.info(`${assetSymbol} current round: ${currentRound.toString()}`);
          
          // Get price per share for current round using the extracted function
          const { pricePerShare, ppsScale } = await this.getPricePerShare(assetSymbol, currentRound);
          
          // Get all share balances for this asset
          const shareBalances = await this.db('share_balances')
            .where('asset', assetSymbol)
            .whereNotNull('shares');
          
          // Update each balance with underlying assets calculation
          for (const balance of shareBalances) {
            const shares = BigInt(balance.shares);
            const ppsScaleFactor = 10n ** ppsScale; // Convert ppsScale to actual scale factor (10^ppsScale)
            const underlyingAssets = (shares * pricePerShare) / ppsScaleFactor;
            
            await this.db('share_balances')
              .where('id', balance.id)
              .update({
                underlying_assets: underlyingAssets.toString(),
              });
          }
          
          logger.info(`Updated ${shareBalances.length} ${assetSymbol} share balances with underlying assets`);
          
          // Store/update price per share in cache
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
          
          // Check if this is a contract not deployed error
          if (errorMessage.includes('returned no data ("0x")') || 
              errorMessage.includes('contract does not have the function') ||
              errorMessage.includes('address is not a contract')) {
            logger.warn(`${assetSymbol} vault skipped because contract is not deployed`);
            continue;
          }
          
          // For other errors, rethrow to maintain existing error handling behavior
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
   * Updates underlying asset values using cached price per share from database
   */
  private async updateUnderlyingAssetsFromDB(): Promise<void> {
    logger.info('Updating underlying assets using cached price per share from database');
    
    try {
      // Get all cached price per share data
      const cachedPpsData = await this.db('price_per_share_cache')
        .select('asset', 'current_price_per_share');
      
      if (cachedPpsData.length === 0) {
        logger.warn('No cached price per share data found - this should not happen after initial ETH processing');
        return;
      }
      
      // Process each asset
      for (const ppsData of cachedPpsData) {
        const assetSymbol = ppsData.asset;
        const pricePerShare = BigInt(ppsData.current_price_per_share);
        const contractConfig = CONTRACTS[assetSymbol as keyof typeof CONTRACTS];
        
        if (!contractConfig) {
          logger.warn(`No contract config found for asset ${assetSymbol}`);
          continue;
        }
        
        logger.info(`Processing ${assetSymbol} with cached PPS: ${pricePerShare.toString()}`);
        
        // Get all share balances for this asset
        const shareBalances = await this.db('share_balances')
          .where('asset', assetSymbol)
          .whereNotNull('shares');
        
        // Update each balance with underlying assets calculation
        for (const balance of shareBalances) {
          const shares = BigInt(balance.shares);
          const ppsScaleFactor = 10n ** contractConfig.ppsScale; // Convert ppsScale to actual scale factor (10^ppsScale)
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