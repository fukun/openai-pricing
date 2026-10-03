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
