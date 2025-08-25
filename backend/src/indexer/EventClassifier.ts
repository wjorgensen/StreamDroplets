import { CONSTANTS, EventClassification, ChainId } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('EventClassifier');

export class EventClassifier {
  /**
   * Classifies a transfer event based on transaction context
   * Distinguishes between unstake burns, bridge burns, and regular transfers
   */
  async classifyTransfer(
    from: string,
    to: string,
    _txHash: string,
    txReceipt: any,
    chainId: ChainId
  ): Promise<EventClassification> {
    // Check if this is a burn (transfer to zero address)
    if (to.toLowerCase() === CONSTANTS.ZERO_ADDRESS.toLowerCase()) {
      return this.classifyBurn(txReceipt, chainId);
    }
    
    // Check if this is a mint (transfer from zero address)
    if (from.toLowerCase() === CONSTANTS.ZERO_ADDRESS.toLowerCase()) {
      return this.classifyMint(txReceipt, chainId);
    }
    
    // Regular transfer between addresses
    return CONSTANTS.EVENT_CLASSIFICATIONS.TRANSFER;
  }
  
  /**
   * Classifies burn events - distinguishes unstake burns from bridge burns
   */
  private classifyBurn(txReceipt: any, _chainId: ChainId): EventClassification {
    if (!txReceipt || !txReceipt.input) {
      return CONSTANTS.EVENT_CLASSIFICATIONS.TRANSFER;
    }
    
    const methodId = txReceipt.input.slice(0, 10).toLowerCase();
    
    // Check if this is an unstake burn
    if (this.isUnstakeMethod(methodId)) {
      logger.debug(`Classified as unstake burn: ${txReceipt.transactionHash}`);
      return CONSTANTS.EVENT_CLASSIFICATIONS.UNSTAKE_BURN;
    }
    
    // Check if this is a bridge burn (OFT burn)
    if (this.isBridgeMethod(methodId, txReceipt)) {
      logger.debug(`Classified as bridge burn: ${txReceipt.transactionHash}`);
      return CONSTANTS.EVENT_CLASSIFICATIONS.BRIDGE_BURN;
    }
    
    // Default to transfer if we can't determine
    return CONSTANTS.EVENT_CLASSIFICATIONS.TRANSFER;
  }
  
  /**
   * Classifies mint events - typically from bridge mints
   */
  private classifyMint(txReceipt: any, _chainId: ChainId): EventClassification {
    // Check if this mint is from a bridge operation
    // This would typically check if the transaction originated from LayerZero endpoint
    if (this.isBridgeMint(txReceipt)) {
      logger.debug(`Classified as bridge mint: ${txReceipt.transactionHash}`);
      return CONSTANTS.EVENT_CLASSIFICATIONS.BRIDGE_MINT;
    }
    
    // Could be a redeem or other mint operation
    return CONSTANTS.EVENT_CLASSIFICATIONS.TRANSFER;
  }
  
  /**
   * Checks if the method ID corresponds to an unstake operation
   */
  private isUnstakeMethod(methodId: string): boolean {
    const unstakeMethods = [
      CONSTANTS.METHOD_SELECTORS.UNSTAKE,
      CONSTANTS.METHOD_SELECTORS.UNSTAKE_AND_WITHDRAW,
      CONSTANTS.METHOD_SELECTORS.INSTANT_UNSTAKE,
      CONSTANTS.METHOD_SELECTORS.INSTANT_UNSTAKE_AND_WITHDRAW,
    ];
    
    return unstakeMethods.some(selector => 
      methodId.toLowerCase() === selector.toLowerCase()
    );
  }
  
  /**
   * Checks if the transaction is a bridge operation
   */
  private isBridgeMethod(methodId: string, txReceipt: any): boolean {
    // Common LayerZero OFT methods
    const bridgeMethods = [
      '0x0df37483', // send(SendParam,MessagingFee,address)
      '0x5e280f11', // sendFrom(address,uint16,bytes32,uint256,...)
      '0xc5803100', // bridge method signatures
    ];
    
    // Check if method matches known bridge methods
    if (bridgeMethods.some(selector => methodId.toLowerCase() === selector.toLowerCase())) {
      return true;
    }
    
    // Additional check: Look for OFT events in the logs
    if (txReceipt.logs) {
      const hasOFTEvent = txReceipt.logs.some((log: any) => {
        // Check for OFTSent event topic
        const oftSentTopic = '0x' + 'e1b87c47fdeb4f9cbadbca9df3af7aba453bb6e501075d0440d88125b711522a';
        return log.topics && log.topics[0] === oftSentTopic;
      });
      
      if (hasOFTEvent) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Checks if a mint is from a bridge operation
   */
  private isBridgeMint(txReceipt: any): boolean {
    if (!txReceipt || !txReceipt.logs) {
      return false;
    }
    
    // Check for OFTReceived event in the logs
    const hasOFTReceived = txReceipt.logs.some((log: any) => {
      // OFTReceived event topic
      const oftReceivedTopic = '0x' + 'efa289a0b1dacee39da97554c6a6891e5b1a82564ca35f6b810fbc7f844beee7';
      return log.topics && log.topics[0] === oftReceivedTopic;
    });
    
    return hasOFTReceived;
  }
  
  /**
   * Classifies vault-specific events (Stake, Redeem, etc.)
   */
  classifyVaultEvent(eventName: string): EventClassification {
    const eventMap: Record<string, EventClassification> = {
      'Stake': CONSTANTS.EVENT_CLASSIFICATIONS.STAKE,
      'Redeem': CONSTANTS.EVENT_CLASSIFICATIONS.REDEEM,
      'Unstake': CONSTANTS.EVENT_CLASSIFICATIONS.UNSTAKE_BURN,
      'InstantUnstake': CONSTANTS.EVENT_CLASSIFICATIONS.UNSTAKE_BURN,
    };
    
    return eventMap[eventName] || CONSTANTS.EVENT_CLASSIFICATIONS.TRANSFER;
  }
}