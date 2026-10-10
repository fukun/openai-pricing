# API 模型价格观察

每天北京时间 08:00 采集 OpenAI、DeepSeek、Claude 和 Gemini 官方 API 模型价格，分别保存数据并发布独立的价格历史页面。四家共用列表、图表、可搜索模型下拉框、日期/价格类型筛选和 CSV 导出功能。

| 页面 | 采集范围 | 官方来源 |
| --- | --- | --- |
| [OpenAI](https://fukun.github.io/openai-pricing/) | GPT-5 及以上的 Standard、Batch | [价格页](https://developers.openai.com/api/docs/pricing?latest-pricing=batch) |
| [DeepSeek](https://fukun.github.io/openai-pricing/deepseek/) | 官方全部模型，高峰/非高峰、缓存命中/未命中 | [价格页](https://api-docs.deepseek.com/quick_start/pricing) |
| [Claude](https://fukun.github.io/openai-pricing/claude/) | 官方模型表全部条目，Standard、Batch、Fast、缓存读写 | [价格页](https://platform.claude.com/docs/en/about-claude/pricing) / [Markdown](https://platform.claude.com/docs/en/about-claude/pricing.md) |
| [Gemini](https://fukun.github.io/openai-pricing/gemini/) | 官方 API 价格页的全部模型（含音频、图片、视频、嵌入等），付费价格及各价格类型 | [Markdown](https://ai.google.dev/gemini-api/docs/pricing.md.txt?hl=zh-cn) |

Gemini 仅采集及展示付费价格。各家保存官方价格单位、条件及模型原始标签；页面精简显示，完整条件可悬停查看，导出保留原值，不将按秒、按图片或按请求计费误标为 token 单价。独立的第三方云平台、工具和代理计费表不在模型监控范围内。模型表中的工具附加价格保留在对应模型的价格明细中。

图表仅绘制可明确取值的单价；含多上下文条件、多模态金额或未来分阶段调价的复合单元格保留完整原文，不取第一个数字冒充统一价格。OpenAI 页面继续保留短/长上下文两列。

## 变化检测与归档

每天从 [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=batch) 采集 GPT-5 及以上 GPT 系列模型的 **Standard** 和 **Batch** 价格。采集器读取官方价格组件的完整模型数据（包括页面上需要点击 **All Models** 才会展开的模型），而不是只读取默认显示的几行。只有模型或价格变化时才保存价格快照并归档官方 Markdown 页面到 Wayback Machine；Wayback 归档时间戳用于区分不同版本。未变化的采集会写入每日采集日志，但不会新增价格记录或 Wayback 快照。

仓库还包含一个静态仪表盘，支持搜索并筛选模型、按日期和价格类型过滤，以列表或价格走势图查看历史数据。列表可导出为 CSV，导出内容遵循当前筛选条件。

模型名会与官方表格附带的价格适用条件分开保存；例如 `<272K context length` 不会拼进模型名，原始官方标签仍可在 CSV 导出中查看。

## 数据

`data/pricing_history.jsonl` 每行是一条 JSON 记录，包含采集时间、日期、模型、价格类型、官网表头、价格行、来源链接和对应的 Wayback 归档链接。价格单位沿用官网页面（通常是 USD / 1M tokens）。`data/collection_log.jsonl` 每天记录一次采集结果，包括价格未变化的日期。

新增三家的数据分别保存在 `data/deepseek/`、`data/claude/`、`data/gemini/`，各自包含 `pricing_history.jsonl`、`collection_log.jsonl` 和 `sources/`。只有模型、模型版本、价格或价格适用条件变化时写入价格快照及完整采集原文；未变化只更新日志。历史按 UTC 日期保存，同一天重复采集保留该天最后一次价格快照和日志，之前日期不会被覆盖。

保存键包含官方原始模型标签及价格条件，同一模型不同上下文档位分别保存。采集时用已有原文恢复旧快照中曾被覆盖的价格档位；JSONL 使用临时文件加原子替换写入，避免写入中断留下半个文件。

DeepSeek 保存 HTML 原文为 `.html.txt`，Claude 和 Gemini 保存官方 Markdown 原文。新增三家在 Wayback 暂时失败时仍保存价格及原文，标记归档待重试；后续检查可以补全之前未成功的归档链接。原文复制和价格历史不会因为归档重试而重复新增。

四家每次提交新归档时，在官方 URL 末尾添加 `capture_id` 参数，值为随机生成的 32 位小写十六进制字符串。例如 `pricing.md?capture_id=<32位随机字符串>`；Gemini 保留原有 `hl=zh-cn`，使用 `&capture_id=...`。实际提交地址保存在 `archive_source_url` 中，归档校验与已返回链接的重试都使用该地址，不重新生成参数。只有任务完成且归档内容校验通过才标记成功。已有有效归档继续复用；模型和价格未变化时不会为添加随机参数而重新归档。

Actions 将所有 `data/` 更新提交到 `main`，再部署到 Pages。四家的采集互相独立，一家失败仍会检查其余三家并发布可用数据和失败日志。

采集后自动检查所有日期的归档状态，每次最多尝试补齐 3 个历史快照。优先校验已有候选链接，或复用模型、价格及条件完全一致的其他日期归档；复用记录保存 `archive_reused_from_date`。仅当前价格仍与历史快照一致时重新提交官方页面，避免用今天的价格冒充历史价格。历史价格已变化且没有匹配归档时保留待重试及原因。价格日期和原文保持其原始采集时间。

每日日志的 `archive_repair` 记录已补齐日期、剩余待重试日期及错误原因；页面底部显示历史归档待重试数量。Actions 摘要汇总四家的采集及归档结果，有采集失败或任一日期归档待补齐时，会在保存数据并发布页面后将任务标记为失败。

OpenAI 低于 GPT-5 的模型、非 GPT 数字系列模型（例如 o 系列、Realtime）不会采集；这条筛选规则不应用于其他三家。Claude 的已退役/限量开放模型仍按官方表格保留原始状态说明。

## 本地运行

推荐 Node.js 24，无需安装第三方包。采集全部四家：

```sh
node collect_all.mjs
```

只采集 OpenAI：

```sh
node collect_pricing.mjs
```

只采集新增三家或指定一家：

```sh
node collect_providers.mjs
node collect_providers.mjs claude
```

单独补齐历史归档及生成状态报告：`node repair_archives.mjs`。本地使用账号时同样可通过 `--env-file=.env` 加载密钥。

本机设置了 HTTP(S) 代理时，可用支持该选项的 Node.js 版本执行 `node --use-env-proxy collect_all.mjs`。官方页面受本机所在地区或网络限制时，采集日志会显示失败原因。

生成三个独立页面和运行解析/存储检查：

```sh
node build_pages.mjs
node --test tests/pricing.test.mjs
```

## 每日运行

`.github/workflows/daily-pricing.yml` 在每天 **北京时间 08:17** 计划运行，避开整点高峰，更新数据后自动部署四个页面到 GitHub Pages。GitHub 定时触发仍可能延迟，日志记录计划时间、实际开始时间及 `schedule_delay_minutes`，不承诺准点。将项目推送到 GitHub 并启用 Actions 后，需在仓库设置的 **Pages → Build and deployment → Source** 选择 **GitHub Actions**；随后可在 Actions 页面手动触发 `Collect model pricing`。

四家模型下拉框按最近一次成功采集的官方价格文档顺序排列；已从官网下架、仅历史记录存在的模型放在末尾。每日检查日志保存模型顺序，官方调整排序不会触发新的价格快照或归档。

价格表头问号说明省略的单位及计费注意事项。Gemini 列表优先显示输入、输出、缓存价格，附加费用、换算及完整条件可悬浮或点击每行“详情”查看；CSV 保留原始数据。

四家的 Wayback 保存结果及已有链接都会验证实际回放时间、来源 URL 和内容。OpenAI 比对采集的 Markdown 原文，其余三家比对解析后的模型/价格；跳转旧版本或内容不匹配会标记归档待重试，不展示失配链接。归档失败不影响价格保存，无价格变化只更新检查日志并重试待完成归档。

四家采集流程同步完成归档回放校验，最多检查 3 次；内容一致才记录归档成功并显示“查看”。本次检查失败统一显示“归档待重试”，保留返回地址供后续重试，避免重复提交保存。内容一致的旧快照可使用其实际时间戳链接。

## Internet Archive 账号认证与结果邮件

在仓库 Settings → Secrets and variables → Actions 中添加两个 Repository secrets：

- `IA_ACCESS_KEY`：Internet Archive S3 access key。
- `IA_SECRET_KEY`：Internet Archive S3 secret key。

两者配置后，四家共用的归档程序将使用认证 API 提交请求，等待任务状态成功，再校验归档内容。每次实际提交新归档时，会请求 Wayback 向该账号的注册邮箱发送结果报告；模型和价格未变化且已有有效归档时，不重复归档或发邮件。

四家顺序采集时相隔 30 秒；认证 API 遇到 HTTP 429 时按 `Retry-After` 等待（未提供时等待 60 秒），网络异常及 HTTP 502/503/504 也会退避重试。最多重试两次，并受整个归档任务三分钟等待上限约束；返回时间戳须通过真实日期校验。

程序通过任务状态及内容校验判断成功，不自动读取邮箱。没有配置两个 Secrets 时，继续使用匿名保存。密钥不写入代码、历史数据或日志。

本地运行可从未提交的 `.env` 文件加载密钥：`node --env-file=.env collect_all.mjs`。设置 `IA_EMAIL_RESULT=0` 可关闭结果邮件请求。
