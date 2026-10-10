#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './pricing_sources.mjs';
import { archiveSource, createArchiveSourceUrl, groupSnapshots, readJsonLines, restoreStoredSnapshots,
  saveLog, snapshotSignature, verifyArchive, writeJsonLines } from './provider_store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, 'data');
const configs = { openai: { name: 'OpenAI', archiveUrl: 'https://developers.openai.com/api/docs/pricing.md' }, ...PROVIDERS };
const now = new Date();
const today = now.toISOString().slice(0, 10);
// Bound the backlog processed during one collection; remaining dates stay visible in the report.
let remainingRepairs = 3;
const summary = [];

const isSaved = (snapshot) => snapshot.every((row) => row.archive_status === 'saved' && row.wayback_url);
const normalizedSource = (source) => source.replaceAll('\r\n', '\n').trim();

for (const [provider, config] of Object.entries(configs)) {
  try {
  const directory = provider === 'openai' ? dataDirectory : join(dataDirectory, provider);
  const historyFile = join(directory, 'pricing_history.jsonl');
  let history = await readJsonLines(historyFile);
  let modified = false;
  if (provider !== 'openai') {
    const restored = await restoreStoredSnapshots(provider, history, dataDirectory);
    history = restored.rows;
    modified = restored.restoredDates.length > 0;
  }
  const snapshots = groupSnapshots(history);
  const dates = [...snapshots.keys()].sort();
  const latestDate = dates.at(-1);
  const sourceCache = new Map();
  async function originalSource(snapshot) {
    const path = snapshot[0].source_snapshot;
    if (!path) throw new Error('The original source document is missing for this historical snapshot.');
    if (!sourceCache.has(path)) sourceCache.set(path, readFile(resolve(root, path), 'utf8'));
    return sourceCache.get(path);
  }
  async function sameContent(left, right) {
    return provider === 'openai'
      ? normalizedSource(await originalSource(left)) === normalizedSource(await originalSource(right))
      : snapshotSignature(left) === snapshotSignature(right);
  }
  const repairedDates = [];
  const errors = [];
  for (const date of dates) {
    const snapshot = snapshots.get(date);
    // The regular collector already attempted the latest price snapshot in this run.
    if (date === latestDate || isSaved(snapshot) || !remainingRepairs) continue;
    remainingRepairs--;
    let waybackUrl;
    let sourceUrl = snapshot[0].archive_source_url || config.archiveUrl;
    let reusedFromDate;
    let candidateUrl = snapshot.find((row) => row.candidate_archive_url)?.candidate_archive_url;
    try {
      const options = provider === 'openai' ? { source: await originalSource(snapshot) } : { provider, rows: snapshot };
      if (candidateUrl) {
        try { waybackUrl = await verifyArchive(candidateUrl, sourceUrl, options); }
        catch (error) {
          if (error.code !== 'WAYBACK_REPLAY_PENDING') candidateUrl = undefined;
        }
      }
      // Reuse a verified version only when all monitored prices and conditions match the historical snapshot.
      if (!waybackUrl) {
        for (const otherDate of [...dates].reverse()) {
          const other = snapshots.get(otherDate);
          if (!isSaved(other) || !await sameContent(snapshot, other)) continue;
          try {
            const target = other[0].archive_source_url || config.archiveUrl;
            waybackUrl = await verifyArchive(other[0].wayback_url, target, options);
            sourceUrl = target;
            reusedFromDate = otherDate;
            break;
          } catch { /* A previously saved link may be temporarily unavailable; try the next version. */ }
        }
      }
      if (!waybackUrl && !candidateUrl) {
        if (!await sameContent(snapshot, snapshots.get(latestDate))) {
          throw new Error('Current official prices differ from this historical snapshot; a matching archived version is required.');
        }
        sourceUrl = createArchiveSourceUrl(config.archiveUrl);
        try { waybackUrl = await archiveSource(sourceUrl, options); }
        catch (error) { candidateUrl = error.candidate_url; throw error; }
      }
      if (!waybackUrl) throw new Error('The historical capture is not available yet; its returned address has been retained.');
      repairedDates.push(date);
      console.log(`${config.name}: repaired archive for ${date}${reusedFromDate ? ` using matching prices from ${reusedFromDate}` : ''}.`);
    } catch (error) {
      errors.push({ date_utc: date, error: error.message });
      console.warn(`${config.name}: archive for ${date} remains pending: ${error.message}`);
    }
    const updated = snapshot.map(({ wayback_url, candidate_archive_url, archive_reused_from_date, ...row }) => ({ ...row,
      archive_status: waybackUrl ? 'saved' : 'pending', archive_source_url: sourceUrl,
      archive_checked_at_utc: now.toISOString(),
      ...(waybackUrl ? { wayback_url: waybackUrl } : {}),
      ...(!waybackUrl && candidateUrl ? { candidate_archive_url: candidateUrl } : {}),
      ...(reusedFromDate ? { archive_reused_from_date: reusedFromDate } : {}) }));
    snapshots.set(date, updated);
    modified = true;
    if (waybackUrl) {
      const pastLog = (await readJsonLines(join(directory, 'collection_log.jsonl'))).find((entry) => entry.date_utc === date);
      if (pastLog) {
        const { archive_error, candidate_archive_url, ...entry } = pastLog;
        await saveLog(directory, { ...entry, archive_status: 'saved', archive_source_url: sourceUrl,
          wayback_url: waybackUrl, archive_repaired_at_utc: now.toISOString(),
          ...(reusedFromDate ? { archive_reused_from_date: reusedFromDate } : {}) });
      }
    }
  }
  if (modified) await writeJsonLines(historyFile, dates.flatMap((date) => snapshots.get(date)));
  const pendingDates = dates.filter((date) => !isSaved(snapshots.get(date)));
  const logs = await readJsonLines(join(directory, 'collection_log.jsonl'));
  const dailyLog = logs.find((entry) => entry.date_utc === today) || {
    provider, date_utc: today, collected_at_utc: now.toISOString(), status: 'failed', error: 'No collection log was recorded today.' };
  const runMetadata = { run_started_at_utc: process.env.COLLECTION_STARTED_AT_UTC || now.toISOString() };
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const started = new Date(runMetadata.run_started_at_utc);
    const scheduled = new Date(started);
    scheduled.setUTCHours(0, 17, 0, 0);
    runMetadata.scheduled_at_utc = scheduled.toISOString();
    runMetadata.schedule_delay_minutes = Math.max(0, Math.floor((started - scheduled) / 60_000));
  }
  await saveLog(directory, { ...dailyLog, ...runMetadata,
    archive_repair: { repaired_dates: repairedDates, pending_dates: pendingDates, errors } });
  summary.push(`| ${config.name} | ${dailyLog.status} | ${dailyLog.model_count ?? 0} | ${repairedDates.length} | ${pendingDates.length} |`);
  if (dailyLog.status === 'failed' || pendingDates.length) process.exitCode = 1;
  } catch (error) {
    console.error(`${config.name}: archive repair/report failed: ${error.message}`);
    summary.push(`| ${config.name} | repair/report failed | — | — | — |`);
    process.exitCode = 1;
  }
}
const report = ['## Pricing collection', '', '| Provider | Collection | Models | Archives repaired | Pending snapshot dates |',
  '| --- | --- | ---: | ---: | ---: |', ...summary].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
