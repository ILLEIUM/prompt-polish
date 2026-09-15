# Prompt Polish · 提示词润色

> **AI-assisted project.** This plugin was designed, implemented, and debugged with substantial assistance from an AI coding agent.
>
> **本项目由 AI 辅助完成。** 插件的设计、实现与调试大量借助 AI 编程代理完成。

按 **Tab** 键，把聊天输入框里的草稿就地润色成一份高质量、可直接执行的任务提示词。

Press **Tab** to polish the draft in the chat composer into a high-quality, ready-to-execute task prompt — in place, with review before sending.

## 特性 / Features

- ⌨️ **Tab 键触发** — 焦点在输入框、草稿非空时按 Tab 即润色；结果浮条提供「应用到草稿 / 再润色 / Esc 关闭」
- 🔄 **迭代润色** — 对已润色文本再按 Tab 继续加深打磨
- 🧠 **零额外费用主路径** — 默认使用你 Hermes 已配置的模型（辅助任务 `prompt_polish`）完成重写，不引入新的 API 账单
- 🌐 **prompts.chat 集成（可选）** — 配置 `PROMPTS_API_KEY` 后，官方 `improve_prompt` 作为备选引擎；失败自动静默降级
- 🔍 **社区检索兜底** — 所有路径都不可用时，用草稿关键词检索 [prompts.chat](https://prompts.chat) 社区提示词库，点选即填入全文
- 🎨 **原生桌面 UI / Native UI** — 状态栏标记 + 输入框上方结果条，跟随主题变量换肤；文案内置 en/zh 双语包，跟随 App 显示语言自动切换

## 环境要求 / Requirements

- Hermes Agent ≥ 0.20，且使用 Hermes **桌面 App**（`hermes desktop`）
- 润色主路径复用桌面端已连接的模型配置，无需额外 Key

## 安装 / Install

```bash
# 1) 克隆到 Hermes 插件目录（Linux/macOS 示例；Windows 为 %HERMES_HOME%\plugins\）
git clone <this-repo-url> ~/.hermes/plugins/prompt-polish

# 2) 启用 Python 后端半边（挂载 /api/plugins/prompt-polish 路由）
hermes plugins enable prompt-polish

# 3) 复制桌面半边到桌面插件门（Electron 渲染进程从这里热加载）
mkdir -p ~/.hermes/desktop-plugins/prompt-polish
cp ~/.hermes/plugins/prompt-polish/desktop/plugin.js ~/.hermes/desktop-plugins/prompt-polish/plugin.js

# 4) 重启 Hermes 桌面 App（后端路由在 serve 进程启动时挂载）
```

然后到 **Capabilities → Plugins**（设置 → 插件）把 **Prompt Polish** 的开关打开（桌面半边默认 opt-in）。

## 可选：配置 prompts.chat Key / Optional API key

1. 在 [prompts.chat/settings](https://prompts.chat/settings) 生成 API Key
2. 写入 `$HERMES_HOME/.env`（**只放这里，不要提交任何版本库**）：

```
PROMPTS_API_KEY=pchat_x…xxxx
```

未配置时插件照常工作（本机模型主路径 + 社区检索兜底）。

## 工作原理 / Architecture

```
[Desktop renderer]                [Gateway / serve process]
 plugin.js                         plugin_api.py
  · Tab 捕获（window 捕获层）  ──▶   · /polish
  · 结果浮条 / 应用草稿               · 1) 本机辅助模型润色（主路径）
                                      · 2) improve_prompt via prompts.chat MCP（有 Key 时）
                                      · 3) search_prompts 社区检索兜底
```

渲染进程不直连外部 API（CORS 限制），所有外呼由 Python 桥转发；Key 只存在于服务端 `.env`，前端不接触。

## 文件结构 / Layout

```
__init__.py            # agent 半边占位模块（加载器要求）
plugin.yaml            # 插件清单
desktop/plugin.js      # 桌面 UI 半边（Tab 劫持、结果浮条、状态栏标记）
dashboard/manifest.json
dashboard/plugin_api.py  # 后端桥：润色路由与降级链
```

## 致谢 / Credits

- [Hermes Agent](https://hermes-agent.nousresearch.com/) — 宿主应用与插件 SDK
- [prompts.chat](https://prompts.chat) — 社区提示词库与 improve API

## 许可证 / License

[MIT](LICENSE) — 版权保留至 contributors（匿名发布）。
