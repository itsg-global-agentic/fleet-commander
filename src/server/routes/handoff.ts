// =============================================================================
// Fleet Commander -- Handoff File Upload Route (multipart)
// =============================================================================
// Receives plan.md, changes.md, review.md files via multipart form upload
// from hook scripts. Replaces the old JSON-encoded approach that broke on
// Windows Git Bash due to awk/sed backslash escaping issues.
//
// Endpoint: POST /api/handoff
// Fields:
//   - team     (string) — worktree name
//   - fileType (string) — one of plan.md, changes.md, review.md
//   - file     (binary) — the file content
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import type { HandoffFileType } from '../../shared/types.js';

const VALID_FILE_TYPES = new Set<string>(['plan.md', 'changes.md', 'review.md']);
const MAX_FILE_SIZE = 51200; // 50KB cap, matching send_handoff.sh

const handoffRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // POST /api/handoff — receive a handoff file via multipart upload
  fastify.post(
    '/api/handoff',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Parse all multipart parts
        const parts = request.parts();

        let team: string | undefined;
        let fileType: string | undefined;
        let fileContent: string | undefined;

        for await (const part of parts) {
          if (part.type === 'field') {
            const field = part as MultipartValue<string>;
            if (field.fieldname === 'team') {
              team = String(field.value);
            } else if (field.fieldname === 'fileType') {
              fileType = String(field.value);
            }
          } else if (part.type === 'file') {
            const file = part as MultipartFile;
            if (file.fieldname === 'file') {
              const buf = await file.toBuffer();
              // Cap at 50KB
              fileContent = buf.subarray(0, MAX_FILE_SIZE).toString('utf-8');
            }
          }
        }

        // Validate required fields
        if (!team || !fileType) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Missing required fields: team, fileType',
          });
        }

        if (!VALID_FILE_TYPES.has(fileType)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Invalid fileType: ${fileType}. Must be one of: ${[...VALID_FILE_TYPES].join(', ')}`,
          });
        }

        if (!fileContent || fileContent.length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Missing or empty file content',
          });
        }

        // Resolve team from worktree name
        const db = getDatabase();
        const teamRecord = db.getTeamByWorktree(team);
        if (!teamRecord) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team not found for worktree: ${team}`,
          });
        }

        // Insert handoff file (with dedup — skips if identical content
        // was captured for the same team + file_type within 5 seconds)
        const { file: handoffFile, deduplicated } = db.insertHandoffFile({
          teamId: teamRecord.id,
          fileType: fileType as HandoffFileType,
          content: fileContent,
          agentName: null, // multipart upload doesn't carry agent name
        });

        // Only broadcast SSE when this is a genuinely new capture
        if (!deduplicated) {
          sseBroker.broadcast('team_handoff_file', {
            team_id: teamRecord.id,
            file_type: handoffFile.fileType,
            agent_name: handoffFile.agentName,
            captured_at: handoffFile.capturedAt,
          }, teamRecord.id);
        }

        return reply.code(200).send({ ok: true });
      } catch (err: unknown) {
        request.log.error(err, 'Handoff file upload failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to process handoff file upload',
        });
      }
    },
  );

  done();
};

export default handoffRoutes;
