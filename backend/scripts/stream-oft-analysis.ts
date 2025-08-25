#!/usr/bin/env tsx
/**
 * Final analysis script for Stream Protocol OFT bridge events
 * Uses the existing RPC manager to search for bridge events
 */

import { createPublicClient, http, keccak256, toBytes, decodeEventLog } from 'viem';
import { mainnet } from 'viem/chains';

const CONTRACTS = {
  xETH: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
  xBTC: '0x12fd502e2052CaFB41eccC5B596023d9978057d6',
  xUSD: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94', 
  xEUR: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
};

// Use the working Alchemy endpoint
const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/UqwRvCeB71FIweoaOAIoH2FYqJ6iottq';

async function main() {
  console.log('🔍 STREAM PROTOCOL LAYERZERO OFT BRIDGE EVENT ANALYSIS');
  console.log('=' .repeat(60));
  
  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  // LayerZero OFT event signatures
  const eventTopics = {
    // Standard LayerZero OFT v2 events
    OFTSent: keccak256(toBytes('OFTSent(bytes32,uint32,address,uint256)')),
    OFTReceived: keccak256(toBytes('OFTReceived(bytes32,uint32,address,uint256)')),
    
    // Alternative event names that might be used
    SendToChain: keccak256(toBytes('SendToChain(uint16,address,bytes,uint256)')),
    ReceiveFromChain: keccak256(toBytes('ReceiveFromChain(uint16,bytes,uint256)')),
    
    // LayerZero v1 events
    Send: keccak256(toBytes('Send(uint16,bytes,uint64,bytes,bytes)')),
    Receive: keccak256(toBytes('Receive(uint16,bytes,uint64,bytes)')),
    
    // Transfer event for context
    Transfer: keccak256(toBytes('Transfer(address,address,uint256)')),
  };

  console.log('\n📋 Searching for these event signatures:');
  Object.entries(eventTopics).forEach(([name, topic]) => {
    console.log(`  ${name}: ${topic}`);
  });

  try {
    const latestBlock = await client.getBlockNumber();
    console.log(`\n📊 Current block: ${latestBlock}`);

    // Check each contract
    for (const [asset, contractAddress] of Object.entries(CONTRACTS)) {
      console.log(`\n🔍 Analyzing ${asset} contract: ${contractAddress}`);
      
      // Search recent blocks for any events
      const fromBlock = latestBlock - 2000n; // Last 2000 blocks
      
      try {
        console.log(`  📅 Searching blocks ${fromBlock} to ${latestBlock}...`);
        
        // Get all events from this contract
        const allLogs = await client.getLogs({
          address: contractAddress as `0x${string}`,
          fromBlock,
          toBlock: latestBlock,
        });
        
        console.log(`  📝 Found ${allLogs.length} total events in recent blocks`);
        
        if (allLogs.length > 0) {
          // Analyze event types
          const eventCounts = new Map<string, number>();
          
          for (const log of allLogs) {
            const topic = log.topics[0];
            eventCounts.set(topic, (eventCounts.get(topic) || 0) + 1);
          }
          
          console.log('  📊 Event breakdown:');
          for (const [topic, count] of eventCounts.entries()) {
            let eventName = 'Unknown';
            
            // Check against known events
            for (const [name, knownTopic] of Object.entries(eventTopics)) {
              if (topic === knownTopic) {
                eventName = name;
                break;
              }
            }
            
            console.log(`    ${eventName}: ${count} (${topic})`);
            
            // If this is a LayerZero OFT event, show details
            if (eventName.includes('OFT') || eventName.includes('Send') || eventName.includes('Receive')) {
              const matchingLogs = allLogs.filter(l => l.topics[0] === topic);
              if (matchingLogs.length > 0) {
                console.log(`    🎯 BRIDGE EVENT FOUND! First occurrence:`);
                const firstLog = matchingLogs[0];
                const block = await client.getBlock({ blockNumber: firstLog.blockNumber });
                console.log(`      Block: ${firstLog.blockNumber}`);
                console.log(`      Timestamp: ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
                console.log(`      Tx: ${firstLog.transactionHash}`);
              }
            }
          }
        }
        
        // Specifically search for bridge patterns from deployment
        console.log(`  🌉 Searching for bridge patterns from deployment...`);
        
        // Search in larger chunks from known deployment block
        const deploymentBlock = 21872213n;
        let searchFrom = deploymentBlock;
        const chunkSize = 50000n; // Larger chunks
        let bridgeEventsFound = false;
        
        while (searchFrom < latestBlock && !bridgeEventsFound && (latestBlock - searchFrom) > chunkSize) {
          const searchTo = Math.min(searchFrom + chunkSize, latestBlock);
          
          console.log(`    Scanning ${searchFrom} to ${searchTo}...`);
          
          try {
            // Search for any potential bridge events
            const bridgeLogs = await client.getLogs({
              address: contractAddress as `0x${string}`,
              fromBlock: searchFrom,
              toBlock: searchTo,
              topics: [
                Object.values(eventTopics).filter(t => t !== eventTopics.Transfer)
              ]
            });
            
            if (bridgeLogs.length > 0) {
              console.log(`    ✅ Found ${bridgeLogs.length} potential bridge events!`);
              
              for (const log of bridgeLogs.slice(0, 3)) {
                const block = await client.getBlock({ blockNumber: log.blockNumber });
                console.log(`      Block ${log.blockNumber} (${new Date(Number(block.timestamp) * 1000).toISOString()}): ${log.transactionHash}`);
              }
              
              bridgeEventsFound = true;
              
              // This would be the first bridge transaction
              const firstBridge = bridgeLogs[0];
              const firstBlock = await client.getBlock({ blockNumber: firstBridge.blockNumber });
              console.log(`\n    🎯 FIRST BRIDGE TRANSACTION FOR ${asset}:`);
              console.log(`      Transaction: ${firstBridge.transactionHash}`);
              console.log(`      Block: ${firstBridge.blockNumber}`);
              console.log(`      Date: ${new Date(Number(firstBlock.timestamp) * 1000).toISOString()}`);
            }
            
            searchFrom = searchTo + 1n;
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
            
          } catch (chunkError) {
            console.log(`    ⚠️ Error in chunk: ${chunkError}`);
            searchFrom = searchTo + 1n;
          }
        }
        
        if (!bridgeEventsFound) {
          console.log(`  ❌ No bridge events found for ${asset}`);
        }
        
      } catch (contractError) {
        console.log(`  ❌ Error analyzing ${asset}:`, contractError);
      }
    }
    
    console.log('\n📝 CONCLUSION:');
    console.log('==============');
    console.log('Event signatures to look for in Stream Protocol contracts:');
    console.log(`1. OFTSent: ${eventTopics.OFTSent}`);
    console.log(`2. OFTReceived: ${eventTopics.OFTReceived}`);
    console.log(`3. SendToChain: ${eventTopics.SendToChain}`);
    console.log(`4. ReceiveFromChain: ${eventTopics.ReceiveFromChain}`);
    console.log('\nIf no LayerZero OFT events are found, the contracts may:');
    console.log('- Not be LayerZero OFT implementations');
    console.log('- Use custom bridge events with different signatures');
    console.log('- Not have had any cross-chain transactions yet');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

main().catch(console.error);