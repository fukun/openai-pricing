# OpenAI GPT-5+ pricing history

每天从 [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=batch) 采集 GPT-5 及以上 GPT 系列模型的 **Standard** 和 **Batch** 价格。采集器读取官方价格组件的完整模型数据（包括页面上需要点击 **All Models** 才会展开的模型），而不是只读取默认显示的几行。适用的最新模型也会记录短上下文和长上下文价格。

仓库还包含一个静态仪表盘，支持搜索并筛选模型、按日期和价格类型过滤，以列表或价格走势图查看历史数据。列表可导出为 CSV，导出内容遵循当前筛选条件。

模型名会与官方表格附带的价格适用条件分开保存；例如 `<272K context length` 不会拼进模型名，原始官方标签仍可在 CSV 导出中查看。

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
