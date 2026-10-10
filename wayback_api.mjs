import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'https://web.archive.org';
const USER_AGENT = 'model-pricing-history/1.0 (+https://github.com/fukun/openai-pricing)';

export function waybackCredentials() {
  const accessKey = process.env.IA_ACCESS_KEY?.trim();
  const secretKey = process.env.IA_SECRET_KEY?.trim();
  if (!accessKey && !secretKey) return null;
  if (!accessKey || !secretKey) throw new Error('Both IA_ACCESS_KEY and IA_SECRET_KEY must be configured.');
  return { accessKey, secretKey };
}

function authenticatedHeaders(credentials) {
  return { Accept: 'application/json', 'User-Agent': USER_AGENT,
    Authorization: `LOW ${credentials.accessKey}:${credentials.secretKey}` };
}

async function readResponse(response) {
  if (!response.ok) throw new Error(`Wayback authenticated API returned HTTP ${response.status}.`);
  // Do not include server response text in logs: it may contain account details.
  try { return await response.json(); }
  catch { throw new Error('Wayback authenticated API did not return JSON.'); }
}

async function requestJson(url, options) {
  // Retry transient failures without losing the current job or its source URL.
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await fetch(url, options); }
    catch (error) {
      if (options.signal.aborted) throw new Error('Wayback capture did not complete within three minutes.');
      if (attempt >= 2) throw error;
      await sleep((attempt + 1) * 5000, undefined, { signal: options.signal });
      continue;
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt >= 2) return readResponse(response);
    const retryAfter = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter)
      : (Date.parse(retryAfter ?? '') - Date.now()) / 1000;
    const fallbackDelay = response.status === 429 ? 60_000 : (attempt + 1) * 5000;
    const delay = Math.min(180_000, Math.max(5000, Number.isFinite(seconds) ? seconds * 1000 : fallbackDelay));
    await response.body?.cancel();
    await sleep(delay, undefined, { signal: options.signal });
  }
}

function captureUrl(result) {
  const timestamp = String(result.timestamp);
  const iso = /^\d{14}$/.test(timestamp) ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z` : '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/\D/g, '').slice(0, 14) !== timestamp
    || typeof result.original_url !== 'string') {
    throw new Error('Wayback reported success without a timestamped source URL.');
  }
  return `${BASE_URL}/web/${timestamp}/${result.original_url}`;
}

export async function saveAuthenticated(sourceUrl, credentials) {
  const signal = AbortSignal.timeout(180_000);
  try { return await runCapture(sourceUrl, credentials, signal); }
  catch (error) {
    if (signal.aborted) throw new Error('Wayback capture did not complete within three minutes.');
    throw error;
  }
}

async function runCapture(sourceUrl, credentials, signal) {
  const headers = authenticatedHeaders(credentials);
  const parameters = new URLSearchParams({ url: sourceUrl, skip_first_archive: '1' });
  if (process.env.IA_EMAIL_RESULT !== '0') parameters.set('email_result', '1');
  if (/\.(?:md|txt)(?:\?|$)/i.test(sourceUrl)) parameters.set('force_get', '1');
  const submitted = await requestJson(`${BASE_URL}/save`, {
    method: 'POST', redirect: 'error', headers, body: parameters, signal,
  });
  if (submitted.status === 'success') return captureUrl(submitted);
  if (typeof submitted.job_id !== 'string' || !/^[\w-]{1,150}$/.test(submitted.job_id)) {
    throw new Error('Wayback did not accept the authenticated capture request.');
  }
  const statusUrl = `${BASE_URL}/save/status/${encodeURIComponent(submitted.job_id)}`;
  while (!signal.aborted) {
    const result = await requestJson(statusUrl, { headers, signal, redirect: 'error', cache: 'no-store' });
    if (result.status === 'success') {
      return captureUrl(result);
    }
    if (result.status === 'error') {
      const reason = /^error:[a-z0-9-]+$/.test(result.status_ext ?? '') ? ` (${result.status_ext})` : '';
      throw new Error(`Wayback reported a capture failure${reason}.`);
    }
    if (result.status !== 'pending') throw new Error('Wayback returned an unexpected capture status.');
    await sleep(5000, undefined, { signal });
  }
  throw new Error('Wayback capture did not complete within three minutes.');
}
