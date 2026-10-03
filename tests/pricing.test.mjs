import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanText, parseClaude, parseDeepSeek, parseGemini } from '../pricing_sources.mjs';
import { numericPrice, priceUnit } from '../price_values.mjs';
import { recordCollection, readJsonLines } from '../provider_store.mjs';

test('DeepSeek expands row/column spans and keeps peak/cache categories separate', () => {
  const html = '<table><tr><td colspan="3">MODEL</td><td>deepseek-test<sup>(1)</sup></td></tr>'
    + '<tr><td rowspan="6">PRICING</td><td rowspan="2">1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.1</td></tr>'
    + '<tr><td>PEAK</td><td>$0.2</td></tr>'
    + '<tr><td rowspan="2">1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$1</td></tr>'
    + '<tr><td>PEAK</td><td>$2</td></tr>'
    + '<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$3</td></tr>'
    + '<tr><td>PEAK</td><td>$6</td></tr></table>';
  const rows = parseDeepSeek(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.pricing_mode === 'Peak').prices, ['deepseek-test', '$0.2', '$2', '$6']);
  assert.throws(() => parseDeepSeek(html.replace('$6', 'unknown')), /Missing DeepSeek/);
});

test('Claude handles official annotations, all model rows, and shared fast-price rows', () => {
  const markdown = `## Model pricing
| Model | Base input tokens | Output tokens |
| --- | --- | --- |
| Claude Test 1 ([retired](https://example.com)) | $1 / MTok | $5 / MTok |
### Batch processing
| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Test 1 | $0.5 / MTok | $2.5 / MTok |
### Fast mode pricing
| Model | Input | Output |
| --- | --- | --- |
| Claude Test 1 / Claude Test 2 | $2 / MTok | $10 / MTok |
`;
  const rows = parseClaude(markdown);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].model, 'Claude Test 1');
  assert.match(rows[0].source_model_label, /retired/);
  assert.deepEqual(rows[0].table_headers, [['Model', 'Input', 'Output']]);
  assert.equal(rows.filter((row) => row.pricing_mode === 'Fast').length, 2);
  assert.throws(() => parseClaude(markdown.replace('### Batch processing', '### Missing')), /Missing official/);
});

test('Gemini keeps shared model IDs, paid prices, modes, source units and composite values', () => {
  const markdown = `## Gemini Live
[\`gemini-test-a\`](https://example.com), [\`gemini-test-b\`](https://example.com)
### Standard
| | Free Tier | Paid Tier, per 1M tokens in USD |
| --- | --- | --- |
| Input price | Free of charge | $1 (short) $2 (long) |
| Used to improve our products | Yes | No |
### Batch
| | Free Tier | Paid Tier, per 1M tokens in USD |
| --- | --- | --- |
| Input price | Not available | $0.5 |
## Pricing for tools
| | Free Tier | Paid Tier |
| --- | --- | --- |
| Search | Free | $10 |
`;
  const rows = parseGemini(markdown);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.model)).size, 2);
  assert.equal(rows[1].prices[1], '$1 (short) $2 (long)');
  assert.equal(rows[1].prices.length, 2);
  assert.match(rows[1].price_unit, /^per 1M/);
  assert.throws(() => parseGemini(markdown.replaceAll('Paid Tier', 'Unexpected')), /Unexpected Gemini/);
});

test('chart ignores composite prices, missing values and scheduled multiple rates', () => {
  assert.equal(numericPrice('$2.50 / MTok'), 2.5);
  assert.equal(numericPrice('Free of charge'), 0);
  assert.equal(numericPrice('Not available'), null);
  assert.equal(numericPrice('$1 (short) $2 (long)'), null);
  assert.equal(numericPrice('$1 through 2026. $2 starting 2027.'), null);
});

