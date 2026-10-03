import { numericPrice, compactPriceLabel, compactPriceValue, newestModels } from './price_values.mjs';

const PROVIDER = document.body.dataset.provider ?? 'openai';
const IS_OPENAI = PROVIDER === 'openai';
const SITE_ROOT = new URL('./', import.meta.url);
const DATA_DIRECTORY = IS_OPENAI ? 'data/' : `data/${PROVIDER}/`;
const DATA_URL = new URL(`${DATA_DIRECTORY}pricing_history.jsonl`, SITE_ROOT);
const LOG_URL = new URL(`${DATA_DIRECTORY}collection_log.jsonl`, SITE_ROOT);
const TABLE_COLUMNS = IS_OPENAI ? 6 : 5;
const COLORS = ['#17855d','#477aa4','#d08336','#8268ad','#d05c65','#358e9b','#a77c28','#626f80','#cf78a3','#53a36f'];

const state = { rows: [], collectionLog: [], view: 'list', metric: null };
const el = (id) => document.getElementById(id);
const modelFilter = el('model-filter');
const modelOptions = el('model-options');
const modeFilter = el('mode-filter');
const fromFilter = el('from-filter');
const toFilter = el('to-filter');
let selectedModel = '';
let highlightedModelOption = 0;

function parseData(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.model && row.date_utc && row.pricing_mode && Array.isArray(row.prices)
      && (PROVIDER !== 'gemini' || row.pricing_tier === 'Paid'));
}

function dateRange(rows) {
  const from = fromFilter.value;
  const to = toFilter.value;
  return rows.filter((row) => (!from || row.date_utc >= from) && (!to || row.date_utc <= to));
}

function priceLabel(headers, index) {
  const group = headers?.[0]?.[index];
  const label = headers?.at(-1)?.[index];
  if (!label) return `价格列 ${index + 1}`;
  return group && group !== label ? `${label}（${group}）` : label;
}

function priceColumnIndex(row, label) {
  const labels = row.table_headers?.at(-1) ?? [];
  return labels.findIndex((_, index) => index > 0 && metricLabel(row, index) === label);
}

function metricLabel(row, index) {
  const label = priceLabel(row.table_headers, index);
  const unit = row.price_units?.[index] ?? row.price_unit;
  return !IS_OPENAI && unit ? `${label} · ${unit}` : label;
}

function filteredRows() {
  return dateRange(state.rows).filter((row) =>
    (!selectedModel || row.model === selectedModel)
    && (modeFilter.value === 'all' || row.pricing_mode === modeFilter.value));
}

