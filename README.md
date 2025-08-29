# Stream Droplets Tracker

## Overview

Stream Droplets is a reward system where users earn points (droplets) for providing liquidity to StreamVault contracts. The system:
- Tracks all stake, unstake, and redeem events across multiple chains
- Calculates USD value of positions using Chainlink price oracles
- Awards droplets at a rate of **1 droplet per $1 USD exposure per round**
- Excludes users who unstake during a round to prevent gaming
- Provides real-time APIs for querying droplet balances and leaderboards

## System Architecture

### Core Components

1. **Indexer Service** - Real-time blockchain event monitoring with automatic failover
2. **Accrual Engine** - Droplet calculation based on USD exposure
3. **API Server** - RESTful endpoints for data access
4. **Backfill Service** - Historical data reconstruction
5. **Database Layer** - PostgreSQL for persistent storage

### How Droplets Are Calculated

Each round (24 hours), users earn droplets based on their USD exposure:

1. **Share Calculation**: System tracks shares held at round start
2. **Unstaking Check**: Users who unstake during a round are excluded (bridge mitigation)
3. **USD Conversion**: Shares converted to USD using Chainlink price feeds
4. **Droplet Award**: 1 droplet per $1 USD per round
5. **Result Caching**: Calculations cached for performance

### Bridge Mitigation

To prevent exploitation through bridging:
- Users who perform ANY unstaking action during a round receive 0 droplets for that round
- This includes partial unstakes, instant unstakes, and redemptions
- Ensures users maintain consistent exposure throughout the round

## API Endpoints

### Public Endpoints

#### GET `/api/v1/points/:address`
Get droplet balance for an address
```json
{
  "address": "0x...",
  "total_droplets": "1234.56",
  "rounds_participated": 10,
  "last_updated": "2024-01-15T12:00:00Z"
}
```

#### GET `/api/v1/leaderboard`
Top addresses by droplet count
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "address": "0x...",
      "total_droplets": "5678.90",
      "rounds_participated": 15
    }
  ],
  "total_participants": 1234
}
```

#### GET `/api/v1/health`
System health status
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2024-01-15T12:00:00Z",
  "service": "stream-droplets-api",
  "version": "1.0.0"
}
```

#### GET `/api/v1/health/ready`
Readiness probe (for Kubernetes/Docker)
```json
{
  "ready": true
}
```

#### GET `/api/v1/health/live`
Liveness probe (for Kubernetes/Docker)
```json
{
  "alive": true
}
```

## Setup Instructions

### Prerequisites

- Node.js 18+ 
- PostgreSQL 14+
- Alchemy API keys for Ethereum and Sonic chains

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd stream-droplets
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment variables:
```bash
cp .env.example .env
```

4. Configure your `.env` file with:
   - Database credentials
   - Alchemy API keys (at least one, preferably three for load balancing)
   - Admin API key for protected endpoints

5. Build the project:
```bash
npm run build
```

6. Run database migrations:
```bash
npm run db:migrate
```

### Running the System

#### Development Mode
```bash
# Run API server and indexer together
npm run dev

# Or run components separately:
npm run dev:api      # API server only
npm run dev:indexer  # Indexer only
```

#### Production Mode
```bash
# Build first
npm run build

# Run combined server
npm start
```

### CLI Commands

The system includes a CLI for management tasks:

```bash
# Run indexer
npx stream-droplets indexer start

# Check indexer status
npx stream-droplets indexer status

# Run historical backfill
npx stream-droplets backfill run --chain ethereum --from-block 17000000

# Calculate droplets for specific address
npx stream-droplets droplets calculate 0x...

# Run database migrations
npx stream-droplets db migrate
```

## Configuration

### Environment Variables

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=stream_droplets
DB_USER=your_db_user
DB_PASSWORD=your_db_password

# RPC Endpoints - Primary
ALCHEMY_API_KEY_1=your_primary_key
# Additional keys for load balancing
ALCHEMY_API_KEY_2=your_second_key
ALCHEMY_API_KEY_3=your_third_key

# API Configuration
API_PORT=3000
API_HOST=0.0.0.0
API_RATE_LIMIT=100

# Indexer Configuration
INDEXER_BATCH_SIZE=100
INDEXER_POLL_INTERVAL=10000
ETH_CONFIRMATIONS=12
SONIC_CONFIRMATIONS=32

# Droplets Configuration
RATE_PER_USD_PER_ROUND=1  # 1 droplet per dollar per round

# Logging
LOG_LEVEL=info
LOG_PRETTY=true
```

### Supported Vaults

**Ethereum Mainnet:**
- xETH Vault: `0x7E586fBaF3084C0be7aB5C82C04FfD7592723153`
- xBTC Vault: `0x12fd502e2052CaFB41eccC5B596023d9978057d6`
- xUSD Vault: `0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94`
- xEUR Vault: `0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13`

**Sonic Chain:**
- xETH Vault: `0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6`
- xBTC Vault: `0xB88fF15ae5f82c791e637b27337909BcF8065270`
- xUSD Vault: `0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926`
- xEUR Vault: `0x931383c1bCA6a41E931f2519BAe8D716857F156c`

## Database Schema

The system uses PostgreSQL with the following main tables:

- **share_events**: All vault interaction events
- **rounds**: Round definitions with price-per-share data
- **balance_snapshots**: User balances at round boundaries
- **droplets_cache**: Cached droplet calculations
- **excluded_addresses**: System and vault addresses excluded from rewards
- **current_balances**: Real-time share balances per user

## Production Features

### Reliability
- Multi-RPC endpoint failover with automatic switching
- Exponential backoff retry logic for transient failures
- Automatic indexer restart on critical errors
- Database transactions for atomic updates

### Performance
- Batch processing with configurable sizes
- Parallel event fetching across chains
- Droplet calculation caching per round
- Connection pooling for database efficiency

### Monitoring
- Health check endpoints
- Real-time indexing progress tracking
- Error rate monitoring
- Event emission for external monitoring systems

## Security

- Input validation using Zod schemas
- Parameterized SQL queries to prevent injection
- Rate limiting on all API endpoints
- Ethereum address format validation
- Admin endpoints protected by API key
- No sensitive data in error responses

## Troubleshooting

### Common Issues

1. **Database Connection Failed**
   - Verify PostgreSQL is running
   - Check database credentials in `.env`
   - Ensure database exists: `createdb stream_droplets`

2. **RPC Rate Limiting**
   - Add multiple Alchemy API keys for load balancing
   - Adjust `INDEXER_BATCH_SIZE` and `INDEXER_POLL_INTERVAL`

3. **Missing Historical Data**
   - Run backfill: `npx stream-droplets backfill run`
   - Check starting block numbers in chain config

4. **Droplet Calculation Issues**
   - Verify Chainlink oracle addresses are correct
   - Check rounds table has price data
   - Run admin recalculation endpoint

## Development

### Project Structure
```
src/
├── api/           # API server and routes
├── accrual/       # Droplet calculation engine
├── cli/           # Command-line interface
├── config/        # Configuration and constants
├── db/            # Database models and migrations
├── indexer/       # Blockchain event indexing
├── services/      # Core business logic
├── types/         # TypeScript type definitions
└── utils/         # Utility functions
```

## License

This project is proprietary software for Stream Protocol.

## Support

For technical support or questions about the Stream Droplets system, please contact the Stream Protocol team.