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