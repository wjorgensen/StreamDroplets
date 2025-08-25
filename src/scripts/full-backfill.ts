import { createPublicClient, http, Address, parseAbiItem, decodeEventLog } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CONSTANTS, AssetType } from '../config/constants';

const logger = createLogger('FullBackfill');

// Contract addresses from environment
const VAULTS = {
  xETH: process.env.XETH_VAULT_ETH || '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
  xBTC: process.env.XBTC_VAULT_ETH || '0x12fd502e2052CaFB41eccC5B596023d9978057d6',
  xUSD: process.env.XUSD_VAULT_ETH || '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
  xEUR: process.env.XEUR_VAULT_ETH || '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
};

// StreamVault Events
const EVENTS = {
  Stake: parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)'),
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  InstantUnstake: parseAbiItem('event InstantUnstake(address indexed account, uint256 amount, uint256 round)'),
  RoundRolled: parseAbiItem('event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)'),
};

class FullBackfill {
  private db = getDb();
  private client: any;
  private stats = {
    rounds: 0,
    stakes: 0,
    unstakes: 0,
    redeems: 0,
    snapshots: 0,
    users: new Set<string>(),
  };

  constructor() {
    const apiKey = process.env.ALCHEMY_API_KEY_1;
    if (!apiKey) {
      throw new Error('ALCHEMY_API_KEY_1 not set');
    }

    this.client = createPublicClient({
      chain: mainnet,
      transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, {
        retryCount: 5,
        retryDelay: 2000,
      }),
    });
  }

  async clearExistingData() {
    logger.info('Clearing existing data...');
    await this.db('balance_snapshots').delete();
    await this.db('rounds').delete();
    await this.db('share_events').delete();
    await this.db('unstake_events').delete();
    await this.db('droplets_cache').delete();
    await this.db('current_balances').delete();
    logger.info('Existing data cleared');
  }

  async backfillAsset(asset: AssetType) {
    const vaultAddress = VAULTS[asset];
    logger.info(`\n=== Backfilling ${asset} from ${vaultAddress} ===`);

    // Start from earliest deployment (xUSD at block 21871574)
    // This ensures we catch all events for all vaults
    const FROM_BLOCK = 21871574n;
    const currentBlock = await this.client.getBlockNumber();
    
    logger.info(`Scanning blocks ${FROM_BLOCK} to ${currentBlock}`);

    // Process in chunks to avoid rate limits
    const CHUNK_SIZE = 1000n;
    let processedBlocks = 0n;

    for (let startBlock = FROM_BLOCK; startBlock < currentBlock; startBlock += CHUNK_SIZE) {
      const endBlock = startBlock + CHUNK_SIZE - 1n > currentBlock ? currentBlock : startBlock + CHUNK_SIZE - 1n;
      
      if (processedBlocks % 10000n === 0n) {
        logger.info(`Progress: ${processedBlocks}/${currentBlock - FROM_BLOCK} blocks processed`);
      }

      // Fetch all events for this chunk
      const [roundRolls, stakes, unstakes, redeems] = await Promise.all([
        this.client.getLogs({
          address: vaultAddress as Address,
          event: EVENTS.RoundRolled,
          fromBlock: startBlock,
          toBlock: endBlock,
        }),
        this.client.getLogs({
          address: vaultAddress as Address,
          event: EVENTS.Stake,
          fromBlock: startBlock,
          toBlock: endBlock,
        }),
        this.client.getLogs({
          address: vaultAddress as Address,
          event: EVENTS.Unstake,
          fromBlock: startBlock,
          toBlock: endBlock,
        }),
        this.client.getLogs({
          address: vaultAddress as Address,
          event: EVENTS.Redeem,
          fromBlock: startBlock,
          toBlock: endBlock,
        }),
      ]);

      // Process RoundRolled events
      for (const log of roundRolls) {
        const decoded = decodeEventLog({
          abi: [EVENTS.RoundRolled],
          data: log.data,
          topics: log.topics,
        });

        await this.db('rounds').insert({
          round_id: Number(decoded.args.round),
          asset,
          chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
          start_block: Number(log.blockNumber),
          start_ts: new Date(),
          pps: decoded.args.pricePerShare.toString(),
          pps_scale: 18,
          shares_minted: decoded.args.sharesMinted.toString(),
          yield: decoded.args.yield.toString(),
          is_yield_positive: decoded.args.isYieldPositive,
          tx_hash: log.transactionHash,
        }).onConflict(['round_id', 'asset', 'chain_id']).merge();

        this.stats.rounds++;
      }

      // Process Stake events
      for (const log of stakes) {
        const decoded = decodeEventLog({
          abi: [EVENTS.Stake],
          data: log.data,
          topics: log.topics,
        });

        const address = decoded.args.account.toLowerCase();
        this.stats.users.add(address);

        await this.db('share_events').insert({
          chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
          asset,
          address,
          event_type: 'stake',
          event_classification: 'share_change',
          shares_delta: decoded.args.amount.toString(),
          round: Number(decoded.args.round),
          block: Number(log.blockNumber),
          timestamp: new Date(),
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
        }).onConflict(['tx_hash', 'log_index']).ignore();

        this.stats.stakes++;
      }

      // Process Unstake events
      for (const log of unstakes) {
        const decoded = decodeEventLog({
          abi: [EVENTS.Unstake],
          data: log.data,
          topics: log.topics,
        });

        const address = decoded.args.account.toLowerCase();
        this.stats.users.add(address);

        await this.db('share_events').insert({
          chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
          asset,
          address,
          event_type: 'unstake',
          event_classification: 'share_change',
          shares_delta: `-${decoded.args.amount}`,
          round: Number(decoded.args.round),
          block: Number(log.blockNumber),
          timestamp: new Date(),
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
        }).onConflict(['tx_hash', 'log_index']).ignore();

        // Track unstake for round exclusion
        await this.db('unstake_events').insert({
          address,
          asset,
          round: Number(decoded.args.round),
          amount: decoded.args.amount.toString(),
          block: Number(log.blockNumber),
        }).onConflict(['address', 'asset', 'round']).ignore();

        this.stats.unstakes++;
      }

      // Process Redeem events
      for (const log of redeems) {
        const decoded = decodeEventLog({
          abi: [EVENTS.Redeem],
          data: log.data,
          topics: log.topics,
        });

        const address = decoded.args.account.toLowerCase();
        this.stats.users.add(address);

        await this.db('share_events').insert({
          chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
          asset,
          address,
          event_type: 'redeem',
          event_classification: 'share_change',
          shares_delta: decoded.args.share.toString(),
          round: Number(decoded.args.round),
          block: Number(log.blockNumber),
          timestamp: new Date(),
          tx_hash: log.transactionHash,
          log_index: log.logIndex,
        }).onConflict(['tx_hash', 'log_index']).ignore();

        this.stats.redeems++;
      }

      processedBlocks += CHUNK_SIZE;
    }

    logger.info(`${asset} backfill complete:
      - Rounds: ${this.stats.rounds}
      - Stakes: ${this.stats.stakes}
      - Unstakes: ${this.stats.unstakes}
      - Redeems: ${this.stats.redeems}
      - Unique users: ${this.stats.users.size}`);
  }

  async reconstructBalances() {
    logger.info('\n=== Reconstructing Balance History ===');

    // Get all unique users and assets
    const events = await this.db('share_events')
      .select('address', 'asset', 'event_type', 'shares_delta', 'round', 'block')
      .orderBy(['address', 'asset', 'block']);

    const balancesByUser: Record<string, Record<string, bigint>> = {};
    const roundBalances: Record<number, Array<{ address: string; asset: string; balance: bigint }>> = {};

    // Build balance history
    for (const event of events) {
      const { address, asset, event_type, shares_delta, round } = event;

      if (!balancesByUser[address]) {
        balancesByUser[address] = {};
      }
      if (!balancesByUser[address][asset]) {
        balancesByUser[address][asset] = 0n;
      }

      // Update balance based on event type
      if (event_type === 'stake' || event_type === 'redeem') {
        balancesByUser[address][asset] += BigInt(shares_delta);
      } else if (event_type === 'unstake') {
        balancesByUser[address][asset] += BigInt(shares_delta); // Already negative
      }

      // Store balance at each round
      if (!roundBalances[round]) {
        roundBalances[round] = [];
      }
      roundBalances[round].push({
        address,
        asset,
        balance: balancesByUser[address][asset],
      });
    }

    // Create balance snapshots for each round
    const rounds = await this.db('rounds').select('round_id', 'asset').orderBy('round_id');
    
    for (const round of rounds) {
      const balancesAtRound = roundBalances[round.round_id] || [];
      
      for (const { address, asset, balance } of balancesAtRound) {
        if (balance > 0n) {
          // Check if user unstaked in this round
          const unstaked = await this.db('unstake_events')
            .where({ address, asset, round: round.round_id })
            .first();

          await this.db('balance_snapshots').insert({
            address,
            asset,
            round_id: round.round_id,
            shares_at_start: balance.toString(),
            had_unstake_in_round: !!unstaked,
            snapshot_block: 0, // Will be updated later
          }).onConflict(['address', 'asset', 'round_id']).merge();

          this.stats.snapshots++;
        }
      }

      // Also update current_balances
      for (const { address, asset, balance } of balancesAtRound) {
        await this.db('current_balances').insert({
          address,
          asset,
          chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
          shares: balance.toString(),
          last_update_block: 0,
        }).onConflict(['address', 'asset', 'chain_id']).merge({
          shares: balance.toString(),
        });
      }
    }

    logger.info(`Created ${this.stats.snapshots} balance snapshots`);
  }

  async run() {
    logger.info('Starting FULL historical backfill from contract creation...');
    
    // Clear existing data for clean start
    await this.clearExistingData();

    // Add excluded addresses
    logger.info('Adding excluded addresses...');
    for (const [asset, address] of Object.entries(VAULTS)) {
      await this.db('excluded_addresses').insert({
        address: address.toLowerCase(),
        reason: `${asset} vault contract`,
      }).onConflict('address').ignore();
    }

    // Backfill each asset
    for (const asset of Object.keys(VAULTS) as AssetType[]) {
      await this.backfillAsset(asset);
      
      // Reset per-asset stats
      this.stats.stakes = 0;
      this.stats.unstakes = 0;
      this.stats.redeems = 0;
      this.stats.rounds = 0;
    }

    // Reconstruct balance history
    await this.reconstructBalances();

    logger.info('\n=== BACKFILL COMPLETE ===');
    logger.info(`Total unique users: ${this.stats.users.size}`);
    logger.info(`Total balance snapshots: ${this.stats.snapshots}`);

    // Test with user's address
    const testAddress = '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c';
    const userEvents = await this.db('share_events')
      .where('address', testAddress)
      .orderBy('block');
    
    logger.info(`\nUser ${testAddress} has ${userEvents.length} events`);
    for (const event of userEvents) {
      logger.info(`  Round ${event.round}: ${event.event_type} ${event.shares_delta} ${event.asset}`);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const backfill = new FullBackfill();
  backfill.run()
    .then(() => {
      logger.info('Backfill completed successfully');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Backfill failed:', error);
      console.error('Full error details:', error);
      process.exit(1);
    });
}

export { FullBackfill };