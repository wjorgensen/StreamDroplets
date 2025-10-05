import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';

const logger = createLogger('TransferValidation');

interface VaultTransferEvent {
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
  isIntegrationAddress: 'from' | 'to';
}

interface IntegrationEvent {
  id: number;
  address: string;
  asset: string;
  chain_id: number;
  event_date: string;
  event_type: string;
  amount_delta: string;
  block_number: number;
  timestamp: Date;
  tx_hash: string;
  log_index: number;
  protocol_name: string;
  protocol_type: string;
  contract_address: string;
  counterparty_address: string | null;
}

interface VerificationEntry {
  id: number;
  verified: boolean;
}

interface IntegrationFilterResult {
  filteredEvents: IntegrationEvent[];
  skippedEvents: IntegrationEvent[];
}

export interface ValidationResult {
  success: boolean;
  totalVaultTransfers: number;
  totalIntegrationEvents: number;
  verifiedPairs: number;
  unverifiedVaultEvents: VaultTransferEvent[];
  unverifiedIntegrationEvents: IntegrationEvent[];
}

export async function validateTransferConsistency(dateString: string): Promise<ValidationResult> {
  const db = getDb();
  logger.info(`Starting transfer validation for ${dateString}`);

  const vaultTransfers = (await db('daily_events')
    .where('event_date', dateString)
    .where('event_type', 'transfer')
    .whereIn('isIntegrationAddress', ['from', 'to'])
    .select(
      'id',
      'from_address',
      'to_address',
      'asset',
      'chain_id',
      'event_date',
      'event_type',
      'amount_delta',
      'block_number',
      'timestamp',
      'tx_hash',
      'log_index',
      'isIntegrationAddress'
    )
    .orderBy(['block_number', 'log_index'])) as VaultTransferEvent[];

  const integrationEventsRaw = (await db('daily_integration_events')
    .where('event_date', dateString)
    .select(
      'id',
      'address',
      'asset',
      'chain_id',
      'event_date',
      'event_type',
      'amount_delta',
      'block_number',
      'timestamp',
      'tx_hash',
      'log_index',
      'protocol_name',
      'protocol_type',
      'contract_address',
      'counterparty_address'
    )
    .orderBy(['block_number', 'log_index'])) as IntegrationEvent[];

  let integrationEventsWorkingSet = integrationEventsRaw;
  const skippedIntegrationEvents: IntegrationEvent[] = [];

  const zeroAmountFilter = filterZeroAmountIntegrationEvents(integrationEventsWorkingSet);
  if (zeroAmountFilter.skippedEvents.length > 0) {
    logger.info(
      `Skipping ${zeroAmountFilter.skippedEvents.length} integration events with zero amount_delta for ${dateString}`
    );
    skippedIntegrationEvents.push(...zeroAmountFilter.skippedEvents);
    integrationEventsWorkingSet = zeroAmountFilter.filteredEvents;
  }

  const siloTransitionFilter = filterInternalSiloCollateralTransitions(integrationEventsWorkingSet);
  if (siloTransitionFilter.skippedEvents.length > 0) {
    logger.info(
      `Skipping ${siloTransitionFilter.skippedEvents.length} Silo collateral transition events for ${dateString}`
    );
    skippedIntegrationEvents.push(...siloTransitionFilter.skippedEvents);
    integrationEventsWorkingSet = siloTransitionFilter.filteredEvents;
  }

  const integrationEvents = integrationEventsWorkingSet;

  const vaultVerification = new Map<number, VerificationEntry>();
  const integrationVerification = new Map<number, VerificationEntry>();
  const vaultEventsById = new Map<number, VaultTransferEvent>();
  const integrationEventsById = new Map<number, IntegrationEvent>();
  const vaultLookup = new Map<string, VaultTransferEvent[]>();
  const vaultEventsByTxAndAmount = new Map<string, VaultTransferEvent[]>();
  const vaultEventsByAmount = new Map<string, VaultTransferEvent[]>();
  const vaultEventsByTx = new Map<string, VaultTransferEvent[]>();

  for (const event of vaultTransfers) {
    const entry: VerificationEntry = { id: event.id, verified: false };
    vaultVerification.set(event.id, entry);
    vaultEventsById.set(event.id, event);

    const userAddress = resolveVaultUserAddress(event);
    const amountKey = normalizeAmount(event.amount_delta);
    const matchKey = buildMatchKey(userAddress, amountKey);

    if (matchKey) {
      if (!vaultLookup.has(matchKey)) {
        vaultLookup.set(matchKey, []);
      }
      vaultLookup.get(matchKey)!.push(event);
    }

    const txMatchKey = buildTxAmountKey(event.tx_hash, amountKey);
    if (txMatchKey) {
      if (!vaultEventsByTxAndAmount.has(txMatchKey)) {
        vaultEventsByTxAndAmount.set(txMatchKey, []);
      }
      vaultEventsByTxAndAmount.get(txMatchKey)!.push(event);
    }

    if (!vaultEventsByAmount.has(amountKey)) {
      vaultEventsByAmount.set(amountKey, []);
    }
    vaultEventsByAmount.get(amountKey)!.push(event);

    const txHash = event.tx_hash?.toLowerCase();
    if (txHash) {
      if (!vaultEventsByTx.has(txHash)) {
        vaultEventsByTx.set(txHash, []);
      }
      vaultEventsByTx.get(txHash)!.push(event);
    }
  }

  const protocolSkippedIntegrationEvents: IntegrationEvent[] = [];
  const matchableIntegrationEvents: IntegrationEvent[] = [];

  for (const event of integrationEvents) {
    if (shouldSkipIntegrationEvent(event)) {
      protocolSkippedIntegrationEvents.push(event);
      continue;
    }

    matchableIntegrationEvents.push(event);
    const entry: VerificationEntry = { id: event.id, verified: false };
    integrationVerification.set(event.id, entry);
    integrationEventsById.set(event.id, event);
  }

  if (protocolSkippedIntegrationEvents.length > 0) {
    logger.info(
      `Excluded ${protocolSkippedIntegrationEvents.length} integration events from validation due to protocol-specific handling`
    );
  }

  let verifiedPairs = 0;

  for (const integrationEvent of matchableIntegrationEvents) {
    const amountKey = normalizeAmount(integrationEvent.amount_delta);
    const protocolName = integrationEvent.protocol_name
      ? integrationEvent.protocol_name.toLowerCase().trim()
      : undefined;
    const counterpartyAddress = normalizeAddress(integrationEvent.counterparty_address ?? undefined);

    if (tryMatchEnclabsEvent(
      integrationEvent,
      amountKey,
      vaultVerification,
      integrationVerification,
      vaultEventsByAmount
    )) {
      verifiedPairs += 1;
      continue;
    }

    if (tryMatchEulerEvent(
      integrationEvent,
      amountKey,
      vaultVerification,
      integrationVerification,
      vaultEventsByTxAndAmount
    )) {
      verifiedPairs += 1;
      continue;
    }

    if (tryMatchShadowEvent(
      integrationEvent,
      vaultVerification,
      integrationVerification,
      vaultEventsByTx
    )) {
      verifiedPairs += 1;
      continue;
    }

    const normalizedUserAddress = normalizeAddress(integrationEvent.address);
    const candidateAddresses = new Set<string | null>([normalizedUserAddress]);

    if (protocolName === 'euler_finance' && counterpartyAddress) {
      candidateAddresses.add(counterpartyAddress);
    }

    let matched = false;

    for (const candidateAddress of candidateAddresses) {
      const matchKey = buildMatchKey(candidateAddress, amountKey);
      if (!matchKey) {
        continue;
      }

      const possibleVaultEvents = vaultLookup.get(matchKey);
      if (!possibleVaultEvents) {
        continue;
      }

      const match = possibleVaultEvents.find((vaultEvent) => {
        const entry = vaultVerification.get(vaultEvent.id);
        return entry !== undefined && entry.verified === false;
      });

      if (!match) {
        continue;
      }

      const integrationEntry = integrationVerification.get(integrationEvent.id);
      const vaultEntry = vaultVerification.get(match.id);

      if (integrationEntry && vaultEntry) {
        integrationEntry.verified = true;
        vaultEntry.verified = true;
        verifiedPairs += 1;
        matched = true;
        break;
      }
    }

    if (matched) {
      continue;
    }
  }

  const unverifiedIntegrationEvents = Array.from(integrationVerification.values())
    .filter((entry) => !entry.verified)
    .map((entry) => integrationEventsById.get(entry.id))
    .filter((event): event is IntegrationEvent => Boolean(event));

  const unverifiedVaultEvents = Array.from(vaultVerification.values())
    .filter((entry) => !entry.verified)
    .map((entry) => vaultEventsById.get(entry.id))
    .filter((event): event is VaultTransferEvent => Boolean(event));

  const success = unverifiedIntegrationEvents.length === 0 && unverifiedVaultEvents.length === 0;

  if (success) {
    logger.info(
      `Validation passed for ${dateString}: ${verifiedPairs} pairs matched across ${matchableIntegrationEvents.length} integration events and ${vaultTransfers.length} vault transfers`
    );
  } else {
    logger.warn(
      `Validation found unmatched events for ${dateString}: ${unverifiedIntegrationEvents.length} integration events and ${unverifiedVaultEvents.length} vault transfers`
    );

    if (unverifiedIntegrationEvents.length > 0) {
      logger.warn('Unverified integration events:');
      unverifiedIntegrationEvents.forEach((event) => {
      logger.warn(
        {
          id: event.id,
          user_address: event.address,
          asset: event.asset,
          amount_delta: event.amount_delta,
          protocol_name: event.protocol_name,
          tx_hash: event.tx_hash,
          block_number: event.block_number,
          chain_id: event.chain_id,
        },
        'Unverified integration event detected'
      );
    });
  }

  if (unverifiedVaultEvents.length > 0) {
    logger.warn('Unverified vault transfer events:');
    unverifiedVaultEvents.forEach((event) => {
      logger.warn(
        {
          id: event.id,
          from_address: event.from_address,
          to_address: event.to_address,
          user_address: resolveVaultUserAddress(event),
          asset: event.asset,
          amount_delta: event.amount_delta,
          tx_hash: event.tx_hash,
          block_number: event.block_number,
          chain_id: event.chain_id,
          isIntegrationAddress: event.isIntegrationAddress,
        },
        'Unverified vault transfer detected'
      );
    });
  }
  }

  return {
    success,
    totalVaultTransfers: vaultTransfers.length,
    totalIntegrationEvents: matchableIntegrationEvents.length,
    verifiedPairs,
    unverifiedVaultEvents,
    unverifiedIntegrationEvents,
  };
}

