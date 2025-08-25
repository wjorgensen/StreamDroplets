# Stream Droplets Deployment Guide

## Railway Deployment

### Quick Deploy

1. **Connect your GitHub repository to Railway**
2. **Railway will automatically detect the configuration** from `railway.json`
3. **Set the required environment variables** (see below)
4. **Deploy!**

### Required Environment Variables

```env
# Database (Railway provides this automatically)
DATABASE_URL=postgresql://user:pass@host:port/dbname

# RPC Endpoints
ALCHEMY_ETH_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_SONIC_RPC=https://sonic-mainnet.g.alchemy.com/v2/YOUR_KEY

# API Keys for load balancing
ALCHEMY_API_KEY_1=your_first_api_key
ALCHEMY_API_KEY_2=your_second_api_key
ALCHEMY_API_KEY_3=your_third_api_key

# Optional: Backfill configuration
ETH_START_BLOCK=20000000  # Start block for Ethereum backfill
SONIC_START_BLOCK=40000000  # Start block for Sonic backfill

# Optional: Admin features
ADMIN_API_KEY=your_secure_admin_key
```

### Frontend Environment Variables

In your frontend service (if deployed separately):

```env
VITE_API_URL=https://your-api.railway.app/api/v1
```

## How It Works

### Startup Sequence

1. **Database Migration**: Automatically runs on build
2. **Backfill Check**: On first start, checks if database is empty
3. **Initial Backfill**: If empty, runs comprehensive backfill from configured start blocks
4. **Live Indexing**: Starts the indexer to continuously sync new blocks
5. **API Server**: Starts the API to serve data

### Services Running

The `deploy-startup.ts` script manages:
- **Backfill**: One-time historical data import (if needed)
- **Indexer**: Continuously syncs new blocks every 10 seconds
- **API Server**: Serves data to frontend

### Monitoring

- Health check endpoint: `GET /api/v1/health`
- Logs show:
  - Backfill progress (blocks processed, users found)
  - Indexer status (current block, new events)
  - API requests

### Performance Tuning

#### Backfill Speed
- Adjust `PARALLEL_WORKERS` in `production-backfill.ts` (default: 3)
- More workers = faster but higher API usage

#### Block Range
- Set `ETH_START_BLOCK` and `SONIC_START_BLOCK` to control history depth
- Recent blocks only: `ETH_START_BLOCK=23200000` (~1 week)
- Full history: `ETH_START_BLOCK=17000000` (token deployment)

#### Database Optimization
- Railway PostgreSQL handles most optimization automatically
- Indexes are created by migrations

### Scaling

#### Horizontal Scaling
- API can run multiple instances
- Indexer should run as single instance (or implement locking)

#### Vertical Scaling
- Increase Railway instance size if:
  - Backfill takes too long
  - API response times are slow
  - Database queries are slow

## Manual Operations

### Run backfill manually
```bash
railway run npm run backfill
```

### Check database
```bash
railway run npx tsx scripts/check-stats.ts
```

### Reset and re-sync
```bash
railway run npm run db:rollback
railway run npm run db:migrate
railway run npx tsx scripts/production-backfill.ts
```

## Troubleshooting

### Backfill is slow
- Check API rate limits
- Reduce `PARALLEL_WORKERS`
- Use more recent `START_BLOCK` values

### Missing data
- Check indexer logs for errors
- Verify RPC endpoints are working
- Check database connection

### High API usage
- Implement caching (Redis)
- Reduce polling frequency in indexer
- Use fewer parallel workers

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌──────────┐
│   Frontend  │────▶│   API    │────▶│ Database │
└─────────────┘     └──────────┘     └──────────┘
                           ▲                ▲
                           │                │
                    ┌──────────┐     ┌──────────┐
                    │ Indexer  │────▶│ Backfill │
                    └──────────┘     └──────────┘
                           ▲                ▲
                           │                │
                    ┌──────────────────────────┐
                    │   Blockchain RPCs        │
                    │  (Ethereum & Sonic)      │
                    └──────────────────────────┘
```

## Production Checklist

- [ ] Set all required environment variables
- [ ] Configure appropriate `START_BLOCK` values
- [ ] Test health endpoint after deployment
- [ ] Monitor initial backfill progress
- [ ] Verify indexer is syncing new blocks
- [ ] Check frontend can connect to API
- [ ] Set up monitoring/alerts (optional)
- [ ] Configure custom domain (optional)