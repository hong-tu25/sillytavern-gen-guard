# Generation Guard

**修复手机端 SillyTavern 退到后台后流式卡死、必须重开浏览器的问题。**

[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-7c3aed)](https://github.com/SillyTavern/SillyTavern)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](LICENSE)
[![No Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](index.js)
[![No Build Step](https://img.shields.io/badge/build-none-brightgreen)](index.js)

[English](README.en.md) · [繁體中文](README.zh-TW.md)

---

## 问题

在手机上使用 SillyTavern 时，如果流式生成期间把浏览器切到后台（锁屏、切 App、息屏），
回到浏览器后界面会**永久锁死**：

- 无法发送消息、无法重新生成 / 继续 / 扮演
- 无法新建聊天、无法查看历史
- 只能刷新或重开浏览器

同时 Termux 终端会成对打印：

```
Streaming request in progress
Streaming request finished
```

## 根因

浏览器进入后台后，客户端流式读取可能永久挂起：

| 环节 | 代码位置 |
| --- | --- |
| 流式读取无超时 | `await reader.read()` — `public/scripts/openai.js:3170` |
| `Generate()` 只靠 Promise settle 收尾 | `.then(onSuccess, onError)` — `public/script.js:5453` |
| 该 Promise 不 settle，则两个回调都不执行 | `public/script.js:5396`、`3875` |
| 于是 `is_send_press` 永久为 `true` | 设于 `public/script.js:4986`，仅 `5699` 复位 |
| `is_send_press === true` 门禁几乎所有主操作 | `public/script.js:1739`、`11598-11659` |

客户端**完全没有** `visibilitychange` / `pagehide` 处理，所以没有任何检测或恢复机制。

## 本扩展怎么修

在**不改动 SillyTavern 任何源码**的前提下切断这条路径：

1. **隐藏后宽限中止** —— 页面隐藏后等待 `hiddenGraceMs`（默认 3000ms），若仍未完成，调用
   `stopGeneration()` 主动中止。这会让挂起的读取立刻失败，酒馆的正常解锁逻辑随即执行。
2. **回前台静默兜底** —— 回到前台后，若仍判定生成中且连续 `stallMs`（默认 5000ms）
   无任何新内容（内容变化或 token 事件），再次中止并强制解锁界面。
3. **只提示，不自动重试** —— 避免在用户不知情时多消耗 API 额度。

> 判定"是否仍在生成"使用 `streamingProcessor.isFinished`，因为酒馆**没有**把
> `isGenerating()` 暴露给扩展（`public/scripts/st-context.js`）。

## 安装

### 方式一：手动放置（推荐，无需 git / 无需联网）

1. 下载本仓库（点 `Code` → `Download ZIP`），取出其中的 `index.js`、`manifest.json`、`settings.html`
2. 放进酒馆的 `public/scripts/extensions/third-party/gen-guard/`
3. **刷新酒馆页面** —— 扩展列表只在页面加载时扫描
4. 打开 **扩展程序** 面板 → 找到 **Generation Guard** → 启用
5. 到扩展设置里确认 `启用 Generation Guard` 已勾选

最终结构必须是：

```
SillyTavern/public/scripts/extensions/third-party/gen-guard/
├── manifest.json
├── index.js
└── settings.html
```

⚠️ 必须多一层 `gen-guard` 目录。直接把三个文件丢在 `third-party/` 下面是**不会生效**的：
酒馆按"子目录 + 内含 manifest.json"识别第三方扩展。

### 方式二：Termux / Linux 一行命令

```bash
git clone https://github.com/<你的用户名>/sillytavern-gen-guard /tmp/gen-guard
mkdir -p ~/SillyTavern/public/scripts/extensions/third-party/gen-guard
cp /tmp/gen-guard/{manifest.json,index.js,settings.html} \
   ~/SillyTavern/public/scripts/extensions/third-party/gen-guard/
```

### 方式三：通过酒馆「安装扩展程序」

在酒馆的 **扩展程序 → 安装扩展程序** 里填入本仓库的 Git URL（例如
`https://github.com/<你的用户名>/sillytavern-gen-guard`），安装后刷新页面并启用。
仓库根目录同时带有 `index.js` / `manifest.json` / `settings.html`，因此可直接被酒馆拉取。

## 配置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用 Generation Guard | 开 | 总开关。关闭后立即停止一切检测（不残留计时器） |
| 后台宽限期（毫秒） | `3000` | 页面隐藏后多久仍未完成就中止。**设为 0 = 隐藏即中止** |
| 卡死判定阈值（毫秒） | `5000` | 回到前台后，多久无新内容就判定卡死并解锁（下限 1000） |
| 显示提示 | 开 | 是否弹出 toast 提示 |
| 诊断日志 | 开 | 是否在控制台输出 `[gen-guard]` 前缀日志 |

### 调参建议

- **仍然卡死** → 把后台宽限期调小（如 `1000`）或设为 `0`
- **正常生成被误中止** → 把后台宽限期调大（如 `10000`），或调大卡死判定阈值
- **排查问题** → 保持诊断日志开启，控制台可看到：

```
[gen-guard] event=visibilitychange hidden=true wasHidden=false generating=true hiddenGraceMs=3000
[gen-guard] check=hidden_grace elapsedMs=3000 generating=true
[gen-guard] action=abort reason=hidden_grace_elapsed kind=hidden
[gen-guard] check=stall silentMs=5000 threshold=5000
```

## 配套建议（Termux / Android）

扩展只处理"客户端状态被卡住"。若 Termux 进程本身被系统冻结，服务端仍会停摆。建议同时：

- `termux-wake-lock`（获取唤醒锁）
- Android 设置里对 Termux **关闭电池优化**、允许后台运行
- 生成期间尽量避免锁屏

## 已知边界

- 不修复位于服务端的根因：`src/util.js` 的流式转发缺少写超时与心跳，
  且存在"监听器挂载晚于流结束"的竞态。彻底修复需要改酒馆源码。
- **不会自动重试**，中止后请手动点「继续」。
- 未做多标签页协调：若多标签同时生成，后台标签的自动中止会误杀前台标签的生成。

## 开发与自测

本扩展为**零依赖、无构建**的纯 ES module。测试套件通过依赖注入替换定时器与
`SillyTavern.getContext()`，因此可在纯 Node 下确定性地验证全部时序逻辑，无需浏览器。

```bash
node tests/run.mjs
```

覆盖 29 个逻辑用例（宽限期边界、静默兜底、幂等、竞态、提示、诊断日志、降级）与
11 个静态契约用例（manifest 字段、面板控件、无网络请求、无静态 import、双份副本一致性、
ESM 标记与零依赖、内联兜底与模板控件一致、失败路径可见性等），共 40 个。

> `extension/package.json` 只声明 `{"type": "module"}`，用于让 Node 18 正确把 `index.js`
> 当 ES module 解析（Node 22+ 会自动嗅探 ESM 语法，因此这个坑只在旧版本上暴露）。
> **仓库根目录故意不放 `package.json`**，这样酒馆的「安装扩展程序」拉取到的就是干净的扩展文件。

## 许可

[AGPL-3.0-or-later](LICENSE)，与 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 主项目一致。
