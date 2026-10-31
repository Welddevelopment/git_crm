/* Git CRM extension: background service worker (MV3).
 * - opens the side panel on toolbar click
 * - tracks the active tab URL and pushes the detected CRM record to the panel
 * - proxies API fetches to the Git CRM server (host_permissions avoid CORS)
 */
importScripts("crms.js");

var DEFAULTS = { serverUrl: "https://gitcrm-production.up.railway.app", reviewer: "Joel", demo: false };

chrome.runtime.onInstalled.addListener(function () {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
  }
});
// Service workers can be restarted; set the behavior on every start too.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
}

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(DEFAULTS, function (s) { resolve(Object.assign({}, DEFAULTS, s || {})); });
  });
}

function trimBase(u) {
  return String(u || DEFAULTS.serverUrl).trim().replace(/\/+$/, "");
}

async function contextFor(tab) {
  var settings = await getSettings();
  var url = (tab && (tab.pendingUrl || tab.url)) || "";
  var d = self.MainlineCRMs.detect(url, settings);
  return { tabId: tab ? tab.id : null, windowId: tab ? tab.windowId : null, url: url, crm: d.crm, record: d.record };
}

async function activeTab() {
  var tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

var lastSent = {};
async function push(tab) {
  if (!tab) return;
  var ctx = await contextFor(tab);
  var key = JSON.stringify([ctx.windowId, ctx.url]);
  if (lastSent[ctx.windowId] === key) return;
  lastSent[ctx.windowId] = key;
  chrome.runtime.sendMessage({ type: "mainline:context", context: ctx }).catch(function () { /* panel not open */ });
}

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId, function (tab) { if (!chrome.runtime.lastError) push(tab); });
});
chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
  if (!tab.active) return;
  if (change.url || change.status === "complete") push(tab);
});
chrome.windows && chrome.windows.onFocusChanged && chrome.windows.onFocusChanged.addListener(function () {
  activeTab().then(push).catch(function () {});
});

async function apiFetch(msg) {
  var settings = await getSettings();
  var base = trimBase(msg.base || settings.serverUrl);
  var url = base + msg.path;
  var init = { method: msg.method || "GET", cache: "no-store", headers: { accept: "application/json" } };
  if (msg.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(msg.body);
  }
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, msg.timeoutMs || 12000);
  init.signal = ctrl.signal;
  try {
    var r = await fetch(url, init);
    var text = await r.text();
    var data = null;
    var isJson = false;
    try { data = JSON.parse(text); isJson = true; } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, json: isJson, data: data, text: isJson ? undefined : text.slice(0, 300), url: url };
  } catch (e) {
    return { ok: false, status: 0, network: true, error: e && e.name === "AbortError" ? "timed out" : String((e && e.message) || e), url: url };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === "mainline:fetch") {
    apiFetch(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "mainline:getContext") {
    (async function () {
      var tab = msg.windowId != null
        ? (await chrome.tabs.query({ active: true, windowId: msg.windowId }))[0]
        : await activeTab();
      sendResponse(await contextFor(tab));
    })().catch(function (e) { sendResponse({ url: "", crm: null, record: null, error: String(e) }); });
    return true;
  }
  if (msg.type === "mainline:openTab") {
    chrome.tabs.create({ url: msg.url });
    return false;
  }
  return false;
});
