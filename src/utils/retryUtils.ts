/**
 * Retry Utility for handling API call failures with exponential backoff
 * Provides configurable retry logic for Alchemy, Royco, and other external API calls
 */

import { createLogger } from './logger';
import { CONSTANTS } from '../config/constants';
import { AlchemyService } from './AlchemyService';

const logger = createLogger('RetryUtils');

export interface RetryOptions {
  maxRetries: number;
  delayMs?: number;
  backoffMultiplier?: number;
  operation: string; // Description of the operation for logging
}

/**
 * Generic retry wrapper for async functions
 * @param asyncFunction - The async function to retry
 * @param options - Retry configuration options
 * @returns Promise that resolves with the function result or rejects after all retries fail
 */
export async function withRetry<T>(
  asyncFunction: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    delayMs = CONSTANTS.RETRY_DELAY_MS,
    backoffMultiplier = CONSTANTS.RETRY_BACKOFF_MULTIPLIER,
    operation
  } = options;

  let lastError: Error;
  let currentDelay = delayMs;
  const maxDelayMs = CONSTANTS.MAX_RETRY_DELAY_SECONDS * 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`${operation} - Attempt ${attempt}/${maxRetries}`);
      const result = await asyncFunction();
      
      if (attempt > 1) {
        logger.info(`${operation} succeeded on attempt ${attempt}/${maxRetries}`);
      }
      
      return result;
    } catch (error) {
      lastError = error as Error;
      
      // Check if this is a contract deployment error - don't retry these
      if (isContractNotDeployedError(lastError)) {
        logger.warn(`${operation} - skipped because contract is not deployed`);
        throw lastError;
      }
      
      if (attempt === maxRetries) {
        logger.error(`${operation} failed after ${maxRetries} attempts. Final error:`, lastError);
        break;
      }
      
      logger.warn(`${operation} failed on attempt ${attempt}/${maxRetries}. Retrying in ${currentDelay}ms. Error:`, {
        message: lastError.message,
        name: lastError.constructor.name,
        stack: lastError.stack,
        fullError: lastError
      });
      
      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      
      // Apply exponential backoff with max delay cap
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  // All retries failed, throw the last error
  throw new Error(`${operation} failed after ${maxRetries} attempts: ${lastError!.message}`);
}

/**
 * Check if an error indicates a contract that is not deployed at the given block
 */
function isContractNotDeployedError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const errorName = error.constructor.name;
  
  // Check for viem ContractFunctionExecutionError patterns
  if (errorName === 'ContractFunctionExecutionError') {
    return message.includes('returned no data ("0x")') ||
           message.includes('contract does not have the function') ||
           message.includes('address is not a contract');
  }
  
  // Check for other viem error types
  if (errorName === 'CallExecutionError' || 
      errorName === 'RpcError' || 
      errorName === 'HttpRequestError') {
    return message.includes('returned no data ("0x")') ||
           message.includes('no contract code at address') ||
           message.includes('address is not a contract') ||
           message.includes('execution reverted');
  }
  
  // Check for parameter/syntax errors that should not be retried
  if (errorName === 'SyntaxError') {
    return message.includes('cannot convert') && message.includes('to a bigint');
  }
  
  // Check for other common patterns indicating undeployed contracts
  return message.includes('contract not deployed') ||
         message.includes('no bytecode') ||
         message.includes('no code at address') ||
         (message.includes('execution reverted') && message.includes('contract'));
}

/**
 * Retry wrapper specifically for Alchemy API calls with fallback support
 */
export async function withAlchemyRetry<T>(
  asyncFunction: () => Promise<T>,
  operation: string
): Promise<T> {
  const alchemyService = AlchemyService.getInstance();
  
  try {
    // First attempt with primary API key
    return await withRetry(asyncFunction, {
      maxRetries: CONSTANTS.MAX_ALCHEMY_RETRIES,
      operation: `Alchemy: ${operation}`
    });
  } catch (primaryError) {
    // Check if this is a contract not deployed error (don't try fallback)
    if (isContractNotDeployedError(primaryError as Error)) {
      logger.warn(`${operation} - skipped because contract is not deployed`);
      throw primaryError;
    }
    
    // If primary API key fails and fallback is available, try with fallback
    const switchedToFallback = alchemyService.switchToFallback();
    
    if (switchedToFallback) {
      logger.warn(`Primary Alchemy API failed for "${operation}", attempting with fallback API key`);
      
      try {
        const result = await withRetry(asyncFunction, {
          maxRetries: CONSTANTS.MAX_ALCHEMY_RETRIES,
          operation: `Alchemy Fallback: ${operation}`
        });
        
        // Switch back to primary for next operations
        alchemyService.switchToPrimary();
        return result;
        
      } catch (fallbackError) {
        // Switch back to primary even if fallback fails
        alchemyService.switchToPrimary();
        
        logger.error(`Both primary and fallback Alchemy APIs failed for "${operation}"`);
        throw new Error(`Alchemy API failed with both keys: Primary - ${(primaryError as Error).message}, Fallback - ${(fallbackError as Error).message}`);
      }
    } else {
      // No fallback available, throw original error
      throw primaryError;
    }
  }
}

/**
 * Retry wrapper specifically for Royco API calls
 */
export async function withRoycoRetry<T>(
  asyncFunction: () => Promise<T>,
  operation: string
): Promise<T> {
  return withRetry(asyncFunction, {
    maxRetries: CONSTANTS.MAX_ROYCO_API_RETRIES,
    operation: `Royco: ${operation}`
  });
}

/**
 * Retry wrapper specifically for Block Time API calls
 */
export async function withBlockTimeRetry<T>(
  asyncFunction: () => Promise<T>,
  operation: string
): Promise<T> {
  return withRetry(asyncFunction, {
    maxRetries: CONSTANTS.MAX_ALCHEMY_RETRIES,
    delayMs: 250,
    backoffMultiplier: 2,
    operation: `BlockTime: ${operation}`
  });
}
