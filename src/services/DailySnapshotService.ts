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
import { AlchemyService } from '../utils/AlchemyService';
import { STREAM_VAULT_ABI } from '../config/abis/streamVault';
import { withAlchemyRetry } from '../utils/retryUtils';

const logger = createLogger('DailySnapshotService');

interface SnapshotPriceData {
  snapshot_date: string;
  eth_usd_price: string;
  btc_usd_price: string;
  usd_usd_price: string;
  eur_usd_price: string;
  xusd_price_per_share: string;
}

export class DailySnapshotService {
  private db = getDb();
  private oracleService: ChainlinkService;
  private alchemyService: AlchemyService;
  
  constructor() {
    this.oracleService = new ChainlinkService();
    this.alchemyService = AlchemyService.getInstance();
  }

  /**
   * Processes daily snapshot for given date and block ranges
   */
  async processDailySnapshot(
    dateString: string,
    blockRanges: BlockRange[]
  ): Promise<void> {
    const startTime = Date.now();
    logger.info(`Starting daily snapshot processing for ${dateString} with ${blockRanges.length} block ranges`);

    try {
      logger.info(`Block ranges received: ${JSON.stringify(blockRanges.map(r => ({chainId: r.chainId, fromBlock: r.fromBlock, toBlock: r.toBlock})))}`);
      
      try {
        logger.info(`Step 1: Processing vault events with full block ranges`);
        await this.processVaultEvents(blockRanges);
        logger.info(`Step 1 completed: Vault events processed successfully`);
      } catch (error) {
        logger.error(`Step 1 failed: Error processing vault events`, error);
        throw new Error(`Failed at Step 1 - Vault events processing: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      const integrationRanges = blockRanges.filter(range => 
        range.chainId === CONSTANTS.CHAIN_IDS.SONIC || 
        range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE
      );
      
      const hasIntegrationChains = integrationRanges.length > 0;
      
      if (hasIntegrationChains) {
        try {
          logger.info(`Step 2: Processing integration events`);
        await this.processIntegrationEvents(integrationRanges);
          logger.info(`Step 2 completed: Integration events processed successfully`);
        } catch (error) {
          logger.error(`Step 2 failed: Error processing integration events`, error);
          throw new Error(`Failed at Step 2 - Integration events processing: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
          logger.info(`Step 3: Updating integration balances using integration ranges`);
          await this.updateIntegrationBalances(integrationRanges);
          logger.info(`Step 3 completed: Integration balances updated successfully`);
        } catch (error) {
          logger.error(`Step 3 failed: Error updating integration balances`, error);
          throw new Error(`Failed at Step 3 - Integration balances update: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
          logger.info(`Step 4: Validating transfer consistency using original full block ranges`);
          await this.validateAndRetryIfNeeded(dateString);
          logger.info(`Step 4 completed: Transfer validation completed successfully`);
        } catch (error) {
          logger.error(`Step 4 failed: Error during transfer validation`, error);
          throw new Error(`Failed at Step 4 - Transfer validation: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        logger.info('No integration chains in block ranges, skipping integration processing and validation (Steps 2-4)');
      }
      
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
      
      let priceData: SnapshotPriceData;
      try {
        logger.info(`Step 5: Fetching price data using Ethereum block ${ethBlockRange.toBlock}`);
        priceData = await this.getPriceDataForDate(dateString, ethBlockRange);
        logger.info(`Step 5 completed: Price data fetched successfully`);
      } catch (error) {
        logger.error(`Step 5 failed: Error fetching price data`, error);
        throw new Error(`Failed at Step 5 - Price data fetching: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        logger.info(`Step 6: Processing user snapshots`);
        await this.processUserSnapshots(dateString, priceData);
        logger.info(`Step 6 completed: User snapshots processed successfully`);
      } catch (error) {
        logger.error(`Step 6 failed: Error processing user snapshots`, error);
        throw new Error(`Failed at Step 6 - User snapshots processing: ${error instanceof Error ? error.message : String(error)}`);
      }

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
   * Processes vault events using VaultIndexer
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
   * Processes integration events using IntegrationIndexer
   */
  private async processIntegrationEvents(
    integrationRanges: BlockRange[]
  ): Promise<void> {
    logger.info(`Processing integration events for ${integrationRanges.length} integration chain(s)`);
    
    const integrationIndexer = new IntegrationIndexer();
    await integrationIndexer.fetchAndProcessIntegrations(integrationRanges);
    
    logger.info('Integration events processing completed');
  }

  /**
   * Updates integration balances with price per share
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
   * Gets price data for the snapshot date
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
      
      logger.info(`Fetching xUSD price per share at block ${ethBlockRange.toBlock}`);
      const xUSDPricePerShare = await this.getXUSDPricePerShare(ethBlockRange.toBlock);
      logger.info(`xUSD price per share: ${xUSDPricePerShare.toString()}`);
      
      const priceData = {
        snapshot_date: dateString,
        eth_usd_price: prices.eth.toString(),
        btc_usd_price: prices.btc.toString(),
        usd_usd_price: prices.usdc.toString(),
        eur_usd_price: prices.eur.toString(),
        xusd_price_per_share: xUSDPricePerShare.toString(),
      };
      
      logger.info(`Price data object created successfully for ${dateString}`);
      return priceData;
      
    } catch (error) {
      logger.error(`Failed to get price data for ${dateString} at block ${ethBlockRange.toBlock}:`, error);
      throw new Error(`Price data retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Gets xUSD price per share at a specific block
   * Uses the same logic as BalanceTracker: gets current round and then roundPricePerShare(round - 1)
   */
  private async getXUSDPricePerShare(blockNumber: number): Promise<bigint> {
    try {
      const viemEthClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.ETHEREUM);
      const xUSDVaultAddress = CONTRACTS.xUSD.ethereum as `0x${string}`;
      
      const currentRound = await withAlchemyRetry(async () => {
        return await viemEthClient.readContract({
          address: xUSDVaultAddress,
          abi: STREAM_VAULT_ABI,
          functionName: 'round',
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `xUSD vault round at block ${blockNumber}`);
      
      logger.info(`xUSD current round: ${currentRound.toString()}`);
      
      const pricePerShareRound = currentRound > 1n ? currentRound - 1n : 1n;
      
      const pricePerShare = await withAlchemyRetry(async () => {
        return await viemEthClient.readContract({
          address: xUSDVaultAddress,
          abi: STREAM_VAULT_ABI,
          functionName: 'roundPricePerShare',
          args: [pricePerShareRound]
        }) as bigint;
      }, `xUSD vault price per share for round ${pricePerShareRound}`);
      
      logger.info(`xUSD price per share for round ${pricePerShareRound} (current round: ${currentRound}): ${pricePerShare.toString()} (scale: ${CONTRACTS.xUSD.ppsScale.toString()})`);
      
      return pricePerShare;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`xUSD vault not deployed at block ${blockNumber}, using fallback value of 1e6`);
        return 10n ** CONTRACTS.xUSD.ppsScale;
      }
      
      logger.error(`Error fetching xUSD price per share at block ${blockNumber}:`, error);
      throw new Error(`Failed to fetch xUSD price per share: ${errorMessage}`);
    }
  }

  /**
   * Processes user snapshots for all active addresses
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
          const { snapshot, hasPositions } = await this.createUserSnapshot(address, dateString, priceData);
          if (hasPositions || snapshot.total_usd_value !== '0') {
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
   * Creates user snapshot for a single address
   */
  private async createUserSnapshot(
    address: string,
    dateString: string,
    priceData: SnapshotPriceData
  ): Promise<{ snapshot: UserDailySnapshot; hasPositions: boolean }> {
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    const assetBreakdown: Record<string, { shares: bigint, usd: bigint }> = {};
    let totalUsd = 0n;
    
    for (const asset of assets) {
      const { shares, underlyingAssets } = await this.getTotalBalancesForAsset(address, asset);
      const priceKey = `${asset.toLowerCase().replace('x', '')}_usd_price` as keyof SnapshotPriceData;
      const usdPrice = BigInt(priceData[priceKey] as string);
      
      const oracleScale = 10n ** 8n;
      const usdScale = 10n ** CONSTANTS.USD_DECIMALS;
      const assetDecimals = CONTRACTS[asset].decimals;
      
      const usdValue = (underlyingAssets * usdPrice * usdScale) / (10n ** assetDecimals * oracleScale);
      
      assetBreakdown[asset] = { shares, usd: usdValue };
      totalUsd += usdValue;
    }
    
    const usdcPrice = BigInt(priceData.usd_usd_price);
    const xUSDPricePerShare = BigInt(priceData.xusd_price_per_share);
    const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
    const xUSDPpsScale = CONTRACTS.xUSD.ppsScale;
    const ppsScaleFactor = 10n ** xUSDPpsScale;
    
    const integrationBreakdown = await this.buildUserIntegrationBreakdown(address, xUSDPricePerShare, usdcPrice);
    
    const integrationBalances = await this.db('integration_balances')
      .where('address', address.toLowerCase())
      .sum('underlying_assets as total')
      .first();
    const integrationXUSDShares = BigInt(integrationBalances?.total || '0');
    const integrationUsdcAmount = (integrationXUSDShares * xUSDPricePerShare) / ppsScaleFactor;
    const integrationUsdValue = (integrationUsdcAmount * usdcPrice) / oracleScale;
    totalUsd += integrationUsdValue;
    
    const dailyDroplets = this.calculateDailyDroplets(totalUsd);
    const previousDroplets = await this.getPreviousUserDroplets(address, dateString);
    const totalDroplets = previousDroplets + dailyDroplets;
    
    const hasVaultShares = Object.values(assetBreakdown).some(({ shares }) => shares > 0n);
    const hasIntegrationBalances = integrationUsdValue > 0n;

    return {
      snapshot: {
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
      },
      hasPositions: hasVaultShares || hasIntegrationBalances,
    };
  }

  /**
   * Processes protocol-wide snapshot
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
          
          const oracleScale = 10n ** 8n;
          const usdScale = 10n ** CONSTANTS.USD_DECIMALS;
          const assetDecimals = CONTRACTS[asset].decimals;
          
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
      
      const usdcPrice = BigInt(priceData.usd_usd_price);
      const xUSDPricePerShare = BigInt(priceData.xusd_price_per_share);
      const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
      const xUSDPpsScale = CONTRACTS.xUSD.ppsScale;
      const ppsScaleFactor = 10n ** xUSDPpsScale;
      
      logger.info('Building total integration breakdown...');
      const totalIntegrationBreakdown = await this.buildTotalIntegrationBreakdown(xUSDPricePerShare, usdcPrice);
      logger.info('Integration breakdown completed');
      
      logger.info('Calculating total integration USD...');
      const totalIntegrationUsdResult = await this.db('integration_balances')
        .sum('underlying_assets as total')
        .first();
      const totalIntegrationXUSDShares = BigInt(totalIntegrationUsdResult?.total || '0');
      const totalIntegrationUsdcAmount = (totalIntegrationXUSDShares * xUSDPricePerShare) / ppsScaleFactor;
      const totalIntegrationUsd = (totalIntegrationUsdcAmount * usdcPrice) / oracleScale;
      totalProtocolUsd += totalIntegrationUsd;
      
      logger.info(`Total integration USD: ${totalIntegrationUsd}, Total protocol USD: ${totalProtocolUsd}`);
      
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
   * Gets total shares and underlying assets for a user's asset
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
   * Gets total protocol shares and underlying assets for an asset
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
   * Builds integration breakdown JSON for a user
   */
  private async buildUserIntegrationBreakdown(address: string, xUSDPricePerShare: bigint, usdcPrice: bigint): Promise<string> {
    const integrationBalances = await this.db('integration_balances')
      .where('address', address.toLowerCase())
      .where('underlying_assets', '>', 0)
      .select('protocol_name', 'asset', 'underlying_assets');

    const breakdown: IntegrationBreakdown = {};
    const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
    const xUSDPpsScale = CONTRACTS.xUSD.ppsScale;
    const ppsScaleFactor = 10n ** xUSDPpsScale;
    
    for (const balance of integrationBalances) {
      const protocolName = balance.protocol_name;
      const assetType = balance.asset;
      const xUSDShares = BigInt(balance.underlying_assets);
      
      const usdcAmount = (xUSDShares * xUSDPricePerShare) / ppsScaleFactor;
      const usdValue = (usdcAmount * usdcPrice) / oracleScale;
      
      if (!breakdown[protocolName]) {
        breakdown[protocolName] = {
          USD: '0'
        };
      }
      
      if (!breakdown[protocolName][assetType]) {
        breakdown[protocolName][assetType] = '0';
      }
      breakdown[protocolName][assetType] = (BigInt(breakdown[protocolName][assetType]) + xUSDShares).toString();
      
      breakdown[protocolName].USD = (BigInt(breakdown[protocolName].USD) + usdValue).toString();
    }
    
    return JSON.stringify(breakdown);
  }

  /**
   * Builds total integration breakdown JSON for protocol
   */
  private async buildTotalIntegrationBreakdown(xUSDPricePerShare: bigint, usdcPrice: bigint): Promise<string> {
    const integrationBalances = await this.db('integration_balances')
      .where('underlying_assets', '>', 0)
      .select('protocol_name', 'asset', 'underlying_assets');

    const breakdown: IntegrationBreakdown = {};
    const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
    const xUSDPpsScale = CONTRACTS.xUSD.ppsScale;
    const ppsScaleFactor = 10n ** xUSDPpsScale;
    
    for (const balance of integrationBalances) {
      const protocolName = balance.protocol_name;
      const assetType = balance.asset;
      const xUSDShares = BigInt(balance.underlying_assets);
      
      const usdcAmount = (xUSDShares * xUSDPricePerShare) / ppsScaleFactor;
      const usdValue = (usdcAmount * usdcPrice) / oracleScale;
      
      if (!breakdown[protocolName]) {
        breakdown[protocolName] = {
          USD: '0'
        };
      }
      
      if (!breakdown[protocolName][assetType]) {
        breakdown[protocolName][assetType] = '0';
      }
      breakdown[protocolName][assetType] = (BigInt(breakdown[protocolName][assetType]) + xUSDShares).toString();
      
      breakdown[protocolName].USD = (BigInt(breakdown[protocolName].USD) + usdValue).toString();
    }
    
    return JSON.stringify(breakdown);
  }

  /**
   * Gets total unique users with any balance
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
   * Gets all addresses that have any balance
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
   * Checks if address is excluded
   */
  private isExcludedAddress(address: string): boolean {
    return checkZeroAddress(address);
  }

  /**
   * Gets most recent total droplets for a user from their last snapshot
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
   * Gets previous day's total protocol droplets
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
   * Gets previous day date string
   */
  private getPreviousDay(dateString: string): string {
    const date = new Date(dateString);
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0];
  }

  /**
   * Calculates daily droplets earned based on USD value
   */
  private calculateDailyDroplets(usdValue: bigint): bigint {
    const ratio = BigInt(CONSTANTS.DROPLET_USD_RATIO);
    const usdScale = 10n ** CONSTANTS.USD_DECIMALS;
    
    return (usdValue * ratio) / usdScale;
  }

  /**
   * Validates transfer consistency
   */
  private async validateAndRetryIfNeeded(
    dateString: string,
  ): Promise<void> {
    logger.info('Validating transfer consistency between vault transfers and integration events');

    const validationResult = await validateTransferConsistency(dateString);

    if (validationResult.success) {
      logger.info(`Transfer validation passed: ${validationResult.verifiedPairs} verified pairs, no inconsistencies found`);
      return;
    }

    const totalInconsistencies = validationResult.unverifiedVaultEvents.length + validationResult.unverifiedIntegrationEvents.length;
    logger.error(`Transfer validation found ${totalInconsistencies} inconsistencies`);
    logger.error(`Summary: ${validationResult.totalVaultTransfers} vault transfers, ${validationResult.totalIntegrationEvents} integration events, ${validationResult.verifiedPairs} verified pairs`);

    if (validationResult.unverifiedVaultEvents.length > 0) {
      logger.error(`Found ${validationResult.unverifiedVaultEvents.length} unverified vault events:`);
      for (const vaultEvent of validationResult.unverifiedVaultEvents) {
        logger.error('UNVERIFIED VAULT EVENT', {
          from_address: vaultEvent.from_address,
          to_address: vaultEvent.to_address,
          asset: vaultEvent.asset,
          chain_id: vaultEvent.chain_id,
          amount_delta: vaultEvent.amount_delta,
          tx_hash: vaultEvent.tx_hash,
          block_number: vaultEvent.block_number,
          isIntegrationAddress: vaultEvent.isIntegrationAddress
        });
      }
    }

    if (validationResult.unverifiedIntegrationEvents.length > 0) {
      logger.error(`Found ${validationResult.unverifiedIntegrationEvents.length} unverified integration events:`);
      for (const integrationEvent of validationResult.unverifiedIntegrationEvents) {
        logger.error('UNVERIFIED INTEGRATION EVENT', {
          address: integrationEvent.address,
          asset: integrationEvent.asset,
          chain_id: integrationEvent.chain_id,
          protocol_name: integrationEvent.protocol_name,
          event_type: integrationEvent.event_type,
          amount_delta: integrationEvent.amount_delta,
          tx_hash: integrationEvent.tx_hash,
          block_number: integrationEvent.block_number
        });
      }
    }

    logger.error(`Transfer validation completed with errors: ${validationResult.unverifiedVaultEvents.length} unverified vault events, ${validationResult.unverifiedIntegrationEvents.length} unverified integration events. Continuing processing...`);
  }


}
