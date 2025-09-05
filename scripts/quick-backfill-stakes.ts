import { Alchemy, Network } from 'alchemy-sdk';
import { getDb } from '../src/db/connection';
import { decodeEventLog, parseAbiItem } from 'viem';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('QuickStakeBackfill');

const STAKE_EVENT = parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)');

const CONTRACTS = [
  { address: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153', symbol: 'xETH', chainId: 1 },
  { address: '0x12fd502e2052CaFB41eccC5B596023d9978057d6', symbol: 'xBTC', chainId: 1 },
  { address: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94', symbol: 'xUSD', chainId: 1 },
  { address: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13', symbol: 'xEUR', chainId: 1 },
];

async function quickBackfillStakes() {
  const alchemy = new Alchemy({
    apiKey: 'UqwRvCeB71FIweoaOAIoH2FYqJ6iottq',
    network: Network.ETH_MAINNET,
  });
  
  const db = await getDb();
  
  try {
    logger.info('Starting quick Stake event backfill...');
    
    for (const contract of CONTRACTS) {
      logger.info(`Processing ${contract.symbol}...`);
      
      // Get logs for Stake events specifically
      const stakeTopic = '0x5af417134f72a9d41143ace85b0a26dce6f550f894f2cbc1eeee8810603d91b6';
      
      const logs = await alchemy.core.getLogs({
        address: contract.address,
        topics: [stakeTopic],
        fromBlock: 21872213, // Deployment block
        toBlock: 'latest',
      });
      
      logger.info(`Found ${logs.length} Stake events for ${contract.symbol}`);
      
      // Process each Stake event
      for (const log of logs) {
        try {
          // Decode the event
          const decoded = decodeEventLog({
            abi: [STAKE_EVENT],
            data: log.data,
            topics: log.topics,
          });
          
          const account = decoded.args.account.toLowerCase();
          const amount = decoded.args.amount.toString();
          const blockNumber = typeof log.blockNumber === 'string' 
            ? parseInt(log.blockNumber, 16) 
            : log.blockNumber;
          
          // Update chain_share_balances
          const existing = await db('chain_share_balances')
            .where({
              chain_id: contract.chainId,
              address: account,
              asset: contract.symbol,
            })
            .first();
          
          if (existing) {
            await db('chain_share_balances')
              .where({ id: existing.id })
              .update({
                shares: (BigInt(existing.shares) + BigInt(amount)).toString(),
                last_block: blockNumber,
                last_updated: new Date(),
              });
          } else {
            await db('chain_share_balances').insert({
              chain_id: contract.chainId,
              address: account,
              asset: contract.symbol,
              shares: amount,
              last_block: blockNumber,
              last_updated: new Date(),
            });
          }
          
          // Also store the event
          await db('events').insert({
            chain_id: contract.chainId,
            contract_address: contract.address.toLowerCase(),
            transaction_hash: log.transactionHash,
            block_number: blockNumber,
            log_index: log.logIndex,
            event_name: 'Stake',
            topics: JSON.stringify(log.topics),
            data: log.data,
            decoded_data: JSON.stringify({
              account: decoded.args.account,
              amount: decoded.args.amount.toString(),
              round: decoded.args.round.toString(),
            }),
            created_at: new Date(),
          }).onConflict(['chain_id', 'transaction_hash', 'log_index']).ignore();
          
        } catch (error: any) {
          logger.error(`Error processing Stake event: ${error.message}`);
          if (logs.indexOf(log) === 0) {
            // Log full error for first one
            console.error('First error details:', error);
          }
        }
      }
    }
    
    // Now process Unstake events to subtract balances
    logger.info('Processing Unstake events...');
    const unstakeTopic = '0xf960dbf9e5d0682f7a298ed974e33a28b4464914b7a2bfac12ae419a9afeb280';
    
    for (const contract of CONTRACTS) {
      const logs = await alchemy.core.getLogs({
        address: contract.address,
        topics: [unstakeTopic],
        fromBlock: 21872213,
        toBlock: 'latest',
      });
      
      logger.info(`Found ${logs.length} Unstake events for ${contract.symbol}`);
      
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: [parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)')],
            data: log.data,
            topics: log.topics,
          });
          
          const account = decoded.args.account.toLowerCase();
          const amount = decoded.args.amount.toString();
          
          // Update balance
          const existing = await db('chain_share_balances')
            .where({
              chain_id: contract.chainId,
              address: account,
              asset: contract.symbol,
            })
            .first();
          
          if (existing) {
            const newBalance = BigInt(existing.shares) - BigInt(amount);
            if (newBalance > 0n) {
              await db('chain_share_balances')
                .where({ id: existing.id })
                .update({
                  shares: newBalance.toString(),
                  last_updated: new Date(),
                });
            } else {
              await db('chain_share_balances')
                .where({ id: existing.id })
                .delete();
            }
          }
        } catch (error) {
          logger.error(`Error processing Unstake event:`, error);
        }
      }
    }
    
    // Final summary
    const balanceCount = await db('chain_share_balances').count('* as count').first();
    const eventCount = await db('events').count('* as count').first();
    
    logger.info('\nBackfill complete!');
    logger.info(`- Total events: ${eventCount?.count || 0}`);
    logger.info(`- Users with balances: ${balanceCount?.count || 0}`);
    
    // Show top users
    const topUsers = await db('chain_share_balances')
      .select('address', 'asset')
      .sum('shares as total_shares')
      .groupBy('address', 'asset')
      .orderBy('total_shares', 'desc')
      .limit(5);
    
    logger.info('\nTop 5 users by shares:');
    topUsers.forEach(u => {
      const shares = Number(u.total_shares) / 1e18;
      logger.info(`  ${u.address.slice(0, 10)}... (${u.asset}): ${shares.toFixed(4)} shares`);
    });
    
  } catch (error) {
    logger.error('Backfill failed:', error);
  } finally {
    await db.destroy();
  }
}

quickBackfillStakes().catch(console.error);