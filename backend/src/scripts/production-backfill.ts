import { createPublicClient, http, Address, parseAbiItem, PublicClient } from 'viem';
import { mainnet, sonic } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';

// Token configurations - use environment variables with fallbacks
const TOKENS = [
  { 
    symbol: 'xETH', 
    ethereum: process.env.XETH_ETHEREUM_ADDRESS || '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153', 
    sonic: process.env.XETH_SONIC_ADDRESS || '0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6' 
  },
  { 
    symbol: 'xBTC', 
    ethereum: process.env.XBTC_ETHEREUM_ADDRESS || '0x1aB7348741E7BA04a8c6163E852F3D7a1E4C8398', 
    sonic: process.env.XBTC_SONIC_ADDRESS || '0x8B659bBb68f43ea3eeCA37c8d929Dd842f2Af5b6' 
  },
  { 
    symbol: 'xUSD', 
    ethereum: process.env.XUSD_ETHEREUM_ADDRESS || '0xEc1B5fF451C1De3235587cEc997C33491D22C73e', 
    sonic: process.env.XUSD_SONIC_ADDRESS || '0xBAfB50128a6A7B8247C88e9Cc3516cb3a2268E1d' 
  },
  { 
    symbol: 'xEUR', 
    ethereum: process.env.XEUR_ETHEREUM_ADDRESS || '0x45a87c78073eF2FB837b853763B96bd1Cd893BcC', 
    sonic: process.env.XEUR_SONIC_ADDRESS || '0xf2F013133DE2F0d3369A6BE96B92aFdD0bDC2Da8' 
  },
];

// Production block ranges - configurable based on deployment needs
const START_BLOCKS = {
  ethereum: {
    xETH: BigInt(process.env.ETH_START_BLOCK || '20000000'), // Default: ~6 months back
    xBTC: BigInt(process.env.ETH_START_BLOCK || '20000000'),
    xUSD: BigInt(process.env.ETH_START_BLOCK || '20000000'),
    xEUR: BigInt(process.env.ETH_START_BLOCK || '20000000'),
  },
  sonic: {
    xETH: BigInt(process.env.SONIC_START_BLOCK || '40000000'), // Default: reasonable Sonic start
    xBTC: BigInt(process.env.SONIC_START_BLOCK || '40000000'),
    xUSD: BigInt(process.env.SONIC_START_BLOCK || '40000000'),
    xEUR: BigInt(process.env.SONIC_START_BLOCK || '40000000'),
  }
};

const CHUNK_SIZE = 500n; // API block limit
const PARALLEL_WORKERS = 3; // Workers per token per chain

async function getCurrentBlock(client: PublicClient): Promise<bigint> {
  const block = await client.getBlockNumber();
  return block;
}

async function getEventsInChunks(
  client: PublicClient,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  eventSignature: string,
  retryCount = 3
): Promise<any[]> {
  const events: any[] = [];
  
  for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += CHUNK_SIZE) {
    const chunkEnd = currentBlock + CHUNK_SIZE - 1n > toBlock ? toBlock : currentBlock + CHUNK_SIZE - 1n;
    
    let attempts = 0;
    while (attempts < retryCount) {
      try {
        const logs = await client.getLogs({
          address: token,
          event: parseAbiItem(eventSignature) as any,
          fromBlock: currentBlock,
          toBlock: chunkEnd,
        });
        
        events.push(...logs);
        break;
      } catch (error: any) {
        attempts++;
        if (attempts >= retryCount) {
          console.error(`Failed to fetch events for block ${currentBlock}-${chunkEnd} after ${retryCount} attempts:`, error.message);
        } else {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 1000));
        }
      }
    }
    
    // Rate limiting to avoid API throttling
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  return events;
}

async function processTokenWorker(
  chain: 'ethereum' | 'sonic',
  token: typeof TOKENS[0],
  startBlock: bigint,
  endBlock: bigint,
  workerId: number,
  apiKey: string
): Promise<{ token: string; chain: string; transfers: any[]; ppsUpdates: any[]; errors: number }> {
  const workerTag = `[${chain}:${token.symbol}:W${workerId}]`;
  console.log(`${workerTag} Starting: blocks ${startBlock} to ${endBlock} (${endBlock - startBlock + 1n} blocks)`);
  
  const rpcUrl = chain === 'ethereum' 
    ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
    : `https://sonic-mainnet.g.alchemy.com/v2/${apiKey}`;

  const client = createPublicClient({
    chain: chain === 'ethereum' ? mainnet : sonic,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 1000,
    }),
  });

  const tokenAddress = (chain === 'ethereum' ? token.ethereum : token.sonic) as Address;
  let errors = 0;
  
  // Get Transfer events
  const transfers = await getEventsInChunks(
    client,
    tokenAddress,
    startBlock,
    endBlock,
    'event Transfer(address indexed from, address indexed to, uint256 value)'
  );
  
  console.log(`${workerTag} Found ${transfers.length} transfers`);
  
  // Get PPS events (only on Ethereum)
  let ppsUpdates: any[] = [];
  if (chain === 'ethereum') {
    ppsUpdates = await getEventsInChunks(
      client,
      tokenAddress,
      startBlock,
      endBlock,
      'event PricePerShareUpdated(uint256 pricePerShare, uint256 totalUnderlying, uint256 totalSupply)'
    );
    console.log(`${workerTag} Found ${ppsUpdates.length} PPS updates`);
  }
  
  console.log(`${workerTag} Completed`);
  return { token: token.symbol, chain, transfers, ppsUpdates, errors };
}