/**
 * Determine if an integration event should be skipped during validation
 */
function shouldSkipIntegrationEvent(event: IntegrationEvent): boolean {
  const protocolName = event.protocol_name
    ? event.protocol_name.toLowerCase().trim()
    : undefined;
  const eventType = event.event_type
    ? event.event_type.toLowerCase().trim()
    : undefined;

  if (protocolName === 'euler_finance' && eventType === 'transfer') {
    return true;
  }

  if (protocolName === 'enclabs' && eventType === 'transfer') {
    return true;
  }

  return false;
}

/**
 * Filter out integration events with zero amount
 */
function filterZeroAmountIntegrationEvents(events: IntegrationEvent[]): IntegrationFilterResult {
  const filteredEvents: IntegrationEvent[] = [];
  const skippedEvents: IntegrationEvent[] = [];

  for (const event of events) {
    const normalizedAmount = normalizeAmount(event.amount_delta);
    if (normalizedAmount === '0') {
      skippedEvents.push(event);
    } else {
      filteredEvents.push(event);
    }
  }

  return { filteredEvents, skippedEvents };
}

/**
 * Filter out internal Silo collateral transition events
 */
function filterInternalSiloCollateralTransitions(events: IntegrationEvent[]): IntegrationFilterResult {
  const skipIds = new Set<number>();
  const groupedEvents = new Map<string, IntegrationEvent[]>();

  for (const event of events) {
    const protocolName = event.protocol_name
      ? event.protocol_name.toLowerCase().trim()
      : undefined;

    if (protocolName !== 'silo_finance') {
      continue;
    }

    const txHash = event.tx_hash?.toLowerCase();
    const userAddress = normalizeAddress(event.address);

    if (!txHash || !userAddress) {
      continue;
    }

    const key = `${txHash}_${userAddress}`;
    if (!groupedEvents.has(key)) {
      groupedEvents.set(key, []);
    }
    groupedEvents.get(key)!.push(event);
  }

  const depositEventTypes = new Set(['deposit', 'deposit_protected']);
  const withdrawEventTypes = new Set(['withdraw', 'withdraw_protected']);

  for (const group of groupedEvents.values()) {
    const sortedGroup = [...group].sort((a, b) => (a.log_index ?? 0) - (b.log_index ?? 0));
    const withdrawByAmount = new Map<string, IntegrationEvent[]>();
    const depositByAmount = new Map<string, IntegrationEvent[]>();

    for (const event of sortedGroup) {
      const eventType = event.event_type?.toLowerCase().trim();
      const amountKey = normalizeAmount(event.amount_delta);

      if (eventType && withdrawEventTypes.has(eventType)) {
        if (!withdrawByAmount.has(amountKey)) {
          withdrawByAmount.set(amountKey, []);
        }
        withdrawByAmount.get(amountKey)!.push(event);
      } else if (eventType && depositEventTypes.has(eventType)) {
        if (!depositByAmount.has(amountKey)) {
          depositByAmount.set(amountKey, []);
        }
        depositByAmount.get(amountKey)!.push(event);
      }
    }

    for (const [amountKey, withdrawEvents] of withdrawByAmount.entries()) {
      const depositEvents = depositByAmount.get(amountKey);
      if (!depositEvents || depositEvents.length === 0) {
        continue;
      }

      const pairCount = Math.min(withdrawEvents.length, depositEvents.length);
      for (let i = 0; i < pairCount; i++) {
        const withdrawEvent = withdrawEvents[i];
        const depositEvent = depositEvents[i];

        if (withdrawEvent?.id !== undefined) {
          skipIds.add(withdrawEvent.id);
        }
        if (depositEvent?.id !== undefined) {
          skipIds.add(depositEvent.id);
        }
      }
    }
  }

  if (skipIds.size === 0) {
    return {
      filteredEvents: events,
      skippedEvents: [],
    };
  }

  const filteredEvents = events.filter((event) => !skipIds.has(event.id));
  const skippedEvents = events.filter((event) => skipIds.has(event.id));

  return {
    filteredEvents,
    skippedEvents,
  };
}

