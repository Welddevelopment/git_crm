/* Git CRM extension: CRM registry. Record detection is by URL only; we never read the CRM's DOM.
 * Shared by the background service worker (importScripts) and the side panel (<script>).
 * One entry per CRM: { id, name, color, hosts(host, settings) -> bool, match(url) -> record | null }.
 * A record is { crm, crmName, objectType, kind, id, label, extra? } where:
 *   objectType = what the lookup route receives (CRM-native spelling, per RecordLookup contract)
 *   kind       = normalized Git CRM type: "deal" | "contact" | "company" | "pr" | other
 */
(function (root) {
  "use strict";

  var HUBSPOT_TYPES = { "0-1": "contact", "0-2": "company", "0-3": "deal", "0-5": "ticket", contact: "contact", company: "company", deal: "deal" };
  var ATTIO_TYPES = {
    person: "people", people: "people", persons: "people",
    company: "companies", companies: "companies",
    deal: "deals", deals: "deals",
  };
  var ATTIO_KIND = { people: "contact", companies: "company", deals: "deal" };
  var SF_KIND = { Opportunity: "deal", Contact: "contact", Lead: "contact", Account: "company" };
  var PD_KIND = { deal: "deal", person: "contact", organization: "company" };

  function rec(crm, objectType, kind, id, extra) {
    var entry = REGISTRY.filter(function (c) { return c.id === crm; })[0];
    return {
      crm: crm,
      crmName: entry ? entry.name : crm,
      objectType: objectType,
      kind: kind || objectType,
      id: id,
      label: kindLabel(kind || objectType),
      extra: extra || null,
    };
  }

  function kindLabel(k) {
    return ({ deal: "Deal", contact: "Contact", company: "Company", ticket: "Ticket", pr: "Pull request" })[k] || (k ? String(k).replace(/[_-]/g, " ") : "Record");
  }

  function hostOf(s) {
    try { return new URL(s).host; } catch (e) { return ""; }
  }

  var REGISTRY = [
    {
      id: "hubspot",
      name: "HubSpot",
      color: "#ff7a59",
      hosts: function (host) { return /^app(-[a-z0-9]+)?\.hubspot\.com$/.test(host); },
      match: function (u) {
        var m = u.pathname.match(/^\/contacts\/(\d+)\/record\/(\d+-\d+)\/(\d+)/);
        if (m) return rec("hubspot", m[2], HUBSPOT_TYPES[m[2]] || m[2], m[3], { portal: m[1] });
        m = u.pathname.match(/^\/contacts\/(\d+)\/(deal|company|contact)\/(\d+)/);
        if (m) return rec("hubspot", m[2], m[2], m[3], { portal: m[1] });
        return null;
      },
    },
    {
      id: "attio",
      name: "Attio",
      color: "#9aa6ff",
      hosts: function (host) { return host === "app.attio.com"; },
      match: function (u) {
        // /<workspace>/<object>/record/<id>/...  (also /<workspace>/objects/<object>/record/<id>)
        var m = u.pathname.match(/^\/([^/]+)\/(?:objects\/)?([a-z_]+)\/record\/([0-9a-zA-Z-]{6,})/);
        // /<workspace>/person/<id>/overview, /<workspace>/company/<id>/...
        if (!m) m = u.pathname.match(/^\/([^/]+)\/(person|people|company|companies|deal|deals)\/([0-9a-fA-F-]{8,})/);
        if (!m) return null;
        var obj = ATTIO_TYPES[m[2]] || m[2];
        return rec("attio", obj, ATTIO_KIND[obj] || m[2], m[3], { workspace: m[1] });
      },
    },
    {
      id: "salesforce",
      name: "Salesforce",
      color: "#1ea7e6",
      hosts: function (host) { return /\.lightning\.force\.com$/.test(host); },
      match: function (u) {
        var m = u.pathname.match(/^\/lightning\/r\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})\/view/);
        if (!m) return null;
        var kind = SF_KIND[m[1]] || m[1].toLowerCase();
        return rec("salesforce", kind, kind, m[2], { object: m[1] });
      },
    },
    {
      id: "pipedrive",
      name: "Pipedrive",
      color: "#3ecf8e",
      hosts: function (host) { return /\.pipedrive\.com$/.test(host); },
      match: function (u) {
        var m = u.pathname.match(/^\/(deal|person|organization)\/(\d+)/);
        if (!m) return null;
        return rec("pipedrive", m[1], PD_KIND[m[1]], m[2]);
      },
    },
    {
      id: "mainline",
      name: "Git CRM",
      color: "#7c9cff",
      hosts: function (host, settings) {
        var own = hostOf((settings && settings.serverUrl) || "");
        return host === own || host === "gitcrm-production.up.railway.app" || host === "localhost:3000";
      },
      match: function (u) {
        if (u.pathname === "/crm" || u.pathname === "/crm/") {
          var ent = u.searchParams.get("entity");
          if (ent) return rec("mainline", ent.split(":")[0], ent.split(":")[0], ent);
          return null;
        }
        var m = u.pathname.match(/^\/prs\/([^/?#]+)/);
        if (m) return rec("mainline", "pr", "pr", decodeURIComponent(m[1]));
        return null;
      },
    },
  ];

  /** Detect { crm, record } for a tab URL. crm is set whenever the host belongs to a known CRM. */
  function detect(url, settings) {
    var u;
    try { u = new URL(url); } catch (e) { return { crm: null, record: null }; }
    if (!/^https?:$/.test(u.protocol)) return { crm: null, record: null };
    for (var i = 0; i < REGISTRY.length; i++) {
      var c = REGISTRY[i];
      if (!c.hosts(u.host, settings)) continue;
      var r = null;
      try { r = c.match(u); } catch (e) { r = null; }
      return { crm: { id: c.id, name: c.name, color: c.color }, record: r };
    }
    return { crm: null, record: null };
  }

  function byId(id) {
    return REGISTRY.filter(function (c) { return c.id === id; })[0] || null;
  }

  root.MainlineCRMs = { REGISTRY: REGISTRY, detect: detect, byId: byId, kindLabel: kindLabel };
})(typeof self !== "undefined" ? self : this);
