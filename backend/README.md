# Stream Droplets Backend

This is the backend service for Stream Droplets tracking system.

## Deployment on Railway

1. Set the root directory to `/backend` in Railway settings
2. Railway will automatically use the `nixpacks.toml` and `railway.json` configuration
3. Required environment variables:
   - `DATABASE_URL` - PostgreSQL connection string (provided by Railway)
   - `ALCHEMY_ETH_RPC` - Ethereum RPC endpoint
   - `ALCHEMY_SONIC_RPC` - Sonic RPC endpoint
   - `ALCHEMY_API_KEY_1` - At least one API key

## Local Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
npm run start:prod
```