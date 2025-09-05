/**
 * Alchemy-Optimized Indexer
 * Uses Alchemy's specialized APIs for efficient blockchain data retrieval
 * No full block downloads - only relevant events and transactions
 */

import { Alchemy, Network, AssetTransfersCategory, AssetTransfersParams, AlchemySubscription } from 'alchemy-sdk';
import { parseAbiItem, decodeEventLog, Address } from 'viem';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import EventEmitter from 'events';

const logger = createLogger('AlchemyOptimizedIndexer');

// Event signatures for filtering
const EVENT_SIGNATURES = {
  // ERC-4626 Vault events (what StreamVaults actually use)
  Deposit: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
  
  // Legacy events (for backward compatibility)
  Stake: parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)'),
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  InstantUnstake: parseAbiItem('event InstantUnstake(address indexed account, uint256 amount, uint256 round)'),
  RoundRolled: parseAbiItem('event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)'),
  
  // ERC-20 events
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  Approval: parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)'),
  
  // LayerZero OFT events
  OFTSent: parseAbiItem('event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)'),
  OFTReceived: parseAbiItem('event OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)'),
  
  // Admin events
  OwnershipTransferred: parseAbiItem('event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)'),
  Paused: parseAbiItem('event Paused(address account)'),
  Unpaused: parseAbiItem('event Unpaused(address account)'),
};


export interface IndexerConfig {
  apiKey: string;
  network: Network;
  contracts: {
    address: string;
    symbol: string;
    chainId: number;
    startBlock?: number;
  }[];
  batchSize?: number;
  realtime?: boolean;
}

export class AlchemyOptimizedIndexer extends EventEmitter {
  private alchemy: Alchemy;
  private db = getDb();
  private config: IndexerConfig;
  private isRunning = false;
  private subscriptions: AlchemySubscription[] = [];
  
  constructor(config: IndexerConfig) {
    super();
    this.config = {
      batchSize: 5000, // Default chunk size for getLogs
      realtime: true,
      ...config
    };
    
    this.alchemy = new Alchemy({
      apiKey: config.apiKey,
      network: config.network,
    });
    
    logger.info(`Initialized Alchemy indexer for ${config.network}`);
  }

  /**
   * Start indexing process
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Indexer already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting Alchemy-optimized indexer');
    
    try {
      // 1. Backfill historical data
      await this.backfillHistoricalData();
      
      // 2. Setup real-time subscriptions if enabled
      if (this.config.realtime) {
        await this.setupRealtimeSubscriptions();
      }
      
      this.emit('started');
    } catch (error) {
      logger.error('Failed to start indexer:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Backfill historical data using efficient APIs
   */
  private async backfillHistoricalData(): Promise<void> {
    logger.info('Starting historical data backfill');
    
    for (const contract of this.config.contracts) {
      try {
        logger.info(`Backfilling ${contract.symbol} at ${contract.address}`);
        
        // Get last processed block from database
        const cursor = await this.db('cursors')
          .where({
            chain_id: contract.chainId,
            contract: contract.address.toLowerCase(),
          })
          .first()
          .catch(() => {
            logger.debug('No existing cursor found, starting fresh');
            return null;
          });
        
        const fromBlock = cursor ? cursor.last_block + 1 : (contract.startBlock || 0);
        const toBlock = await this.alchemy.core.getBlockNumber();
        
        if (fromBlock >= toBlock) {
          logger.info(`${contract.symbol} already up to date`);
          continue;
        }
        
        // 1. Get all asset transfers involving this contract
        await this.fetchAssetTransfers(contract, fromBlock, toBlock);
        
        // 2. Get all event logs from this contract
        await this.fetchEventLogs(contract, fromBlock, toBlock);
        
        // 3. Update cursor
        await this.updateCursor(contract, toBlock);
        
        logger.info(`Completed backfill for ${contract.symbol} up to block ${toBlock}`);
      } catch (error) {
        logger.error(`Error backfilling ${contract.symbol}:`, error);
        this.emit('error', { contract, error });
      }
    }
  }

