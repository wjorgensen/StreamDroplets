import { parseAbi } from 'viem';

/**
 * Silo Finance Router ABI
 * Sample Address: 0x9Fa3C1E843d8eb1387827E5d77c07E8BB97B1e50
 */
export const SILO_ROUTER_ABI = parseAbi([
  // Events
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address account)',
  'event Unpaused(address account)',

  // Core View Functions
  'function IMPLEMENTATION() view returns (address)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',

  // Ownership Functions (Ownable2Step pattern)
  'function acceptOwnership()',
  'function transferOwnership(address newOwner)',
  'function renounceOwnership()',

  // Pausable Functions
  'function pause()',
  'function unpause()',

  // Multicall Functionality
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
