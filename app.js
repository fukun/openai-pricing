const DATA_URL = 'data/pricing_history.jsonl';
const COLORS = ['#17855d','#477aa4','#d08336','#8268ad','#d05c65','#358e9b','#a77c28','#626f80','#cf78a3','#53a36f'];

const state = { rows: [], view: 'list', metric: null };
const el = (id) => document.getElementById(id);
const modelFilter = el('model-filter');
const modeFilter = el('mode-filter');
const fromFilter = el('from-filter');
const toFilter = el('to-filter');

function parseData(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.model && row.date_utc && row.pricing_mode && Array.isArray(row.prices));
}

function dateRange(rows) {
  const from = fromFilter.value;
  const to = toFilter.value;
  return rows.filter((row) => (!from || row.date_utc >= from) && (!to || row.date_utc <= to));
}

function filteredRows() {
  return dateRange(state.rows).filter((row) =>
    (modelFilter.value === 'all' || row.model === modelFilter.value)
    && (modeFilter.value === 'all' || row.pricing_mode === modeFilter.value));
}

function metricOptions(rows) {
  const metrics = new Map();
  for (const row of rows) {
    const headers = row.table_headers?.at(-1) ?? [];
    row.prices.slice(1).forEach((_, offset) => {
      const cellIndex = offset + 1;
      let label = headers[cellIndex] || `价格列 ${cellIndex + 1}`;
      if (metrics.has(String(cellIndex)) && metrics.get(String(cellIndex)) !== label) {
        label = `${label} (${row.model})`;
      }
      metrics.set(String(cellIndex), label);
    });
  }
  return [...metrics.entries()].map(([value, label]) => ({ value: Number(value), label }));
}

function renderMetricOptions(rows) {
  const options = metricOptions(rows);
  const previous = Number(el('metric-filter').value || state.metric);
  el('metric-filter').replaceChildren(...options.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  const selected = options.some((option) => option.value === previous) ? previous : options[0]?.value;
  state.metric = selected ?? null;
  if (selected != null) el('metric-filter').value = String(selected);
}

function renderSummary() {
  const models = new Set(state.rows.map((row) => row.model));
  const dates = state.rows.map((row) => row.date_utc).sort();
  el('model-count').textContent = String(models.size);
  el('record-count').textContent = state.rows.length.toLocaleString('zh-CN');
  el('latest-date').textContent = dates.at(-1) ?? '—';
  modelFilter.replaceChildren(new Option('全部模型', 'all'));
  for (const model of [...models].sort((a, b) => a.localeCompare(b))) {
    modelFilter.add(new Option(model, model));
  }
}

function renderList(rows) {
  const body = el('price-rows');
  el('visible-count').textContent = `${rows.length.toLocaleString('zh-CN')} 条`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">当前筛选条件没有价格记录。</td></tr>';
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
    const mode = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `mode-badge ${row.pricing_mode === 'Batch' ? 'mode-batch' : 'mode-standard'}`;
    badge.textContent = row.pricing_mode;
    mode.append(badge);
    const prices = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'price-values';
    const headers = row.table_headers?.at(-1) ?? [];
    row.prices.slice(1).forEach((value, offset) => {
      const chip = document.createElement('span');
      chip.className = 'price-chip';
      const label = document.createElement('b');
      label.textContent = headers[offset + 1] || `价格 ${offset + 2}`;
      const amount = document.createElement('span');
      amount.textContent = value || '—';
      chip.append(label, amount);
      wrap.append(chip);
    });
    prices.append(wrap);
    tr.append(date, model, mode, prices);
    return tr;
  }));
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

  const index = state.metric;
  const series = new Map();
  for (const row of rows) {
    const value = Number(String(row.prices[index] ?? '').replace(/[$,]/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(value)) continue;
    const name = modeFilter.value === 'all' ? `${row.model} · ${row.pricing_mode}` : row.model;
    if (!series.has(name)) series.set(name, new Map());
    series.get(name).set(row.date_utc, value);
  }
  const dates = [...new Set(rows.filter((row) => series.has(row.model)).map((row) => row.date_utc))].sort();
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

for (const filter of [modelFilter, modeFilter, fromFilter, toFilter]) filter.addEventListener('change', render);
el('metric-filter').addEventListener('change', (event) => { state.metric = Number(event.target.value); drawChart(filteredRows()); });
document.querySelectorAll('.view-button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
window.addEventListener('resize', () => { if (state.view === 'chart') drawChart(filteredRows()); });

try {
  const response = await fetch(DATA_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
  state.rows = parseData(await response.text());
  renderSummary();
  render();
  el('status').textContent = `已载入 ${state.rows.length.toLocaleString('zh-CN')} 条价格记录`;
} catch (error) {
  el('status').textContent = '数据还未生成或暂时无法读取';
  el('price-rows').innerHTML = `<tr><td colspan="4" class="empty">${String(error.message)}</td></tr>`;
}
