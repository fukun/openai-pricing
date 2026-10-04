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

function captureUrl(result) {
  if (!/^\d{14}$/.test(String(result.timestamp)) || typeof result.original_url !== 'string') {
    throw new Error('Wayback reported success without a timestamped source URL.');
  }
  return `${BASE_URL}/web/${result.timestamp}/${result.original_url}`;
}

export async function saveAuthenticated(sourceUrl, credentials) {
  const signal = AbortSignal.timeout(180_000);
  const headers = authenticatedHeaders(credentials);
  const parameters = new URLSearchParams({ url: sourceUrl, skip_first_archive: '1' });
  if (process.env.IA_EMAIL_RESULT !== '0') parameters.set('email_result', '1');
  if (/\.(?:md|txt)(?:\?|$)/i.test(sourceUrl)) parameters.set('force_get', '1');
  const submitted = await readResponse(await fetch(`${BASE_URL}/save`, {
    method: 'POST', redirect: 'error', headers, body: parameters, signal,
  }));
  if (submitted.status === 'success') return captureUrl(submitted);
  if (typeof submitted.job_id !== 'string' || !/^[\w-]{1,150}$/.test(submitted.job_id)) {
    throw new Error('Wayback did not accept the authenticated capture request.');
  }
  const statusUrl = `${BASE_URL}/save/status/${encodeURIComponent(submitted.job_id)}`;
  while (!signal.aborted) {
    const result = await readResponse(await fetch(statusUrl, { headers, signal, redirect: 'error', cache: 'no-store' }));
    if (result.status === 'success') {
      return captureUrl(result);
    }
    if (result.status === 'error') throw new Error('Wayback reported a capture failure.');
    if (result.status !== 'pending') throw new Error('Wayback returned an unexpected capture status.');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Wayback capture did not complete within three minutes.');
}
