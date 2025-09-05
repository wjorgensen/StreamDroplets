import { createPublicClient, http, parseAbi, Address } from 'viem';
import { mainnet, base, arbitrum, avalanche } from 'viem/chains';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('FetchAllChains');

// Define Sonic chain (Chain ID 146)
const sonic = {
  id: 146,
  name: 'Sonic',
  network: 'sonic',
  nativeCurrency: { name: 'S', symbol: 'S', decimals: 18 },
  rpcUrls: {
    default: { http: [`${process.env.ALCHEMY_SONIC_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`] },
    public: { http: [`${process.env.ALCHEMY_SONIC_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`] },
  },
};

// Define Berachain (Chain ID 81457)
const berachain = {
  id: 81457,
  name: 'Berachain',
  network: 'berachain',
  nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
  rpcUrls: {
    default: { http: [`${process.env.ALCHEMY_BERA_RPC}${process.env.ALCHEMY_API_KEY_1}`] },
    public: { http: [`${process.env.ALCHEMY_BERA_RPC}${process.env.ALCHEMY_API_KEY_1}`] },
  },
};

// OFT ABI for balanceOf and totalSupply
const OFT_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

interface ChainConfig {
  chainId: number;
  name: string;
  chain: any;
  contracts: {
    xETH: Address;
    xBTC: Address;
    xUSD: Address;
    xEUR: Address;
  };
}

async function fetchAllChains() {
  const db = await getDb();
  
  try {
    logger.info('=== FETCHING DATA FROM ALL CHAINS ===\n');
    
    // Configure all chains
    const chains: ChainConfig[] = [
      {
        chainId: 146,
        name: 'Sonic',
        chain: sonic,
        contracts: {
          xETH: process.env.XETH_OFT_SONIC as Address,
          xBTC: process.env.XBTC_OFT_SONIC as Address,
          xUSD: process.env.XUSD_OFT_SONIC as Address,
          xEUR: process.env.XEUR_OFT_SONIC as Address,
        },
      },
      {
        chainId: 8453,
        name: 'Base',
        chain: base,
        contracts: {
          xETH: process.env.XETH_OFT_BASE as Address,
          xBTC: process.env.XBTC_OFT_BASE as Address,
          xUSD: process.env.XUSD_OFT_BASE as Address,
          xEUR: process.env.XEUR_OFT_BASE as Address,
        },
      },
      {
        chainId: 42161,
        name: 'Arbitrum',
        chain: arbitrum,
        contracts: {
          xETH: process.env.XETH_OFT_ARB as Address,
          xBTC: process.env.XBTC_OFT_ARB as Address,
          xUSD: process.env.XUSD_OFT_ARB as Address,
          xEUR: process.env.XEUR_OFT_ARB as Address,
        },
      },
      {
        chainId: 43114,
        name: 'Avalanche',
        chain: avalanche,
        contracts: {
          xETH: process.env.XETH_OFT_AVAX as Address,
          xBTC: process.env.XBTC_OFT_AVAX as Address,
          xUSD: process.env.XUSD_OFT_AVAX as Address,
          xEUR: process.env.XEUR_OFT_AVAX as Address,
        },
      },
      {
        chainId: 81457,
        name: 'Berachain',
        chain: berachain,
        contracts: {
          xETH: process.env.XETH_OFT_BERA as Address,
          xBTC: process.env.XBTC_OFT_BERA as Address,
          xUSD: process.env.XUSD_OFT_BERA as Address,
          xEUR: process.env.XEUR_OFT_BERA as Address,
        },
      },
    ];
    
    for (const chainConfig of chains) {
      logger.info(`\nProcessing ${chainConfig.name} (Chain ID: ${chainConfig.chainId})...`);
      
      // Create client for this chain
      const client = createPublicClient({
        chain: chainConfig.chain,
        transport: http(),
      });
      
      // Process each asset
      for (const [asset, contractAddress] of Object.entries(chainConfig.contracts)) {
        if (!contractAddress) {
          logger.warn(`  Skipping ${asset} - no contract address`);
          continue;
        }
        
        try {
          logger.info(`  Fetching ${asset} holders from ${contractAddress}...`);
          
          // Get Transfer events to find all holders
          const fromBlock = 0n; // You might want to adjust this based on deployment block
          const toBlock = await client.getBlockNumber();
          
          // Fetch transfer events in chunks
          const chunkSize = 10000n;
          const holders = new Set<string>();
          
          for (let block = fromBlock; block < toBlock; block += chunkSize) {
            const endBlock = block + chunkSize > toBlock ? toBlock : block + chunkSize;
            
            try {
              const logs = await client.getLogs({
                address: contractAddress,
                event: OFT_ABI[3], // Transfer event
                fromBlock: block,
                toBlock: endBlock,
              });
              
              // Add all unique addresses
              logs.forEach(log => {
                if (log.args.from && log.args.from !== '0x0000000000000000000000000000000000000000') {
                  holders.add(log.args.from.toLowerCase());
                }
                if (log.args.to && log.args.to !== '0x0000000000000000000000000000000000000000') {
                  holders.add(log.args.to.toLowerCase());
                }
              });
            } catch (error) {
              logger.debug(`    Chunk ${block}-${endBlock} error: ${error.message}`);
            }
          }
          
          logger.info(`    Found ${holders.size} unique holders`);
          
          // Get current balances for all holders
          let validBalances = 0;
          const balanceRecords = [];
          
          for (const holder of holders) {
            try {
              const balance = await client.readContract({
                address: contractAddress,
                abi: OFT_ABI,
                functionName: 'balanceOf',
                args: [holder as Address],
              });
              
              if (balance && balance > 0n) {
                validBalances++;
                balanceRecords.push({
                  address: holder,
                  chain_id: chainConfig.chainId,
                  asset: `stream${asset.slice(1)}`, // Convert xETH to streamETH
                  shares: balance.toString(),
                  block_number: Number(toBlock),
                  created_at: new Date(),
                  updated_at: new Date(),
                });
              }
            } catch (error) {
              // Skip if balance check fails
            }
          }
          
          // Store balances in database
          if (balanceRecords.length > 0) {
            await db('chain_share_balances')
              .insert(balanceRecords)
              .onConflict(['address', 'chain_id', 'asset'])
              .merge(['shares', 'block_number', 'updated_at']);
            
            logger.info(`    Stored ${balanceRecords.length} balances for ${asset}`);
          }
          
        } catch (error) {
          logger.error(`  Error processing ${asset}: ${error.message}`);
        }
      }
    }
    
    // Summary
    logger.info('\n=== FETCH COMPLETE ===\n');
    
    const summary = await db.raw(`
      SELECT 
        chain_id,
        COUNT(DISTINCT address) as unique_users,
        COUNT(DISTINCT asset) as assets,
        COUNT(*) as total_records
      FROM chain_share_balances
      GROUP BY chain_id
      ORDER BY chain_id
    `);
    
    logger.info('Database Summary:');
    summary.rows.forEach(row => {
      const chainName = {
        1: 'Ethereum',
        146: 'Sonic',
        8453: 'Base',
        42161: 'Arbitrum',
        43114: 'Avalanche',
        81457: 'Berachain'
      }[row.chain_id] || `Chain ${row.chain_id}`;
      
      logger.info(`  ${chainName}: ${row.unique_users} users, ${row.assets} assets, ${row.total_records} records`);
    });
    
  } catch (error) {
    logger.error('Failed to fetch chain data:', error);
  } finally {
    await db.destroy();
  }
}

fetchAllChains().catch(console.error);