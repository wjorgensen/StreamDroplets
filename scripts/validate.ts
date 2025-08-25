#!/usr/bin/env tsx

import { AccrualEngine } from '../src/accrual/AccrualEngine';
import { ChainlinkService } from '../src/oracle/ChainlinkService';
import { BalanceTracker } from '../src/indexer/BalanceTracker';
import { getDb, closeDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import { CONSTANTS, AssetType } from '../src/config/constants';

const logger = createLogger('Validate');

interface ValidationResult {
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    details?: any;
  }[];
}

async function validate(): Promise<ValidationResult> {
  const db = getDb();
  const result: ValidationResult = {
    passed: true,
    checks: [],
  };
  
  try {
    logger.info('Starting validation...');
    
    // Check 1: Database connectivity
    const dbCheck = {
      name: 'Database Connection',
      passed: false,
      details: {},
    };
    
    try {
      await db.raw('SELECT 1');
      dbCheck.passed = true;
    } catch (error) {
      dbCheck.details = { error: (error as Error).message };
    }
    
    result.checks.push(dbCheck);
    
    // Check 2: Required tables exist
    const tablesCheck = {
      name: 'Database Tables',
      passed: false,
      details: { missing: [] as string[] },
    };
    
    const requiredTables = [
      'rounds',
      'share_events',
      'balance_snapshots',
      'oracle_prices',
      'droplets_cache',
      'bridge_events',
      'cursors',
      'config',
      'current_balances',
    ];
    
    for (const table of requiredTables) {
      const exists = await db.schema.hasTable(table);
      if (!exists) {
        tablesCheck.details.missing.push(table);
      }
    }
    
    tablesCheck.passed = tablesCheck.details.missing.length === 0;
    result.checks.push(tablesCheck);
    
    // Check 3: Oracle prices available
    const oracleCheck = {
      name: 'Oracle Prices',
      passed: false,
      details: { assets: {} as Record<string, any> },
    };
    
    const oracleService = new ChainlinkService();
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    
    for (const asset of assets) {
      const hasPrice = await oracleService.validatePrices(asset);
      oracleCheck.details.assets[asset] = hasPrice;
    }
    
    oracleCheck.passed = Object.values(oracleCheck.details.assets).every(v => v);
    result.checks.push(oracleCheck);
    
    // Check 4: Round continuity
    const roundsCheck = {
      name: 'Round Continuity',
      passed: false,
      details: { assets: {} as Record<string, any> },
    };
    
    for (const asset of assets) {
      const rounds = await db('rounds')
        .where({ asset })
        .orderBy('round_id', 'asc');
      
      let continuous = true;
      for (let i = 1; i < rounds.length; i++) {
        if (rounds[i].round_id !== rounds[i - 1].round_id + 1) {
          continuous = false;
          break;
        }
      }
      
      roundsCheck.details.assets[asset] = {
        total: rounds.length,
        continuous,
        latest: rounds[rounds.length - 1]?.round_id,
      };
    }
    
    roundsCheck.passed = Object.values(roundsCheck.details.assets)
      .every((v: any) => v.continuous);
    result.checks.push(roundsCheck);
    
    // Check 5: Balance consistency
    const balanceCheck = {
      name: 'Balance Consistency',
      passed: false,
      details: { discrepancies: [] as any[] },
    };
    
    // Sample check: Total shares in events should match current balances
    const eventTotals = await db('share_events')
      .select('address', 'asset')
      .sum('shares_delta as total')
      .groupBy('address', 'asset');
    
    for (const eventTotal of eventTotals) {
      const currentBalance = await db('current_balances')
        .where({
          address: eventTotal.address,
          asset: eventTotal.asset,
        })
        .sum('shares as total')
        .first();
      
      const eventSum = BigInt(eventTotal.total || 0);
      const balanceSum = BigInt(currentBalance?.total || 0);
      
      if (eventSum !== balanceSum) {
        balanceCheck.details.discrepancies.push({
          address: eventTotal.address,
          asset: eventTotal.asset,
          event_total: eventSum.toString(),
          balance_total: balanceSum.toString(),
        });
      }
    }
    
    balanceCheck.passed = balanceCheck.details.discrepancies.length === 0;
    result.checks.push(balanceCheck);
    
    // Check 6: Droplets determinism (sample)
    const determinismCheck = {
      name: 'Droplets Determinism',
      passed: false,
      details: { tested: 0, passed: 0 },
    };
    
    const accrualEngine = new AccrualEngine();
    const testAddresses = await db('droplets_cache')
      .select('address')
      .limit(10);
    
    for (const row of testAddresses) {
      const cached = await db('droplets_cache')
        .where({ address: row.address })
        .sum('droplets_total as total')
        .first();
      
      const recalculated = await accrualEngine.calculateDroplets(row.address);
      
      determinismCheck.details.tested++;
      
      if (cached?.total === recalculated.droplets) {
        determinismCheck.details.passed++;
      }
    }
    
    determinismCheck.passed = determinismCheck.details.tested === determinismCheck.details.passed;
    result.checks.push(determinismCheck);
    
    // Overall result
    result.passed = result.checks.every(check => check.passed);
    
    // Print results
    console.log('\n=== Validation Results ===\n');
    
    for (const check of result.checks) {
      const status = check.passed ? '✅' : '❌';
      console.log(`${status} ${check.name}`);
      if (!check.passed && check.details) {
        console.log('   Details:', JSON.stringify(check.details, null, 2));
      }
    }
    
    console.log('\n' + '='.repeat(25));
    console.log(`Overall: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log('='.repeat(25) + '\n');
    
    return result;
    
  } catch (error) {
    logger.error('Validation failed:', error);
    result.passed = false;
    return result;
  } finally {
    await closeDb();
  }
}

// Run validation
validate().then(result => {
  process.exit(result.passed ? 0 : 1);
});