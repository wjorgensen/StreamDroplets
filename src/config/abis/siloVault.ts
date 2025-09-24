import { parseAbi } from 'viem';

/**
 * Silo Finance Vault ABI (ERC-4626 standard with protected deposits)
 * Sample Address: 0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172
 */
export const SILO_VAULT_ABI = parseAbi([
  // Events
  'event AccruedInterest(uint256 hooksBefore)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Borrow(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event CollateralTypeChanged(address indexed borrower)',
  'event DeployerFeesRedirected(uint256 deployerFees)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event DepositProtected(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event EIP712DomainChanged()',
  'event FlashLoan(uint256 amount)',
  'event HooksUpdated(uint24 hooksBefore, uint24 hooksAfter)',
  'event Initialized(uint64 version)',
  'event NotificationSent(address indexed notificationReceiver, bool success)',
  'event Repay(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event WithdrawProtected(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event WithdrawnFees(uint256 daoFees, uint256 deployerFees, bool redirectedDeployerFees)',

  // Core View Functions
  'function asset() view returns (address assetTokenAddress)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256 totalManagedAssets)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',

  // ERC-4626 Standard Functions
  'function convertToAssets(uint256 _shares) view returns (uint256 assets)',
  'function convertToAssets(uint256 _shares, uint8 _assetType) view returns (uint256 assets)',
  'function convertToShares(uint256 _assets) view returns (uint256 shares)',
  'function convertToShares(uint256 _assets, uint8 _assetType) view returns (uint256 shares)',
  
  // Preview Functions
  'function previewDeposit(uint256 _assets) view returns (uint256 shares)',
  'function previewDeposit(uint256 _assets, uint8 _collateralType) view returns (uint256 shares)',
  'function previewMint(uint256 _shares) view returns (uint256 assets)',
  'function previewMint(uint256 _shares, uint8 _collateralType) view returns (uint256 assets)',
  'function previewWithdraw(uint256 _assets) view returns (uint256 shares)',
  'function previewWithdraw(uint256 _assets, uint8 _collateralType) view returns (uint256 shares)',
  'function previewRedeem(uint256 _shares) view returns (uint256 assets)',
  'function previewRedeem(uint256 _shares, uint8 _collateralType) view returns (uint256 assets)',
  
  // Max Functions
  'function maxDeposit(address) pure returns (uint256 maxAssets)',
  'function maxMint(address) view returns (uint256 maxShares)',
  'function maxWithdraw(address _owner) view returns (uint256 maxAssets)',
  'function maxWithdraw(address _owner, uint8 _collateralType) view returns (uint256 maxAssets)',
  'function maxRedeem(address _owner) view returns (uint256 maxShares)',
  'function maxRedeem(address _owner, uint8 _collateralType) view returns (uint256 maxShares)',

  // Core Operations
  'function deposit(uint256 _assets, address _receiver) returns (uint256 shares)',
  'function deposit(uint256 _assets, address _receiver, uint8 _collateralType) returns (uint256 shares)',
  'function mint(uint256 _shares, address _receiver) returns (uint256 assets)',
  'function mint(uint256 _shares, address _receiver, uint8 _collateralType) returns (uint256 assets)',
  'function mint(address _owner, address, uint256 _amount)',
  'function withdraw(uint256 _assets, address _receiver, address _owner) returns (uint256 shares)',
  'function withdraw(uint256 _assets, address _receiver, address _owner, uint8 _collateralType) returns (uint256 shares)',
  'function redeem(uint256 _shares, address _receiver, address _owner) returns (uint256 assets)',
  'function redeem(uint256 _shares, address _receiver, address _owner, uint8 _collateralType) returns (uint256 assets)',

  // ERC-20 Functions
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool result)',
  'function transfer(address _to, uint256 _amount) returns (bool result)',
  'function transferFrom(address _from, address _to, uint256 _amount) returns (bool result)',

  // Borrowing Functions
  'function borrow(uint256 _assets, address _receiver, address _borrower) returns (uint256 shares)',
  'function borrowSameAsset(uint256 _assets, address _receiver, address _borrower) returns (uint256 shares)',
  'function borrowShares(uint256 _shares, address _receiver, address _borrower) returns (uint256 assets)',
  'function repay(uint256 _assets, address _borrower) returns (uint256 shares)',
  'function repayShares(uint256 _shares, address _borrower) returns (uint256 assets)',
  
  // Borrowing Preview Functions
  'function previewBorrow(uint256 _assets) view returns (uint256 shares)',
  'function previewBorrowShares(uint256 _shares) view returns (uint256 assets)',
  'function previewRepay(uint256 _assets) view returns (uint256 shares)',
  'function previewRepayShares(uint256 _shares) view returns (uint256 assets)',
  
  // Borrowing Max Functions
  'function maxBorrow(address _borrower) view returns (uint256 maxAssets)',
  'function maxBorrowSameAsset(address _borrower) view returns (uint256 maxAssets)',
  'function maxBorrowShares(address _borrower) view returns (uint256 maxShares)',
  'function maxRepay(address _borrower) view returns (uint256 assets)',
  'function maxRepayShares(address _borrower) view returns (uint256 shares)',

  // Flash Loan Functions
  'function flashLoan(address _receiver, address _token, uint256 _amount, bytes _data) returns (bool success)',
  'function flashFee(address _token, uint256 _amount) view returns (uint256 fee)',
  'function maxFlashLoan(address _token) view returns (uint256 maxLoan)',

  // Solvency and Risk Functions
  'function isSolvent(address _borrower) view returns (bool)',

  // Interest and Fee Functions
  'function accrueInterest() returns (uint256 accruedInterest)',
  'function accrueInterestForConfig(address _interestRateModel, uint256 _daoFee, uint256 _deployerFee)',
  'function withdrawFees()',

  // Collateral Management
  'function switchCollateralToThisSilo()',
  'function transitionCollateral(uint256 _shares, address _owner, uint8 _transitionFrom) returns (uint256 assets)',

  // Hook System
  'function hookReceiver() view returns (address)',
  'function hookSetup() view returns ((address hookReceiver, uint24 hooksBefore, uint24 hooksAfter, uint24 tokenType))',
  'function synchronizeHooks(uint24 _hooksBefore, uint24 _hooksAfter)',
  'function updateHooks()',

  // Advanced View Functions
  'function balanceOfAndTotalSupply(address _account) view returns (uint256, uint256)',
  'function getLiquidity() view returns (uint256 liquidity)',
  'function getCollateralAssets() view returns (uint256 totalCollateralAssets)',
  'function getDebtAssets() view returns (uint256 totalDebtAssets)',
  'function getCollateralAndDebtTotalsStorage() view returns (uint256 totalCollateralAssets, uint256 totalDebtAssets)',
  'function getCollateralAndProtectedTotalsStorage() view returns (uint256 totalCollateralAssets, uint256 totalProtectedAssets)',
  'function getTotalAssetsStorage(uint8 _assetType) view returns (uint256 totalAssetsByType)',
  'function getFractionsStorage() view returns ((uint64 interest, uint64 revenue) fractions)',
  'function getSiloStorage() view returns (uint192 daoAndDeployerRevenue, uint64 interestRateTimestamp, uint256 protectedAssets, uint256 collateralAssets, uint256 debtAssets)',
  'function utilizationData() view returns ((uint256 collateralAssets, uint256 debtAssets, uint64 interestRateTimestamp))',

  // Configuration Functions
  'function config() view returns (address siloConfig)',
  'function siloConfig() view returns (address)',
  'function factory() view returns (address)',
  'function silo() view returns (address)',
  'function initialize(address _config)',

  // EIP-712 and Permit Functions
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',

  // Advanced Operations
  'function burn(address _owner, address _spender, uint256 _amount)',
  'function forwardTransferFromNoChecks(address _from, address _to, uint256 _amount)',
  'function callOnBehalfOfSilo(address _target, uint256 _value, uint8 _callType, bytes _input) payable returns (bool success, bytes result)',
]);
