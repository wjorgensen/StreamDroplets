#!/usr/bin/env tsx
/**
 * Example of using multiple API keys for parallel requests
 * This demonstrates how to avoid rate limits by distributing requests across keys
 */

import { getRPCManager } from '../src/utils/rpcManager';
import { parseAbi } from 'viem';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('MultiKeyExample');

async function fetchWithSingleClient() {
  logger.info('Fetching with single client (rotates keys automatically)...');
  
  const rpcManager = getRPCManager();
  
  // Each call to createClient() will rotate through available keys
  for (let i = 0; i < 5; i++) {
    const client = rpcManager.createClient('ethereum');
    const blockNumber = await client.getBlockNumber();
    logger.info(`Request ${i + 1}: Block ${blockNumber}`);
  }
  
  logger.info('Stats:', rpcManager.getStats());
}

async function fetchWithParallelClients() {
  logger.info('\nFetching with parallel clients (uses all keys simultaneously)...');
  
  const rpcManager = getRPCManager();
  const clients = rpcManager.createParallelClients('ethereum');
  
  logger.info(`Created ${clients.length} parallel clients`);
  
  // Distribute requests across all available clients
  const promises = clients.map(async (client, index) => {
    const blockNumber = await client.getBlockNumber();
    return { clientIndex: index, blockNumber };
  });
  
  const results = await Promise.all(promises);
  results.forEach(r => {
    logger.info(`Client ${r.clientIndex}: Block ${r.blockNumber}`);
  });
  
  logger.info('Stats:', rpcManager.getStats());
}

async function fetchEventsInParallel() {
  logger.info('\nFetching events with load distribution...');
  
  const rpcManager = getRPCManager();
  const clients = rpcManager.createParallelClients('ethereum');
  
  const XETH_ADDRESS = '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153';
  const deploymentBlock = 21872213n;
  const chunkSize = 1000n;
  const numChunks = 10;
  
  // Distribute chunks across available clients
  const promises = [];
  for (let i = 0; i < numChunks; i++) {
    const clientIndex = i % clients.length;
    const client = clients[clientIndex];
    const fromBlock = deploymentBlock + (BigInt(i) * chunkSize);
    const toBlock = fromBlock + chunkSize - 1n;
    
    promises.push(
      client.getLogs({
        address: XETH_ADDRESS,
        event: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0],
        fromBlock,
        toBlock,
      }).then(logs => ({
        chunk: i,
        clientIndex,
        eventsFound: logs.length,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
      })).catch(err => ({
        chunk: i,
        clientIndex,
        eventsFound: 0,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        error: err.message,
      }))
    );
  }
  
  const results = await Promise.all(promises);
  
  results.forEach(r => {
    if (r.error) {
      logger.warn(`Chunk ${r.chunk} (Client ${r.clientIndex}): Error - ${r.error}`);
    } else {
      logger.info(`Chunk ${r.chunk} (Client ${r.clientIndex}): ${r.eventsFound} events in blocks ${r.fromBlock}-${r.toBlock}`);
    }
  });
  
  logger.info('\nFinal Stats:', rpcManager.getStats());
}

async function main() {
  try {
    await fetchWithSingleClient();
    await fetchWithParallelClients();
    await fetchEventsInParallel();
    
    // Cleanup
    getRPCManager().destroy();
    
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main().catch(console.error);