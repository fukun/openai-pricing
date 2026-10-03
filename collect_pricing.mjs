#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_URL = 'https://developers.openai.com/api/docs/pricing';
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), 'data/pricing_history.jsonl');
const MODEL_NAME = /^gpt-(?:5|[6-9]|[1-9]\d)(?:[.-]|$)/i;
const MODES = ['Standard', 'Batch'];

function decodeHtml(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cellText(html) {
  return decodeHtml(html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTables(html) {
  const tables = [];
  for (const tableMatch of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = [];
    for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
        cells.push({ tag: cellMatch[1].toLowerCase(), text: cellText(cellMatch[2]) });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function modelRows(tables, mode) {
  const records = [];
  for (const rows of tables) {
    const headers = rows.filter((row) => row.every((cell) => cell.tag === 'th'))
      .map((row) => row.map((cell) => cell.text));
    for (const row of rows) {
      const values = row.map((cell) => cell.text);
      const model = values[0]?.replace(/^`|`$/g, '');
      if (MODEL_NAME.test(model ?? '')) {
        records.push({ model, pricing_mode: mode, table_headers: headers, prices: values });
      }
    }
  }
  return records;
}

async function getPrices(mode) {
  const url = `${PAGE_URL}?latest-pricing=${mode.toLowerCase()}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'openai-pricing-history/1.0 (+https://developers.openai.com/api/docs/pricing)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const html = await response.text();
  const records = modelRows(parseTables(html), mode);
  if (!records.length) {
    throw new Error(`No GPT-5+ model pricing rows found for ${mode}; no snapshot was written.`);
  }
  return records.map((record) => ({ ...record, source_url: url }));
}

const now = new Date();
const timestamp = now.toISOString();
const date = timestamp.slice(0, 10);
const todaysRows = [];
for (const mode of MODES) todaysRows.push(...await getPrices(mode));

// Merge by day/model/mode/table so reruns replace today's rows instead of duplicating them.
let previousRows = [];
try {
  const content = await readFile(OUTPUT, 'utf8');
  previousRows = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const keyed = new Map();
for (const row of [...previousRows, ...todaysRows.map((row) => ({
  collected_at_utc: timestamp,
  date_utc: date,
  ...row,
}))]) {
  const key = [row.date_utc, row.model, row.pricing_mode, JSON.stringify(row.table_headers)].join('\u0000');
  keyed.set(key, row);
}

await mkdir(dirname(OUTPUT), { recursive: true });
const history = [...keyed.values()].sort((a, b) =>
  a.date_utc.localeCompare(b.date_utc)
  || a.model.localeCompare(b.model)
  || a.pricing_mode.localeCompare(b.pricing_mode));
await writeFile(OUTPUT, `${history.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(`Saved ${todaysRows.length} GPT-5+ pricing rows for ${date} to ${OUTPUT}`);
