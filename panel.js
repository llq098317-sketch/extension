// 随译 panel.js —— 工具栏设置面板逻辑。
// 独立成文件：MV3 CSP 禁止内联脚本（script-src 'self'），内联 JS 会被拦截导致白屏。
(function () {
  "use strict";

  function init() {
    var LANGS = [
      ["auto", "自动检测"],
      ["zh", "中文"],
      ["en", "英语"],
      ["ja", "日语"],
      ["ko", "韩语"],
      ["fr", "法语"],
      ["de", "德语"],
      ["es", "西班牙语"],
      ["ru", "俄语"],
      ["pt", "葡萄牙语"],
      ["it", "意大利语"],
      ["ar", "阿拉伯语"]
    ];
    var TARGETS = [
      ["zh-Hans", "简体中文"],
      ["zh-Hant", "繁体中文"],
      ["en", "英语"],
      ["ja", "日语"],
      ["ko", "韩语"],
      ["fr", "法语"],
      ["de", "德语"],
      ["es", "西班牙语"],
      ["ru", "俄语"],
      ["pt", "葡萄牙语"],
      ["it", "意大利语"],
      ["ar", "阿拉伯语"]
    ];
    var DEFAULTS = {
      apiKey: "",
      model: "deepseek-v4-flash",
      sourceLang: "auto",
      targetLang: "zh-Hans",
      translateMode: "page",
      style: "same",
      alwaysTranslate: false,
      alwaysLanguages: ["en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
      skipPureNumbers: true,
      lazyMode: true,
      immersiveMode: true,
      hotkey: "Alt+A"
    };

    function fillSelect(sel, opts) {
      sel.innerHTML = "";
      opts.forEach(function (o) {
        var option = document.createElement("option");
        option.value = o[0];
        option.textContent = o[1];
        sel.appendChild(option);
      });
    }

    fillSelect(document.getElementById("opt-source"), LANGS);
    fillSelect(document.getElementById("opt-target"), TARGETS);

    var apiKey = document.getElementById("opt-apikey");
    var model = document.getElementById("opt-model");
    var source = document.getElementById("opt-source");
    var target = document.getElementById("opt-target");
    var mode = document.getElementById("opt-mode");
    var style = document.getElementById("opt-style");
    var always = document.getElementById("opt-always");
    var alwaysLangs = document.getElementById("opt-always-langs");
    var skipNumbers = document.getElementById("opt-skipnumbers");
    var lazyMode = document.getElementById("opt-lazymode");
    var immersive = document.getElementById("opt-immersive");
    var hotkeyInput = document.getElementById("opt-hotkey");
    var loadedHotkey = DEFAULTS.hotkey;
    var statusEl = document.getElementById("status");

    function load() {
      chrome.storage.sync.get(DEFAULTS, function (data) {
        apiKey.value = data.apiKey || "";
        model.value = data.model || DEFAULTS.model;
        source.value = data.sourceLang || "auto";
        target.value = data.targetLang || "zh-Hans";
        mode.value = data.translateMode || "page";
        style.value = data.style || "same";
        always.checked = !!data.alwaysTranslate;
        alwaysLangs.value = (data.alwaysLanguages || []).join(", ");
        skipNumbers.checked = data.skipPureNumbers !== false;
        lazyMode.checked = data.lazyMode !== false;
        immersive.checked = data.immersiveMode !== false;
        loadedHotkey = data.hotkey || DEFAULTS.hotkey;
        hotkeyInput.value = loadedHotkey;
      });
    }

    function collect() {
      return {
        apiKey: apiKey.value.trim(),
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
        hotkey: hotkeyInput.value || DEFAULTS.hotkey
      };
    }

    // 快捷键录制
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
      var parts = [];
      if (e.ctrlKey) { parts.push("Ctrl"); }
      if (e.altKey) { parts.push("Alt"); }
      if (e.shiftKey) { parts.push("Shift"); }
      if (e.metaKey) { parts.push("Meta"); }
      var key = e.key;
      if (!key || key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") {
        return;
      }
      if (key === " ") {
        key = "Space";
      } else if (key.length === 1) {
        key = key.toUpperCase();
      } else if (/^Key[A-Z]$/i.test(key)) {
        key = key.slice(3).toUpperCase();
      } else if (/^Digit\d$/.test(key)) {
        key = key.slice(5);
      }
      parts.push(key);
      if (parts.length >= 2) {
        recordingHotkey = false;
        hotkeyInput.value = parts.join("+");
        hotkeyInput.style.background = "#fff";
      }
    });
    hotkeyInput.addEventListener("blur", function () {
      if (recordingHotkey) {
        recordingHotkey = false;
        hotkeyInput.value = loadedHotkey || DEFAULTS.hotkey;
        hotkeyInput.style.background = "#fff";
      }
    });

    document.getElementById("btn-save").addEventListener("click", function () {
      var settings = collect();
      chrome.storage.sync.set(settings, function () {
        statusEl.textContent = "✓ 已保存";
        statusEl.className = "status ok";
      });
    });

    document.getElementById("btn-test").addEventListener("click", function () {
      var btn = document.getElementById("btn-test");
      btn.disabled = true;
      btn.textContent = "测试中…";
      statusEl.textContent = "";
      statusEl.className = "status";
      chrome.runtime.sendMessage({
        type: "ds-test-connection",
        apiKey: apiKey.value.trim(),
        model: model.value.trim() || DEFAULTS.model
      }, function (resp) {
        btn.disabled = false;
        btn.textContent = "测试连接";
        if (resp && resp.ok) {
          statusEl.textContent = "✓ 连接成功";
          statusEl.className = "status ok";
        } else {
          statusEl.textContent = "✗ " + ((resp && resp.error) || "未知错误");
          statusEl.className = "status err";
        }
      });
    });

    // 清除译文缓存
    document.getElementById("btn-clearcache").addEventListener("click", function () {
      var btn = document.getElementById("btn-clearcache");
      btn.disabled = true;
      btn.textContent = "清除中...";
      chrome.storage.session.remove("suiyi_trans_cache", function () {
        btn.disabled = false;
        btn.textContent = "✓ 已清除";
        statusEl.textContent = "译文缓存已清空，重新翻译即可";
        statusEl.className = "status ok";
        setTimeout(function () {
          btn.textContent = "清除译文缓存（升级后翻译异常时使用）";
          statusEl.textContent = "";
          statusEl.className = "status";
        }, 2000);
      });
    });

    load();
  }

  // 等 DOM 就绪后再初始化（脚本在 head 引用时 body 尚未解析完）
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
