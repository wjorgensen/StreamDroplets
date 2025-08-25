import { createPublicClient, http, Log, Block } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, ChainId, AssetType } from '../config/constants';
import { CONTRACTS } from '../config/contracts';
import { createLogger } from '../utils/logger';
import { TimelineOracleService } from '../oracle/TimelineOracleService';

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
  private oracleService: TimelineOracleService;
  private isRunning = false;
  
  constructor() {
    // Initialize Ethereum client
    this.clients.set(CONSTANTS.CHAIN_IDS.ETHEREUM, createPublicClient({
      chain: mainnet,
      transport: http(config.rpc.ethereum),
    }));
    
    // Initialize Sonic client (using custom chain config)
    const sonicChain = {
      id: CONSTANTS.CHAIN_IDS.SONIC,
      name: 'Sonic',
      network: 'sonic',
      nativeCurrency: {
        decimals: 18,
        name: 'Sonic',
        symbol: 'S',
      },
      rpcUrls: {
        default: { http: [config.rpc.sonic] },
        public: { http: [config.rpc.sonic] },
      },
    };
    
    this.clients.set(CONSTANTS.CHAIN_IDS.SONIC, createPublicClient({
      chain: sonicChain as any,
      transport: http(config.rpc.sonic),
    }));
    
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
    
    for (const [asset, contractConfig] of Object.entries(CONTRACTS)) {
      // Index Ethereum
      indexPromises.push(
        this.indexChain(
          CONSTANTS.CHAIN_IDS.ETHEREUM,
          asset as AssetType,
          contractConfig.ethereum
        )
      );
      
      // Index Sonic
      indexPromises.push(
        this.indexChain(
          CONSTANTS.CHAIN_IDS.SONIC,
          asset as AssetType,
          contractConfig.sonic
        )
      );
    }
    
    await Promise.all(indexPromises);
  }
  
  async stop() {
    this.isRunning = false;
    logger.info('Stopping timeline indexer');
  }
  
  private async indexChain(chainId: ChainId, asset: AssetType, contractAddress: string) {
    const client = this.clients.get(chainId);
    if (!client) {
      logger.error(`No client configured for chain ${chainId}`);
      return;
    }
    
    // Get or create cursor
    const cursor = await this.getCursor(chainId, contractAddress);
    let currentBlock = BigInt(cursor.last_safe_block);
    
    logger.info(`Starting timeline indexer for ${asset} on chain ${chainId} from block ${currentBlock}`);
    
    while (this.isRunning) {
      try {
        const latestBlock = await client.getBlockNumber();
        const confirmations = chainId === CONSTANTS.CHAIN_IDS.ETHEREUM 
          ? config.indexer.ethConfirmations 
          : config.indexer.sonicConfirmations;
        
        const safeBlock = latestBlock - BigInt(confirmations);
        
        if (currentBlock >= safeBlock) {
          await new Promise(resolve => setTimeout(resolve, config.indexer.pollInterval));
          continue;
        }
        
        // Process blocks in batches
        const toBlock = currentBlock + BigInt(config.indexer.batchSize);
        const endBlock = toBlock > safeBlock ? safeBlock : toBlock;
        
        await this.processBlockRange(chainId, asset, currentBlock, endBlock);
        
        // Update cursor
        await this.updateCursor(chainId, contractAddress, endBlock);
        currentBlock = endBlock + 1n;
        
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
    const logs = await client.getLogs({
      address: CONTRACTS[asset][chainId === 1 ? 'ethereum' : 'sonic'] as `0x${string}`,
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
    const client = this.clients.get(chainId);
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
    _address: string,
    _asset: AssetType,
    _chainId: ChainId,
    _blockNumber: bigint
  ): Promise<bigint> {
    // This would query the current balance table or calculate from events
    // For now, return a placeholder
    return 0n;
  }
  
  private async getPPSAtBlock(
    _asset: AssetType,
    _chainId: ChainId,
    _blockNumber: bigint
  ): Promise<bigint> {
    // This would query the rounds table for the PPS at this block
    // For now, return a placeholder
    return 1000000000000000000n; // 1.0 PPS
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
      
      // Calculate USD exposure
      const shares = BigInt(interval.shares);
      const pps = BigInt(interval.pps);
      const price = BigInt(interval.price_usd);
      
      const usdExposure = (shares * pps * price) / (10n ** 18n) / (10n ** 8n);
      
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
}