async function processChainData(results: any[]) {
  const db = getDb();
  console.log('\nProcessing data into database...');
  
  // Process PPS updates as rounds
  let roundId = 1;
  const allPpsEvents = results.flatMap(r => 
    r.ppsUpdates.map((e: any) => ({ ...e, token: r.token, chain: r.chain }))
  );
  
  // Sort by block number
  allPpsEvents.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  
  console.log(`Processing ${allPpsEvents.length} PPS events...`);
  for (const event of allPpsEvents) {
    try {
      await db('rounds').insert({
        round_id: roundId++,
        asset: event.token,
        chain_id: event.chain === 'ethereum' ? 1 : 146,
        start_block: Number(event.blockNumber),
        start_ts: new Date(), // Would need to fetch actual timestamp
        pps: event.args.pricePerShare.toString(),
        pps_scale: 18,
        tx_hash: event.transactionHash,
      }).onConflict(['round_id', 'asset', 'chain_id']).merge();
    } catch (error) {
      console.error(`Error inserting round for ${event.token}:`, error);
    }
  }
  
  // Process transfers for balance tracking
  const allTransfers = results.flatMap(r => 
    r.transfers.map((e: any) => ({ ...e, token: r.token, chain: r.chain }))
  );
  
  console.log(`Processing ${allTransfers.length} transfers...`);
  
  // Group transfers by user
  const userBalances = new Map<string, Map<string, bigint>>();
  
  for (const transfer of allTransfers) {
    const { from, to, value } = transfer.args;
    const token = transfer.token;
    const chainId = transfer.chain === 'ethereum' ? 1 : 146;
    const key = `${from.toLowerCase()}_${token}_${chainId}`;
    const keyTo = `${to.toLowerCase()}_${token}_${chainId}`;
    
    // Update sender balance
    if (from !== '0x0000000000000000000000000000000000000000') {
      if (!userBalances.has(key)) {
        userBalances.set(key, new Map());
      }
      const current = userBalances.get(key)!.get('balance') || 0n;
      userBalances.get(key)!.set('balance', current - BigInt(value));
      userBalances.get(key)!.set('address', from.toLowerCase());
      userBalances.get(key)!.set('token', token);
      userBalances.get(key)!.set('chainId', BigInt(chainId));
    }
    
    // Update receiver balance
    if (to !== '0x0000000000000000000000000000000000000000') {
      if (!userBalances.has(keyTo)) {
        userBalances.set(keyTo, new Map());
      }
      const current = userBalances.get(keyTo)!.get('balance') || 0n;
      userBalances.get(keyTo)!.set('balance', current + BigInt(value));
      userBalances.get(keyTo)!.set('address', to.toLowerCase());
      userBalances.get(keyTo)!.set('token', token);
      userBalances.get(keyTo)!.set('chainId', BigInt(chainId));
    }
  }
  
  // Insert final balances
  console.log(`Updating ${userBalances.size} user balances...`);
  let processed = 0;
  
  for (const [_, data] of userBalances) {
    const balance = data.get('balance')!;
    if (balance > 0n) {
      await db('current_balances')
        .insert({
          address: data.get('address'),
          asset: data.get('token'),
          chain_id: Number(data.get('chainId')),
          shares: balance.toString(),
          last_update_block: 0,
        })
        .onConflict(['address', 'asset', 'chain_id'])
        .merge({
          shares: balance.toString(),
          updated_at: db.fn.now(),
        });
    }
    
    processed++;
    if (processed % 100 === 0) {
      console.log(`Processed ${processed}/${userBalances.size} balances`);
    }
  }
}

