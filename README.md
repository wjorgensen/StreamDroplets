# StreamDroplets API

## Overview

StreamDroplets is a multi-chain indexing and rewards system that tracks user balances across Stream Protocol's vault contracts and integration protocols. The system processes blockchain events, calculates user positions, fetches real-time price data, and awards "droplets" based on USD value held.

The system operates across 6 blockchains (Ethereum, Sonic, Base, Arbitrum, Avalanche, Berachain) and integrates with multiple DeFi protocols including Shadow Exchange, Euler Finance, Enclabs, Stability Protocol, Royco, and Silo Finance.

## Architecture

### Key Components

#### MainOrchestrator
The primary orchestration service that coordinates the entire indexing system. It handles:
- Historical backfill from deployment dates to current
- Real-time daily snapshots triggered at 12:05 AM EST
- Progress tracking via database cursors
- Block range calculation for multi-chain processing
- Chain synchronization and validation

#### DailySnapshotService
The core processing engine that creates daily user and protocol snapshots. Responsibilities include:
- Coordinating vault and integration event processing
- Fetching price data from Chainlink oracles
- Calculating user balances and USD values
- Computing droplet rewards (1 droplet per USD per day)
- Creating comprehensive daily snapshots for users and protocol totals
- Transfer validation and retry logic

#### VaultIndexer
Processes events from Stream Protocol's vault contracts across all supported chains:
- Handles Deposit, Withdraw, and Transfer events
- Tracks share balances and underlying asset amounts
- Updates real-time balance tracking in the database
- Supports all vault types: xETH, xBTC, xUSD, xEUR

#### IntegrationIndexer
Coordinates event processing across multiple integration protocols:
- **Shadow Exchange**: DEX liquidity pool tracking on Sonic
- **Euler Finance**: Vault deposits and yield accrual on Sonic
- **Enclabs**: Lending protocol integration on Sonic
- **Stability Protocol**: Stability pool participation on Sonic
- **Royco**: Market-making protocol integration via API on Sonic
- **Silo Finance**: Isolated lending markets on Sonic and Avalanche

Each integration has its own balance tracker that handles protocol-specific logic and price-per-share calculations.

#### ChainlinkService
Fetches real-time price data for all supported assets:
- Retrieves ETH, BTC, USDC, and EUR prices at specific block numbers
- Uses Chainlink price feeds on Ethereum mainnet
- Ensures consistent pricing across all chains and snapshots

### System Flow

1. **MainOrchestrator** starts and initializes all chain connections
2. **Historical Backfill**: Processes all days from deployment to current, calculating block ranges for each chain
3. **Daily Processing**: Each day, the system:
   - Calculates block ranges for end-of-day on all chains
   - **VaultIndexer** processes vault events across all chains
   - **IntegrationIndexer** processes integration events on Sonic/Avalanche
   - Updates integration balances with current exchange rates
   - **ChainlinkService** fetches price data at end-of-day blocks
   - **DailySnapshotService** creates user and protocol snapshots
   - Validates transfer consistency and retries if needed
4. **Real-time Mode**: Runs daily at 12:05 AM EST to process previous day's data

## Setup Instructions

### 1. Environment Variables

Copy the example environment file and configure your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:
```env
# Required API Keys
ALCHEMY_API_KEY=your_alchemy_api_key_here
ROYCO_API_KEY=your_royco_api_key_here

# Database password
DB_PASSWORD=your_secure_password_here
```

