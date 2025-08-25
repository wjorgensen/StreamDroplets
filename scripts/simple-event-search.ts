#!/usr/bin/env tsx
/**
 * Simple script to search for events in Stream Protocol contracts
 * Uses public RPC to avoid rate limiting issues
 */

import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';

const XETH_CONTRACT = '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153';
const DEPLOYMENT_BLOCK = 21872213n;

async function searchEvents() {
  console.log('🔍 Searching for LayerZero OFT events in Stream Protocol contracts');
  
  // Use public Ethereum RPC
  const client = createPublicClient({
    chain: mainnet,
    transport: http('https://rpc.ankr.com/eth'), // Free public RPC
  });

  try {
    console.log('\n📋 LayerZero OFT Event Signatures:');
    
    // Calculate standard LayerZero OFT event hashes
    const oftSentTopic = keccak256(toBytes('OFTSent(bytes32,uint32,address,uint256)'));
    const oftReceivedTopic = keccak256(toBytes('OFTReceived(bytes32,uint32,address,uint256)'));
    const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
    
    console.log(`OFTSent: ${oftSentTopic}`);
    console.log(`OFTReceived: ${oftReceivedTopic}`);
    console.log(`Transfer: ${transferTopic}`);
    
    console.log(`\n🔍 Searching xETH contract: ${XETH_CONTRACT}`);
    console.log(`Starting from deployment block: ${DEPLOYMENT_BLOCK}`);
    
    // Check recent blocks first (last 1000 blocks)
    const latestBlock = await client.getBlockNumber();
    const recentFromBlock = latestBlock - 1000n;
    
    console.log(`\n📊 Searching recent blocks (${recentFromBlock} to ${latestBlock})...`);
    
    // Search for all events in recent blocks
    const recentLogs = await client.getLogs({
      address: XETH_CONTRACT as `0x${string}`,
      fromBlock: recentFromBlock,
      toBlock: latestBlock,
    });
    
    console.log(`Found ${recentLogs.length} recent events`);
    
    // Group by event type
    const eventCounts = new Map<string, number>();
    
    for (const log of recentLogs) {
      const topic = log.topics[0];
      eventCounts.set(topic, (eventCounts.get(topic) || 0) + 1);
    }
    
    console.log('\n📈 Recent Event Summary:');
    for (const [topic, count] of eventCounts.entries()) {
      let eventName = 'Unknown';
      if (topic === transferTopic) eventName = 'Transfer';
      if (topic === oftSentTopic) eventName = 'OFTSent';
      if (topic === oftReceivedTopic) eventName = 'OFTReceived';
      
      console.log(`  ${eventName}: ${count} events (${topic})`);
    }
    
    // Search for LayerZero OFT events specifically
    console.log('\n🌉 Searching for LayerZero OFT events...');
    
    // Search in chunks from deployment
    let searchFromBlock = DEPLOYMENT_BLOCK;
    const chunkSize = 10000n;
    let oftEventsFound = 0;
    let transfersToZero = 0;
    let transfersFromZero = 0;
    
    while (searchFromBlock < latestBlock && oftEventsFound === 0) {
      const searchToBlock = searchFromBlock + chunkSize > latestBlock ? latestBlock : searchFromBlock + chunkSize;
      
      console.log(`  Searching blocks ${searchFromBlock} to ${searchToBlock}...`);
      
      try {
        // Search for OFT events
        const oftLogs = await client.getLogs({
          address: XETH_CONTRACT as `0x${string}`,
          fromBlock: searchFromBlock,
          toBlock: searchToBlock,
          topics: [[oftSentTopic, oftReceivedTopic]]
        });
        
        if (oftLogs.length > 0) {
          console.log(`\n✅ Found ${oftLogs.length} OFT events!`);
          for (const log of oftLogs.slice(0, 3)) { // Show first 3
            console.log(`    Block ${log.blockNumber}: ${log.transactionHash}`);
          }
          oftEventsFound += oftLogs.length;
        }
        
        // Search for burns (Transfer to zero address)
        const zeroAddress = '0x0000000000000000000000000000000000000000';
        const zeroTopic = '0x' + zeroAddress.slice(2).padStart(64, '0');
        
        const burnLogs = await client.getLogs({
          address: XETH_CONTRACT as `0x${string}`,
          fromBlock: searchFromBlock,
          toBlock: searchToBlock,
          topics: [
            transferTopic,
            null,
            zeroTopic
          ]
        });
        
        if (burnLogs.length > 0) {
          transfersToZero += burnLogs.length;
        }
        
        // Search for mints (Transfer from zero address)
        const mintLogs = await client.getLogs({
          address: XETH_CONTRACT as `0x${string}`,
          fromBlock: searchFromBlock,
          toBlock: searchToBlock,
          topics: [
            transferTopic,
            zeroTopic,
            null
          ]
        });
        
        if (mintLogs.length > 0) {
          transfersFromZero += mintLogs.length;
        }
        
        searchFromBlock = searchToBlock + 1n;
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.log(`    ⚠️ Error in range ${searchFromBlock}-${searchToBlock}:`, error);
        searchFromBlock = searchToBlock + 1n;
      }
    }
    
    console.log('\n📊 SUMMARY RESULTS:');
    console.log('==================');
    console.log(`OFT Events Found: ${oftEventsFound}`);
    console.log(`Burns (to zero): ${transfersToZero}`);
    console.log(`Mints (from zero): ${transfersFromZero}`);
    
    if (oftEventsFound === 0) {
      console.log('\n❌ No LayerZero OFT events found');
      console.log('This suggests either:');
      console.log('1. The contracts do not use LayerZero OFT standard');
      console.log('2. No bridge transactions have occurred yet');
      console.log('3. Different event signatures are used');
    } else {
      console.log('\n✅ LayerZero OFT events detected!');
    }
    
    if (transfersToZero > 0 || transfersFromZero > 0) {
      console.log('\n💡 Burn/Mint activity detected - could be bridge-related');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

searchEvents().catch(console.error);