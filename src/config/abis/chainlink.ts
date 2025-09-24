import { parseAbi } from 'viem';

/**
 * Chainlink Aggregator ABI for price feeds
 * Includes all functionality for reading price data, round information, and aggregator management
 */
export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  // Events
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
  'event NewRound(uint256 indexed roundId, address indexed startedBy, uint256 startedAt)',
  'event OwnershipTransferRequested(address indexed from, address indexed to)',
  'event OwnershipTransferred(address indexed from, address indexed to)',
  
  // Core Price Feed Functions
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function latestAnswer() view returns (int256)',
  'function latestRound() view returns (uint256)',
  'function latestTimestamp() view returns (uint256)',
  'function getAnswer(uint256 _roundId) view returns (int256)',
  'function getTimestamp(uint256 _roundId) view returns (uint256)',
  
  // Feed Information
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function version() view returns (uint256)',
  
  // Aggregator Management
  'function aggregator() view returns (address)',
  'function phaseId() view returns (uint16)',
  'function phaseAggregators(uint16) view returns (address)',
  'function proposedAggregator() view returns (address)',
  'function proposeAggregator(address _aggregator)',
  'function confirmAggregator(address _aggregator)',
  'function proposedGetRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function proposedLatestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  
  // Access Control
  'function accessController() view returns (address)',
  'function setController(address _accessController)',
  
  // Ownership
  'function owner() view returns (address)',
  'function transferOwnership(address _to)',
  'function acceptOwnership()',
]);