**Required Services:**
- **Alchemy API Key**: Get from [alchemy.com](https://alchemy.com) - needs access to all supported chains (Ethereum, Sonic, Base, Arbitrum, Avalanche, Berachain)
- **Royco API Key**: Get from Royco Protocol for market data access

### 2. Configuration Review

#### Check Settings in `src/config/constants.ts`

Review the `CONSTANTS` object for any adjustments needed:

```typescript
export const CONSTANTS = {
  /** Droplet calculation settings */
  DROPLET_USD_RATIO: 1, // 1 droplet per USD per day
  
  /** API retry configuration */
  MAX_ALCHEMY_RETRIES: 5,
  MAX_ROYCO_API_RETRIES: 10,
  
  /** Database configuration */
  DATABASE: {
    HOST: 'localhost',
    PORT: 5432,
    NAME: 'stream_droplets',
    USER: 'stream',
  },
  
  /** API server configuration */
  API: {
    PORT: 3000,
    HOST: '0.0.0.0',
  },
}
```

#### Verify Contract Addresses in `src/config/contracts.ts`

Double-check the contract configurations for accuracy:

- **CONTRACTS**: Stream vault addresses across all chains
- **INTEGRATION_CONTRACTS**: Integration protocol addresses
- **DEPLOYMENT_INFO**: Deployment dates and starting blocks

Key sections to verify:
- Vault addresses for each chain
- Oracle feed addresses for price data
- Integration contract addresses
- Deployment blocks and dates

### 3. Docker Deployment

The system is containerized for easy deployment:

```bash
# Start the complete system (database + API + indexer)
docker compose up -d

# View logs
docker compose logs -f

# Stop the system
docker compose down
```

The Docker setup includes:
- PostgreSQL database with automatic migrations
- Node.js application container
- Automatic dependency installation
- Environment variable injection
- Health checks and restart policies

### 4. Monitoring

After startup, monitor the system:

```bash
# Check system health
curl http://localhost:3000/api/v1/health

# View indexer progress in logs
docker compose logs -f stream-droplets

# Check database connectivity
docker compose exec db psql -U stream -d stream_droplets -c "SELECT COUNT(*) FROM daily_snapshots;"
```

The system will automatically:
1. Run database migrations
2. Initialize chain connections
3. Start historical backfill if needed
4. Begin real-time processing
5. Serve API endpoints

## Database Schema

The system maintains several key tables:
- `share_balances`: Current user balances across vault contracts
- `integration_balances`: User balances in integration protocols  
- `user_daily_snapshots`: Daily user balance and droplet snapshots
- `daily_snapshots`: Protocol-wide daily snapshots
- `daily_events`: Raw blockchain events processed
- `progress_cursors`: Chain indexing progress tracking

## Adding New Chains

If the protocol decides to expand to additional blockchain networks in the future, follow this comprehensive guide to integrate a new chain.

### Overview

Adding a new chain requires updates to **7 files** across the codebase:

| File | Changes | Required? |
|------|---------|-----------|
| `src/config/contracts.ts` | 5 updates: chain config, network mapping, vault addresses, deployment info, block time | ✅ Yes |
| `src/config/constants.ts` | 2-3 updates: Alchemy URL, chain ID, LayerZero EID | ✅ Yes |
| `src/indexer/vault/VaultIndexer.ts` | 1 update: batch size configuration | ✅ Yes |
| `src/utils/AlchemyService.ts` | 1 update: RPC URL mapping | ✅ Yes |
| `src/utils/blockTime.ts` | 2 updates: chain mapping, timestamp API support | ✅ Yes |
| Database | 1 update: progress cursor entry | ✅ Yes |
| `src/services/DailySnapshotService.ts` | 1 update: integration chain filter | ⚠️ Only if chain has integrations |

**Good News:** `MainOrchestrator.ts` and `VaultIndexer.ts` core logic are fully dynamic and require no changes!

### Prerequisites

Before beginning, ensure you have:
- **Vault contract addresses** for all four assets (xETH, xBTC, xUSD, xEUR) on the new chain
- **Deployment block numbers** for each vault contract
- **Deployment date** (YYYY-MM-DD format) when the first vault was deployed
- **Alchemy support** verification - confirm the chain is supported by Alchemy SDK
- **Typical block time** for the chain (in seconds) for fallback calculations

### Step-by-Step Integration Guide

#### Step 1: Update Chain Configuration (`src/config/contracts.ts`)

**1.1. Add to `SUPPORTED_CHAINS`** (lines 31-62)

Add your new chain to the `SUPPORTED_CHAINS` object:

```typescript
export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  // ... existing chains
  newchain: {  // Use lowercase chain name as key
    chainId: 12345,  // Your chain's ID
    name: 'NewChain',  // Display name
    alchemyNetwork: Network.NEWCHAIN_MAINNET,  // Alchemy SDK Network enum
  },
} as const;
```

**1.2. Add to `networkToNetworkName` mapping** (lines 88-104)

Add the network name mapping for the block time API:

```typescript
export function networkToNetworkName(network: Network): NetworkName {
  const networkMapping: Partial<Record<Network, NetworkName>> = {
    // ... existing mappings
    [Network.NEWCHAIN_MAINNET]: 'newchain-mainnet',
  };
  // ...
}
```

**1.3. Add vault addresses to `CONTRACTS`** (lines 200-245)

For each asset type (xETH, xBTC, xUSD, xEUR), add the new chain's vault address:

```typescript
export const CONTRACTS: Record<string, ContractConfig> = {
  xETH: {
    // ... existing chains
    newchain: '0xYourNewChainXETHVaultAddress',
    // ...
  },
  xBTC: {
    // ... existing chains
    newchain: '0xYourNewChainXBTCVaultAddress',
    // ...
  },
  xUSD: {
    // ... existing chains
    newchain: '0xYourNewChainXUSDVaultAddress',
    // ...
  },
  xEUR: {
    // ... existing chains
    newchain: '0xYourNewChainXEURVaultAddress',
    // ...
  },
};
```

**1.4. Add deployment information to `DEPLOYMENT_INFO`** (lines 361-395)

Add the chain's deployment metadata:

```typescript
export const DEPLOYMENT_INFO = {
  OVERALL_START_DATE: '2025-02-18',  // Don't change this
  CHAIN_DEPLOYMENTS: {
    // ... existing chains
    NEWCHAIN: {
      chainId: 12345,
      earliestBlock: 9999999,  // Block number of first vault deployment
      earliestDate: '2025-03-01',  // Date in YYYY-MM-DD format
    },
  },
} as const;
```

**1.5. Add block time to `TYPICAL_BLOCK_TIME_SEC`** (lines 413-420)

Add the chain's typical block time for binary search fallback:

```typescript
export const TYPICAL_BLOCK_TIME_SEC: Record<number, number> = {
  // ... existing chains
  12345: 2,  // Your chain's typical block time in seconds
} as const;
```

#### Step 2: Update Constants (`src/config/constants.ts`)

**2.1. Add Alchemy base URL** (lines 24-32)

```typescript
ALCHEMY_BASE_URLS: {
  // ... existing chains
  NEWCHAIN: 'https://newchain-mainnet.g.alchemy.com/v2/',
},
```

**2.2. Add to `CHAIN_IDS` object** (lines 95-102)

```typescript
CHAIN_IDS: {
  // ... existing chains
  NEWCHAIN: 12345,
},
```

**2.3. (Optional) Add LayerZero EID mapping** (lines 105-112)

If your chain uses LayerZero for cross-chain transfers:

```typescript
LAYERZERO_EID_TO_CHAIN_ID: {
  // ... existing mappings
  30999: 12345,  // NewChain LayerZero Endpoint ID
} as const,
```

#### Step 3: Configure Indexer Batch Size (`src/indexer/vault/VaultIndexer.ts`)

**3.1. Add to `MAX_BATCHES` mapping** (lines 13-20)

Start with a conservative batch size and adjust based on testing:

```typescript
const MAX_BATCHES: Record<number, number> = {
  // ... existing chains
  12345: 10000,  // Start with 10k, increase if stable
};
```

**Testing guidance:**
- Start with 10,000 blocks per batch
- Monitor for Alchemy rate limit errors during initial indexing
- If stable, try increasing to 50,000, then 100,000
- Reduce if you encounter rate limit or timeout errors

#### Step 3.2: Update Alchemy Service (`src/utils/AlchemyService.ts`)

**Add RPC URL mapping** (lines 100-108)

Add your chain's RPC URL to the `getAlchemyRpcUrl` method:

```typescript
private getAlchemyRpcUrl(network: Network, apiKey: string): string {
  const rpcUrls: Partial<Record<Network, string>> = {
    // ... existing chains
    [Network.NEWCHAIN_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.NEWCHAIN}${apiKey}`,
  };
  // ...
}
```

**Important:** This step requires that you completed Step 2.1 (adding the Alchemy base URL to constants.ts).

#### Step 3.3: Test Alchemy Blocks-By-Timestamp API Support

Before continuing, **test if your chain is supported** by Alchemy's blocks-by-timestamp API. This determines whether the system will use fast API lookups or binary search fallback.

**Create a test script:** `test-newchain-alchemy.ts`

```typescript
import { config } from './src/config';

