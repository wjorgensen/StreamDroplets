import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';

const logger = createLogger('API:Rounds');

const paramsSchema = z.object({
  asset: z.enum(['xETH', 'xBTC', 'xUSD', 'xEUR']),
});

export const roundsRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /rounds/:asset
   * Returns round history for an asset
   */
  fastify.get('/:asset', async (request, reply) => {
    try {
      const { asset } = paramsSchema.parse(request.params);
      
      const rounds = await db('rounds')
        .leftJoin('oracle_prices', function() {
          this.on('rounds.round_id', '=', 'oracle_prices.round_id')
            .andOn('rounds.asset', '=', 'oracle_prices.asset');
        })
        .where('rounds.asset', asset)
        .select(
          'rounds.round_id',
          'rounds.start_block',
          'rounds.start_ts',
          'rounds.end_ts',
          'rounds.pps',
          'rounds.pps_scale',
          'rounds.tx_hash',
          'oracle_prices.price_usd'
        )
        .orderBy('rounds.round_id', 'desc');
      
      return reply.send({
        asset,
        rounds: rounds.map(round => ({
          round_id: round.round_id,
          start_block: round.start_block,
          start_timestamp: round.start_ts,
          end_timestamp: round.end_ts,
          price_per_share: round.pps,
          pps_scale: round.pps_scale,
          oracle_price_usd: round.price_usd,
          tx_hash: round.tx_hash,
        })),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid asset',
          details: error.errors,
        });
      }
      
      logger.error('Error fetching rounds:', error);
      return reply.status(500).send({
        error: 'Failed to fetch rounds',
      });
    }
  });
  
  /**
   * GET /rounds/:asset/current
   * Returns current round info for an asset
   */
  fastify.get('/:asset/current', async (request, reply) => {
    try {
      const { asset } = paramsSchema.parse(request.params);
      
      const currentRound = await db('rounds')
        .where('asset', asset)
        .whereNull('end_ts')
        .orderBy('round_id', 'desc')
        .first();
      
      if (!currentRound) {
        return reply.status(404).send({
          error: 'No current round found',
        });
      }
      
      return reply.send({
        asset,
        round_id: currentRound.round_id,
        start_block: currentRound.start_block,
        start_timestamp: currentRound.start_ts,
        price_per_share: currentRound.pps,
        pps_scale: currentRound.pps_scale,
      });
    } catch (error) {
      logger.error('Error fetching current round:', error);
      return reply.status(500).send({
        error: 'Failed to fetch current round',
      });
    }
  });
};