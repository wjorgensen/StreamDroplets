import { Knex } from 'knex';
import { createLogger } from '../utils/logger';
import { SimplePriceOracle } from '../oracle/SimplePriceOracle';

const logger = createLogger('UnifiedBalanceService');

export interface UserBalance {
  user_address: string;
  chain_id: number;
  asset: string;
  balance: string;  // Raw balance (shares on ETH, tokens on other chains)
  balance_type: 'shares' | 'tokens';
  usd_value?: number;
}

export interface UnifiedUserBalance {
  user_address: string;
  total_usd_value: number;
  chain_balances: {
    chain_id: number;
    chain_name: string;
    asset: string;
    balance: string;
    balance_type: 'shares' | 'tokens';
    usd_value: number;
  }[];
}

export class UnifiedBalanceService {
  private oracleService: SimplePriceOracle;
  
  constructor(
    private db: Knex,
    oracleService?: SimplePriceOracle
  ) {
    this.oracleService = oracleService || new SimplePriceOracle();
  }

  /**
   * Get all user balances across all chains at a specific timestamp
   */
  async getAllUserBalances(timestamp: Date): Promise<UnifiedUserBalance[]> {
    logger.info(`Calculating unified balances for ${timestamp.toISOString()}`);

    // Get all chain_share_balances (includes both shares and tokens)
    const allBalances = await this.db('chain_share_balances')
      .select('*')
      .where('shares', '>', '0');

    // Group by user
    const userBalanceMap = new Map<string, UserBalance[]>();
    
    for (const balance of allBalances) {
      const userAddress = balance.address.toLowerCase();
      
      if (!userBalanceMap.has(userAddress)) {
        userBalanceMap.set(userAddress, []);
      }
      
      // Determine if this is shares (ETH vault) or tokens (other chains)
      const isEthereumVault = balance.chain_id === 1;
      
      userBalanceMap.get(userAddress)!.push({
        user_address: userAddress,
        chain_id: balance.chain_id,
        asset: balance.asset,
        balance: balance.shares,
        balance_type: isEthereumVault ? 'shares' : 'tokens',
      });
    }

    // Calculate USD values for each balance
    const unifiedBalances: UnifiedUserBalance[] = [];
    
    for (const [userAddress, balances] of userBalanceMap) {
      // Skip excluded addresses
      const isExcluded = await this.db('excluded_addresses')
        .where('address', userAddress)
        .first();
      
      if (isExcluded) {
        continue;
      }
      
      const chainBalances = await Promise.all(
        balances.map(async (balance) => {
          const usdValue = await this.calculateUSDValue(balance, timestamp);
          
          return {
            chain_id: balance.chain_id,
            chain_name: this.getChainName(balance.chain_id),
            asset: balance.asset,
            balance: balance.balance,
            balance_type: balance.balance_type,
            usd_value: usdValue,
          };
        })
      );
      
      const totalUsdValue = chainBalances.reduce((sum, cb) => sum + cb.usd_value, 0);
      
      // Only include users with positive USD value
      if (totalUsdValue > 0) {
        unifiedBalances.push({
          user_address: userAddress,
          total_usd_value: totalUsdValue,
          chain_balances: chainBalances,
        });
      }
    }
    
    logger.info(`Calculated unified balances for ${unifiedBalances.length} users`);
    return unifiedBalances;
  }

  /**
   * Calculate USD value for a balance
   * For shares: multiply by asset price (1 share = 1 asset in vaults)
   * For tokens: multiply by token price directly
   */
  private async calculateUSDValue(balance: UserBalance, timestamp: Date): Promise<number> {
    try {
      // Get asset type from the symbol
      const assetType = this.getAssetType(balance.asset);
      if (!assetType) {
        logger.warn(`Unknown asset type for ${balance.asset}`);
        return 0;
      }
      
      // Get price from oracle (returns BigInt of the price in dollars)
      const priceRaw = await this.oracleService.getPriceAtTimestamp(assetType, timestamp);
      if (!priceRaw || priceRaw === 0n) {
        logger.debug(`No price found for ${assetType} at ${timestamp.toISOString()}`);
        return 0;
      }
      
      // Convert BigInt price to number (already in dollars)
      const price = Number(priceRaw);
      
      // Convert balance to number with correct decimals per asset
      // Ethereum vaults: xETH:18, xBTC:8, xUSD:8, xEUR:6
      // Cross-chain OFTs: streamETH:18, streamBTC:8, streamUSD:6, streamEUR:6
      let divisor = 1e18; // default
      
      // Handle both vault (x*) and OFT (stream*) tokens
      const isEthereum = balance.chain_id === 1;
      
      if (balance.asset === 'xETH' || balance.asset === 'streamETH') {
        divisor = 1e18;
      } else if (balance.asset === 'xBTC' || balance.asset === 'streamBTC') {
        divisor = 1e8;
      } else if (balance.asset === 'xUSD' || balance.asset === 'streamUSD') {
        // xUSD on Ethereum uses 8 decimals, streamUSD on other chains uses 6
        divisor = isEthereum ? 1e8 : 1e6;
      } else if (balance.asset === 'xEUR' || balance.asset === 'streamEUR') {
        divisor = 1e6;
      }
      
      const balanceInUnits = Number(balance.balance) / divisor;
      
      // Calculate USD value
      const usdValue = balanceInUnits * price;
      
      return usdValue;
    } catch (error) {
      logger.error(`Error calculating USD value for ${balance.asset}:`, error);
      return 0;
    }
  }

