/* Git CRM extension: side panel.
 * Shows pending agent PRs for the CRM record in the active tab (via GET /api/records/lookup),
 * or the global open-PR queue when the tab isn't a recognized record. All network calls go
 * through the background worker (mainline:fetch) so host_permissions apply.
 */
(function () {
  "use strict";

  var DEFAULTS = { serverUrl: "https://gitcrm-production.up.railway.app", reviewer: "Joel", demo: false };
  var POLL_MS = 4000;
  var FORCE_DEMO = /[?&]demo\b/.test(location.search);
  var CRMs = self.MainlineCRMs;

  var S = {
    settings: Object.assign({}, DEFAULTS),
    windowId: null,
    ctx: null, // { url, crm, record }
    view: null, // computed view model
    conn: "connecting", // ok | err | demo | connecting
    lastError: null,
    lookupMissing: false, // lookup route not deployed → client-side fallback
    expanded: {}, // prId -> true
    details: {}, // prId -> { key, data, error }
    busy: {}, // prId -> "merge" | "close"
    confirmReject: {}, // prId -> true
    results: {}, // prId -> { ok, msg }
    seen: null, // Set of PR ids seen in the previous load
    fresh: {},
    sig: "",
    loading: false,
    loadSeq: 0,
    tab: "record", // record | prs | graph | timeline | crm | settings | demo
  };

  // Tabs: "record"/"prs" are rendered natively; the rest iframe the web app in embed mode.
  var FRAME_TABS = { graph: "/", timeline: "/timeline", crm: "/crm", settings: "/settings", demo: "/demo" };
  var FRAME_TITLES = { graph: "Branch graph", timeline: "Time travel", crm: "Records", settings: "Agents & rules", demo: "Demo console" };
  var frames = {}; // tab -> { el, src } (created on first open, hidden — not destroyed — when switching)

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- utils
  function h(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var MONEY = /(^|\.)(amount|arr|mrr|acv|value|price|revenue|budget)$/i;
  var usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function isMoney(f) { return !!f && MONEY.test(f); }
  function fmtVal(v, field) {
    if (v === undefined) return "∅";
    if (v === null) return "empty";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "[]";
    if (typeof v === "number") return isMoney(field) ? usd.format(v) : v.toLocaleString("en-US");
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v === "") return '""';
    return String(v);
  }
  function fmtAge(ts) {
    if (!ts) return "";
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var hr = Math.round(m / 60);
    if (hr < 24) return hr + "h ago";
    var d = Math.round(hr / 24);
    if (d < 30) return d + "d ago";
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function base() { return String(S.settings.serverUrl || DEFAULTS.serverUrl).trim().replace(/\/+$/, ""); }
  function prUrl(id) { return base() + "/prs/" + encodeURIComponent(id); }
  function entityUrl(id) { return base() + "/crm?entity=" + encodeURIComponent(id); }
  function slugName(id) {
    if (!id) return "—";
    var s = String(id).slice(String(id).indexOf(":") + 1);
    return s.replace(/[-_]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function entType(id) { var i = String(id || "").indexOf(":"); return i > 0 ? String(id).slice(0, i) : "entity"; }
  function actorName(a) {
    if (!a) return "unknown";
    if (a.kind !== "system" && a.name) return a.name;
    if (a.kind === "agent") return a.id + " agent";
    if (a.kind === "system") return a.id === "merge" ? "auto-merge" : "system:" + a.id;
    return a.id;
  }
  function actorChip(a) {
    var k = (a && a.kind) || "system";
    return '<span class="chip ' + h(k) + '" title="' + h(k) + '"><span class="dot"></span>' + h(actorName(a)) + "</span>";
  }
  function crmChip(crm) {
    if (!crm) return "";
    return '<span class="chip crm" style="--c:' + h(crm.color || "var(--accent)") + '"><span class="dot"></span>' + h(crm.name) + "</span>";
  }
  function errText(r) {
    if (!r) return "unknown error";
    if (r.network) return r.error || "network error";
    if (r.data && r.data.error) return r.data.error;
    return "HTTP " + r.status + (r.text ? ": " + r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "");
  }
  var ICON_PR = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>';
  var ICON_CHEV = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

  // ---------------------------------------------------------------- chrome bridge
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) resolve({ ok: false, status: 0, network: true, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, status: 0, network: true, error: "no response from background" });
        });
      } catch (e) {
        resolve({ ok: false, status: 0, network: true, error: String((e && e.message) || e) });
      }
    });
  }
  function api(path, opts) {
    opts = opts || {};
    return send({ type: "mainline:fetch", path: path, method: opts.method, body: opts.body, base: opts.base });
  }
  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(DEFAULTS, function (s) {
          S.settings = Object.assign({}, DEFAULTS, s || {});
          resolve(S.settings);
        });
      } catch (e) { resolve(S.settings); }
    });
  }

  // ---------------------------------------------------------------- data
  /** Does this PR touch the entity (or anything aliased to it)? */
  function touches(pr, ids) {
    var ch = pr.changes || [];
    for (var i = 0; i < ch.length; i++) {
      var c = ch[i];
      if (ids[c.entity] || ids[c.from] || ids[c.into]) return true;
    }
    var cf = pr.conflicts || [];
    for (var j = 0; j < cf.length; j++) if (ids[cf[j].entity]) return true;
    return false;
  }

  var EXT_ID_ATTR = { hubspot: ["hubspotId", "hs_object_id"], attio: ["attioId", "attioRecordId"], salesforce: ["salesforceId", "sfId"], pipedrive: ["pipedriveId"] };
  var KIND_TO_TYPE = { deal: "deal", contact: "contact", company: "company" };

  /** Client-side RecordLookup built from /api/prs + /api/state (used until /api/records/lookup is live, or with ?demo). */
  async function fallbackLookup(record) {
    var rs = await Promise.all([api("/api/state"), api("/api/prs?status=open")]);
    if (!rs[0].ok) return { error: rs[0] };
    if (!rs[1].ok) return { error: rs[1] };
    var state = rs[0].data.state;
    var open = rs[1].data.prs || [];
    var entities = state.entities || {};
    var aliases = state.aliases || {};
    var entityId = null;
    var mapped = false;

    if (record.crm === "mainline") {
      entityId = aliases[record.id] || record.id;
      if (!entities[entityId]) entityId = null;
    } else {
      var attrs = EXT_ID_ATTR[record.crm] || [];
      Object.keys(entities).some(function (id) {
        var a = entities[id].attrs || {};
        for (var i = 0; i < attrs.length; i++) if (a[attrs[i]] != null && String(a[attrs[i]]) === String(record.id)) { entityId = id; return true; }
        return false;
      });
      if (!entityId && (S.settings.demo || FORCE_DEMO)) {
        entityId = demoPick(record.kind, entities, open);
        mapped = !!entityId;
      }
    }
    return { data: buildLookup(record.crm, entityId, state, open, mapped), state: state };
  }

  /** Demo mapping: the live entity of the same type with the most open PRs. */
  function demoPick(kind, entities, open) {
    var t = KIND_TO_TYPE[kind] || "deal";
    var score = {};
    open.forEach(function (pr) {
      (pr.changes || []).forEach(function (c) {
        var id = c.entity || c.into;
        if (id && entType(id) === t) score[id] = (score[id] || 0) + (pr.staleness && pr.staleness.status === "stale" ? 3 : 1);
      });
    });
    var best = Object.keys(score).filter(function (id) { return entities[id] && !entities[id].deleted; }).sort(function (a, b) { return score[b] - score[a]; })[0];
    if (best) return best;
    return Object.keys(entities).filter(function (id) { return entities[id].type === t && !entities[id].deleted && !entities[id].mergedInto; })[0] || null;
  }

  function buildLookup(crm, entityId, state, open, mapped) {
    var ent = entityId ? state.entities[entityId] : null;
    var ids = {};
    if (entityId) {
      ids[entityId] = true;
      Object.keys(state.aliases || {}).forEach(function (k) { if (state.aliases[k] === entityId) ids[k] = true; });
    }
    var prov = (entityId && state.provenance && state.provenance[entityId]) || {};
    var history = {};
    Object.keys(prov).forEach(function (f) { history[f] = [prov[f]]; });
    return {
      crm: crm,
      entityId: ent ? entityId : null,
      entity: ent || null,
      displayName: ent ? (ent.attrs && ent.attrs.name) || slugName(entityId) : null,
      pendingPRs: ent ? open.filter(function (pr) { return touches(pr, ids); }) : [],
      history: history,
      mainlineUrl: ent ? entityUrl(entityId) : base() + "/crm",
      _mapped: !!mapped,
      _fallback: true,
    };
  }

  function lookupPath(r) {
    return "/api/records/lookup?crm=" + encodeURIComponent(r.crm) + "&objectType=" + encodeURIComponent(r.objectType || "") + "&id=" + encodeURIComponent(r.id);
  }

  /** Returns a view model: { mode: "record"|"queue"|"pr", ... } or { mode:"error" } */
  async function fetchView() {
    var ctx = S.ctx || { crm: null, record: null };
    var rec = S.tab === "prs" ? null : ctx.record; // PRs tab: always the global queue

    // Git CRM's own PR page: focus that PR, plus the rest of the queue.
    if (rec && rec.crm === "mainline" && rec.kind === "pr") {
      var rr = await Promise.all([api("/api/prs/" + encodeURIComponent(rec.id)), api("/api/prs?status=open")]);
      if (!rr[1].ok) return { mode: "error", error: rr[1] };
      var focus = rr[0].ok ? rr[0].data.pr : null;
      if (rr[0].ok) S.details[rec.id] = { key: detailKey(rr[0].data.pr), data: rr[0].data };
      if (focus && S.expanded[focus.id] === undefined) S.expanded[focus.id] = true;
      return { mode: "pr", ctx: ctx, focus: focus, focusId: rec.id, prs: (rr[1].data.prs || []).filter(function (p) { return !focus || p.id !== focus.id; }) };
    }

    if (rec) {
      var lk = null;
      var notMirrored = false;
      if (!S.lookupMissing && !FORCE_DEMO) {
        var r = await api(lookupPath(rec));
        if (r.ok && r.json && r.data && "pendingPRs" in r.data) {
          lk = r.data;
          if (!lk.entityId && (S.settings.demo) ) lk = null; // let demo mapping try
        } else if (r.status === 400 || (r.status === 404 && r.json)) {
          notMirrored = true; // unknown crm / record not mirrored → treat as not mirrored
        } else if (r.status === 404 || r.status === 405) {
          S.lookupMissing = true; // route not deployed yet
        } else {
          return { mode: "error", error: r };
        }
      }
      if (!lk) {
        if (notMirrored && !S.settings.demo) {
          lk = { crm: rec.crm, entityId: null, entity: null, displayName: null, pendingPRs: [], history: {}, mainlineUrl: base() + "/crm" };
        } else {
          var fb = await fallbackLookup(rec);
          if (fb.error) return { mode: "error", error: fb.error };
          lk = fb.data;
        }
      }
      var queue = null;
      if (!lk.entityId) {
        var q = await api("/api/prs?status=open");
        queue = q.ok ? q.data.prs || [] : null;
      }
      return { mode: "record", ctx: ctx, lookup: lk, queue: queue };
    }

    var g = await api("/api/prs?status=open");
    if (!g.ok) return { mode: "error", error: g };
    return { mode: "queue", ctx: ctx, prs: g.data.prs || [] };
  }

  function detailKey(pr) { return pr.id + "@" + (pr.updatedAt || 0) + "@" + (pr.status || ""); }

  async function ensureDetail(pr) {
    var key = detailKey(pr);
    var cur = S.details[pr.id];
    if (cur && cur.key === key && (cur.data || cur.loading)) return;
    S.details[pr.id] = { key: key, loading: true, data: cur && cur.data };
    var r = await api("/api/prs/" + encodeURIComponent(pr.id));
    S.details[pr.id] = r.ok ? { key: key, data: r.data } : { key: key, error: errText(r), data: cur && cur.data };
    render(true);
  }

  async function load(opts) {
    opts = opts || {};
    var seq = ++S.loadSeq;
    S.loading = true;
    if (opts.spin) $("refresh").classList.add("spin");
    var v;
    try { v = await fetchView(); } catch (e) { v = { mode: "error", error: { network: true, error: String((e && e.message) || e) } }; }
    if (seq !== S.loadSeq) return; // superseded
    S.loading = false;
    setTimeout(function () { $("refresh").classList.remove("spin"); }, 350);

    if (v.mode === "error") {
      S.conn = "err";
      S.lastError = v.error;
      // keep showing the last good data under an error notice
      if (!S.view || opts.reset) S.view = v;
    } else {
      var mapped = v.mode === "record" && v.lookup && v.lookup._mapped;
      S.conn = mapped || FORCE_DEMO ? "demo" : "ok";
      S.lastError = null;
      trackFresh(v);
      S.view = v;
    }
    render();
  }

  function allPRs(v) {
    if (!v) return [];
    if (v.mode === "record") return (v.lookup.pendingPRs || []).concat(v.queue || []);
    if (v.mode === "pr") return (v.focus ? [v.focus] : []).concat(v.prs || []);
    return v.prs || [];
  }
  function trackFresh(v) {
    var ids = allPRs(v).map(function (p) { return p.id; });
    if (S.seen) {
      ids.forEach(function (id) {
        if (!S.seen.has(id)) {
          S.fresh[id] = true;
          setTimeout(function () { delete S.fresh[id]; }, 2600);
        }
      });
    }
    S.seen = new Set(ids);
  }

  // ---------------------------------------------------------------- actions
  async function act(prId, kind) {
    if (S.busy[prId]) return;
    if (kind === "close" && !S.confirmReject[prId]) {
      S.confirmReject[prId] = true;
      render(true);
      setTimeout(function () { if (S.confirmReject[prId]) { delete S.confirmReject[prId]; render(true); } }, 4000);
      return;
    }
    delete S.confirmReject[prId];
    S.busy[prId] = kind;
    delete S.results[prId];
    render(true);
    var by = String(S.settings.reviewer || DEFAULTS.reviewer).trim() || DEFAULTS.reviewer;
    var body = kind === "merge" ? { by: by } : { by: by, reason: "Rejected from the Git CRM Chrome extension" };
    var r = await api("/api/prs/" + encodeURIComponent(prId) + "/" + kind, { method: "POST", body: body });
    delete S.busy[prId];
    if (r.ok) {
      S.results[prId] = { ok: true, msg: kind === "merge" ? "Merged into main by " + by : "Rejected by " + by };
      toast(kind === "merge" ? "Merged #" + prId.replace(/^pr_/, "") + " into main" : "Rejected #" + prId.replace(/^pr_/, ""), "ok");
      setTimeout(function () { delete S.results[prId]; delete S.expanded[prId]; load(); }, 900);
    } else {
      S.results[prId] = { ok: false, msg: errText(r), status: r.status };
    }
    render(true);
  }

  var toastT;
  function toast(msg, kind) {
    var t = $("toast");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- render
  function nameOf(id, detail) {
    var v = S.view;
    if (v && v.mode === "record" && v.lookup.entityId === id && v.lookup.displayName) return v.lookup.displayName;
    var bs = detail && detail.baseState;
    var e = bs && bs.entities && (bs.entities[id] || bs.entities[(bs.aliases || {})[id]]);
    var n = e && e.attrs && e.attrs.name;
    return typeof n === "string" && n.trim() ? n : slugName(id);
  }

  function badges(pr) {
    var out = [];
    var t = pr.policy && pr.policy.tier;
    if (t) {
      var label = { auto: "auto-merge", review: "needs review", block: "blocked" }[t] || t;
      out.push('<span class="badge ' + h(t) + '" title="' + h((pr.policy.reasons || []).join("\n")) + '">' + h(label) + "</span>");
    }
    var st = pr.staleness && pr.staleness.status;
    if (st === "stale") out.push('<span class="badge stale" title="Newer evidence contradicts this PR"><span class="dot"></span>stale</span>');
    if (st === "version-conflict") out.push('<span class="badge vconf" title="Fields this agent read changed on main">outdated reads</span>');
    var unresolved = (pr.conflicts || []).filter(function (c) { return !c.autoResolved && !c.resolution; }).length;
    if (unresolved) out.push('<span class="badge conflict">' + h(plural(unresolved, "conflict")) + "</span>");
    var rebased = (pr.conflicts || []).filter(function (c) { return c.autoResolved; }).length;
    if (rebased) out.push('<span class="badge info" title="Auto-rebased onto merge survivor">rebased</span>');
    return out.join("");
  }

  function explainers(pr) {
    var out = [];
    var s = pr.staleness;
    if (s && s.status === "stale") {
      var items = (s.contradictions || []).map(function (c) {
        return "<li><b>" + h(c.title) + "</b>" + (c.explanation ? " — " + h(c.explanation) : "") + "</li>";
      }).join("");
      out.push('<div class="explain stale"><h4>Stale: newer evidence contradicts this change</h4><p>The agent decided this before the following arrived. Re-check before merging.</p>' + (items ? "<ul>" + items + "</ul>" : "") + "</div>");
    } else if (s && s.status === "version-conflict") {
      var reads = (s.changedReads || []).slice(0, 4).map(function (c) { return "<li><code>" + h(c.key.replace("::", ".")) + "</code> changed on main since the agent read it</li>"; }).join("");
      out.push('<div class="explain vconf"><h4>Outdated reads</h4><p>The agent worked from values that have since changed.</p>' + (reads ? "<ul>" + reads + "</ul>" : "") + "</div>");
    }
    var unresolved = (pr.conflicts || []).filter(function (c) { return !c.autoResolved && !c.resolution; });
    if (unresolved.length) {
      var li = unresolved.slice(0, 4).map(function (c) {
        if (c.kind === "field") return "<li><code>" + h((c.field || "field")) + "</code>: main has <b>" + h(fmtVal(c.ours, c.field)) + "</b>, this PR wants <b>" + h(fmtVal(c.theirs, c.field)) + "</b></li>";
        return "<li>" + h(c.kind) + " conflict on " + h(slugName(c.entity)) + "</li>";
      }).join("");
      out.push('<div class="explain conflict"><h4>' + h(plural(unresolved.length, "merge conflict")) + '</h4><p>Pick a side in Git CRM before merging.</p><ul>' + li + "</ul></div>");
    }
    var autoRes = (pr.conflicts || []).filter(function (c) { return c.autoResolved; });
    if (autoRes.length) out.push('<div class="explain info"><h4>Auto-rebased</h4><p>' + h(autoRes[0].autoResolved.note || "Edit was rebased onto the merge survivor.") + "</p></div>");
    var p = pr.policy;
    if (p && p.tier !== "auto" && (p.reasons || []).length) {
      out.push('<div class="explain ' + h(p.tier) + '"><h4>' + (p.tier === "block" ? "Blocked by branch protection" : "Held for human review") + "</h4><ul>" +
        p.reasons.map(function (r) { return "<li>" + h(r) + "</li>"; }).join("") + "</ul></div>");
    }
    return out.join("");
  }

  function fieldTier(detail, entity, field) {
    if (!detail || !detail.pr || !detail.pr.policy) return null;
    var per = detail.pr.policy.perEvent || {};
    var evs = detail.events || [];
    for (var i = 0; i < evs.length; i++) {
      var op = evs[i].op;
      if (op.type === "field.set" && op.entity === entity && op.field === field) return per[evs[i].id] && per[evs[i].id].tier;
    }
    return null;
  }

  function diffHtml(pr, detail, focusId) {
    var changes = (pr.changes || []).filter(function (c) { return c.kind !== "evidence.added"; });
    if (!changes.length) return '<div class="muted small">' + ((pr.conflicts || []).length ? "The proposed change collides with main. Resolve the conflict to see the final diff." : "No field changes (evidence only).") + "</div>";
    var groups = {};
    var order = [];
    var key = function (c) { return c.entity || c.into || c.entityType || "_"; };
    changes.forEach(function (c) {
      var k = c.kind === "schema.changed" ? "schema:" + c.entityType : key(c);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(c);
    });
    if (focusId) order.sort(function (a, b) { return (b === focusId) - (a === focusId); });
    return '<div class="diff">' + order.map(function (k) {
      var rows = groups[k].map(function (c) {
        if (c.kind === "field.changed") {
          var tier = fieldTier(detail, c.entity, c.field);
          var delta = "";
          if (typeof c.before === "number" && typeof c.after === "number" && c.before !== c.after) {
            var d = c.after - c.before;
            var txt = isMoney(c.field) ? (d >= 0 ? "+" : "−") + usd.format(Math.abs(d)) : (d >= 0 ? "+" : "−") + Math.abs(d).toLocaleString("en-US");
            delta = '<span class="delta ' + (d >= 0 ? "up" : "down") + '">' + h(txt) + "</span>";
          }
          var before = c.before === undefined || c.before === null || c.before === "" ? '<span class="muted">empty</span>' : '<span class="del">' + h(fmtVal(c.before, c.field)) + "</span>";
          return '<div class="diff-row' + (tier && tier !== "auto" ? " tier-" + h(tier) : "") + '"' + (tier && tier !== "auto" ? ' title="' + h(tier === "block" ? "Blocked field" : "Needs human review") + '"' : "") + '><span class="f">' + h(c.field) + '</span><span class="v">' + before +
            '<span class="arrow">→</span><span class="add">' + h(fmtVal(c.after, c.field)) + "</span>" + delta + "</span></div>";
        }
        if (c.kind === "entity.added") return '<div class="diff-note"><span class="k plus">+ new</span>' + h(entType(c.entity)) + " <b>" + h((c.attrs && c.attrs.name) || slugName(c.entity)) + "</b></div>";
        if (c.kind === "entity.removed") return '<div class="diff-note"><span class="k minus">− delete</span>' + h(nameOf(c.entity, detail)) + "</div>";
        if (c.kind === "entity.merged") return '<div class="diff-note"><span class="k merge">merge</span><b>' + h(nameOf(c.from, detail)) + "</b> into <b>" + h(nameOf(c.into, detail)) + "</b> <span class=\"muted mono\">" + h(c.from) + " → " + h(c.into) + "</span></div>";
        if (c.kind === "schema.changed") return '<div class="diff-note"><span class="k schema">schema</span>' + h(c.description) + "</div>";
        return "";
      }).join("");
      var head = "";
      if (k.indexOf("schema:") === 0) head = '<div class="diff-ent">Schema <span class="t">' + h(k.slice(7)) + "</span></div>";
      else if (k !== "_") head = '<div class="diff-ent">' + h(nameOf(k, detail)) + ' <span class="t">' + h(entType(k)) + "</span></div>";
      return head + rows;
    }).join("") + "</div>";
  }

  function evidenceHtml(detail) {
    if (!detail) return "";
    var docs = {};
    (detail.docs || []).forEach(function (d) { docs[d.id] = d; });
    var seen = {};
    var refs = [];
    (detail.events || []).forEach(function (e) {
      (e.evidence || []).forEach(function (r) {
        var k = r.docId + "|" + r.claim;
        if (seen[k]) return;
        seen[k] = true;
        refs.push(r);
      });
    });
    if (!refs.length) return "";
    return '<div class="section-title" style="margin:2px 0 -2px">Evidence</div>' + refs.slice(0, 6).map(function (r) {
      var d = docs[r.docId];
      var src = d ? (d.kind + " · " + (d.title || d.id) + (d.from ? " · " + d.from.replace(/<.*>/, "").trim() : "") + (d.ts ? " · " + fmtAge(d.ts) : "")) : r.docId;
      return '<div class="ev"><div class="claim">' + h(r.claim) + "</div>" + (r.quote ? "<blockquote>“" + h(r.quote) + "”</blockquote>" : "") + '<div class="src">' + h(src) + "</div></div>";
    }).join("") + (refs.length > 6 ? '<div class="muted small">+' + (refs.length - 6) + " more in Git CRM</div>" : "");
  }

  function actionsHtml(pr) {
    var id = pr.id;
    var res = S.results[id];
    if (res && res.ok) return '<div class="act-ok">✓ ' + h(res.msg) + "</div>";
    var unresolved = (pr.conflicts || []).filter(function (c) { return !c.autoResolved && !c.resolution; }).length;
    var blocked = pr.policy && pr.policy.tier === "block";
    var busy = S.busy[id];
    var mergeDisabled = !!busy || blocked || unresolved > 0 || pr.status !== "open";
    var mergeTitle = blocked ? "Blocked by branch protection" : unresolved ? "Resolve conflicts in Git CRM first" : "";
    var stale = pr.staleness && pr.staleness.status === "stale";
    var mergeLabel = busy === "merge" ? "Merging…" : stale ? "Merge anyway" : "Approve &amp; merge";
    var rejectLabel = busy === "close" ? "Rejecting…" : S.confirmReject[id] ? "Confirm reject" : "Reject";
    return (res && !res.ok ? '<div class="act-err">' + h(res.status === 409 ? "Can't merge: " : "Failed: ") + h(res.msg) + "</div>" : "") +
      '<div class="actions">' +
      '<button class="btn primary" data-act="merge" data-id="' + h(id) + '"' + (mergeDisabled ? " disabled" : "") + (mergeTitle ? ' title="' + h(mergeTitle) + '"' : "") + ">" + mergeLabel + "</button>" +
      '<button class="btn danger" data-act="close" data-id="' + h(id) + '"' + (busy || pr.status !== "open" ? " disabled" : "") + ">" + rejectLabel + "</button>" +
      '<a class="open-link" href="' + h(prUrl(id)) + '" target="_blank" rel="noopener">' + (unresolved ? "Resolve conflicts in Git CRM ↗" : "Open in Git CRM ↗") + "</a>" +
      "</div>";
  }

  function cardHtml(pr, focusId) {
    var open = !!S.expanded[pr.id];
    var stale = pr.staleness && pr.staleness.status === "stale";
    var n = (pr.changes || []).filter(function (c) { return c.kind !== "evidence.added"; }).length;
    var det = S.details[pr.id];
    var body = "";
    if (open) {
      var detail = det && det.data;
      body = '<div class="card-body">' + explainers(pr) + diffHtml(pr, detail, focusId) +
        (detail ? evidenceHtml(detail) : det && det.error ? '<div class="muted small">Couldn\'t load evidence: ' + h(det.error) + "</div>" : '<div class="muted small">Loading evidence…</div>') +
        actionsHtml(pr) + "</div>";
    }
    return '<div class="card' + (stale ? " stale" : "") + (open ? " open" : "") + (S.fresh[pr.id] ? " fresh" : "") + '" data-card="' + h(pr.id) + '">' +
      '<button class="card-head" data-toggle="' + h(pr.id) + '" aria-expanded="' + open + '">' +
      '<span class="ico">' + ICON_PR + '</span><span class="title">' + h(pr.title) + '</span><span class="chev">' + ICON_CHEV + "</span>" +
      '<span class="badges">' + actorChip(pr.author) + badges(pr) + "</span>" +
      '<span class="meta"><span class="mono">#' + h(String(pr.id).replace(/^pr_/, "")) + "</span><span>· " + h(plural(n, "change")) + "</span><span>· " + h(fmtAge(pr.createdAt)) + "</span></span>" +
      "</button>" + body + "</div>";
  }

  function sortPRs(list) {
    var rank = function (p) {
      var r = 0;
      if (p.staleness && p.staleness.status === "stale") r -= 4;
      if (p.policy && p.policy.tier === "review") r -= 2;
      if ((p.conflicts || []).some(function (c) { return !c.autoResolved && !c.resolution; })) r -= 1;
      return r;
    };
    return list.slice().sort(function (a, b) { return rank(a) - rank(b) || b.createdAt - a.createdAt; });
  }

  function cardsHtml(list, focusId) {
    return '<div class="cards">' + sortPRs(list).map(function (p) { return cardHtml(p, focusId); }).join("") + "</div>";
  }

  function historyHtml(lk) {
    var hist = lk.history || {};
    var fields = Object.keys(hist).filter(function (f) { return (hist[f] || []).length; });
    if (!fields.length) return "";
    var attrs = (lk.entity && lk.entity.attrs) || {};
    fields.sort(function (a, b) { return (hist[b][0].ts || 0) - (hist[a][0].ts || 0); });
    return '<section><div class="section-title">Field history <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· who wrote what</span></div><div class="hist">' +
      fields.map(function (f) {
        var items = hist[f].slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        var last = items[0];
        return '<details class="hist-field"><summary><span class="f">' + h(f) + '</span><span class="cur" title="' + h(fmtVal(attrs[f], f)) + '">' + h(fmtVal(attrs[f], f)) + "</span>" + actorChip(last.actor) + "</summary>" +
          '<div class="hist-list">' + items.map(function (p) {
            var ev = (p.evidence || [])[0];
            return '<div class="hist-item">' + actorChip(p.actor) + '<span class="when">' + h(fmtAge(p.ts)) + (p.branch && p.branch !== "main" ? " · " + h(p.branch) : "") + "</span>" +
              (p.reason || ev ? '<span class="why">' + h(p.reason || "") + (ev && ev.quote ? (p.reason ? " — " : "") + "“" + h(ev.quote) + "”" : "") + "</span>" : "") + "</div>";
          }).join("") + "</div></details>";
      }).join("") + "</div></section>";
  }

  function errorHtml(e, compact) {
    var unreachable = !e || e.network || e.status === 0 || e.status >= 500;
    var title = unreachable ? "Can't reach Git CRM" : "Git CRM returned an error";
    var msg = unreachable ? "The server at " + h(base().replace(/^https?:\/\//, "")) + " didn't respond. It may be waking up — try again in a few seconds." : h(errText(e));
    if (compact) return '<div class="notice"><span>⚠</span><span><b>' + title + ".</b> Showing the last data we had. Retrying every few seconds…</span></div>";
    return '<div class="error"><h3>' + title + "</h3><p>" + msg + '</p><div class="detail">' + h(errText(e)) + '</div><div class="row"><button class="btn sm" data-act="retry">Retry</button><button class="btn sm ghost" data-act="settings">Settings</button></div></div>';
  }

  function render(force) {
    var v = S.view;
    var app = $("app");
    var conn = $("conn");
    conn.className = "conn " + S.conn;
    var connLabel = { ok: "live", err: "offline", demo: "demo data", connecting: "connecting" }[S.conn];
    conn.querySelector(".conn-label").textContent = connLabel;
    conn.title = S.conn === "ok" ? "Connected to " + base() + " · polling every 4s" + (S.lookupMissing ? " · record lookup computed client-side" : "") : S.conn === "demo" ? "Demo mapping: CRM record shown as a matching Git CRM demo record" : S.conn === "err" ? errText(S.lastError) : "Connecting…";
    if (!v) return;

    var sig = JSON.stringify([v, S.expanded, S.details, S.busy, S.confirmReject, S.results, S.fresh, S.conn]);
    if (!force && sig === S.sig) return;
    S.sig = sig;

    var html = "";
    if (S.lastError && v.mode !== "error") html += errorHtml(S.lastError, true);

    if (v.mode === "error") {
      html += errorHtml(v.error);
    } else if (v.mode === "record") {
      html += recordHtml(v);
    } else if (v.mode === "pr") {
      html += '<div class="record"><div class="r1">' + crmChip(v.ctx.crm) + '<span class="chip system">Pull request</span></div><h1>' +
        (v.focus ? h(v.focus.title) : "PR " + h(v.focusId)) + "</h1>" +
        (v.focus ? '<div class="r3"><span class="eid">#' + h(String(v.focus.id).replace(/^pr_/, "")) + "</span><span>" + h(v.focus.status) + '</span><span class="branch">' + h(v.focus.branch) + "</span></div>" : "") + "</div>";
      if (v.focus && v.focus.status === "open") html += cardsHtml([v.focus]);
      else if (v.focus) html += '<div class="notice">This PR is <b>' + h(v.focus.status) + "</b>. Nothing to review.</div>";
      html += queueSection(v.prs, "Other open PRs");
    } else {
      var crm = v.ctx && v.ctx.crm;
      if (crm && crm.id !== "mainline" && S.tab !== "prs") {
        html += '<div class="notice">' + crmChip(crm) + "<span>Open a deal, contact or company in " + h(crm.name) + " to see its agent changes here.</span></div>";
      }
      html += queueSection(v.prs, S.tab === "prs" ? "All open PRs" : "Open PR queue", true);
    }
    html += '<div class="foot"><span>' + h(base().replace(/^https?:\/\//, "")) + '</span><a href="' + h(base() + "/prs") + '" target="_blank" rel="noopener">All PRs ↗</a></div>';

    var scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    app.innerHTML = html;
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;

    // lazy-load details for expanded cards
    allPRs(v).forEach(function (p) { if (S.expanded[p.id]) ensureDetail(p); });
  }

  function queueSection(prs, title, isMain) {
    prs = prs || [];
    var need = prs.filter(function (p) { return (p.staleness && p.staleness.status === "stale") || (p.policy && p.policy.tier !== "auto"); }).length;
    var head = '<div class="section-title">' + h(title) + ' <span class="count">' + prs.length + "</span>" + (need ? '<span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">· ' + need + " need a human</span>" : "") + "</div>";
    if (!prs.length) {
      if (!isMain) return "";
      return "<section>" + head + '<div class="empty ok"><div class="big">✓</div><h3>No open agent PRs</h3><p>Agents haven\'t proposed anything that needs review. New PRs show up here within seconds.</p></div></section>';
    }
    return "<section>" + head + cardsHtml(prs) + "</section>";
  }

  function recordHtml(v) {
    var lk = v.lookup;
    var rec = v.ctx.record;
    var crm = v.ctx.crm || CRMs.byId(lk.crm);
    var html = "";
    if (!lk.entityId) {
      var cname = (crm && crm.name) || rec.crmName || rec.crm;
      html += '<div class="record"><div class="r1">' + crmChip(crm) + '<span class="chip system">' + h(rec.label) + '</span></div><h1>' + h(rec.label) + ' <span class="muted mono" style="font-size:12px;font-weight:400">' + h(rec.id) + "</span></h1></div>";
      if (rec.crm === "mainline") {
        html += '<div class="empty"><div class="big">∅</div><h3>Record not found on main</h3><p>' + h(rec.id) + " doesn't exist in Git CRM (it may have been merged or deleted).</p></div>";
      } else {
        html += '<div class="empty"><div class="big">' + ICON_PR.replace(/14/g, "22") + '</div><h3>Connect ' + h(cname) + " to Git CRM</h3><p>This " + h(rec.label.toLowerCase()) + " isn't mirrored in Git CRM yet. Once " + h(cname) +
          " is connected, agents open PRs against it instead of writing to it directly, and you review them here.</p>" +
          '<div class="row"><a class="btn sm" href="' + h(base() + "/extension") + '" target="_blank" rel="noopener">How to connect ↗</a>' +
          '<button class="btn sm ghost" data-act="demo-on" title="Map this record to a Git CRM demo record of the same type">Use demo mapping</button></div></div>';
      }
      if (v.queue) html += queueSection(v.queue, "Open PR queue · all records");
      return html;
    }
    var pending = lk.pendingPRs || [];
    var stale = pending.filter(function (p) { return p.staleness && p.staleness.status === "stale"; }).length;
    html += '<div class="record"><div class="r1">' + crmChip(crm) + '<span class="chip system">' + h(CRMs.kindLabel(entType(lk.entityId))) + "</span>" +
      (lk._mapped ? '<span class="badge neutral" title="Demo mapping: this CRM record is shown as the matching Git CRM demo record">demo mapping</span>' : "") + "</div>" +
      "<h1>" + h(lk.displayName || slugName(lk.entityId)) + "</h1>" +
      '<div class="r3"><span class="eid">' + h(lk.entityId) + '</span><a href="' + h(lk.mainlineUrl || entityUrl(lk.entityId)) + '" target="_blank" rel="noopener">View on main ↗</a></div>' +
      (pending.length
        ? '<div class="summary warn"><strong>' + h(plural(pending.length, "pending agent change", "pending agent changes")) + "</strong>" + (stale ? '<span class="badge stale"><span class="dot"></span>' + stale + " stale</span>" : "") + "</div>"
        : "") +
      "</div>";
    if (pending.length) {
      html += '<section><div class="section-title">Pending agent changes <span class="count">' + pending.length + "</span></div>" + cardsHtml(pending, lk.entityId) + "</section>";
    } else {
      html += '<div class="empty ok"><div class="big">✓</div><h3>No agent changes pending for this record</h3><p>Main is up to date. If an agent proposes a change, it appears here within seconds.</p></div>';
    }
    html += historyHtml(lk);
    return html;
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-toggle],[data-act],a[target=_blank]");
    if (!t) return;
    if (t.matches("a[target=_blank]")) {
      e.preventDefault();
      send({ type: "mainline:openTab", url: t.href });
      return;
    }
    if (t.dataset.toggle) {
      var id = t.dataset.toggle;
      if (S.expanded[id]) delete S.expanded[id]; else S.expanded[id] = true;
      render(true);
      return;
    }
    var act = t.dataset.act;
    if (act === "merge" || act === "close") act === "merge" ? doAct(t.dataset.id, "merge") : doAct(t.dataset.id, "close");
    else if (act === "retry") { S.view = null; $("app").innerHTML = '<div class="skel"></div><div class="skel"></div>'; load({ spin: true, reset: true }); }
    else if (act === "settings") openSettings();
    else if (act === "demo-on") {
      S.settings.demo = true;
      try { chrome.storage.sync.set({ demo: true }); } catch (err) { /* ignore */ }
      load({ spin: true });
    }
  });
  function doAct(id, kind) { act(id, kind); }

  $("refresh").addEventListener("click", function () { S.lookupMissing = false; load({ spin: true }); });
  $("gear").addEventListener("click", function () { $("settings").hidden ? openSettings() : closeSettings(); });

  function openSettings() {
    $("s-server").value = S.settings.serverUrl;
    $("s-reviewer").value = S.settings.reviewer;
    $("s-demo").checked = !!S.settings.demo;
    $("s-msg").textContent = "";
    $("s-msg").className = "s-msg";
    $("settings").hidden = false;
    $("frames").hidden = true;
    $("s-reviewer").focus();
  }
  function closeSettings() { $("settings").hidden = true; $("frames").hidden = !FRAME_TABS[S.tab]; }
  function readForm() {
    var url = $("s-server").value.trim().replace(/\/+$/, "") || DEFAULTS.serverUrl;
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    return { serverUrl: url, reviewer: $("s-reviewer").value.trim() || DEFAULTS.reviewer, demo: $("s-demo").checked };
  }
  $("s-cancel").addEventListener("click", closeSettings);
  $("s-test").addEventListener("click", async function () {
    var f = readForm();
    var m = $("s-msg");
    m.className = "s-msg";
    m.textContent = "Testing…";
    var r = await api("/api/prs?status=open", { base: f.serverUrl });
    if (r.ok && r.data && Array.isArray(r.data.prs)) { m.className = "s-msg ok"; m.textContent = "Connected · " + plural(r.data.prs.length, "open PR"); }
    else { m.className = "s-msg err"; m.textContent = "Failed: " + errText(r); }
  });
  $("s-save").addEventListener("click", function () {
    var f = readForm();
    var changedServer = f.serverUrl !== S.settings.serverUrl;
    S.settings = Object.assign({}, S.settings, f);
    try { chrome.storage.sync.set(f); } catch (e) { /* ignore */ }
    if (changedServer) { S.lookupMissing = false; S.details = {}; S.seen = null; resetFrames(); }
    closeSettings();
    toast("Settings saved", "ok");
    load({ spin: true, reset: true });
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "sync") return;
      Object.keys(changes).forEach(function (k) { S.settings[k] = changes[k].newValue; });
    });
  } catch (e) { /* ignore */ }

  // context from the background worker
  function setContext(ctx) {
    if (!ctx) return;
    if (S.windowId != null && ctx.windowId != null && ctx.windowId !== S.windowId) return;
    var prevKey = S.ctx ? JSON.stringify([S.ctx.crm && S.ctx.crm.id, S.ctx.record]) : null;
    S.ctx = ctx;
    var key = JSON.stringify([ctx.crm && ctx.crm.id, ctx.record]);
    if (key !== prevKey && S.tab === "record") {
      S.view = null;
      S.sig = "";
      $("app").innerHTML = '<div class="skel"></div><div class="skel"></div>';
      load();
    }
  }
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "mainline:context") setContext(msg.context);
    });
  } catch (e) { /* ignore */ }

  // polling while visible
  var pollT = null;
  function schedule() {
    clearTimeout(pollT);
    pollT = setTimeout(function tick() {
      if (document.visibilityState === "visible" && !S.loading && !Object.keys(S.busy).length && !FRAME_TABS[S.tab]) load();
      schedule();
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && !FRAME_TABS[S.tab]) load(); });
  // re-render relative times occasionally
  setInterval(function () { render(true); }, 30000);

  // ---------------------------------------------------------------- tabs
  function frameSrc(tab) { return base() + FRAME_TABS[tab] + "?embed=1"; }
  function resetFrames() {
    Object.keys(frames).forEach(function (k) { frames[k].wrap.remove(); delete frames[k]; });
    if (FRAME_TABS[S.tab]) ensureFrame(S.tab);
  }
  function ensureFrame(tab) {
    var src = frameSrc(tab);
    if (frames[tab] && frames[tab].src === src) return frames[tab];
    if (frames[tab]) frames[tab].wrap.remove();
    var wrap = document.createElement("div");
    wrap.className = "frame-wrap";
    wrap.innerHTML = '<div class="frame-load">Loading ' + h(FRAME_TITLES[tab]) + "…</div>" +
      '<div class="frame-bar"><a class="btn sm" href="' + h(base() + FRAME_TABS[tab]) + '" target="_blank" rel="noopener" title="Open this view in a full tab">Open full ↗</a></div>';
    var f = document.createElement("iframe");
    f.className = "frame";
    f.title = FRAME_TITLES[tab];
    f.setAttribute("data-frame", tab);
    f.setAttribute("allow", "clipboard-write");
    f.addEventListener("load", function () {
      var l = wrap.querySelector(".frame-load"); if (l) l.remove();
      if (frames[tab] && frames[tab].el === f) postVis(frames[tab], S.tab === tab);
    });
    f.src = src;
    wrap.insertBefore(f, wrap.firstChild);
    $("frames").appendChild(wrap);
    frames[tab] = { wrap: wrap, src: src, el: f };
    return frames[tab];
  }
  function postVis(fr, visible) {
    try { fr.el.contentWindow.postMessage({ type: "gitcrm:visible", visible: visible }, new URL(fr.src).origin); } catch (e) { /* not loaded yet */ }
  }
  function setTab(tab, opts) {
    opts = opts || {};
    if (tab !== "record" && tab !== "prs" && !FRAME_TABS[tab]) tab = "record";
    var prev = S.tab;
    S.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"), function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      if (on && b.scrollIntoView) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    var framed = !!FRAME_TABS[tab];
    document.body.classList.toggle("framed", framed);
    $("frames").hidden = !framed || !$("settings").hidden;
    if (framed) {
      ensureFrame(tab); // lazy: created on first open, then kept
    }
    // hidden frames pause their live stream (see EMBED_BOOT in src/app/layout.tsx); state is kept
    Object.keys(frames).forEach(function (k) {
      var vis = k === tab;
      frames[k].wrap.hidden = !vis;
      postVis(frames[k], vis);
    });
    try { chrome.storage.local.set({ tab: tab }); } catch (e) { /* ignore */ }
    if (opts.boot) return;
    if (!framed) {
      // record <-> prs show different data: drop the old view so it doesn't flash
      var showsRecord = function (t) { return t === "record" && !!(S.ctx && S.ctx.record); };
      if (S.view && showsRecord(tab) !== showsRecord(FRAME_TABS[prev] ? (S.view.mode === "queue" ? "prs" : "record") : prev)) {
        S.view = null; S.sig = "";
        $("app").innerHTML = '<div class="skel"></div><div class="skel"></div>';
      }
      if (prev !== tab) load({ spin: true });
    }
  }
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab);
  });
  function loadTab() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get({ tab: "record" }, function (r) { resolve((r && r.tab) || "record"); }); }
      catch (e) { resolve("record"); }
    });
  }

  // ---------------------------------------------------------------- boot
  (async function boot() {
    await loadSettings();
    setTab(await loadTab(), { boot: true });
    try {
      var w = await new Promise(function (resolve) {
        if (chrome.windows && chrome.windows.getCurrent) chrome.windows.getCurrent(function (win) { resolve(win); });
        else resolve(null);
      });
      if (w) S.windowId = w.id;
    } catch (e) { /* ignore */ }
    var ctx = await send({ type: "mainline:getContext", windowId: S.windowId });
    S.ctx = ctx && "record" in ctx ? ctx : { url: "", crm: null, record: null };
    await load();
    schedule();
  })();
})();
