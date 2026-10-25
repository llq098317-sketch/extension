// 随译 background.js
// Service worker：唯一接触 DeepSeek API 与 API Key 的地方。
// 页面脚本只发翻译请求消息，由这里统一调用 OpenAI 兼容接口，再返回译文 JSON。

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEEPSEEK_BASE = "https://api.deepseek.com";

// 单点限流与退避，避免 429
let inflight = 0;
let lastRetryAt = 0;

// storage.session 默认只允许后台/扩展页面访问，content script（guard）默认没有权限。
// 必须用 TRUSTED_AND_UNTRUSTED_CONTEXTS 才能让 content script 读写译文缓存。
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

const sleep = function (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
};

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: "ds-translate-page",
    title: "随译：翻译本页",
    contexts: ["page"]
  });
  // service worker 重启后顶层代码会重跑，onInstalled 里再确保一次
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId === "ds-translate-page") {
    chrome.tabs.sendMessage(info.tabId, { type: "ds-translate-toggle" });
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "ds-translate") {
    translateWithDeepSeek(message)
      .then(function (result) {
        sendResponse({ ok: true, result: result });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) });
      });
    return true; // 异步响应
  }
  if (message.type === "ds-test-connection") {
    testConnection(message)
      .then(function (result) {
        sendResponse({ ok: true, result: result });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) });
      });
    return true;
  }
});

// 归一化消息体：支持 guard 转发（payload 包在 message.payload 里）
// 和面板直连（settings/units 平铺在 message 上）两种形态。
function unwrap(message) {
  if (message && message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  return message || {};
}

async function translateWithDeepSeek(message) {
  const m = unwrap(message);
  const settings = m.settings || {};
  const apiKey = settings.apiKey;
  if (!apiKey) {
    throw new Error("未配置 API Key，请在设置面板中填写 DeepSeek API Key。");
  }
  const model = settings.model || DEFAULT_MODEL;
  const sourceLang = settings.sourceLang || "auto";
  const targetLang = settings.targetLang || "zh-Hans";
  const temperature = typeof settings.temperature === "number" ? settings.temperature : 0.2;

  const system =
    "网页翻译引擎。输入是 JSON：{id, text} 列表。逐条把 text 从" + sourceLabel(sourceLang) +
    "译成" + targetLabel(targetLang) + "，忠实通顺，保留 id 一一对应。只输出一个 JSON 对象 {\"translations\":[{\"id\":编号,\"text\":译文}]}，不要其它内容。";

  const body = {
    model: model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(m.units) }
    ],
    temperature: temperature,
    // DeepSeek V4 默认开启思考模式且 effort=high，翻译场景应关闭，显著提速
    thinking: { type: "disabled" },
    response_format: { type: "json_object" }
  };

  const data = await requestWithRetry(apiKey, body, model);
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) {
    throw new Error("DeepSeek 返回内容为空：" + JSON.stringify(data));
  }
  let parsed = content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      throw new Error("DeepSeek 返回的不是合法 JSON：" + String(content).slice(0, 200));
    }
  }
  const list = parsed && parsed.translations;
  if (!Array.isArray(list)) {
    throw new Error("DeepSeek 返回格式异常（缺少 translations 数组）：" + String(content).slice(0, 200));
  }
  const map = {};
  list.forEach(function (item) {
    if (item && typeof item.id === "number" && typeof item.text === "string") {
      map[item.id] = item.text;
    }
  });
  return { map: map };
}

async function testConnection(message) {
  const m = unwrap(message);
  const apiKey = m.apiKey;
  if (!apiKey) {
    throw new Error("请先填写 API Key。");
  }
  const model = m.model || DEFAULT_MODEL;
  const body = {
    model: model,
    messages: [
      { role: "system", content: "你只回复一个词：ok" },
      { role: "user", content: "hi" }
    ],
    temperature: 0,
    max_tokens: 4,
    thinking: { type: "disabled" }
  };
  await requestWithRetry(apiKey, body, model);
  return { ok: true };
}

async function requestWithRetry(apiKey, body, model) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return await requestOnce(apiKey, body);
    } catch (error) {
      const status = error.status || 0;
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempts >= 3) {
        throw error;
      }
      // 退避：首次 800ms，之后翻倍
      const backoff = Math.min(4000, 800 * Math.pow(2, attempts - 1));
      await sleep(backoff);
    }
  }
}

async function requestOnce(apiKey, body) {
  // 全局限流：并发不超过 8（承接前台 6 路并发）；429 后统一冷却。
  // 用带上限的等待循环代替 setInterval 轮询：旧实现若 inflight 长期不降回 8 以下，
  // 80ms 轮询定时器永不停止，会阻止 service worker 休眠并持续消耗资源。
  let waited = 0;
  while (inflight >= 8) {
    await sleep(80);
    waited += 80;
    if (waited > 60000) {
      throw new Error("翻译队列等待超时，请稍后重试");
    }
  }
  inflight += 1;
  const now = Date.now();
  if (lastRetryAt > now) {
    await sleep(lastRetryAt - now);
  }
  try {
    const res = await fetch(DEEPSEEK_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = "";
      try {
        const errBody = await res.json();
        detail = (errBody && errBody.error && (errBody.error.message || errBody.error.code)) || JSON.stringify(errBody);
      } catch (e) {
        detail = res.statusText || "";
      }
      if (res.status === 429) {
        lastRetryAt = Date.now() + 2000;
      }
      const error = new Error("DeepSeek 请求失败 (" + res.status + "): " + detail);
      error.status = res.status;
      throw error;
    }
    return await res.json();
  } finally {
    inflight -= 1;
  }
}

function sourceLabel(code) {
  const labels = {
    auto: "自动检测",
    zh: "中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    ru: "俄语",
    pt: "葡萄牙语",
    it: "意大利语",
    ar: "阿拉伯语"
  };
  return labels[code] || code;
}

function targetLabel(code) {
  const labels = {
    "zh-Hans": "简体中文",
    "zh-Hant": "繁体中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    ru: "俄语",
    pt: "葡萄牙语",
    it: "意大利语",
    ar: "阿拉伯语"
  };
  return labels[code] || code;
}