  /**
   * Get asset type from symbol
   */
  private getAssetType(symbol: string): string | null {
    // Handle both vault shares (xETH) and regular tokens (streamETH)
    const assetMap: Record<string, string> = {
      'xETH': 'xETH',
      'streamETH': 'xETH',
      'xBTC': 'xBTC', 
      'streamBTC': 'xBTC',
      'xUSD': 'xUSD',
      'streamUSD': 'xUSD',
      'xEUR': 'xEUR',
      'streamEUR': 'xEUR',
    };
    
    return assetMap[symbol] || null;
  }

  /**
   * Get chain name from chain ID
   */
  private getChainName(chainId: number): string {
    const chainNames: Record<number, string> = {
      1: 'Ethereum',
      146: 'Sonic',
      8453: 'Base',
      42161: 'Arbitrum',
      43114: 'Avalanche',
      81457: 'Berachain',
    };
    
    return chainNames[chainId] || `Chain ${chainId}`;
  }

  /**
   * Store unified balances in database for a specific snapshot
   */
  async storeUnifiedBalances(
    balances: UnifiedUserBalance[],
    snapshotTimestamp: Date
  ): Promise<void> {
    // Get current round (use unix timestamp as round ID for now)
    const roundId = Math.floor(snapshotTimestamp.getTime() / 1000);
    
    // Store snapshots in user_usd_snapshots with existing structure
    const records = await Promise.all(balances.map(async balance => {
      // Extract individual asset values
      let xethShares = 0n;
      let xethUsd = 0n;
      let xbtcShares = 0n;
      let xbtcUsd = 0n;
      let xusdShares = 0n;
      let xusdUsd = 0n;
      let xeurShares = 0n;
      let xeurUsd = 0n;
      
      for (const cb of balance.chain_balances) {
        const shares = BigInt(cb.balance);
        const usdValue = BigInt(Math.floor(cb.usd_value));
        
        switch(cb.asset) {
          case 'xETH':
            xethShares += shares;
            xethUsd += usdValue;
            break;
          case 'xBTC':
            xbtcShares += shares;
            xbtcUsd += usdValue;
            break;
          case 'xUSD':
            xusdShares += shares;
            xusdUsd += usdValue;
            break;
          case 'xEUR':
            xeurShares += shares;
            xeurUsd += usdValue;
            break;
        }
      }
      
      // Check if excluded
      const isExcluded = await this.db('excluded_addresses')
        .where('address', balance.user_address)
        .first();
      
      return {
        address: balance.user_address,
        round_id: roundId,
        total_usd_value: BigInt(Math.floor(balance.total_usd_value)).toString(),
        xeth_shares_total: xethShares.toString(),
        xeth_usd_value: xethUsd.toString(),
        xbtc_shares_total: xbtcShares.toString(),
        xbtc_usd_value: xbtcUsd.toString(),
        xusd_shares_total: xusdShares.toString(),
        xusd_usd_value: xusdUsd.toString(),
        xeur_shares_total: xeurShares.toString(),
        xeur_usd_value: xeurUsd.toString(),
        had_unstake: false,
        is_excluded: !!isExcluded,
        droplets_earned: '0',
        snapshot_time: snapshotTimestamp,
        created_at: new Date(),
      };
    }));
    
    if (records.length > 0) {
      await this.db('user_usd_snapshots')
        .insert(records)
        .onConflict(['address', 'round_id'])
        .merge();
      
      logger.info(`Stored ${records.length} unified balance snapshots for round ${roundId}`);
    }
  }

  /**
   * Calculate droplets based on USD exposure (1 droplet per $1 USD per day)
   */
  async calculateAndStoreDroplets(
    balances: UnifiedUserBalance[],
    snapshotDate: Date
  ): Promise<number> {
    const dateStr = snapshotDate.toISOString().split('T')[0];
    let totalDropletsAwarded = 0;
    
    // Award droplets based on USD value (1:1 ratio)
    const dropletRecords = balances.map(balance => {
      const dropletsAmount = Math.floor(balance.total_usd_value); // 1 droplet per $1 USD
      totalDropletsAwarded += dropletsAmount;
      
      return {
        user_address: balance.user_address,
        amount: dropletsAmount.toString(),
        snapshot_date: dateStr,
        awarded_at: new Date(),
        reason: `Daily USD exposure: $${balance.total_usd_value.toFixed(2)}`,
      };
    }).filter(record => parseInt(record.amount) > 0); // Only award if > 0 droplets
    
    if (dropletRecords.length > 0) {
      await this.db('droplets_cache')
        .insert(dropletRecords)
        .onConflict(['user_address', 'snapshot_date'])
        .merge();
      
      logger.info(`Awarded ${totalDropletsAwarded} total droplets to ${dropletRecords.length} users for ${dateStr}`);
    }
    
    return totalDropletsAwarded;
  }
}