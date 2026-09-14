import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A ~120-line router instead of a framework.
 *
 * The whole surface is 20 endpoints with one auth model and one error model; a
 * dependency here would buy nothing and cost reviewability.
 */

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

export interface RequestContext {
  req: IncomingMessage;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  user: import('../domain/types.js').User | null;
  deps: import('../app.js').AppDeps;
}

export interface RouteResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set for 204-style responses that must not carry a body. */
  empty?: boolean;
}

export type RouteHandler = (ctx: RequestContext) => Promise<RouteResult | void> | RouteResult | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter((segment) => segment !== ''),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, path: string): RouteMatch | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let pathExists = false;
    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i]!;
        const value = segments[i]!;
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathExists = true;
      if (route.method === method.toUpperCase()) return { handler: route.handler, params };
    }
    if (pathExists) return null;
    return null;
  }
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function applyResult(res: ServerResponse, result: RouteResult | void): void {
  if (!result) {
    writeJson(res, 200, {});
    return;
  }
  if (result.empty) {
    res.writeHead(result.status ?? 204, result.headers ?? {});
    res.end();
    return;
  }
  writeJson(res, result.status ?? 200, result.body ?? {}, result.headers ?? {});
}