test('Markdown context thresholds retain both prices instead of being removed as HTML tags', () => {
  const text = '$1.25, prompts \\<= 200k tokens $2.50, prompts \\> 200k tokens';
  assert.equal(cleanText(text), '$1.25, prompts <= 200k tokens $2.50, prompts > 200k tokens');
  assert.equal(numericPrice(cleanText(text)), null);
});

test('cell-specific billing units override the token-table default', () => {
  assert.equal(priceUnit('$0.0195 per image', 'per 1M tokens in USD'), 'USD / image');
  assert.equal(priceUnit('then $35 / 1,000 grounded prompts', 'per 1M tokens in USD'), 'USD / 1,000 grounded prompts');
  assert.equal(priceUnit('$3 (audio)', 'per 1M tokens in USD'), 'USD / 1M tokens');
});

const priceRow = (model = 'test', price = '$1') => ({ model, pricing_mode: 'Standard',
  price_unit: 'USD / 1M tokens', table_headers: [['Model', 'Input']], prices: [model, price] });

test('unchanged daily checks leave history/source bytes unchanged and write a daily log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-history-'));
  try {
    let captures = 0;
    const archive = async () => { captures++; return 'https://web.archive.org/web/20261003000000/https://example.com'; };
    const args = { verify: async () => {}, provider: 'claude', rows: [priceRow()], source: 'source', dataDirectory: directory, archive };
    await recordCollection({ ...args, now: new Date('2026-10-03T00:00:00Z') });
    const file = join(directory, 'claude/pricing_history.jsonl');
    const history = await readFile(file, 'utf8');
    const log = await recordCollection({ ...args, now: new Date('2026-10-04T00:00:00Z') });
    assert.equal(log.status, 'unchanged');
    assert.equal(captures, 1);
    assert.equal(await readFile(file, 'utf8'), history);
    assert.equal((await readdir(join(directory, 'claude/sources'))).length, 1);
    assert.equal((await readJsonLines(join(directory, 'claude/collection_log.jsonl'))).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed Wayback saves prices; retry repairs that capture without another daily snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-archive-'));
  try {
    const args = { verify: async () => {}, provider: 'claude', rows: [priceRow()], source: 'source', dataDirectory: directory };
    const first = await recordCollection({ ...args, now: new Date('2026-10-03T00:00:00Z'),
      archive: async () => { throw new Error('HTTP 429'); } });
    assert.equal(first.status, 'changed');
    assert.equal(first.archive_status, 'pending');
    const repaired = await recordCollection({ ...args, now: new Date('2026-10-04T00:00:00Z'),
      archive: async () => 'https://web.archive.org/web/20261004000000/https://example.com' });
    assert.equal(repaired.status, 'unchanged');
    const history = await readJsonLines(join(directory, 'claude/pricing_history.jsonl'));
    assert.equal(history.length, 1);
    assert.equal(history[0].date_utc, '2026-10-03');
    assert.equal(history[0].archive_status, 'saved');
    assert.equal((await readdir(join(directory, 'claude/sources'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a same-day model removal replaces that daily snapshot; older dates remain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-models-'));
  try {
    const args = { verify: async () => {}, provider: 'claude', source: 'source', dataDirectory: directory,
      archive: async () => 'https://web.archive.org/web/20261003000000/https://example.com' };
    await recordCollection({ ...args, rows: [priceRow('a'), priceRow('b')], now: new Date('2026-10-02T00:00:00Z') });
    await recordCollection({ ...args, rows: [priceRow('a', '$2'), priceRow('b')], now: new Date('2026-10-03T00:00:00Z') });
    await recordCollection({ ...args, rows: [priceRow('a', '$3')], now: new Date('2026-10-03T01:00:00Z') });
    const rows = await readJsonLines(join(directory, 'claude/pricing_history.jsonl'));
    assert.equal(rows.filter((row) => row.date_utc === '2026-10-02').length, 2);
    assert.equal(rows.filter((row) => row.date_utc === '2026-10-03').length, 1);
    await assert.rejects(recordCollection({ ...args, rows: [] }), /empty pricing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
