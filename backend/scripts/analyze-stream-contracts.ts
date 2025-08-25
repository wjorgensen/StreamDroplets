#!/usr/bin/env tsx
/**
 * Script to analyze Stream Protocol contracts and find all events
 * This will help identify the actual event signatures used
 */

import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('StreamContractAnalyzer');

// Stream Protocol contract addresses
const STREAM_CONTRACTS = {
  xETH: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
  xBTC: '0x12fd502e2052CaFB41eccC5B596023d9978057d6', 
  xUSD: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
  xEUR: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
};

// Known deployment block for xETH
const XETH_DEPLOYMENT_BLOCK = 21872213n;

async function analyzeContract(asset: string, contractAddress: string): Promise<void> {
  logger.info(`\n📊 ANALYZING ${asset} CONTRACT`);
  logger.info(`Address: ${contractAddress}`);
  logger.info('=' .repeat(50));

  // Create RPC client with Alchemy
  const client = createPublicClient({
    chain: mainnet,
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/UqwRvCeB71FIweoaOAIoH2FYqJ6iottq`),
  });

  try {
    // Check if contract exists
    const code = await client.getBytecode({ address: contractAddress as `0x${string}` });
    if (!code || code === '0x') {
      logger.error(`❌ No contract found at ${contractAddress}`);
      return;
    }
    
    logger.info(`✅ Contract found (${code.length / 2 - 1} bytes)`);

    // Get recent blocks to analyze - start from a reasonable recent block
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock - 5000n; // Last ~5000 blocks
    
    logger.info(`🔍 Searching for events in blocks ${fromBlock} to ${latestBlock}`);

    // Get ALL logs from this contract to see what events it emits
    const logs = await client.getLogs({
      address: contractAddress as `0x${string}`,
      fromBlock: fromBlock,
      toBlock: latestBlock,
    });

    logger.info(`📝 Found ${logs.length} total events in recent blocks`);

    if (logs.length === 0) {
      logger.warn('⚠️  No recent events found. Contract might be inactive or newly deployed.');
      return;
    }

    // Group events by topic (event signature)
    const eventsByTopic = new Map<string, any[]>();
    
    for (const log of logs) {
      const topic = log.topics[0];
      if (!eventsByTopic.has(topic)) {
        eventsByTopic.set(topic, []);
      }
      eventsByTopic.get(topic)!.push(log);
    }

    logger.info(`\n📋 UNIQUE EVENT SIGNATURES FOUND:`);
    logger.info('-'.repeat(40));

    const commonEventSignatures = [
      { name: 'Transfer', signature: 'Transfer(address,address,uint256)', topic: keccak256(toBytes('Transfer(address,address,uint256)')) },
      { name: 'Approval', signature: 'Approval(address,address,uint256)', topic: keccak256(toBytes('Approval(address,address,uint256)')) },
      { name: 'Stake', signature: 'Stake(address,uint256,uint256)', topic: keccak256(toBytes('Stake(address,uint256,uint256)')) },
      { name: 'Unstake', signature: 'Unstake(address,uint256,uint256)', topic: keccak256(toBytes('Unstake(address,uint256,uint256)')) },
      { name: 'Redeem', signature: 'Redeem(address,uint256,uint256)', topic: keccak256(toBytes('Redeem(address,uint256,uint256)')) },
      { name: 'RoundRolled', signature: 'RoundRolled(uint256,uint256,uint256,uint256,uint256,uint256,bool)', topic: keccak256(toBytes('RoundRolled(uint256,uint256,uint256,uint256,uint256,uint256,bool)')) },
      // LayerZero OFT events
      { name: 'OFTSent', signature: 'OFTSent(bytes32,uint32,address,uint256)', topic: keccak256(toBytes('OFTSent(bytes32,uint32,address,uint256)')) },
      { name: 'OFTReceived', signature: 'OFTReceived(bytes32,uint32,address,uint256)', topic: keccak256(toBytes('OFTReceived(bytes32,uint32,address,uint256)')) },
      // Alternative LayerZero events
      { name: 'SendToChain', signature: 'SendToChain(uint16,address,bytes,uint256)', topic: keccak256(toBytes('SendToChain(uint16,address,bytes,uint256)')) },
      { name: 'ReceiveFromChain', signature: 'ReceiveFromChain(uint16,bytes,uint256)', topic: keccak256(toBytes('ReceiveFromChain(uint16,bytes,uint256)')) },
      // More potential LayerZero events
      { name: 'MessageSent', signature: 'MessageSent(bytes32,uint32,bytes)', topic: keccak256(toBytes('MessageSent(bytes32,uint32,bytes)')) },
      { name: 'MessageReceived', signature: 'MessageReceived(bytes32,uint32,bytes)', topic: keccak256(toBytes('MessageReceived(bytes32,uint32,bytes)')) },
    ];

    for (const [topic, eventLogs] of eventsByTopic.entries()) {
      const knownEvent = commonEventSignatures.find(e => e.topic === topic);
      const eventName = knownEvent ? knownEvent.name : 'Unknown';
      const signature = knownEvent ? knownEvent.signature : 'Unknown signature';
      
      logger.info(`${eventName}: ${eventLogs.length} events`);
      logger.info(`  Topic: ${topic}`);
      logger.info(`  Signature: ${signature}`);
      
      // Show first event details
      if (eventLogs.length > 0) {
        const firstEvent = eventLogs[0];
        logger.info(`  First occurrence: Block ${firstEvent.blockNumber}, Tx ${firstEvent.transactionHash}`);
        
        // For Transfer events, show from/to addresses
        if (eventName === 'Transfer' && firstEvent.topics.length >= 3) {
          const from = `0x${firstEvent.topics[1]?.slice(26)}`;
          const to = `0x${firstEvent.topics[2]?.slice(26)}`;
          const zeroAddress = '0x0000000000000000000000000000000000000000';
          
          if (from.toLowerCase() === zeroAddress.toLowerCase()) {
            logger.info(`    🟢 MINT: from ${from} to ${to}`);
          } else if (to.toLowerCase() === zeroAddress.toLowerCase()) {
            logger.info(`    🔥 BURN: from ${from} to ${to}`);
          } else {
            logger.info(`    ↔️  TRANSFER: from ${from} to ${to}`);
          }
        }
      }
      logger.info('');
    }

    // Special search for bridge-related burns/mints
    await analyzeBridgeActivity(client, contractAddress, asset, fromBlock, latestBlock);

  } catch (error) {
    logger.error(`❌ Error analyzing ${asset} contract:`, error);
  }
}

async function analyzeBridgeActivity(
  client: any,
  contractAddress: string,
  asset: string,
  fromBlock: bigint,
  latestBlock: bigint
): Promise<void> {
  logger.info(`🌉 BRIDGE ACTIVITY ANALYSIS FOR ${asset}`);
  logger.info('-'.repeat(40));

  try {
    const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const zeroTopic = '0x' + zeroAddress.slice(2).padStart(64, '0');

    // Look for burns (transfers TO zero address)
    const burnLogs = await client.getLogs({
      address: contractAddress as `0x${string}`,
      fromBlock: fromBlock,
      toBlock: latestBlock,
      topics: [
        transferTopic,
        null, // from (any address)
        zeroTopic // to zero address
      ]
    });

    // Look for mints (transfers FROM zero address)  
    const mintLogs = await client.getLogs({
      address: contractAddress as `0x${string}`,
      fromBlock: fromBlock,
      toBlock: latestBlock,
      topics: [
        transferTopic,
        zeroTopic, // from zero address
        null // to (any address)
      ]
    });

    logger.info(`🔥 Burns (to zero): ${burnLogs.length} events`);
    logger.info(`🟢 Mints (from zero): ${mintLogs.length} events`);

    // Analyze burn transactions to see if they're bridge-related
    if (burnLogs.length > 0) {
      logger.info('\n🔍 Analyzing burn transactions for bridge patterns:');
      
      for (let i = 0; i < Math.min(5, burnLogs.length); i++) {
        const burnLog = burnLogs[i];
        const tx = await client.getTransaction({ hash: burnLog.transactionHash });
        const receipt = await client.getTransactionReceipt({ hash: burnLog.transactionHash });
        
        logger.info(`\nBurn ${i + 1}:`);
        logger.info(`  Tx: ${burnLog.transactionHash}`);
        logger.info(`  Block: ${burnLog.blockNumber}`);
        logger.info(`  From: 0x${burnLog.topics[1]?.slice(26)}`);
        logger.info(`  Method: ${tx.input?.slice(0, 10)}`);
        logger.info(`  Gas Used: ${receipt.gasUsed}`);
        logger.info(`  Logs Count: ${receipt.logs.length}`);
        
        // Check if any logs in this tx have LayerZero-like patterns
        const hasLzLogs = receipt.logs.some(log => {
          // Look for logs with multiple topics (common in LayerZero)
          return log.topics.length >= 4 || log.data.length > 66; // More than basic uint256
        });
        
        if (hasLzLogs) {
          logger.info(`  🌉 Potential bridge transaction (complex logs detected)`);
        }
      }
    }

    // Analyze mint transactions
    if (mintLogs.length > 0) {
      logger.info('\n🔍 Analyzing mint transactions:');
      
      for (let i = 0; i < Math.min(3, mintLogs.length); i++) {
        const mintLog = mintLogs[i];
        const tx = await client.getTransaction({ hash: mintLog.transactionHash });
        const receipt = await client.getTransactionReceipt({ hash: mintLog.transactionHash });
        
        logger.info(`\nMint ${i + 1}:`);
        logger.info(`  Tx: ${mintLog.transactionHash}`);
        logger.info(`  Block: ${mintLog.blockNumber}`);
        logger.info(`  To: 0x${mintLog.topics[2]?.slice(26)}`);
        logger.info(`  Method: ${tx.input?.slice(0, 10)}`);
        logger.info(`  Logs Count: ${receipt.logs.length}`);
      }
    }

  } catch (error) {
    logger.error('Error analyzing bridge activity:', error);
  }
}

async function main(): Promise<void> {
  try {
    logger.info('🚀 STREAM PROTOCOL CONTRACT ANALYSIS');
    logger.info('=====================================');
    
    // Analyze all contracts
    for (const [asset, contractAddress] of Object.entries(STREAM_CONTRACTS)) {
      await analyzeContract(asset, contractAddress);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
    }
    
    logger.info('\n✅ Analysis completed');
    
  } catch (error) {
    logger.error('Error in main:', error);
    process.exit(1);
  }
}

main().catch(console.error);