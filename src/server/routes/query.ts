// =============================================================================
// Fleet Commander — Query Routes (CC Query Service)
// =============================================================================
// Fastify plugin exposing predefined CC structured queries via REST API.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { CCQueryService } from '../services/cc-query.js';

const VALID_QUERY_NAMES = ['prioritizeIssues', 'estimateComplexity', 'suggestAssignmentOrder'] as const;
type QueryName = (typeof VALID_QUERY_NAMES)[number];

function isValidQueryName(name: string): name is QueryName {
  return (VALID_QUERY_NAMES as readonly string[]).includes(name);
}

const queryRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // POST /api/query/:queryName
  fastify.post(
    '/api/query/:queryName',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { queryName } = request.params as { queryName: string };

      if (!isValidQueryName(queryName)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Unknown query "${queryName}". Valid queries: ${VALID_QUERY_NAMES.join(', ')}`,
        });
      }

      const body = request.body as Record<string, unknown> | null;
      if (!body) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Request body is required',
        });
      }

      const service = CCQueryService.getInstance();

      try {
        switch (queryName) {
          case 'prioritizeIssues': {
            const issues = body.issues as { number: number; title: string }[];
            if (!Array.isArray(issues)) {
              return reply.code(400).send({
                error: 'Bad Request',
                message: 'Field "issues" must be an array of { number, title }',
              });
            }
            const result = await service.prioritizeIssues(issues);
            if (!result.success) {
              request.log.warn({ error: result.error, text: result.text }, `CC query "prioritizeIssues" returned no data`);
            }
            return reply.code(200).send(result);
          }

          case 'estimateComplexity': {
            const issueTitle = body.issueTitle as string;
            const issueBody = body.issueBody as string;
            if (typeof issueTitle !== 'string' || typeof issueBody !== 'string') {
              return reply.code(400).send({
                error: 'Bad Request',
                message: 'Fields "issueTitle" and "issueBody" are required strings',
              });
            }
            const result = await service.estimateComplexity(issueTitle, issueBody);
            return reply.code(200).send(result);
          }

          case 'suggestAssignmentOrder': {
            const issues = body.issues as { number: number; title: string; labels: string[] }[];
            const constraints = body.constraints as { maxConcurrent: number; preferredOrder?: 'priority' | 'complexity' | 'fifo' };
            if (!Array.isArray(issues) || !constraints || typeof constraints.maxConcurrent !== 'number') {
              return reply.code(400).send({
                error: 'Bad Request',
                message: 'Fields "issues" (array) and "constraints" ({ maxConcurrent: number }) are required',
              });
            }
            const result = await service.suggestAssignmentOrder(issues, constraints);
            return reply.code(200).send(result);
          }
        }
      } catch (err: unknown) {
        request.log.error(err, `CC query "${queryName}" failed`);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default queryRoutes;
