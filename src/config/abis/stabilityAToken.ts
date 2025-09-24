import { parseAbi } from 'viem';

/**
 * Stability aToken ABI (AAVE interest-bearing token)
 * Sample Address: 0xD56cA83ad45976b3590B53AdE167DE27b89683D8
 */
export const STABILITY_ATOKEN_ABI = parseAbi([
  // Events
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event BalanceTransfer(address indexed from, address indexed to, uint256 value, uint256 index)',
  'event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)',
  'event Initialized(address indexed underlyingAsset, address indexed pool, address treasury, address incentivesController, uint8 aTokenDecimals, string aTokenName, string aTokenSymbol, bytes params)',
  'event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',

  // Core View Functions
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address user) view returns (uint256)',

  // ERC-20 Functions
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address recipient, uint256 amount) returns (bool)',
  'function transferFrom(address sender, address recipient, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
  'function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)',

  // Scaled Balance Functions (AAVE-specific)
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function scaledTotalSupply() view returns (uint256)',
  'function getScaledUserBalanceAndSupply(address user) view returns (uint256, uint256)',
  'function getPreviousIndex(address user) view returns (uint256)',

  // Core aToken Functions
  'function mint(address caller, address onBehalfOf, uint256 amount, uint256 index) returns (bool)',
  'function burn(address from, address receiverOfUnderlying, uint256 amount, uint256 index)',
  'function mintToTreasury(uint256 amount, uint256 index)',

  // Transfer Functions
  'function transferOnLiquidation(address from, address to, uint256 value)',
  'function transferUnderlyingTo(address target, uint256 amount)',

  // Repayment Handling
  'function handleRepayment(address user, address onBehalfOf, uint256 amount)',

  // Protocol Integration
  'function POOL() view returns (address)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function RESERVE_TREASURY_ADDRESS() view returns (address)',
  'function getIncentivesController() view returns (address)',
  'function setIncentivesController(address controller)',

  // EIP-712 and Permit Functions
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function PERMIT_TYPEHASH() view returns (bytes32)',
  'function EIP712_REVISION() view returns (bytes)',
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',

  // Version and Constants
  'function ATOKEN_REVISION() view returns (uint256)',

  // Admin Functions
  'function rescueTokens(address token, address to, uint256 amount)',

  // Initialization
  'function initialize(address initializingPool, address treasury, address underlyingAsset, address incentivesController, uint8 aTokenDecimals, string aTokenName, string aTokenSymbol, bytes params)',
]);
