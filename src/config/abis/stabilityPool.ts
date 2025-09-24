import { parseAbi } from 'viem';

/**
 * Stability Pool ABI (AAVE v3 lending pool)
 * Sample Address: 0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8
 */
export const STABILITY_POOL_ABI = parseAbi([
  // Events
  'event BackUnbacked(address indexed reserve, address indexed backer, uint256 amount, uint256 fee)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event FlashLoan(address indexed target, address initiator, address indexed asset, uint256 amount, uint8 interestRateMode, uint256 premium, uint16 indexed referralCode)',
  'event IsolationModeTotalDebtUpdated(address indexed asset, uint256 totalDebt)',
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  'event MintUnbacked(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event MintedToTreasury(address indexed reserve, uint256 amountMinted)',
  'event RebalanceStableBorrowRate(address indexed reserve, address indexed user)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)',
  'event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user)',
  'event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event SwapBorrowRateMode(address indexed reserve, address indexed user, uint8 interestRateMode)',
  'event UserEModeSet(address indexed user, uint8 categoryId)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',

  // Core View Functions
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function BRIDGE_PROTOCOL_FEE() view returns (uint256)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function FLASHLOAN_PREMIUM_TO_PROTOCOL() view returns (uint128)',
  'function MAX_NUMBER_RESERVES() view returns (uint16)',
  'function MAX_STABLE_RATE_BORROW_SIZE_PERCENT() view returns (uint256)',
  'function POOL_REVISION() view returns (uint256)',

  // Supply and Withdraw Functions
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function supplyWithPermit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',

  // Borrowing Functions
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode) returns (uint256)',
  'function repayWithPermit(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS) returns (uint256)',
  'function swapBorrowRateMode(address asset, uint256 interestRateMode)',
  'function rebalanceStableBorrowRate(address asset, address user)',

  // Flash Loan Functions
  'function flashLoan(address receiverAddress, address[] assets, uint256[] amounts, uint256[] interestRateModes, address onBehalfOf, bytes params, uint16 referralCode)',
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode)',

  // Liquidation Functions
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)',

  // Collateral Management
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
  'function setUserEMode(uint8 categoryId)',

  // Data Retrieval Functions
  'function getReserveData(address asset) view returns (((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getReserveNormalizedVariableDebt(address asset) view returns (uint256)',
  'function getReservesList() view returns (address[])',
  'function getReserveAddressById(uint16 id) view returns (address)',

  // User Account Information
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserConfiguration(address user) view returns ((uint256 data))',
  'function getUserEMode(address user) view returns (uint256)',

  // EMode Category Functions
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
  'function configureEModeCategory(uint8 id, (uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label) category)',

  // Admin Functions
  'function initReserve(address asset, address aTokenAddress, address stableDebtAddress, address variableDebtAddress, address interestRateStrategyAddress)',
  'function dropReserve(address asset)',
  'function setConfiguration(address asset, (uint256 data) configuration)',
  'function setReserveInterestRateStrategyAddress(address asset, address rateStrategyAddress)',
  'function updateBridgeProtocolFee(uint256 protocolFee)',
  'function updateFlashloanPremiums(uint128 flashLoanPremiumTotal, uint128 flashLoanPremiumToProtocol)',

  // Advanced Functions
  'function mintUnbacked(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function backUnbacked(address asset, uint256 amount, uint256 fee) returns (uint256)',
  'function mintToTreasury(address[] assets)',
  'function resetIsolationModeTotalDebt(address asset)',
  'function rescueTokens(address token, address to, uint256 amount)',

  // Transfer Finalization
  'function finalizeTransfer(address asset, address from, address to, uint256 amount, uint256 balanceFromBefore, uint256 balanceToBefore)',

  // Initialization
  'function initialize(address provider)',
]);
