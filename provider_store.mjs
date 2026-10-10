import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { PROVIDERS, PARSERS } from './pricing_sources.mjs';
import { saveAuthenticated, waybackCredentials } from './wayback_api.mjs';

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

export async function writeJsonLines(file, rows) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function snapshotRowKey(row) {
  return JSON.stringify([row.date_utc, row.model, row.model_version, row.source_model_label ?? row.model,
    row.pricing_mode, row.pricing_tier, row.price_unit, row.price_units, row.table_headers]);
}

export function groupSnapshots(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.date_utc)) groups.set(row.date_utc, []);
    groups.get(row.date_utc).push(row);
  }
  return groups;
}

export async function restoreStoredSnapshots(provider, history, dataDirectory) {
  const restoredDates = [];
  const restored = [];
  for (const [date, snapshot] of groupSnapshots(history)) {
    const sourcePath = snapshot[0].source_snapshot;
    if (!sourcePath) { restored.push(...snapshot); continue; }
    let parsed;
    try { parsed = PARSERS[provider](await readFile(resolve(dataDirectory, sourcePath.replace(/^data\//, '')), 'utf8')); }
    catch (error) {
      console.warn(`${PROVIDERS[provider].name}: could not restore saved source for ${date}: ${error.message}`);
      restored.push(...snapshot);
      continue;
    }
    if (snapshotSignature(parsed) === snapshotSignature(snapshot)) { restored.push(...snapshot); continue; }
    // Recover complete price variants from the original captured document, keeping its date and archive metadata.
    const fields = ['provider', 'date_utc', 'collected_at_utc', 'source_url', 'source_snapshot',
      'archive_source_url', 'archive_status', 'wayback_url', 'candidate_archive_url', 'archive_checked_at_utc',
      'archive_reused_from_date'];
    const metadata = Object.fromEntries(fields.filter((key) => snapshot[0][key] !== undefined)
      .map((key) => [key, snapshot[0][key]]));
    restored.push(...parsed.map((row) => ({ ...metadata, ...row })));
    restoredDates.push(date);
  }
  return { rows: restored, restoredDates };
}

export async function saveLog(directory, entry) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'collection_log.jsonl');
  const byDate = new Map((await readJsonLines(file)).map((row) => [row.date_utc, row]));
  byDate.set(entry.date_utc, entry);
  await writeJsonLines(file, [...byDate.values()].sort((a, b) => a.date_utc.localeCompare(b.date_utc)));
}

export function createArchiveSourceUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  url.searchParams.set('capture_id', randomBytes(16).toString('hex'));
  return url.href;
}

export async function archiveSource(sourceUrl, options = {}) {
  const credentials = waybackCredentials();
  if (credentials) {
    const captureUrl = await saveAuthenticated(sourceUrl, credentials);
    try { return await verifyArchive(captureUrl, sourceUrl, options); }
    catch (error) {
      if (error.code === 'WAYBACK_REPLAY_PENDING') error.candidate_url = captureUrl;
      throw error;
    }
  }
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
  try { return await verifyArchive(url.href, sourceUrl, options); }
  catch (error) {
    if (error.code === 'WAYBACK_REPLAY_PENDING') error.candidate_url = url.href;
    throw error;
  }
}

export async function verifyArchive(archiveUrl, sourceUrl, options = {}) {
  // Finish verification within this collection run, with bounded retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await verifyReplay(archiveUrl, sourceUrl, options); }
    catch (error) {
      if (error.code !== 'WAYBACK_REPLAY_PENDING' || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
    }
  }
}

async function verifyReplay(archiveUrl, sourceUrl, { provider, rows, source } = {}) {
  const url = new URL(archiveUrl);
  if (url.hostname !== 'web.archive.org' || !/^\/web\/\d{14}(?:[a-z_]+)?\/https?:\/\//.test(url.pathname)) {
    throw new Error('Invalid timestamped Wayback capture URL.');
  }
  const canonicalTarget = (value) => {
    const target = new URL(value);
    target.pathname = target.pathname.replace(/\/+$/, '') || '/';
    return target.href;
  };
  const expectedTarget = canonicalTarget(sourceUrl);
  const capture = url.pathname.match(/^\/web\/(\d{14})(?:[a-z_]+)?\/(.+)$/);
  if (canonicalTarget(capture[2] + url.search) !== expectedTarget) throw new Error('Wayback capture targets a different source URL.');
  const replayUrl = `https://web.archive.org/web/${capture[1]}id_/${capture[2]}${url.search}`;
  const replay = await fetch(replayUrl, { signal: AbortSignal.timeout(40_000) });
  const replayLocation = new URL(replay.url);
  if (replayLocation.hostname !== 'web.archive.org') throw new Error('Wayback replay redirects outside the archive service.');
  const actual = replayLocation.pathname.match(/^\/web\/(\d{14})(?:[a-z_]+)?\/(.+)$/);
  if (!replay.ok || !actual) {
    const error = new Error('Wayback capture is not yet available at its requested timestamp.');
    error.code = 'WAYBACK_REPLAY_PENDING';
    throw error;
  }
  if (canonicalTarget(actual[2] + new URL(replay.url).search) !== expectedTarget) {
    throw new Error('Wayback replay targets a different source URL.');
  }
  const body = await replay.text();
  let matches = false;
  try {
    if (provider && rows) matches = snapshotSignature(PARSERS[provider](body)) === snapshotSignature(rows);
    else if (source !== undefined) matches = body.replaceAll('\r\n', '\n').trim() === source.replaceAll('\r\n', '\n').trim();
  } catch { matches = false; }
  if (!matches) {
    const error = new Error('Wayback replay content does not match the collected snapshot.');
    // An older fallback may disappear once the newly saved capture is indexed.
    if (actual[1] !== capture[1]) error.code = 'WAYBACK_REPLAY_PENDING';
    throw error;
  }
  // Older captures are usable when their verified content matches exactly.
  return `https://web.archive.org/web/${actual[1]}/${actual[2]}${new URL(replay.url).search}`;

}

export async function recordCollection({ provider, rows, source, now = new Date(), dataDirectory, archive = archiveSource, verify = verifyArchive }) {
  if (!rows.length) throw new Error('Refusing to replace history with empty pricing data.');
  const config = PROVIDERS[provider];
  const directory = join(dataDirectory, provider);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'pricing_history.jsonl');
  const recovered = await restoreStoredSnapshots(provider, await readJsonLines(file), dataDirectory);
  const previous = recovered.rows;
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
  let archiveSourceUrl = snapshot.find((row) => row.archive_source_url)?.archive_source_url || config.archiveUrl;
  let waybackUrl = snapshot.find((row) => row.wayback_url)?.wayback_url;
  let candidateUrl = snapshot.find((row) => row.candidate_archive_url)?.candidate_archive_url;
  const existingUrl = waybackUrl || candidateUrl;
  if (existingUrl) {
    try { waybackUrl = await verify(existingUrl, archiveSourceUrl, { provider, rows }) || existingUrl; candidateUrl = undefined; }
    catch (error) {
      waybackUrl = undefined;
      candidateUrl = error.code === 'WAYBACK_REPLAY_PENDING' ? existingUrl : undefined;
      archiveError = error.message;
    }
  }
  // Retain failed capture URLs for retry, while reporting this run as unsuccessful.
  if (!waybackUrl && !candidateUrl) {
    archiveSourceUrl = createArchiveSourceUrl(config.archiveUrl);
    try { waybackUrl = await archive(archiveSourceUrl, { provider, rows }); archiveError = undefined; }
    catch (error) { archiveError = error.message; candidateUrl = error.candidate_url; }
  }
  const archiveStatus = waybackUrl ? 'saved' : 'pending';
  const previousArchive = snapshot.map((row) => [row.archive_status, row.wayback_url, row.candidate_archive_url, row.archive_source_url]);
  snapshot = snapshot.map(({ wayback_url, candidate_archive_url, ...row }) => ({ ...row, archive_status: archiveStatus,
    archive_source_url: archiveSourceUrl,
    ...(waybackUrl ? { wayback_url: waybackUrl } : {}), ...(candidateUrl ? { candidate_archive_url: candidateUrl } : {}) }));
  const archiveChanged = JSON.stringify(previousArchive) !== JSON.stringify(snapshot.map((row) => [row.archive_status, row.wayback_url, row.candidate_archive_url, row.archive_source_url]));
  if (changed || archiveChanged || recovered.restoredDates.length) {
    const merged = new Map();
    const retained = changed ? previous.filter((row) => row.date_utc !== date) : previous;
    for (const row of [...retained, ...snapshot]) {
      const key = snapshotRowKey(row);
      merged.set(key, row);
    }
    await writeJsonLines(file, [...merged.values()].sort((a, b) => a.date_utc.localeCompare(b.date_utc)
      || a.model.localeCompare(b.model) || a.pricing_mode.localeCompare(b.pricing_mode)
      || (a.pricing_tier ?? '').localeCompare(b.pricing_tier ?? '')));
  }
  const log = { provider, date_utc: date, collected_at_utc: timestamp, status: changed ? 'changed' : 'unchanged',
    model_count: new Set(rows.map((row) => row.model)).size,
    model_order: [...new Set(rows.map((row) => row.model))], pricing_rows: changed ? rows.length : 0,
    latest_snapshot_date: changed ? date : latestDate, archive_status: archiveStatus, archive_source_url: archiveSourceUrl,
    ...(recovered.restoredDates.length ? { restored_snapshot_dates: recovered.restoredDates } : {}),
    ...(waybackUrl ? { wayback_url: waybackUrl } : {}), ...(candidateUrl ? { candidate_archive_url: candidateUrl } : {}),
    ...(archiveError ? { archive_error: archiveError } : {}) };
  await saveLog(directory, log);
  return log;
}
