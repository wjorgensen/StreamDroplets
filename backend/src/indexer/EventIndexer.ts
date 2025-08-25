import { createPublicClient, http, Log, Block } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, ChainId, AssetType } from '../config/constants';
import { CONTRACTS } from '../config/contracts';
import { createLogger } from '../utils/logger';
import { ShareEvent, Cursor, Round } from '../types';
import { EventClassifier } from './EventClassifier';
import { BalanceTracker } from './BalanceTracker';

const logger = createLogger('EventIndexer');

export class EventIndexer {
  private db = getDb();
  private clients: Map<ChainId, any> = new Map();
  private classifier: EventClassifier;
  private balanceTracker: BalanceTracker;
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
    
    this.classifier = new EventClassifier();
    this.balanceTracker = new BalanceTracker();
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Indexer is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting event indexer');
    
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
    
    // Run all indexers in parallel
    await Promise.all(indexPromises);
  }
  
  async stop() {
    this.isRunning = false;
    logger.info('Stopping event indexer');
  }
  
  private async indexChain(chainId: ChainId, asset: AssetType, contractAddress: string) {
    const client = this.clients.get(chainId);
    if (!client) {
      logger.error(`No client configured for chain ${chainId}`);
      return;
    }
    
    // Get or create cursor
    const cursor = await this.getCursor(chainId, contractAddress);
    let currentBlock = cursor.last_safe_block;
    
    logger.info(`Starting indexer for ${asset} on chain ${chainId} from block ${currentBlock}`);
    
    while (this.isRunning) {
      try {
        const latestBlock = await client.getBlockNumber();
        const confirmations = chainId === CONSTANTS.CHAIN_IDS.ETHEREUM 
          ? config.indexer.ethConfirmations 
          : config.indexer.sonicConfirmations;
        
        const safeBlock = latestBlock - BigInt(confirmations);
        
        if (currentBlock >= safeBlock) {
          // Wait for new blocks
          await new Promise(resolve => setTimeout(resolve, config.indexer.pollInterval));
          continue;
        }
        
        // Process blocks in batches
        const toBlock = currentBlock + BigInt(config.indexer.batchSize);
        const endBlock = toBlock > safeBlock ? safeBlock : toBlock;
        
        logger.debug(`Processing blocks ${currentBlock} to ${endBlock} for ${asset} on chain ${chainId}`);
        
        // Get all events in range
        const logs = await client.getLogs({
          address: contractAddress as `0x${string}`,
          fromBlock: currentBlock,
          toBlock: endBlock,
        });
        
        // Process logs in order
        await this.processLogs(logs, chainId, asset);
        
        // Update cursor
        await this.updateCursor(chainId, contractAddress, endBlock);
        currentBlock = endBlock + 1n;
        
      } catch (error) {
        logger.error(`Error indexing chain ${chainId}:`, error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  private async processLogs(logs: Log[], chainId: ChainId, asset: AssetType) {
    const sortedLogs = logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return Number(a.blockNumber! - b.blockNumber!);
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex! - b.transactionIndex!;
      }
      return a.logIndex! - b.logIndex!;
    });
    
    for (const log of sortedLogs) {
      try {
        await this.processLog(log, chainId, asset);
      } catch (error) {
        logger.error(`Error processing log:`, { error, log });
      }
    }
  }
  
  private async processLog(log: Log, chainId: ChainId, asset: AssetType) {
    const client = this.clients.get(chainId);
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    
    // Decode event based on topic
    const eventSignatures = {
      stake: '0x' + '9e3e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e', // Replace with actual
      unstake: '0x' + '9e3e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e',
      redeem: '0x' + '9e3e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e',
      roundRolled: '0x' + '9e3e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e7c2e0a3e',
      transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    };
    
    // Handle different event types
    if (log.topics[0] === eventSignatures.transfer) {
      await this.handleTransfer(log, block, chainId, asset);
    } else if (log.topics[0] === eventSignatures.roundRolled) {
      await this.handleRoundRolled(log, block, chainId, asset);
    } else {
      await this.handleVaultEvent(log, block, chainId, asset);
    }
  }
  
  private async handleTransfer(log: Log, block: Block, chainId: ChainId, asset: AssetType) {
    const from = `0x${log.topics[1]?.slice(26)}`;
    const to = `0x${log.topics[2]?.slice(26)}`;
    const value = BigInt(log.data);
    
    const txReceipt = await this.clients.get(chainId)?.getTransactionReceipt({ 
      hash: log.transactionHash 
    });
    
    const classification = await this.classifier.classifyTransfer(
      from,
      to,
      log.transactionHash!,
      txReceipt,
      chainId
    );
    
    // Store event
    const event: ShareEvent = {
      chain_id: chainId,
      address: from,
      event_type: 'transfer',
      shares_delta: (-value).toString(),
      block: log.blockNumber!,
      timestamp: new Date(Number(block.timestamp) * 1000),
      tx_hash: log.transactionHash!,
      log_index: log.logIndex!,
      event_classification: classification,
      asset,
    };
    
    await this.storeEvent(event);
    
    // Update balances
    await this.balanceTracker.updateBalance(from, asset, chainId, -value, log.blockNumber!);
    await this.balanceTracker.updateBalance(to, asset, chainId, value, log.blockNumber!);
    
    // Handle bridge events
    if (classification === 'bridge_burn' || classification === 'bridge_mint') {
      await this.handleBridgeEvent(log, from, to, value, classification, asset, block);
    }
  }
  
  private async handleRoundRolled(log: Log, block: Block, chainId: ChainId, asset: AssetType) {
    // Decode RoundRolled event
    // This is a simplified version - actual implementation would decode properly
    const round = Number(log.topics[1]);
    const pricePerShare = BigInt(log.data);
    
    const roundData: Round = {
      round_id: round,
      asset,
      chain_id: chainId,
      start_block: log.blockNumber!,
      start_ts: new Date(Number(block.timestamp) * 1000),
      pps: pricePerShare.toString(),
      pps_scale: 18, // From contract
      tx_hash: log.transactionHash!,
    };
    
    await this.storeRound(roundData);
    
    // Trigger snapshot for this round
    await this.balanceTracker.snapshotForRound(round, asset, block.timestamp);
  }
  
  private async handleVaultEvent(_log: Log, _block: Block, _chainId: ChainId, _asset: AssetType) {
    // Implementation for other vault events (Stake, Unstake, Redeem, etc.)
    // This would decode the specific event and store it appropriately
  }
  
  private async handleBridgeEvent(
    log: Log,
    from: string,
    _to: string,
    amount: bigint,
    classification: string,
    asset: AssetType,
    block: Block
  ) {
    // Store bridge event for correlation
    if (classification === 'bridge_burn') {
      await this.db('bridge_events').insert({
        src_chain: (log as any).chainId || 0,
        dst_chain: 0, // To be determined
        burn_tx: log.transactionHash!,
        address: from,
        shares: amount.toString(),
        burn_timestamp: new Date(Number(block.timestamp) * 1000),
        status: 'pending',
        asset,
      });
    }
  }
  
  private async getCursor(chainId: ChainId, contractAddress: string): Promise<Cursor> {
    const cursor = await this.db('cursors')
      .where({ chain_id: chainId, contract_address: contractAddress })
      .first();
    
    if (cursor) {
      return cursor;
    }
    
    // Create new cursor starting from deployment block
    const newCursor: Cursor = {
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
  
  private async storeEvent(event: ShareEvent) {
    try {
      await this.db('share_events').insert(event);
    } catch (error: any) {
      if (error.code === '23505') {
        // Duplicate key error - event already processed
        logger.debug(`Event already processed: ${event.tx_hash}:${event.log_index}`);
      } else {
        throw error;
      }
    }
  }
  
  private async storeRound(round: Round) {
    try {
      await this.db('rounds').insert(round);
    } catch (error: any) {
      if (error.code === '23505') {
        // Duplicate key error - round already exists
        logger.debug(`Round already exists: ${round.round_id} for ${round.asset}`);
      } else {
        throw error;
      }
    }
  }
}