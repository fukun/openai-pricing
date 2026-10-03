# OpenAI GPT-5+ pricing history

每天从 [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=batch) 采集 GPT-5 及以上 GPT 系列模型的 **Standard** 和 **Batch** 价格。价格表的表头和原始价格行会一并保留，以适应不同上下文长度和缓存价格列。

仓库还包含一个静态仪表盘，支持按日期、模型和价格类型筛选，并以列表或价格走势图查看历史数据。

## 数据

`data/pricing_history.jsonl` 每行是一条 JSON 记录，包含采集时间、日期、模型、价格类型、官网表头、价格行和来源链接。价格单位沿用官网页面（通常是 USD / 1M tokens）。重复运行会更新当天同一记录，不会重复追加。

低于 GPT-5 的模型、非 GPT 数字系列模型（例如 o 系列、Realtime）不会采集。

## 本地运行

需要 Node.js 18 或更新版本，无需安装第三方包：

```sh
node collect_pricing.mjs
```

## 每日运行

`.github/workflows/daily-pricing.yml` 在每天 **北京时间 08:00** 运行，更新数据后自动部署仪表盘到 GitHub Pages。将项目推送到 GitHub 并启用 Actions 后，需在仓库设置的 **Pages → Build and deployment → Source** 选择 **GitHub Actions**；随后可在 Actions 页面手动触发 `Collect OpenAI model pricing`。
