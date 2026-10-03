// Composite/context-dependent prices remain visible in the table, but must not
// turn into a misleading single number in a chart.
export function numericPrice(value) {
  const text = String(value ?? '').trim();
  if (/^(?:Free(?: of charge)?|免费)$/i.test(text)) return 0;
  const amounts = [...text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)];
  if (amounts.length !== 1) return null;
  const amount = Number(amounts[0][1].replaceAll(',', ''));
  return Number.isFinite(amount) ? amount : null;
}

export function priceUnit(value, fallback) {
  const text = String(value ?? '');
  const defaultUnit = fallback.replace(/^per (.+) in USD$/i, 'USD / $1');
  if ([...text.matchAll(/\$/g)].length > 1) return defaultUnit;
  const explicit = text.match(/\$\s*[\d,.]+\s*(?:\/|per\s+)\s*([^$()]*?)(?:$|\(|\bthrough|\bstarting)/i)?.[1]?.trim().replace(/\.$/, '');
  if (explicit) return `USD / ${/^MTok$/i.test(explicit) ? '1M tokens' : explicit}`;
  return defaultUnit;
}

// Formatting changes only the presentation; exports and collection retain raw values.
export function compactPriceLabel(value) {
  return String(value ?? '')
    .replace(/\s*·\s*(?:USD\s*\/\s*|per\s+)(?:1M|1,000,000) tokens(?: in USD)?/gi, '')
    .replace(/1M INPUT TOKENS \(CACHE HIT\)/gi, 'Cached input')
    .replace(/1M INPUT TOKENS \(CACHE MISS\)/gi, 'Input')
    .replace(/1M OUTPUT TOKENS/gi, 'Output')
    .replace(/Base Input Tokens/gi, 'Input')
    .replace(/Output Tokens/gi, 'Output')
    .replace(/Cache Hits? & Refreshes/gi, 'Cached input')
    .replace(/5m Cache Writes/gi, 'Cache writes (5m)')
    .replace(/1h Cache Writes/gi, 'Cache writes (1h)')
    .replace(/Input price/gi, 'Input')
    .replace(/Output price\s*\(including thinking tokens\)/gi, 'Output')
    .replace(/Output price/gi, 'Output')
    .replace(/Context caching price/gi, 'Cached input')
    .replace(/Grounding with Google Search/gi, 'Google Search')
    .replace(/Grounding with Google Maps/gi, 'Google Maps');
}

export function compactPriceValue(value) {
  return String(value ?? '')
    .replace(/\s*(?:\/|per\s+)(?:MTok|1M tokens|1,000,000 tokens)\b/gi, '')
    .replace(/\bper hour\b/gi, '/hour')
    .replace(/\bNot available\b/gi, '—')
    .replace(/text \/ image \/ video/gi, 'text/image/video')
    .replace(/\bprompts? (?:<=|≤)\s*/gi, '≤')
    .replace(/\bprompts? >\s*/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

// The earliest stored observation is the only reliable date available for every model.
export function newestModels(rows) {
  const firstSeen = new Map();
  for (const row of rows) {
    const date = row.date_utc || row.collected_at_utc;
    if (!firstSeen.has(row.model) || date < firstSeen.get(row.model)) firstSeen.set(row.model, date);
  }
  const version = (name) => (name.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '').replaceAll('-', '.');
  return [...firstSeen.keys()].sort((a, b) => firstSeen.get(b).localeCompare(firstSeen.get(a))
    || version(b).localeCompare(version(a), 'en', { numeric: true })
    || b.localeCompare(a, 'en', { numeric: true }));
}
