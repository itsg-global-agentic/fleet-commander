// @deprecated — cost tracking has been removed; usage tracking replaces it.
// This file is kept as an empty plugin for backwards compatibility
// in case any external code imports it.

import type {
  FastifyInstance,
  FastifyPluginCallback,
} from 'fastify';

const costsRoutes: FastifyPluginCallback = (
  _fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // No routes — cost tracking has been removed.
  done();
};

export default costsRoutes;
