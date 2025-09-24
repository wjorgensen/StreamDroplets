/**
 * Daily Snapshot Service - Utility Class
 * Processes daily snapshots for a given date and block ranges
 * Creates user and protocol snapshots based on vault and integration balances
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { AssetType, CONSTANTS, BlockRange, UserDailySnapshot, ProtocolDailySnapshot, IntegrationBreakdown } from '../config/constants';
import { checkZeroAddress, CONTRACTS } from '../config/contracts';
import { ChainlinkService } from '../oracle/ChainlinkService';
import { VaultIndexer } from '../indexer/vault/VaultIndexer';
import { IntegrationIndexer } from '../indexer/integrations/IntegrationIndexer';
import { validateTransferConsistency } from '../indexer/TransferValidation';

const logger = createLogger('DailySnapshotService');

interface SnapshotPriceData {
  snapshot_date: string;
  eth_usd_price: string;
  btc_usd_price: string;
  usd_usd_price: string;
  eur_usd_price: string;
}

export class DailySnapshotService {
  private db = getDb();
  private oracleService: ChainlinkService;
  
  constructor() {
    this.oracleService = new ChainlinkService();
  }

  /**
   * Process daily snapshot for given date and block ranges
   */
  async processDailySnapshot(
    dateString: string,
    blockRanges: BlockRange[]
  ): Promise<void> {
    const startTime = Date.now();
    logger.info(`Starting daily snapshot processing for ${dateString} with ${blockRanges.length} block ranges`);

    try {
      // Log incoming block ranges for debugging
      logger.info(`Block ranges received: ${JSON.stringify(blockRanges.map(r => ({chainId: r.chainId, fromBlock: r.fromBlock, toBlock: r.toBlock})))}`);
      
      // Step 1: Process vault events (indexers handle batching internally)
      try {
        logger.info(`Step 1: Processing vault events with full block ranges`);
        await this.processVaultEvents(blockRanges);
        logger.info(`Step 1 completed: Vault events processed successfully`);
      } catch (error) {
        logger.error(`Step 1 failed: Error processing vault events`, error);
        throw new Error(`Failed at Step 1 - Vault events processing: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Filter for integration chains only
      const integrationRanges = blockRanges.filter(range => 
        range.chainId === CONSTANTS.CHAIN_IDS.SONIC || 
        range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE
      );
      
      const hasIntegrationChains = integrationRanges.length > 0;
      
      if (hasIntegrationChains) {
        // Step 2: Process integration events (indexers handle batching internally)
        try {
          logger.info(`Step 2: Processing integration events`);
          await this.processIntegrationEvents(integrationRanges, dateString);
          logger.info(`Step 2 completed: Integration events processed successfully`);
        } catch (error) {
          logger.error(`Step 2 failed: Error processing integration events`, error);
          throw new Error(`Failed at Step 2 - Integration events processing: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Step 3: Update integration balances (uses original integration ranges)
        try {
          logger.info(`Step 3: Updating integration balances using integration ranges`);
          await this.updateIntegrationBalances(integrationRanges);
          logger.info(`Step 3 completed: Integration balances updated successfully`);
        } catch (error) {
          logger.error(`Step 3 failed: Error updating integration balances`, error);
          throw new Error(`Failed at Step 3 - Integration balances update: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Step 4: Validate transfers (uses original full block ranges)
        try {
          logger.info(`Step 4: Validating transfer consistency using original full block ranges`);
          await this.validateAndRetryIfNeeded(dateString, blockRanges);
          logger.info(`Step 4 completed: Transfer validation completed successfully`);
        } catch (error) {
          logger.error(`Step 4 failed: Error during transfer validation`, error);
          throw new Error(`Failed at Step 4 - Transfer validation: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        logger.info('No integration chains in block ranges, skipping integration processing and validation (Steps 2-4)');
      }
      
      // Step 5: Check for Ethereum block range (uses original full block ranges)
      logger.info(`Step 5 prep: Looking for Ethereum block range in original block ranges`);
      logger.info(`Available chains in original block ranges: ${blockRanges.map(r => r.chainId).join(', ')}`);
      
      const ethBlockRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.ETHEREUM);
      if (!ethBlockRange) {
        logger.error(`CRITICAL ERROR: No Ethereum block range found for price data.`);
        logger.error(`Original block ranges: ${JSON.stringify(blockRanges)}`);
        logger.error(`Expected Ethereum chain ID: ${CONSTANTS.CHAIN_IDS.ETHEREUM}`);
        throw new Error('No Ethereum block range found for price data');
      }
      
      logger.info(`Ethereum block range found: blocks ${ethBlockRange.fromBlock} to ${ethBlockRange.toBlock} on chain ${ethBlockRange.chainId}`)
      
      // Step 5: Get price data
      let priceData: SnapshotPriceData;
      try {
        logger.info(`Step 5: Fetching price data using Ethereum block ${ethBlockRange.toBlock}`);
        priceData = await this.getPriceDataForDate(dateString, ethBlockRange);
        logger.info(`Step 5 completed: Price data fetched successfully`);
      } catch (error) {
        logger.error(`Step 5 failed: Error fetching price data`, error);
        throw new Error(`Failed at Step 5 - Price data fetching: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Step 6: Process user snapshots
      try {
        logger.info(`Step 6: Processing user snapshots`);
        await this.processUserSnapshots(dateString, priceData);
        logger.info(`Step 6 completed: User snapshots processed successfully`);
      } catch (error) {
        logger.error(`Step 6 failed: Error processing user snapshots`, error);
        throw new Error(`Failed at Step 6 - User snapshots processing: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Step 7: Process protocol snapshot
      try {
        logger.info(`Step 7: Processing protocol snapshot`);
        await this.processProtocolSnapshot(dateString, priceData);
        logger.info(`Step 7 completed: Protocol snapshot processed successfully`);
      } catch (error) {
        logger.error(`Step 7 failed: Error processing protocol snapshot`, error);
        throw new Error(`Failed at Step 7 - Protocol snapshot processing: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      const duration = (Date.now() - startTime) / 1000;
      logger.info(`Daily snapshot processing completed for ${dateString} in ${duration}s`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Daily snapshot processing failed for ${dateString}. Error: ${errorMessage}`);
      
      if (error instanceof Error && error.stack) {
        logger.error(`Stack trace:`, error.stack);
      }
      
      throw error;
    }
  }


  /**
   * Process vault events using VaultIndexer
   */
  private async processVaultEvents(
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info('Processing vault events');
    
    const vaultIndexer = new VaultIndexer();
    await vaultIndexer.fetchAndProcessVaults(blockRanges);
    
    logger.info('Vault events processing completed');
  }

  /**
   * Process integration events using IntegrationIndexer
   * Expects pre-filtered integration ranges (Sonic/Avalanche only)
   */
  private async processIntegrationEvents(
    integrationRanges: BlockRange[],
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing integration events for ${integrationRanges.length} integration chain(s)`);
    
    const integrationIndexer = new IntegrationIndexer();
    await integrationIndexer.fetchAndProcessIntegrations(integrationRanges, eventDate);
    
    logger.info('Integration events processing completed');
  }

  /**
   * Update integration balances with price per share
   * Expects pre-filtered integration ranges (Sonic/Avalanche only)
   */
  private async updateIntegrationBalances(integrationRanges: BlockRange[]): Promise<void> {
    logger.info('Updating integration balances');
    
    if (integrationRanges.length === 0) {
      throw new Error('No integration block range found for balance updates');
    }
    
    logger.info(`Using integration block ranges for balance updates:`, 
      integrationRanges.map(range => `Chain ${range.chainId}: ${range.toBlock}`).join(', '));
    
    const integrationIndexer = new IntegrationIndexer();
    await integrationIndexer.updateIntegrationBalances(integrationRanges);
    
    logger.info('Integration balances update completed');
  }

  /**
   * Get price data for the snapshot date using block-based pricing
   */
  private async getPriceDataForDate(
    dateString: string,
    ethBlockRange: BlockRange
  ): Promise<SnapshotPriceData> {
    logger.info(`Fetching oracle prices for ${dateString} at block ${ethBlockRange.toBlock}`);
    
    try {
      logger.info(`Calling oracleService.getPricesAtBlock(${ethBlockRange.toBlock})`);
      const prices = await this.oracleService.getPricesAtBlock(ethBlockRange.toBlock);
      
      logger.info(`Oracle prices fetched successfully: ETH=${prices.eth}, BTC=${prices.btc}, USDC=${prices.usdc}, EUR=${prices.eur}`);
      
      const priceData = {
        snapshot_date: dateString,
        eth_usd_price: prices.eth.toString(),
        btc_usd_price: prices.btc.toString(),
        usd_usd_price: prices.usdc.toString(),
        eur_usd_price: prices.eur.toString(),
      };
      
      logger.info(`Price data object created successfully for ${dateString}`);
      return priceData;
      
    } catch (error) {
      logger.error(`Failed to get price data for ${dateString} at block ${ethBlockRange.toBlock}:`, error);
      throw new Error(`Price data retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Process user snapshots for all active addresses
   */
  private async processUserSnapshots(
    dateString: string,
    priceData: SnapshotPriceData
  ): Promise<void> {
    logger.info('Processing user snapshots');
    
    try {
      logger.info('Fetching active addresses...');
      const addresses = await this.getActiveAddresses();
      logger.info(`Found ${addresses.length} active addresses`);
      
      const userSnapshots: UserDailySnapshot[] = [];
      
      logger.info('Creating user snapshots...');
      for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        
        if (this.isExcludedAddress(address)) {
          logger.debug(`Skipping excluded address: ${address}`);
          continue;
        }
        
        try {
          const snapshot = await this.createUserSnapshot(address, dateString, priceData);
          if (snapshot.total_usd_value !== '0') {
            userSnapshots.push(snapshot);
          }
          
          if ((i + 1) % 100 === 0) {
            logger.info(`Processed ${i + 1}/${addresses.length} user snapshots`);
          }
        } catch (error) {
          logger.error(`Failed to create snapshot for address ${address}:`, error);
          throw new Error(`User snapshot creation failed for ${address}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      logger.info(`Created ${userSnapshots.length} non-zero user snapshots from ${addresses.length} addresses`);
      
      if (userSnapshots.length > 0) {
        logger.info(`Inserting ${userSnapshots.length} user snapshots into database...`);
        await this.db('user_daily_snapshots')
          .insert(userSnapshots)
          .onConflict(['address', 'snapshot_date'])
          .merge();
        logger.info('User snapshots inserted successfully');
      } else {
        logger.info('No user snapshots to insert (all users had zero balances)');
      }
      
      logger.info(`User snapshots processing completed: ${userSnapshots.length} snapshots processed`);
      
    } catch (error) {
      logger.error('Failed to process user snapshots:', error);
      throw new Error(`User snapshots processing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create user snapshot for a single address
   */
  private async createUserSnapshot(
    address: string,
    dateString: string,
    priceData: SnapshotPriceData
  ): Promise<UserDailySnapshot> {
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    const assetBreakdown: Record<string, { shares: bigint, usd: bigint }> = {};
    let totalUsd = 0n;
    
    for (const asset of assets) {
      const { shares, underlyingAssets } = await this.getTotalBalancesForAsset(address, asset);
      const priceKey = `${asset.toLowerCase().replace('x', '')}_usd_price` as keyof SnapshotPriceData;
      const usdPrice = BigInt(priceData[priceKey] as string);
      
      // Oracle prices have 8 decimals, convert to our USD_DECIMALS (6) precision
      const oracleScale = 10n ** 8n;
      const usdScale = 10n ** CONSTANTS.USD_DECIMALS;
      const assetDecimals = CONTRACTS[asset].decimals;
      
      // Calculate USD value: (underlyingAssets / 10^assetDecimals) * (usdPrice / 10^8) * 10^6
      // Simplified: (underlyingAssets * usdPrice * 10^6) / (10^assetDecimals * 10^8)
      const usdValue = (underlyingAssets * usdPrice * usdScale) / (10n ** assetDecimals * oracleScale);
      
      assetBreakdown[asset] = { shares, usd: usdValue };
      totalUsd += usdValue;
    }
    
    const integrationBreakdown = await this.buildUserIntegrationBreakdown(address);
    
    const integrationBalances = await this.db('integration_balances')
      .where('address', address.toLowerCase())
      .sum('underlying_assets as total')
      .first();
    const integrationUsdValue = BigInt(integrationBalances?.total || '0');
    totalUsd += integrationUsdValue;
    
    // Calculate droplets
    const dailyDroplets = this.calculateDailyDroplets(totalUsd);
    const previousDroplets = await this.getPreviousUserDroplets(address, dateString);
    const totalDroplets = previousDroplets + dailyDroplets;
    
    return {
      address: address.toLowerCase(),
      snapshot_date: dateString,
      total_usd_value: totalUsd.toString(),
      xeth_shares_total: assetBreakdown.xETH?.shares?.toString() || '0',
      xeth_usd_value: assetBreakdown.xETH?.usd?.toString() || '0',
      xbtc_shares_total: assetBreakdown.xBTC?.shares?.toString() || '0',
      xbtc_usd_value: assetBreakdown.xBTC?.usd?.toString() || '0',
      xusd_shares_total: assetBreakdown.xUSD?.shares?.toString() || '0',
      xusd_usd_value: assetBreakdown.xUSD?.usd?.toString() || '0',
      xeur_shares_total: assetBreakdown.xEUR?.shares?.toString() || '0',
      xeur_usd_value: assetBreakdown.xEUR?.usd?.toString() || '0',
      integration_breakdown: integrationBreakdown,
      daily_droplets_earned: dailyDroplets.toString(),
      total_droplets: totalDroplets.toString(),
      snapshot_timestamp: new Date(),
    };
  }

  /**
   * Process protocol-wide snapshot
   */
  private async processProtocolSnapshot(
    dateString: string,
    priceData: SnapshotPriceData
  ): Promise<void> {
    logger.info('Processing protocol snapshot');
    
    try {
      const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
      const protocolTotals: Record<string, { shares: bigint, usd: bigint }> = {};
      let totalProtocolUsd = 0n;
      
      logger.info('Calculating protocol totals for each asset...');
      for (const asset of assets) {
        try {
          logger.info(`Processing asset: ${asset}`);
          const { shares, underlyingAssets } = await this.getTotalProtocolBalancesForAsset(asset);
          const priceKey = `${asset.toLowerCase().replace('x', '')}_usd_price` as keyof SnapshotPriceData;
          const usdPrice = BigInt(priceData[priceKey] as string);
          
          logger.info(`Asset ${asset}: shares=${shares}, underlyingAssets=${underlyingAssets}, price=${usdPrice}`);
          
          // Oracle prices have 8 decimals, convert to our USD_DECIMALS (6) precision
          const oracleScale = 10n ** 8n;
          const usdScale = 10n ** CONSTANTS.USD_DECIMALS;
          const assetDecimals = CONTRACTS[asset].decimals;
          
          // Calculate USD value: (underlyingAssets / 10^assetDecimals) * (usdPrice / 10^8) * 10^6
          // Simplified: (underlyingAssets * usdPrice * 10^6) / (10^assetDecimals * 10^8)
          const usdValue = (underlyingAssets * usdPrice * usdScale) / (10n ** assetDecimals * oracleScale);
          
          protocolTotals[asset] = { shares, usd: usdValue };
          totalProtocolUsd += usdValue;
          
          logger.info(`Asset ${asset} USD value: ${usdValue}`);
        } catch (error) {
          logger.error(`Failed to process asset ${asset}:`, error);
          throw new Error(`Protocol asset processing failed for ${asset}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      logger.info(`Total protocol USD from assets: ${totalProtocolUsd}`);
      
      logger.info('Building total integration breakdown...');
      const totalIntegrationBreakdown = await this.buildTotalIntegrationBreakdown();
      logger.info('Integration breakdown completed');
      
      logger.info('Calculating total integration USD...');
      const totalIntegrationUsdResult = await this.db('integration_balances')
        .sum('underlying_assets as total')
        .first();
      const totalIntegrationUsd = BigInt(totalIntegrationUsdResult?.total || '0');
      totalProtocolUsd += totalIntegrationUsd;
      
      logger.info(`Total integration USD: ${totalIntegrationUsd}, Total protocol USD: ${totalProtocolUsd}`);
      
      // Calculate protocol droplets
      logger.info('Calculating protocol droplets...');
      const dailyProtocolDroplets = this.calculateDailyDroplets(totalProtocolUsd);
      const previousProtocolDroplets = await this.getPreviousProtocolDroplets(dateString);
      const totalProtocolDroplets = previousProtocolDroplets + dailyProtocolDroplets;
      
      logger.info(`Daily droplets: ${dailyProtocolDroplets}, Previous droplets: ${previousProtocolDroplets}, Total: ${totalProtocolDroplets}`);
      
      logger.info('Getting total unique users...');
      const totalUsers = await this.getTotalUniqueUsers();
      logger.info(`Total unique users: ${totalUsers}`);
      
      logger.info('Creating protocol snapshot object...');
      const protocolSnapshot: ProtocolDailySnapshot = {
        snapshot_date: dateString,
        total_protocol_usd: totalProtocolUsd.toString(),
        total_xeth_shares: protocolTotals.xETH?.shares?.toString() || '0',
        total_xeth_usd: protocolTotals.xETH?.usd?.toString() || '0',
        total_xbtc_shares: protocolTotals.xBTC?.shares?.toString() || '0',
        total_xbtc_usd: protocolTotals.xBTC?.usd?.toString() || '0',
        total_xusd_shares: protocolTotals.xUSD?.shares?.toString() || '0',
        total_xusd_usd: protocolTotals.xUSD?.usd?.toString() || '0',
        total_xeur_shares: protocolTotals.xEUR?.shares?.toString() || '0',
        total_xeur_usd: protocolTotals.xEUR?.usd?.toString() || '0',
        total_integration_breakdown: totalIntegrationBreakdown,
        total_users: totalUsers,
        daily_protocol_droplets: dailyProtocolDroplets.toString(),
        total_protocol_droplets: totalProtocolDroplets.toString(),
        eth_usd_price: priceData.eth_usd_price,
        btc_usd_price: priceData.btc_usd_price,
        eur_usd_price: priceData.eur_usd_price,
        snapshot_timestamp: new Date(),
      };
      
      logger.info('Inserting protocol snapshot into database...');
      await this.db('daily_snapshots')
        .insert(protocolSnapshot)
        .onConflict('snapshot_date')
        .merge();
      
      logger.info('Protocol snapshot processing completed successfully');
      
    } catch (error) {
      logger.error('Failed to process protocol snapshot:', error);
      throw new Error(`Protocol snapshot processing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get total shares and underlying assets for an asset for a user
   */
  private async getTotalBalancesForAsset(
    address: string,
    asset: AssetType
  ): Promise<{ shares: bigint; underlyingAssets: bigint }> {
    const balance = await this.db('share_balances')
      .where({ 
        address: address.toLowerCase(), 
        asset 
      })
      .first();

    if (!balance) {
      return { shares: 0n, underlyingAssets: 0n };
    }

    return { 
      shares: BigInt(balance.shares), 
      underlyingAssets: BigInt(balance.underlying_assets || '0')
    };
  }

  /**
   * Get total protocol shares and underlying assets for an asset (consolidated across all chains)
   */
  private async getTotalProtocolBalancesForAsset(
    asset: AssetType
  ): Promise<{ shares: bigint; underlyingAssets: bigint }> {
    const result = await this.db('share_balances')
      .where({ asset })
      .sum('shares as total_shares')
      .sum('underlying_assets as total_underlying_assets')
      .first();

    return {
      shares: result?.total_shares ? BigInt(result.total_shares) : 0n,
      underlyingAssets: result?.total_underlying_assets ? BigInt(result.total_underlying_assets) : 0n
    };
  }

  /**
   * Build integration breakdown JSON for a user
   */
  private async buildUserIntegrationBreakdown(address: string): Promise<string> {
    const integrationBalances = await this.db('integration_balances')
      .where('address', address.toLowerCase())
      .where('underlying_assets', '>', 0)
      .select('protocol_name', 'asset', 'underlying_assets');

    const breakdown: IntegrationBreakdown = {};
    
    for (const balance of integrationBalances) {
      const protocolName = balance.protocol_name;
      const assetType = balance.asset;
      const amount = BigInt(balance.underlying_assets);
      
      if (!breakdown[protocolName]) {
        breakdown[protocolName] = {
          USD: '0'
        };
      }
      
      if (!breakdown[protocolName][assetType]) {
        breakdown[protocolName][assetType] = '0';
      }
      breakdown[protocolName][assetType] = (BigInt(breakdown[protocolName][assetType]) + amount).toString();
      
      breakdown[protocolName].USD = (BigInt(breakdown[protocolName].USD) + amount).toString();
    }
    
    return JSON.stringify(breakdown);
  }

  /**
   * Build total integration breakdown JSON for protocol
   */
  private async buildTotalIntegrationBreakdown(): Promise<string> {
    const integrationBalances = await this.db('integration_balances')
      .where('underlying_assets', '>', 0)
      .select('protocol_name', 'asset', 'underlying_assets');

    const breakdown: IntegrationBreakdown = {};
    
    for (const balance of integrationBalances) {
      const protocolName = balance.protocol_name;
      const assetType = balance.asset;
      const amount = BigInt(balance.underlying_assets);
      
      if (!breakdown[protocolName]) {
        breakdown[protocolName] = {
          USD: '0'
        };
      }
      
      if (!breakdown[protocolName][assetType]) {
        breakdown[protocolName][assetType] = '0';
      }
      breakdown[protocolName][assetType] = (BigInt(breakdown[protocolName][assetType]) + amount).toString();
      
      breakdown[protocolName].USD = (BigInt(breakdown[protocolName].USD) + amount).toString();
    }
    
    return JSON.stringify(breakdown);
  }

  /**
   * Get total unique users with any balance
   */
  private async getTotalUniqueUsers(): Promise<number> {
    const shareUsers = this.db('share_balances')
      .distinct('address')
      .where('shares', '>', 0);
    
    const integrationUsers = this.db('integration_balances')
      .distinct('address')
      .where('underlying_assets', '>', 0);
    
    const result = await this.db
      .union([shareUsers, integrationUsers])
      .count('* as count')
      .first();

    return Number(result?.count || 0);
  }

  /**
   * Get all addresses that have any balance
   */
  private async getActiveAddresses(): Promise<string[]> {
    try {
      logger.info('Querying share_balances for addresses with shares > 0...');
      const shareAddresses = this.db('share_balances')
        .distinct('address')
        .where('shares', '>', 0);
      
      logger.info('Querying integration_balances for addresses with underlying_assets > 0...');
      const integrationAddresses = this.db('integration_balances')
        .distinct('address')
        .where('underlying_assets', '>', 0);
      
      logger.info('Executing UNION query to get all unique addresses...');
      const addresses = await this.db
        .union([shareAddresses, integrationAddresses])
        .pluck('address');
      
      logger.info(`Found ${addresses.length} total unique active addresses`);
      return addresses;
      
    } catch (error) {
      logger.error('Failed to get active addresses:', error);
      throw new Error(`Active addresses query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if address is excluded (zero or dead address)
   */
  private isExcludedAddress(address: string): boolean {
    return checkZeroAddress(address);
  }

  /**
   * Get most recent total droplets for a user from their last snapshot
   */
  private async getPreviousUserDroplets(address: string, currentDate: string): Promise<bigint> {
    const result = await this.db('user_daily_snapshots')
      .where('address', address.toLowerCase())
      .where('snapshot_date', '<', currentDate)
      .orderBy('snapshot_date', 'desc')
      .select('total_droplets')
      .first();
    
    return result ? BigInt(result.total_droplets) : 0n;
  }

  /**
   * Get previous day's total protocol droplets
   */
  private async getPreviousProtocolDroplets(currentDate: string): Promise<bigint> {
    const previousDate = this.getPreviousDay(currentDate);
    
    const result = await this.db('daily_snapshots')
      .where('snapshot_date', previousDate)
      .select('total_protocol_droplets')
      .first();
    
    return result ? BigInt(result.total_protocol_droplets) : 0n;
  }

  /**
   * Get previous day date string
   */
  private getPreviousDay(dateString: string): string {
    const date = new Date(dateString);
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0];
  }

  /**
   * Calculate daily droplets earned based on USD value
   */
  private calculateDailyDroplets(usdValue: bigint): bigint {
    // Convert USD value (with USD_DECIMALS precision) to droplets
    // DROPLET_USD_RATIO is the number of droplets per USD per day
    const ratio = BigInt(CONSTANTS.DROPLET_USD_RATIO);
    const usdScale = 10n ** CONSTANTS.USD_DECIMALS; // USD values are scaled by USD_DECIMALS (6)
    
    // Calculate droplets = (usdValue * ratio) / usdScale
    return (usdValue * ratio) / usdScale;
  }

  /**
   * Validate transfer consistency and retry if needed
   */
  private async validateAndRetryIfNeeded(
    dateString: string, 
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info('Validating transfer consistency between vault transfers and integration events');
    
    const validationResult = await validateTransferConsistency(blockRanges);
    
    if (validationResult.success) {
      logger.info(`Transfer validation passed: ${validationResult.matchedPairs} matched pairs, no inconsistencies found`);
      return;
    }

    logger.warn(`Transfer validation found ${validationResult.inconsistencies.length} inconsistencies, attempting to fix`);
    
    // Log detailed information about each inconsistency
    for (const inconsistency of validationResult.inconsistencies) {
      logger.warn(`INCONSISTENCY DETECTED - Type: ${inconsistency.type}`, {
        type: inconsistency.type,
        details: inconsistency.details,
        chainId: inconsistency.chainId,
        userAddress: inconsistency.userAddress,
        asset: inconsistency.asset,
        txHash: inconsistency.txHash,
        expectedAmount: inconsistency.expectedAmount,
        vaultEvent: inconsistency.vaultEvent ? {
          from_address: inconsistency.vaultEvent.from_address,
          to_address: inconsistency.vaultEvent.to_address,
          asset: inconsistency.vaultEvent.asset,
          chain_id: inconsistency.vaultEvent.chain_id,
          amount_delta: inconsistency.vaultEvent.amount_delta,
          tx_hash: inconsistency.vaultEvent.tx_hash,
          block_number: inconsistency.vaultEvent.block_number,
          isIntegrationAddress: inconsistency.vaultEvent.isIntegrationAddress
        } : null,
        integrationEvent: inconsistency.integrationEvent ? {
          address: inconsistency.integrationEvent.address,
          asset: inconsistency.integrationEvent.asset,
          chain_id: inconsistency.integrationEvent.chain_id,
          protocol_name: inconsistency.integrationEvent.protocol_name,
          event_type: inconsistency.integrationEvent.event_type,
          amount_delta: inconsistency.integrationEvent.amount_delta,
          tx_hash: inconsistency.integrationEvent.tx_hash,
          block_number: inconsistency.integrationEvent.block_number
        } : null
      });
    }

    const missingVaultInconsistencies = validationResult.inconsistencies.filter(inc => inc.type === 'missing_vault');
    const missingIntegrationInconsistencies = validationResult.inconsistencies.filter(inc => inc.type === 'missing_integration');

    if (missingVaultInconsistencies.length > 0) {
      logger.info(`Found ${missingVaultInconsistencies.length} missing vault events, clearing vault data and retrying`);
      await this.clearVaultDataForDate(dateString);
      await this.processVaultEvents(blockRanges);
    }

    if (missingIntegrationInconsistencies.length > 0) {
      logger.info(`Found ${missingIntegrationInconsistencies.length} missing integration events, clearing integration data and retrying`);
      
      const protocolInconsistencies = new Map<string, typeof missingIntegrationInconsistencies>();
      for (const inconsistency of missingIntegrationInconsistencies) {
        if (!inconsistency.integrationEvent) continue;
        
        const protocolName = inconsistency.integrationEvent.protocol_name;
        if (!protocolInconsistencies.has(protocolName)) {
          protocolInconsistencies.set(protocolName, []);
        }
        protocolInconsistencies.get(protocolName)!.push(inconsistency);
      }

      for (const [protocolName, inconsistencies] of protocolInconsistencies) {
        logger.info(`Clearing and retrying ${protocolName} due to ${inconsistencies.length} inconsistencies`);
        
        await this.clearIntegrationDataForProtocol(protocolName, dateString);
        
        const affectedChains = new Set(inconsistencies.map(inc => inc.chainId));
        for (const chainId of affectedChains) {
          const chainRange = blockRanges.find(range => range.chainId === chainId);
          if (chainRange) {
            const integrationIndexer = new IntegrationIndexer();
            await integrationIndexer.processSpecificIntegration(
              protocolName,
              chainId,
              chainRange.fromBlock,
              chainRange.toBlock,
              dateString
            );
          }
        }
      }

      const integrationRanges = blockRanges.filter(range => 
        range.chainId === CONSTANTS.CHAIN_IDS.SONIC || 
        range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE
      );
      
      if (integrationRanges.length > 0) {
        const integrationIndexer = new IntegrationIndexer();
        for (const [protocolName] of protocolInconsistencies) {
          await integrationIndexer.updateSpecificIntegrationBalances(protocolName, integrationRanges);
        }
      }
    }

    logger.info('Running final validation after retry attempts');
    const finalValidationResult = await validateTransferConsistency(blockRanges);
    
    if (!finalValidationResult.success) {
      const errorMessage = `Transfer validation still failed after retry: ${finalValidationResult.inconsistencies.length} inconsistencies remain. This indicates a code issue in the processing logic.`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    logger.info(`Final validation passed: ${finalValidationResult.matchedPairs} matched pairs, no inconsistencies`);
  }

  /**
   * Clear vault data for the specified date and reconstruct affected user balances from snapshots
   */
  private async clearVaultDataForDate(dateString: string): Promise<void> {
    logger.info(`Clearing vault data for date ${dateString}`);

    // Find all share balances that were last updated on this date
    const affectedBalances = await this.db('share_balances')
      .where('last_updated_date', dateString)
      .select('*');

    if (affectedBalances.length > 0) {
      logger.info(`Found ${affectedBalances.length} share balances that were last updated on ${dateString}`);
      
      // Group affected balances by user address for reconstruction
      const affectedUserAddresses = [...new Set(affectedBalances.map(b => b.address))];
      logger.info(`Affected users: ${affectedUserAddresses.length}`);

      // Calculate previous date for snapshot reconstruction
      const currentDate = new Date(dateString + 'T00:00:00.000Z');
      const previousDate = new Date(currentDate);
      previousDate.setDate(previousDate.getDate() - 1);
      const previousDateString = previousDate.toISOString().split('T')[0];

      logger.info(`Reconstructing balances from previous day snapshots: ${previousDateString}`);

      // Delete affected balances first
      const shareBalancesDeleted = await this.db('share_balances')
        .whereIn('id', affectedBalances.map(b => b.id))
        .del();
      logger.info(`Cleared ${shareBalancesDeleted} records from share_balances that were last updated on ${dateString}`);

      // Reconstruct balances from previous day's user snapshots
      for (const userAddress of affectedUserAddresses) {
        const previousSnapshot = await this.db('user_daily_snapshots')
          .where('address', userAddress)
          .where('snapshot_date', previousDateString)
          .first();

        if (previousSnapshot) {
          // Reconstruct each asset balance from the snapshot
          const assetsToReconstruct = [
            { asset: 'xETH', shares: previousSnapshot.xeth_shares_total, chainId: 1 },
            { asset: 'xBTC', shares: previousSnapshot.xbtc_shares_total, chainId: 1 },
            { asset: 'xUSD', shares: previousSnapshot.xusd_shares_total, chainId: 1 },
            { asset: 'xEUR', shares: previousSnapshot.xeur_shares_total, chainId: 1 }
          ];

          for (const { asset, shares, chainId } of assetsToReconstruct) {
            const shareAmount = BigInt(shares);
            if (shareAmount > 0n) {
              // Insert reconstructed balance with previous date as last_updated_date
              await this.db('share_balances').insert({
                address: userAddress,
                asset: asset,
                chain_id: chainId,
                shares: shareAmount.toString(),
                underlying_assets: null, // Will be calculated later
                last_update_block: 0, // Use 0 to indicate reconstructed from snapshot
                last_updated: new Date(previousDateString + 'T23:59:59.999Z'),
                last_updated_date: previousDateString,
                created_at: new Date()
              });
              
              logger.debug(`Reconstructed ${asset} balance for ${userAddress}: ${shareAmount} shares`);
            }
          }
        } else {
          logger.warn(`No previous snapshot found for user ${userAddress} on ${previousDateString}. User will start with zero balance.`);
        }
      }
    } else {
      logger.info(`No share balances found that were last updated on ${dateString}`);
    }

    const eventsDeleted = await this.db('daily_events')
      .where('event_date', dateString)
      .del();
    logger.info(`Cleared ${eventsDeleted} events from daily_events for date ${dateString}`);
  }

  /**
   * Clear integration data for a specific protocol and reconstruct affected user balances from snapshots
   */
  private async clearIntegrationDataForProtocol(protocolName: string, dateString: string): Promise<void> {
    logger.info(`Clearing integration data for protocol ${protocolName} on date ${dateString}`);

    // Find all integration balances that were last updated on this date for this protocol
    const affectedBalances = await this.db('integration_balances')
      .where('protocol_name', protocolName)
      .where('last_updated_date', dateString)
      .select('*');

    if (affectedBalances.length > 0) {
      logger.info(`Found ${affectedBalances.length} integration balances that were last updated on ${dateString} for protocol ${protocolName}`);
      
      // Group affected balances by user address for reconstruction
      const affectedUserAddresses = [...new Set(affectedBalances.map(b => b.address))];
      logger.info(`Affected users: ${affectedUserAddresses.length}`);

      // Calculate previous date for snapshot reconstruction
      const currentDate = new Date(dateString + 'T00:00:00.000Z');
      const previousDate = new Date(currentDate);
      previousDate.setDate(previousDate.getDate() - 1);
      const previousDateString = previousDate.toISOString().split('T')[0];

      logger.info(`Reconstructing integration balances from previous day snapshots: ${previousDateString}`);

      // Delete affected balances first
      const balancesDeleted = await this.db('integration_balances')
        .whereIn('id', affectedBalances.map(b => b.id))
        .del();
      logger.info(`Cleared ${balancesDeleted} integration balance records for protocol ${protocolName} that were last updated on ${dateString}`);

      // Reconstruct balances from previous day's user snapshots
      for (const userAddress of affectedUserAddresses) {
        const previousSnapshot = await this.db('user_daily_snapshots')
          .where('address', userAddress)
          .where('snapshot_date', previousDateString)
          .first();

        if (previousSnapshot) {
          try {
            // Parse the integration_breakdown JSON
            const integrationBreakdown = JSON.parse(previousSnapshot.integration_breakdown || '{}');
            
            if (integrationBreakdown[protocolName]) {
              const protocolData = integrationBreakdown[protocolName];
              
              // Reconstruct balances for each asset in this protocol (excluding USD total)
              for (const [assetType, amount] of Object.entries(protocolData)) {
                if (assetType !== 'USD' && typeof amount === 'string') {
                  const underlyingAssets = BigInt(amount as string);
                  
                  if (underlyingAssets > 0n) {
                    // We need to find the contract_address for this protocol/asset combination
                    // For now, we'll use a placeholder - this should be improved to track contract addresses properly
                    const contractAddress = affectedBalances.find(b => 
                      b.address === userAddress && 
                      b.asset === assetType && 
                      b.protocol_name === protocolName
                    )?.contract_address || '0x0000000000000000000000000000000000000000';

                    // Insert reconstructed integration balance
                    await this.db('integration_balances').insert({
                      address: userAddress,
                      asset: assetType,
                      chain_id: affectedBalances.find(b => b.address === userAddress && b.protocol_name === protocolName)?.chain_id || 1,
                      protocol_name: protocolName,
                      contract_address: contractAddress,
                      position_shares: '0', // We don't store position shares in snapshots, will be recalculated
                      underlying_assets: underlyingAssets.toString(),
                      last_update_block: 0, // Use 0 to indicate reconstructed from snapshot
                      last_updated: new Date(previousDateString + 'T23:59:59.999Z'),
                      last_updated_date: previousDateString,
                      created_at: new Date()
                    }).onConflict(['address', 'chain_id', 'contract_address']).merge();
                    
                    logger.debug(`Reconstructed ${protocolName} ${assetType} balance for ${userAddress}: ${underlyingAssets} underlying assets`);
                  }
                }
              }
            }
          } catch (error) {
            logger.error(`Failed to parse integration_breakdown JSON for user ${userAddress}:`, error);
            logger.warn(`User ${userAddress} will start with zero ${protocolName} balance.`);
          }
        } else {
          logger.warn(`No previous snapshot found for user ${userAddress} on ${previousDateString}. User will start with zero ${protocolName} balance.`);
        }
      }
    } else {
      logger.info(`No integration balances found that were last updated on ${dateString} for protocol ${protocolName}`);
    }

    const eventsDeleted = await this.db('daily_integration_events')
      .where('protocol_name', protocolName)
      .where('event_date', dateString)
      .del();
    logger.info(`Cleared ${eventsDeleted} integration events for protocol ${protocolName} on date ${dateString}`);
  }
}