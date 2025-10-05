import { CONTRACTS } from '../config/contracts';
import { CHAINLINK_AGGREGATOR_ABI } from '../config/abis/chainlink';
import { createLogger } from '../utils/logger';
import { AlchemyService } from '../utils/AlchemyService';
import { CONSTANTS } from '../config/constants';
import { withAlchemyRetry } from '../utils/retryUtils';

const logger = createLogger('ChainlinkService');

export class ChainlinkService {
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
  }

  /**
   * Gets ETH, BTC, USDC, and EUR prices at a specific block number
   */
  async getPricesAtBlock(blockNumber: number): Promise<{
    eth: bigint;
    btc: bigint;
    usdc: bigint;
    eur: bigint;
  }> {
    const ethFeed = CONTRACTS.xETH.oracleFeed as `0x${string}`;
    const btcFeed = CONTRACTS.xBTC.oracleFeed as `0x${string}`;
    const usdcFeed = CONTRACTS.xUSD.oracleFeed as `0x${string}`;
    const eurFeed = CONTRACTS.xEUR.oracleFeed as `0x${string}`;

    try {
      const viemClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
      
      const results = await Promise.allSettled([
        withAlchemyRetry(async () => {
          return await viemClient.readContract({
            address: ethFeed,
            abi: CHAINLINK_AGGREGATOR_ABI,
            functionName: 'latestRoundData',
            blockNumber: BigInt(blockNumber)
          });
        }, `ETH price feed at block ${blockNumber}`),
        
        withAlchemyRetry(async () => {
          return await viemClient.readContract({
            address: btcFeed,
            abi: CHAINLINK_AGGREGATOR_ABI,
            functionName: 'latestRoundData',
            blockNumber: BigInt(blockNumber)
          });
        }, `BTC price feed at block ${blockNumber}`),
        
        withAlchemyRetry(async () => {
          return await viemClient.readContract({
            address: usdcFeed,
            abi: CHAINLINK_AGGREGATOR_ABI,
            functionName: 'latestRoundData',
            blockNumber: BigInt(blockNumber)
          });
        }, `USDC price feed at block ${blockNumber}`),
        
        withAlchemyRetry(async () => {
          return await viemClient.readContract({
            address: eurFeed,
            abi: CHAINLINK_AGGREGATOR_ABI,
            functionName: 'latestRoundData',
            blockNumber: BigInt(blockNumber)
          });
        }, `EUR price feed at block ${blockNumber}`)
      ]);

      const prices: any = {};
      const feeds = ['eth', 'btc', 'usdc', 'eur'];
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const feedName = feeds[i];
        
        if (result.status === 'fulfilled') {
          prices[feedName] = result.value[1];
        } else {
          const errorMessage = result.reason?.message || 'Unknown error';
          
          if (errorMessage.includes('returned no data ("0x")') || 
              errorMessage.includes('contract does not have the function') ||
              errorMessage.includes('address is not a contract')) {
            logger.warn(`${feedName.toUpperCase()} price feed not deployed at block ${blockNumber}, using fallback value`);
            prices[feedName] = 0n;
          } else {
            logger.error(`Failed to fetch ${feedName.toUpperCase()} price at block ${blockNumber}:`, result.reason);
            throw new Error(`Failed to fetch ${feedName.toUpperCase()} price: ${errorMessage}`);
          }
        }
      }

      return {
        eth: prices.eth,
        btc: prices.btc,
        usdc: prices.usdc,
        eur: prices.eur
      };

    } catch (error) {
      logger.error(`Error fetching prices at block ${blockNumber}:`, error);
      throw new Error(`Failed to fetch prices at block ${blockNumber}: ${error}`);
    }
  }
}