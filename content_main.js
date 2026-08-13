// 随译 content_main.js
// 由 content_guard.js 动态注入页面主世界执行。
// 职责：悬浮窗 UI、交互、DOM 翻译引擎、批量调用、译文渲染与还原。
// 约束：ES5 风格（无 let/const/箭头/可选链），无构建，无外部依赖。

(function () {
  "use strict";

  if (window.__suiyi_main_init__) {
    return;
  }
  window.__suiyi_main_init__ = true;

  // ---------- 配置与状态 ----------
  var DEFAULTS = {
    apiKey: "",
    model: "deepseek-v4-flash",
    sourceLang: "auto",
    targetLang: "zh-Hans",
    translateMode: "page", // page = 整页, main = 正文主体
    style: "same", // same / underline / highlight / block
    alwaysTranslate: false,
    alwaysLanguages: ["en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
    alwaysOnlyTargetNotTranslated: true,
    skipPureNumbers: true, // 跳过纯数字块（如 12345、1.2.3、2024）
    lazyMode: true, // 滚动到哪译到哪；关闭则一次翻译整页
    immersiveMode: true, // 沉浸式翻译：译文放原文下方；关闭则译文替换原文
    hotkey: "Alt+A", // 翻译快捷键（面板可录制自定义）
    temperature: 0.2
  };

  var settings = {};
  var translated = false; // 当前整页是否处于已翻译状态
  var translating = false; // 是否正在翻译中
  var cleanupFns = []; // 页面上可清除的事件监听（还原后移除）
  var bgReady = false;

  var state = {
    isTop: window.self === window.top
  };

  // ---------- 桥接：页面脚本 <-> 扩展后台 ----------
  // 页面主世界没有 chrome.runtime / chrome.storage，
  // 通过 window.postMessage 与 content_guard（隔离世界）通信，由它转发后台/存储。

  var bgSeq = 0;
  var bgPending = {};

  function bgSend(type, payload) {
    return new Promise(function (resolve, reject) {
      var reqId = (++bgSeq);
      bgPending[reqId] = { resolve: resolve, reject: reject };
      // 长文翻译单次响应可能 30-40s，超时放宽到 75s（> guard 的 60s）
      var timer = setTimeout(function () {
        if (bgPending[reqId]) {
          delete bgPending[reqId];
          reject(new Error("后台响应超时"));
        }
      }, 75000);
      bgPending[reqId].timer = timer;
      window.postMessage({ suiYiBridge: true, type: type, payload: payload, reqId: reqId }, "*");
    });
  }

  // 读取设置（含 API Key）：由 guard 从 storage 读取后经桥回传
  // DEFAULTS 之外的键（如 fabTop）一并保留，避免丢键。
  function loadSettings() {
    return bgSend("ds-get-settings").then(function (data) {
      var merged = {};
      var key;
      for (key in DEFAULTS) {
        merged[key] = (data && typeof data[key] !== "undefined") ? data[key] : DEFAULTS[key];
      }
      if (data && typeof data.fabTop === "number") {
        merged.fabTop = data.fabTop;
      }
      return merged;
    });
  }

  function saveSettings(partial) {
    return bgSend("ds-set-settings", partial);
  }

  function saveFabTop(top) {
    window.postMessage({ suiYiBridge: true, type: "ds-fab-position", payload: { top: top } }, "*");
  }

  // 接收 guard 回传的响应（按 reqId 匹配）
  // 注意：页面发出的请求消息也会被本监听器收到（同一 window），
  // 因此只处理响应类型（type 以 -resp 结尾），避免把请求自身当成响应。
  window.addEventListener("message", function (event) {
    if (!event.data || event.data.suiYiBridge !== true) {
      return;
    }
    var type = event.data.type;
    var payload = event.data.payload;
    var reqId = event.data.reqId;
    if (!reqId || !type || type.indexOf("-resp") === -1) {
      return;
    }
    var p = bgPending[reqId];
    if (!p) {
      return;
    }
    clearTimeout(p.timer);
    delete bgPending[reqId];
    p.resolve(payload);
  });

  // ---------- 工具函数 ----------
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(null, args);
      }, wait);
    };
  }

  function getLangFromHTML() {
    var el = document.documentElement;
    if (!el) {
      return "auto";
    }
    var lang = el.getAttribute("lang") || el.getAttribute("xml:lang") || "";
    return lang.split("-")[0].toLowerCase();
  }

  function isChinesePage() {
    var lang = getLangFromHTML();
    return lang === "zh" || lang === "zh-hans" || lang === "zh-hant" || lang === "zh-hk" || lang === "zh-tw" || lang === "zh-cn";
  }

  function isTargetLangPage() {
    var lang = getLangFromHTML();
    var target = (settings.targetLang || "zh-Hans").toLowerCase();
    return lang === target || lang === target.split("-")[0];
  }

  // 页面语言是否命中"总是翻译"列表
  function shouldAutoTranslate() {
    if (!settings.alwaysTranslate) {
      return false;
    }
    var lang = getLangFromHTML();
    if (!lang) {
      return false;
    }
    var list = settings.alwaysLanguages || [];
    if (list.indexOf(lang) === -1) {
      return false;
    }
    if (settings.alwaysOnlyTargetNotTranslated && isTargetLangPage()) {
      return false;
    }
    return true;
  }

  // 过滤已翻译节点（避免重复注入）
  function isTranslatedNode(node) {
    return node.nodeType === 1 && (node.getAttribute("data-mt-role") === "translation" || node.getAttribute("data-suiyi-translated") === "1");
  }

  // 块是否已翻译：直接模式（块内译文 div）或替换模式（块自身 data-suiyi-replaced）
  function isBlockTranslated(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    if (el.getAttribute("data-suiyi-replaced") === "1") {
      return true;
    }
    // 直接模式：块内是否有译文节点
    var children = el.children;
    for (var i = 0; i < children.length; i += 1) {
      if (isTranslatedNode(children[i])) {
        return true;
      }
    }
    return false;
  }

  // ---------- 主题样式 ----------
  function getThemeStyles(style) {
    if (style === "highlight") {
      return {
        background: "rgba(255, 235, 59, 0.18)",
        borderLeft: "none",
        borderBottom: "none"
      };
    }
    if (style === "underline") {
      return {
        background: "transparent",
        borderBottom: "1px solid rgba(0, 0, 0, 0.25)",
        borderLeft: "none"
      };
    }
    if (style === "block") {
      return {
        background: "rgba(127, 127, 127, 0.08)",
        borderLeft: "3px solid rgba(0, 0, 0, 0.12)",
        borderBottom: "none"
      };
    }
    // same：无任何视觉区分
    return {
      background: "transparent",
      borderLeft: "none",
      borderBottom: "none"
    };
  }

  // ---------- DOM 收集：按块收集文本 ----------
  function isVisible(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var style = getComputedStyle(el, null);
    if (!style) {
      return false;
    }
    return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") > 0.05;
  }

  function isInViewport(el) {
    if (el.getBoundingClientRect) {
      var rect = el.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) {
        return true; // 无法确定尺寸时默认保留
      }
      var w = window.innerWidth || document.documentElement.clientWidth;
      var h = window.innerHeight || document.documentElement.clientHeight;
      return rect.bottom >= -50 && rect.top <= h + 50 && rect.right >= -50 && rect.left <= w + 50;
    }
    return true;
  }

  var SKIP_TAGS = {
    SCRIPT: true,
    STYLE: true,
    PRE: true,
    CODE: true,
    NOSCRIPT: true,
    TEXTAREA: true,
    INPUT: true,
    SELECT: true,
    OPTION: true,
    SVG: true,
    CANVAS: true,
    IFRAME: true,
    BUTTON: true,
    LABEL: true,
    KBD: true,
    SAMP: true,
    TEMPLATE: true,
    VIDEO: true,
    AUDIO: true
  };

  var BLOCK_TAGS = {
    P: true,
    H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
    LI: true,
    BLOCKQUOTE: true,
    TD: true,
    TH: true,
    FIGCAPTION: true,
    DD: true,
    DT: true,
    CAPTION: true,
    SUMMARY: true,
    DIV: true,
    SECTION: true,
    ARTICLE: true,
    ASIDE: true,
    MAIN: true,
    NAV: true,
    HEADER: true,
    FOOTER: true
  };

  // 最近块级祖先
  function nearestBlock(el) {
    var n = el;
    while (n && n.nodeType === 1 && n.nodeName !== "BODY") {
      if (BLOCK_TAGS[n.nodeName]) {
        return n;
      }
      n = n.parentNode;
    }
    return null;
  }

  // 内联标签（不翻译，但保留在块内）
  var INLINE_TAGS = {
    SPAN: true, EM: true, STRONG: true, B: true, I: true, U: true, A: true,
    MARK: true, SMALL: true, SUB: true, SUP: true, ABBR: true, BDI: true,
    BDO: true, DATA: true, TIME: true, WBR: true, BR: true
  };

  // 一个块是否应跳过（块本身是跳过标签，例如 pre/code 块）
  function isSkipBlock(el) {
    return !!(el && el.nodeType === 1 && SKIP_TAGS[el.nodeName]);
  }

  // 是否在"不翻译容器"内（script/style/textarea/input/svg 等，沿父链检查）。
  // 解决：脚本内容文本节点的最近块级祖先不是 script（script 是行内元素），
  // 会被 isSkipBlock(nearestBlock) 漏过，导致页面脚本被当作正文翻译。
  function isInSkipContainer(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      if (SKIP_TAGS[n.nodeName]) {
        return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var style = getComputedStyle(el, null);
    if (!style) {
      return false;
    }
    return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") > 0.05;
  }

  function isInViewport(el) {
    if (el.getBoundingClientRect) {
      var rect = el.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) {
        return true; // 无法确定尺寸时默认保留
      }
      var w = window.innerWidth || document.documentElement.clientWidth;
      var h = window.innerHeight || document.documentElement.clientHeight;
      return rect.bottom >= -50 && rect.top <= h + 50 && rect.right >= -50 && rect.left <= w + 50;
    }
    return true;
  }

  // 是否纯数字块：整块都是数字/小数/百分比/版本号（如 12345、1.2.3、2024、3.14%、v1.0.2）
  function isPureNumber(text) {
    if (!text) {
      return false;
    }
    var trimmed = text.trim();
    if (trimmed.length === 0) {
      return false;
    }
    // 允许：数字、小数点、百分号、版本分隔符 . 或 -、前后可带 v/V
    return /^[vV]?[\d][\d.,%\-()/ ]*$/.test(trimmed);
  }

  // 文本是否已主要是目标语言（如中文）：中文字符占比超过阈值则视为"已是目标语言"，跳过翻译。
  function isTargetLanguageText(text) {
    var target = (settings.targetLang || "zh-Hans").toLowerCase();
    var isZh = target === "zh-hans" || target === "zh-hant" || target === "zh" || target === "zh-cn";
    if (!isZh) {
      return false; // 目标语言非中文时不做检测
    }
    if (!text) {
      return false;
    }
    var cjk = text.match(/[一-鿿㐀-䶿]/g);
    if (!cjk) {
      return false;
    }
    // 中文字符占可显示字符的比例超过 50% 视为已是中文
    var significant = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
    if (significant.length === 0) {
      return false;
    }
    return cjk.length / significant.length > 0.5;
  }

  // 是否在随译自己的 UI（悬浮窗）内：这些文字不应被翻译
  function isInSuiyiUI(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      if (n.id === "suiyi-fab-root" || n.id === "suiyi-panel-overlay") {
        return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  // 收集"叶块"：其最近块级祖先包含叶子文本节点的最小块。
  // 整页模式下返回 {block, texts:[..]}，正文主体模式下返回 {block, texts:[..]}（限定在 article/main）。
  // 每个块内的多个文本节点合并为一段文本；超过 MAX_BLOCK_CHARS 则按字符切分，保证单次请求规模可控。
  var MAX_BLOCK_CHARS = 1400;
  var blockSeq = 0;

  function collectTexts(mode) {
    var root = document.body;
    var mainRoot = null;
    if (mode === "main") {
      mainRoot = collectMainBlocks(root);
      if (!mainRoot) {
        return [];
      }
    }

    var map = {}; // key: __suiyi_id__ -> { el, texts: [] }
    var order = [];

    function getBlockEntry(el) {
      if (!el.__suiyi_id__) {
        el.__suiyi_id__ = (++blockSeq);
      }
      var entry = map[el.__suiyi_id__];
      if (!entry) {
        entry = { el: el, texts: [] };
        map[el.__suiyi_id__] = entry;
        order.push(entry);
      }
      return entry;
    }

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node = walker.nextNode();
    while (node) {
      var text = (node.nodeValue || "").trim();
      if (text.length > 0) {
        var parent = node.parentNode;
        var parentBlock = nearestBlock(parent);
        // 跳过已翻译的祖先/块、隐藏节点、不翻译容器（script/style/textarea 等，沿父链检查）、随译 UI
        if (parent && (isTranslatedNode(parent) || isBlockTranslated(parentBlock) || isInSkipContainer(parent) || !isVisible(parentBlock || parent) || isInSuiyiUI(parent))) {
          node = walker.nextNode();
          continue;
        }
        // 正文主体模式：只收集 mainRoot 内部
        if (mode === "main" && (!mainRoot || (parent !== mainRoot && !mainRoot.contains(parent)))) {
          node = walker.nextNode();
          continue;
        }
        // 最近块级祖先作为翻译块
        var block = nearestBlock(parent);
        if (block) {
          if (mode === "main" && !mainRoot.contains(block)) {
            node = walker.nextNode();
            continue;
          }
          getBlockEntry(block).texts.push(text);
        }
      }
      node = walker.nextNode();
    }

    // 把每个块的 texts 合并成段，超长按字符切分
    var units = [];
    order.forEach(function (entry) {
      var joined = entry.texts.join(" ");
      // 设置开启时跳过纯数字块（如 12345、1.2.3、2024）
      if (settings.skipPureNumbers && isPureNumber(joined)) {
        return;
      }
      // 已是目标语言（如中文）的文本自动跳过，不重复翻译
      if (isTargetLanguageText(joined)) {
        return;
      }
      var chunks = splitText(joined, MAX_BLOCK_CHARS);
      chunks.forEach(function (chunk, idx) {
        units.push({ el: entry.el, text: chunk, id: entry.el.__suiyi_id__ + (chunks.length > 1 ? "-" + idx : "") });
      });
    });
    return units;
  }

  // 视口优先排序：当前可见的块排前面先翻译，屏外的排在后面
  function sortUnitsByViewport(units) {
    return units.slice().sort(function (a, b) {
      var aIn = isInViewport(a.el);
      var bIn = isInViewport(b.el);
      if (aIn !== bIn) {
        return aIn ? -1 : 1; // 视口内的排前面
      }
      // 同为视口内：按垂直位置从上到下
      var aTop = a.el.getBoundingClientRect ? a.el.getBoundingClientRect().top : 0;
      var bTop = b.el.getBoundingClientRect ? b.el.getBoundingClientRect().top : 0;
      return aTop - bTop;
    });
  }

  function splitText(text, max) {
    var chunks = [];
    while (text.length > max) {
      chunks.push(text.slice(0, max));
      text = text.slice(max);
    }
    if (text.length > 0) {
      chunks.push(text);
    }
    return chunks;
  }

  function collectMainBlocks(root) {
    // 找正文主体：优先 article/main，否则最长文本容器
    var candidates = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    var node = walker.nextNode();
    while (node) {
      if (node.nodeName === "ARTICLE" || node.nodeName === "MAIN") {
        candidates.push(node);
      }
      node = walker.nextNode();
    }
    if (candidates.length > 0) {
      var best = null;
      var bestCount = -1;
      candidates.forEach(function (c) {
        var count = c.textContent ? c.textContent.length : 0;
        if (count > bestCount) {
          bestCount = count;
          best = c;
        }
      });
      if (best && bestCount > 50) {
        return best;
      }
    }
    // 兜底：取文本量最大的顶层块
    var topBest = null;
    var topBestCount = 0;
    for (var i = 0; i < root.children.length; i += 1) {
      var child = root.children[i];
      var c = child.textContent ? child.textContent.length : 0;
      if (c > topBestCount) {
        topBestCount = c;
        topBest = child;
      }
    }
    return topBest || root;
  }

  // ---------- 译文渲染 ----------
  // 默认：译文以 block 插到原文块末尾，显示在"原文正下方"。
  // 当原文块宽度不足（框太小）时，改为内联，译文紧跟原文横向排列（A+X）。
  function renderBlock(el, translatedText, theme) {
    if (!translatedText || !el) {
      return;
    }
    // 防重入：该块已翻译则跳过（直接模式查译文 div，替换模式查 replaced 标记）
    if (isBlockTranslated(el)) {
      return;
    }

    // 译文到达，移除加载圆环
    removeBlockSpinner(el);

    // 替换模式：就地替换原文（Edge 式），不创建 div、不改 DOM 结构
    if (settings.immersiveMode === false) {
      renderReplaceMode(el, translatedText);
      return;
    }

    // 同原文样式：继承父级
    var ps = getComputedStyle(el, null);

    // 判断排列方式：块宽不足 → 内联跟在原文后；否则 → 下方 block
    var inline = shouldInlineTranslate(el);

    var div = document.createElement("div");
    div.setAttribute("data-mt-role", "translation");
    div.setAttribute("data-suiyi-translated", "1");
    div.style.wordWrap = "break-word";
    div.style.overflowWrap = "break-word";
    div.style.whiteSpace = "pre-wrap";

    if (inline) {
      // 横向：译文作为行内元素跟在原文文本后面
      div.style.display = "inline";
      div.style.marginLeft = "0.5em";
      // 行内元素不可加 paddingLeft/bottom，只保留可继承的样式
      if (theme.background) {
        div.style.background = theme.background;
      }
      if (theme.borderLeft) {
        div.style.borderLeft = theme.borderLeft;
      }
      if (theme.borderBottom) {
        div.style.borderBottom = theme.borderBottom;
      }
    } else {
      // 下方：block 独占一行
      div.style.display = "block";
      if (theme.background) {
        div.style.background = theme.background;
      }
      if (theme.borderLeft) {
        div.style.borderLeft = theme.borderLeft;
        div.style.paddingLeft = "0.5em";
      }
      if (theme.borderBottom) {
        div.style.borderBottom = theme.borderBottom;
        div.style.paddingBottom = "0.25em";
      }
    }

    if (ps) {
      div.style.fontSize = ps.fontSize;
      div.style.fontFamily = ps.fontFamily;
      div.style.color = ps.color;
      div.style.lineHeight = ps.lineHeight;
      div.style.fontWeight = ps.fontWeight;
      div.style.fontStyle = ps.fontStyle;
    }

    div.textContent = translatedText;
    div.style.opacity = "0";
    div.style.transition = "opacity 0.3s ease";

    el.appendChild(div);
    requestAnimationFrame(function () {
      div.style.opacity = "1";
    });
  }

  // ---------- 替换模式（Edge 式：就地替换文本节点，DOM 结构零变化） ----------
  // 原文快照：blockId -> [{node, original}]，还原时改回 nodeValue。
  var replaceSnapshots = {};

  function renderReplaceMode(el, translatedText) {
    // 收集块内文本节点（排除已翻译的嵌套块）
    var textNodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n = walker.nextNode();
    while (n) {
      // 跳过随译 UI 内的文本
      if (!isInSuiyiUI(n.parentNode)) {
        textNodes.push(n);
      }
      n = walker.nextNode();
    }
    if (textNodes.length === 0) {
      return;
    }
    // 译文到达，移除加载圆环（在收集快照前，避免把 spinner 文本也算进去）
    removeBlockSpinner(el);
    // 存快照
    var blockId = el.__suiyi_id__;
    if (blockId) {
      replaceSnapshots[blockId] = textNodes.map(function (tn) {
        return { node: tn, original: tn.nodeValue };
      });
    }
    // 第一个文本节点放译文，其余清空（保留 inline 元素骨架，布局不受影响）
    textNodes[0].nodeValue = translatedText;
    for (var i = 1; i < textNodes.length; i += 1) {
      textNodes[i].nodeValue = "";
    }
    el.setAttribute("data-suiyi-replaced", "1");
  }

  function restoreReplaceMode() {
    var blocks = document.querySelectorAll('[data-suiyi-replaced="1"]');
    var list = Array.prototype.slice.call(blocks);
    list.forEach(function (el) {
      var snap = replaceSnapshots[el.__suiyi_id__];
      if (snap) {
        snap.forEach(function (item) {
          if (item.node && item.node.parentNode) {
            item.node.nodeValue = item.original;
          }
        });
      }
      el.removeAttribute("data-suiyi-replaced");
    });
  }

  // 判断原文块是否"框不足"：块宽 < 视口 45% 或 < 360px 视为窄块，译文横向排列
  function shouldInlineTranslate(el) {    if (!el) {
      return false;
    }
    var w = el.clientWidth;
    if (!w) {
      var rect = el.getBoundingClientRect();
      w = rect && rect.width;
    }
    if (!w) {
      return false;
    }
    var vw = window.innerWidth || document.documentElement.clientWidth;
    return w < vw * 0.45 || w < 360;
  }

  // ---------- 块级加载指示器（spinner） ----------
  // 待翻译的块显示一个小圆环，译文到达后移除。
  var spinnerClass = "suiyi-spinner";

  function showBlockSpinner(el) {
    if (!el || el.getAttribute("data-suiyi-spinner") === "1") {
      return;
    }
    // 替换模式：spinner 作为块内行内元素放在文本节点之后
    var spinner = document.createElement("span");
    spinner.className = spinnerClass;
    spinner.setAttribute("data-suiyi-spinner", "1");
    el.setAttribute("data-suiyi-spinner", "1");
    el.appendChild(spinner);
  }

  function removeBlockSpinner(el) {
    if (!el) {
      return;
    }
    if (el.getAttribute("data-suiyi-spinner") === "1") {
      var spinners = el.querySelectorAll('[data-suiyi-spinner="1"]');
      Array.prototype.slice.call(spinners).forEach(function (s) {
        if (s.parentNode) {
          s.parentNode.removeChild(s);
        }
      });
      el.removeAttribute("data-suiyi-spinner");
    }
  }

  // ---------- 译文缓存 ----------
  // 缓存键 = 块原文文本 hash。内容不变则复用译文，刷新页面后 session 缓存自动清空。
  var CACHE_PREFIX = "suiyi_trans_cache_";
  var hashCache = {};

  function simpleHash(str) {
    if (hashCache[str] !== undefined) {
      return hashCache[str];
    }
    var h = 0;
    for (var i = 0; i < str.length; i += 1) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    h = Math.abs(h);
    hashCache[str] = h;
    return h;
  }

  function cacheKeyFor(text) {
    return CACHE_PREFIX + simpleHash(text) + "_" + text.length;
  }

  // 读取全部缓存（session 级）
  function loadTranslateCache() {
    return bgSend("ds-cache-get").then(function (data) {
      return data && data.cache ? data.cache : {};
    });
  }

  // 写入若干条缓存
  function saveTranslateCache(entries) {
    return bgSend("ds-cache-set", entries);
  }

  // ---------- 翻译执行 ----------
  function translatePage() {
    if (translating) {
      return;
    }
    if (translated) {
      restorePage();
      return;
    }
    if (!settings.apiKey) {
      showToast("请先在设置中填写 DeepSeek API Key");
      openPanel();
      return;
    }
    var allUnits = sortUnitsByViewport(collectTexts(settings.translateMode || "page"));
    if (allUnits.length === 0) {
      showToast("没有可翻译的内容");
      return;
    }
    // 滚动懒译模式：只译视口内的块，屏外留给滚动懒翻译
    // 整页模式：一次翻译全部
    var units;
    if (settings.lazyMode !== false) {
      units = allUnits.filter(function (u) {
        return isStrictlyInViewport(u.el);
      });
      if (units.length === 0) {
        units = allUnits.slice(0, 20); // 兜底：视口判定失败时先译前 20 块
      }
    } else {
      units = allUnits;
    }

    translating = true;
    translated = true;
    setButtonBusy(true);

    var theme = getThemeStyles(settings.style);

    // 先查缓存：命中的块直接渲染，未命中的进 doTranslate
    loadTranslateCache().then(function (cache) {
      var freshUnits = [];
      var cacheHits = 0;
      units.forEach(function (unit) {
        var key = cacheKeyFor(unit.text);
        var cached = cache[key];
        if (typeof cached === "string" && cached.length > 0) {
          renderBlock(unit.el, cached, theme);
          cacheHits += 1;
        } else {
          freshUnits.push(unit);
        }
      });

      if (freshUnits.length === 0) {
        // 全部命中缓存，无需请求
        translating = false;
        setButtonBusy(false);
        startLazyTranslate();
        showToast(cacheHits > 0 ? "已恢复上次译文" : "翻译完成");
        return;
      }

      doTranslate(freshUnits, {
        showBusy: true,
        onDone: function (errors) {
          translating = false;
          setButtonBusy(false);
          startLazyTranslate();
          if (errors.length > 0) {
            showToast("部分翻译失败：" + errors[0]);
          } else {
            showToast(cacheHits > 0 ? "翻译完成（含缓存）" : "翻译完成");
          }
        }
      });
    }).catch(function () {
      // 缓存读取失败时降级：直接全量翻译
      doTranslate(units, {
        showBusy: true,
        onDone: function (errors) {
          translating = false;
          setButtonBusy(false);
          startLazyTranslate();
          if (errors.length > 0) {
            showToast("部分翻译失败：" + errors[0]);
          } else {
            showToast("翻译完成");
          }
        }
      });
    });
  }

  // ---------- 滚动懒翻译 ----------
  // 首次翻译优先视口内文字；滚动后，新进入视口的块自动翻译。
  var lazyTimer = null;
  var lazyObserver = null;
  var scrollListener = null;

  function startLazyTranslate() {
    if (!translated || translating) {
      return;
    }
    // 整页模式：屏外块已在首次请求里翻译完，无需滚动懒译
    if (settings.lazyMode === false) {
      return;
    }
    if (scrollListener) {
      return; // 已启动
    }
    scrollListener = function () {
      clearTimeout(lazyTimer);
      lazyTimer = setTimeout(lazyTranslateNow, 300);
    };
    window.addEventListener("scroll", scrollListener, { passive: true });
    document.addEventListener("scroll", scrollListener, { passive: true });
  }

  function lazyTranslateNow() {
    if (!translated || translating) {
      return;
    }
    var units = collectTexts(settings.translateMode || "page");
    var fresh = units.filter(function (unit) {
      // 新进入视口且未翻译的块（严格判定：必须真实在视口内）
      return isStrictlyInViewport(unit.el) && !isBlockTranslated(unit.el);
    });
    if (fresh.length === 0) {
      return;
    }
    translating = true;
    doTranslate(fresh, {
      onDone: function () {
        translating = false;
      }
    });
  }

  // 严格视口判定：块必须真实可见在视口内，高度为 0 的块视为不在视口
  function isStrictlyInViewport(el) {
    if (!el || !el.getBoundingClientRect) {
      return false;
    }
    var rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) {
      return false;
    }
    var w = window.innerWidth || document.documentElement.clientWidth;
    var h = window.innerHeight || document.documentElement.clientHeight;
    // 需要真实出现在视口内（含一点容差），而不是"可能可见"
    return rect.bottom > 0 && rect.top < h && rect.right > 0 && rect.left < w;
  }

  function stopLazyTranslate() {
    clearTimeout(lazyTimer);
    if (scrollListener) {
      window.removeEventListener("scroll", scrollListener);
      document.removeEventListener("scroll", scrollListener);
      scrollListener = null;
    }
    if (lazyObserver) {
      lazyObserver.disconnect();
      lazyObserver = null;
    }
  }

  // 核心翻译管线：对 units 分批并发调用后台，译文按块收集，完成后回调。
  function doTranslate(units, opts) {
    var showBusy = !!(opts && opts.showBusy);

    // 给每个待翻译的块显示加载圆环
    units.forEach(function (unit) {
      showBlockSpinner(unit.el);
    });

    // 把每个块文本切成 API 分片
    var MAX_CHUNK = 1500;
    var payloadUnits = [];
    var chunkSeq = 0;
    units.forEach(function (unit) {
      var chunks = splitText(unit.text, MAX_CHUNK);
      chunks.forEach(function (chunk) {
        payloadUnits.push({ blockId: unit.el.__suiyi_id__, chunkId: chunkSeq, text: chunk });
        chunkSeq += 1;
      });
    });
    if (payloadUnits.length === 0) {
      if (opts && opts.onDone) {
        opts.onDone([]);
      }
      return;
    }

    // 分批：每批 ≤20 片 或 ≤3500 字符（更大批次 = 更少请求往返）
    var batches = [];
    var current = [];
    var currentLen = 0;
    payloadUnits.forEach(function (pu) {
      current.push(pu);
      currentLen += pu.text.length;
      if (current.length >= 20 || currentLen >= 3500) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
    });
    if (current.length > 0) {
      batches.push(current);
    }

    var totalChunks = payloadUnits.length;
    var doneCount = 0;
    var errors = [];
    var theme = getThemeStyles(settings.style);
    var blockTranslated = {}; // blockId -> { chunkId: 译文 }

    // 渲染该块译文（块文本分片按 chunkId 顺序拼接后一次性插入）
    function renderBlockData(blockId) {
      var byBlock = blockTranslated[blockId];
      if (!byBlock) {
        return;
      }
      var keys = Object.keys(byBlock).sort(function (a, b) {
        return parseInt(a, 10) - parseInt(b, 10);
      });
      if (keys.length === 0) {
        return;
      }
      // 找到该块对应的 DOM 元素（用缓存避免重复查 DOM）
      var el = blockEls[blockId];
      if (!el) {
        return;
      }
      var translatedText = keys.map(function (cid) {
        return byBlock[cid];
      }).join("");
      renderBlock(el, translatedText, theme);
    }

    // blockId -> DOM 元素 映射（收集 units 时建立）
    var blockEls = {};
    units.forEach(function (unit) {
      blockEls[unit.el.__suiyi_id__] = unit.el;
    });

    var concurrency = 6;
    var index = 0;

    function worker() {
      if (index >= batches.length) {
        return Promise.resolve();
      }
      var batch = batches[index];
      index += 1;
      var unitsPayload = batch.map(function (pu) {
        return { id: pu.chunkId, text: pu.text };
      });
      return bgSend("ds-translate", {
        settings: settings,
        units: unitsPayload
      }).then(function (resp) {
        if (resp && resp.ok && resp.result && resp.result.map) {
          var map = resp.result.map;
          batch.forEach(function (pu) {
            var tr = map[pu.chunkId];
            if (typeof tr === "string") {
              if (!blockTranslated[pu.blockId]) {
                blockTranslated[pu.blockId] = {};
              }
              blockTranslated[pu.blockId][pu.chunkId] = tr;
            } else {
              errors.push("部分内容未返回译文");
            }
            doneCount += 1;
          });
        } else {
          if (resp && resp.error) {
            errors.push(resp.error);
          } else {
            errors.push("翻译失败");
          }
          doneCount += batch.length;
        }
        if (showBusy) {
          setButtonProgress(doneCount / totalChunks);
        }
        // 边到边渲染：本批完成的块立即插入译文（块内分片可能跨批，需等齐分片）
        // 先渲染本批独有完成的块；跨批块留到全部完成后兜底
        var renderedNow = {};
        batch.forEach(function (pu) {
          if (!renderedNow[pu.blockId]) {
            renderedNow[pu.blockId] = true;
            // 只有该块所有分片都已返回时才渲染
            if (isBlockComplete(pu.blockId)) {
              renderBlockData(pu.blockId);
            }
          }
        });
        // 取下一个批次继续，直到全部完成
        return worker();
      });
    }

    // 判断某块的所有分片是否都已返回
    function isBlockComplete(blockId) {
      var byBlock = blockTranslated[blockId];
      if (!byBlock) {
        return false;
      }
      // 统计该块应有的分片数
      var expected = 0;
      units.forEach(function (unit) {
        if (unit.el.__suiyi_id__ === blockId) {
          expected += Math.ceil(unit.text.length / MAX_CHUNK);
        }
      });
      return Object.keys(byBlock).length >= expected;
    }

    var workers = [];
    for (var i = 0; i < concurrency; i += 1) {
      workers.push(worker());
    }
    Promise.all(workers).then(function () {
      // 兜底渲染：处理跨批未齐的块
      units.forEach(function (unit) {
        renderBlockData(unit.el.__suiyi_id__);
      });

      // 写入缓存：块原文 hash → 译文
      var entries = {};
      units.forEach(function (unit) {
        var blockId = unit.el.__suiyi_id__;
        var byBlock = blockTranslated[blockId];
        if (!byBlock) {
          return;
        }
        var keys = Object.keys(byBlock).sort(function (a, b) {
          return parseInt(a, 10) - parseInt(b, 10);
        });
        if (keys.length === 0) {
          return;
        }
        var full = keys.map(function (cid) {
          return byBlock[cid];
        }).join("");
        if (full && full.trim().length > 0) {
          entries[cacheKeyFor(unit.text)] = full;
        }
      });
      if (Object.keys(entries).length > 0) {
        saveTranslateCache({ entries: entries });
      }

      if (opts && opts.onDone) {
        opts.onDone(errors);
      }
    }).catch(function (err) {
      if (opts && opts.onDone) {
        opts.onDone([String((err && err.message) || err)]);
      }
    });
  }

  function restorePage() {
    if (translating) {
      return;
    }
    // 还原替换模式：从快照改回文本节点原文（Edge 式，DOM 结构零变化）
    restoreReplaceMode();

    // 清理可能残留的加载圆环
    var spinners = document.querySelectorAll('[data-suiyi-spinner="1"]');
    Array.prototype.slice.call(spinners).forEach(function (s) {
      if (s.parentNode) {
        s.parentNode.removeChild(s);
      }
    });

    // 删除所有直接模式的译文节点
    var nodes = document.querySelectorAll('[data-mt-role="translation"]');
    var list = Array.prototype.slice.call(nodes);
    list.forEach(function (node) {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    translated = false;
    stopLazyTranslate();
    setButtonState();
  }

  // ---------- 悬浮窗 UI ----------
  var panelOpen = false;
  var button = null;
  var buttonIcon = null;
  var settingsBtn = null;
  var toasts = [];

  function buildUI() {
    // 防重入：根节点已存在则不再创建（页面可能因守卫被注入多次）
    if (document.getElementById("suiyi-fab-root")) {
      return;
    }
    var host = document.createElement("div");
    host.id = "suiyi-fab-root";
    host.style.cssText = "position: fixed; right: 6px; top: 50%; transform: translateY(-50%); z-index: 2147483647;";

    button = document.createElement("div");
    button.id = "suiyi-fab";
    button.setAttribute("title", "随译：翻译本页");
    button.setAttribute("role", "button");
    button.style.cssText = "width: 23px; height: 23px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px; user-select: none; box-shadow: 0 2px 10px rgba(0,0,0,0.2); transition: transform 0.15s ease, box-shadow 0.15s ease;";

    buttonIcon = document.createElement("span");
    buttonIcon.textContent = "译";
    button.appendChild(buttonIcon);
    host.appendChild(button);

    settingsBtn = document.createElement("div");
    settingsBtn.id = "suiyi-settings-btn";
    settingsBtn.setAttribute("role", "button");
    settingsBtn.textContent = "⚙";
    settingsBtn.style.cssText = "margin-top: 3px; width: 17px; height: 17px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 8px; opacity: 0; transform: translateY(-4px); transition: opacity 0.15s ease, transform 0.15s ease; pointer-events: none;";
    host.appendChild(settingsBtn);

    document.body.appendChild(host);

    // 主题：默认深色半透明
    applyButtonTheme("dark");
    restoreFabPosition();

    bindEvents();
  }

  function applyButtonTheme(mode) {
    if (!button) {
      return;
    }
    var bg, fg, shadow, border;
    if (mode === "dark") {
      bg = "rgba(30, 30, 30, 0.75)";
      fg = "#ffffff";
      shadow = "0 2px 10px rgba(0,0,0,0.3)";
      border = "1px solid rgba(255,255,255,0.18)";
    } else {
      bg = "rgba(255, 255, 255, 0.85)";
      fg = "#1a1a1a";
      shadow = "0 2px 10px rgba(0,0,0,0.15)";
      border = "1px solid rgba(0,0,0,0.12)";
    }
    button.style.background = bg;
    button.style.color = fg;
    button.style.boxShadow = shadow;
    button.style.border = border;
    settingsBtn.style.background = bg;
    settingsBtn.style.color = fg;
    settingsBtn.style.boxShadow = shadow;
    settingsBtn.style.border = border;
  }

  function restoreFabPosition() {
    loadSettings().then(function (data) {
      var host = document.getElementById("suiyi-fab-root");
      if (!host) {
        return;
      }
      if (data.fabTop) {
        host.style.top = data.fabTop + "px";
        host.style.transform = "none";
      } else {
        host.style.top = "50%";
        host.style.transform = "translateY(-50%)";
      }
    });
  }

  function bindEvents() {
    var pressTimer = null;
    var dragging = false;
    var startY = 0;
    var startTop = 0;

    button.addEventListener("mousedown", function (e) {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      pressTimer = setTimeout(function () {
        pressTimer = null;
        dragging = true;
        startY = e.clientY;
        var host = document.getElementById("suiyi-fab-root");
        startTop = host.offsetTop;
        button.classList.add("suiyi-dragging");
      }, 500);
    });

    window.addEventListener("mousemove", function (e) {
      if (!dragging) {
        return;
      }
      var host = document.getElementById("suiyi-fab-root");
      var delta = e.clientY - startY;
      var newTop = Math.max(0, Math.min(window.innerHeight - 23, startTop + delta));
      host.style.top = newTop + "px";
      host.style.transform = "none";
    });

    window.addEventListener("mouseup", function () {
      if (dragging) {
        dragging = false;
        var host = document.getElementById("suiyi-fab-root");
        button.classList.remove("suiyi-dragging");
        var top = host.offsetTop;
        saveFabTop(top);
      }
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    // 单击 = 翻译
    button.addEventListener("click", function () {
      if (dragging) {
        dragging = false;
        return;
      }
      translatePage();
    });

    // 悬停淡入设置按钮
    var host = document.getElementById("suiyi-fab-root");
    host.addEventListener("mouseenter", function () {
      settingsBtn.style.opacity = "1";
      settingsBtn.style.transform = "translateY(0)";
      settingsBtn.style.pointerEvents = "auto";
    });
    host.addEventListener("mouseleave", function () {
      if (!panelOpen) {
        settingsBtn.style.opacity = "0";
        settingsBtn.style.transform = "translateY(-4px)";
        settingsBtn.style.pointerEvents = "none";
      }
    });

    settingsBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openPanel();
    });
  }

  function setButtonBusy(busy) {
    if (!button) {
      return;
    }
    if (busy) {
      buttonIcon.textContent = "…";
    } else {
      buttonIcon.textContent = "译";
    }
  }

  function setButtonProgress(p) {
    // 进度环：简单用文字百分比
    if (!buttonIcon) {
      return;
    }
    buttonIcon.textContent = Math.round(p * 100) + "%";
  }

  function setButtonState() {
    if (!button) {
      return;
    }
    buttonIcon.textContent = "译";
    button.style.background = "rgba(30, 30, 30, 0.75)";
  }

  function showToast(msg) {
    var host = document.getElementById("suiyi-fab-root");
    if (!host) {
      return;
    }
    var toast = document.createElement("div");
    toast.textContent = msg;
    toast.style.cssText = "position: absolute; right: 60px; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.85); color: #fff; font-size: 12px; padding: 6px 10px; border-radius: 6px; white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity 0.2s ease; z-index: 10; pointer-events: none;";
    host.appendChild(toast);
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
    });
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 200);
    }, 2500);
    toasts.push(toast);
  }

  // ---------- 快捷键 ----------
  // 默认 Alt+A 翻译；面板可录制自定义组合键。监听全局 keydown 匹配。
  function hotkeyFromEvent(e) {
    var parts = [];
    if (e.ctrlKey) {
      parts.push("Ctrl");
    }
    if (e.altKey) {
      parts.push("Alt");
    }
    if (e.shiftKey) {
      parts.push("Shift");
    }
    if (e.metaKey) {
      parts.push("Meta");
    }
    var key = e.key;
    if (!key || key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") {
      return null; // 纯修饰键，忽略
    }
    // 归一化 key：处理浏览器编码形式（KeyK→K、Digit5→5）与特殊键
    if (key === " ") {
      key = "Space";
    } else if (key.length === 1) {
      key = key.toUpperCase();
    } else if (/^Key[A-Z]$/i.test(key)) {
      key = key.slice(3).toUpperCase();
    } else if (/^Digit\d$/.test(key)) {
      key = key.slice(5);
    } else {
      var aliases = {
        "arrowup": "ArrowUp",
        "arrowdown": "ArrowDown",
        "arrowleft": "ArrowLeft",
        "arrowright": "ArrowRight",
        "enter": "Enter",
        "tab": "Tab",
        "escape": "Esc",
        "backspace": "Backspace",
        "delete": "Delete",
        "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4",
        "f5": "F5", "f6": "F6", "f7": "F7", "f8": "F8",
        "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12"
      };
      key = aliases[key.toLowerCase()] || key;
    }
    parts.push(key);
    if (parts.length < 2) {
      return null; // 至少需要一个修饰键，避免单个字母就翻译
    }
    return parts.join("+");
  }

  function isHotkeyMatch(e, hotkey) {
    if (!hotkey) {
      return false;
    }
    var combo = hotkeyFromEvent(e);
    return combo === hotkey;
  }

  // 监听全局快捷键
  document.addEventListener("keydown", function (e) {
    // 面板输入框内不触发翻译快捷键
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) {
      // 但正在录制快捷键时例外（由输入框自身处理）
      return;
    }
    if (isHotkeyMatch(e, settings.hotkey)) {
      e.preventDefault();
      e.stopPropagation();
      translatePage();
    }
  }, true);

  // ---------- 设置面板 ----------
  function openPanel() {
    if (panelOpen) {
      return;
    }
    panelOpen = true;
    var overlay = document.createElement("div");
    overlay.id = "suiyi-panel-overlay";
    overlay.style.cssText = "position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 2147483646; display: flex; align-items: center; justify-content: center;";
    overlay.innerHTML =
      '<div id="suiyi-panel" style="background:#fff;color:#222;border-radius:12px;padding:24px 28px;width:360px;max-width:92vw;max-height:82vh;overflow:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:14px;box-shadow:0 12px 40px rgba(0,0,0,0.25);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
          '<h2 style="margin:0;font-size:18px;font-weight:600;">随译设置</h2>' +
          '<button id="suiyi-panel-close" style="border:none;background:transparent;font-size:20px;cursor:pointer;color:#888;">&times;</button>' +
        '</div>' +
        '<label style="display:block;margin-bottom:12px;">' +
          'DeepSeek API Key' +
          '<input id="suiyi-opt-apikey" type="password" placeholder="sk-..." style="width:100%;box-sizing:border-box;margin-top:4px;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;">' +
        '</label>' +
        '<div style="display:flex;gap:10px;margin-bottom:12px;">' +
          '<label style="flex:1;display:block;">源语言' +
            '<select id="suiyi-opt-source" style="width:100%;margin-top:4px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;">' +
              '<option value="auto">自动检测</option>' +
              '<option value="zh">中文</option>' +
              '<option value="en">英语</option>' +
              '<option value="ja">日语</option>' +
              '<option value="ko">韩语</option>' +
              '<option value="fr">法语</option>' +
              '<option value="de">德语</option>' +
              '<option value="es">西班牙语</option>' +
              '<option value="ru">俄语</option>' +
              '<option value="pt">葡萄牙语</option>' +
              '<option value="it">意大利语</option>' +
              '<option value="ar">阿拉伯语</option>' +
            '</select>' +
          '</label>' +
          '<label style="flex:1;display:block;">目标语言' +
            '<select id="suiyi-opt-target" style="width:100%;margin-top:4px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;">' +
              '<option value="zh-Hans">简体中文</option>' +
              '<option value="zh-Hant">繁体中文</option>' +
              '<option value="en">英语</option>' +
              '<option value="ja">日语</option>' +
              '<option value="ko">韩语</option>' +
              '<option value="fr">法语</option>' +
              '<option value="de">德语</option>' +
              '<option value="es">西班牙语</option>' +
              '<option value="ru">俄语</option>' +
              '<option value="pt">葡萄牙语</option>' +
              '<option value="it">意大利语</option>' +
              '<option value="ar">阿拉伯语</option>' +
            '</select>' +
          '</label>' +
        '</div>' +
        '<label style="display:block;margin-bottom:12px;">模型名' +
          '<input id="suiyi-opt-model" type="text" placeholder="deepseek-v4-flash" style="width:100%;box-sizing:border-box;margin-top:4px;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;">' +
        '</label>' +
        '<label style="display:block;margin-bottom:12px;">翻译快捷键' +
          '<input id="suiyi-opt-hotkey" type="text" readonly placeholder="点击后按下组合键，如 Alt+A" style="width:100%;box-sizing:border-box;margin-top:4px;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#f8f8f8;cursor:pointer;">' +
        '</label>' +
        '<label style="display:block;margin-bottom:12px;">翻译范围' +
          '<select id="suiyi-opt-mode" style="width:100%;margin-top:4px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;">' +
            '<option value="page">整页</option>' +
            '<option value="main">仅正文主体</option>' +
          '</select>' +
        '</label>' +
        '<label style="display:block;margin-bottom:12px;">译文样式' +
          '<select id="suiyi-opt-style" style="width:100%;margin-top:4px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;">' +
            '<option value="same">与原文相同样式</option>' +
            '<option value="underline">下划线</option>' +
            '<option value="highlight">高亮背景</option>' +
            '<option value="block">左侧条带</option>' +
          '</select>' +
        '</label>' +
        '<label class="suiyi-switch" style="margin-bottom:12px;">' +
          '<input id="suiyi-opt-always" type="checkbox">' +
          '<span class="suiyi-switch-track"><span class="suiyi-switch-thumb"></span></span>' +
          '<span class="suiyi-switch-text">总是翻译外语网页<span class="suiyi-sub">打开网页自动翻译</span></span>' +
        '</label>' +
        '<label style="display:block;margin-bottom:16px;">' +
          '当页面语言是' +
          '<input id="suiyi-opt-always-langs" type="text" placeholder="en, ja, ko, fr, de..." style="width:100%;box-sizing:border-box;margin-top:4px;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;">' +
        '</label>' +
        '<label class="suiyi-switch" style="margin-bottom:16px;">' +
          '<input id="suiyi-opt-skipnumbers" type="checkbox">' +
          '<span class="suiyi-switch-track"><span class="suiyi-switch-thumb"></span></span>' +
          '<span class="suiyi-switch-text">跳过纯数字块<span class="suiyi-sub">如 12345、1.2.3、2024</span></span>' +
        '</label>' +
        '<label class="suiyi-switch" style="margin-bottom:16px;">' +
          '<input id="suiyi-opt-lazymode" type="checkbox">' +
          '<span class="suiyi-switch-track"><span class="suiyi-switch-thumb"></span></span>' +
          '<span class="suiyi-switch-text">滚动到哪译到哪<span class="suiyi-sub">关闭则一次翻译整页</span></span>' +
        '</label>' +
        '<label class="suiyi-switch" style="margin-bottom:16px;">' +
          '<input id="suiyi-opt-immersive" type="checkbox">' +
          '<span class="suiyi-switch-track"><span class="suiyi-switch-thumb"></span></span>' +
          '<span class="suiyi-switch-text">沉浸式翻译<span class="suiyi-sub">译文在原文下方；关闭则译文替换原文</span></span>' +
        '</label>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="suiyi-opt-test" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">测试连接</button>' +
          '<button id="suiyi-opt-save" style="flex:1;padding:8px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">保存</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    settingsBtn.style.opacity = "1";

    // 填充当前设置
    var apikey = document.getElementById("suiyi-opt-apikey");
    var model = document.getElementById("suiyi-opt-model");
    var source = document.getElementById("suiyi-opt-source");
    var target = document.getElementById("suiyi-opt-target");
    var mode = document.getElementById("suiyi-opt-mode");
    var style = document.getElementById("suiyi-opt-style");
    var always = document.getElementById("suiyi-opt-always");
    var alwaysLangs = document.getElementById("suiyi-opt-always-langs");
    var skipNumbers = document.getElementById("suiyi-opt-skipnumbers");
    var lazyMode = document.getElementById("suiyi-opt-lazymode");
    var immersive = document.getElementById("suiyi-opt-immersive");
    var hotkeyInput = document.getElementById("suiyi-opt-hotkey");
    apikey.value = settings.apiKey || "";
    model.value = settings.model || DEFAULTS.model;
    source.value = settings.sourceLang || "auto";
    target.value = settings.targetLang || "zh-Hans";
    mode.value = settings.translateMode || "page";
    style.value = settings.style || "same";
    always.checked = !!settings.alwaysTranslate;
    skipNumbers.checked = settings.skipPureNumbers !== false;
    lazyMode.checked = settings.lazyMode !== false;
    immersive.checked = settings.immersiveMode !== false;
    alwaysLangs.value = (settings.alwaysLanguages || []).join(", ");
    hotkeyInput.value = settings.hotkey || DEFAULTS.hotkey;

    // 快捷键录制：点击输入框后，按下组合键即记录
    var recordingHotkey = false;
    hotkeyInput.addEventListener("click", function () {
      recordingHotkey = true;
      hotkeyInput.value = "请按下快捷键...";
      hotkeyInput.style.background = "#fff7d6";
    });
    hotkeyInput.addEventListener("keydown", function (e) {
      if (!recordingHotkey) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var combo = hotkeyFromEvent(e);
      if (combo) {
        recordingHotkey = false;
        hotkeyInput.value = combo;
        hotkeyInput.style.background = "#f8f8f8";
      }
    });
    hotkeyInput.addEventListener("blur", function () {
      recordingHotkey = false;
      hotkeyInput.value = settings.hotkey || DEFAULTS.hotkey;
      hotkeyInput.style.background = "#f8f8f8";
    });

    function close() {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      panelOpen = false;
      if (!isHovering()) {
        settingsBtn.style.opacity = "0";
        settingsBtn.style.transform = "translateY(-4px)";
        settingsBtn.style.pointerEvents = "none";
      }
    }

    function isHovering() {
      var host = document.getElementById("suiyi-fab-root");
      if (!host) {
        return false;
      }
      return host.matches(":hover");
    }

    document.getElementById("suiyi-panel-close").addEventListener("click", close);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) {
        close();
      }
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", esc);
      }
    });

    document.getElementById("suiyi-opt-save").addEventListener("click", function () {
      var newSettings = {
        apiKey: apikey.value.trim(),
        model: model.value.trim() || DEFAULTS.model,
        sourceLang: source.value,
        targetLang: target.value,
        translateMode: mode.value,
        style: style.value,
        alwaysTranslate: always.checked,
        alwaysLanguages: alwaysLangs.value.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        skipPureNumbers: skipNumbers.checked,
        lazyMode: lazyMode.checked,
        immersiveMode: immersive.checked,
        hotkey: hotkeyInput.value || DEFAULTS.hotkey,
        temperature: settings.temperature
      };
      saveSettings(newSettings).then(function () {
        settings = newSettings;
        close();
        showToast("设置已保存");
      }).catch(function (err) {
        showToast("保存失败：" + String((err && err.message) || err));
      });
    });

    document.getElementById("suiyi-opt-test").addEventListener("click", function () {
      var btn = document.getElementById("suiyi-opt-test");
      btn.textContent = "测试中…";
      btn.disabled = true;
      bgSend("ds-test-connection", {
        apiKey: apikey.value.trim(),
        model: model.value.trim() || DEFAULTS.model
      }).then(function (resp) {
        btn.textContent = resp && resp.ok ? "连接成功 ✓" : "失败：" + ((resp && resp.error) || "未知错误");
        btn.disabled = false;
      }).catch(function (err) {
        btn.textContent = "失败：" + String((err && err.message) || err);
        btn.disabled = false;
      });
    });
  }

  // ---------- 初始化 ----------
  function loadSettingsAndInit() {
    loadSettings().then(function (data) {
      settings = data || {};
      if (settings.apiKey) {
        bgReady = true;
      }
      buildUI();

      // 总是翻译：页面语言命中且非目标语言时自动翻译
      if (shouldAutoTranslate()) {
        // 等页面主体基本就绪
        setTimeout(function () {
          translatePage();
        }, 1200);
      }

      // SPA 页面内容变化时，若处于已翻译状态则重新翻译新内容（增量）
      var observer = new MutationObserver(debounce(function () {
        if (translated && !translating) {
          var missing = collectTexts(settings.translateMode || "page");
          var fresh = missing.filter(function (unit) {
            return !isBlockTranslated(unit.el);
          });
          if (fresh.length > 0) {
            translating = true;
            doTranslate(fresh, {
              onDone: function () {
                translating = false;
              }
            });
          }
        }
      }, 800));
      observer.observe(document.body, { childList: true, subtree: true });
    }).catch(function (err) {
      // 桥未就绪时静默，悬浮窗仍显示
      settings = DEFAULTS;
      buildUI();
    });
  }

  if (state.isTop && document.body) {
    loadSettingsAndInit();
  } else if (state.isTop) {
    document.addEventListener("DOMContentLoaded", loadSettingsAndInit, { once: true });
  }
})();
