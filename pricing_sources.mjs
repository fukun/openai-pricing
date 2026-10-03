import { priceUnit } from './price_values.mjs';

export const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    fetchUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    archiveUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    extension: 'html.txt',
  },
  claude: {
    name: 'Claude',
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetchUrl: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    archiveUrl: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    extension: 'md',
  },
  gemini: {
    name: 'Gemini',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing?hl=zh-cn',
    fetchUrl: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt?hl=zh-cn',
    archiveUrl: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt?hl=zh-cn',
    extension: 'md.txt',
  },
};

export function cleanText(value) {
  return String(value)
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\\([|<>*_])/g, '$1')
    .replace(/[`*]/g, '').replace(/\^.*?\^/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function markdownTables(markdown) {
  const tables = [];
  const blocks = markdown.match(/(?:^\s*\|.*\|\s*$\n?)+/gm) ?? [];
  for (const block of blocks) {
    const lines = block.trim().split('\n').map((line) => line.trim());
    const cells = (line) => line.slice(1, -1).split(/(?<!\\)\|/).map(cleanText);
    if (lines.length < 3 || !cells(lines[1]).every((cell) => /^:?-+:?$/.test(cell))) continue;
    const headers = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    if (rows.some((row) => row.length !== headers.length)) throw new Error('Pricing table column count changed.');
    tables.push({ headers, rows });
  }
  return tables;
}

function section(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = markdown.match(new RegExp(`^(#{2,3}) ${escaped}\\s*$`, 'm'));
  if (!start) throw new Error(`Missing official pricing section: ${heading}`);
  const body = markdown.slice(start.index + start[0].length);
  const next = body.search(new RegExp(`^#{1,${start[1].length}} `, 'm'));
  return next < 0 ? body : body.slice(0, next);
}

export function parseClaude(markdown) {
  const records = [];
  for (const [heading, mode] of [['Model pricing', 'Standard'], ['Batch processing', 'Batch'], ['Fast mode pricing', 'Fast']]) {
    const table = markdownTables(section(markdown, heading)).find((table) => /Model/i.test(table.headers[0]));
    if (!table) throw new Error(`No Claude ${mode} prices found.`);
    const headers = table.headers.map((label) => label.replace(/^(?:Base|Batch) /i, '')
      .replace(/^input(?: tokens)?$/i, 'Input').replace(/^output(?: tokens)?$/i, 'Output'));
    for (const values of table.rows) {
      const sourceLabel = values[0];
      if (!/^Claude\s/.test(sourceLabel) || !values.slice(1).every((value) => /^\$[\d.]+\s*\/\s*MTok/.test(value))) {
        throw new Error(`Unexpected Claude ${mode} pricing row: ${sourceLabel}`);
      }
      for (const label of sourceLabel.split(/\s+\/\s+(?=Claude)/)) {
        const model = label.replace(/\s+\([^)]*\)/g, '').trim();
        records.push({ model, source_model_label: label, pricing_mode: mode,
          price_unit: 'USD / 1M tokens', table_headers: [headers], prices: [model, ...values.slice(1)] });
      }
    }
  }
  if (!records.some((row) => row.pricing_mode === 'Standard') || !records.some((row) => row.pricing_mode === 'Batch')) {
    throw new Error('Incomplete Claude model pricing.');
  }
  return records;
}

export function htmlTableGrid(table) {
  const grid = [];
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  rows.forEach((row, y) => {
    grid[y] ??= [];
    let x = 0;
    for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (grid[y][x] !== undefined) x++;
      const width = Number(cell[1].match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1);
      const height = Number(cell[1].match(/rowspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1);
      const text = cleanText(cell[2]);
      for (let dy = 0; dy < height; dy++) {
        grid[y + dy] ??= [];
        for (let dx = 0; dx < width; dx++) grid[y + dy][x + dx] = text;
      }
      x += width;
    }
  });
  return grid;
}

export function parseDeepSeek(html) {
  const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? [];
  const grid = tables.map(htmlTableGrid).find((rows) => rows[0]?.some((cell) => /^deepseek-/i.test(cell)));
  if (!grid) throw new Error('Missing DeepSeek model/pricing table.');
  const columns = grid[0].map((model, index) => ({ model, index })).filter(({ model }) => /^deepseek-/i.test(model));
  const version = grid.find((row) => /MODEL VERSION/i.test(row[0]));
  const note = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1])).find((text) => /Off-peak rates|Peak hours/i.test(text)) ?? '';
  const records = new Map();
  for (const row of grid) {
    if (!/^PRICING/i.test(row[0])) continue;
    const labels = [...new Set(row.slice(0, columns[0].index))];
    const metric = labels.find((label) => /TOKENS/i.test(label));
    if (!metric) throw new Error('Unrecognized DeepSeek token pricing metric.');
    const rate = labels.find((label) => /^(OFF[- ]?PEAK|PEAK)$/i.test(label));
    const mode = rate ? (/^OFF/i.test(rate) ? 'Off-peak' : 'Peak') : 'Standard';
    for (const { model, index } of columns) {
      if (!/^\$[\d.]+$/.test(row[index] ?? '')) throw new Error(`Missing DeepSeek ${model} ${metric} price.`);
      const key = `${model}:${mode}`;
      if (!records.has(key)) records.set(key, { model, model_version: version?.[index], pricing_mode: mode,
        pricing_notes: note, price_unit: 'USD / 1M tokens', table_headers: [['Model']], prices: [model] });
      records.get(key).table_headers[0].push(metric);
      records.get(key).prices.push(row[index]);
    }
  }
  if (!records.size || [...records.values()].some((row) => row.prices.length < 4)) throw new Error('Incomplete DeepSeek pricing.');
  return [...records.values()];
}

