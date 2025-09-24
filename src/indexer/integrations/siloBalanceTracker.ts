/**
 * Silo Finance Balance Tracker
 * Tracks ERC-4626 vault positions in Silo lending markets
 * Supports multiple vaults across Sonic and Avalanche chains
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS } from '../../config/constants';
import { INTEGRATION_CONTRACTS } from '../../config/contracts';
import { SILO_VAULT_ABI } from '../../config/abis/siloVault';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('SiloBalanceTracker');

export interface SiloEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'silo_finance';
  protocolType: 'vault';
  eventType: 'deposit' | 'withdraw' | 'transfer' | 'deposit_protected' | 'withdraw_protected';
  userAddress: string;
  amount?: string; // For transfer, this is shares; for deposit/withdraw this is assets
  shares?: string; // For deposit/withdraw, this is the shares amount
  assets?: string; // For deposit/withdraw, this is the assets amount
  fromAddress?: string; // For transfers
  toAddress?: string; // For transfers
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class SiloBalanceTracker {
  private readonly SILO_VAULT_ADDRESSES: Record<number, string[]> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_1,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_2,
    ],
    [CONSTANTS.CHAIN_IDS.AVALANCHE]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.XUSD_VAULT,
    ],
  };

  
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Silo Balance Tracker');
  }

  /**
   * Fetch and process all Silo vault events for a specific block range
   */
  async processSiloEvents(
    chainId: number,
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[chainId];
    if (!vaultAddresses || vaultAddresses.length === 0) {
      logger.warn(`No Silo vaults configured for chain ${chainId}`);
      return;
    }

    logger.info(`Processing Silo vault events from blocks ${fromBlock} to ${toBlock} on chain ${chainId}`);
    
    try {
      const allEvents: SiloEvent[] = [];
      
      // Process events from all vaults on this chain
      for (const vaultAddress of vaultAddresses) {
        const events = await this.fetchVaultEvents(chainId, vaultAddress, fromBlock, toBlock);
        allEvents.push(...events);
      }
      
      if (allEvents.length === 0) {
        logger.debug(`No Silo vault events found in block range for chain ${chainId}`);
        return;
      }
      
      await this.storeEvents(allEvents, eventDate);
      await this.updateUserBalances(allEvents, eventDate);
      
      logger.info(`Processed ${allEvents.length} Silo vault events on chain ${chainId}`);
    } catch (error) {
      logger.error(`Failed to process Silo vault events on chain ${chainId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch events from a specific Silo vault contract
   */
  private async fetchVaultEvents(
    chainId: number,
    vaultAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<SiloEvent[]> {
    const events: SiloEvent[] = [];

    try {
      const alchemyInstance = this.alchemyService.getAlchemyInstance(chainId);
      const logs = await withAlchemyRetry(async () => {
        return await alchemyInstance.core.getLogs({
          address: vaultAddress,
          fromBlock,
          toBlock,
        });
      }, `Silo Finance getLogs for vault ${vaultAddress} (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodeLogToEvent(log, chainId, vaultAddress);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
        }
      }

      logger.debug(`Fetched ${events.length} events from Silo vault ${vaultAddress} on chain ${chainId}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Silo vault ${vaultAddress}:`, error);
      return [];
    }
  }

  /**
   * Decode a log to a SiloEvent
   */
  private async decodeLogToEvent(log: any, chainId: number, contractAddress: string): Promise<SiloEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: SILO_VAULT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

      switch ((decodedLog as any).eventName) {
        case 'Deposit': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'deposit',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'DepositProtected': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'deposit_protected',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Withdraw': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'withdraw',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'WithdrawProtected': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'withdraw_protected',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Transfer': {
          const { from, to, value } = decodedLog.args as any;
          
          // Skip mint/burn transactions (to/from zero address)
          const { checkZeroAddress } = require('../../config/contracts');
          if (checkZeroAddress(from) || checkZeroAddress(to)) {
            return null;
          }

          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'transfer',
            userAddress: getAddress(to as string),
            amount: value.toString(),
            shares: value.toString(),
            fromAddress: getAddress(from as string),
            toAddress: getAddress(to as string),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        default:
          logger.warn(`Unknown event type: ${(decodedLog as any).eventName}`);
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode log to event:', error);
      return null;
    }
    
    return null;
  }


  async getCurrentPricePerShare(chainId: number, vaultAddress: string, blockNumber: number): Promise<bigint> {
    try {
      const viemClient = this.alchemyService.getViemClient(chainId);
      
      const pricePerShare = await withAlchemyRetry(async () => {
        return await viemClient.readContract({
          address: vaultAddress as `0x${string}`,
          abi: SILO_VAULT_ABI,
          functionName: 'convertToAssets',
          args: [BigInt(1e18)],
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `Silo Finance price per share for vault ${vaultAddress} at block ${blockNumber}`);
      
      if (pricePerShare <= 0n) {
        throw new Error(`Invalid price per share returned: ${pricePerShare}`);
      }
      
      logger.debug(`Silo vault ${vaultAddress} price per share at block ${blockNumber}: ${Number(pricePerShare) / 1e18}`);
      return pricePerShare;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Check if this is a contract not deployed error
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Silo vault ${vaultAddress} not deployed at block ${blockNumber}, skipping price per share calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get price per share from Silo vault ${vaultAddress} at block ${blockNumber}:`, error);
      throw new Error(`Unable to get Silo vault price per share: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateBalancesWithPricePerShare(chainId: number, blockNumber: number): Promise<void> {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[chainId];
    if (!vaultAddresses || vaultAddresses.length === 0) {
      logger.warn(`No Silo vaults configured for chain ${chainId}`);
      return;
    }

    logger.info(`Updating Silo balances with price per share on chain ${chainId} at block ${blockNumber}`);
    
    try {
      for (const vaultAddress of vaultAddresses) {
        await this.updateVaultBalancesWithPricePerShare(chainId, vaultAddress, blockNumber);
      }
    } catch (error) {
      logger.error(`Failed to update Silo balances with price per share on chain ${chainId}:`, error);
      throw error;
    }
  }

  /**
   * Update balances for a specific vault
   */
  private async updateVaultBalancesWithPricePerShare(
    chainId: number,
    vaultAddress: string,
    blockNumber: number
  ): Promise<void> {
    try {
      const pricePerShare = await this.getCurrentPricePerShare(chainId, vaultAddress, blockNumber);
      
      const positions = await this.db('integration_balances')
        .where({
          protocol_name: 'silo_finance',
          chain_id: chainId,
          contract_address: vaultAddress.toLowerCase(),
        })
        .where('position_shares', '>', '0');

      let updatedPositions = 0;

      for (const position of positions) {
        const shares = BigInt(position.position_shares);
        const newUnderlyingAssets = (shares * pricePerShare) / (10n ** 18n);
        
        const currentUnderlying = BigInt(position.underlying_assets || '0');
        const changeThreshold = currentUnderlying / 1000n; // 0.1% threshold

        if (newUnderlyingAssets > currentUnderlying + changeThreshold || 
            newUnderlyingAssets < currentUnderlying - changeThreshold) {
          
          await this.db('integration_balances')
            .where({ id: position.id })
            .update({
              underlying_assets: newUnderlyingAssets.toString(),
              last_updated: new Date(),
            });

          updatedPositions++;
        }
      }

      logger.info(`Updated ${updatedPositions} Silo positions for vault ${vaultAddress} with PPS: ${Number(pricePerShare) / 1e18}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Check if this is a contract not deployed error
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Silo vault ${vaultAddress} not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error(`Failed to update balances for Silo vault ${vaultAddress}:`, error);
      throw error;
    }
  }

  /**
   * Store events in the daily_integration_events table
   */
  private async storeEvents(events: SiloEvent[], eventDate: string): Promise<void> {
    if (events.length === 0) return;
    
    const eventRecords = events.map(event => ({
      address: event.userAddress.toLowerCase(),
      asset: 'xUSD',
      chain_id: event.chainId,
      protocol_name: event.protocolName,
      protocol_type: event.protocolType,
      contract_address: event.contractAddress.toLowerCase(),
      event_date: eventDate,
      event_type: event.eventType,
      amount_delta: this.getAmountDelta(event),
      shares_delta: this.getSharesDelta(event),
      block_number: event.blockNumber,
      timestamp: event.timestamp,
      tx_hash: event.txHash,
      log_index: event.logIndex,
      counterparty_address: event.fromAddress?.toLowerCase() || null,
    }));

    await this.db('daily_integration_events')
      .insert(eventRecords)
      .onConflict(['chain_id', 'tx_hash', 'log_index'])
      .ignore();
      
    logger.debug(`Stored ${eventRecords.length} Silo events`);
  }

  /**
   * Calculate amount delta based on event type
   */
  private getAmountDelta(event: SiloEvent): string {
    switch (event.eventType) {
      case 'deposit':
      case 'deposit_protected':
        return event.assets || '0';
      case 'withdraw':
      case 'withdraw_protected':
        return `-${event.assets || '0'}`;
      case 'transfer':
        return event.shares || '0';
      default:
        return '0';
    }
  }

  /**
   * Calculate shares delta based on event type
   */
  private getSharesDelta(event: SiloEvent): string {
    switch (event.eventType) {
      case 'deposit':
      case 'deposit_protected':
        return event.shares || '0';
      case 'withdraw':
      case 'withdraw_protected':
        return `-${event.shares || '0'}`;
      case 'transfer':
        return event.shares || '0';
      default:
        return '0';
    }
  }

  /**
   * Update user balances based on events
   */
  private async updateUserBalances(events: SiloEvent[], eventDate: string): Promise<void> {
    // Group events by user and vault
    const userVaultEvents = new Map<string, SiloEvent[]>();
    
    for (const event of events) {
      const userVaultKey = `${event.userAddress.toLowerCase()}_${event.contractAddress.toLowerCase()}_${event.chainId}`;
      if (!userVaultEvents.has(userVaultKey)) {
        userVaultEvents.set(userVaultKey, []);
      }
      userVaultEvents.get(userVaultKey)!.push(event);
    }

    for (const [userVaultKey, userEventList] of userVaultEvents) {
      const [userAddress, contractAddress, chainIdStr] = userVaultKey.split('_');
      const chainId = parseInt(chainIdStr);
      
      let netShareChange = 0n;
      
      for (const event of userEventList) {
        const delta = this.calculateShareDelta(event);
        netShareChange += delta;
      }

      if (netShareChange !== 0n) {
        await this.updateUserBalance(
          userAddress, 
          contractAddress, 
          chainId, 
          netShareChange, 
          userEventList[0].blockNumber,
          eventDate
        );
      }
    }
  }

  /**
   * Calculate share delta for balance updates
   */
  private calculateShareDelta(event: SiloEvent): bigint {
    switch (event.eventType) {
      case 'deposit':
      case 'deposit_protected':
        return BigInt(event.shares || '0');
      case 'withdraw':
      case 'withdraw_protected':
        return -BigInt(event.shares || '0');
      case 'transfer':
        // For transfers, we need to check if this user is receiving or sending
        return BigInt(event.shares || '0');
      default:
        return 0n;
    }
  }

  /**
   * Update a single user's balance for a specific vault
   */
  private async updateUserBalance(
    userAddress: string, 
    contractAddress: string,
    chainId: number,
    shareChange: bigint, 
    blockNumber: number,
    eventDate: string
  ): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: chainId,
        contract_address: contractAddress.toLowerCase(),
        protocol_name: 'silo_finance',
      })
      .first();

    const currentShares = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newShares = currentShares + shareChange;

    if (newShares < 0n) {
      logger.warn(`Negative balance detected for ${userAddress} in vault ${contractAddress}: ${newShares}`);
    }

    // For now, set underlying assets equal to shares - will be updated by price per share update
    const underlyingAssets = newShares;

    if (currentBalance) {
      await this.db('integration_balances')
        .where({ id: currentBalance.id })
        .update({
          position_shares: newShares.toString(),
          underlying_assets: underlyingAssets.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    } else {
      await this.db('integration_balances')
        .insert({
          address: userAddress,
          asset: 'xUSD',
          chain_id: chainId,
          protocol_name: 'silo_finance',
          contract_address: contractAddress.toLowerCase(),
          position_shares: newShares.toString(),
          underlying_assets: underlyingAssets.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    }
  }
}
