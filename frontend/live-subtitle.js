(function () {
  // Single-sentence subtitle page, designed to be pulled into OBS as a browser
  // source. URL params:
  //   src    : source key (which stream to listen to)            [required]
  //   lang   : "zh" -> original transcript, "en" -> translation  [default zh]
  //   passwd : passkey for `src`; when present we log in to get the auth cookie.
  const captionEl = document.getElementById("caption");

  // Mirrors relay_service/resource_manage.py:KEY_RE and app.js:KEY_RE.
  const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const params = new URLSearchParams(window.location.search);
  const rawSrc = params.get("src");
  const key = rawSrc && KEY_RE.test(rawSrc) ? rawSrc : null;
  const lang = (params.get("lang") || "zh").toLowerCase() === "en" ? "en" : "zh";
  const passwd = params.get("passwd");

  function log(message) {
    console.log(`[live-subtitle] ${message}`);
  }

  // ── Stateful segment tracking (mirrors app.js's append logic) ──
  // We keep an ordered list of finalized segments and one in-progress
  // ("updating") item. Each WS message's lines[] are applied incrementally:
  //   - "segment"        → appended to the list
  //   - "segment_update" → patches the matching existing segment in-place
  //   - "updating"       → replaces the current in-progress item
  // Display always picks the tail of this ordered history, so a
  // segment_update to an OLD sentence never overwrites a newer one.
  var segments = [];
  var currentUpdating = null;
  var MAX_SEGMENTS = 200;

  function lineText(line) {
    if (line == null) return "";
    if (typeof line === "string") {
      return lang === "en" ? "" : line.trim();
    }
    if (typeof line !== "object") return "";
    if (lang === "en") {
      return String(line.translation ?? line.text_translation ?? line.translated ?? "").trim();
    }
    return String(line.text ?? line.original ?? "").trim();
  }

  function normalizeLine(line) {
    if (typeof line === "string") {
      return { original: line, translation: "", status: "segment", start: null, end: null };
    }
    if (!line || typeof line !== "object") {
      return { original: "", translation: "", status: "segment", start: null, end: null };
    }
    return {
      original: String(line.text ?? line.original ?? ""),
      translation: String(line.translation ?? line.text_translation ?? line.translated ?? ""),
      status:
        line.status === "updating" || line.status === "segment_update"
          ? line.status
          : "segment",
      start: line.start ?? null,
      end: line.end ?? null,
    };
  }

  // Mirrors relay_service/asr_link.py:segment_key — timestamps have 1-second
  // resolution, so the original text is part of the identity to keep two
  // short sentences starting in the same second apart.
  function segmentKey(item) {
    return JSON.stringify([item.start ?? null, item.end ?? null, item.original ?? ""]);
  }

  function applyLines(lines) {
    if (!Array.isArray(lines)) return;
    currentUpdating = null;

    lines.forEach(function (raw) {
      var item = normalizeLine(raw);
      if (!item.original && !item.translation) return;

      if (item.status === "updating") {
        currentUpdating = item;
        return;
      }

      if (item.status === "segment_update") {
        var sk = segmentKey(item);
        var existing = null;
        for (var i = segments.length - 1; i >= 0; i -= 1) {
          if (segmentKey(segments[i]) === sk) { existing = segments[i]; break; }
        }
        if (existing) {
          Object.assign(existing, item, { status: "segment" });
          return;
        }
        item.status = "segment";
      }

      item.status = "segment";
      segments.push(item);
    });

    if (segments.length > MAX_SEGMENTS) {
      segments = segments.slice(-MAX_SEGMENTS);
    }
  }

  function latestDisplayText() {
    if (currentUpdating) {
      var t = lineText(currentUpdating);
      if (t) return t;
    }
    for (var i = segments.length - 1; i >= 0; i -= 1) {
      var t2 = lineText(segments[i]);
      if (t2) return t2;
    }
    return "";
  }

  function applyCaptionPayload(payload) {
    if (!payload || payload.type !== "caption") return;
    applyLines(payload.lines);
    var text = latestDisplayText();
    if (text && captionEl) captionEl.textContent = text;
  }

  function deriveRegisterUrl(relayWsUrl) {
    const u = new URL(relayWsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/register";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  }

  function deriveRecentSubtitlesUrl(relayWsUrl) {
    const u = new URL(relayWsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = u.pathname.replace(/\/subtitles(?=\/|$)/, "/subtitles_recent");
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  async function ensureAuth() {
    // No passkey supplied: rely on an existing cookie (set previously / via /login).
    if (!passwd) return;
    log("Logging in with passwd from URL");
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ key, passkey: passwd }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `login failed (HTTP ${res.status})`);
    }
    log("Login OK; auth cookie set");
  }

  async function registerKey(registerUrl) {
    const res = await fetch(`${registerUrl}?src=${encodeURIComponent(key)}`, {
      method: "POST",
      credentials: "same-origin",
    });
    // 200: session created; 409: already exists (another viewer). Both are fine.
    if (res.status === 200 || res.status === 409) return res.status;
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    throw new Error(`register HTTP ${res.status}`);
  }

  async function loadRecentSubtitles(recentSubtitlesUrl) {
    try {
      const res = await fetch(recentSubtitlesUrl, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!res.ok) {
        log(`recent subtitles unavailable: HTTP ${res.status}`);
        return;
      }
      const payload = await res.json();
      const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
      // Apply in order so the final state reflects the newest sentence.
      subtitles.forEach(applyCaptionPayload);
      log(`Seeded from ${subtitles.length} recent subtitle messages`);
    } catch (err) {
      log(`recent subtitles failed: ${err && err.message ? err.message : err}`);
    }
  }

  function connectWs(relayWsUrl) {
    let backoff = 1000;

    function open() {
      let ws;
      try {
        ws = new WebSocket(relayWsUrl);
      } catch (err) {
        log(`Failed to open WS: ${err}`);
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15000);
        return;
      }
      log(`Connecting subtitles WS: ${relayWsUrl}`);

      ws.onopen = () => {
        backoff = 1000;
        log("Subtitle WS connected");
      };

      ws.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload && payload.type === "caption") {
          applyCaptionPayload(payload);
        }
      };

      ws.onclose = () => {
        log("Subtitle WS closed; reconnecting");
        const delay = Math.min(backoff, 15000);
        backoff = Math.min(backoff * 2, 15000);
        setTimeout(open, delay);
      };

      ws.onerror = () => {
        log("Subtitle WS error");
      };
    }

    open();
  }

  async function start() {
    const cfg = window.FRONTEND_CONFIG || {};
    const defaultHost = cfg.host || window.location.hostname || "localhost";
    const relayWsUrlBase = (cfg.relayWsUrl || `ws://${defaultHost}:9000/subtitles`).replace(/\/+$/, "");
    const relayWsUrl = `${relayWsUrlBase}/${key}`;
    const registerUrl = deriveRegisterUrl(relayWsUrlBase);
    const recentSubtitlesUrl = deriveRecentSubtitlesUrl(relayWsUrl);

    try {
      await ensureAuth();
    } catch (err) {
      log(`Auth failed: ${err && err.message ? err.message : err}`);
      // Without auth the relay endpoints will 401; nothing more we can do here.
      return;
    }

    try {
      const status = await registerKey(registerUrl);
      log(`register success: HTTP ${status}`);
    } catch (err) {
      log(`register failed: ${err && err.message ? err.message : err}`);
      // Still attempt to seed/subscribe; another viewer may already hold the session.
    }

    await loadRecentSubtitles(recentSubtitlesUrl);
    connectWs(relayWsUrl);
  }

  function waitForConfig() {
    if (!window.FRONTEND_CONFIG) {
      setTimeout(waitForConfig, 100);
      return;
    }
    start();
  }

  if (!key) {
    log("Missing or invalid ?src= in URL");
    return;
  }

  waitForConfig();
})();
