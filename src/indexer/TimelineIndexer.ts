import { createPublicClient, http, Log, Block } from 'viem';
import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, ChainId, AssetType } from '../config/constants';
import { CONTRACTS } from '../config/contracts';
import { createLogger } from '../utils/logger';
import { TimelineOracleService } from '../oracle/TimelineOracleService';
import { getRPCManager } from '../utils/rpcManager';
import { CHAIN_CONFIGS } from '../config/chains';

const logger = createLogger('TimelineIndexer');

export interface TimelineInterval {
  id?: number;
  address: string;
  asset: AssetType;
  chain_id: ChainId;
  start_time: Date;
  end_time?: Date;
  shares: string;
  pps: string;
  pps_scale: number;
  price_usd: string;
  price_scale: number;
  usd_exposure?: string;
  created_at?: Date;
}

export class TimelineIndexer {
  private db = getDb();
  private clients: Map<ChainId, any> = new Map();
  private clientArrays: Map<ChainId, any[]> = new Map();
  private clientIndexes: Map<ChainId, number> = new Map();
  private oracleService: TimelineOracleService;
  private isRunning = false;
  
  constructor() {
    // Initialize clients for all chains
    const rpcManager = getRPCManager();
    
    // Initialize clients for each configured chain
    for (const [chainName, chainConfig] of Object.entries(CHAIN_CONFIGS)) {
      if (!chainConfig.rpcEndpoints || chainConfig.rpcEndpoints.length === 0) {
        logger.warn(`No RPC endpoints configured for ${chainName}`);
        continue;
      }
      
      // Create multiple clients for load balancing (one per API key)
      const clients = chainConfig.rpcEndpoints.map((rpcEndpoint, index) => {
        logger.info(`Creating client ${index + 1}/${chainConfig.rpcEndpoints.length} for ${chainName}`);
        return createPublicClient({
          chain: chainConfig.chain as any,
          transport: http(rpcEndpoint, {
            retryCount: 2,
            retryDelay: 1000,
          }),
        });
      });
      
      this.clientArrays.set(chainConfig.chainId, clients);
      this.clientIndexes.set(chainConfig.chainId, 0);
      // Set first client as default for backward compatibility
      this.clients.set(chainConfig.chainId, clients[0]);
      logger.info(`Initialized ${clients.length} clients for ${chainName} (${chainConfig.chainId})`);
    }
    
    this.oracleService = new TimelineOracleService();
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Timeline indexer is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting timeline indexer');
    
    // Start indexing for each chain and asset
    const indexPromises: Promise<void>[] = [];
    
    // Iterate through all configured chains
    for (const chainConfig of Object.values(CHAIN_CONFIGS)) {
      // Skip chains without valid addresses
      const hasValidVaults = Object.values(chainConfig.vaults).some(
        vault => vault.address && vault.address !== '0x0000000000000000000000000000000000000000'
      );
      
      if (!hasValidVaults) {
        logger.info(`Skipping ${chainConfig.name} - no valid vault addresses`);
        continue;
      }
      
      // Index each asset on this chain
      for (const [asset, vaultConfig] of Object.entries(chainConfig.vaults)) {
        if (!vaultConfig.address || vaultConfig.address === '0x0000000000000000000000000000000000000000') {
          continue;
        }
        
        indexPromises.push(
          this.indexChain(
            chainConfig.chainId,
            asset as AssetType,
            vaultConfig.address
          ).catch(error => {
            logger.error(`Failed to start indexing ${asset} on ${chainConfig.name}:`, error);
          })
        );
      }
    }
    
    await Promise.all(indexPromises);
  }
  
  async stop() {
    this.isRunning = false;
    logger.info('Stopping timeline indexer');
  }
  