  /**
   * Fetch asset transfers using Alchemy's Transfers API
   */
  private async fetchAssetTransfers(
    contract: IndexerConfig['contracts'][0],
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    logger.info(`Fetching transfers for ${contract.symbol} from block ${fromBlock} to ${toBlock}`);
    
    const categories: AssetTransfersCategory[] = [
      AssetTransfersCategory.EXTERNAL,
      AssetTransfersCategory.ERC20,
      AssetTransfersCategory.INTERNAL,
    ];
    
    // Fetch transfers TO the contract
    let pageKey: string | undefined;
    do {
      const params: AssetTransfersParams = {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        toAddress: contract.address,
        category: categories,
        withMetadata: true,
        excludeZeroValue: false,
        pageKey,
      };
      
      const result = await this.alchemy.core.getAssetTransfers(params);
      
      // Process transfers
      for (const transfer of result.transfers) {
        await this.processTransfer(transfer, contract);
      }
      
      pageKey = result.pageKey;
      
      if (result.transfers.length > 0) {
        logger.debug(`Processed ${result.transfers.length} transfers TO ${contract.symbol}`);
      }
    } while (pageKey);
    
    // Fetch transfers FROM the contract
    pageKey = undefined;
    do {
      const params: AssetTransfersParams = {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        fromAddress: contract.address,
        category: categories,
        withMetadata: true,
        excludeZeroValue: false,
        pageKey,
      };
      
      const result = await this.alchemy.core.getAssetTransfers(params);
      
      // Process transfers
      for (const transfer of result.transfers) {
        await this.processTransfer(transfer, contract);
      }
      
      pageKey = result.pageKey;
      
      if (result.transfers.length > 0) {
        logger.debug(`Processed ${result.transfers.length} transfers FROM ${contract.symbol}`);
      }
    } while (pageKey);
  }

