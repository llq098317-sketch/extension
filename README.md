# 随译 —— 浏览器沉浸式翻译插件（自用）

Edge/Chrome 扩展（Manifest V3）。右侧悬浮窗一键沉浸式翻译网页，译文以与原文相同的样式直接嵌在原文正下方，翻译由 DeepSeek `deepseek-v4-flash` 提供。

## 功能

- **右侧悬浮窗**：常驻页面右侧垂直居中，不随滚动。
- **点击翻译**：单击悬浮窗翻译整页 / 正文主体（可在设置中切换范围）；再点一次还原原文。
- **译文样式一致**：译文继承原文的字体、字号、颜色、行高，淡入显示。
- **长按拖动**：长按悬浮窗（≥500ms）上下拖动调整位置，松开记忆。
- **悬停设置**：鼠标悬停时，悬浮窗下方淡入淡出「⚙」按钮，点击打开控制面板。
- **控制面板**：配置 API Key、目标语言、源语言、模型名、翻译范围、译文样式、总是翻译。
- **总是翻译**：开启后，命中语言列表的外语页面自动翻译。
- **DeepSeek 接入**：批量调用 OpenAI 兼容接口，带重试与限流。

## 加载（Edge）

1. 打开 `edge://extensions`
2. 右上角开启「开发人员模式」
3. 点击「加载解压缩的扩展」→ 选择本目录：`D:\Ds\claude\浏览器翻译插件\extension`
4. 点击扩展图标，在控制面板填入 DeepSeek API Key 并「测试连接」

## 目录结构

```
extension/
  manifest.json       # MV3 声明
  background.js       # service worker：DeepSeek API 代理（唯一接触 API Key 的地方）
  content_guard.js    # 隔离世界：注入主脚本 + 页面<->后台 通信桥
  content_main.js     # 页面主世界：悬浮窗 UI、DOM 翻译引擎、译文渲染
  styles/inject.css   # 注入样式
  icons/              # 16/48/128 图标
```

## 通信架构

```
页面主世界(content_main.js)
   │  window.postMessage({suiYiBridge, type, payload, reqId})
   ▼
隔离世界(content_guard.js) ──转发──▶ background.js
   │  chrome.runtime.sendMessage          │
   │                                      ▼
   │                              fetch api.deepseek.com (含 API Key)
   ◀──────────────────────────────────────┘ 响应回传
```

页面脚本**永远接触不到 API Key**；Key 只存在于扩展后台。

## 隐私

- API Key 仅存 `chrome.storage.sync`，仅在 `background.js` 内使用。
- 不采集、不上传任何页面数据；唯一的外部请求是发送给 DeepSeek 的待翻译文本。

## 验证清单

1. 悬浮窗右侧垂直居中显示。
2. 点击 → 译文嵌入原文正下方、样式一致、淡入出现；再点 → 还原。
3. 长按拖动，位置记忆（刷新后仍在原处）。
4. 悬停 → 设置按钮淡入 → 打开面板。
5. 面板填 Key → 测试连接成功 → 保存。
6. 英文/日文页面开启「总是翻译」→ 打开自动翻译。
