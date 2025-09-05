import { Alchemy, Network } from 'alchemy-sdk';
import { getDb } from '../src/db/connection';
import { decodeEventLog, parseAbiItem } from 'viem';

const EVENT_SIGNATURES = {
  // ERC-4626 Vault events
  Deposit: parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  Withdraw: parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

async function testEventFetching() {
  const alchemy = new Alchemy({
    apiKey: 'UqwRvCeB71FIweoaOAIoH2FYqJ6iottq',
    network: Network.ETH_MAINNET,
  });
  
  const db = await getDb();
  
  try {
    // Test fetching events from xETH vault
    const contract = {
      address: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
      symbol: 'xETH',
    };
    
    // Fetch recent logs
    console.log('Fetching recent logs from xETH contract...');
    const logs = await alchemy.core.getLogs({
      address: contract.address,
      fromBlock: 21872213, // Deployment block
      toBlock: 21872313, // 100 blocks after
    });
    
    console.log(`Found ${logs.length} logs`);
    
    // Try to decode them
    let decodedCount = 0;
    for (const log of logs.slice(0, 10)) { // Process first 10
      let eventName = 'Unknown';
      let decodedLog: any = null;
      
      // Try to decode against known event signatures
      for (const [name, signature] of Object.entries(EVENT_SIGNATURES)) {
        try {
          decodedLog = decodeEventLog({
            abi: [signature],
            data: log.data,
            topics: log.topics,
          });
          eventName = name;
          decodedCount++;
          break;
        } catch {
          // Not this event type
        }
      }
      
      console.log(`  Block ${log.blockNumber}: ${eventName}`);
      console.log(`    Topic0: ${log.topics[0]}`);
      if (decodedLog) {
        console.log('    Args:', JSON.stringify(decodedLog.args, null, 2));
      }
    }
    
    console.log(`\nSuccessfully decoded ${decodedCount} events`);
    
  } finally {
    await db.destroy();
  }
}

testEventFetching().catch(console.error);