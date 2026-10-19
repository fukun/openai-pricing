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
  const original = await response.text();
  let offlineSavedAt;
  if (provider === 'deepseek') {
    const frame = document.getElementById('preview');
    const offlinePath = path.replace('/sources/', '/offline/').replace(/\.html\.txt$/, '');
    let offlineReady = false;
    try {
      const manifestResponse = await fetch(new URL(`${offlinePath}.json`, root));
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();
        if (manifest.source_snapshot !== path || manifest.mode !== 'offline-reading') throw new Error('Invalid offline manifest');
        frame.src = new URL(`${offlinePath}.html`, root);
        const download = document.getElementById('download');
        download.href = new URL(`${offlinePath}.zip`, root);
        download.hidden = false;
        offlineSavedAt = manifest.resources_saved_at_utc;
        offlineReady = true;
      }
    } catch { /* Keep the original captured article readable if a backup is not ready. */ }
    if (!offlineReady) {
    const page = new DOMParser().parseFromString(original, 'text/html');
    // Display the captured article without running the original site's app.
    const article = page.querySelector('article');
    if (!article) throw new Error('归档中缺少页面正文，可通过原始文件查看。');
    const stylesheet = `<style>body{margin:0;padding:24px;color:#24352d;background:white;font:15px/1.7 system-ui,sans-serif}h1{font-size:28px}a{color:#4d6bfe}svg{width:1em;height:1em;vertical-align:middle}nav[aria-label="Breadcrumbs"]{display:none}table{border-collapse:collapse;display:block;overflow:auto;width:100%;margin:20px 0}th,td{border:1px solid #dce5dd;padding:10px 14px;text-align:left;min-width:90px}th{background:#f1f6f2}img{max-width:100%}pre{overflow:auto}button{display:none}</style>`;
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri https://api-docs.deepseek.com; form-action 'none'"><base href="https://api-docs.deepseek.com/">${stylesheet}</head><body>${article.outerHTML}</body></html>`;
    }
    frame.hidden = false;
  } else {
    source.textContent = original;
    source.hidden = false;
  }
  metadata.textContent = `服务商：${provider === 'openai' ? 'OpenAI' : provider}\n采集时间：${row.collected_at_utc}（UTC）\n归档文件：${path}`;
  if (provider === 'deepseek') metadata.textContent += offlineSavedAt
    ? `\n离线资源保存时间：${offlineSavedAt}（历史页面资源可能晚于原文补存）`
    : '\n离线备份尚未完成，当前为原文正文预览。';
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
