/**
 * Date utility functions for StreamDroplets
 */

import { DEPLOYMENT_INFO } from '../config/contracts';

/**
 * Increments a date string by one day
 */
export function incrementDateString(dateString: string): string {
  const date = new Date(dateString + 'T00:00:00.000Z');
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
}

/**
 * Gets the next processing date for backfill
 */
export function getNextProcessingDate(currentDateString: string | null): string {
  if (currentDateString === null) {
    return DEPLOYMENT_INFO.OVERALL_START_DATE;
  }
  return incrementDateString(currentDateString);
}

/**
 * Calculates 11:59:59 PM UTC Unix timestamp for a given date string
 */
export function getEndOfDayTimestampUTC(dateString: string): number {
  const date = new Date(dateString + 'T00:00:00.000Z');
  
  const endOfDayUTC = new Date(date.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999);
  
  return Math.floor(endOfDayUTC.getTime() / 1000);
}

/**
 * Converts date string to ISO string for end of day UTC
 */
export function dateStringToEndOfDayISO(dateString: string): string {
  const timestamp = getEndOfDayTimestampUTC(dateString);
  return new Date(timestamp * 1000).toISOString();
}
