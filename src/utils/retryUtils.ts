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
  operation: string;
}

/**
 * Generic retry wrapper for async functions
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
      const shouldLogAttempt = !operation.startsWith('Alchemy: getBlock');
      if (shouldLogAttempt) {
        logger.debug(`${operation} - Attempt ${attempt}/${maxRetries}`);
      }
      const result = await asyncFunction();
      
      if (attempt > 1) {
        logger.info(`${operation} succeeded on attempt ${attempt}/${maxRetries}`);
      }
      
      return result;
    } catch (error) {
      lastError = error as Error;
      
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
      
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw new Error(`${operation} failed after ${maxRetries} attempts: ${lastError!.message}`);
}

/**
 * Checks if an error indicates a contract that is not deployed at the given block
 */
function isContractNotDeployedError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const errorName = error.constructor.name;
  
  if (errorName === 'ContractFunctionExecutionError') {
    return message.includes('returned no data ("0x")') ||
           message.includes('contract does not have the function') ||
           message.includes('address is not a contract');
  }
  
  if (errorName === 'CallExecutionError' || 
      errorName === 'RpcError' || 
      errorName === 'HttpRequestError') {
    return message.includes('returned no data ("0x")') ||
           message.includes('no contract code at address') ||
           message.includes('address is not a contract') ||
           message.includes('execution reverted');
  }
  
  if (errorName === 'SyntaxError') {
    return message.includes('cannot convert') && message.includes('to a bigint');
  }
  
  return message.includes('contract not deployed') ||
         message.includes('no bytecode') ||
         message.includes('no code at address') ||
         (message.includes('execution reverted') && message.includes('contract'));
}

/**
 * Retry wrapper for Alchemy API calls with fallback support
 */
export async function withAlchemyRetry<T>(
  asyncFunction: () => Promise<T>,
  operation: string
): Promise<T> {
  const alchemyService = AlchemyService.getInstance();
  
  try {
    return await withRetry(asyncFunction, {
      maxRetries: CONSTANTS.MAX_ALCHEMY_RETRIES,
      operation: `Alchemy: ${operation}`
    });
  } catch (primaryError) {
    if (isContractNotDeployedError(primaryError as Error)) {
      logger.warn(`${operation} - skipped because contract is not deployed`);
      throw primaryError;
    }
    
    const switchedToFallback = alchemyService.switchToFallback();
    
    if (switchedToFallback) {
      logger.warn(`Primary Alchemy API failed for "${operation}", attempting with fallback API key`);
      
      try {
        const result = await withRetry(asyncFunction, {
          maxRetries: CONSTANTS.MAX_ALCHEMY_RETRIES,
          operation: `Alchemy Fallback: ${operation}`
        });
        
        alchemyService.switchToPrimary();
        return result;
        
      } catch (fallbackError) {
        alchemyService.switchToPrimary();
        
        logger.error(`Both primary and fallback Alchemy APIs failed for "${operation}"`);
        throw new Error(`Alchemy API failed with both keys: Primary - ${(primaryError as Error).message}, Fallback - ${(fallbackError as Error).message}`);
      }
    } else {
      throw primaryError;
    }
  }
}

/**
 * Retry wrapper for Royco API calls
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
 * Retry wrapper for Block Time API calls
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
