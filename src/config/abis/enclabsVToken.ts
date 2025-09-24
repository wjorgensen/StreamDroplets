import { parseAbi } from 'viem';

/**
 * Enclabs VToken ABI (Compound-style lending token)
 * Sample Address: 0x13d79435F306D155CA2b9Af77234c84f80506045
 */
export const ENCLABS_VTOKEN_ABI = parseAbi([
  // Events
  'event AccrueInterest(uint256 cashPrior, uint256 interestAccumulated, uint256 borrowIndex, uint256 totalBorrows)',
  'event Approval(address indexed owner, address indexed spender, uint256 amount)',
  'event BadDebtIncreased(address indexed borrower, uint256 badDebtDelta, uint256 badDebtOld, uint256 badDebtNew)',
  'event BadDebtRecovered(uint256 badDebtOld, uint256 badDebtNew)',
  'event Borrow(address indexed borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)',
  'event HealBorrow(address indexed payer, address indexed borrower, uint256 repayAmount)',
  'event Initialized(uint8 version)',
  'event LiquidateBorrow(address indexed liquidator, address indexed borrower, uint256 repayAmount, address indexed vTokenCollateral, uint256 seizeTokens)',
  'event Mint(address indexed minter, uint256 mintAmount, uint256 mintTokens, uint256 accountBalance)',
  'event NewAccessControlManager(address oldAccessControlManager, address newAccessControlManager)',
  'event NewComptroller(address indexed oldComptroller, address indexed newComptroller)',
  'event NewMarketInterestRateModel(address indexed oldInterestRateModel, address indexed newInterestRateModel)',
  'event NewProtocolSeizeShare(uint256 oldProtocolSeizeShareMantissa, uint256 newProtocolSeizeShareMantissa)',
  'event NewProtocolShareReserve(address indexed oldProtocolShareReserve, address indexed newProtocolShareReserve)',
  'event NewReduceReservesBlockDelta(uint256 oldReduceReservesBlockOrTimestampDelta, uint256 newReduceReservesBlockOrTimestampDelta)',
  'event NewReserveFactor(uint256 oldReserveFactorMantissa, uint256 newReserveFactorMantissa)',
  'event NewShortfallContract(address indexed oldShortfall, address indexed newShortfall)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event ProtocolSeize(address indexed from, address indexed to, uint256 amount)',
  'event Redeem(address indexed redeemer, uint256 redeemAmount, uint256 redeemTokens, uint256 accountBalance)',
  'event RepayBorrow(address indexed payer, address indexed borrower, uint256 repayAmount, uint256 accountBorrows, uint256 totalBorrows)',
  'event ReservesAdded(address indexed benefactor, uint256 addAmount, uint256 newTotalReserves)',
  'event SpreadReservesReduced(address indexed protocolShareReserve, uint256 reduceAmount, uint256 newTotalReserves)',
  'event SweepToken(address indexed token)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',

  // Core View Functions
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function underlying() view returns (address)',

  // ERC-20 Functions
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address dst, uint256 amount) returns (bool)',
  'function transferFrom(address src, address dst, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
  'function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)',

  // VToken Core Functions
  'function exchangeRateStored() view returns (uint256)',
  'function exchangeRateCurrent() returns (uint256)',
  'function getCash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalBorrowsCurrent() returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function borrowIndex() view returns (uint256)',
  'function accrualBlockNumber() view returns (uint256)',

  // Supply/Withdraw Functions
  'function mint(uint256 mintAmount) returns (uint256)',
  'function mintBehalf(address minter, uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'function redeemBehalf(address redeemer, uint256 redeemTokens) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
  'function redeemUnderlyingBehalf(address redeemer, uint256 redeemAmount) returns (uint256)',

  // Borrow/Repay Functions
  'function borrow(uint256 borrowAmount) returns (uint256)',
  'function borrowBehalf(address borrower, uint256 borrowAmount) returns (uint256)',
  'function repayBorrow(uint256 repayAmount) returns (uint256)',
  'function repayBorrowBehalf(address borrower, uint256 repayAmount) returns (uint256)',

  // Account Information
  'function balanceOfUnderlying(address owner) returns (uint256)',
  'function borrowBalanceCurrent(address account) returns (uint256)',
  'function borrowBalanceStored(address account) view returns (uint256)',
  'function getAccountSnapshot(address account) view returns (uint256 errorCode, uint256 vTokenBalance, uint256 borrowBalance, uint256 exchangeRate)',

  // Interest Rate Functions
  'function borrowRatePerBlock() view returns (uint256)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function accrueInterest() returns (uint256)',

  // Liquidation Functions
  'function liquidateBorrow(address borrower, uint256 repayAmount, address vTokenCollateral) returns (uint256)',
  'function forceLiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, address vTokenCollateral, bool skipLiquidityCheck)',
  'function healBorrow(address payer, address borrower, uint256 repayAmount)',
  'function seize(address liquidator, address borrower, uint256 seizeTokens)',

  // Admin Functions
  'function setInterestRateModel(address newInterestRateModel)',
  'function setReserveFactor(uint256 newReserveFactorMantissa)',
  'function addReserves(uint256 addAmount)',
  'function reduceReserves(uint256 reduceAmount)',
  'function setProtocolSeizeShare(uint256 newProtocolSeizeShareMantissa_)',
  'function setProtocolShareReserve(address protocolShareReserve_)',
  'function setReduceReservesBlockDelta(uint256 _newReduceReservesBlockOrTimestampDelta)',

  // Configuration View Functions
  'function interestRateModel() view returns (address)',
  'function comptroller() view returns (address)',
  'function reserveFactorMantissa() view returns (uint256)',
  'function protocolSeizeShareMantissa() view returns (uint256)',
  'function protocolShareReserve() view returns (address)',
  'function reduceReservesBlockDelta() view returns (uint256)',
  'function reduceReservesBlockNumber() view returns (uint256)',
  'function shortfall() view returns (address)',

  // Access Control and Ownership
  'function accessControlManager() view returns (address)',
  'function setAccessControlManager(address accessControlManager_)',
  'function setShortfallContract(address shortfall_)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'function renounceOwnership()',

  // Advanced Features
  'function badDebt() view returns (uint256)',
  'function badDebtRecovered(uint256 recoveredAmount_)',
  'function isVToken() pure returns (bool)',
  'function isTimeBased() view returns (bool)',
  'function blocksOrSecondsPerYear() view returns (uint256)',
  'function getBlockNumberOrTimestamp() view returns (uint256)',
  'function sweepToken(address token)',

  // Constants
  'function NO_ERROR() view returns (uint256)',

  // Initialization
  'function initialize(address underlying_, address comptroller_, address interestRateModel_, uint256 initialExchangeRateMantissa_, string name_, string symbol_, uint8 decimals_, address admin_, address accessControlManager_, address riskManagementShortfall, address riskManagementProtocolShareReserve, uint256 reserveFactorMantissa_)',
]);
