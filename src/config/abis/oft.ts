import { parseAbi } from 'viem';

/**
 * LayerZero OFT (Omni Fungible Token) ABI for cross-chain functionality
 * Includes cross-chain transfer events, messaging, and LayerZero endpoint interactions
 */
export const OFT_ABI = parseAbi([
  // OFT Events
  'event OFTSent(bytes32 indexed guid, uint32 indexed dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  
  // LayerZero Configuration Events
  'event PeerSet(uint32 eid, bytes32 peer)',
  'event EnforcedOptionSet((uint32 eid, uint16 msgType, bytes options)[] _enforcedOptions)',
  'event PreCrimeSet(address preCrimeAddress)',
  'event MsgInspectorSet(address inspector)',
  
  // OFT Core Functions
  'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, (uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function bridgeWithRedeem((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee), (uint256 amountSentLD, uint256 amountReceivedLD))',
  
  // Quote Functions
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) msgFee)',
  'function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD) oftLimit, (int256 feeAmountLD, string description)[] oftFeeDetails, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  
  // LayerZero Message Handling
  'function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) _origin, bytes32 _guid, bytes _message, address _executor, bytes _extraData) payable',
  'function lzReceiveSimulate((uint32 srcEid, bytes32 sender, uint64 nonce) _origin, bytes32 _guid, bytes _message, address _executor, bytes _extraData) payable',
  'function lzReceiveAndRevert(((uint32 srcEid, bytes32 sender, uint64 nonce) origin, uint32 dstEid, address receiver, bytes32 guid, uint256 value, address executor, bytes message, bytes extraData)[] _packets) payable',
  
  // LayerZero Configuration Functions
  'function setPeer(uint32 _eid, bytes32 _peer)',
  'function peers(uint32 eid) view returns (bytes32 peer)',
  'function isPeer(uint32 _eid, bytes32 _peer) view returns (bool)',
  'function setEnforcedOptions((uint32 eid, uint16 msgType, bytes options)[] _enforcedOptions)',
  'function enforcedOptions(uint32 eid, uint16 msgType) view returns (bytes enforcedOption)',
  'function combineOptions(uint32 _eid, uint16 _msgType, bytes _extraOptions) view returns (bytes)',
  
  // LayerZero Endpoint and Configuration
  'function endpoint() view returns (address)',
  'function oApp() view returns (address)',
  'function nextNonce(uint32, bytes32) view returns (uint64 nonce)',
  'function setDelegate(address _delegate)',
  'function setPreCrime(address _preCrime)',
  'function preCrime() view returns (address)',
  'function setMsgInspector(address _msgInspector)',
  'function msgInspector() view returns (address)',
  
  // OFT Standards and Version
  'function oftVersion() pure returns (bytes4 interfaceId, uint64 version)',
  'function oAppVersion() pure returns (uint64 senderVersion, uint64 receiverVersion)',
  'function sharedDecimals() view returns (uint8)',
  'function decimalConversionRate() view returns (uint256)',
  'function approvalRequired() pure returns (bool)',
  
  // Path and Compose Message Functions
  'function allowInitializePath((uint32 srcEid, bytes32 sender, uint64 nonce) origin) view returns (bool)',
  'function isComposeMsgSender((uint32 srcEid, bytes32 sender, uint64 nonce), bytes, address _sender) view returns (bool)',
  
  // Independence and Advanced Features
  'function allowIndependence() view returns (bool)',
  'function setAllowIndependence(bool _allowIndependence)',
  
  // Message Type Constants
  'function SEND() view returns (uint16)',
  'function SEND_AND_CALL() view returns (uint16)',
]);
