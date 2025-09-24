/**
 * Date utility functions for StreamDroplets
 */

import { DEPLOYMENT_INFO } from '../config/contracts';

/**
 * Increment a date string by one day
 * @param dateString - Date string in YYYY-MM-DD format
 * @returns Next day in YYYY-MM-DD format
 */
export function incrementDateString(dateString: string): string {
  const date = new Date(dateString + 'T00:00:00.000Z');
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
}

/**
 * Get the next processing date for backfill
 * @param currentDateString - Current date string, or null to start from OVERALL_START_DATE
 * @returns Next date string in YYYY-MM-DD format
 */
export function getNextProcessingDate(currentDateString: string | null): string {
  if (currentDateString === null) {
    return DEPLOYMENT_INFO.OVERALL_START_DATE;
  }
  return incrementDateString(currentDateString);
}

/**
 * Calculate 11:59:59 PM UTC Unix timestamp for a given date string
 * @param dateString - Date string in YYYY-MM-DD format
 * @returns Unix timestamp in seconds for 11:59:59 PM UTC on that date
 */
export function getEndOfDayTimestampUTC(dateString: string): number {
  // Start with the target date at midnight UTC
  const date = new Date(dateString + 'T00:00:00.000Z');
  
  // Add 23 hours 59 minutes 59 seconds 999 milliseconds to get to end of day UTC
  const endOfDayUTC = new Date(date.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999);
  
  return Math.floor(endOfDayUTC.getTime() / 1000);
}

/**
 * Convert date string to ISO string for timestamp calculations
 * @param dateString - Date string in YYYY-MM-DD format
 * @returns ISO string for end of day UTC
 */
export function dateStringToEndOfDayISO(dateString: string): string {
  const timestamp = getEndOfDayTimestampUTC(dateString);
  return new Date(timestamp * 1000).toISOString();
}
