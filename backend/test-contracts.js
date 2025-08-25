const { createPublicClient, http, parseAbiItem } = require('viem');
const { mainnet } = require('viem/chains');

async function testContract() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http('https://eth.llamarpc.com'),
  });

  const contracts = [
    { symbol: 'xETH', address: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153' },
    { symbol: 'xBTC', address: '0x1aB7348741E7BA04a8c6163E852F3D7a1E4C8398' },
    { symbol: 'xUSD', address: '0xEc1B5fF451C1De3235587cEc997C33491D22C73e' },
    { symbol: 'xEUR', address: '0x45a87c78073eF2FB837b853763B96bd1Cd893BcC' },
  ];

  const currentBlock = await client.getBlockNumber();
  console.log('Current block:', currentBlock);

  for (const contract of contracts) {
    try {
      console.log(`\nTesting ${contract.symbol} at ${contract.address}`);
      
      // Try to get code at address
      const code = await client.getBytecode({ address: contract.address });
      console.log(`  Has code: ${code && code !== '0x' ? 'YES' : 'NO'}`);
      
      // Try to fetch recent transfer events
      const transfers = await client.getLogs({
        address: contract.address,
        event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
        fromBlock: currentBlock - 100n,
        toBlock: currentBlock,
      });
      
      console.log(`  Transfers in last 100 blocks: ${transfers.length}`);
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
    }
  }
}

testContract().catch(console.error);