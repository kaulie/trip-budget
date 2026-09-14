import { createApp, createDeps } from './app.js';
import { llmConfigFromEnv } from './agent/llmParser.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';

const deps = createDeps();
const { server } = createApp(deps);
const llm = llmConfigFromEnv();

server.listen(port, host, () => {
  const mode = llm.enabled ? `LLM: ${llm.model} @ ${llm.baseUrl}` : 'LLM: disabled (rule parser only)';
  // eslint-disable-next-line no-console
  console.log(`[trip-budget] listening on http://${host}:${port} — ${mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`[trip-budget] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
