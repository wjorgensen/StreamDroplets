# Stream Droplets Tracker

## Overview

Stream Droplets is a multi-chain liquidity rewards system that tracks USD value across Stream Protocol vaults and cross-chain deployments. The system:

- **Multi-chain Support**: Ethereum mainnet vaults + 5 cross-chain deployments (Sonic, Base, Arbitrum, Avalanche, Berachain)
- **Unified USD Tracking**: Calculates single USD value per user across all chains
- **Daily Accumulation**: Awards 1 droplet per $1 USD exposure per 24-hour period
- **Integration Exclusion**: Automatically excludes integration contracts and custody addresses
- **Real-time APIs**: RESTful endpoints for querying balances and leaderboards

## System Architecture

### Core Components

1. **Multi-Chain Indexer** - Monitors events across 6 blockchains simultaneously
2. **Unified Balance Service** - Aggregates USD value across all chains and assets
3. **Accrual Engine** - Daily droplet calculation based on total USD exposure
4. **Oracle Service** - Price feeds for accurate USD conversion
5. **API Server** - RESTful endpoints for data access
6. **PostgreSQL Database** - Persistent storage with optimized schema

### Supported Chains & Assets

**Ethereum Mainnet (Chain 1)**
- Vault shares: xETH, xBTC, xUSD, xEUR
- Users hold shares, not tokens directly

**Cross-Chain Deployments**
- Sonic (Chain 146)
- Base (Chain 8453)
- Arbitrum (Chain 42161)
- Avalanche (Chain 43114)
- Berachain (Chain 81457)
- OFT tokens: streamETH, streamBTC, streamUSD, streamEUR

### How Droplets Are Calculated

1. **Balance Aggregation**: System tracks vault shares (ETH) and token balances (other chains)
2. **USD Conversion**: All positions converted to USD using oracle prices
3. **Daily Snapshots**: Taken every 24 hours at consistent times
4. **Droplet Award**: 1 droplet per $1 USD exposure per day
5. **Accumulation**: Droplets accumulate daily (TVL × days invested)

### Integration Contract Handling

The system automatically excludes:
- Vault contract addresses themselves
- Integration pool contracts (Velodrome, Aerodrome, etc.)
- System addresses and custody contracts
- Any address in the `excluded_addresses` table

## Docker Deployment

### Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd stream-droplets

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Build and run with Docker Compose
docker-compose up -d

# Check logs
docker-compose logs -f app

# Verify API is running
curl http://localhost:3000/api/v1/health
```

### Docker Features

- **Auto-initialization**: Database setup and migrations on first run
- **Idempotent Backfill**: Checks existing data to avoid duplicates
- **Health Checks**: Built-in liveness and readiness probes
- **Auto-restart**: Recovers from failures automatically
- **Volume Persistence**: Database data persists across container restarts

## API Endpoints

### Public Endpoints

#### GET `/api/v1/points/:address`
Get total droplets for an address across all chains
```json
{
  "address": "0x...",
  "total_droplets": "156789",
  "breakdown": {
    "ethereum": "50000",
    "sonic": "35000",
    "base": "30000",
    "arbitrum": "20000",
    "avalanche": "15000",
    "berachain": "6789"
  },
  "last_updated": "2025-01-15T12:00:00Z"
}
```

#### GET `/api/v1/leaderboard`
Top addresses by total droplets earned
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "address": "0x...",
      "total_droplets": "5678900",
      "days_active": 150,
      "avg_daily": "37859"
    }
  ],
  "total_participants": 1071,
  "total_droplets_awarded": "234567890"
}
```

#### GET `/api/v1/tvl`
Current total value locked across all chains
```json
{
  "total_tvl": "157090247",
  "breakdown": {
    "ethereum": "107090247",
    "sonic": "15000000",
    "base": "12000000",
    "arbitrum": "10000000",
    "avalanche": "8000000",
    "berachain": "5000000"
  },
  "last_updated": "2025-01-15T12:00:00Z"
}
```

### Health Endpoints

#### GET `/api/v1/health`
Comprehensive health status
```json
{
  "status": "healthy",
  "database": "connected",
  "chains_synced": 6,
  "last_snapshot": "2025-01-15T00:00:00Z",
  "version": "1.0.0"
}
```

#### GET `/api/v1/health/ready`
Kubernetes readiness probe

