import { parseAbi } from 'viem';

/**
 * Shadow Exchange Pair ABI for AMM liquidity pools
 * Sample Address: 0xdee813f080f9128e52e38e9ffef8b997f9544332
 */
export const SHADOW_PAIR_ABI = parseAbi([
  // Events
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',

  // Core ERC-20 Functions
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',

  // Liquidity Functions
  'function mint(address to) returns (uint256 liquidity)',
  'function burn(address to) returns (uint256 amount0, uint256 amount1)',

  // DEX Functions
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
  'function skim(address to)',
  'function sync()',

  // Pair Information
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',

  // Stable Pair Features
  'function stable() view returns (bool)',
  'function metadata() view returns (uint256 _decimals0, uint256 _decimals1, uint256 _reserve0, uint256 _reserve1, bool _stable, address _token0, address _token1)',

  // Fee Management
  'function fee() view returns (uint256)',
  'function feeRecipient() view returns (address)',
  'function feeSplit() view returns (uint256)',
  'function setFee(uint256 _fee)',
  'function setFeeRecipient(address _feeRecipient)',
  'function setFeeSplit(uint256 _feeSplit)',
  'function mintFee()',

  // Price Oracle Functions
  'function current(address tokenIn, uint256 amountIn) view returns (uint256 amountOut)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
  'function quote(address tokenIn, uint256 amountIn, uint256 granularity) view returns (uint256 amountOut)',
  'function prices(address tokenIn, uint256 amountIn, uint256 points) view returns (uint256[])',
  'function sample(address tokenIn, uint256 amountIn, uint256 points, uint256 window) view returns (uint256[])',

  // Cumulative Price Tracking
  'function currentCumulativePrices() view returns (uint256 reserve0Cumulative, uint256 reserve1Cumulative, uint256 blockTimestamp)',
  'function reserve0CumulativeLast() view returns (uint256)',
  'function reserve1CumulativeLast() view returns (uint256)',

  // Observation System
  'function lastObservation() view returns ((uint256 timestamp, uint256 reserve0Cumulative, uint256 reserve1Cumulative))',
  'function observations(uint256) view returns (uint256 timestamp, uint256 reserve0Cumulative, uint256 reserve1Cumulative)',
  'function observationLength() view returns (uint256)',

  // Constants
  'function MINIMUM_LIQUIDITY() view returns (uint256)',
  'function kLast() view returns (uint256)',

  // Initialization
  'function initialize(address _token0, address _token1, bool _stable)',
]);

/**
 * Shadow Exchange Router ABI for liquidity operations
 */
export const SHADOW_ROUTER_ABI = parseAbi([
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function pairFor(address tokenA, address tokenB, bool stable) view returns (address pair)',
  'function getReserves(address tokenA, address tokenB, bool stable) view returns (uint256 reserveA, uint256 reserveB)',
  'function quoteAddLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function quoteRemoveLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity) view returns (uint256 amountA, uint256 amountB)',
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
]);