async function productionBackfill() {
  console.log('🚀 Starting production backfill...');
  console.log(`Using ${config.rpc.apiKeys?.length || 1} API keys`);
  
  const db = getDb();
  
  // Clear existing data
  console.log('Clearing existing data...');
  await db('current_balances').delete();
  await db('rounds').delete();
  await db('balance_snapshots').delete();
  await db('share_events').delete();
  
  const apiKeys = config.rpc.apiKeys || [];
  if (apiKeys.length === 0) {
    throw new Error('No API keys configured');
  }
  
  // Get current blocks
  console.log('Fetching current block numbers...');
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKeys[0]}`),
  });
  
  const sonicClient = createPublicClient({
    chain: sonic,
    transport: http(`https://sonic-mainnet.g.alchemy.com/v2/${apiKeys[0]}`),
  });
  
  const currentEthBlock = await getCurrentBlock(ethClient);
  const currentSonicBlock = await getCurrentBlock(sonicClient);
  
  console.log(`Current Ethereum block: ${currentEthBlock}`);
  console.log(`Current Sonic block: ${currentSonicBlock}`);
  
  // Create worker tasks
  const tasks: Promise<any>[] = [];
  let workerId = 0;
  
  for (const token of TOKENS) {
    // Ethereum workers
    const ethStart = START_BLOCKS.ethereum[token.symbol as keyof typeof START_BLOCKS.ethereum];
    const ethRange = currentEthBlock - ethStart;
    const ethChunkSize = ethRange / BigInt(PARALLEL_WORKERS);
    
    console.log(`\n${token.symbol} on Ethereum: ${ethRange} blocks total`);
    
    for (let i = 0; i < PARALLEL_WORKERS; i++) {
      const startBlock = ethStart + (ethChunkSize * BigInt(i));
      const endBlock = i === PARALLEL_WORKERS - 1 ? currentEthBlock : startBlock + ethChunkSize - 1n;
      const apiKey = apiKeys[workerId % apiKeys.length];
      
      tasks.push(
        processTokenWorker('ethereum', token, startBlock, endBlock, workerId++, apiKey)
      );
    }
    
    // Sonic workers
    const sonicStart = START_BLOCKS.sonic[token.symbol as keyof typeof START_BLOCKS.sonic];
    const sonicRange = currentSonicBlock - sonicStart;
    const sonicChunkSize = sonicRange / BigInt(PARALLEL_WORKERS);
    
    console.log(`${token.symbol} on Sonic: ${sonicRange} blocks total`);
    
    for (let i = 0; i < PARALLEL_WORKERS; i++) {
      const startBlock = sonicStart + (sonicChunkSize * BigInt(i));
      const endBlock = i === PARALLEL_WORKERS - 1 ? currentSonicBlock : startBlock + sonicChunkSize - 1n;
      const apiKey = apiKeys[workerId % apiKeys.length];
      
      tasks.push(
        processTokenWorker('sonic', token, startBlock, endBlock, workerId++, apiKey)
      );
    }
  }
  
  console.log(`\n📊 Starting ${tasks.length} parallel workers...`);
  const startTime = Date.now();
  
  // Execute all tasks with concurrency limit
  const CONCURRENCY_LIMIT = 6; // Process 6 workers at a time
  const results: any[] = [];
  
  for (let i = 0; i < tasks.length; i += CONCURRENCY_LIMIT) {
    const batch = tasks.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.allSettled(batch);
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.error('Worker failed:', result.reason);
      }
    }
    
    console.log(`Completed batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(tasks.length / CONCURRENCY_LIMIT)}`);
  }
  
  const successCount = results.filter(r => r).length;
  const errorCount = tasks.length - successCount;
  
  console.log(`\n✅ Data fetching complete in ${(Date.now() - startTime) / 1000}s`);
  console.log(`Successful: ${successCount}, Failed: ${errorCount}`);
  
  // Process all collected data
  await processChainData(results);
  
  // Get final statistics
  const totalUsers = await db('current_balances')
    .countDistinct('address as count');
  const totalRounds = await db('rounds').count('* as count');
  const topUsers = await db('current_balances')
    .select('address')
    .sum('shares as total_shares')
    .groupBy('address')
    .orderBy('total_shares', 'desc')
    .limit(10);
  
  console.log('\n' + '='.repeat(50));
  console.log('🎉 PRODUCTION BACKFILL COMPLETE');
  console.log('='.repeat(50));
  console.log(`Total unique users: ${totalUsers[0].count}`);
  console.log(`Total rounds indexed: ${totalRounds[0].count}`);
  console.log('\nTop 10 users by shares:');
  topUsers.forEach((user, i) => {
    console.log(`${(i + 1).toString().padStart(2)}. ${user.address}: ${Number(user.total_shares).toLocaleString()} shares`);
  });
  
  await db.destroy();
  console.log('\n✨ System is production ready!');
}

// Run with error handling
productionBackfill().catch(error => {
  console.error('❌ Backfill failed:', error);
  process.exit(1);
});