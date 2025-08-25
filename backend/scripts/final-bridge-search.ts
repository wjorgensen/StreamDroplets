#!/usr/bin/env tsx
/**
 * Final comprehensive search for LayerZero OFT bridge events
 * Respects Alchemy's 500 block limit and searches systematically
 */

import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';

const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/UqwRvCeB71FIweoaOAIoH2FYqJ6iottq';

// Stream Protocol contracts
const CONTRACTS = {
  xETH: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
  xBTC: '0x12fd502e2052CaFB41eccC5B596023d9978057d6',
  xUSD: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
  xEUR: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
};

// LayerZero OFT event topic hashes (calculated from signatures)
const BRIDGE_EVENT_TOPICS = {
  OFTSent: '0xfff873bb909b73d08a8c1af4b21779e87103bb8ea8cf3b3a0067eb8526b8b80a',
  OFTReceived: '0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c',
  SendToChain: '0x39a4c66499bcf4b56d79f0dde8ed7a9d4925a0df55825206b2b8531e202be0d0',
  ReceiveFromChain: '0x6a32ad4efd124722e0476b60002979c9a685a2c272e5e7b02cc9921f0a937c96',
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function main() {
  console.log('🔍 FINAL LAYERZERO OFT BRIDGE EVENT SEARCH');
  console.log('==========================================');
  
  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  console.log('\n📋 LayerZero OFT Event Signatures:');
  console.log('OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)');
  console.log('OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)');
  
  console.log('\n🎯 Searching for these event topic hashes:');
  Object.entries(BRIDGE_EVENT_TOPICS).forEach(([name, topic]) => {
    console.log(`  ${name}: ${topic}`);
  });

  try {
    const latestBlock = await client.getBlockNumber();
    console.log(`\n📊 Current Ethereum block: ${latestBlock}`);
    
    let bridgeEventsFound = 0;
    let firstBridgeEvent = null;
    
    // Search each contract
    for (const [asset, contractAddress] of Object.entries(CONTRACTS)) {
      console.log(`\n🔍 Searching ${asset} contract: ${contractAddress}`);
      console.log('-'.repeat(60));
      
      try {
        // First, search recent blocks (last 500) for any activity
        const fromBlock = latestBlock - 500n;
        
        console.log(`📅 Scanning recent blocks ${fromBlock} to ${latestBlock}...`);
        
        // Get all recent events to understand contract activity
        const recentLogs = await client.getLogs({
          address: contractAddress as `0x${string}`,
          fromBlock: fromBlock,
          toBlock: latestBlock,
        });
        
        console.log(`📝 Found ${recentLogs.length} total events in recent blocks`);
        
        if (recentLogs.length > 0) {
          // Group events by topic
          const eventCounts = new Map<string, number>();
          
          for (const log of recentLogs) {
            const topic = log.topics[0];
            eventCounts.set(topic, (eventCounts.get(topic) || 0) + 1);
          }
          
          console.log('📊 Recent event types:');
          for (const [topic, count] of eventCounts.entries()) {
            let eventName = 'Unknown';
            
            if (topic === TRANSFER_TOPIC) {
              eventName = 'Transfer';
            } else {
              // Check if it's a bridge event
              for (const [name, bridgeTopic] of Object.entries(BRIDGE_EVENT_TOPICS)) {
                if (topic === bridgeTopic) {
                  eventName = `🌉 ${name} (BRIDGE EVENT!)`;
                  bridgeEventsFound += count;
                  
                  // Find the first occurrence
                  const bridgeLogs = recentLogs.filter(l => l.topics[0] === topic);
                  if (bridgeLogs.length > 0) {
                    const firstLog = bridgeLogs[0];
                    if (!firstBridgeEvent || firstLog.blockNumber < firstBridgeEvent.blockNumber) {
                      firstBridgeEvent = {
                        asset,
                        eventName: name,
                        txHash: firstLog.transactionHash,
                        blockNumber: firstLog.blockNumber,
                        contractAddress,
                      };
                    }
                  }
                  break;
                }
              }
            }
            
            console.log(`  ${eventName}: ${count} events (${topic})`);
          }
        }
        
        // Search for bridge events specifically from deployment block
        console.log('\n🌉 Searching for bridge events from deployment...');
        
        const deploymentBlock = 21872213n; // Known xETH deployment
        const chunkSize = 500n; // Max allowed by Alchemy
        let searchFrom = deploymentBlock;
        
        // Search in chunks, focusing on finding ANY bridge event
        while (searchFrom < latestBlock && bridgeEventsFound === 0) {
          const searchTo = searchFrom + chunkSize > latestBlock ? latestBlock : searchFrom + chunkSize;
          
          console.log(`  🔍 Blocks ${searchFrom} to ${searchTo}...`);
          
          try {
            // Search for any of the LayerZero OFT events
            const bridgeLogs = await client.getLogs({
              address: contractAddress as `0x${string}`,
              fromBlock: searchFrom,
              toBlock: searchTo,
              topics: [Object.values(BRIDGE_EVENT_TOPICS)]
            });
            
            if (bridgeLogs.length > 0) {
              console.log(`✅ FOUND ${bridgeLogs.length} BRIDGE EVENTS!`);
              
              for (const log of bridgeLogs) {
                const block = await client.getBlock({ blockNumber: log.blockNumber });
                const eventName = Object.entries(BRIDGE_EVENT_TOPICS).find(([_, topic]) => topic === log.topics[0])?.[0] || 'Unknown';
                
                console.log(`    ${eventName} in tx ${log.transactionHash}`);
                console.log(`    Block ${log.blockNumber} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
                
                bridgeEventsFound++;
                
                if (!firstBridgeEvent || log.blockNumber < firstBridgeEvent.blockNumber) {
                  firstBridgeEvent = {
                    asset,
                    eventName,
                    txHash: log.transactionHash,
                    blockNumber: log.blockNumber,
                    contractAddress,
                    timestamp: new Date(Number(block.timestamp) * 1000),
                  };
                }
              }
              
              break; // Found events for this contract
            }
            
            searchFrom = searchTo + 1n;
            
            // Progress indicator and rate limiting
            if (Number(searchTo - deploymentBlock) % 50000 === 0) {
              const progress = ((Number(searchTo - deploymentBlock)) / Number(latestBlock - deploymentBlock) * 100).toFixed(1);
              console.log(`    Progress: ${progress}% (${searchTo - deploymentBlock} blocks searched)`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
          } catch (chunkError: any) {
            console.log(`    ⚠️ Error in chunk ${searchFrom}-${searchTo}:`, chunkError.shortMessage || chunkError.message);
            searchFrom = searchTo + 1n;
          }
        }
        
        if (bridgeEventsFound === 0) {
          console.log(`❌ No bridge events found for ${asset}`);
        }
        
      } catch (contractError: any) {
        console.log(`❌ Error searching ${asset}:`, contractError.shortMessage || contractError.message);
      }
    }
    
    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('🎯 FINAL RESULTS SUMMARY');
    console.log('='.repeat(60));
    
    if (bridgeEventsFound > 0) {
      console.log(`✅ Found ${bridgeEventsFound} total bridge events across all contracts`);
      
      if (firstBridgeEvent) {
        console.log('\n🏆 FIRST BRIDGE TRANSACTION:');
        console.log(`  Asset: ${firstBridgeEvent.asset}`);
        console.log(`  Event: ${firstBridgeEvent.eventName}`);
        console.log(`  Transaction: ${firstBridgeEvent.txHash}`);
        console.log(`  Block: ${firstBridgeEvent.blockNumber}`);
        console.log(`  Contract: ${firstBridgeEvent.contractAddress}`);
        if (firstBridgeEvent.timestamp) {
          console.log(`  Date: ${firstBridgeEvent.timestamp.toISOString()}`);
        }
      }
      
    } else {
      console.log('❌ NO LAYERZERO OFT BRIDGE EVENTS FOUND');
      console.log('\nThis indicates that:');
      console.log('1. Stream Protocol contracts may not use LayerZero OFT standard');
      console.log('2. No bridge transactions have occurred yet');
      console.log('3. The contracts use different event signatures than standard OFT');
      console.log('4. Bridge functionality may not be deployed/activated yet');
    }
    
    console.log('\n📝 VERIFIED EVENT SIGNATURES TO MONITOR:');
    console.log('For LayerZero OFT v2 standard:');
    console.log(`OFTSent: ${BRIDGE_EVENT_TOPICS.OFTSent}`);
    console.log(`OFTReceived: ${BRIDGE_EVENT_TOPICS.OFTReceived}`);
    
  } catch (error: any) {
    console.error('❌ Search failed:', error.shortMessage || error.message);
  }
}

main().catch(console.error);