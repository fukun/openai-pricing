const root = new URL('./', import.meta.url);
const metadata = document.getElementById('metadata');
try {
  const path = new URL(location.href).searchParams.get('source');
  if (!/^data\/(?:deepseek\/|claude\/|gemini\/)?sources\/[\w.-]+\.(?:md|html\.txt|md\.txt)$/.test(path ?? '')) {
    throw new Error('归档路径无效，请从价格历史列表打开归档。');
  }
  const provider = path.split('/')[1] === 'sources' ? 'openai' : path.split('/')[1];
  const directory = provider === 'openai' ? 'data/' : `data/${provider}/`;
  const history = await fetch(new URL(`${directory}pricing_history.jsonl`, root));
  if (!history.ok) throw new Error('无法读取归档索引，请稍后重试。');
  const row = (await history.text()).split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .find((entry) => entry.source_snapshot === path);
  if (!row) throw new Error('未找到对应的历史快照。');
  const response = await fetch(new URL(path, root));
  if (!response.ok) throw new Error('归档原文暂时无法读取，请稍后重试。');
  const source = document.getElementById('source');
  source.textContent = await response.text();
  source.hidden = false;
  metadata.textContent = `服务商：${provider === 'openai' ? 'OpenAI' : provider}\n采集时间：${row.collected_at_utc}（UTC）\n归档文件：${path}`;
  document.getElementById('back').href = new URL(provider === 'openai' ? './' : `${provider}/`, root);
  const official = document.getElementById('official');
  if (/^https?:\/\//.test(row.source_url ?? '')) {
    official.href = row.source_url;
    official.hidden = false;
  }
  const raw = document.getElementById('raw');
  raw.href = new URL(path, root);
  raw.hidden = false;
} catch (error) {
  metadata.textContent = error.message;
}
