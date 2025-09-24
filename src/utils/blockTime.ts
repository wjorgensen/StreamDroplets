/**
 * Block Time Utilities
 * Uses Alchemy's blocks-by-timestamp API for supported networks and binary search for others
 */

import { Network } from 'alchemy-sdk';
import { NetworkName, BlockByTimestampResponse } from '../config/constants';
import { TYPICAL_BLOCK_TIME_SEC, networkToNetworkName } from '../config/contracts';
import { AlchemyService } from './AlchemyService';
import { withBlockTimeRetry } from './retryUtils';

/**
 * Networks supported by Alchemy's blocks-by-timestamp API
 */
const SUPPORTED_TIMESTAMP_NETWORKS = new Set<NetworkName>([
  'eth-mainnet',
  'base-mainnet', 
  'arb-mainnet',
  'avax-mainnet'
]);

/**
 * Options for binary search fallback
 */
interface BinarySearchOptions {
  /** Max retries for a single getBlock call (default 5) */
  maxRetries?: number;
  /** Initial retry delay in ms (default 120) */
  initialBackoffMs?: number;
  /** Multiplier for initial window size around the estimate (default 4) */
  initialWindowMultiplier?: number;
  /** Minimum window size in blocks around the estimate (default 2048) */
  minWindow?: number;
  /** Maximum window size in blocks around the estimate (default 2_000_000) */
  maxWindow?: number;
}

/**
 * Binary search implementation for finding block by timestamp
 * Returns the greatest block number whose on-chain timestamp is strictly < targetTimestampSec
 */