async function testNewChainAlchemySupport() {
  const apiKey = config.apiKeys.alchemy;
  
  if (!apiKey) {
    console.error('ALCHEMY_API_KEY not found in environment');
    process.exit(1);
  }

  const timestamp = '2025-03-01T00:00:00Z';  // Use your chain's start date
  const network = 'newchain-mainnet';  // Your network name
  
  const url = `https://api.g.alchemy.com/data/v1/${encodeURIComponent(apiKey)}/utility/blocks/by-timestamp`;
  
  const params = new URLSearchParams();
  params.set('networks', network);
  params.set('timestamp', timestamp);
  params.set('direction', 'BEFORE');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };

  console.log(`Testing Alchemy blocks-by-timestamp API for ${network}...`);
  console.log(`Timestamp: ${timestamp}\n`);

  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers
    });

    console.log(`Response status: ${res.status} ${res.statusText}`);
    const responseText = await res.text();
    console.log(`Response body: ${responseText}\n`);

    if (!res.ok) {
      console.error(`❌ NOT supported - will use binary search`);
      process.exit(0);
    }

    const json = JSON.parse(responseText);
    
    if (json.data && json.data.length > 0 && json.data[0]?.block) {
      console.log(`✅ SUPPORTED! Add to SUPPORTED_TIMESTAMP_NETWORKS`);
      console.log(`Block: ${json.data[0].block.number}`);
    }
  } catch (error: any) {
    console.error(`❌ NOT supported - will use binary search`);
  }
}

