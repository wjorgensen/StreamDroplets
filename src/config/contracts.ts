import { parseAbi } from 'viem';

export const STREAM_VAULT_ABI = parseAbi([
  // Events
  'event Stake(address indexed account, uint256 amount, uint256 round)',
  'event Unstake(address indexed account, uint256 amount, uint256 round)',
  'event Redeem(address indexed account, uint256 share, uint256 round)',
  'event InstantUnstake(address indexed account, uint256 amount, uint256 round)',
  'event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  
  // Read functions
  'function roundPricePerShare(uint256 round) view returns (uint256)',
  'function vaultState() view returns (uint16 round, uint256 totalPending)',
  'function decimals() view returns (uint8)',
  'function cap() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function omniTotalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function shares(address account) view returns (uint256)',
  
  // LayerZero OFT events
  'event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, uint256 amountSent)',
  'event OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amountReceived)',
]);

export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export interface ContractConfig {
  ethereum: string;  // Vault address on Ethereum
  sonic: string;     // OFT address on Sonic
  base: string;      // OFT address on Base
  arbitrum: string;  // OFT address on Arbitrum
  avalanche: string; // OFT address on Avalanche
  berachain: string; // OFT address on Berachain
  oracleFeed: string;
  decimals: bigint;
  ppsScale: bigint;
}

export const CONTRACTS: Record<string, ContractConfig> = {
  xETH: {
    ethereum: process.env.XETH_VAULT_ETH || '0x0000000000000000000000000000000000000000',
    sonic: process.env.XETH_OFT_SONIC || '0x0000000000000000000000000000000000000000',
    base: process.env.XETH_OFT_BASE || '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926', // From plan.md
    arbitrum: process.env.XETH_OFT_ARB || '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce', // From plan.md
    avalanche: process.env.XETH_OFT_AVAX || '0x413bF752b33e76562dc876182141e2329716f250', // From plan.md
    berachain: process.env.XETH_OFT_BERA || '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce', // From plan.md
    oracleFeed: process.env.ETH_USD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    decimals: 18n,
    ppsScale: 18n,
  },
  xBTC: {
    ethereum: process.env.XBTC_VAULT_ETH || '0x0000000000000000000000000000000000000000',
    sonic: process.env.XBTC_OFT_SONIC || '0x0000000000000000000000000000000000000000',
    base: process.env.XBTC_OFT_BASE || '0x0000000000000000000000000000000000000000',
    arbitrum: process.env.XBTC_OFT_ARB || '0x0000000000000000000000000000000000000000',
    avalanche: process.env.XBTC_OFT_AVAX || '0x0000000000000000000000000000000000000000',
    berachain: process.env.XBTC_OFT_BERA || '0x0000000000000000000000000000000000000000',
    oracleFeed: process.env.BTC_USD_FEED || '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    decimals: 18n,
    ppsScale: 18n,
  },
  xUSD: {
    ethereum: process.env.XUSD_VAULT_ETH || '0x0000000000000000000000000000000000000000',
    sonic: process.env.XUSD_OFT_SONIC || '0x0000000000000000000000000000000000000000',
    base: process.env.XUSD_OFT_BASE || '0x0000000000000000000000000000000000000000',
    arbitrum: process.env.XUSD_OFT_ARB || '0x0000000000000000000000000000000000000000',
    avalanche: process.env.XUSD_OFT_AVAX || '0x0000000000000000000000000000000000000000',
    berachain: process.env.XUSD_OFT_BERA || '0x0000000000000000000000000000000000000000',
    oracleFeed: process.env.USDC_USD_FEED || '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    decimals: 6n,
    ppsScale: 18n,
  },
  xEUR: {
    ethereum: process.env.XEUR_VAULT_ETH || '0x0000000000000000000000000000000000000000',
    sonic: process.env.XEUR_OFT_SONIC || '0x0000000000000000000000000000000000000000',
    base: process.env.XEUR_OFT_BASE || '0x0000000000000000000000000000000000000000',
    arbitrum: process.env.XEUR_OFT_ARB || '0x0000000000000000000000000000000000000000',
    avalanche: process.env.XEUR_OFT_AVAX || '0x0000000000000000000000000000000000000000',
    berachain: process.env.XEUR_OFT_BERA || '0x0000000000000000000000000000000000000000',
    oracleFeed: process.env.EUR_USD_FEED || '0xb49f677943BC038e9857d61E7d053CaA2C1734C1',
    decimals: 18n,
    ppsScale: 18n,
  },
};

// LayerZero endpoint IDs
export const LZ_ENDPOINT_IDS = {
  ETHEREUM: 30101,
  SONIC: 30146,
  BASE: 30184,
  ARBITRUM: 30110,
  AVALANCHE: 30106,
  BERACHAIN: 30296, // Update when mainnet ID is available
};