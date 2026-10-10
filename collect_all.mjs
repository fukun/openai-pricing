#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.env.COLLECTION_STARTED_AT_UTC = new Date().toISOString();
let firstProvider = true;
// Every provider is attempted even if another source is unavailable.
for (const [script, ...args] of [['collect_pricing.mjs'], ['collect_providers.mjs', 'deepseek'],
  ['collect_providers.mjs', 'claude'], ['collect_providers.mjs', 'gemini'], ['repair_archives.mjs']]) {
  // Space requests across providers to avoid Save Page Now rate limits.
  if (!firstProvider) await new Promise((resolve) => setTimeout(resolve, 30_000));
  firstProvider = false;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, join(root, script), ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (code !== 0) process.exitCode = 1;
}
