import { AssetType, ChainId, EventClassification } from '../config/constants';

export interface Round {
  id?: number;
  round_id: number;
  asset: AssetType;
  chain_id: ChainId;
  start_block: bigint;
  start_ts: Date;
  end_ts?: Date;
  pps: string; // Stored as string for precision
  pps_scale: number;
  tx_hash: string;
}

export interface ShareEvent {
  id?: number;
  chain_id: ChainId;
  address: string;
  event_type: string;
  shares_delta: string;
  block: bigint;
  timestamp: Date;
  tx_hash: string;
  log_index: number;
  round_id?: number;
  event_classification: EventClassification;
  asset: AssetType;
}

export interface BalanceSnapshot {
  id?: number;
  address: string;
  asset: AssetType;
  round_id: number;
  shares_at_start: string;
  had_unstake_in_round: boolean;
  had_transfer_in_round: boolean;
  had_bridge_in_round: boolean;
}

export interface OraclePrice {
  id?: number;
  asset: AssetType;
  round_id: number;
  price_usd: string;
  oracle_block: bigint;
  oracle_timestamp: Date;
  chainlink_round_id?: string;
}

export interface DropletsCache {
  id?: number;
  address: string;
  asset: AssetType;
  last_round_calculated: number;
  droplets_total: string;
  updated_at?: Date;
}

export interface BridgeEvent {
  id?: number;
  src_chain: ChainId;
  dst_chain: ChainId;
  burn_tx: string;
  mint_tx?: string;
  address: string;
  shares: string;
  burn_timestamp: Date;
  mint_timestamp?: Date;
  status: 'pending' | 'completed' | 'failed';
  asset: AssetType;
}

export interface Cursor {
  id?: number;
  chain_id: ChainId;
  contract_address: string;
  last_safe_block: bigint;
  last_tx_hash?: string;
  last_log_index?: number;
  updated_at?: Date;
}

export interface CurrentBalance {
  id?: number;
  address: string;
  asset: AssetType;
  chain_id: ChainId;
  shares: string;
  last_update_block: bigint;
  updated_at?: Date;
}

export interface ConfigItem {
  id?: number;
  key: string;
  value: string;
  updated_at?: Date;
}

export interface DropletsResult {
  address: string;
  droplets: string;
  lastUpdated: Date;
  breakdown?: {
    [key in AssetType]?: string;
  };
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  droplets: string;
}