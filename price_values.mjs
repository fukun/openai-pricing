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
    .replace(/\s*(?:\/\s*|per\s+)(?:MTok|1M tokens|1,000,000 tokens)\b/gi, '')
    .replace(/\bper hour\b/gi, '/hour')
    .replace(/\bNot available\b/gi, '—')
    .replace(/text \/ image \/ video/gi, 'text/image/video')
    .replace(/\bprompts? (?:<=|≤)\s*/gi, '≤')
    .replace(/\bprompts? >\s*/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

// Daily collection logs preserve source order even when prices do not change.
export function officialModelOrder(rows, logs) {
  const available = new Set(rows.map((row) => row.model));
  const ordered = new Set();
  const recentLogs = [...logs].sort((a, b) => b.collected_at_utc.localeCompare(a.collected_at_utc));
  for (const log of recentLogs) {
    for (const model of log.model_order ?? []) if (available.has(model)) ordered.add(model);
  }
  for (const row of rows) ordered.add(row.model);
  return [...ordered];
}

export function compactGeminiValue(value) {
  const months = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
  const text = compactPriceValue(value)
    .replace(/(?:,?\s*equivalent to|\s+Equivalent to)[\s\S]*$/i, '')
    .replace(/\s*\(\$[^)]*\)/g, '')
    .replace(/through ([A-Za-z]+) (\d{1,2}), (\d{4})\.?/g, (_, month, day, year) => `（至${year}-${months[month] ?? month}-${day.padStart(2, '0')}）`)
    .replace(/starting ([A-Za-z]+) (\d{1,2}), (\d{4})\.?/g, (_, month, day, year) => `（自${year}-${months[month] ?? month}-${day.padStart(2, '0')}）`)
    .replace(/,?\s*prompts?\s*(<=|≤|>)\s*(\d+k)(?: tokens)?/gi, ' ($1$2)')
    .replace(/text\s*\/\s*image\s*\/\s*video\s*\/\s*audio/gi, '文本/图像/视频/音频')
    .replace(/text\s*\/\s*image\s*\/\s*video/gi, '文本/图像/视频')
    .replace(/text and thinking/gi, '文本含思考')
    .replace(/input caching/gi, '缓存读取')
    .replace(/storage price/gi, '存储')
    .replace(/\btext\b/gi, '文本').replace(/\bimages?\b/gi, '图像')
    .replace(/\baudio\b/gi, '音频').replace(/\bvideo\b/gi, '视频')
    .replace(/\bor\s+\$[\d.]+\/min/g, '')
    .trim();
  return text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
}
