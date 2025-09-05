-- Update droplets_cache table for new USD-based architecture

-- First, drop the existing table
DROP TABLE IF EXISTS droplets_cache CASCADE;

-- Create new droplets_cache table aligned with USD-based architecture
CREATE TABLE droplets_cache (
  id SERIAL PRIMARY KEY,
  user_address VARCHAR(42) NOT NULL,
  amount NUMERIC(78,0) NOT NULL,
  snapshot_date DATE NOT NULL,
  awarded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  UNIQUE(user_address, snapshot_date)
);

-- Create indexes for performance
CREATE INDEX idx_droplets_cache_user ON droplets_cache(user_address);
CREATE INDEX idx_droplets_cache_date ON droplets_cache(snapshot_date);
CREATE INDEX idx_droplets_cache_awarded ON droplets_cache(awarded_at);

-- Create user_usd_snapshots table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_usd_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  user_address VARCHAR(42) NOT NULL,
  total_usd_value NUMERIC(20, 2) NOT NULL,
  chain_breakdown JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(snapshot_date, user_address)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_usd_snapshots_user ON user_usd_snapshots(user_address);
CREATE INDEX IF NOT EXISTS idx_usd_snapshots_date ON user_usd_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_usd_snapshots_value ON user_usd_snapshots(total_usd_value DESC);