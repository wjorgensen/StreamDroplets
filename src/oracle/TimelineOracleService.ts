import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, AssetType } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('TimelineOracleService');

export interface PriceSnapshot {
  id?: number;
  asset: AssetType;
  chain_id: number;
  block_number: bigint;
  timestamp: Date;
  price_usd: string;
  oracle_scale: number;
  oracle_source: 'chainlink' | 'fallback';
  created_at?: Date;
}

export interface OraclePriceTimeline {
  id?: number;
  asset: AssetType;
  chain_id: number;
  block_number: bigint;
  timestamp: Date;
  price_usd: string;
  chainlink_round_id?: string;
  updated_at_block?: bigint;
  oracle_updated_at?: Date;
  source: 'chainlink' | 'fallback' | 'historical';
  created_at?: Date;
}

export class TimelineOracleService {
  private db = getDb();
  private client;
  
  constructor() {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(config.rpc.ethereum),
    });
  }
  
  /**
   * Get USD price at a specific block number
   */
  async getPriceAtBlock(
    asset: AssetType, 
    blockNumber: bigint,
    _chainId: number = CONSTANTS.CHAIN_IDS.ETHEREUM
  ): Promise<bigint> {
    // Check if we already have this price
    const existing = await this.db('oracle_prices_timeline')
      .where({
        asset,
        chain_id: chainId,
        block_number: blockNumber.toString()
      })
      .first();
    
    if (existing) {
      return BigInt(existing.price_usd);
    }
    
    // Fetch from Chainlink
    const price = await this.fetchPriceAtBlock(asset, blockNumber);
    
    // Store in database
    await this.storePriceTimeline({
      asset,
      chain_id: chainId,
      block_number: blockNumber,
      timestamp: new Date(), // This should be the block timestamp
      price_usd: price.toString(),
      source: 'chainlink'
    });
    
    return price;
  }
  
  /**
   * Get price for a time range (for integration calculations)
   */
  async getPriceForInterval(
    asset: AssetType,
    startTime: Date,
    endTime: Date,
    _chainId: number = CONSTANTS.CHAIN_IDS.ETHEREUM
  ): Promise<bigint> {
    // Find the closest price snapshot in the interval
    const price = await this.db('oracle_prices_timeline')
      .where({ asset, chain_id: chainId })
      .whereBetween('timestamp', [startTime, endTime])
      .orderBy('timestamp', 'desc')
      .first();
    
    if (price) {
      return BigInt(price.price_usd);
    }
    
    // If no price in interval, get the latest before the interval
    const latestPrice = await this.db('oracle_prices_timeline')
      .where({ asset, chain_id: _chainId })
      .where('timestamp', '<=', endTime)
      .orderBy('timestamp', 'desc')
      .first();
    
    if (latestPrice) {
      return BigInt(latestPrice.price_usd);
    }
    
    // Fallback to current price
    return this.getCurrentPrice(asset, chainId);
  }
  
  /**
   * Get current USD price
   */
  async getCurrentPrice(
    asset: AssetType,
    _chainId: number = 1
  ): Promise<bigint> {
    try {
      const contractConfig = CONTRACTS[asset];
      if (!contractConfig || !contractConfig.oracleFeed) {
        throw new Error(`No oracle feed configured for ${asset}`);
      }
      
      const aggregatorAddress = contractConfig.oracleFeed as `0x${string}`;
      
      const latestData = await this.client.readContract({
        address: aggregatorAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      });
      
      const [, answer] = latestData as [bigint, bigint, bigint, bigint, bigint];
      return answer;
      
    } catch (error) {
      logger.error(`Error fetching current price for ${asset}:`, error);
      return 0n; // Fallback price
    }
  }
  
  /**
   * Fetch historical price at specific block
   */
  private async fetchPriceAtBlock(
    asset: AssetType,
    blockNumber: bigint
  ): Promise<bigint> {
    try {
      const contractConfig = CONTRACTS[asset];
      if (!contractConfig || !contractConfig.oracleFeed) {
        throw new Error(`No oracle feed configured for ${asset}`);
      }
      
      const aggregatorAddress = contractConfig.oracleFeed as `0x${string}`;
      
      // Try to get the price at the specific block
      const latestData = await this.client.readContract({
        address: aggregatorAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: 'latestRoundData',
        blockNumber: blockNumber,
      });
      
      const [, answer] = latestData as [bigint, bigint, bigint, bigint, bigint];
      return answer;
      
    } catch (error) {
      logger.error(`Error fetching historical price for ${asset} at block ${blockNumber}:`, error);
      throw new Error(`Failed to fetch Chainlink price for ${asset} at block ${blockNumber}: ${error}`);
    }
  }
  
  
  /**
   * Store price snapshot in database
   */
  private async _storePriceSnapshot(snapshot: PriceSnapshot): Promise<void> {
    try {
      await this.db('price_snapshots').insert(snapshot);
    } catch (error: any) {
      if (error.code === '23505') {
        logger.debug(`Price snapshot already exists for ${snapshot.asset} at block ${snapshot.block_number}`);
      } else {
        logger.error('Error storing price snapshot:', error);
      }
    }
  }
  
  /**
   * Store price in timeline table
   */
  private async storePriceTimeline(price: OraclePriceTimeline): Promise<void> {
    try {
      await this.db('oracle_prices_timeline').insert(price);
    } catch (error: any) {
      if (error.code === '23505') {
        logger.debug(`Price already exists for ${price.asset} at block ${price.block_number}`);
      } else {
        logger.error('Error storing price timeline:', error);
      }
    }
  }
  
  /**
   * Pre-fetch and cache price history for a date range
   */
  async prefetchPriceHistory(
    asset: AssetType,
    startDate: Date,
    endDate: Date,
    _chainId: number = CONSTANTS.CHAIN_IDS.ETHEREUM
  ): Promise<void> {
    logger.info(`Prefetching price history for ${asset} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // This would implement historical price fetching
    // For now, just get current price as placeholder
    const currentPrice = await this.getCurrentPrice(asset, chainId);
    
    // Store with current timestamp (in production, you'd fetch historical data)
    await this.storePriceTimeline({
      asset,
      chain_id: chainId,
      block_number: 0n, // Would be actual block number
      timestamp: new Date(),
      price_usd: currentPrice.toString(),
      source: 'historical'
    });
  }
  
  /**
   * Validate oracle price staleness
   */
  async validatePriceStaleness(
    asset: AssetType,
    maxAgeSeconds: number = 3600 // 1 hour
  ): Promise<boolean> {
    const latestPrice = await this.db('oracle_prices_timeline')
      .where({ asset })
      .orderBy('timestamp', 'desc')
      .first();
    
    if (!latestPrice) {
      return false;
    }
    
    const age = Date.now() - new Date(latestPrice.timestamp).getTime();
    const isStale = age > (maxAgeSeconds * 1000);
    
    if (isStale) {
      logger.warn(`Price for ${asset} is ${age / 1000} seconds old`);
    }
    
    return !isStale;
  }
}

// Import CHAINLINK_AGGREGATOR_ABI from contracts
const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

// Import CONTRACTS from contracts file
import { CONTRACTS } from '../config/contracts';
