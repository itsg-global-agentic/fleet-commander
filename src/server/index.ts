import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env['PORT'] ?? '4680', 10);

async function main() {
  const server = Fastify({ logger: true });

  await server.register(cors, { origin: true });

  // Health check
  server.get('/api/health', async (_request, _reply) => {
    return { status: 'ok' };
  });

  // Static file serving for production builds
  const clientDir = path.resolve(__dirname, '..', 'client');
  try {
    await server.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      wildcard: false,
    });
  } catch {
    server.log.warn(`Static file directory not found: ${clientDir}`);
  }

  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info(`Fleet Commander server listening on port ${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