function renderModelOptions(query = '') {
  const models = newestModels(state.rows)
    .filter((model) => model.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const allModelsOption = { label: '全部模型', value: '' };
  const options = query.trim()
    ? [...models.map((model) => ({ label: model, value: model })), ...(models.length ? [allModelsOption] : [])]
    : [allModelsOption, ...models.map((model) => ({ label: model, value: model }))];
  modelOptions.replaceChildren(...options.map(({ label, value }, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `model-option-${index}`;
    option.className = 'model-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(value === selectedModel));
    option.dataset.model = value;
    option.textContent = label;
    return option;
  }));
  if (!options.length) {
    const empty = document.createElement('div');
    empty.className = 'model-options-empty';
    empty.textContent = '没有匹配的模型';
    modelOptions.append(empty);
  }
  highlightedModelOption = 0;
  updateModelHighlight();
}

function updateModelHighlight() {
  const options = [...modelOptions.querySelectorAll('[role="option"]')];
  options.forEach((option, index) => option.classList.toggle('highlighted', index === highlightedModelOption));
  const active = options[highlightedModelOption];
  if (active) modelFilter.setAttribute('aria-activedescendant', active.id);
  else modelFilter.removeAttribute('aria-activedescendant');
}

function setModelOptionsOpen(open) {
  modelOptions.hidden = !open;
  modelFilter.setAttribute('aria-expanded', String(open));
  if (!open) {
    modelFilter.value = selectedModel;
    modelFilter.removeAttribute('aria-activedescendant');
  }
}

function chooseModel(model) {
  selectedModel = model;
  modelFilter.value = model;
  setModelOptionsOpen(false);
  render();
}

function metricOptions(rows) {
  const metrics = new Set();
  for (const row of rows) {
    row.prices.slice(1).forEach((_, offset) => {
      metrics.add(metricLabel(row, offset + 1));
    });
  }
  return [...metrics].map((label) => ({ value: label, label: compactPriceLabel(label) }));
}

function renderMetricOptions(rows) {
  const options = metricOptions(rows);
  const previous = el('metric-filter').value || state.metric;
  el('metric-filter').replaceChildren(...options.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  const selected = options.some((option) => option.value === previous) ? previous : options[0]?.value;
  state.metric = selected ?? null;
  if (selected != null) el('metric-filter').value = selected;
}

function renderSummary() {
  const models = new Set(state.rows.map((row) => row.model));
  const dates = state.rows.map((row) => row.date_utc).sort();
  el('model-count').textContent = String(models.size);
  el('record-count').textContent = state.rows.length.toLocaleString('zh-CN');
  el('latest-date').textContent = dates.at(-1) ?? '—';
  const modes = [...new Set(state.rows.map((row) => row.pricing_mode))].sort();
  modeFilter.replaceChildren(new Option('全部类型', 'all'), ...modes.map((mode) => new Option(mode, mode)));
  renderModelOptions();
}

function renderList(rows) {
  const body = el('price-rows');
  el('visible-count').textContent = `${rows.length.toLocaleString('zh-CN')} 条`;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${TABLE_COLUMNS}" class="empty">当前筛选条件没有价格记录。</td></tr>`;
    return;
  }
  const sorted = [...rows].sort((a, b) => b.date_utc.localeCompare(a.date_utc)
    || a.model.localeCompare(b.model) || a.pricing_mode.localeCompare(b.pricing_mode));
  body.replaceChildren(...sorted.map((row) => {
    const tr = document.createElement('tr');
    const date = document.createElement('td');
    date.className = 'date-cell';
    date.textContent = row.date_utc;
    const model = document.createElement('td');
    model.className = 'model-name';
    model.textContent = row.model;
    model.title = row.source_model_label ?? row.model;
    const mode = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `mode-badge ${row.pricing_mode === 'Batch' ? 'mode-batch' : row.pricing_mode === 'Standard' ? 'mode-standard' : 'mode-other'}`;
    badge.textContent = row.pricing_mode;
    mode.append(badge);
    const renderPriceCell = (longContext) => {
      const cell = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = IS_OPENAI ? 'price-values' : 'price-values provider-price-values';
      row.prices.slice(1).forEach((value, offset) => {
        const fullLabel = priceLabel(row.table_headers, offset + 1);
        const isLongContext = /long context/i.test(fullLabel);
        if (longContext !== null && isLongContext !== longContext) return;
        const chip = document.createElement('span');
        chip.className = 'price-chip';
        const label = document.createElement('b');
        label.textContent = IS_OPENAI ? fullLabel.replace(/\s*[（(](?:short|long) context[）)]/i, '') : compactPriceLabel(fullLabel);
        if (!IS_OPENAI && row.price_unit === 'per second in USD') label.textContent += ' /second';
        const amount = document.createElement('span');
        amount.textContent = compactPriceValue(value) || '—';
        chip.title = [fullLabel, value, row.model_version, row.pricing_notes].filter(Boolean).join(' · ');
        chip.append(label, amount);
        wrap.append(chip);
      });
      if (wrap.childElementCount) cell.append(wrap);
      else { cell.className = 'date-cell'; cell.textContent = '—'; }
      return cell;
    };
    const archive = document.createElement('td');
    if (row.wayback_url) {
      const link = document.createElement('a');
      link.className = 'archive-link';
      link.href = row.wayback_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = IS_OPENAI ? '查看 ↗' : 'Wayback ↗';
      archive.append(link);
    } else {
      archive.className = 'date-cell';
      archive.textContent = row.archive_status === 'pending' ? '归档待重试' : '—';
    }
    if (IS_OPENAI) tr.append(date, model, mode, renderPriceCell(false), renderPriceCell(true), archive);
    else tr.append(date, model, mode, renderPriceCell(null), archive);
    return tr;
  }));
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportCsv(rows) {
  const status = el('export-status');
  status.textContent = '';
  if (!rows.length) {
    status.textContent = '当前筛选没有可导出的记录';
    return;
  }
  try {
    const priceColumns = [...new Set(rows.flatMap((row) => row.prices.slice(1)
      .map((_, offset) => metricLabel(row, offset + 1))))];
    const headers = ['日期', '模型', '官方原始模型标签', '价格类型', '价格单位', 'Wayback 归档', ...priceColumns];
    const lines = [headers, ...rows.map((row) => {
      const valuesByLabel = new Map();
      row.prices.slice(1).forEach((value, offset) => {
        valuesByLabel.set(metricLabel(row, offset + 1), value);
      });
      return [row.date_utc, row.model, row.source_model_label ?? row.model, row.pricing_mode,
        row.price_unit ?? '', row.wayback_url ?? '',
        ...priceColumns.map((label) => valuesByLabel.get(label) ?? '')];
    })].map((line) => line.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${lines}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${PROVIDER}-pricing-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `已导出 ${rows.length.toLocaleString('zh-CN')} 条`;
  } catch (error) {
    status.textContent = `导出失败：${error.message}`;
  }
}

function drawChart(rows) {
  const canvas = el('price-chart');
  const context = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const metric = state.metric;
  const series = new Map();
  for (const row of rows) {
    const index = priceColumnIndex(row, metric);
    if (index < 0) continue;
    const value = numericPrice(row.prices[index]);
    if (value == null) continue;
    const name = [row.model, modeFilter.value === 'all' ? row.pricing_mode : ''].filter(Boolean).join(' · ');
    if (!series.has(name)) series.set(name, new Map());
    series.get(name).set(row.date_utc, value);
  }
  const dates = [...new Set([...series.values()].flatMap((points) => [...points.keys()]))].sort();
  el('chart-empty').hidden = series.size > 0 && dates.length > 0;
  el('chart-legend').replaceChildren();
  if (!series.size || !dates.length) return;

  const values = [...series.values()].flatMap((points) => [...points.values()]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min = Math.max(0, min * 0.85); max = max * 1.15 || 1; }
  const pad = { left: 56, right: 20, top: 18, bottom: 40 };
  const width = rect.width - pad.left - pad.right;
  const height = rect.height - pad.top - pad.bottom;
  const yMin = min < 0 ? min : 0;
  const yMax = max;
  const xAt = (i) => pad.left + (dates.length < 2 ? width / 2 : (i / (dates.length - 1)) * width);
  const yAt = (value) => pad.top + height - ((value - yMin) / (yMax - yMin || 1)) * height;

  context.font = '10px DM Mono, monospace';
  context.textBaseline = 'middle';
  for (let tick = 0; tick <= 4; tick++) {
    const value = yMin + (yMax - yMin) * tick / 4;
    const y = yAt(value);
    context.strokeStyle = '#edf0f2';
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(rect.width - pad.right, y); context.stroke();
    context.fillStyle = '#89919a';
    context.textAlign = 'right';
    context.fillText(value.toPrecision(3), pad.left - 10, y);
  }
  const labelCount = Math.min(6, dates.length);
  for (let i = 0; i < labelCount; i++) {
    const dateIndex = labelCount < 2 ? 0 : Math.round(i * (dates.length - 1) / (labelCount - 1));
    context.fillStyle = '#89919a';
    context.textAlign = 'center';
    context.fillText(dates[dateIndex].slice(5), xAt(dateIndex), rect.height - 16);
  }

  [...series.entries()].forEach(([model, points], seriesIndex) => {
    const color = COLORS[seriesIndex % COLORS.length];
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.lineJoin = 'round';
    let segment = [];
    const strokeSegment = () => {
      if (segment.length === 1) {
        context.fillStyle = color;
        context.beginPath(); context.arc(segment[0].x, segment[0].y, 3, 0, Math.PI * 2); context.fill();
        segment = [];
        return;
      }
      if (segment.length < 2) { segment = []; return; }
      context.beginPath(); context.moveTo(segment[0].x, segment[0].y);
      for (const point of segment.slice(1)) context.lineTo(point.x, point.y);
      context.stroke(); segment = [];
    };
    dates.forEach((date, dateIndex) => {
      if (points.has(date)) segment.push({ x: xAt(dateIndex), y: yAt(points.get(date)) });
      else strokeSegment();
    });
    strokeSegment();
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('i');
    swatch.className = 'legend-swatch'; swatch.style.background = color;
    item.append(swatch, document.createTextNode(model));
    el('chart-legend').append(item);
  });
}

function render() {
  const rows = filteredRows();
  renderMetricOptions(rows);
  renderList(rows);
  if (state.view === 'chart') drawChart(rows);
}

function setView(view) {
  state.view = view;
  el('list-view').hidden = view !== 'list';
  el('chart-view').hidden = view !== 'chart';
  document.querySelectorAll('.view-button').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (view === 'chart') render();
}

modelFilter.addEventListener('focus', () => {
  renderModelOptions(modelFilter.value);
  setModelOptionsOpen(true);
});
modelFilter.addEventListener('input', () => {
  renderModelOptions(modelFilter.value);
  setModelOptionsOpen(true);
});
modelFilter.addEventListener('keydown', (event) => {
  const options = [...modelOptions.querySelectorAll('[role="option"]')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (modelOptions.hidden) {
      renderModelOptions(modelFilter.value);
      setModelOptionsOpen(true);
    } else if (options.length) {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlightedModelOption = (highlightedModelOption + step + options.length) % options.length;
      updateModelHighlight();
    }
  } else if (event.key === 'Enter' && !modelOptions.hidden && options.length) {
    event.preventDefault();
    chooseModel(options[highlightedModelOption]?.dataset.model ?? '');
  } else if (event.key === 'Escape' && !modelOptions.hidden) {
    event.preventDefault();
    setModelOptionsOpen(false);
  }
});
modelOptions.addEventListener('mousedown', (event) => event.preventDefault());
modelOptions.addEventListener('click', (event) => {
  const option = event.target.closest('[role="option"]');
  if (option) chooseModel(option.dataset.model ?? '');
});
modelOptions.addEventListener('mousemove', (event) => {
  const options = [...modelOptions.querySelectorAll('[role="option"]')];
  const index = options.indexOf(event.target.closest('[role="option"]'));
  if (index >= 0) { highlightedModelOption = index; updateModelHighlight(); }
});
modelFilter.addEventListener('blur', () => setModelOptionsOpen(false));
for (const filter of [modeFilter, fromFilter, toFilter]) filter.addEventListener('change', render);
el('export-csv').addEventListener('click', () => exportCsv(filteredRows()));
el('metric-filter').addEventListener('change', (event) => { state.metric = event.target.value; drawChart(filteredRows()); });
document.querySelectorAll('.view-button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
window.addEventListener('resize', () => { if (state.view === 'chart') drawChart(filteredRows()); });

try {
  const [response, logResponse] = await Promise.all([
    fetch(DATA_URL, { cache: 'no-store' }),
    fetch(LOG_URL, { cache: 'no-store' }).catch(() => null),
  ]);
  if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
  state.rows = parseData(await response.text());
  if (logResponse?.ok) {
    state.collectionLog = (await logResponse.text()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  renderSummary();
  render();
  const today = new Date().toISOString().slice(0, 10);
  const todayLog = state.collectionLog.find((entry) => entry.date_utc === today);
  const collectionStatus = todayLog?.status === 'unchanged' ? '今日已采集；模型和价格无变化'
    : todayLog?.status === 'changed' ? '今日已采集；模型或价格有变化'
      : todayLog?.status === 'failed' ? '今日采集失败'
        : `已载入 ${state.rows.length.toLocaleString('zh-CN')} 条价格记录`;
  el('status').textContent = collectionStatus + (todayLog?.archive_status === 'pending' ? '；Wayback 归档待重试' : '');
} catch (error) {
  el('status').textContent = '数据还未生成或暂时无法读取';
  const cell = document.createElement('td');
  cell.colSpan = TABLE_COLUMNS;
  cell.className = 'empty';
  cell.textContent = error.message;
  const row = document.createElement('tr');
  row.append(cell);
  el('price-rows').replaceChildren(row);
}
