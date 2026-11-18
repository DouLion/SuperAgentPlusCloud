# AGENTS｜Client

给后续 Agent 的 Client 开发约定。设计依据：`docs/03_总体架构.md`、`docs/05_实施计划.md`。

## 目录约定

- `bin/sap.mjs`：进程入口，负责参数分发与退出码；不写业务逻辑。
- `src/help.mjs`：帮助文本与命令清单（新增命令时同步登记）。
- `src/api.mjs`：Center HTTP 客户端（T2 起新增，唯一发出请求的地方）。
- `src/commands/*.mjs`：每个命令一个文件，如 `commands/submit.mjs`。
- `test/*.test.mjs`：命令与 API 的单元测试。

## 命名约定

- 命令名用单个英文单词，动作为主：`submit`、`decide`、`claim`、`deliver`、`review`。
- ID 参数统一 `--requirement <req_id>`、`--task <task_id>` 形式，值带 ID 前缀，便于肉眼识别对象类型。
- 输出给人看的内容用中文；错误信息写到 stderr，正常结果写到 stdout。

## 配置约定

- Center 地址只从环境变量读取：`CENTER_URL`，默认 `http://127.0.0.1:8787`。
- 禁止把绝对地址、令牌硬编码进代码。
- 需要本地覆盖时用环境变量，不改默认值。

## 退出码约定

- `0`：成功（含 `--help`）。
- `1`：未知命令、缺少参数、Center 返回错误或命令尚未实现。
- 不得在未实现时静默返回 0。

## 测试方式

```powershell
npm test
# 或根目录：node --test client/test/
```

- 用 `node:test` + `node:assert/strict`，零外部依赖。
- 不启动真实 Center；HTTP 交互通过注入 fetch/适配器进行替身测试。
- 避免在测试里用子进程管道捕获输出（Windows 沙箱下命名管道受限）。

## 禁止事项

- 禁止引入第三方依赖，禁止 `npm install`。
- 禁止接入任何编码 CLI（如 Claude Code、Codex 等），Client 只与 Center 交互。
- 禁止修改 `docs/` 下文档。
- 禁止执行 `git add` / `git commit` / `git push`。
- 禁止把服务端下发的“建议”当作已确认结论展示，UI 文案需区分建议与确认。
