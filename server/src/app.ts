import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Repo } from './store/repo.js';
import { openDatabase } from './store/db.js';
import { AppError } from './lib/errors.js';
import { buildRouter } from './http/routes.js';
import { applyResult, readJsonBody, writeJson, type RequestContext } from './http/router.js';
import type { User } from './domain/types.js';

export interface AppDeps {
  repo: Repo;
  db: DatabaseSync;
}

export function createDeps(options: { dbPath?: string } = {}): AppDeps {
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? 'data/trip-budget.sqlite';
  const db = openDatabase(dbPath);
  return { repo: new Repo(db), db };
}

function authenticate(deps: AppDeps, req: IncomingMessage): User | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return deps.repo.findUser(match[1]!.trim());
}

export function createApp(deps: AppDeps): { server: Server; deps: AppDeps } {
  const router = buildRouter(deps);

  const server = createServer((req, res) => {
    void (async () => {
      // The MVP is used by the native app; CORS is here so the same API can be
      // exercised from a browser during development.
      const corsHeaders: Record<string, string> = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization, x-client-date, x-device-id',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      };

      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const method = (req.method ?? 'GET').toUpperCase();
        const match = router.match(method, url.pathname);
        if (!match) {
          writeJson(res, 404, { error: { code: 'not_found', message: 'no such route', path: url.pathname } }, corsHeaders);
          return;
        }

        const body = method === 'GET' || method === 'DELETE' ? undefined : await readJsonBody(req);
        const ctx: RequestContext = {
          req,
          method,
          path: url.pathname,
          query: url.searchParams,
          params: match.params,
          body,
          user: authenticate(deps, req),
          deps,
        };

        const result = await match.handler(ctx);
        if (result && result.headers) {
          applyResult(res, { ...result, headers: { ...corsHeaders, ...result.headers } });
        } else {
          applyResult(res, { ...(result ?? {}), headers: corsHeaders });
        }
      } catch (error) {
        if (error instanceof AppError) {
          writeJson(res, error.status, error.toJSON(), corsHeaders);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error('[trip-budget] unhandled error:', error);
        writeJson(
          res,
          500,
          { error: { code: 'internal', message: 'internal error', details: { message } } },
          corsHeaders,
        );
      }
    })();
  });

  return { server, deps };
}