testNewChainAlchemySupport();
```

**Run the test:**

```bash
npx tsx test-newchain-alchemy.ts
```

**Interpret results:**
- ✅ **Status 200 with block data** → Chain IS supported, add to `SUPPORTED_TIMESTAMP_NETWORKS` (Step 3.3.2)
- ❌ **Status 400 "Unsupported network"** → Chain NOT supported, skip `SUPPORTED_TIMESTAMP_NETWORKS`

**Clean up:**
```bash
rm test-newchain-alchemy.ts
```

#### Step 3.4: Update Block Time Utilities (`src/utils/blockTime.ts`)

**3.4.1. Add to chain mapping for binary search** (lines 279-292)

Add your chain to the hardcoded mapping used for binary search fallback:

```typescript
const chainConfig = Object.values({
  // ... existing chains
  newchain: { chainId: 12345, alchemyNetwork: Network.NEWCHAIN_MAINNET },
}).find(config => {
  // ...
});
```

**3.4.2. (Optional) Add to supported timestamp networks** (lines 15-22)

**Only if Step 3.3 test succeeded** (Status 200 with block data):

```typescript
const SUPPORTED_TIMESTAMP_NETWORKS = new Set<NetworkName>([
  // ... existing networks
  'newchain-mainnet',  // Add only if Alchemy test passed
]);
```

**Note:** If your chain is NOT supported by Alchemy's API, the system will automatically use binary search fallback (configured in Step 1.5 with typical block time).

#### Step 3.5: Verify Dynamic Systems (No Changes Needed)

The following components automatically adapt to new chains once the above configurations are complete:

✅ **MainOrchestrator.ts** - Uses `getSupportedChainIds()` and loops through all chains dynamically  
✅ **VaultIndexer.ts** - Uses `buildVaultContracts()` to automatically include all configured vaults  
✅ **DailySnapshotService.ts** - Processes all chains in the provided block ranges (except integration filtering in Step 5)

No code changes needed in these files for basic vault indexing.

#### Step 4: Handle SDK Compatibility (If Needed)

**Skip this step unless:** Your chain is very new and not yet in the Alchemy SDK (like Plasma was).

If you get TypeScript errors like `Property 'NEWCHAIN_MAINNET' does not exist on type 'typeof Network'`:

**4.1. Use type assertions in contracts.ts:**

```typescript
newchain: {
  chainId: 12345,
  name: 'NewChain',
  alchemyNetwork: 'newchain-mainnet' as Network,  // Type assertion
},
```

**4.2. Add special case handling in networkToNetworkName (contracts.ts):**

```typescript
export function networkToNetworkName(network: Network): NetworkName {
  // Handle NewChain (not yet in SDK)
  if (network === ('newchain-mainnet' as any)) {
    return 'newchain-mainnet';
  }
  
  const networkMapping: Partial<Record<Network, NetworkName>> = {
    // ... existing mappings (don't add newchain here)
  };
  // ...
}
```

**4.3. Add special case in AlchemyService.ts:**

```typescript
private getAlchemyRpcUrl(network: Network, apiKey: string): string {
  // Handle NewChain (not yet in SDK)
  if (network === ('newchain-mainnet' as any)) {
    return `${CONSTANTS.ALCHEMY_BASE_URLS.NEWCHAIN}${apiKey}`;
  }
  
  const rpcUrls: Partial<Record<Network, string>> = {
    // ... existing URLs (don't add newchain here)
  };
  // ...
}
```

**4.4. Use 'as any' in blockTime.ts chain mapping:**

```typescript
newchain: { chainId: 12345, alchemyNetwork: 'newchain-mainnet' as any },
```

**Note:** Once the Alchemy SDK updates to include your chain, you can remove these workarounds and use the proper `Network.NEWCHAIN_MAINNET` enum.

#### Step 5: Initialize Database Progress Cursor

**5.1. Create and run a database migration**

Create a new migration file or run this SQL directly on your database:

```sql
-- Replace values with your chain's information
INSERT INTO progress_cursors (chain_id, chain_name, last_processed_block, last_processed_date)
VALUES (
  12345,                    -- Your chain ID
  'newchain',              -- Lowercase chain name
  9999998,                 -- earliestBlock - 1
  '2025-02-17'             -- Day before your chain's earliestDate
)
ON CONFLICT (chain_id) DO NOTHING;
```

**Important:** The `last_processed_block` should be `earliestBlock - 1`, and `last_processed_date` should be the day before your chain's `earliestDate`. This ensures the indexer starts from the correct block when processing the first day.

#### Step 6: (Optional) Add Integration Chain Support

**6.1. Only if integrations exist on the new chain**

If your new chain has integration protocols (like Shadow Exchange, Euler, Silo, etc.), update the integration chain filter in `src/services/DailySnapshotService.ts` (lines 59-62):

```typescript
const integrationRanges = blockRanges.filter(range => 
  range.chainId === CONSTANTS.CHAIN_IDS.SONIC || 
  range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE ||
  range.chainId === CONSTANTS.CHAIN_IDS.NEWCHAIN  // Add your chain
);
```

**6.2. Configure integration contracts**

If adding integrations, also update the `INTEGRATION_CONTRACTS` object in `src/config/contracts.ts` (lines 151-186):

```typescript
export const INTEGRATION_CONTRACTS = {
  // ... existing integrations
  YOUR_PROTOCOL: {
    NEWCHAIN: {
      CONTRACT_ADDRESS: '0xYourIntegrationContractAddress',
    },
  },
} as const;
```

#### Step 7: Update Environment Variables (if needed)

If your chain requires custom RPC endpoints beyond Alchemy, add to `.env`:

```env
# NewChain Configuration (if custom RPC needed)
NEWCHAIN_RPC_URL=https://rpc.newchain.network
NEWCHAIN_API_KEY=your_api_key_here
```

#### Step 8: Verify Alchemy SDK Support

Ensure the Alchemy SDK supports your chain:

1. Check [Alchemy's supported networks documentation](https://docs.alchemy.com/reference/supported-networks)
2. Verify the `Network` enum includes your chain (e.g., `Network.NEWCHAIN_MAINNET`)
3. If not supported by Alchemy, you'll need to implement a custom RPC provider in `src/utils/AlchemyService.ts`

#### Step 9: Testing and Deployment

**9.1. Test configuration**

Before deploying, verify your configuration:

```bash
# Check that all vault addresses are valid
node -e "const c = require('./src/config/contracts'); console.log(c.CONTRACTS.xETH.newchain)"

