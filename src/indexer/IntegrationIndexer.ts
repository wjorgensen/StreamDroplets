/**
 * Integration Protocol Indexer
 * Tracks user positions in integrated protocols (DEXs, Vaults, Lending)
 * Prevents double counting by tracking xUSD deposited into these protocols
 */

import { Alchemy, Network } from 'alchemy-sdk';
import { parseAbiItem, decodeEventLog, Address } from 'viem';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import EventEmitter from 'events';

const logger = createLogger('IntegrationIndexer');

// Common ERC20 events
const ERC20_EVENTS = {
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

// LP Pair events (Uniswap V2 style)
const LP_EVENTS = {
  Mint: parseAbiItem('event Mint(address indexed sender, uint256 amount0, uint256 amount1)'),
  Burn: parseAbiItem('event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)'),
  Sync: parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
  Transfer: ERC20_EVENTS.Transfer,
};

// ERC4626 Vault events
const VAULT_EVENTS = {
  Deposit: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
  Transfer: ERC20_EVENTS.Transfer,
};

// Compound/Aave style lending events (reference - using hardcoded topics below)
// @ts-ignore - Reference for event signatures
const _LENDING_EVENTS = {
  // Compound cToken style
  Mint: parseAbiItem('event Mint(address minter, uint256 mintAmount, uint256 mintTokens)'),
  Redeem: parseAbiItem('event Redeem(address redeemer, uint256 redeemAmount, uint256 redeemTokens)'),
  // Aave style
  Supply: parseAbiItem('event Supply(address indexed user, address indexed onBehalfOf, address indexed asset, uint256 amount, uint16 referralCode)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed user, address indexed to, address indexed asset, uint256 amount)'),
  Transfer: ERC20_EVENTS.Transfer,
};

interface IntegrationProtocol {
  id: number;
  protocol_name: string;
  integration_type: 'lp' | 'vault' | 'lending';
  chain_id: number;
  contract_address: string;
  underlying_asset: string;
  metadata: any;
  is_active: boolean;
}

export class IntegrationIndexer extends EventEmitter {
  private alchemy: Alchemy;
  private db = getDb();
  private protocols: Map<string, IntegrationProtocol> = new Map();
  private isRunning = false;

  constructor(private chainId: number, apiKey: string) {
    super();
    
    // Map chain ID to Alchemy network
    const network = this.getAlchemyNetwork(chainId);
    this.alchemy = new Alchemy({
      apiKey,
      network,
    });

    logger.info(`Initialized Integration Indexer for chain ${chainId}`);
  }

  private getAlchemyNetwork(chainId: number): Network {
    switch (chainId) {
      case 1: return Network.ETH_MAINNET;
      case 146: 
        // Sonic network - Alchemy supports it but SDK enum might not have it yet
        // Using the string value directly
        return 'sonic-mainnet' as Network;
      case 8453: return Network.BASE_MAINNET;
      case 42161: return Network.ARB_MAINNET;
      case 43114: 
        // Avalanche C-Chain
        return 'avalanche-mainnet' as Network;
      default: throw new Error(`Unsupported chain ID: ${chainId}`);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Integration indexer already running');
      return;
    }

    this.isRunning = true;
    logger.info(`Starting integration indexer for chain ${this.chainId}`);

    try {
      // Load active protocols for this chain
      await this.loadProtocols();

      // Index each protocol
      for (const protocol of this.protocols.values()) {
        await this.indexProtocol(protocol);
      }

      // Setup real-time monitoring
      await this.setupRealtimeMonitoring();

      this.emit('started');
    } catch (error) {
      logger.error('Failed to start integration indexer:', error);
      this.isRunning = false;
      throw error;
    }
  }

  private async loadProtocols(): Promise<void> {
    const protocols = await this.db('integration_protocols')
      .where({ chain_id: this.chainId, is_active: true });

    for (const protocol of protocols) {
      this.protocols.set(protocol.contract_address.toLowerCase(), {
        ...protocol,
        metadata: typeof protocol.metadata === 'string' ? JSON.parse(protocol.metadata) : protocol.metadata
      });
    }

    logger.info(`Loaded ${this.protocols.size} integration protocols for chain ${this.chainId}`);
  }

  private async indexProtocol(protocol: IntegrationProtocol): Promise<void> {
    logger.info(`Indexing protocol: ${protocol.protocol_name}`);

    // Get last indexed block
    const cursor = await this.db('integration_cursors')
      .where({ protocol_id: protocol.id })
      .first();

    const fromBlock = cursor ? Number(cursor.last_block) + 1 : 'earliest';
    const toBlock = 'latest';

    try {
      switch (protocol.integration_type) {
        case 'lp':
          await this.indexLPProtocol(protocol, fromBlock, toBlock);
          break;
        case 'vault':
          await this.indexVaultProtocol(protocol, fromBlock, toBlock);
          break;
        case 'lending':
          await this.indexLendingProtocol(protocol, fromBlock, toBlock);
          break;
      }
    } catch (error) {
      logger.error(`Failed to index protocol ${protocol.protocol_name}:`, error);
    }
  }

  private async indexLPProtocol(protocol: IntegrationProtocol, fromBlock: any, toBlock: any): Promise<void> {
    const address = protocol.contract_address as Address;

    // Get Mint events (liquidity additions)
    const mintLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f'], // Mint topic
      fromBlock,
      toBlock,
    });

    // Get Burn events (liquidity removals)
    const burnLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496'], // Burn topic
      fromBlock,
      toBlock,
    });

    // Get Transfer events (LP token transfers)
    const transferLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], // Transfer topic
      fromBlock,
      toBlock,
    });

    // Get Sync events to track reserves
    const syncLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'], // Sync topic
      fromBlock,
      toBlock,
    });

    // Process events
    await this.processLPEvents(protocol, [...mintLogs, ...burnLogs, ...transferLogs, ...syncLogs]);
  }

  private async indexVaultProtocol(protocol: IntegrationProtocol, fromBlock: any, toBlock: any): Promise<void> {
    const address = protocol.contract_address as Address;

    // Get Deposit events
    const depositLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7'], // Deposit topic
      fromBlock,
      toBlock,
    });

    // Get Withdraw events
    const withdrawLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db'], // Withdraw topic
      fromBlock,
      toBlock,
    });

    // Get Transfer events (share transfers)
    const transferLogs = await this.alchemy.core.getLogs({
      address,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], // Transfer topic
      fromBlock,
      toBlock,
    });

    // Process events
    await this.processVaultEvents(protocol, [...depositLogs, ...withdrawLogs, ...transferLogs]);
  }

  private async indexLendingProtocol(protocol: IntegrationProtocol, fromBlock: any, toBlock: any): Promise<void> {
    const address = protocol.contract_address as Address;
    const metadata = protocol.metadata;

    if (metadata.marketType === 'cToken') {
      // Compound-style cToken events
      const mintLogs = await this.alchemy.core.getLogs({
        address,
        topics: ['0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f'], // Mint topic
        fromBlock,
        toBlock,
      });

      const redeemLogs = await this.alchemy.core.getLogs({
        address,
        topics: ['0xe5b754fb1abb7f01b499791d0b820ae3b6af3424ac1c59768edb53f4ec31a929'], // Redeem topic
        fromBlock,
        toBlock,
      });

      await this.processLendingEvents(protocol, [...mintLogs, ...redeemLogs], 'compound');

    } else if (metadata.marketType === 'aave') {
      // Aave-style events from the pool contract
      const poolAddress = metadata.poolAddress as Address;
      
      const supplyLogs = await this.alchemy.core.getLogs({
        address: poolAddress,
        topics: ['0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61'], // Supply topic
        fromBlock,
        toBlock,
      });

      const withdrawLogs = await this.alchemy.core.getLogs({
        address: poolAddress,
        topics: ['0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7'], // Withdraw topic
        fromBlock,
        toBlock,
      });

      // Also track aToken transfers
      const aTokenAddress = metadata.aTokenAddress as Address;
      const transferLogs = await this.alchemy.core.getLogs({
        address: aTokenAddress,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], // Transfer topic
        fromBlock,
        toBlock,
      });

      await this.processLendingEvents(protocol, [...supplyLogs, ...withdrawLogs, ...transferLogs], 'aave');
    }
  }

  private async processLPEvents(protocol: IntegrationProtocol, logs: any[]): Promise<void> {
    const batch = [];
    let latestReserves = { reserve0: 0n, reserve1: 0n, totalSupply: 0n };

    for (const log of logs) {
      try {
        const topic = log.topics[0];
        const blockNumber = Number(log.blockNumber);
        const timestamp = await this.getBlockTimestamp(blockNumber);

        // Decode based on event type
        if (topic === '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1') {
          // Sync event - update reserves
          const decoded = decodeEventLog({
            abi: [LP_EVENTS.Sync],
            data: log.data,
            topics: log.topics,
          });

          latestReserves = {
            reserve0: BigInt(decoded.args.reserve0),
            reserve1: BigInt(decoded.args.reserve1),
            totalSupply: latestReserves.totalSupply, // Keep existing supply
          };

          // Save reserves snapshot
          await this.db('lp_pool_reserves').insert({
            protocol_id: protocol.id,
            reserve0: latestReserves.reserve0.toString(),
            reserve1: latestReserves.reserve1.toString(),
            total_supply: latestReserves.totalSupply.toString(),
            block_number: blockNumber,
            timestamp,
          });

        } else if (topic === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
          // Transfer event - track LP token movements
          const decoded = decodeEventLog({
            abi: [ERC20_EVENTS.Transfer],
            data: log.data,
            topics: log.topics,
          });

          const from = decoded.args.from as string;
          const to = decoded.args.to as string;
          const value = BigInt(decoded.args.value);

          // Update positions for both parties
          if (from !== '0x0000000000000000000000000000000000000000') {
            await this.updateLPPosition(protocol, from, -value, blockNumber, timestamp);
          }
          if (to !== '0x0000000000000000000000000000000000000000') {
            await this.updateLPPosition(protocol, to, value, blockNumber, timestamp);
          }

          // Record event
          batch.push({
            protocol_id: protocol.id,
            event_type: 'transfer',
            user_address: from.toLowerCase(),
            shares_delta: (-value).toString(),
            block_number: blockNumber,
            timestamp,
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          });

          if (to !== '0x0000000000000000000000000000000000000000') {
            batch.push({
              protocol_id: protocol.id,
              event_type: 'transfer',
              user_address: to.toLowerCase(),
              shares_delta: value.toString(),
              block_number: blockNumber,
              timestamp,
              tx_hash: log.transactionHash,
              log_index: log.logIndex + 1000, // Offset to avoid unique constraint
            });
          }
        }
      } catch (error) {
        logger.error(`Failed to process LP event:`, error);
      }
    }

    // Batch insert events
    if (batch.length > 0) {
      await this.db('integration_events').insert(batch).onConflict(['tx_hash', 'log_index']).ignore();
    }

    // Update cursor
    if (logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      await this.updateCursor(protocol.id, Number(lastLog.blockNumber), lastLog.transactionHash, lastLog.logIndex);
    }
  }

  private async processVaultEvents(protocol: IntegrationProtocol, logs: any[]): Promise<void> {
    const batch = [];

    for (const log of logs) {
      try {
        const topic = log.topics[0];
        const blockNumber = Number(log.blockNumber);
        const timestamp = await this.getBlockTimestamp(blockNumber);

        if (topic === '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7') {
          // Deposit event
          const decoded = decodeEventLog({
            abi: [VAULT_EVENTS.Deposit],
            data: log.data,
            topics: log.topics,
          });

          const owner = decoded.args.owner as string;
          const assets = BigInt(decoded.args.assets);
          const shares = BigInt(decoded.args.shares);

          await this.updateVaultPosition(protocol, owner, shares, assets, blockNumber, timestamp);

          batch.push({
            protocol_id: protocol.id,
            event_type: 'deposit',
            user_address: owner.toLowerCase(),
            shares_delta: shares.toString(),
            underlying_delta: assets.toString(),
            block_number: blockNumber,
            timestamp,
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          });

        } else if (topic === '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db') {
          // Withdraw event
          const decoded = decodeEventLog({
            abi: [VAULT_EVENTS.Withdraw],
            data: log.data,
            topics: log.topics,
          });

          const owner = decoded.args.owner as string;
          const assets = BigInt(decoded.args.assets);
          const shares = BigInt(decoded.args.shares);

          await this.updateVaultPosition(protocol, owner, -shares, -assets, blockNumber, timestamp);

          batch.push({
            protocol_id: protocol.id,
            event_type: 'withdraw',
            user_address: owner.toLowerCase(),
            shares_delta: (-shares).toString(),
            underlying_delta: (-assets).toString(),
            block_number: blockNumber,
            timestamp,
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          });

        } else if (topic === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
          // Transfer event - handle share transfers between users
          const decoded = decodeEventLog({
            abi: [ERC20_EVENTS.Transfer],
            data: log.data,
            topics: log.topics,
          });

          const from = decoded.args.from as string;
          const to = decoded.args.to as string;
          const value = BigInt(decoded.args.value);

          // For transfers, we need to calculate the underlying amount based on exchange rate
          const exchangeRate = await this.getVaultExchangeRate(protocol, blockNumber);
          const underlyingAmount = (value * exchangeRate.rate) / exchangeRate.scale;

          if (from !== '0x0000000000000000000000000000000000000000') {
            await this.updateVaultPosition(protocol, from, -value, -underlyingAmount, blockNumber, timestamp);
          }
          if (to !== '0x0000000000000000000000000000000000000000') {
            await this.updateVaultPosition(protocol, to, value, underlyingAmount, blockNumber, timestamp);
          }
        }
      } catch (error) {
        logger.error(`Failed to process vault event:`, error);
      }
    }

    // Batch insert events
    if (batch.length > 0) {
      await this.db('integration_events').insert(batch).onConflict(['tx_hash', 'log_index']).ignore();
    }

    // Update cursor
    if (logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      await this.updateCursor(protocol.id, Number(lastLog.blockNumber), lastLog.transactionHash, lastLog.logIndex);
    }
  }

  private async processLendingEvents(protocol: IntegrationProtocol, logs: any[], _type: 'compound' | 'aave'): Promise<void> {
    const batch: any[] = [];

    for (const _log of logs) {
      try {
        // Process log - blockNumber available in log when needed
        // const blockNumber = Number(log.blockNumber);
        // const timestamp = await this.getBlockTimestamp(blockNumber);

        // Process based on lending protocol type
        // Implementation details would go here for each event type
        // Similar structure to vault events but with lending-specific logic
      } catch (error) {
        logger.error(`Failed to process lending event:`, error);
      }
    }

    // Batch insert events
    if (batch.length > 0) {
      await this.db('integration_events').insert(batch).onConflict(['tx_hash', 'log_index']).ignore();
    }

    // Update cursor
    if (logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      await this.updateCursor(protocol.id, Number(lastLog.blockNumber), lastLog.transactionHash, lastLog.logIndex);
    }
  }

  private async updateLPPosition(
    protocol: IntegrationProtocol,
    user: string,
    sharesDelta: bigint,
    blockNumber: number,
    timestamp: Date
  ): Promise<void> {
    // Get current position
    const position = await this.db('integration_positions')
      .where({ protocol_id: protocol.id, user_address: user.toLowerCase() })
      .first();

    const currentShares = position ? BigInt(position.position_shares) : 0n;
    const newShares = currentShares + sharesDelta;

    if (newShares <= 0n) {
      // Remove position if zero or negative
      await this.db('integration_positions')
        .where({ protocol_id: protocol.id, user_address: user.toLowerCase() })
        .delete();
    } else {
      // Calculate underlying xUSD amount based on reserves
      const reserves = await this.db('lp_pool_reserves')
        .where({ protocol_id: protocol.id })
        .orderBy('block_number', 'desc')
        .first();

      if (reserves) {
        const totalSupply = BigInt(reserves.total_supply);
        const reserve0 = BigInt(reserves.reserve0);
        const reserve1 = BigInt(reserves.reserve1);

        // Assuming xUSD is token0 in the metadata
        const xUSDReserve = protocol.metadata.token0 === 'xUSD' ? reserve0 : reserve1;
        const userXUSD = totalSupply > 0n ? (newShares * xUSDReserve) / totalSupply : 0n;

        // USD value (xUSD ≈ $1)
        const usdValue = userXUSD;

        // Update or insert position
        await this.db('integration_positions')
          .insert({
            protocol_id: protocol.id,
            user_address: user.toLowerCase(),
            position_shares: newShares.toString(),
            underlying_amount: userXUSD.toString(),
            usd_value: usdValue.toString(),
            block_number: blockNumber,
            timestamp,
            last_updated: timestamp,
          })
          .onConflict(['protocol_id', 'user_address'])
          .merge();
      }
    }
  }

  private async updateVaultPosition(
    protocol: IntegrationProtocol,
    user: string,
    sharesDelta: bigint,
    assetsDelta: bigint,
    blockNumber: number,
    timestamp: Date
  ): Promise<void> {
    // Get current position
    const position = await this.db('integration_positions')
      .where({ protocol_id: protocol.id, user_address: user.toLowerCase() })
      .first();

    const currentShares = position ? BigInt(position.position_shares) : 0n;
    const currentAssets = position ? BigInt(position.underlying_amount) : 0n;
    
    const newShares = currentShares + sharesDelta;
    const newAssets = currentAssets + assetsDelta;

    if (newShares <= 0n) {
      // Remove position if zero or negative
      await this.db('integration_positions')
        .where({ protocol_id: protocol.id, user_address: user.toLowerCase() })
        .delete();
    } else {
      // USD value (xUSD ≈ $1)
      const usdValue = newAssets;

      // Update or insert position
      await this.db('integration_positions')
        .insert({
          protocol_id: protocol.id,
          user_address: user.toLowerCase(),
          position_shares: newShares.toString(),
          underlying_amount: newAssets.toString(),
          usd_value: usdValue.toString(),
          block_number: blockNumber,
          timestamp,
          last_updated: timestamp,
        })
        .onConflict(['protocol_id', 'user_address'])
        .merge();
    }
  }

  private async getVaultExchangeRate(protocol: IntegrationProtocol, blockNumber: number): Promise<{ rate: bigint, scale: bigint }> {
    // Get cached exchange rate or fetch from chain
    const cached = await this.db('vault_exchange_rates')
      .where({ protocol_id: protocol.id })
      .where('block_number', '<=', blockNumber)
      .orderBy('block_number', 'desc')
      .first();

    if (cached) {
      return {
        rate: BigInt(cached.exchange_rate),
        scale: BigInt(cached.rate_scale),
      };
    }

    // Default 1:1 if no rate found
    return { rate: 10n ** 18n, scale: 10n ** 18n };
  }

  private async getBlockTimestamp(blockNumber: number): Promise<Date> {
    try {
      const block = await this.alchemy.core.getBlock(blockNumber);
      return new Date(block.timestamp * 1000);
    } catch {
      return new Date();
    }
  }

  private async updateCursor(protocolId: number, blockNumber: number, txHash: string, logIndex: number): Promise<void> {
    await this.db('integration_cursors')
      .insert({
        protocol_id: protocolId,
        last_block: blockNumber,
        last_tx_hash: txHash,
        last_log_index: logIndex,
        updated_at: new Date(),
      })
      .onConflict('protocol_id')
      .merge();
  }

  private async setupRealtimeMonitoring(): Promise<void> {
    // Setup WebSocket subscriptions for each protocol
    for (const protocol of this.protocols.values()) {
      try {
        // Subscribe to events for this protocol
        this.alchemy.ws.on({
          address: protocol.contract_address,
        }, async (log) => {
          // Process new events in real-time
          logger.debug(`New event for ${protocol.protocol_name}:`, log);
          // Process based on protocol type
        });
      } catch (error) {
        logger.error(`Failed to setup monitoring for ${protocol.protocol_name}:`, error);
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    // Clean up WebSocket connections
    await this.alchemy.ws.removeAllListeners();
    logger.info('Integration indexer stopped');
  }
}