#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveSource, createArchiveSourceUrl, verifyArchive, readJsonLines, saveLog, writeJsonLines,
  snapshotRowKey } from './provider_store.mjs';

const PAGE_URL = 'https://developers.openai.com/api/docs/pricing?latest-pricing=batch';
const ARCHIVE_PAGE_URL = 'https://developers.openai.com/api/docs/pricing.md';
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), 'data/pricing_history.jsonl');
const LOG_OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), 'data/collection_log.jsonl');
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

function unpackPageValue(value) {
  const item = Array.isArray(value) ? value[1] : value;
  if (item && typeof item === 'object' && item.__pricingHtml) {
    return cellText(item.__pricingHtml[1]);
  }
  if (item == null) return '-';
  return typeof item === 'number' ? `$${item}` : String(item);
}

function parseComponentData(source) {
  const longPricesLiteral = source.match(/var l=({[\s\S]*?}),u=/)?.[1];
  const latestModelLiteral = source.match(/E=new Set\(\[([\s\S]*?)\]\)/)?.[1];
  if (!longPricesLiteral || !latestModelLiteral) {
    throw new Error('OpenAI pricing component format changed; refusing to save incomplete prices.');
  }

  // The page bundle stores this section as a static object literal. Convert only
  // its literal syntax to JSON; never evaluate code from the remote page.
  const longPricesJson = longPricesLiteral
    .replace(/`([^`]*)`/g, (_, value) => JSON.stringify(value))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/(:\s*)(\.\d+)/g, (_, prefix, value) => `${prefix}0${value}`);
  const longPrices = JSON.parse(longPricesJson);
  const latestModels = new Set([...latestModelLiteral.matchAll(/`([^`]*)`/g)].map((match) => match[1]));
  return { longPrices, latestModels };
}

function modelRows(html, { longPrices, latestModels }) {
  const records = [];
  const islands = html.matchAll(/<astro-island\b(?=[^>]*\bcomponent-export="TextTokenPricingTables")[^>]*>/gi);

  for (const islandMatch of islands) {
    const propsValue = islandMatch[0].match(/\bprops="([^"]*)"/i)?.[1];
    if (!propsValue) continue;

    let props;
    try {
      props = JSON.parse(decodeHtml(propsValue));
    } catch (error) {
      throw new Error(`Could not parse OpenAI pricing table metadata: ${error.message}`);
    }
    const mode = props.tier?.[1];
    if (!MODES.some((item) => item.toLowerCase() === mode)) continue;

    const encodedRows = props.rows?.[1];
    if (!Array.isArray(encodedRows)) continue;
    for (const encodedRow of encodedRows) {
      const values = encodedRow?.[1]?.map(unpackPageValue);
      const sourceModelLabel = values?.[0]?.replace(/^`|`$/g, '');
      if (!MODEL_NAME.test(sourceModelLabel ?? '')) continue;

      // Keep the canonical model identifier separate from source annotations
      // embedded in the cell (for example, a context-length pricing condition).
      const model = sourceModelLabel.replace(/\s+\(<272K context length\)$/i, '');
      const normalizedModel = model;
      const isLatest = latestModels.has(normalizedModel);
      const shortValues = values.slice(1);
      let tableHeaders;
      let prices;
      if (isLatest) {
        const [input = '-', cachedInput = '-', cacheWrites = '-', output = '-'] = shortValues;
        const long = longPrices[mode]?.[normalizedModel] ?? {};
        tableHeaders = [[
          'Model', 'Input (short context)', 'Cached input (short context)',
          'Cache writes (short context)', 'Output (short context)',
          'Input (long context)', 'Cached input (long context)',
          'Cache writes (long context)', 'Output (long context)',
        ]];
        prices = [model, input, cachedInput, cacheWrites, output,
          unpackPageValue(long.input), unpackPageValue(long.cachedInput),
          unpackPageValue(long.cacheWrite), unpackPageValue(long.output)];
      } else if (shortValues.length === 4) {
        tableHeaders = [['Model', 'Input', 'Cached input', 'Cache writes', 'Output']];
        prices = [model, ...shortValues];
      } else {
        tableHeaders = [['Model', 'Input', 'Cached input', 'Output']];
        prices = [model, ...shortValues];
      }

      records.push({
        model,
        ...(sourceModelLabel !== model ? { source_model_label: sourceModelLabel } : {}),
        pricing_mode: mode[0].toUpperCase() + mode.slice(1),
        table_headers: tableHeaders,
        prices,
      });
    }
  }
  return records;
}

