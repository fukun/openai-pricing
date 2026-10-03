import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDERS } from './pricing_sources.mjs';

export async function readJsonLines(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function snapshotSignature(rows) {
  const values = rows.map((row) => ({ model: row.model, model_version: row.model_version,
    source_model_label: row.source_model_label, pricing_mode: row.pricing_mode,
    pricing_tier: row.pricing_tier, price_unit: row.price_unit, price_units: row.price_units, pricing_notes: row.pricing_notes,
    table_headers: row.table_headers, prices: row.prices.slice(1) }));
  return JSON.stringify(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

async function writeJsonLines(file, rows) {
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

export async function saveLog(directory, entry) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'collection_log.jsonl');
  const byDate = new Map((await readJsonLines(file)).map((row) => [row.date_utc, row]));
  byDate.set(entry.date_utc, entry);
  await writeJsonLines(file, [...byDate.values()].sort((a, b) => a.date_utc.localeCompare(b.date_utc)));
}

export async function archiveSource(sourceUrl) {
  const response = await fetch(`https://web.archive.org/save/${sourceUrl}`, {
    redirect: 'manual', signal: AbortSignal.timeout(40_000),
    headers: { 'user-agent': 'model-pricing-history/1.0 (+https://github.com/fukun/openai-pricing)' },
  });
  const location = response.headers.get('location') ?? response.headers.get('content-location');
  if (!response.ok && (response.status < 300 || response.status >= 400)) {
    throw new Error(`Save Page Now returned HTTP ${response.status}`);
  }
  if (!location) throw new Error('Save Page Now did not return a timestamped capture URL.');
  const url = new URL(location, 'https://web.archive.org/');
  if (url.hostname !== 'web.archive.org' || !/^\/web\/\d{14}(?:[a-z_]+)?\/https?:\/\//.test(url.pathname)) {
    throw new Error('Save Page Now has not returned a completed capture.');
  }
  return url.href;
}

export async function recordCollection({ provider, rows, source, now = new Date(), dataDirectory, archive = archiveSource }) {
  if (!rows.length) throw new Error('Refusing to replace history with empty pricing data.');
  const config = PROVIDERS[provider];
  const directory = join(dataDirectory, provider);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'pricing_history.jsonl');
  const previous = await readJsonLines(file);
  const date = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();
  const latestDate = previous.reduce((latest, row) => row.date_utc > latest ? row.date_utc : latest, '');
  const latest = previous.filter((row) => row.date_utc === latestDate);
  const changed = !latest.length || snapshotSignature(latest) !== snapshotSignature(rows);
  let snapshot = latest;
  if (changed) {
    const sourcePath = `data/${provider}/sources/${timestamp.replaceAll(':', '-')}.${config.extension}`;
    await mkdir(join(directory, 'sources'), { recursive: true });
    await writeFile(join(directory, 'sources', sourcePath.split('/').at(-1)), source, 'utf8');
    snapshot = rows.map((row) => ({ ...row, provider, collected_at_utc: timestamp, date_utc: date,
      source_url: config.sourceUrl, source_snapshot: sourcePath, archive_source_url: config.archiveUrl }));
  }
  let archiveError;
  let waybackUrl = snapshot.find((row) => row.wayback_url)?.wayback_url;
  // An unchanged price check only retries an earlier failed archive. It never
  // creates a new price snapshot or a new local source copy.
  if (!waybackUrl) {
    try { waybackUrl = await archive(config.archiveUrl); }
    catch (error) { archiveError = error.message; }
  }
  snapshot = snapshot.map((row) => ({ ...row, archive_status: waybackUrl ? 'saved' : 'pending',
    ...(waybackUrl ? { wayback_url: waybackUrl } : {}) }));
  if (changed || (!latest.some((row) => row.wayback_url) && waybackUrl)) {
    const merged = new Map();
    const retained = changed ? previous.filter((row) => row.date_utc !== date) : previous;
    for (const row of [...retained, ...snapshot]) {
      const key = JSON.stringify([row.date_utc, row.model, row.pricing_mode, row.pricing_tier ?? '', row.price_unit, row.table_headers]);
      merged.set(key, row);
    }
    await writeJsonLines(file, [...merged.values()].sort((a, b) => a.date_utc.localeCompare(b.date_utc)
      || a.model.localeCompare(b.model) || a.pricing_mode.localeCompare(b.pricing_mode)
      || (a.pricing_tier ?? '').localeCompare(b.pricing_tier ?? '')));
  }
  const log = { provider, date_utc: date, collected_at_utc: timestamp, status: changed ? 'changed' : 'unchanged',
    model_count: new Set(rows.map((row) => row.model)).size,
    model_order: [...new Set(rows.map((row) => row.model))], pricing_rows: changed ? rows.length : 0,
    latest_snapshot_date: changed ? date : latestDate, archive_status: waybackUrl ? 'saved' : 'pending',
    ...(waybackUrl ? { wayback_url: waybackUrl } : {}), ...(archiveError ? { archive_error: archiveError } : {}) };
  await saveLog(directory, log);
  return log;
}
