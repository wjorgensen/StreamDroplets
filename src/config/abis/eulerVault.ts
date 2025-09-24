import { parseAbi } from 'viem';

/**
 * Euler Finance Vault ABI (ERC-4626 standard)
 * Sample Address: 0xdEBdAB749330bb976fD10dc52f9A452aaF029028
 */
export const EULER_VAULT_ABI = parseAbi([
  // Events
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event BalanceForwarderStatus(address indexed account, bool status)',
  'event Borrow(address indexed account, uint256 assets)',
  'event ConvertFees(address indexed sender, address indexed protocolReceiver, address indexed governorReceiver, uint256 protocolShares, uint256 governorShares)',
  'event DebtSocialized(address indexed account, uint256 assets)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event EVaultCreated(address indexed creator, address indexed asset, address dToken)',
  'event GovSetCaps(uint16 newSupplyCap, uint16 newBorrowCap)',
  'event GovSetConfigFlags(uint32 newConfigFlags)',
  'event GovSetFeeReceiver(address indexed newFeeReceiver)',
  'event GovSetGovernorAdmin(address indexed newGovernorAdmin)',
  'event GovSetHookConfig(address indexed newHookTarget, uint32 newHookedOps)',
  'event GovSetInterestFee(uint16 newFee)',
  'event GovSetInterestRateModel(address newInterestRateModel)',
  'event GovSetLTV(address indexed collateral, uint16 borrowLTV, uint16 liquidationLTV, uint16 initialLiquidationLTV, uint48 targetTimestamp, uint32 rampDuration)',
  'event GovSetLiquidationCoolOffTime(uint16 newCoolOffTime)',
  'event GovSetMaxLiquidationDiscount(uint16 newDiscount)',
  'event InterestAccrued(address indexed account, uint256 assets)',
  'event Liquidate(address indexed liquidator, address indexed violator, address collateral, uint256 repayAssets, uint256 yieldBalance)',
  'event PullDebt(address indexed from, address indexed to, uint256 assets)',
  'event Repay(address indexed account, uint256 assets)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event VaultStatus(uint256 totalShares, uint256 totalBorrows, uint256 accumulatedFees, uint256 cash, uint256 interestAccumulator, uint256 interestRate, uint256 timestamp)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',

  // Core View Functions
  'function EVC() view returns (address)',
  'function asset() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',

  // ERC-4626 Standard Functions
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewMint(uint256 shares) view returns (uint256)',
  'function previewWithdraw(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function maxDeposit(address account) view returns (uint256)',
  'function maxMint(address account) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function maxRedeem(address owner) view returns (uint256)',

  // Core Operations
  'function deposit(uint256 amount, address receiver) returns (uint256)',
  'function mint(uint256 amount, address receiver) returns (uint256)',
  'function withdraw(uint256 amount, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 amount, address receiver, address owner) returns (uint256)',

  // ERC-20 Functions
  'function allowance(address holder, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function transferFromMax(address from, address to) returns (bool)',

  // Borrowing Functions
  'function borrow(uint256 amount, address receiver) returns (uint256)',
  'function repay(uint256 amount, address receiver) returns (uint256)',
  'function repayWithShares(uint256 amount, address receiver) returns (uint256 shares, uint256 debt)',
  'function pullDebt(uint256 amount, address from)',
  'function debtOf(address account) view returns (uint256)',
  'function debtOfExact(address account) view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalBorrowsExact() view returns (uint256)',

  // Liquidation Functions
  'function liquidate(address violator, address collateral, uint256 repayAssets, uint256 minYieldBalance)',
  'function checkLiquidation(address liquidator, address violator, address collateral) view returns (uint256 maxRepay, uint256 maxYield)',

  // Account Status and Risk Management
  'function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)',
  'function accountLiquidityFull(address account, bool liquidation) view returns (address[] collaterals, uint256[] collateralValues, uint256 liabilityValue)',
  'function checkAccountStatus(address account, address[] collaterals) view returns (bytes4)',
  'function checkVaultStatus() returns (bytes4)',

  // LTV (Loan-to-Value) Functions
  'function LTVBorrow(address collateral) view returns (uint16)',
  'function LTVLiquidation(address collateral) view returns (uint16)',
  'function LTVFull(address collateral) view returns (uint16 borrowLTV, uint16 liquidationLTV, uint16 initialLiquidationLTV, uint48 targetTimestamp, uint32 rampDuration)',
  'function LTVList() view returns (address[])',

  // Interest Rate and Fee Functions
  'function interestRate() view returns (uint256)',
  'function interestAccumulator() view returns (uint256)',
  'function interestRateModel() view returns (address)',
  'function interestFee() view returns (uint16)',
  'function accumulatedFees() view returns (uint256)',
  'function accumulatedFeesAssets() view returns (uint256)',
  'function cash() view returns (uint256)',

  // Configuration Functions
  'function caps() view returns (uint16 supplyCap, uint16 borrowCap)',
  'function configFlags() view returns (uint32)',
  'function oracle() view returns (address)',
  'function unitOfAccount() view returns (address)',
  'function hookConfig() view returns (address, uint32)',
  'function liquidationCoolOffTime() view returns (uint16)',
  'function maxLiquidationDiscount() view returns (uint16)',

  // Module Addresses
  'function MODULE_INITIALIZE() view returns (address)',
  'function MODULE_TOKEN() view returns (address)',
  'function MODULE_VAULT() view returns (address)',
  'function MODULE_BORROWING() view returns (address)',
  'function MODULE_LIQUIDATION() view returns (address)',
  'function MODULE_RISKMANAGER() view returns (address)',
  'function MODULE_BALANCE_FORWARDER() view returns (address)',
  'function MODULE_GOVERNANCE() view returns (address)',

  // Governance Functions
  'function governorAdmin() view returns (address)',
  'function feeReceiver() view returns (address)',
  'function protocolFeeReceiver() view returns (address)',
  'function protocolFeeShare() view returns (uint256)',
  'function creator() view returns (address)',
  'function dToken() view returns (address)',

  // Governance Operations (admin only)
  'function setCaps(uint16 supplyCap, uint16 borrowCap)',
  'function setConfigFlags(uint32 newConfigFlags)',
  'function setFeeReceiver(address newFeeReceiver)',
  'function setGovernorAdmin(address newGovernorAdmin)',
  'function setHookConfig(address newHookTarget, uint32 newHookedOps)',
  'function setInterestFee(uint16 newFee)',
  'function setInterestRateModel(address newModel)',
  'function setLTV(address collateral, uint16 borrowLTV, uint16 liquidationLTV, uint32 rampDuration)',
  'function setLiquidationCoolOffTime(uint16 newCoolOffTime)',
  'function setMaxLiquidationDiscount(uint16 newDiscount)',

  // Balance Forwarder
  'function balanceForwarderEnabled(address account) view returns (bool)',
  'function enableBalanceForwarder()',
  'function disableBalanceForwarder()',
  'function disableController()',

  // Additional Functions
  'function initialize(address proxyCreator)',
  'function touch()',
  'function convertFees()',
  'function skim(uint256 amount, address receiver) returns (uint256)',
  'function flashLoan(uint256 amount, bytes data)',
  'function viewDelegate() payable',
  
  // Protocol Integration Addresses
  'function balanceTrackerAddress() view returns (address)',
  'function protocolConfigAddress() view returns (address)',
  'function permit2Address() view returns (address)',
]);
