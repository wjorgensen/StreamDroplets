/**
 * Transfer Validation Utility
 * Validates consistency between vault transfers and integration protocol events
 * Ensures data integrity between independent blockchain data pulls
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';

const logger = createLogger('TransferValidation');

export interface BlockRange {
  chainId: number;
  fromBlock: number;
  toBlock: number;
}

export interface VaultTransferEvent {
  id: number;
  from_address: string;
  to_address: string;
  asset: string;
  chain_id: number;
  event_date: string;
  event_type: string;
  amount_delta: string;
  block_number: number;
  timestamp: Date;
  tx_hash: string;
  log_index: number;
  isIntegrationAddress: 'from' | 'to' | null;
  counterparty_address?: string;
}

export interface IntegrationEvent {
  id: number;
  address: string;
  asset: string;
  chain_id: number;
  protocol_name: string;
  protocol_type: string;
  contract_address: string;
  event_date: string;
  event_type: string;
  amount_delta: string;
  shares_delta: string;
  block_number: number;
  timestamp: Date;
  tx_hash: string;
  log_index: number;
  counterparty_address?: string;
}

export interface ValidationInconsistency {
  type: 'missing_integration' | 'missing_vault';
  vaultEvent?: VaultTransferEvent;
  integrationEvent?: IntegrationEvent;
  details: string;
  chainId: number;
  txHash?: string;
  userAddress: string;
  asset: string;
  expectedAmount?: string;
}

export interface ValidationResult {
  success: boolean;
  totalVaultTransfers: number;
  totalIntegrationEvents: number;
  matchedPairs: number;
  inconsistencies: ValidationInconsistency[];
}


/**
 * Validates transfer consistency between vault transfers and integration events.
 * Matches vault transfers to/from integration contracts with corresponding integration protocol events.
 * Matching is based on user address, asset, and amount.
 */
export async function validateTransferConsistency(
  blockRanges: BlockRange[]
): Promise<ValidationResult> {
  const db = getDb();
  const inconsistencies: ValidationInconsistency[] = [];
  
  let totalVaultTransfers = 0;
  let totalIntegrationEvents = 0;
  let matchedPairs = 0;

  logger.info(`Starting transfer validation for ${blockRanges.length} chain(s)`);

  try {
    for (const blockRange of blockRanges) {
      const { chainId, fromBlock, toBlock } = blockRange;
      
      logger.info(`Validating chain ${chainId} blocks ${fromBlock}-${toBlock}`);

      const vaultTransfers = await db('daily_events')
        .where('chain_id', chainId)
        .where('event_type', 'transfer')
        .whereBetween('block_number', [fromBlock, toBlock])
        .whereIn('isIntegrationAddress', ['from', 'to'])
        .orderBy(['block_number', 'log_index']);

      const integrationEvents = await db('daily_integration_events')
        .where('chain_id', chainId)
        .whereBetween('block_number', [fromBlock, toBlock])
        .orderBy(['block_number', 'log_index']);

      totalVaultTransfers += vaultTransfers.length;
      totalIntegrationEvents += integrationEvents.length;

      logger.debug(`Chain ${chainId}: Found ${vaultTransfers.length} vault transfers and ${integrationEvents.length} integration events`);

      const integrationEventMap = new Map<string, IntegrationEvent[]>();
      
      integrationEvents.forEach((event: IntegrationEvent) => {
        const key = `${event.address.toLowerCase()}-${event.asset}-${Math.abs(parseFloat(event.amount_delta))}`;
        if (!integrationEventMap.has(key)) {
          integrationEventMap.set(key, []);
        }
        integrationEventMap.get(key)!.push(event);
      });

      for (const vaultTransfer of vaultTransfers as VaultTransferEvent[]) {
        const userAddress = vaultTransfer.isIntegrationAddress === 'from' 
          ? vaultTransfer.from_address 
          : vaultTransfer.to_address;

        const vaultAmount = Math.abs(parseFloat(vaultTransfer.amount_delta));
        const lookupKey = `${userAddress.toLowerCase()}-${vaultTransfer.asset}-${vaultAmount}`;
        const matchingIntegrationEvents = integrationEventMap.get(lookupKey) || [];

        if (matchingIntegrationEvents.length === 0) {
          inconsistencies.push({
            type: 'missing_integration',
            vaultEvent: vaultTransfer,
            details: `Vault transfer to/from integration contract has no matching integration event`,
            chainId: vaultTransfer.chain_id,
            txHash: vaultTransfer.tx_hash,
            userAddress,
            asset: vaultTransfer.asset,
            expectedAmount: vaultTransfer.amount_delta,
          });
          continue;
        }

        matchedPairs++;
        
        const remainingEvents = matchingIntegrationEvents.slice(1);
        if (remainingEvents.length > 0) {
          integrationEventMap.set(lookupKey, remainingEvents);
        } else {
          integrationEventMap.delete(lookupKey);
        }
      }

      for (const [, remainingEvents] of integrationEventMap.entries()) {
        for (const integrationEvent of remainingEvents) {
          inconsistencies.push({
            type: 'missing_vault',
            integrationEvent,
            details: `Integration event has no matching vault transfer`,
            chainId: integrationEvent.chain_id,
            txHash: integrationEvent.tx_hash,
            userAddress: integrationEvent.address,
            asset: integrationEvent.asset,
            expectedAmount: integrationEvent.amount_delta,
          });
        }
      }
    }

    const success = inconsistencies.length === 0;

    if (success) {
      logger.info(`Validation passed: ${matchedPairs} matched pairs, no inconsistencies found`);
    } else {
      logger.warn(`Validation found ${inconsistencies.length} inconsistencies out of ${totalVaultTransfers + totalIntegrationEvents} total events`);
    }

    if (inconsistencies.length > 0) {
      logger.warn(`Inconsistencies breakdown:`);
      const byType = inconsistencies.reduce((acc, inc) => {
        acc[inc.type] = (acc[inc.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      Object.entries(byType).forEach(([type, count]) => {
        logger.warn(`  ${type}: ${count}`);
      });
    }

    return {
      success,
      totalVaultTransfers,
      totalIntegrationEvents,
      matchedPairs,
      inconsistencies,
    };

  } catch (error) {
    logger.error('Transfer validation failed:', error);
    throw error;
  }
}
