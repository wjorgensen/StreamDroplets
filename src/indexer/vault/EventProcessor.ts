import { parseAbiItem, decodeEventLog, getAddress } from 'viem';
import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';
import { checkZeroAddress, isIntegrationAddress, INTEGRATION_CONTRACTS } from '../../config/contracts';
import { CONSTANTS, IndexerContractConfig } from '../../config/constants';

const logger = createLogger('EventProcessor');

export const EVENT_SIGNATURES = {
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

export class EventProcessor {
  private db = getDb();

  private readonly SILO_ROUTER_ADDRESSES: Record<number, string> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.ROUTER,
    [CONSTANTS.CHAIN_IDS.AVALANCHE]: INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.ROUTER,
  };

  private readonly SILO_VAULT_ADDRESSES: Record<number, string[]> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_1,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_2,
    ],
    [CONSTANTS.CHAIN_IDS.AVALANCHE]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.XUSD_VAULT,
    ],
  };

  private readonly SHADOW_ROUTER_ADDRESSES: Record<number, string> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.ROUTER,
  };

  private readonly SHADOW_POOL_ADDRESSES: Record<number, string[]> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: [
      INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_HLP0_POOL,
      INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_ASONUSDC_POOL,
    ],
  };

  constructor() {
  }

  /**
   * Check if an address is a Silo router address for the given chain
   */
  private isRouterAddress(chainId: number, address: string): boolean {
    const routerAddress = this.SILO_ROUTER_ADDRESSES[chainId];
    return Boolean(routerAddress && getAddress(address) === getAddress(routerAddress));
  }

  /**
   * Check if an address is a Silo vault address for the given chain
   */
  private isSiloVaultAddress(chainId: number, address: string): boolean {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[chainId];
    return vaultAddresses?.some(vault => getAddress(address) === getAddress(vault)) || false;
  }

  /**
   * Check if an address is a Shadow router address for the given chain
   */
  private isShadowRouterAddress(chainId: number, address: string): boolean {
    const routerAddress = this.SHADOW_ROUTER_ADDRESSES[chainId];
    return Boolean(routerAddress && getAddress(address) === getAddress(routerAddress));
  }

  /**
   * Check if an address is a Shadow pool address for the given chain
   */
  private isShadowPoolAddress(chainId: number, address: string): boolean {
    const poolAddresses = this.SHADOW_POOL_ADDRESSES[chainId];
    return poolAddresses?.some(pool => getAddress(address) === getAddress(pool)) || false;
  }

  /**
   * Converts event date string to timestamp for database storage
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }

  /**
   * Processes a single event log and stores relevant events in daily_events table
   */
  async processEventLog(log: any, contract: IndexerContractConfig, eventDate: string): Promise<void> {
    let eventName = 'Unknown';
    try {
      let decodedLog: any = null;
      
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
          continue;
        }
      }
      
      
      if (decodedLog) {
        logger.info(`Processing ${eventName} event for ${contract.symbol} on chain ${contract.chainId}`, {
          eventName,
          args: decodedLog.args,
          blockNumber: typeof log.blockNumber === 'string' ? parseInt(log.blockNumber, 16) : log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          contractAddress: contract.address
        });
        await this.processSpecificEvent(eventName, decodedLog.args, log, contract, eventDate);
      }
      
    } catch (error: any) {
      logger.error(`Error processing event log: ${error.message}`, {
        error: error.stack,
        eventName: eventName,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        contract: contract.symbol
      });
    }
  }

  /**
   * Handles specific event types and stores relevant events in daily_events table
   */
  private async processSpecificEvent(
    eventName: string,
    args: any,
    log: any,
    contract: IndexerContractConfig,
    eventDate: string
  ): Promise<void> {
    const blockNumber = typeof log.blockNumber === 'string' 
      ? parseInt(log.blockNumber, 16) 
      : log.blockNumber;
    const timestamp = this.getEventTimestamp(eventDate);
    
    switch (eventName) {
      case 'Unstake':
        logger.info(`Processing Unstake event details`, {
          account: args.account.toLowerCase(),
          amount: args.amount.toString(),
          asset: contract.symbol,
          chainId: contract.chainId,
          blockNumber,
          txHash: log.transactionHash
        });
        await this.db('daily_events').insert({
          from_address: args.account.toLowerCase(),
          to_address: null,
          asset: contract.symbol,
          chain_id: contract.chainId,
          event_date: eventDate,
          event_type: 'unstake',
          amount_delta: `-${args.amount.toString()}`,
          block_number: blockNumber,
          timestamp: timestamp,
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
          round: args.round.toString(),
          isIntegrationAddress: null,
          created_at: new Date(),
        });
        break;
        
      case 'Redeem':
        const redeemShares = args.share ? args.share.toString() : args.shares?.toString() || '0';
        
        logger.info(`Processing Redeem event details`, {
          account: args.account.toLowerCase(),
          shares: redeemShares,
          asset: contract.symbol,
          chainId: contract.chainId,
          blockNumber,
          txHash: log.transactionHash
        });
        
        await this.db('daily_events').insert({
          from_address: args.account.toLowerCase(),
          to_address: null,
          asset: contract.symbol,
          chain_id: contract.chainId,
          event_date: eventDate,
          event_type: 'redeem',
          amount_delta: redeemShares,
          block_number: blockNumber,
          timestamp: timestamp,
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
          round: null,
          isIntegrationAddress: null,
          created_at: new Date(),
        });
        break;
        
      case 'Transfer':
        logger.info(`Processing Transfer event details`, {
          from: args.from.toLowerCase(),
          to: args.to.toLowerCase(),
          value: args.value.toString(),
          asset: contract.symbol,
          chainId: contract.chainId,
          blockNumber,
          txHash: log.transactionHash
        });
        await this.handleTransferEvent(args, contract, blockNumber, timestamp, log);
        break;
    }
  }


  /**
   * Handles Transfer events and logs them to daily_events table with integration address detection
   */
  private async handleTransferEvent(
    args: any,
    contract: IndexerContractConfig,
    blockNumber: number,
    timestamp: Date,
    log: any
  ): Promise<void> {
    const fromAddr = args.from.toLowerCase();
    const toAddr = args.to.toLowerCase();
    const contractAddr = contract.address.toLowerCase();
    const amount = args.value.toString();

    if (BigInt(amount) === BigInt(0)) {
      logger.debug('Skipping zero-value transfer for daily_events insertion', {
        from: fromAddr,
        to: toAddr,
        asset: contract.symbol,
        chainId: contract.chainId,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      });
      return;
    }
    const eventDate = timestamp.toISOString().split('T')[0];
     
    if (!checkZeroAddress(fromAddr) && !checkZeroAddress(toAddr) && 
        fromAddr !== contractAddr && toAddr !== contractAddr) {
      let integrationAddressType: string | null = null;
      const isSiloChain = contract.chainId === CONSTANTS.CHAIN_IDS.SONIC || contract.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE;

      if (isSiloChain) {
        const fromIsRouter = this.isRouterAddress(contract.chainId, fromAddr);
        const toIsRouter = this.isRouterAddress(contract.chainId, toAddr);
        const fromIsVault = this.isSiloVaultAddress(contract.chainId, fromAddr);
        const toIsVault = this.isSiloVaultAddress(contract.chainId, toAddr);

        if (fromIsRouter && toIsVault) {
          integrationAddressType = 'siloRouter';
        } else if (!fromIsRouter && (toIsRouter || toIsVault)) {
          integrationAddressType = 'silo_pending_to';
        } else if (!toIsRouter && (fromIsRouter || fromIsVault)) {
          integrationAddressType = 'silo_pending_from';
        }
      }

      if (!integrationAddressType) {
        if (await isIntegrationAddress(fromAddr, contract.chainId)) {
          integrationAddressType = 'from';
        } else if (await isIntegrationAddress(toAddr, contract.chainId)) {
          integrationAddressType = 'to';
        } else if (contract.chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          const fromIsShadowRouter = this.isShadowRouterAddress(contract.chainId, fromAddr);
          const toIsShadowRouter = this.isShadowRouterAddress(contract.chainId, toAddr);
          const fromIsShadowPool = this.isShadowPoolAddress(contract.chainId, fromAddr);
          const toIsShadowPool = this.isShadowPoolAddress(contract.chainId, toAddr);
          
          if ((fromIsShadowRouter && toIsShadowPool) || (fromIsShadowPool && toIsShadowRouter)) {
            logger.debug('Skipping transfer between Shadow router and pool', {
              from: fromAddr,
              to: toAddr,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
            });
            return;
          }
          
          if (fromIsShadowPool && toIsShadowPool) {
            logger.debug('Skipping transfer between shadow pools', {
              from: fromAddr,
              to: toAddr,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
            });
            return;
          }
          
          if (toIsShadowRouter && !fromIsShadowRouter) {
            integrationAddressType = 'shadow_pending_to';
          } else if (fromIsShadowRouter && !toIsShadowRouter) {
            integrationAddressType = 'shadow_pending_from';
          }
          else if (toIsShadowPool && !fromIsShadowPool && !fromIsShadowRouter) {
            integrationAddressType = 'shadow_to';
          } else if (fromIsShadowPool && !toIsShadowPool && !toIsShadowRouter) {
            integrationAddressType = 'shadow_from';
          }
        }
      }
      
      logger.info(`Inserting Transfer event into daily_events`, {
        from_address: fromAddr,
        to_address: toAddr,
        amount_delta: amount,
        asset: contract.symbol,
        chain_id: contract.chainId,
        integration_type: integrationAddressType,
        event_type: 'transfer',
        block_number: blockNumber,
        tx_hash: log.transactionHash
      });
      
      await this.db('daily_events').insert({
        from_address: fromAddr,
        to_address: toAddr,
        asset: contract.symbol,
        chain_id: contract.chainId,
        event_date: eventDate,
        event_type: 'transfer',
        amount_delta: amount,
        block_number: blockNumber,
        timestamp: timestamp,
        tx_hash: log.transactionHash,
        log_index: log.logIndex,
        round: null,
        isIntegrationAddress: integrationAddressType,
        created_at: new Date(),
      });
    }
  }

  /**
   * Decodes and validates a log entry, returning processed event data
   */
  decodeAndValidateLog(log: any, contract: IndexerContractConfig): any {
    let eventName = 'Unknown';
    let decodedLog: any = null;
    
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
        continue;
      }
    }
    
    if (!decodedLog) {
      return null;
    }
    
    return {
      eventName,
      args: decodedLog.args,
      log,
      contract,
    };
  }
}
