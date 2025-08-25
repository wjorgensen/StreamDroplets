# Stream Droplets Points Tracker

A deterministic, auditable points tracking system for Stream Protocol vaults using round-based accounting with USD-denominated rewards across Ethereum and Sonic chains.

## Overview

The Stream Droplets tracker indexes vault activity, calculates points ("droplets") based on USD exposure, and provides a REST API for querying balances and leaderboards. The system uses a round-based approach where users earn points for holding shares at round start, with exclusions for withdrawal rounds.

### Key Features

- **Round-based accounting**: No per-second calculations, snapshots at round boundaries
- **USD-denominated fairness**: All assets (xETH, xBTC, xUSD, xEUR) earn at the same rate per dollar
- **Transfer neutrality**: Mid-round transfers don't affect current round earnings
- **Deterministic calculations**: Recomputing from genesis produces identical results
- **Multi-chain support**: Indexes Ethereum and Sonic with bridge correlation
- **Chainlink oracle integration**: USD prices fetched at round boundaries

## Architecture

### Core Components

1. **Event Indexer**: Monitors vault contracts and classifies events
2. **Balance Tracker**: Maintains user balances and creates snapshots
3. **Oracle Service**: Fetches Chainlink prices at round boundaries
4. **Accrual Engine**: Calculates droplets using round-based logic
5. **REST API**: Provides endpoints for points, leaderboards, and audit trails

### Earning Logic

Users earn droplets for round `r` if and only if:
- They held shares at `round_start_timestamp`
- They did NOT unstake to assets during round `r`

Formula: `droplets = shares × PPS × USD_price × rate_per_round`

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Docker & Docker Compose (optional)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd StreamDroplets
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment configuration:
```bash
cp .env.example .env
```

4. Update `.env` with your configuration:
- Add Alchemy RPC URLs for Ethereum and Sonic
- Add vault contract addresses
- Set admin API key

### Using Docker

Start all services with Docker Compose:

```bash
docker-compose up -d
```

This starts PostgreSQL and the application in containers.

### Manual Setup

1. Start PostgreSQL:
```bash
# MacOS
brew services start postgresql

# Linux
sudo systemctl start postgresql
```

2. Create database:
```bash
createdb stream_droplets
```

3. Run migrations:
```bash
npm run db:migrate
```

4. Start the application:
```bash
npm run dev
```

## API Endpoints

### Points

- `GET /points/:address` - Get total droplets and breakdown by asset
- `GET /points/:address/:asset` - Get droplets for specific asset

### Leaderboard

- `GET /leaderboard?limit=100` - Get top addresses by droplets

### Events

- `GET /events/:address` - Get event history for an address
- `GET /events/:address/summary` - Get event summary

### Rounds

- `GET /rounds/:asset` - Get round history with PPS and oracle prices
- `GET /rounds/:asset/current` - Get current round info

### Health

- `GET /health` - Service health status
- `GET /health/ready` - Readiness check
- `GET /health/live` - Liveness check

### Admin (Protected)

- `POST /admin/config` - Update configuration
- `POST /admin/recalculate` - Trigger full recalculation
- `POST /admin/backfill` - Start historical backfill
- `GET /admin/stats` - System statistics

## Scripts

### Backfill Historical Data

```bash
npm run backfill -- --asset xETH --from 19000000 --recalculate
```

Options:
- `--asset <xETH|xBTC|xUSD|xEUR>` - Specific asset to backfill
- `--from <block>` - Starting block number
- `--to <block>` - Ending block number
- `--chain <1|146>` - Specific chain (1=Ethereum, 146=Sonic)
- `--recalculate` - Recalculate all droplets after backfill

### Validate System

```bash
npm run validate
```

Runs validation checks:
- Database connectivity
- Table existence
- Oracle price availability
- Round continuity
- Balance consistency
- Droplets determinism

## Configuration

### Environment Variables

Key configuration in `.env`:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=stream_droplets

# RPC Endpoints
ALCHEMY_ETH_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_SONIC_RPC=https://sonic-mainnet.g.alchemy.com/v2/YOUR_KEY

# Droplets Rate
RATE_PER_USD_PER_ROUND=1000000000000000000  # 1e18

# Contract Addresses
XETH_VAULT_ETH=0x...
XETH_VAULT_SONIC=0x...

# Chainlink Oracles
ETH_USD_FEED=0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
BTC_USD_FEED=0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c
USDC_USD_FEED=0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6
```

## Database Schema

Key tables:
- `rounds` - Round data with PPS from vault
- `share_events` - All vault events with classification
- `balance_snapshots` - User balances at round start
- `oracle_prices` - Chainlink prices at round boundaries
- `droplets_cache` - Cached droplets calculations
- `bridge_events` - Cross-chain bridge correlation

## Development

### Project Structure

```
src/
├── indexer/          # Event indexing and classification
├── accrual/          # Droplets calculation engine
├── oracle/           # Chainlink price service
├── api/              # REST API routes
├── db/               # Database migrations and models
├── config/           # Configuration and constants
├── types/            # TypeScript type definitions
└── utils/            # Utilities and logging
```

### Running Tests

```bash
npm test                 # Run all tests
npm run test:watch      # Watch mode
```

### Type Checking

```bash
npm run typecheck       # Check TypeScript types
```

### Linting

```bash
npm run lint           # Run ESLint
```

## Deployment

### Production Build

```bash
npm run build
```

### Docker Deployment

Build and run with Docker:

```bash
docker build -t stream-droplets .
docker run -p 3000:3000 --env-file .env stream-droplets
```

### Environment Considerations

- Use separate database for production
- Configure appropriate RPC rate limits
- Set up monitoring and alerting
- Use secrets management for API keys
- Configure log aggregation

## Monitoring

### Metrics

The system exposes metrics for:
- Indexer lag (blocks behind)
- Events processed per second
- API response times
- Database query performance
- Oracle price staleness

### Health Checks

- `/health` - Overall system health
- `/health/ready` - Ready to serve requests
- `/health/live` - Process is alive

## Troubleshooting

### Common Issues

1. **Database connection errors**
   - Check PostgreSQL is running
   - Verify connection credentials
   - Ensure database exists

2. **RPC rate limiting**
   - Reduce batch size in config
   - Increase poll interval
   - Use multiple RPC endpoints

3. **Missing oracle prices**
   - Check Chainlink feed addresses
   - Verify RPC connection to Ethereum
   - Run price validation script

4. **Indexer lag**
   - Check RPC performance
   - Increase batch size if possible
   - Monitor database performance

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.