/**
 * Try to match an Enclabs event with vault transfers
 */
function tryMatchEnclabsEvent(
  integrationEvent: IntegrationEvent,
  amountKey: string,
  vaultVerification: Map<number, VerificationEntry>,
  integrationVerification: Map<number, VerificationEntry>,
  vaultEventsByAmount: Map<string, VaultTransferEvent[]>
): boolean {
  const protocolName = integrationEvent.protocol_name
    ? integrationEvent.protocol_name.toLowerCase().trim()
    : undefined;

  if (protocolName !== 'enclabs') {
    return false;
  }

  const eventType = integrationEvent.event_type
    ? integrationEvent.event_type.toLowerCase().trim()
    : undefined;

  if (eventType === 'transfer') {
    return false;
  }

  const possibleAmountMatches = vaultEventsByAmount.get(amountKey);
  if (!possibleAmountMatches) {
    return false;
  }

  const match = possibleAmountMatches.find((vaultEvent) => {
    const entry = vaultVerification.get(vaultEvent.id);
    return entry !== undefined && entry.verified === false;
  });

  if (!match) {
    return false;
  }

  const integrationEntry = integrationVerification.get(integrationEvent.id);
  const vaultEntry = vaultVerification.get(match.id);

  if (!integrationEntry || !vaultEntry) {
    return false;
  }

  integrationEntry.verified = true;
  vaultEntry.verified = true;
  return true;
}