# Verify chain is in supported list
node -e "const c = require('./src/config/contracts'); console.log(c.getSupportedChainIds())"
```

**9.2. Deploy and monitor**

```bash
# Rebuild and restart services
docker compose down
docker compose build
docker compose up -d

# Monitor logs for the new chain
docker compose logs -f | grep "chain 12345"
```

**9.3. Verify indexing**

After startup, check that the chain is being indexed:

```bash
# Check progress cursor
docker compose exec db psql -U stream -d stream_droplets -c \
  "SELECT * FROM progress_cursors WHERE chain_id = 12345;"

# Check for events being indexed
docker compose exec db psql -U stream -d stream_droplets -c \
  "SELECT COUNT(*) FROM daily_events WHERE chain_id = 12345;"
```

### Troubleshooting

**Issue: "No network name found for chain X"**
- Verify Step 1.2: ensure `networkToNetworkName` includes your chain

**Issue: "No end block found for chain X"**
- Check that `TYPICAL_BLOCK_TIME_SEC` includes your chain ID (Step 1.5)
- Verify chain mapping in `blockTime.ts` (Step 3.3.1)
- Verify Alchemy SDK supports the chain

**Issue: "No Alchemy instance configured for chain X"**
- Verify `SUPPORTED_CHAINS` includes your chain (Step 1.1)
- Check `ALCHEMY_BASE_URLS` in constants.ts (Step 2.1)
- Verify RPC URL mapping in AlchemyService.ts (Step 3.2)

**Issue: "No RPC URL configured for network"**
- Verify Step 2.1: `ALCHEMY_BASE_URLS` includes your chain
- Verify Step 3.2: `getAlchemyRpcUrl` method includes your chain's Network enum

**Issue: Rate limit errors during indexing**
- Reduce `MAX_BATCHES` value in Step 3.1
- Check Alchemy API key limits

**Issue: "No progress cursor found for chain X"**
- Verify Step 4: ensure progress cursor was inserted into database
- Check chain_id matches exactly

**Issue: Chain not processing during backfill**
- Verify `earliestDate` in `DEPLOYMENT_INFO` is before today's date
- Check that vault addresses are not zero addresses
- Ensure `last_processed_date` in progress cursor is before `earliestDate`

**Issue: "Could not find chainId for network"**
- Verify Step 3.3.1: chain mapping in `blockTime.ts` includes your chain

### Checklist Summary

Use this checklist to ensure all steps are completed:

**Step 1: contracts.ts**
- [ ] Added chain to `SUPPORTED_CHAINS`
- [ ] Added network name mapping in `networkToNetworkName`
- [ ] Added all 4 vault addresses (xETH, xBTC, xUSD, xEUR) to `CONTRACTS`
- [ ] Added deployment info to `DEPLOYMENT_INFO.CHAIN_DEPLOYMENTS`
- [ ] Added block time to `TYPICAL_BLOCK_TIME_SEC`

**Step 2: constants.ts**
- [ ] Added Alchemy base URL to `ALCHEMY_BASE_URLS`
- [ ] Added chain ID to `CONSTANTS.CHAIN_IDS`
- [ ] Added LayerZero EID mapping (if applicable)

**Step 3: Indexer & Services**
- [ ] Added batch size to `MAX_BATCHES` in VaultIndexer.ts
- [ ] Added RPC URL mapping in AlchemyService.ts
- [ ] **Tested Alchemy blocks-by-timestamp API support**
- [ ] Added chain mapping in blockTime.ts for binary search
- [ ] (Optional) Added to `SUPPORTED_TIMESTAMP_NETWORKS` if API test passed

**Step 4: SDK Compatibility (if needed)**
- [ ] Added type assertions if chain not yet in Alchemy SDK
- [ ] Added special case handling in key functions

**Step 5: Database**
- [ ] Created database progress cursor entry

**Step 6: Integrations (if applicable)**
- [ ] Updated integration chain filter in DailySnapshotService.ts
- [ ] Added integration contracts to `INTEGRATION_CONTRACTS`

**Steps 7-9: Testing & Deployment**
- [ ] Verified Alchemy SDK support
- [ ] Tested configuration
- [ ] Deployed and monitored initial indexing
- [ ] Verified events are being captured

## API Endpoints

### Address Balance

#### GET `/api/v1/addressBalance/:address`
Returns the latest user daily snapshot for an address with optional field filtering.

**Parameters:**
- `address` (path): Ethereum address (0x...)
- `fields` (query, optional): Comma-separated list of fields to return

**Example Request:**
```bash
# Get all data
GET /api/v1/addressBalance/0x1234567890123456789012345678901234567890

