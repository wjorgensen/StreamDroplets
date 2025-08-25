# Railway Environment Variables Guide

## Required Variables

For Railway deployment, you need ONLY these environment variables:

### Database
```env
# Use Railway's PostgreSQL public URL (NOT the internal URL during build)
DATABASE_URL=postgresql://user:pass@host.railway.app:port/dbname
```

**Important**: Do NOT set these if you have DATABASE_URL:
- ❌ DB_HOST
- ❌ DB_PORT  
- ❌ DB_NAME
- ❌ DB_USER
- ❌ DB_PASSWORD

Having both DATABASE_URL and individual DB_* variables will cause conflicts!

### RPC Endpoints (Required)
```env
ALCHEMY_ETH_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_SONIC_RPC=https://sonic-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### API Keys for Load Balancing (At least one required)
```env
ALCHEMY_API_KEY_1=your_first_api_key
ALCHEMY_API_KEY_2=your_second_api_key  # Optional
ALCHEMY_API_KEY_3=your_third_api_key   # Optional
```

### Optional Configuration
```env
# Backfill start blocks (defaults shown)
ETH_START_BLOCK=20000000    # ~6 months of history
SONIC_START_BLOCK=40000000  # Reasonable Sonic start

# Admin API
ADMIN_API_KEY=your_secure_admin_key

# Node environment
NODE_ENV=production
```

## Railway-Specific Notes

1. **Database URL**: Railway provides the DATABASE_URL automatically when you provision PostgreSQL. Use the **public URL** format, not the internal one.

2. **Internal URLs**: The `*.railway.internal` URLs only work for service-to-service communication at runtime, NOT during build/migration.

3. **Port**: Railway automatically sets the PORT variable. Don't override it.

4. **SSL**: Railway's PostgreSQL requires SSL connections. The app automatically handles this when it detects Railway environment.

## Troubleshooting

If database connection fails:
1. Check you're using the public DATABASE_URL (ends with `.railway.app`)
2. Remove any DB_HOST, DB_PORT, etc. variables
3. Check deploy logs for connection details
4. Run `npm run test:db` as a Railway command to debug