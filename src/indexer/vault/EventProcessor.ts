import { parseAbiItem, decodeEventLog, getAddress } from 'viem';
import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';
import { checkZeroAddress, isIntegrationAddress, isShadowAddress, INTEGRATION_CONTRACTS } from '../../config/contracts';
import { CONSTANTS, IndexerContractConfig } from '../../config/constants';

const logger = createLogger('EventProcessor');

export const EVENT_SIGNATURES = {
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  OFTSent: parseAbiItem('event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)'),
  OFTReceived: parseAbiItem('event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)'),
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

  constructor() {
  }

  /**
   * Convert LayerZero EID to chain ID
   */
  private eidToChainId(eid: number): number {
    const chainId = CONSTANTS.LAYERZERO_EID_TO_CHAIN_ID[eid as keyof typeof CONSTANTS.LAYERZERO_EID_TO_CHAIN_ID];
    if (!chainId) {
      throw new Error(`Unknown LayerZero EID: ${eid}`);
    }
    return chainId;
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
   * Processes a single event log and stores relevant events in daily_events table
   */
  async processEventLog(log: any, contract: IndexerContractConfig): Promise<void> {
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
        await this.processSpecificEvent(eventName, decodedLog.args, log, contract);
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
    contract: IndexerContractConfig
  ): Promise<void> {
    const blockNumber = typeof log.blockNumber === 'string' 
      ? parseInt(log.blockNumber, 16) 
      : log.blockNumber;
    const timestamp = new Date();
    
    const eventDate = timestamp.toISOString().split('T')[0];
    
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
          round: args.round.toString(), // Store round for unstake events
          isIntegrationAddress: null,
          created_at: new Date(),
        }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
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
          round: null, // No round for redeem events
          isIntegrationAddress: null,
          created_at: new Date(),
        }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
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
        
      case 'OFTSent':
        const destChainId = this.eidToChainId(args.dstEid);
        
        logger.info(`Processing OFTSent event`, {
          guid: args.guid,
          from: args.fromAddress.toLowerCase(),
          amountSentLD: args.amountSentLD.toString(),
          amountReceivedLD: args.amountReceivedLD.toString(),
          asset: contract.symbol,
          sourceChainId: contract.chainId,
          destChainId: destChainId,
          blockNumber,
          txHash: log.transactionHash
        });
        
        // Store as daily event (tokens being sent/burned from source chain)
        await this.db('daily_events').insert({
          from_address: args.fromAddress.toLowerCase(),
          to_address: null, // OFT burns tokens, no direct recipient on this chain
          asset: contract.symbol,
          chain_id: contract.chainId,
          event_date: eventDate,
          event_type: 'oft_sent',
          amount_delta: `-${args.amountSentLD.toString()}`, // Negative because tokens are burned
          block_number: blockNumber,
          timestamp: timestamp,
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
          round: null, // No round for OFT events
          isIntegrationAddress: null,
          oft_guid: args.guid,
          dest_chain_id: destChainId,
          created_at: new Date(),
        }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
        break;
        
      case 'OFTReceived':
        const sourceChainId = this.eidToChainId(args.srcEid);
        
        logger.info(`Processing OFTReceived event`, {
          guid: args.guid,
          toAddress: args.toAddress.toLowerCase(),
          amount: args.amountReceivedLD.toString(),
          asset: contract.symbol,
          sourceChainId: sourceChainId,
          destChainId: contract.chainId,
          blockNumber,
          txHash: log.transactionHash
        });
        
        // Store as daily event (tokens being received/minted on destination chain)
        await this.db('daily_events').insert({
          from_address: null, // OFT mints tokens, no direct sender on this chain
          to_address: args.toAddress.toLowerCase(),
          asset: contract.symbol,
          chain_id: contract.chainId,
          event_date: eventDate,
          event_type: 'oft_received',
          amount_delta: args.amountReceivedLD.toString(), // Positive because tokens are minted
          block_number: blockNumber,
          timestamp: timestamp,
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
          round: null, // No round for OFT events
          isIntegrationAddress: null,
          oft_guid: args.guid,
          dest_chain_id: null, // This is the destination, so no further dest_chain_id needed
          created_at: new Date(),
        }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
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
    const eventDate = timestamp.toISOString().split('T')[0];
     
    // Skip transfers involving zero addresses or the contract address itself
    // Contract transfers are handled separately via Redeem/Unstake events
    if (!checkZeroAddress(fromAddr) && !checkZeroAddress(toAddr) && 
        fromAddr !== contractAddr && toAddr !== contractAddr) {
      let integrationAddressType: string | null = null;
      if (contract.chainId === 146 || contract.chainId === 43114) {
        if (this.isRouterAddress(contract.chainId, fromAddr) && this.isSiloVaultAddress(contract.chainId, toAddr)) {
          integrationAddressType = 'siloRouter';
        } else if (this.isRouterAddress(contract.chainId, toAddr)) {
          integrationAddressType = 'to';
        } else if (this.isRouterAddress(contract.chainId, fromAddr)) {
          integrationAddressType = 'from';
        } else if (await isIntegrationAddress(fromAddr, contract.chainId)) {
          integrationAddressType = 'from';
        } else if (await isIntegrationAddress(toAddr, contract.chainId)) {
          integrationAddressType = 'to';
        } else if (contract.chainId === 146 && isShadowAddress(toAddr)) {
          integrationAddressType = 'shadow_to';
        } else if (contract.chainId === 146 && isShadowAddress(fromAddr)) {
          integrationAddressType = 'shadow_from';
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
        round: null, // No round for transfer events
        isIntegrationAddress: integrationAddressType,
        created_at: new Date(),
      }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
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
