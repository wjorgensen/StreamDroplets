/**
 * Scheduler Service
 * Runs daily snapshots every 24 hours at midnight UTC
 */

import { DailySnapshotService } from './DailySnapshotService';
import { createLogger } from '../utils/logger';
import { getDb } from '../db/connection';

const logger = createLogger('SchedulerService');

export class SchedulerService {
  private dailySnapshotService: DailySnapshotService;
  private intervalId: NodeJS.Timeout | null = null;
  private db = getDb();
  private isRunning = false;

  constructor() {
    this.dailySnapshotService = new DailySnapshotService();
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting scheduler service');

    // Check and process any missed snapshots first
    await this.processMissedSnapshots();

    // Calculate time until next midnight UTC
    const now = new Date();
    const nextMidnight = new Date();
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);
    
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    
    logger.info(`Next snapshot will run at ${nextMidnight.toISOString()} (in ${msUntilMidnight / 1000 / 60} minutes)`);

    // Schedule first run at next midnight
    setTimeout(async () => {
      await this.runDailySnapshot();
      
      // Then run every 24 hours
      this.intervalId = setInterval(async () => {
        await this.runDailySnapshot();
      }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
    }, msUntilMidnight);

    // Also allow immediate processing for testing
    if (process.env.RUN_SNAPSHOT_NOW === 'true') {
      logger.info('RUN_SNAPSHOT_NOW is true, running snapshot immediately');
      await this.runDailySnapshot();
    }
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Scheduler service stopped');
  }

  /**
   * Run the daily snapshot
   */
  private async runDailySnapshot(): Promise<void> {
    try {
      logger.info('Running scheduled daily snapshot');
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      
      await this.dailySnapshotService.processDailySnapshot(today);
      
      logger.info('Daily snapshot completed successfully');
    } catch (error) {
      logger.error('Failed to run daily snapshot:', error);
    }
  }

  /**
   * Process any missed snapshots since last run
   */
  private async processMissedSnapshots(): Promise<void> {
    try {
      // Get the last processed snapshot date
      const lastProcessed = await this.db('system_state')
        .where('key', 'last_snapshot_date')
        .first();

      if (!lastProcessed) {
        logger.info('No previous snapshots found, starting fresh');
        return;
      }

      const lastDate = new Date(lastProcessed.value + 'T00:00:00.000Z');
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      // Calculate days between last processed and today
      const daysDiff = Math.floor((today.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));

      if (daysDiff > 1) {
        logger.info(`Found ${daysDiff - 1} missed snapshots, processing...`);
        
        const currentDate = new Date(lastDate);
        currentDate.setDate(currentDate.getDate() + 1);
        
        while (currentDate < today) {
          logger.info(`Processing missed snapshot for ${currentDate.toISOString().split('T')[0]}`);
          await this.dailySnapshotService.processDailySnapshot(currentDate);
          currentDate.setDate(currentDate.getDate() + 1);
        }
      } else {
        logger.info('No missed snapshots to process');
      }
    } catch (error) {
      logger.error('Failed to process missed snapshots:', error);
    }
  }

  /**
   * Force run a snapshot for a specific date (for testing/backfill)
   */
  async forceSnapshot(date: Date): Promise<void> {
    logger.info(`Force running snapshot for ${date.toISOString().split('T')[0]}`);
    await this.dailySnapshotService.processDailySnapshot(date);
  }

  /**
   * Get scheduler status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    lastSnapshot: string;
    nextSnapshot: string;
    pendingSnapshots: number;
  }> {
    const lastProcessed = await this.db('system_state')
      .where('key', 'last_snapshot_date')
      .first();

    const nextMidnight = new Date();
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);

    const pendingJobs = await this.db('daily_snapshot_jobs')
      .where('status', 'pending')
      .count('* as count')
      .first();

    return {
      isRunning: this.isRunning,
      lastSnapshot: lastProcessed?.value || 'Never',
      nextSnapshot: nextMidnight.toISOString(),
      pendingSnapshots: Number(pendingJobs?.count || 0),
    };
  }
}