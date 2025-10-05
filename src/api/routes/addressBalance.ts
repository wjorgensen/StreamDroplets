import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:AddressBalance');

const paramsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

const querySchema = z.object({
  fields: z.string().optional().transform(val => val ? val.split(',') : undefined),
});

export const addressBalanceRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /addressBalance/:address
   * Returns the latest user daily snapshot for an address with optional field filtering
   */
  fastify.get('/:address', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      const { fields } = querySchema.parse(request.query);
      
      logger.info(`Getting address balance for ${address}`);
      
      // Get the latest user daily snapshot for this address
      const latestSnapshot = await db('user_daily_snapshots')
        .where('address', address.toLowerCase())
        .orderBy('snapshot_date', 'desc')
        .first();
      
      if (!latestSnapshot) {
        return reply.status(404).send({
          error: 'Address not found or has no snapshots',
        });
      }

      // Parse integration breakdown JSON
      let integrationBreakdown = {};
      try {
        integrationBreakdown = JSON.parse(latestSnapshot.integration_breakdown || '{}');
      } catch (e) {
        logger.warn(`Failed to parse integration breakdown for ${address}: ${e}`);
      }

      // Build full response data
      // USD values are stored with 6 implied decimals, so divide by 1,000,000
      const fullData = {
        address: latestSnapshot.address,
        snapshotDate: latestSnapshot.snapshot_date,
        totalDroplets: latestSnapshot.total_droplets,
        dailyDropletsEarned: latestSnapshot.daily_droplets_earned,
        totalUsdValue: (parseFloat(latestSnapshot.total_usd_value) / 1_000_000).toFixed(6),
        balances: {
          xeth: {
            shares: latestSnapshot.xeth_shares_total,
            usdValue: (parseFloat(latestSnapshot.xeth_usd_value) / 1_000_000).toFixed(6),
          },
          xbtc: {
            shares: latestSnapshot.xbtc_shares_total,
            usdValue: (parseFloat(latestSnapshot.xbtc_usd_value) / 1_000_000).toFixed(6),
          },
          xusd: {
            shares: latestSnapshot.xusd_shares_total,
            usdValue: (parseFloat(latestSnapshot.xusd_usd_value) / 1_000_000).toFixed(6),
          },
          xeur: {
            shares: latestSnapshot.xeur_shares_total,
            usdValue: (parseFloat(latestSnapshot.xeur_usd_value) / 1_000_000).toFixed(6),
          },
        },
        integrationBreakdown,
        snapshotTimestamp: latestSnapshot.snapshot_timestamp,
      };

      // Apply field filtering if requested
      if (fields && fields.length > 0) {
        const filteredData: any = {};
        const fieldMapping: { [key: string]: any } = {
          address: fullData.address,
          snapshotDate: fullData.snapshotDate,
          totalDroplets: fullData.totalDroplets,
          dailyDropletsEarned: fullData.dailyDropletsEarned,
          totalUsdValue: fullData.totalUsdValue,
          balances: fullData.balances,
          integrationBreakdown: fullData.integrationBreakdown,
          snapshotTimestamp: fullData.snapshotTimestamp,
        };

        for (const field of fields) {
          const trimmedField = field.trim();
          if (fieldMapping.hasOwnProperty(trimmedField)) {
            filteredData[trimmedField] = fieldMapping[trimmedField];
          }
        }

        return reply.send(filteredData);
      }

      return reply.send(fullData);
      
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid request parameters',
          details: error.errors,
        });
      }
      
      logger.error('Error fetching address balance:', error);
      return reply.status(500).send({
        error: 'Failed to fetch address balance',
      });
    }
  });
};
