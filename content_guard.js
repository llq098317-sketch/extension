// 随译 content_guard.js
// document_start 注入（扩展隔离世界）。双重职责：
// 1) 把主脚本 content_main.js（页面主世界）和样式注入页面；
// 2) 充当页面主世界 <-> 扩展后台 的通信桥。
//    页面主世界没有 chrome.runtime，通过 window.postMessage 与这里交互。

(function () {
  if (window.__suiyi_guard_loaded__) {
    return;
  }
  window.__suiyi_guard_loaded__ = true;

  var isTop = window.self === window.top;
  if (!isTop) {
    return; // 只作用于顶层页面，避免 iframe 重复注入
  }

  // ---------- 通信桥：页面主世界 <-> 后台 ----------
  // 页面脚本调用 window.postMessage({suiYiBridge:true, type, payload}, "*")
  // 这里（隔离世界）收到后转发给 background，再把响应回传。

  var pending = {};
  var reqSeq = 0;

  // 防御：扩展被刷新/禁用后，旧 content script 实例的 chrome API 会失效。
  // storage.session 和 runtime 可能不可用，统一守卫避免抛错。
  function sessionStorageAvailable() {
    return !!(chrome && chrome.storage && chrome.storage.session && chrome.storage.session.get && chrome.runtime && chrome.runtime.getManifest);
  }

  // 把响应回传给页面主世界（带 reqId 便于页面侧匹配）
  function respondToPage(event, type, payload, reqId) {
    event.source.postMessage({
      suiYiBridge: true,
      type: type,
      payload: payload,
      reqId: reqId
    }, event.origin);
  }

  function forwardToBackground(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = (++reqSeq);
      pending[id] = { resolve: resolve, reject: reject };
      // 给后台 60s 超时保护，防止后台被回收导致 Promise 悬挂。
      // 长文翻译单次响应可能 30-40s，15s 会误掐。
      var timer = setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("后台响应超时"));
        }
      }, 60000);
      pending[id].timer = timer;

      // 防御：chrome API 可能已失效（扩展被刷新/禁用后旧实例）
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        clearTimeout(timer);
        delete pending[id];
        reject(new Error("扩展已失效，请刷新页面"));
        return;
      }
      chrome.runtime.sendMessage({ type: type, payload: payload, reqId: id }, function (response) {
        if (chrome.runtime.lastError) {
          var p = pending[id];
          if (p) {
            clearTimeout(p.timer);
            delete pending[id];
            p.reject(new Error(chrome.runtime.lastError.message || "后台错误"));
          }
          return;
        }
        var q = pending[id];
        if (q) {
          clearTimeout(q.timer);
          delete pending[id];
          q.resolve(response);
        }
      });
    });
  }

  window.addEventListener("message", function (event) {
    if (!event.data || event.data.suiYiBridge !== true) {
      return;
    }
    var type = event.data.type;
    var payload = event.data.payload;
    var reqId = event.data.reqId;

    // 本监听器挂在同一个 window 上，因此也会收到自己 respondToPage 发出的回包。
    // 回包 type 以 -resp 结尾，若不在这里排除，会被下面的兜底逻辑当成新请求转发后台；
    // 后台不认识该 type、不会回包 → reject → 再回包 type+"-resp" → 无限自激回环
    //（type 字符串每绕一圈加长 5 字节，最终把页面拖到 Out of Memory）。
    if (!type || type.indexOf("-resp") !== -1) {
      return;
    }

    if (type === "ds-get-settings") {
      if (!chrome || !chrome.storage || !chrome.storage.sync) {
        respondToPage(event, "ds-get-settings-resp", {}, reqId); // 降级：返回空设置
        return;
      }
      chrome.storage.sync.get(null, function (all) {
        respondToPage(event, "ds-get-settings-resp", all || {}, reqId);
      });
      return;
    }
    if (type === "ds-set-settings") {
      if (!chrome || !chrome.storage || !chrome.storage.sync) {
        respondToPage(event, "ds-set-settings-resp", { ok: false }, reqId);
        return;
      }
      chrome.storage.sync.set(payload || {}, function () {
        respondToPage(event, "ds-set-settings-resp", { ok: true }, reqId);
      });
      return;
    }
    if (type === "ds-fab-position") {
      if (chrome && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ fabTop: payload && payload.top });
      }
      return; // 无需回包
    }
    if (type === "ds-cache-get") {
      // 读译文缓存（session 级，刷新页面自动清空）
      // 缓存带扩展版本号：升级后版本不匹配 → 返回空缓存，避免复用旧 bug 的错误译文
      if (!sessionStorageAvailable()) {
        respondToPage(event, "ds-cache-get-resp", { cache: {} }, reqId); // 降级：无缓存
        return;
      }
      chrome.storage.session.get("suiyi_trans_cache", function (data) {
        var stored = (data && data.suiyi_trans_cache) || null;
        var currentVersion = chrome.runtime.getManifest().version;
        if (stored && stored._version === currentVersion && stored.cache) {
          respondToPage(event, "ds-cache-get-resp", { cache: stored.cache }, reqId);
        } else {
          respondToPage(event, "ds-cache-get-resp", { cache: {} }, reqId);
        }
      });
      return;
    }
    if (type === "ds-cache-set") {
      // 追加译文缓存条目
      if (!sessionStorageAvailable()) {
        respondToPage(event, "ds-cache-set-resp", { ok: true }, reqId); // 降级：跳过缓存
        return;
      }
      chrome.storage.session.get("suiyi_trans_cache", function (data) {
        var stored = (data && data.suiyi_trans_cache) || null;
        var currentVersion = chrome.runtime.getManifest().version;
        // 版本不匹配时从空缓存开始
        var cache = {};
        if (stored && stored._version === currentVersion && stored.cache) {
          cache = stored.cache;
        }
        var entries = (payload && payload.entries) || {};
        var key;
        for (key in entries) {
          // 单条译文过长（>8000 字符）不缓存，避免少数巨型条目撑爆 storage.session
          var val = entries[key];
          if (typeof val === "string" && val.length <= 8000) {
            cache[key] = val;
          }
        }
        // 限制缓存规模，防无限膨胀（上限 1500 条：原文+译文序列化后仍可控）
        var keys = Object.keys(cache);
        if (keys.length > 1500) {
          var trimmed = {};
          keys.slice(keys.length - 1500).forEach(function (k) {
            trimmed[k] = cache[k];
          });
          cache = trimmed;
        }
        chrome.storage.session.set({ suiyi_trans_cache: { _version: currentVersion, cache: cache } }, function () {
          respondToPage(event, "ds-cache-set-resp", { ok: true }, reqId);
        });
      });
      return;
    }
    if (type === "ds-cache-clear") {
      // 手动清空译文缓存（面板"清除缓存"按钮）
      if (!sessionStorageAvailable()) {
        respondToPage(event, "ds-cache-clear-resp", { ok: true }, reqId); // 降级：无需清理
        return;
      }
      chrome.storage.session.remove("suiyi_trans_cache", function () {
        respondToPage(event, "ds-cache-clear-resp", { ok: true }, reqId);
      });
      return;
    }
    // 翻译 / 测试连接：转发后台。
    // 只放行这两个已知请求类型，未知 type 一律丢弃（不回包、不转发），
    // 从物理上断开"回包被当成新请求"的回环可能。
    if (type !== "ds-translate" && type !== "ds-test-connection") {
      return;
    }
    forwardToBackground(type, payload).then(function (response) {
      respondToPage(event, type + "-resp", response, reqId);
    }).catch(function (error) {
      respondToPage(event, type + "-resp", {
        ok: false,
        error: String((error && error.message) || error)
      }, reqId);
    });
  }, true);

  // ---------- 注入主脚本与样式 ----------
  function boot() {
    if (window.__suiyi_main_loaded__) {
      return;
    }
    // 防御：扩展可能已被刷新/禁用，旧 content script 实例的 chrome API 会失效。
    // 此时静默退出，避免向页面抛 "Cannot read properties of undefined"。
    if (!chrome || !chrome.runtime || !chrome.runtime.getURL) {
      return;
    }
    // document_start 时 <head> 可能尚未创建。直接挂到 <html> 下会导致 <script> 不执行，
    // 因此 head 不存在时不标记 loaded，交给 DOMContentLoaded / load 回调重试。
    var head = document.head;
    if (!head) {
      return;
    }
    window.__suiyi_main_loaded__ = true;

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = chrome.runtime.getURL("styles/inject.css");
    head.appendChild(css);

    var script = document.createElement("script");
    script.type = "text/javascript";
    script.src = chrome.runtime.getURL("content_main.js");
    script.async = false;
    script.onerror = function () {
      // 主脚本加载失败时不阻塞页面
    };
    head.appendChild(script);
  }

  if (document.readyState === "interactive" || document.readyState === "complete") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  }

  window.addEventListener("load", function () {
    if (!window.__suiyi_main_loaded__) {
      boot();
    }
  }, { once: true });
})();
