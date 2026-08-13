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

    if (type === "ds-get-settings") {
      chrome.storage.sync.get(null, function (all) {
        respondToPage(event, "ds-get-settings-resp", all || {}, reqId);
      });
      return;
    }
    if (type === "ds-set-settings") {
      chrome.storage.sync.set(payload || {}, function () {
        respondToPage(event, "ds-set-settings-resp", { ok: true }, reqId);
      });
      return;
    }
    if (type === "ds-fab-position") {
      chrome.storage.sync.set({ fabTop: payload && payload.top });
      return; // 无需回包
    }
    if (type === "ds-cache-get") {
      // 读译文缓存（session 级，刷新页面自动清空）
      chrome.storage.session.get("suiyi_trans_cache", function (data) {
        respondToPage(event, "ds-cache-get-resp", { cache: (data && data.suiyi_trans_cache) || {} }, reqId);
      });
      return;
    }
    if (type === "ds-cache-set") {
      // 追加译文缓存条目
      chrome.storage.session.get("suiyi_trans_cache", function (data) {
        var cache = (data && data.suiyi_trans_cache) || {};
        var entries = (payload && payload.entries) || {};
        var key;
        for (key in entries) {
          cache[key] = entries[key];
        }
        // 限制缓存规模，防无限膨胀
        var keys = Object.keys(cache);
        if (keys.length > 5000) {
          var trimmed = {};
          keys.slice(keys.length - 5000).forEach(function (k) {
            trimmed[k] = cache[k];
          });
          cache = trimmed;
        }
        chrome.storage.session.set({ suiyi_trans_cache: cache }, function () {
          respondToPage(event, "ds-cache-set-resp", { ok: true }, reqId);
        });
      });
      return;
    }
    // 翻译 / 测试连接：转发后台
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
    window.__suiyi_main_loaded__ = true;

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = chrome.runtime.getURL("styles/inject.css");
    document.head.appendChild(css);

    var script = document.createElement("script");
    script.type = "text/javascript";
    script.src = chrome.runtime.getURL("content_main.js");
    script.async = false;
    script.onerror = function () {
      // 主脚本加载失败时不阻塞页面
    };
    document.head.appendChild(script);
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