async function getPrices() {
  const response = await fetch(PAGE_URL, {
    headers: { 'user-agent': 'openai-pricing-history/1.0 (+https://developers.openai.com/api/docs/pricing)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${PAGE_URL} returned HTTP ${response.status}`);
  const html = await response.text();
  const componentPath = html.match(/<astro-island\b(?=[^>]*\bcomponent-export="TextTokenPricingTables")[^>]*component-url="([^"]+)"/i)?.[1];
  if (!componentPath) throw new Error('Could not find OpenAI pricing component metadata.');
  const componentUrl = new URL(decodeHtml(componentPath), new URL(PAGE_URL).origin).href;
  const componentResponse = await fetch(componentUrl, {
    headers: { 'user-agent': 'openai-pricing-history/1.0 (+https://developers.openai.com/api/docs/pricing)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!componentResponse.ok) throw new Error(`${componentUrl} returned HTTP ${componentResponse.status}`);
  const componentData = parseComponentData(await componentResponse.text());
  const records = modelRows(html, componentData).map((record) => ({ ...record, source_url: PAGE_URL }));
  for (const mode of MODES) {
    if (records.filter((record) => record.pricing_mode === mode).length < 10) {
      throw new Error(`No GPT-5+ model pricing rows found for ${mode}; no snapshot was written.`);
    }
  }
  return records;
}

async function writeCollectionLog(entry) {
  await saveLog(dirname(LOG_OUTPUT), entry);
}

function snapshotSignature(rows) {
  const snapshot = rows.map((row) => ({
    model: row.model,
    source_model_label: row.source_model_label ?? row.model,
    pricing_mode: row.pricing_mode,
    table_headers: row.table_headers,
    prices: row.prices.slice(1),
  }));
  return JSON.stringify(snapshot.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

const now = new Date();
const timestamp = now.toISOString();
const date = timestamp.slice(0, 10);
try {
  const todaysRows = await getPrices();
  const previousRows = (await readJsonLines(OUTPUT)).map((row) => {
    const canonicalModel = row.model?.replace(/\s+\(<272K context length\)$/i, '');
    if (canonicalModel && canonicalModel !== row.model) {
      row.source_model_label ??= row.model;
      row.model = canonicalModel;
    }
    return row;
  });
  const lastSnapshotDate = previousRows.reduce((latest, row) => row.date_utc > latest ? row.date_utc : latest, '');
  const lastSnapshot = previousRows.filter((row) => row.date_utc === lastSnapshotDate);
  const changed = !lastSnapshot.length || snapshotSignature(lastSnapshot) !== snapshotSignature(todaysRows);

  let snapshotRows = changed ? todaysRows.map((row) => ({ ...row, collected_at_utc: timestamp, date_utc: date })) : lastSnapshot;
  let waybackUrl = changed ? undefined : lastSnapshot.find((row) => row.wayback_url)?.wayback_url;
  let candidateUrl = changed ? undefined : lastSnapshot.find((row) => row.candidate_archive_url)?.candidate_archive_url;
  let archiveSourceUrl = changed ? ARCHIVE_PAGE_URL
    : lastSnapshot.find((row) => row.archive_source_url)?.archive_source_url || ARCHIVE_PAGE_URL;
  let archiveError;
  let archiveCorrection = false;
  let source;
  try {
    const localSource = !changed && lastSnapshot.find((row) => row.source_snapshot)?.source_snapshot;
    if (localSource) source = await readFile(resolve(dirname(OUTPUT), '..', localSource), 'utf8');
    else {
      const response = await fetch(ARCHIVE_PAGE_URL, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Markdown source returned HTTP ${response.status}`);
      source = await response.text();
    }
    if (changed) {
      const sourcePath = `data/sources/${timestamp.replaceAll(':', '-')}.md`;
      await mkdir(resolve(dirname(OUTPUT), 'sources'), { recursive: true });
      await writeFile(resolve(dirname(OUTPUT), '..', sourcePath), source);
      snapshotRows = snapshotRows.map((row) => ({ ...row, source_snapshot: sourcePath }));
    }
    const existingUrl = waybackUrl || candidateUrl;
    if (existingUrl) {
      try { waybackUrl = await verifyArchive(existingUrl, archiveSourceUrl, { source }); candidateUrl = undefined; }
      catch (error) {
        archiveCorrection = true;
        waybackUrl = undefined;
        candidateUrl = error.code === 'WAYBACK_REPLAY_PENDING' ? existingUrl : undefined;
        archiveError = error.message;
      }
    }
    if (!waybackUrl && !candidateUrl) {
      archiveSourceUrl = createArchiveSourceUrl(ARCHIVE_PAGE_URL);
      waybackUrl = await archiveSource(archiveSourceUrl, { source });
      archiveError = undefined;
    }
  } catch (error) {
    archiveError = error.message;
    if (waybackUrl) archiveCorrection = true;
    waybackUrl = undefined;
    candidateUrl = error.candidate_url || candidateUrl;
  }
  const archiveStatus = waybackUrl ? 'saved' : 'pending';
  const oldArchive = JSON.stringify(snapshotRows.map((row) => [row.archive_status, row.wayback_url, row.candidate_archive_url, row.archive_source_url]));
  snapshotRows = snapshotRows.map(({ wayback_url, candidate_archive_url, ...row }) => ({ ...row,
    archive_status: archiveStatus, archive_source_url: archiveSourceUrl, ...(waybackUrl ? { wayback_url: waybackUrl } : {}),
    ...(candidateUrl ? { candidate_archive_url: candidateUrl } : {}) }));
  archiveCorrection ||= oldArchive !== JSON.stringify(snapshotRows.map((row) => [row.archive_status, row.wayback_url, row.candidate_archive_url, row.archive_source_url]));
  const repaired = !lastSnapshot.some((row) => row.wayback_url) && waybackUrl;
  if (changed || archiveCorrection || repaired) {
    const keyed = new Map();
    const retained = changed ? previousRows.filter((row) => row.date_utc !== date) : previousRows;
    for (const row of [...retained, ...snapshotRows]) {
      const key = snapshotRowKey(row);
      keyed.set(key, row);
    }
    await mkdir(dirname(OUTPUT), { recursive: true });
    const history = [...keyed.values()].sort((a, b) => a.date_utc.localeCompare(b.date_utc)
      || a.model.localeCompare(b.model) || a.pricing_mode.localeCompare(b.pricing_mode));
    await writeJsonLines(OUTPUT, history);
  }
  await writeCollectionLog({
    collected_at_utc: timestamp, date_utc: date, status: changed ? 'changed' : 'unchanged',
    model_count: new Set(todaysRows.map((row) => row.model)).size,
    model_order: [...new Set(todaysRows.map((row) => row.model))],
    pricing_rows: changed ? todaysRows.length : 0, latest_snapshot_date: changed ? date : lastSnapshotDate,
    archive_status: archiveStatus, archive_source_url: archiveSourceUrl,
    ...(waybackUrl ? { wayback_url: waybackUrl } : {}), ...(candidateUrl ? { candidate_archive_url: candidateUrl } : {}),
    ...(archiveError ? { archive_error: archiveError } : {}),
  });
  console.log(`OpenAI: ${changed ? 'prices changed; saved snapshot' : 'prices unchanged; checked today'}; Wayback ${waybackUrl ? 'verified' : 'pending retry'}.`);

} catch (error) {
  await writeCollectionLog({
    collected_at_utc: timestamp,
    date_utc: date,
    status: 'failed',
    model_count: 0,
    pricing_rows: 0,
    error: error.message,
  });
  console.error(`Pricing collection failed for ${date}: ${error.message}`);
  process.exitCode = 1;
}
