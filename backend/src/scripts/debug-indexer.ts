#!/usr/bin/env node

import { createPublicClient, http, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('Debug-Indexer');

async function testDatabaseWrite() {
  logger.info('Testing database write capability...');
  
  const db = getDb();
  
  try {
    // Test inserting a dummy balance
    const testData = {
      address: '0xtest' + Date.now(),
      asset: 'xETH',
      chain_id: 1,
      shares: '1000000000000000000',
      last_update_block: 23217900,
    };
    
    logger.info('Attempting to insert test data:', testData);
    
    await db('current_balances')
      .insert(testData)
      .onConflict(['address', 'asset', 'chain_id'])
      .merge({
        shares: testData.shares,
        last_update_block: testData.last_update_block,
        updated_at: db.fn.now(),
      });
    
    logger.info('✅ Database write successful');
    
    // Read it back
    const result = await db('current_balances')
      .where({ address: testData.address })
      .first();
    
    logger.info('Read back from database:', result);
    
    // Clean up
    await db('current_balances')
      .where({ address: testData.address })
      .delete();
    
    logger.info('Test data cleaned up');
    
  } catch (error: any) {
    logger.error('❌ Database write failed:', {
      message: error?.message || 'Unknown error',
      code: error?.code,
      detail: error?.detail,
      stack: error?.stack,
      fullError: JSON.stringify(error)
    });
  }
}

async function testEthereumRPC() {
  logger.info('Testing Ethereum RPC connection...');
  
  try {
    const apiKey = config.rpc.apiKeys?.[0] || process.env.ALCHEMY_API_KEY_1;
    
    if (!apiKey) {
      logger.error('No Alchemy API key found!');
      return;
    }
    
    const client = createPublicClient({
      chain: mainnet,
      transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`),
    });
    
    const blockNumber = await client.getBlockNumber();
    logger.info(`✅ Ethereum RPC working. Current block: ${blockNumber}`);
    
    // Test fetching events for xETH
    const xETH = '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153';
    
    logger.info('Testing event fetch for xETH...');
    
    const fromBlock = blockNumber - 10n;
    const toBlock = blockNumber;
    
    try {
      const transfers = await client.getLogs({
        address: xETH as `0x${string}`,
        event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        fromBlock,
        toBlock,
      });
      
      logger.info(`✅ Event fetch successful. Found ${transfers.length} transfers in last 10 blocks`);
      
      if (transfers.length > 0) {
        logger.info('Sample transfer:', {
          from: transfers[0].args?.from,
          to: transfers[0].args?.to,
          value: transfers[0].args?.value?.toString(),
          blockNumber: transfers[0].blockNumber
        });
      }
      
    } catch (error: any) {
      logger.error('❌ Event fetch failed:', {
        message: error?.message || 'Unknown error',
        code: error?.code,
        cause: error?.cause,
        fullError: JSON.stringify(error)
      });
    }
    
  } catch (error: any) {
    logger.error('❌ Ethereum RPC connection failed:', {
      message: error?.message || 'Unknown error',
      code: error?.code,
      fullError: JSON.stringify(error)
    });
  }
}

async function testSonicRPC() {
  logger.info('Testing Sonic RPC connection...');
  
  try {
    const sonicRpcUrl = 'https://rpc.soniclabs.com';
    
    // Define Sonic chain manually
    const sonicChain = {
      id: 146,
      name: 'Sonic',
      network: 'sonic',
      nativeCurrency: {
        decimals: 18,
        name: 'Sonic',
        symbol: 'S',
      },
      rpcUrls: {
        default: { http: [sonicRpcUrl] },
        public: { http: [sonicRpcUrl] },
      },
    };
    
    const client = createPublicClient({
      chain: sonicChain as any,
      transport: http(sonicRpcUrl),
    });
    
    const blockNumber = await client.getBlockNumber();
    logger.info(`✅ Sonic RPC working. Current block: ${blockNumber}`);
    
  } catch (error: any) {
    logger.error('❌ Sonic RPC connection failed:', {
      message: error?.message || 'Unknown error',
      code: error?.code,
      fullError: JSON.stringify(error)
    });
  }
}

async function main() {
  logger.info('🔍 Starting indexer debugging...');
  logger.info('Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
    RAILWAY: !!process.env.RAILWAY_ENVIRONMENT,
  });
  
  // Test database connection
  await testDatabaseWrite();
  
  // Test Ethereum RPC
  await testEthereumRPC();
  
  // Test Sonic RPC
  await testSonicRPC();
  
  logger.info('✅ Debugging complete');
  process.exit(0);
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});