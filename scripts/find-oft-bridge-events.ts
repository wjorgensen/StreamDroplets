#!/usr/bin/env tsx
/**
 * Script to find LayerZero OFT bridge events in Stream Protocol contracts
 * This script searches for OFTSent and OFTReceived events to identify bridge transactions
 */

import { createPublicClient, http, parseAbi, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';
import { createLogger } from '../src/utils/logger';
import { getRPCManager } from '../src/utils/rpcManager';

const logger = createLogger('OFTBridgeEventFinder');

// Stream Protocol contract addresses
const STREAM_CONTRACTS = {
  xETH: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
  xBTC: '0x12fd502e2052CaFB41eccC5B596023d9978057d6', 
  xUSD: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
  xEUR: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
};

// Known deployment blocks (xETH is confirmed, others estimated)
const DEPLOYMENT_BLOCKS = {
  xETH: 21872213n,
  xBTC: 21872213n, // Estimated - adjust if needed
  xUSD: 21872213n, // Estimated - adjust if needed
  xEUR: 21872213n, // Estimated - adjust if needed
};

// Calculate LayerZero OFT event topic hashes
const OFT_EVENT_TOPICS = {
  // OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)
  OFTSent: keccak256(toBytes('OFTSent(bytes32,uint32,address,uint256)')),
  // OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)  
  OFTReceived: keccak256(toBytes('OFTReceived(bytes32,uint32,address,uint256)')),
  // Alternative naming conventions that might be used
  SendToChain: keccak256(toBytes('SendToChain(uint16,address,bytes,uint256)')),
  ReceiveFromChain: keccak256(toBytes('ReceiveFromChain(uint16,bytes,uint256)')),
};

const OFT_ABI = parseAbi([
  'event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)',
  'event OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)',
  'event SendToChain(uint16 indexed _dstChainId, address indexed _from, bytes _toAddress, uint256 _amount)',
  'event ReceiveFromChain(uint16 indexed _srcChainId, bytes _fromAddress, uint256 _amount)',
]);

interface BridgeEvent {
  eventName: string;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  contract: string;
  asset: string;
  args: any;
  logIndex: number;
}

async function findBridgeEvents(): Promise<void> {
  const rpcManager = getRPCManager();
  const client = rpcManager.createClient('ethereum');
  
  logger.info('Starting search for LayerZero OFT bridge events...');
  logger.info('Event topic hashes:');
  Object.entries(OFT_EVENT_TOPICS).forEach(([name, topic]) => {
    logger.info(`  ${name}: ${topic}`);
  });

  const allBridgeEvents: BridgeEvent[] = [];
  
  for (const [asset, contractAddress] of Object.entries(STREAM_CONTRACTS)) {
    logger.info(`\n🔍 Searching ${asset} contract: ${contractAddress}`);
    
    try {
      const deploymentBlock = DEPLOYMENT_BLOCKS[asset as keyof typeof DEPLOYMENT_BLOCKS];
      const latestBlock = await client.getBlockNumber();
      
      logger.info(`  Block range: ${deploymentBlock} to ${latestBlock} (${latestBlock - deploymentBlock + 1n} blocks)`);
      
      // Search for all OFT-related events
      const chunkSize = 2000n; // Smaller chunks to avoid RPC limits
      let currentBlock = deploymentBlock;
      
      while (currentBlock <= latestBlock) {
        const toBlock = currentBlock + chunkSize - 1n > latestBlock ? latestBlock : currentBlock + chunkSize - 1n;
        
        logger.info(`    Scanning blocks ${currentBlock} to ${toBlock}...`);
        
        // Get all logs for this contract in the block range
        const logs = await client.getLogs({
          address: contractAddress as `0x${string}`,
          fromBlock: currentBlock,
          toBlock: toBlock,
          topics: [
            // Search for any of the OFT event topics
            Object.values(OFT_EVENT_TOPICS)
          ]
        });
        
        logger.info(`    Found ${logs.length} potential bridge events`);
        
        // Process each log to decode the event
        for (const log of logs) {
          try {
            const block = await client.getBlock({ blockNumber: log.blockNumber });
            
            // Try to decode with each possible event ABI
            let decodedEvent = null;
            let eventName = '';
            
            // Check which event topic matches
            for (const [name, topic] of Object.entries(OFT_EVENT_TOPICS)) {
              if (log.topics[0] === topic) {
                eventName = name;
                try {
                  // Find matching ABI
                  const eventAbi = OFT_ABI.find(item => item.type === 'event' && item.name === name);
                  if (eventAbi) {
                    // Manual decoding since viem's decodeEventLog might not work with all formats
                    decodedEvent = {
                      topics: log.topics,
                      data: log.data,
                    };
                  }
                } catch (decodeError) {
                  logger.warn(`    Could not decode ${name} event: ${decodeError}`);
                }
                break;
              }
            }
            
            if (eventName && decodedEvent) {
              const bridgeEvent: BridgeEvent = {
                eventName,
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
                timestamp: new Date(Number(block.timestamp) * 1000),
                contract: contractAddress,
                asset,
                args: decodedEvent,
                logIndex: log.logIndex,
              };
              
              allBridgeEvents.push(bridgeEvent);
              logger.info(`    ✅ Found ${eventName} in tx ${log.transactionHash} at block ${log.blockNumber}`);
            }
          } catch (error) {
            logger.warn(`    Error processing log: ${error}`);
          }
        }
        
        currentBlock = toBlock + 1n;
        
        // Add small delay to avoid rate limiting
        if (currentBlock <= latestBlock) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
    } catch (error) {
      logger.error(`Error searching ${asset} contract:`, error);
    }
  }
  
  // Sort events by timestamp to find the earliest
  allBridgeEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  
  // Print summary
  logger.info('\n📊 BRIDGE EVENTS SUMMARY');
  logger.info('================================');
  
  if (allBridgeEvents.length === 0) {
    logger.info('❌ No LayerZero OFT bridge events found in any contract.');
    logger.info('\nPossible reasons:');
    logger.info('- Contracts might not have bridge functionality enabled yet');
    logger.info('- Events might use different signatures than expected');
    logger.info('- Bridge transactions might not have occurred yet');
    logger.info('\nNext steps:');
    logger.info('1. Check if contracts are actually LayerZero OFT implementations');
    logger.info('2. Verify the correct event signatures by checking contract code');
    logger.info('3. Look for alternative bridge event names');
  } else {
    logger.info(`✅ Found ${allBridgeEvents.length} bridge events total`);
    
    // Group by asset
    const eventsByAsset = allBridgeEvents.reduce((acc, event) => {
      if (!acc[event.asset]) acc[event.asset] = [];
      acc[event.asset].push(event);
      return acc;
    }, {} as Record<string, BridgeEvent[]>);
    
    Object.entries(eventsByAsset).forEach(([asset, events]) => {
      logger.info(`\n${asset}: ${events.length} events`);
      events.forEach(event => {
        logger.info(`  ${event.eventName} - ${event.timestamp.toISOString()} - Tx: ${event.txHash}`);
      });
    });
    
    // Show the first bridge transaction
    if (allBridgeEvents.length > 0) {
      const firstEvent = allBridgeEvents[0];
      logger.info('\n🎯 FIRST BRIDGE TRANSACTION');
      logger.info('============================');
      logger.info(`Asset: ${firstEvent.asset}`);
      logger.info(`Event: ${firstEvent.eventName}`);
      logger.info(`Transaction: ${firstEvent.txHash}`);
      logger.info(`Block: ${firstEvent.blockNumber}`);
      logger.info(`Timestamp: ${firstEvent.timestamp.toISOString()}`);
      logger.info(`Contract: ${firstEvent.contract}`);
    }
  }
  
  // Also search for raw Transfer events that might be bridge-related
  logger.info('\n🔍 Searching for Transfer events that might be bridge burns/mints...');
  await findPotentialBridgeTransfers();
}

async function findPotentialBridgeTransfers(): Promise<void> {
  const rpcManager = getRPCManager();
  const client = rpcManager.createClient('ethereum');
  
  const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  
  for (const [asset, contractAddress] of Object.entries(STREAM_CONTRACTS)) {
    logger.info(`\nChecking ${asset} for burn/mint transfers...`);
    
    try {
      const deploymentBlock = DEPLOYMENT_BLOCKS[asset as keyof typeof DEPLOYMENT_BLOCKS];
      const latestBlock = await client.getBlockNumber();
      
      // Look for burns (transfers to zero address)
      const burnLogs = await client.getLogs({
        address: contractAddress as `0x${string}`,
        fromBlock: deploymentBlock,
        toBlock: latestBlock,
        topics: [
          transferTopic,
          null, // from (any address)
          '0x' + zeroAddress.slice(2).padStart(64, '0') // to zero address
        ]
      });
      
      // Look for mints (transfers from zero address)  
      const mintLogs = await client.getLogs({
        address: contractAddress as `0x${string}`,
        fromBlock: deploymentBlock,
        toBlock: latestBlock,
        topics: [
          transferTopic,
          '0x' + zeroAddress.slice(2).padStart(64, '0'), // from zero address
          null // to (any address)
        ]
      });
      
      logger.info(`  Burns: ${burnLogs.length}, Mints: ${mintLogs.length}`);
      
      // Show first few of each type
      if (burnLogs.length > 0) {
        logger.info('  First 3 burns:');
        for (let i = 0; i < Math.min(3, burnLogs.length); i++) {
          const log = burnLogs[i];
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          logger.info(`    ${log.transactionHash} at ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
        }
      }
      
      if (mintLogs.length > 0) {
        logger.info('  First 3 mints:');
        for (let i = 0; i < Math.min(3, mintLogs.length); i++) {
          const log = mintLogs[i];
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          logger.info(`    ${log.transactionHash} at ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
        }
      }
      
    } catch (error) {
      logger.error(`Error searching transfers for ${asset}:`, error);
    }
  }
}

async function main(): Promise<void> {
  try {
    await findBridgeEvents();
    
    logger.info('\n✅ Bridge event search completed');
    
    // Cleanup
    getRPCManager().destroy();
    
  } catch (error) {
    logger.error('Error in main:', error);
    process.exit(1);
  }
}

main().catch(console.error);