import { createLogger } from '../utils/logger';

const logger = createLogger('SimplePriceOracle');

// Simple price oracle with hardcoded prices for testing
// In production, this would fetch from Chainlink or other oracles
export class SimplePriceOracle {
  private prices: Record<string, number> = {
    'xETH': 3488,   // ETH price in USD
    'xBTC': 95000,  // BTC price in USD  
    'xUSD': 1,      // USD stablecoin
    'xEUR': 1.05,   // EUR/USD rate
  };
  
  async getPriceAtTimestamp(asset: string, timestamp: Date): Promise<bigint> {
    const price = this.prices[asset] || 0;
    logger.debug(`Price for ${asset} at ${timestamp.toISOString()}: $${price}`);
    return BigInt(Math.floor(price));
  }
  
  async getCurrentPrice(asset: string): Promise<bigint> {
    const price = this.prices[asset] || 0;
    return BigInt(Math.floor(price));
  }
}