async function findBlockNumberBeforeTimestampFromStart(
  chainId: number,
  targetTimestampSec: number,
  startBlock: number,
  alchemyService: AlchemyService,
  opts: BinarySearchOptions = {}
): Promise<number> {
  const alchemy = alchemyService.getAlchemyInstance(chainId);

  const maxRetries = opts.maxRetries ?? 5;
  const initialBackoffMs = opts.initialBackoffMs ?? 120;
  const initialWindowMultiplier = Math.max(1, opts.initialWindowMultiplier ?? 4);
  const minWindow = Math.max(1, opts.minWindow ?? 2048);
  const maxWindow = Math.max(minWindow, opts.maxWindow ?? 2_000_000);

  const typicalBlockTime = TYPICAL_BLOCK_TIME_SEC[chainId] ?? TYPICAL_BLOCK_TIME_SEC[1] ?? 12;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const getBlockWithRetry = async (num: number) => {
    let attempt = 0;
    let delay = initialBackoffMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const b = await alchemy.core.getBlock(num);
        if (!b || typeof b.timestamp !== 'number') {
          throw new Error(`Block ${num} not found or missing timestamp`);
        }
        return b;
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
  };

  // Get latest & genesis for bounds
  const latestNumber = await alchemy.core.getBlockNumber();
  const latestBlock = await getBlockWithRetry(latestNumber);
  const latestTs = latestBlock.timestamp;

  if (targetTimestampSec > latestTs) return latestNumber;

  const genesisBlock = await getBlockWithRetry(0);
  const genesisTs = genesisBlock.timestamp;
  if (targetTimestampSec <= genesisTs) return 0;

  // Ensure start is within [0, latest]
  const start = Math.min(Math.max(0, startBlock), latestNumber);
  const startB = await getBlockWithRetry(start);
  const startTs = startB.timestamp;

  // Estimate the target block near the timestamp using typical block time
  const dt = targetTimestampSec - startTs;
  const estShift = Math.trunc(dt / typicalBlockTime);
  let est = start + estShift;

  if (Number.isNaN(est) || !Number.isFinite(est)) est = start;
  if (est < 0) est = 0;
  if (est > latestNumber) est = latestNumber;

  // Helper to fetch a block timestamp safely
  const getTs = async (n: number) => (await getBlockWithRetry(n)).timestamp;

  // If our estimate already satisfies ts<target and next block >= target, return it quickly
  const estTs = await getTs(est);
  if (estTs < targetTimestampSec) {
    if (est === latestNumber) return est;
    const nextTs = await getTs(est + 1);
    if (nextTs >= targetTimestampSec) return est;
  } else {
    // estTs >= target; if est > 0 check left neighbor
    if (est > 0) {
      const prevTs = await getTs(est - 1);
      if (prevTs < targetTimestampSec) return est - 1;
    }
  }

  // Bracket the boundary around the estimate using exponential expansion
  let lo = -1; // lo will satisfy ts(lo) < target
  let hi = -1; // hi will satisfy ts(hi) >= target

  const directionRight = estTs < targetTimestampSec;
  let step = Math.max(
    minWindow,
    Math.min(
      maxWindow,
      Math.abs(estShift) * initialWindowMultiplier || minWindow
    )
  );

  if (directionRight) {
    // Move right until ts >= target OR we hit latest
    let cur = est;
    while (true) {
      lo = cur; // lo is safe: ts(lo) < target
      if (cur === latestNumber) {
        hi = latestNumber;
        break;
      }
      const next = Math.min(latestNumber, cur + step);
      const nextTs = await getTs(next);
      if (nextTs >= targetTimestampSec) {
        hi = next;
        break;
      }
      cur = next;
      step = Math.min(maxWindow, step * 2);
    }
  } else {
    // Move left until ts < target OR we hit genesis
    let cur = est;
    while (true) {
      hi = cur; // hi is safe: ts(hi) >= target
      if (cur === 0) {
        lo = 0;
        break;
      }
      const prev = Math.max(0, cur - step);
      const prevTs = await getTs(prev);
      if (prevTs < targetTimestampSec) {
        lo = prev;
        break;
      }
      cur = prev;
      step = Math.min(maxWindow, step * 2);
    }
  }

  // Binary search on [lo, hi] to find max n with ts(n) < target
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const midTs = await getTs(mid);
    if (midTs < targetTimestampSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return Math.max(0, lo);
}

/**
 * Fetches block numbers before timestamp using appropriate method per network
 */
export async function blocksBeforeTimestamp(
  timestamp: string,
  networks: NetworkName[],
  { fetchImpl, startingBlocks }: { fetchImpl?: typeof fetch; startingBlocks?: Record<string, number> } = {}
): Promise<Record<string, number>> {
  if (!Array.isArray(networks) || networks.length === 0) {
    throw new Error('networks must be a non-empty array of network names');
  }

  const results: Record<string, number> = {};
  const alchemyService = AlchemyService.getInstance();

  // Separate networks by support status
  const supportedNetworks = networks.filter(net => SUPPORTED_TIMESTAMP_NETWORKS.has(net));
  const unsupportedNetworks = networks.filter(net => !SUPPORTED_TIMESTAMP_NETWORKS.has(net));

  // Handle supported networks with Alchemy API
  if (supportedNetworks.length > 0) {
    const apiKey = process.env.ALCHEMY_API_KEY;
    if (!apiKey) throw new Error('ALCHEMY_API_KEY is required in env');

    const doFetch: typeof fetch = fetchImpl ?? (globalThis as any).fetch;
    if (!doFetch) {
      throw new Error('No fetch implementation found. Provide fetchImpl or run on Node 18+/Deno/Bun/browser.');
    }

    for (const network of supportedNetworks) {
      const result = await withBlockTimeRetry(async () => {
        const url = `https://api.g.alchemy.com/data/v1/${encodeURIComponent(apiKey)}/utility/blocks/by-timestamp`;
        
        const params = new URLSearchParams();
        params.set('networks', network);
        params.set('timestamp', timestamp);
        params.set('direction', 'BEFORE');

        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiKey}`,
        };

        const res = await doFetch(`${url}?${params.toString()}`, { 
          method: 'GET', 
          headers 
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Alchemy by-timestamp error ${res.status}: ${body || res.statusText}`);
        }

        const json = (await res.json()) as BlockByTimestampResponse;
        
        if (json.data && json.data.length > 0 && json.data[0]?.block) {
          return json.data[0].block.number;
        }
        
        throw new Error(`No block data returned for network ${network}`);
      }, `fetch block for ${network}`);

      results[network] = result;
    }
  }

  // Handle unsupported networks with binary search
  if (unsupportedNetworks.length > 0) {
    const targetTimestamp = new Date(timestamp).getTime() / 1000; // Convert to unix seconds

    for (const network of unsupportedNetworks) {
      const result = await withBlockTimeRetry(async () => {
        // Map network name back to chainId for binary search
        let chainId: number;
        
        // Find chainId from network name
        const chainConfig = Object.values({
          ethereum: { chainId: 1, alchemyNetwork: Network.ETH_MAINNET },
          sonic: { chainId: 146, alchemyNetwork: Network.SONIC_MAINNET },
          base: { chainId: 8453, alchemyNetwork: Network.BASE_MAINNET },
          arbitrum: { chainId: 42161, alchemyNetwork: Network.ARB_MAINNET },
          avalanche: { chainId: 43114, alchemyNetwork: Network.AVAX_MAINNET },
          berachain: { chainId: 80094, alchemyNetwork: Network.BERACHAIN_MAINNET },
        }).find(config => {
          try {
            return networkToNetworkName(config.alchemyNetwork) === network;
          } catch {
            return false;
          }
        });

        if (!chainConfig) {
          throw new Error(`Could not find chainId for network ${network}`);
        }
        chainId = chainConfig.chainId;

        // Use the provided starting block or fall back to a reasonable default
        const startBlock = startingBlocks?.[network] ?? 1000;
        
        return await findBlockNumberBeforeTimestampFromStart(
          chainId,
          targetTimestamp,
          startBlock,
          alchemyService
        );
      }, `binary search block for ${network}`);

      results[network] = result;
    }
  }

  return results;
}

/**
 * Convenience wrapper for fetching block before timestamp for a single network
 */
export async function blockBeforeTimestamp(
  timestamp: string,
  network: NetworkName,
  opts?: Parameters<typeof blocksBeforeTimestamp>[2]
): Promise<number> {
  const map = await blocksBeforeTimestamp(timestamp, [network], opts);
  if (map[network] === undefined) {
    throw new Error(`No block number returned for network "${network}"`);
  }
  return map[network];
}