# Get only total droplets
GET /api/v1/addressBalance/0x1234567890123456789012345678901234567890?fields=totalDroplets

# Get multiple specific fields
GET /api/v1/addressBalance/0x1234567890123456789012345678901234567890?fields=totalDroplets,balances,totalUsdValue
```

**Response:**
```json
{
  "address": "0x1234567890123456789012345678901234567890",
  "snapshotDate": "2024-09-22",
  "totalDroplets": "156789",
  "dailyDropletsEarned": "1250",
  "totalUsdValue": "1250.00",
  "balances": {
    "xeth": {
      "shares": "0.5",
      "usdValue": "800.00"
    },
    "xbtc": {
      "shares": "0.01", 
      "usdValue": "450.00"
    },
    "xusd": {
      "shares": "0",
      "usdValue": "0"
    },
    "xeur": {
      "shares": "0",
      "usdValue": "0"
    }
  },
  "integrationBreakdown": {
    "enclabs": "500.00",
    "euler": "300.00"
  },
  "snapshotTimestamp": "2024-09-22T00:00:00.000Z"
}
```

### Leaderboard

#### GET `/api/v1/leaderboard`
Returns leaderboard of addresses ranked by total droplets earned, including users who may have withdrawn funds but earned droplets historically.

**Query Parameters:**
- `limit` (optional): Number of results to return (default: 100, max: 1000)
- `offset` (optional): Number of results to skip (default: 0)

**Example Request:**
```bash
GET /api/v1/leaderboard?limit=50&offset=0
```

**Response:**
```json
{
  "data": [
    {
      "rank": 1,
      "address": "0x1234567890123456789012345678901234567890",
      "totalDroplets": "5678900",
      "lastActive": "2024-09-22",
      "totalUsdValue": "2500.00",
      "balances": {
        "xeth": {
          "shares": "1.5",
          "usdValue": "2000.00"
        },
        "xbtc": {
          "shares": "0.01",
          "usdValue": "500.00"
        },
        "xusd": {
          "shares": "0",
          "usdValue": "0"
        },
        "xeur": {
          "shares": "0", 
          "usdValue": "0"
        }
      },
      "integrationBreakdown": {
        "enclabs": "1000.00",
        "euler": "500.00"
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1071,
    "hasMore": true
  }
}
```

### Protocol Stats

#### GET `/api/v1/protocolStats`
Returns latest or historical daily protocol snapshots.

**Query Parameters:**
- `timestamp` (optional): ISO timestamp to get historical data (returns snapshot from day before timestamp)

**Example Requests:**
```bash
# Get latest protocol stats
GET /api/v1/protocolStats

# Get historical protocol stats (returns Sept 4th snapshot for Sept 5th timestamp)
GET /api/v1/protocolStats?timestamp=2024-09-05T12:00:00Z
```

**Response:**
```json
{
  "id": 123,
  "snapshotDate": "2024-09-22",
  "totalProtocolUsd": "157090247.50",
  "totalXethShares": "50000.0",
  "totalXethUsd": "80000000.00",
  "totalXbtcShares": "1000.0", 
  "totalXbtcUsd": "65000000.00",
  "totalXusdShares": "10000000.0",
  "totalXusdUsd": "10000000.00",
  "totalXeurShares": "2000000.0",
  "totalXeurUsd": "2090247.50",
  "totalIntegrationBreakdown": {
    "enclabs": "50000000.00",
    "euler": "30000000.00",
    "silo": "20000000.00"
  },
  "totalUsers": 1071,
  "dailyProtocolDroplets": "157090247",
  "totalProtocolDroplets": "23563786205",
  "ethUsdPrice": "2500.00",
  "btcUsdPrice": "65000.00",
  "eurUsdPrice": "1.05",
  "snapshotTimestamp": "2024-09-22T00:00:00.000Z",
  "createdAt": "2024-09-22T01:00:00.000Z"
}
```

### Health Endpoints

#### GET `/api/v1/health`
Returns comprehensive service health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-09-22T12:00:00.000Z",
  "database": "connected",
  "service": "stream-droplets-api",
  "version": "1.0.0"
}
```

#### GET `/api/v1/health/ready`
Kubernetes readiness probe endpoint.

**Response:**
```json
{
  "ready": true
}
```

#### GET `/api/v1/health/live`
Kubernetes liveness probe endpoint.

**Response:**
```json
{
  "alive": true
}
```