  /**
   * Fetch event logs using eth_getLogs in chunks
   */
  private async fetchEventLogs(
    contract: IndexerConfig['contracts'][0],
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    logger.info(`Fetching event logs for ${contract.symbol} from block ${fromBlock} to ${toBlock}`);
    
    const batchSize = this.config.batchSize || 5000;
    let currentBlock = fromBlock;
    
    while (currentBlock <= toBlock) {
      const endBlock = Math.min(currentBlock + batchSize - 1, toBlock);
      
      try {
        // Fetch logs for all relevant events
        const logs = await this.alchemy.core.getLogs({
          address: contract.address,
          fromBlock: currentBlock,
          toBlock: endBlock,
          // We want all events from the contract, so no topic filter
        });
        
        // Process each log
        for (const log of logs) {
          await this.processEventLog(log, contract);
        }
        
        if (logs.length > 0) {
          logger.debug(`Processed ${logs.length} events for ${contract.symbol} in blocks ${currentBlock}-${endBlock}`);
        }
        
        currentBlock = endBlock + 1;
      } catch (error: any) {
        if (error.message?.includes('query returned more than')) {
          // Reduce batch size if we hit limits
          const newBatchSize = Math.floor(batchSize / 2);
          logger.warn(`Reducing batch size from ${batchSize} to ${newBatchSize} due to query limits`);
          this.config.batchSize = newBatchSize;
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Process a single transfer
   */
  private async processTransfer(transfer: any, contract: IndexerConfig['contracts'][0]): Promise<void> {
    try {
      // Get transaction receipt for additional details if needed
      const receipt = await this.alchemy.core.getTransactionReceipt(transfer.hash);
      
      // Store transfer in database
      // blockNum from Alchemy transfers is a hex string
      const blockNum = typeof transfer.blockNum === 'string' 
        ? (transfer.blockNum.startsWith('0x') ? parseInt(transfer.blockNum, 16) : parseInt(transfer.blockNum))
        : transfer.blockNum;
      
      await this.db('transfers').insert({
        chain_id: contract.chainId,
        contract_address: contract.address.toLowerCase(),
        transaction_hash: transfer.hash,
        block_number: blockNum,
        from_address: transfer.from?.toLowerCase(),
        to_address: transfer.to?.toLowerCase(),
        value: transfer.value?.toString() || '0',
        asset: transfer.asset,
        category: transfer.category,
        raw_contract: transfer.rawContract,
        metadata: JSON.stringify(transfer.metadata),
        status: receipt?.status === 1 ? 'success' : 'failed',
        gas_used: receipt?.gasUsed?.toString(),
        created_at: new Date(),
      }).onConflict(['chain_id', 'transaction_hash', 'contract_address']).ignore();
      
    } catch (error) {
      logger.error(`Error processing transfer ${transfer.hash}:`, error);
    }
  }

  /**
   * Process a single event log
   */
  private async processEventLog(log: any, contract: IndexerConfig['contracts'][0]): Promise<void> {
    try {
      // Decode the event log
      let eventName = 'Unknown';
      let decodedLog: any = null;
      
      // Try to decode against known event signatures
      for (const [name, signature] of Object.entries(EVENT_SIGNATURES)) {
        try {
          decodedLog = decodeEventLog({
            abi: [signature],
            data: log.data,
            topics: log.topics,
          });
          eventName = name;
          break;
        } catch {
          // Not this event type, try next
        }
      }
      
      // Store event in database
      // blockNumber from Alchemy can be either hex string or number
      const blockNum = typeof log.blockNumber === 'string' 
        ? parseInt(log.blockNumber, 16) 
        : log.blockNumber;
      
      await this.db('events').insert({
        chain_id: contract.chainId,
        contract_address: contract.address.toLowerCase(),
        transaction_hash: log.transactionHash,
        block_number: blockNum,
        log_index: log.logIndex,
        event_name: eventName,
        topics: JSON.stringify(log.topics),
        data: log.data,
        decoded_data: decodedLog ? JSON.stringify(decodedLog.args) : null,
        created_at: new Date(),
      }).onConflict(['chain_id', 'transaction_hash', 'log_index']).ignore();
      
      // Process specific event types
      if (decodedLog) {
        await this.processSpecificEvent(eventName, decodedLog.args, log, contract);
      }
      
    } catch (error: any) {
      logger.error(`Error processing event log: ${error.message}`, {
        error: error.stack,
        eventName,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        contract: contract.name
      });
    }
  }

  /**
   * Process specific event types for business logic
   */
  private async processSpecificEvent(
    eventName: string,
    args: any,
    log: any,
    contract: IndexerConfig['contracts'][0]
  ): Promise<void> {
    const blockNumber = typeof log.blockNumber === 'string' 
      ? parseInt(log.blockNumber, 16) 
      : log.blockNumber;
    const timestamp = new Date(); // You might want to fetch actual block timestamp
    
    switch (eventName) {
      case 'Deposit':
        // ERC-4626 Deposit event: User deposits assets and receives shares
        // Update chain_share_balances with the new shares
        const depositShares = args.shares.toString();
        const currentDepositBalance = await this.db('chain_share_balances')
          .where({
            chain_id: contract.chainId,
            address: args.owner.toLowerCase(),
            asset: contract.symbol,
          })
          .first();
        
        if (currentDepositBalance) {
          await this.db('chain_share_balances')
            .where({ id: currentDepositBalance.id })
            .update({
              shares: (BigInt(currentDepositBalance.shares) + BigInt(depositShares)).toString(),
              last_block: blockNumber,
              last_updated: timestamp,
            });
        } else {
          await this.db('chain_share_balances').insert({
            chain_id: contract.chainId,
            address: args.owner.toLowerCase(),
            asset: contract.symbol,
            shares: depositShares,
            last_block: blockNumber,
            last_updated: timestamp,
          });
        }
        break;
        
      case 'Withdraw':
        // ERC-4626 Withdraw event: User withdraws assets and burns shares
        const withdrawShares = args.shares.toString();
        const currentWithdrawBalance = await this.db('chain_share_balances')
          .where({
            chain_id: contract.chainId,
            address: args.owner.toLowerCase(),
            asset: contract.symbol,
          })
          .first();
        
        if (currentWithdrawBalance) {
          const newBalance = BigInt(currentWithdrawBalance.shares) - BigInt(withdrawShares);
          if (newBalance > 0n) {
            await this.db('chain_share_balances')
              .where({ id: currentWithdrawBalance.id })
              .update({
                shares: newBalance.toString(),
                last_block: blockNumber,
                last_updated: timestamp,
              });
          } else {
            // Remove if balance is 0
            await this.db('chain_share_balances')
              .where({ id: currentWithdrawBalance.id })
              .delete();
          }
        }
        break;
        
      case 'Stake':
        // User stakes assets and receives shares in the vault
        // We track this as a balance increase
        const stakeUser = args.account.toLowerCase();
        const stakeAmount = args.amount.toString();
        
        const currentStakeBalance = await this.db('chain_share_balances')
          .where({
            chain_id: contract.chainId,
            address: stakeUser,
            asset: contract.symbol,
          })
          .first();
        
        if (currentStakeBalance) {
          await this.db('chain_share_balances')
            .where({ id: currentStakeBalance.id })
            .update({
              shares: (BigInt(currentStakeBalance.shares) + BigInt(stakeAmount)).toString(),
              last_block: blockNumber,
              last_updated: timestamp,
            });
        } else {
          await this.db('chain_share_balances').insert({
            chain_id: contract.chainId,
            address: stakeUser,
            asset: contract.symbol,
            shares: stakeAmount,
            last_block: blockNumber,
            last_updated: timestamp,
          });
        }
        break;
        
      case 'Unstake':
        // User unstakes and burns shares
        const unstakeUser = args.account.toLowerCase();
        const unstakeAmount = args.amount.toString();
        
        const currentUnstakeBalance = await this.db('chain_share_balances')
          .where({
            chain_id: contract.chainId,
            address: unstakeUser,
            asset: contract.symbol,
          })
          .first();
        
        if (currentUnstakeBalance) {
          const newBalance = BigInt(currentUnstakeBalance.shares) - BigInt(unstakeAmount);
          if (newBalance > 0n) {
            await this.db('chain_share_balances')
              .where({ id: currentUnstakeBalance.id })
              .update({
                shares: newBalance.toString(),
                last_block: blockNumber,
                last_updated: timestamp,
              });
          } else {
            await this.db('chain_share_balances')
              .where({ id: currentUnstakeBalance.id })
              .delete();
          }
        }
        break;
        
      case 'Redeem':
        // Similar to Unstake - user redeems shares
        const redeemUser = args.account.toLowerCase();
        const redeemShares = args.share ? args.share.toString() : args.shares?.toString() || '0';
        
        const currentRedeemBalance = await this.db('chain_share_balances')
          .where({
            chain_id: contract.chainId,
            address: redeemUser,
            asset: contract.symbol,
          })
          .first();
        
        if (currentRedeemBalance) {
          const newBalance = BigInt(currentRedeemBalance.shares) - BigInt(redeemShares);
          if (newBalance > 0n) {
            await this.db('chain_share_balances')
              .where({ id: currentRedeemBalance.id })
              .update({
                shares: newBalance.toString(),
                last_block: blockNumber,
                last_updated: timestamp,
              });
          } else {
            await this.db('chain_share_balances')
              .where({ id: currentRedeemBalance.id })
              .delete();
          }
        }
        break;
        
      case 'InstantUnstake':
      case 'RoundRolled':
        // Legacy events - skip for now as tables don't exist
        logger.debug(`Skipping legacy event ${eventName}`);
        break;
        
      case 'Transfer':
        // Handle share transfers between users
        // This is important for tracking vault share movements
        if (args.from !== '0x0000000000000000000000000000000000000000' &&
            args.to !== '0x0000000000000000000000000000000000000000') {
          // Update sender balance
          const senderBalance = await this.db('chain_share_balances')
            .where({
              chain_id: contract.chainId,
              address: args.from.toLowerCase(),
              asset: contract.symbol,
            })
            .first();
          
          if (senderBalance) {
            const newSenderBalance = BigInt(senderBalance.shares) - BigInt(args.value.toString());
            if (newSenderBalance > 0n) {
              await this.db('chain_share_balances')
                .where({ id: senderBalance.id })
                .update({
                  shares: newSenderBalance.toString(),
                  last_block: blockNumber,
                  last_updated: timestamp,
                });
            } else {
              await this.db('chain_share_balances')
                .where({ id: senderBalance.id })
                .delete();
            }
          }
          
          // Update receiver balance
          const receiverBalance = await this.db('chain_share_balances')
            .where({
              chain_id: contract.chainId,
              address: args.to.toLowerCase(),
              asset: contract.symbol,
            })
            .first();
          
          if (receiverBalance) {
            await this.db('chain_share_balances')
              .where({ id: receiverBalance.id })
              .update({
                shares: (BigInt(receiverBalance.shares) + BigInt(args.value.toString())).toString(),
                last_block: blockNumber,
                last_updated: timestamp,
              });
          } else {
            await this.db('chain_share_balances').insert({
              chain_id: contract.chainId,
              address: args.to.toLowerCase(),
              asset: contract.symbol,
              shares: args.value.toString(),
              last_block: blockNumber,
              last_updated: timestamp,
            });
          }
        }
        break;
        
      case 'OFTSent':
      case 'OFTReceived':
        // Handle cross-chain transfers
        await this.db('cross_chain_transfers').insert({
          chain_id: contract.chainId,
          contract_address: contract.address.toLowerCase(),
          event_type: eventName,
          guid: args.guid,
          endpoint_id: args.dstEid || args.srcEid,
          account: (args.from || args.to).toLowerCase(),
          amount: args.amountSent || args.amountReceived,
          block_number: blockNumber,
          transaction_hash: log.transactionHash,
          timestamp,
        }).onConflict(['chain_id', 'transaction_hash', 'log_index']).ignore();
        break;
    }
    
    this.emit('eventProcessed', { eventName, contract: contract.symbol, blockNumber });
  }

  /**
   * Setup real-time subscriptions for live updates
   */
  private async setupRealtimeSubscriptions(): Promise<void> {
    logger.info('Setting up real-time subscriptions');
    
    for (const contract of this.config.contracts) {
      try {
        // Subscribe to pending transactions involving the contract
        const pendingTxSub = await this.alchemy.ws.on(
          {
            method: AlchemySubscription.PENDING_TRANSACTIONS,
            toAddress: contract.address as Address,
          },
          async (tx) => {
            logger.debug(`Pending tx to ${contract.symbol}: ${tx.hash}`);
            await this.processPendingTransaction(tx, contract);
          }
        );
        this.subscriptions.push(pendingTxSub as any);
        
        // Subscribe to mined transactions
        const minedTxSub = await this.alchemy.ws.on(
          {
            method: AlchemySubscription.MINED_TRANSACTIONS,
            addresses: [{ to: contract.address as Address }, { from: contract.address as Address }],
            includeRemoved: false,
            hashesOnly: false,
          },
          async (tx) => {
            logger.debug(`Mined tx for ${contract.symbol}: ${tx.hash}`);
            await this.processMinedTransaction(tx, contract);
          }
        );
        this.subscriptions.push(minedTxSub as any);
        
        logger.info(`Setup real-time subscriptions for ${contract.symbol}`);
      } catch (error) {
        logger.error(`Error setting up subscriptions for ${contract.symbol}:`, error);
      }
    }
  }

  /**
   * Process pending transaction in real-time
   */
  private async processPendingTransaction(tx: any, contract: IndexerConfig['contracts'][0]): Promise<void> {
    // Skip pending transaction storage - table removed in cleanup
    // Just emit the event
    this.emit('pendingTransaction', { contract: contract.symbol, hash: tx.hash });
  }

  /**
   * Process mined transaction in real-time
   */
  private async processMinedTransaction(tx: any, contract: IndexerConfig['contracts'][0]): Promise<void> {
    // Get full receipt with logs
    const receipt = await this.alchemy.core.getTransactionReceipt(tx.hash);
    
    if (!receipt) {
      logger.warn(`No receipt found for tx ${tx.hash}`);
      return;
    }
    
    // Skip pending transaction removal - table removed in cleanup
    
    // Process the transaction
    await this.processTransfer({
      hash: tx.hash,
      blockNum: tx.blockNumber,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      asset: 'ETH',
      category: AssetTransfersCategory.EXTERNAL,
      metadata: { blockTimestamp: tx.timestamp },
    }, contract);
    
    // Process all logs in the receipt
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === contract.address.toLowerCase()) {
        await this.processEventLog(log, contract);
      }
    }
    
    this.emit('transactionMined', { contract: contract.symbol, hash: tx.hash, status: receipt.status });
  }

  /**
   * Update cursor for a contract
   */
  private async updateCursor(contract: IndexerConfig['contracts'][0], blockNumber: number): Promise<void> {
    await this.db('cursors')
      .insert({
        chain_id: contract.chainId,
        contract: contract.address.toLowerCase(),
        last_block: blockNumber,
        updated_at: new Date(),
      })
      .onConflict(['chain_id', 'contract'])
      .merge(['last_block', 'updated_at']);
  }

  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    logger.info('Stopping Alchemy-optimized indexer');
    this.isRunning = false;
    
    // Unsubscribe from all WebSocket subscriptions
    for (const sub of this.subscriptions) {
      try {
        await this.alchemy.ws.off(sub);
      } catch (error) {
        logger.error('Error unsubscribing:', error);
      }
    }
    
    this.subscriptions = [];
    this.emit('stopped');
  }

  /**
   * Get indexer metrics
   */
  async getMetrics(): Promise<any> {
    const metrics: any = {};
    
    for (const contract of this.config.contracts) {
      const cursor = await this.db('cursors')
        .where({
          chain_id: contract.chainId,
          contract: contract.address.toLowerCase(),
        })
        .first();
      
      const eventCount = await this.db('events')
        .where({
          chain_id: contract.chainId,
          contract_address: contract.address.toLowerCase(),
        })
        .count('* as count')
        .first();
      
      const transferCount = await this.db('transfers')
        .where({
          chain_id: contract.chainId,
          contract_address: contract.address.toLowerCase(),
        })
        .count('* as count')
        .first();
      
      metrics[contract.symbol] = {
        lastBlock: cursor?.last_block || 0,
        events: eventCount?.count || 0,
        transfers: transferCount?.count || 0,
      };
    }
    
    return metrics;
  }
}

export default AlchemyOptimizedIndexer;