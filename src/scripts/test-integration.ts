/**
 * Test script for integration tracking
 * Verifies that integration protocols are properly configured and tracked
 */

import { getDb } from '../db/connection';
import { IntegrationAccrualEngine } from '../accrual/IntegrationAccrualEngine';
import { AccrualEngine } from '../accrual/AccrualEngine';
import { createLogger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('IntegrationTest');

async function testIntegrationSetup() {
  const db = getDb();
  
  try {
    logger.info('Testing Integration Setup...');
    
    // 1. Check if integration tables exist
    logger.info('Checking database tables...');
    const tables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        'integration_protocols',
        'integration_positions',
        'integration_events',
        'lp_pool_reserves',
        'vault_exchange_rates',
        'integration_droplets_cache',
        'integration_cursors'
      )
    `);
    
    logger.info(`Found ${tables.rows.length} integration tables`);
    tables.rows.forEach((row: any) => {
      logger.info(`  - ${row.table_name}`);
    });
    
    // 2. Check integration protocols
    logger.info('\nChecking configured integration protocols...');
    const protocols = await db('integration_protocols').select('*');
    
    logger.info(`Found ${protocols.length} integration protocols:`);
    protocols.forEach((protocol: any) => {
      logger.info(`  - ${protocol.protocol_name} (${protocol.integration_type}) on chain ${protocol.chain_id}`);
      logger.info(`    Contract: ${protocol.contract_address}`);
      logger.info(`    Asset: ${protocol.underlying_asset}`);
      logger.info(`    Active: ${protocol.is_active}`);
    });
    
    // 3. Check excluded addresses
    logger.info('\nChecking excluded addresses for integrations...');
    const excludedCount = await db('excluded_addresses')
      .where('reason', 'LIKE', '%Integration%')
      .orWhere('reason', 'LIKE', '%Pool Contract%')
      .count('* as count');
    
    logger.info(`Found ${excludedCount[0].count} integration-related excluded addresses`);
    
    // 4. Test sample address calculation
    const testAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0'; // Example address
    
    logger.info(`\nTesting droplet calculation for address: ${testAddress}`);
    
    // Test integration engine
    const integrationEngine = new IntegrationAccrualEngine();
    const integrationResult = await integrationEngine.calculateIntegrationDroplets(testAddress);
    
    logger.info('Integration droplets result:');
    logger.info(`  Total integration droplets: ${integrationResult.totalDroplets}`);
    logger.info(`  Protocols with positions: ${integrationResult.breakdown.length}`);
    integrationResult.breakdown.forEach((item: any) => {
      logger.info(`    - ${item.protocolName}: ${item.droplets} droplets (USD value: ${item.usdValue})`);
    });
    
    // Test main engine with integrations
    const mainEngine = new AccrualEngine();
    const totalResult = await mainEngine.calculateDroplets(testAddress);
    
    logger.info('\nTotal droplets result (including integrations):');
    logger.info(`  Total droplets: ${totalResult.droplets}`);
    logger.info('  Breakdown:');
    Object.entries(totalResult.breakdown || {}).forEach(([asset, droplets]) => {
      logger.info(`    - ${asset}: ${droplets}`);
    });
    
    if (totalResult.integrationDetails) {
      logger.info('  Integration details:');
      totalResult.integrationDetails.forEach((detail: any) => {
        logger.info(`    - ${detail.protocolName}: ${detail.droplets} droplets`);
      });
    }
    
    // 5. Verify integration contract exclusion
    logger.info('\nVerifying integration contracts are excluded from earning droplets...');
    
    const integrationContracts = [
      '0xdEE813F080f9128e52E38E9Ffef8B997F9544332', // Shadow Pool A
      '0xFEAd02Fb16eC3B2F6318dCa230198dB73E99428C', // Shadow Pool B
      '0xdEBdAB749330bb976fD10dc52f9A452aaF029028', // Euler Vault
      '0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172', // Silo Market 118
      '0x172a687c397E315DBE56ED78aB347D7743D0D4fa', // Silo Market 112
      '0xc380E5250d9718f8d9116Bc9d787A0229044e2EB', // Silo Avalanche
      '0x13d79435F306D155CA2b9Af77234c84f80506045', // Enclabs/Stability
    ];
    
    for (const contractAddress of integrationContracts) {
      const result = await mainEngine.calculateDroplets(contractAddress);
      if (result.droplets === '0') {
        logger.info(`  ✓ ${contractAddress.slice(0, 10)}... correctly excluded (0 droplets)`);
      } else {
        logger.error(`  ✗ ${contractAddress.slice(0, 10)}... NOT excluded (${result.droplets} droplets) - THIS IS AN ERROR!`);
      }
    }
    
    logger.info('\n✅ Integration setup test completed successfully!');
    
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Run the test
if (require.main === module) {
  testIntegrationSetup()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('Unhandled error:', error);
      process.exit(1);
    });
}