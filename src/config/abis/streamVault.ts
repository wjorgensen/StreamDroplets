import { parseAbi } from 'viem';

/**
 * Stream Vault ABI containing vault-specific events and functions
 * Includes staking, unstaking, redemption, and core vault functionality
 */
export const STREAM_VAULT_ABI = parseAbi([
  // Vault Events
  'event Stake(address indexed account, uint256 amount, uint256 round)',
  'event Unstake(address indexed account, uint256 amount, uint256 round)',
  'event Redeem(address indexed account, uint256 share, uint256 round)',
  'event InstantUnstake(address indexed account, uint256 amount, uint256 round)',
  'event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  
  // OFT Events (LayerZero cross-chain functionality)
  'event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  
  // Core Vault Functions
  'function roundPricePerShare(uint256 round) view returns (uint256)',
  'function vaultState() view returns (uint16 round, uint256 totalPending)',
  'function round() public view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function cap() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function omniTotalSupply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function shares(address account) view returns (uint256)',
  
  // Vault Operations
  'function stake(uint104 amount, address creditor)',
  'function unstake(uint256 numShares, uint256 minAmountOut)',
  'function redeem(uint256 numShares)',
  'function instantUnstake(uint104 amount)',
  'function depositAndStake(uint104 amount, address creditor)',
  'function depositETHAndStake(address creditor) payable',
  'function instantUnstakeAndWithdraw(uint104 amount)',
  'function unstakeAndWithdraw(uint256 numShares, uint256 minAmountOut)',
  'function maxRedeem()',
  
  // Vault State and Configuration
  'function accountVaultBalance(address account) view returns (uint256)',
  'function shareBalancesHeldByAccount(address account) view returns (uint256)',
  'function shareBalancesHeldByVault(address account) view returns (uint256)',
  'function totalPending() view returns (uint256)',
  'function stakeReceipts(address) view returns (uint16 round, uint104 amount, uint128 unredeemedShares)',
  'function vaultParams() view returns (uint8 decimals, uint56 minimumSupply, uint104 cap)',
  
  // Token Management
  'function stableWrapper() view returns (address)',
  'function token() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  
  // ERC20 Functions
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  
  // Owner Functions
  'function rollToNextRound(uint256 yield, bool isYieldPositive)',
  'function setVaultParams((uint8 decimals, uint56 minimumSupply, uint104 cap) newVaultParams)',
  'function setStableWrapper(address newStableWrapper)',
  'function rescueETH(uint256 amount)',
  'function rescueTokens(address _token, uint256 amount)',
]);