/**
 * Try to match an Euler event with vault transfers
 */
function tryMatchEulerEvent(
  integrationEvent: IntegrationEvent,
  amountKey: string,
  vaultVerification: Map<number, VerificationEntry>,
  integrationVerification: Map<number, VerificationEntry>,
  vaultEventsByTxAndAmount: Map<string, VaultTransferEvent[]>
): boolean {
  const protocolName = integrationEvent.protocol_name
    ? integrationEvent.protocol_name.toLowerCase().trim()
    : undefined;
  const eventType = integrationEvent.event_type
    ? integrationEvent.event_type.toLowerCase().trim()
    : undefined;

  if (
    protocolName !== 'euler_finance' ||
    !(eventType === 'deposit' || eventType === 'withdraw')
  ) {
    return false;
  }

  const txMatchKey = buildTxAmountKey(integrationEvent.tx_hash, amountKey);
  if (!txMatchKey) {
    return false;
  }

  const possibleTxMatches = vaultEventsByTxAndAmount.get(txMatchKey);
  if (!possibleTxMatches) {
    return false;
  }

  const match = possibleTxMatches.find((vaultEvent) => {
    const entry = vaultVerification.get(vaultEvent.id);
    return entry !== undefined && entry.verified === false;
  });

  if (!match) {
    return false;
  }

  const integrationEntry = integrationVerification.get(integrationEvent.id);
  const vaultEntry = vaultVerification.get(match.id);

  if (!integrationEntry || !vaultEntry) {
    return false;
  }

  integrationEntry.verified = true;
  vaultEntry.verified = true;
  return true;
}