#### GET `/api/v1/health/live`
Kubernetes liveness probe

## Configuration

### Environment Variables

```env
# Database Configuration
DB_HOST=postgres
DB_PORT=5432
DB_NAME=stream_droplets
DB_USER=stream
DB_PASSWORD=your_secure_password

# RPC Endpoints - Alchemy API Keys
ALCHEMY_API_KEY_1=your_primary_key
ALCHEMY_API_KEY_2=your_secondary_key
ALCHEMY_API_KEY_3=your_tertiary_key

# Chain RPC Base URLs
ALCHEMY_ETH_BASE_URL=https://eth-mainnet.g.alchemy.com/v2/
ALCHEMY_SONIC_BASE_URL=https://sonic-mainnet.g.alchemy.com/v2/
ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/
ALCHEMY_ARB_URL=https://arb-mainnet.g.alchemy.com/v2/
ALCHEMY_AVAX_URL=https://avax-mainnet.g.alchemy.com/v2/
ALCHEMY_BERA_RPC=https://berachain-mainnet.g.alchemy.com/v2/

# API Configuration
API_PORT=3000
API_HOST=0.0.0.0

# Droplets Configuration  
RATE_PER_USD_PER_ROUND=1

# Contract Addresses
# See .env.example for full list of vault and OFT addresses
```

## Database Schema

### Core Tables

- **chain_share_balances**: Current balances per user per chain per asset
- **user_usd_snapshots**: Daily USD value snapshots per user
- **droplets_cache**: Accumulated droplets per user per day
- **excluded_addresses**: Integration and system addresses to exclude
- **events**: Raw blockchain events for audit trail

## Production Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:14-alpine
    environment:
      POSTGRES_DB: stream_droplets
      POSTGRES_USER: stream
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    
  app:
    build: .
    depends_on:
      - postgres
    environment:
      - DB_HOST=postgres
    env_file:
      - .env
    ports:
      - "3000:3000"
    restart: unless-stopped

volumes:
  postgres_data:
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stream-droplets
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: app
        image: stream-droplets:latest
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /api/v1/health/live
            port: 3000
        readinessProbe:
          httpGet:
            path: /api/v1/health/ready
            port: 3000
```

## Monitoring & Maintenance

### Key Metrics to Monitor

- **TVL Tracking**: Should match dashboard ($157M+)
- **User Count**: Currently ~1,071 active users
- **Daily Droplets**: Should equal TVL (1:1 ratio)
- **Chain Sync Status**: All 6 chains should stay synchronized
- **Excluded Addresses**: 13 integration contracts excluded

### Maintenance Commands

```bash
# Check system status
docker-compose exec app npm run status

# Trigger manual snapshot
docker-compose exec app npm run snapshot

# Recalculate historical droplets
docker-compose exec app npm run recalculate --from 2024-02-19

# Check database integrity
docker-compose exec app npm run verify
```

## Architecture Details

### Balance Types

**Ethereum Mainnet**
- Users hold vault shares (not tokens)
- Shares represent underlying asset value
- Conversion: shares × price = USD value

**Other Chains**
- Users hold actual OFT tokens
- Direct token balances tracked
- Conversion: tokens × price = USD value

### Decimal Precision

Different assets use different decimal places:
- ETH/streamETH: 18 decimals
- BTC/streamBTC: 8 decimals
- USD: 8 decimals (Ethereum), 6 decimals (other chains)
- EUR/streamEUR: 6 decimals

### Historical Data

- First xETH vault deployment: Block 21872213
- First stake event: Block 21872273
- Backfill starts: February 19, 2024
- Daily snapshots: Continuous from start date

## Troubleshooting

### Common Issues

1. **TVL Mismatch**
   - Verify all chains are being indexed
   - Check decimal conversions for each asset
   - Ensure oracle prices are updating

2. **Missing Users**
   - Check if address is in excluded_addresses
   - Verify chain_share_balances has entries
   - Ensure all chains are synced

3. **Droplet Calculation Issues**
   - Verify daily snapshots are running
   - Check USD conversion logic
   - Ensure 1:1 ratio (1 droplet per $1 per day)

4. **Container Startup Issues**
   - Check database connection
   - Verify all environment variables set
   - Review container logs

## Support

For technical support or questions, contact the Stream Protocol team.

## License

Proprietary - Stream Protocol © 2024-2025