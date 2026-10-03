#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './pricing_sources.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const template = await readFile(join(root, 'index.html'), 'utf8');
const descriptions = {
  deepseek: '追踪 DeepSeek 官方模型的高峰、非高峰及缓存命中价格变化。',
  claude: '追踪 Claude 官方模型的 Standard、Batch、Fast 与提示缓存价格变化。',
  gemini: '追踪 Gemini API 付费模型的 Standard、Batch、Flex、Priority 等价格变化。',
};
for (const [provider, config] of Object.entries(PROVIDERS)) {
  const nav = `<nav class="provider-nav" aria-label="服务商">\n${['openai', ...Object.keys(PROVIDERS)].map((id) =>
    `        <a href="${id === 'openai' ? '../' : `../${id}/`}"${id === provider ? ' aria-current="page"' : ''}>${id === 'openai' ? 'OpenAI' : PROVIDERS[id].name}</a>`).join('\n')}\n      </nav>`;
  const html = template
    .replace('<body>', `<body data-provider="${provider}">`)
    .replaceAll('OpenAI GPT-5 及以上模型 API 价格历史', `${config.name} API 价格历史`)
    .replaceAll('OpenAI API 价格历史', `${config.name} API 价格历史`)
    .replace('href="styles.css"', 'href="../styles.css"')
    .replace('src="app.js"', 'src="../app.js"')
    .replace('class="brand" href="./"', 'class="brand" href="../"')
    .replace('class="brand-mark">O', `class="brand-mark">${config.name[0]}`)
    .replaceAll('https://developers.openai.com/api/docs/pricing?latest-pricing=batch', config.sourceUrl.replaceAll('&', '&amp;'))
    .replace('OpenAI 官方价格', `${config.name} 官方价格`)
    .replace(/<nav class="provider-nav"[\s\S]*?<\/nav>/, nav)
    .replace('GPT-5+ API PRICING', `${config.name.toUpperCase()} API PRICING`)
    .replace('<h1>模型价格历史</h1>', `<h1>${config.name} 模型价格历史</h1>`)
    .replace('追踪 OpenAI GPT-5 及以上模型的 Standard 和 Batch 价格变化。', descriptions[provider])
    .replace('<small>GPT-5 及以上</small>', '<small>官方价格页全部模型</small>')
    .replace('<small>Standard + Batch</small>', '<small>各价格类型</small>')
    .replace('<option>Standard</option><option>Batch</option>', '')
    .replace('按日期查看每日采集到的价格行', '仅在模型或价格变化时保存快照；每日检查结果见页面底部')
    .replace(/<thead>[\s\S]*?<\/thead>/, '<thead><tr><th>日期</th><th>模型</th><th>类型</th><th>价格明细</th><th>Wayback</th></tr></thead>')
    .replace('colspan="6"', 'colspan="5"')
    .replace('比较模型在所选价格类型和价格列下的每日变化', '比较单一数值的价格变化；多条件复合价格请查看列表明细');
  await mkdir(join(root, provider), { recursive: true });
  await writeFile(join(root, provider, 'index.html'), html);
}