/**
 * Try to match a Shadow Exchange event with vault transfers
 */
function tryMatchShadowEvent(
  integrationEvent: IntegrationEvent,
  vaultVerification: Map<number, VerificationEntry>,
  integrationVerification: Map<number, VerificationEntry>,
  vaultEventsByTx: Map<string, VaultTransferEvent[]>
): boolean {
  const protocolName = integrationEvent.protocol_name
    ? integrationEvent.protocol_name.toLowerCase().trim()
    : undefined;
  const eventType = integrationEvent.event_type
    ? integrationEvent.event_type.toLowerCase().trim()
    : undefined;

  if (
    protocolName !== 'shadow_exchange' ||
    !(eventType === 'mint' || eventType === 'burn')
  ) {
    return false;
  }

  const txHash = integrationEvent.tx_hash?.toLowerCase();
  if (!txHash) {
    return false;
  }

  const possibleTxMatches = vaultEventsByTx.get(txHash);
  if (!possibleTxMatches) {
    return false;
  }

  const match = possibleTxMatches.find((vaultEvent) => {
    const entry = vaultVerification.get(vaultEvent.id);
    return entry !== undefined && entry.verified === false;
  });

  if (!match) {
    return false;
  }

  const integrationEntry = integrationVerification.get(integrationEvent.id);
  const vaultEntry = vaultVerification.get(match.id);

  if (!integrationEntry || !vaultEntry) {
    return false;
  }

  integrationEntry.verified = true;
  vaultEntry.verified = true;
  return true;
}

/**
 * Resolve the user address from a vault transfer event
 */
function resolveVaultUserAddress(event: VaultTransferEvent): string | null {
  if (event.isIntegrationAddress === 'to') {
    return normalizeAddress(event.from_address);
  }

  if (event.isIntegrationAddress === 'from') {
    return normalizeAddress(event.to_address);
  }

  return null;
}

/**
 * Normalize address to lowercase
 */
function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.toLowerCase();
}

/**
 * Normalize amount to absolute value string
 */
function normalizeAmount(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) {
    return '0';
  }

  const trimmed = amount.trim();
  if (trimmed === '') {
    return '0';
  }

  try {
    const value = BigInt(trimmed);
    return value < 0n ? (-value).toString() : value.toString();
  } catch (error) {
    logger.warn({ amount }, 'Failed to normalize amount');
    return '0';
  }
}

/**
 * Build match key from address and amount
 */
function buildMatchKey(address: string | null, amount: string): string | null {
  if (!address) {
    return null;
  }

  return `${address}-${amount}`;
}

/**
 * Build match key from transaction hash and amount
 */
function buildTxAmountKey(txHash: string | null | undefined, amount: string): string | null {
  if (!txHash) {
    return null;
  }

  const normalizedHash = txHash.trim();
  if (normalizedHash === '') {
    return null;
  }

  return `${normalizedHash.toLowerCase()}-${amount}`;
}
