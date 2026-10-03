#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, PARSERS } from './pricing_sources.mjs';
import { recordCollection, saveLog } from './provider_store.mjs';

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), 'data');
const selected = process.argv.slice(2);
const providers = selected.length ? selected : Object.keys(PROVIDERS);
for (const provider of providers) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}`);
  const now = new Date();
  try {
    const response = await fetch(PROVIDERS[provider].fetchUrl, {
      headers: { 'user-agent': 'model-pricing-history/1.0 (+https://github.com/fukun/openai-pricing)' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`);
    const source = await response.text();
    const rows = PARSERS[provider](source);
    const log = await recordCollection({ provider, rows, source, now, dataDirectory });
    console.log(`${PROVIDERS[provider].name}: ${log.model_count} models; ${log.status}; Wayback ${log.archive_status}.`);
    if (log.archive_error) console.warn(`Archive will be retried: ${log.archive_error}`);
  } catch (error) {
    await saveLog(join(dataDirectory, provider), { provider, date_utc: now.toISOString().slice(0, 10),
      collected_at_utc: now.toISOString(), status: 'failed', error: error.message });
    console.error(`${PROVIDERS[provider].name}: ${error.message}`);
    process.exitCode = 1;
  }
}
