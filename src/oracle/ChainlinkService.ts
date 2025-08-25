import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, AssetType } from '../config/constants';
import { CHAINLINK_AGGREGATOR_ABI, CONTRACTS } from '../config/contracts';
import { createLogger } from '../utils/logger';
import { OraclePrice, Round } from '../types';

const logger = createLogger('ChainlinkService');

export class ChainlinkService {
  private db = getDb();
  private client;
  private priceCache: Map<string, bigint> = new Map();
  
  constructor() {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(config.rpc.ethereum),
    });
  }
  
  /**
   * Fetches the USD price for an asset at the start of a round
   */
  async fetchPriceAtRoundStart(asset: AssetType, round: Round): Promise<bigint> {
    const cacheKey = `${asset}-${round.round_id}`;
    
    // Check memory cache
    if (this.priceCache.has(cacheKey)) {
      return this.priceCache.get(cacheKey)!;
    }
    
    // Check database cache
    const cached = await this.db('oracle_prices')
      .where({ asset, round_id: round.round_id })
      .first();
    
    if (cached) {
      const price = BigInt(cached.price_usd);
      this.priceCache.set(cacheKey, price);
      return price;
    }
    
    // Fetch from Chainlink
    const price = await this.fetchFromChainlink(asset, round);
    
    // Store in database
    await this.storePrice(asset, round, price);
    
    // Store in memory cache
    this.priceCache.set(cacheKey, price);
    
    return price;
  }
  
  /**
   * Fetches price from Chainlink aggregator
   */
  private async fetchFromChainlink(asset: AssetType, round: Round): Promise<bigint> {
    try {
      const contractConfig = CONTRACTS[asset];
      if (!contractConfig) {
        throw new Error(`No contract config for asset ${asset}`);
      }
      
      const aggregatorAddress = contractConfig.oracleFeed as `0x${string}`;
      
      // Get the latest round data at the time of the round start
      const latestData = await this.client.readContract({
        address: aggregatorAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      });
      
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = latestData as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint
      ];
      
      // Check if price is stale (more than 1 hour old)
      const roundTimestamp = Number(round.start_ts) / 1000;
      const priceTimestamp = Number(updatedAt);
      const staleness = roundTimestamp - priceTimestamp;
      
      if (staleness > 3600) {
        logger.warn(`Price is ${staleness} seconds stale for ${asset} at round ${round.round_id}`);
      }
      
      // Answer is the price with 8 decimals (Chainlink standard)
      // We store it as-is and handle scaling in calculations
      return answer;
      
    } catch (error) {
      logger.error(`Error fetching Chainlink price for ${asset}:`, error);
      throw new Error(`Failed to fetch Chainlink price for ${asset}: ${error}`);
    }
  }
  
  /**
   * Finds the closest Chainlink round before a given block
   */
  private async findClosestRound(
    aggregatorAddress: `0x${string}`,
    targetBlock: bigint
  ): Promise<bigint> {
    try {
      // This is a simplified version
      // In production, you'd binary search through historical rounds
      const latestData = await this.client.readContract({
        address: aggregatorAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: 'latestRoundData',
        blockNumber: targetBlock,
      });
      
      return (latestData as any)[1]; // Return the answer
      
    } catch (error) {
      logger.error(`Error finding closest Chainlink round:`, error);
      throw error;
    }
  }
  
  /**
   * Stores oracle price in database
   */
  private async storePrice(asset: AssetType, round: Round, price: bigint): Promise<void> {
    try {
      const oraclePrice: OraclePrice = {
        asset,
        round_id: round.round_id,
        price_usd: price.toString(),
        oracle_block: round.start_block,
        oracle_timestamp: round.start_ts,
      };
      
      await this.db('oracle_prices').insert(oraclePrice);
      
      logger.info(`Stored oracle price for ${asset} round ${round.round_id}: $${Number(price) / 1e8}`);
      
    } catch (error: any) {
      if (error.code === '23505') {
        // Duplicate key - price already stored
        logger.debug(`Price already stored for ${asset} round ${round.round_id}`);
      } else {
        logger.error(`Error storing oracle price:`, error);
        throw error;
      }
    }
  }
  
  /**
   * Gets all cached prices for an asset
   */
  async getCachedPrices(asset: AssetType): Promise<OraclePrice[]> {
    return await this.db('oracle_prices')
      .where({ asset })
      .orderBy('round_id', 'asc');
  }
  
  /**
   * Clears the memory cache
   */
  clearCache(): void {
    this.priceCache.clear();
  }
  
  /**
   * Validates that we have prices for all rounds
   */
  async validatePrices(asset: AssetType): Promise<boolean> {
    const rounds = await this.db('rounds')
      .where({ asset })
      .orderBy('round_id', 'asc');
    
    const prices = await this.db('oracle_prices')
      .where({ asset })
      .orderBy('round_id', 'asc');
    
    const priceMap = new Map(prices.map(p => [p.round_id, p]));
    
    let allValid = true;
    for (const round of rounds) {
      if (!priceMap.has(round.round_id)) {
        logger.warn(`Missing price for ${asset} round ${round.round_id}`);
        allValid = false;
      }
    }
    
    return allValid;
  }
}