  private getNextClient(chainId: ChainId): any {
    const clients = this.clientArrays.get(chainId);
    if (!clients || clients.length === 0) {
      return this.clients.get(chainId);
    }
    
    // Round-robin through clients
    const currentIndex = this.clientIndexes.get(chainId) || 0;
    const nextIndex = (currentIndex + 1) % clients.length;
    this.clientIndexes.set(chainId, nextIndex);
    
    return clients[nextIndex];
  }
  
  private async indexChain(chainId: ChainId, asset: AssetType, contractAddress: string) {
    const clients = this.clientArrays.get(chainId);
    if (!clients || clients.length === 0) {
      logger.error(`No clients configured for chain ${chainId}`);
      return;
    }
    
    // Start with a rotating client
    let client = this.getNextClient(chainId);
    
    // Get or create cursor
    const cursor = await this.getCursor(chainId, contractAddress);
    
    logger.info(`Starting timeline indexer for ${asset} on chain ${chainId}`);
    if (cursor.last_tx_hash) {
      logger.info(`Resuming from tx ${cursor.last_tx_hash} log index ${cursor.last_log_index}`);
    }
    
    while (this.isRunning) {
      try {
        // Rotate client for each iteration to spread load
        client = this.getNextClient(chainId);
        
        // Fetch ALL logs for this contract address
        const logs = await client.getLogs({
          address: contractAddress as `0x${string}`,
          fromBlock: 'earliest',
          toBlock: 'latest',
        });
        
        logger.info(`Fetched ${logs.length} total logs for ${asset} on chain ${chainId}`);
        
        // Find where we left off based on tx hash and log index
        let startProcessing = !cursor.last_tx_hash; // If no cursor, process all
        let processedCount = 0;
        let lastProcessedLog: any = null;
        
        for (const log of logs) {
          // Skip logs we've already processed
          if (!startProcessing) {
            if (log.transactionHash === cursor.last_tx_hash && 
                log.logIndex === cursor.last_log_index) {
              startProcessing = true;
              continue; // Skip this one, start with the next
            }
            continue;
          }
          
          // Process this log
          await this.processLog(log, chainId, asset);
          processedCount++;
          lastProcessedLog = log;
        }
        
        // Update cursor with the last processed log
        if (lastProcessedLog) {
          await this.updateCursorWithLog(
            chainId, 
            contractAddress, 
            lastProcessedLog.blockNumber,
            lastProcessedLog.transactionHash,
            lastProcessedLog.logIndex
          );
          logger.info(`Processed ${processedCount} new logs for ${asset} on chain ${chainId}`);
        } else {
          logger.info(`No new logs to process for ${asset} on chain ${chainId}`);
        }
        
        // Wait before checking for new events
        await new Promise(resolve => setTimeout(resolve, config.indexer.pollInterval));
        
      } catch (error) {
        logger.error(`Error indexing chain ${chainId}:`, error);
        console.error('Full indexer error:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  private async processBlockRange(
    chainId: ChainId,
    asset: AssetType,
    fromBlock: bigint,
    toBlock: bigint
  ) {
    const client = this.clients.get(chainId);
    if (!client) return;
    
    // Get all events in range
    const chainName = this.getChainName(chainId);
    const contractAddress = (CONTRACTS[asset] as any)[chainName];
    
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
      return;
    }
    
    const logs = await client.getLogs({
      address: contractAddress as `0x${string}`,
      fromBlock,
      toBlock,
    });
    
    // Sort logs by block and transaction
    const sortedLogs = logs.sort((a: any, b: any) => {
      if (a.blockNumber !== b.blockNumber) {
        return Number(a.blockNumber - b.blockNumber);
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });
    
    // Process each log
    for (const log of sortedLogs) {
      await this.processLog(log, chainId, asset);
    }
  }
  
  private async processLog(log: Log, chainId: ChainId, asset: AssetType) {
    // Rotate client for block fetching
    const client = this.getNextClient(chainId);
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    
    // Get all affected addresses from this log
    const affectedAddresses = this.extractAddressesFromLog(log);
    
    // For each affected address, update their timeline
    for (const address of affectedAddresses) {
      await this.updateAddressTimeline(address, log, block, chainId, asset);
    }
  }
  
  private extractAddressesFromLog(log: Log): string[] {
    // Extract addresses from log topics and data
    const addresses: string[] = [];
    
    // Cast log to include topics for event processing
    const logWithTopics = log as Log & { topics: readonly `0x${string}`[] };
    
    const eventSignature = logWithTopics.topics[0];
    
    // ERC-20 Transfer event: topics[1] = from, topics[2] = to
    if (eventSignature === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
      if (logWithTopics.topics[1]) addresses.push('0x' + logWithTopics.topics[1].slice(26));
      if (logWithTopics.topics[2]) addresses.push('0x' + logWithTopics.topics[2].slice(26));
    }
    
    // OFTReceived event: OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)
    // Event signature: 0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c
    if (eventSignature === '0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c') {
      // topics[3] = to address (recipient)
      if (logWithTopics.topics[3]) addresses.push('0x' + logWithTopics.topics[3].slice(26));
    }
    
    // OFTSent event: OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)  
    // Event signature: 0xfff873bb909b73d08a8c1af4b21779e87103bb8ea8cf3b3a0067eb8526b8b80a
    if (eventSignature === '0xfff873bb909b73d08a8c1af4b21779e87103bb8ea8cf3b3a0067eb8526b8b80a') {
      // topics[3] = from address (sender)
      if (logWithTopics.topics[3]) addresses.push('0x' + logWithTopics.topics[3].slice(26));
    }
    
    // Stake event: Stake(address indexed account, uint256 amount, uint256 round)
    // Event signature: 0x5af417134f72a9d41143ace85b0a26dce6f550f894f2cbc1eeee8810603d91b6
    if (eventSignature === '0x5af417134f72a9d41143ace85b0a26dce6f550f894f2cbc1eeee8810603d91b6') {
      // topics[1] = staker address
      if (logWithTopics.topics[1]) addresses.push('0x' + logWithTopics.topics[1].slice(26));
    }
    
    // Unstake event: Unstake(address indexed account, uint256 amount, uint256 round)
    // Event signature: 0xf960dbf9e5d0682f7a298ed974e33a28b4464914b7a2bfac12ae419a9afeb280
    if (eventSignature === '0xf960dbf9e5d0682f7a298ed974e33a28b4464914b7a2bfac12ae419a9afeb280') {
      // topics[1] = unstaker address
      if (logWithTopics.topics[1]) addresses.push('0x' + logWithTopics.topics[1].slice(26));
    }
    
    // Fallback: if we have any indexed address in topics[1]
    if (!addresses.length && logWithTopics.topics[1]) {
      addresses.push('0x' + logWithTopics.topics[1].slice(26));
    }
    
    return [...new Set(addresses)]; // Remove duplicates
  }
  
  private async updateAddressTimeline(
    address: string,
    log: Log,
    block: Block,
    chainId: ChainId,
    asset: AssetType
  ) {
    const eventTime = new Date(Number(block.timestamp) * 1000);
    
    // Get current state at this address
    const currentBalance = await this.getBalanceAtBlock(address, asset, chainId, log.blockNumber!);
    const currentPPS = await this.getPPSAtBlock(asset, chainId, log.blockNumber!);
    const currentPrice = await this.oracleService.getPriceAtBlock(asset, log.blockNumber!, chainId);
    
    // Close any open intervals for this address
    await this.closeOpenIntervals(address, asset, eventTime);
    
    // Calculate USD exposure: (shares * PPS * token_price) / (10^pps_decimals * 10^price_decimals)
    const ppsScale = 18n;
    const priceScale = 8n;
    const usdExposure = (currentBalance * currentPPS * BigInt(currentPrice)) / (10n ** ppsScale) / (10n ** priceScale);
    
    // Start new interval
    const newInterval: TimelineInterval = {
      address,
      asset,
      chain_id: chainId,
      start_time: eventTime,
      shares: currentBalance.toString(),
      pps: currentPPS.toString(),
      pps_scale: 18, // Standard for most contracts
      price_usd: currentPrice.toString(),
      price_scale: 8, // Chainlink standard
      usd_exposure: usdExposure.toString(),
    };
    
    await this.db('timeline_intervals').insert(newInterval);
  }
  
  private async closeOpenIntervals(
    address: string,
    asset: AssetType,
    endTime: Date
  ) {
    await this.db('timeline_intervals')
      .where({ address, asset })
      .whereNull('end_time')
      .update({ end_time: endTime });
  }
  
  private async getBalanceAtBlock(
    address: string,
    asset: AssetType,
    chainId: ChainId,
    blockNumber: bigint
  ): Promise<bigint> {
    const client = this.clients.get(chainId);
    if (!client) {
      logger.error(`No client configured for chain ${chainId}`);
      return 0n;
    }
    
    const contractAddress = CONTRACTS[asset][chainId === CONSTANTS.CHAIN_IDS.ETHEREUM ? 'ethereum' : 'sonic'];
    
    // Check if we need to use cached data for very old blocks
    const currentBlockClient = this.getNextClient(chainId);
    const currentBlock = await currentBlockClient.getBlockNumber();
    const blockAge = currentBlock - blockNumber;
    const maxHistoricalDepth = 10000000n; // ~1.5 years on Ethereum at 12s blocks
    
    if (blockAge > maxHistoricalDepth) {
      // Try to get from cache first for very old blocks
      const cached = await this.getCachedBalance(address, asset, chainId, blockNumber);
      if (cached !== null) {
        return cached;
      }
    }
    
    try {
      if (chainId === CONSTANTS.CHAIN_IDS.ETHEREUM) {
        // On Ethereum, call shares() on the vault contract
        const shares = await this.retryWithFallback(async () => {
          return await client.readContract({
            address: contractAddress as `0x${string}`,
            abi: [{
              name: 'shares',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }]
            }],
            functionName: 'shares',
            args: [address],
            blockNumber
          });
        }, 3, 1000);
        
        // Cache the result for future use
        await this.cacheBalance(address, asset, chainId, blockNumber, shares as bigint);
        return shares as bigint;
      } else {
        // On all other chains (Sonic, Base, Arbitrum, etc.), call balanceOf() on the OFT contract
        const balance = await this.retryWithFallback(async () => {
          return await client.readContract({
            address: contractAddress as `0x${string}`,
            abi: [{
              name: 'balanceOf',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }]
            }],
            functionName: 'balanceOf',
            args: [address],
            blockNumber
          });
        }, 3, 1000);
        
        // Cache the result for future use
        await this.cacheBalance(address, asset, chainId, blockNumber, balance as bigint);
        return balance as bigint;
      }
    } catch (error) {
      logger.error(`Error fetching balance for ${address} on chain ${chainId} at block ${blockNumber}:`, error);
      
      // Try to get from cache as last resort
      const cached = await this.getCachedBalance(address, asset, chainId, blockNumber);
      if (cached !== null) {
        return cached;
      }
      
      return 0n;
    }
  }
  
  private async retryWithFallback<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: any;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        
        // Check if it's a historical block depth error
        if (error.message?.includes('block range') || 
            error.message?.includes('historical') ||
            error.message?.includes('archive')) {
          logger.warn(`Historical block query failed, will use cache: ${error.message}`);
          throw error; // Don't retry for historical depth errors
        }
        
        if (i < maxRetries - 1) {
          logger.debug(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i))); // Exponential backoff
        }
      }
    }
    
    throw lastError;
  }
  
  private async getCachedBalance(
    address: string,
    asset: AssetType,
    chainId: ChainId,
    blockNumber: bigint
  ): Promise<bigint | null> {
    try {
      const cached = await this.db('balance_cache')
        .where({ address, asset, chain_id: chainId })
        .where('block_number', '<=', blockNumber.toString())
        .orderBy('block_number', 'desc')
        .first();
      
      if (cached) {
        return BigInt(cached.balance);
      }
    } catch (error) {
      logger.debug('Cache lookup failed:', error);
    }
    
    return null;
  }
  
  private async cacheBalance(
    address: string,
    asset: AssetType,
    chainId: ChainId,
    blockNumber: bigint,
    balance: bigint
  ): Promise<void> {
    try {
      await this.db('balance_cache')
        .insert({
          address,
          asset,
          chain_id: chainId,
          block_number: blockNumber.toString(),
          balance: balance.toString(),
          timestamp: new Date(),
          created_at: new Date()
        })
        .onConflict(['address', 'asset', 'chain_id', 'block_number'])
        .merge();
    } catch (error) {
      logger.debug('Failed to cache balance:', error);
    }
  }
  
  private async getPPSAtBlock(
    asset: AssetType,
    chainId: ChainId,
    blockNumber: bigint
  ): Promise<bigint> {
    // PPS (Price Per Share) is only available on Ethereum vault
    // For ALL chains (including Sonic), we query the Ethereum vault for PPS
    // Non-Ethereum chains should NEVER try to fetch PPS locally
    
    // Always use Ethereum client for PPS, regardless of which chain requested it
    const ethereumClient = this.getNextClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
    if (!ethereumClient) {
      logger.error('No Ethereum client configured for PPS fetch');
      return 1000000000000000000n; // Default to 1.0 PPS
    }
    
    const vaultAddress = CONTRACTS[asset].ethereum;
    
    try {
      // For non-Ethereum chains, we need to use the latest block on Ethereum
      // since the block number from other chains doesn't exist on Ethereum
      let ethereumBlockNumber = blockNumber;
      
      if (chainId !== CONSTANTS.CHAIN_IDS.ETHEREUM) {
        // For non-Ethereum chains, use the latest Ethereum block
        // This gives us the current PPS which is good enough for other chains
        try {
          ethereumBlockNumber = await ethereumClient.getBlockNumber();
        } catch {
          // If we can't get latest block, use a recent known block
          ethereumBlockNumber = 20000000n; // Recent Ethereum block as fallback
        }
      }
      
      // First get the current round number
      const currentRound = await ethereumClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: [{
          name: 'currentRound',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'currentRound',
        blockNumber: ethereumBlockNumber
      });
      
      // Then get the PPS for this round
      const pps = await ethereumClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: [{
          name: 'roundPricePerShare',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'round', type: 'uint256' }],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'roundPricePerShare',
        args: [currentRound],
        blockNumber: ethereumBlockNumber
      });
      
      return pps as bigint;
    } catch (error) {
      // Only log error if it's on Ethereum chain, for other chains this is expected
      if (chainId === CONSTANTS.CHAIN_IDS.ETHEREUM) {
        logger.error(`Error fetching PPS for ${asset} at block ${blockNumber}:`, error);
      } else {
        logger.debug(`Using fallback PPS for ${asset} on chain ${chainId}`);
      }
      
      // Check if we have a cached PPS in the database
      const cachedPPS = await this.db('vault_states')
        .where({ asset })
        .where('block_number', '<=', blockNumber.toString())
        .orderBy('block_number', 'desc')
        .first();
      
      if (cachedPPS && cachedPPS.pps) {
        return BigInt(cachedPPS.pps);
      }
      
      return 1000000000000000000n; // Default to 1.0 PPS
    }
  }
  
  private async getCursor(chainId: ChainId, contractAddress: string) {
    const cursor = await this.db('cursors')
      .where({ chain_id: chainId, contract_address: contractAddress })
      .first();
    
    if (cursor) {
      return cursor;
    }
    
    // Create new cursor starting from deployment block
    const newCursor = {
      chain_id: chainId,
      contract_address: contractAddress,
      last_safe_block: 0n, // Should be set to actual deployment block
    };
    
    await this.db('cursors').insert(newCursor);
    return newCursor;
  }
  
  private async updateCursor(chainId: ChainId, contractAddress: string, block: bigint) {
    await this.db('cursors')
      .where({ chain_id: chainId, contract_address: contractAddress })
      .update({
        last_safe_block: block.toString(),
        updated_at: new Date(),
      });
  }
  
  private async updateCursorWithLog(
    chainId: ChainId, 
    contractAddress: string, 
    blockNumber: bigint,
    txHash: string,
    logIndex: number
  ) {
    await this.db('cursors')
      .where({ chain_id: chainId, contract_address: contractAddress })
      .update({
        last_safe_block: blockNumber.toString(),
        last_tx_hash: txHash,
        last_log_index: logIndex,
        updated_at: new Date(),
      });
  }
  
  /**
   * Calculate droplets for an address over a time range
   */
  async calculateDropletsForRange(
    address: string,
    asset: AssetType,
    startTime: Date,
    endTime: Date
  ): Promise<bigint> {
    // Get all intervals for this address in the time range
    const intervals = await this.db('timeline_intervals')
      .where({ address, asset })
      .where('start_time', '<=', endTime)
      .where(function() {
        this.where('end_time', '>=', startTime).orWhereNull('end_time');
      })
      .orderBy('start_time');
    
    let totalDroplets = 0n;
    
    for (const interval of intervals) {
      // Calculate effective time in this interval
      const intervalStart = interval.start_time > startTime ? interval.start_time : startTime;
      const intervalEnd = interval.end_time && interval.end_time < endTime ? interval.end_time : endTime;
      
      if (intervalStart >= intervalEnd) continue;
      
      const durationSeconds = BigInt(Math.floor((intervalEnd.getTime() - intervalStart.getTime()) / 1000));
      
      // Use pre-calculated USD exposure if available, otherwise calculate it
      let usdExposure: bigint;
      if (interval.usd_exposure) {
        usdExposure = BigInt(interval.usd_exposure);
      } else {
        // Calculate USD exposure: (shares * PPS * token_price) / (10^pps_decimals * 10^price_decimals)
        const shares = BigInt(interval.shares);
        const pps = BigInt(interval.pps);
        const price = BigInt(interval.price_usd);
        const ppsScale = BigInt(interval.pps_scale || 18);
        const priceScale = BigInt(interval.price_scale || 8);
        
        usdExposure = (shares * pps * price) / (10n ** ppsScale) / (10n ** priceScale);
      }
      
      // Get rate for this time period
      const rate = await this.getRateAtTime(intervalStart);
      
      // Calculate droplets: usd_exposure * rate * duration
      const droplets = (usdExposure * rate * durationSeconds) / (10n ** 18n);
      
      totalDroplets += droplets;
    }
    
    return totalDroplets;
  }
  
  private async getRateAtTime(time: Date): Promise<bigint> {
    const rate = await this.db('rate_configuration')
      .where('effective_from', '<=', time)
      .where(function() {
        this.where('effective_to', '>=', time).orWhereNull('effective_to');
      })
      .where('is_active', true)
      .first();
    
    return rate ? BigInt(rate.rate_per_usd_second) : 1000000000000000000n;
  }
  
  private getChainName(chainId: number): string {
    switch (chainId) {
      case CONSTANTS.CHAIN_IDS.ETHEREUM:
        return 'ethereum';
      case CONSTANTS.CHAIN_IDS.SONIC:
        return 'sonic';
      case CONSTANTS.CHAIN_IDS.BASE:
        return 'base';
      case CONSTANTS.CHAIN_IDS.ARBITRUM:
        return 'arbitrum';
      case CONSTANTS.CHAIN_IDS.AVALANCHE:
        return 'avalanche';
      case CONSTANTS.CHAIN_IDS.BERACHAIN:
        return 'berachain';
      default:
        return 'ethereum';
    }
  }
}