export function parseGemini(markdown) {
  const records = [];
  for (const match of markdown.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    const heading = cleanText(match[1]);
    if (/^(Pricing for|Notes|工具|代理|备注)/i.test(heading)) continue;
    const body = match[2];
    const introduction = body.split(/^### |^\|/m)[0];
    const ids = [...new Set([...introduction.matchAll(/`([a-z][a-z0-9.-]+)`/g)].map((id) => id[1]))];
    const models = ids.length ? ids : [heading];
    // Retain free/paid tiers and source units instead of treating all cells as token prices.
    let mode = 'Standard';
    const chunks = body.split(/(^### .+$)/m);
    for (const chunk of chunks) {
      if (chunk.startsWith('### ')) { mode = cleanText(chunk.slice(4)); continue; }
      for (const table of markdownTables(chunk)) {
        if (table.headers.length !== 3 || !/Free|免费/i.test(table.headers[1]) || !/Paid|付费/i.test(table.headers[2])) {
          throw new Error(`Unexpected Gemini tier table in ${heading}.`);
        }
        const priceRows = table.rows.filter((row) => !/Used to improve|改进.*产品|改善.*产品/i.test(row[0]));
        if (!priceRows.length) throw new Error(`No Gemini price metrics in ${heading}.`);
        for (const model of models) {
          let applicable = priceRows;
          if (/^veo-/.test(model)) {
            const variant = model.includes('-fast-') ? /Fast/i : model.includes('-lite-') ? /Lite/i : /Standard/i;
            applicable = priceRows.filter((row) => variant.test(row[0]));
          } else if (/^lyria-3-/.test(model)) {
            applicable = priceRows.filter((row) => (model.includes('-clip-') ? /Clip/i : /Pro/i).test(row[0]));
          }
          if (!applicable.length) throw new Error(`No applicable price rows for ${model}.`);
          for (const [index, tier] of [[2, 'Paid']]) {
            const unit = table.headers[2].replace(/^(?:Paid Tier|付费层级)[，,]?\s*/i, '');
            records.push({ model, source_model_label: heading, pricing_mode: mode, pricing_tier: tier,
              price_unit: unit,
              price_units: ['Model', ...applicable.map((row) => priceUnit(row[2], unit))],
              table_headers: [['Model', ...applicable.map((row) => row[0])]],
              prices: [model, ...applicable.map((row) => row[index])] });
          }
        }
      }
    }
  }
  if (!records.length || !records.some((row) => row.pricing_mode === 'Batch')) throw new Error('Incomplete Gemini pricing.');
  return records;
}

export const PARSERS = { deepseek: parseDeepSeek, claude: parseClaude, gemini: parseGemini };
