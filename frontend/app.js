(function () {
  const qs = (id) => document.getElementById(id);

  const appRoot = qs("app");

  const player = qs("player");
  const videoStatus = qs("videoStatus");
  const subtitleStatus = qs("subtitleStatus");
  const captionEl = qs("caption");
  const logEl = qs("log");
  const noSignalMessage = qs("noSignalMessage");
  const liveBadge = qs("liveBadge");
  const noteArea = qs("noteArea");
  const muteToggleButton = qs("muteToggleButton");
  const subtitleFontSizeControl = qs("subtitleFontSize");
  let sessionExpired = false;
  let videoMuted = true;

  // Mirrors relay_service/resource_manage.py:KEY_RE.
  const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function getSrcFromURL() {
    const raw = new URLSearchParams(window.location.search).get("src");
    return raw && KEY_RE.test(raw) ? raw : null;
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

  async function registerKey(registerUrl, key) {
    const res = await fetch(`${registerUrl}?src=${encodeURIComponent(key)}`, {
      method: "POST",
      credentials: "same-origin",
    });
    // 200: session created; 409: already exists (another viewer). Both mean
    // "OK to subscribe"; anything else is fatal for this page load.
    if (res.status === 200 || res.status === 409) return res.status;
    if (res.status === 401) {
      throw new Error("SESSION_EXPIRED");
    }
    if (res.status === 429) {
      throw new Error("RATE_LIMIT");
    }
    throw new Error(`HTTP ${res.status}`);
  }

  async function fetchRecentSubtitles(recentSubtitlesUrl) {
    const res = await fetch(recentSubtitlesUrl, {
      method: "GET",
      credentials: "same-origin",
    });
    if (res.status === 401) {
      throw new Error("SESSION_EXPIRED");
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function showSessionExpired() {
    if (sessionExpired) return;
    sessionExpired = true;
    if (window.LiveCaptionUI && typeof window.LiveCaptionUI.showSessionExpired === "function") {
      window.LiveCaptionUI.showSessionExpired(document.body);
    } else {
      window.location.href = "/login";
    }
  }

  function isSessionExpiredError(err) {
    return err && String(err.message || err) === "SESSION_EXPIRED";
  }

  function setupNotes(key) {
    if (!noteArea) return;
    const storageKey = `livecaption:notes:${key}`;
    try {
      noteArea.value = window.localStorage.getItem(storageKey) || "";
    } catch (err) {
      console.warn("[frontend] Failed to load notes:", err);
    }

    noteArea.addEventListener("input", () => {
      try {
        window.localStorage.setItem(storageKey, noteArea.value);
      } catch (err) {
        console.warn("[frontend] Failed to save notes:", err);
      }
    });
  }

  function setupSubtitleFontSize() {
    if (!captionEl || !subtitleFontSizeControl) return;
    const storageKey = "livecaption:subtitle-font-size";
    const min = Number(subtitleFontSizeControl.min) || 16;
    const max = Number(subtitleFontSizeControl.max) || 32;

    function clampFontSize(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 20;
      return Math.min(max, Math.max(min, parsed));
    }

    function applyFontSize(value) {
      const size = clampFontSize(value);
      captionEl.style.fontSize = `${size}px`;
      subtitleFontSizeControl.value = String(size);
      return size;
    }

    try {
      applyFontSize(window.localStorage.getItem(storageKey) || subtitleFontSizeControl.value);
    } catch (err) {
      console.warn("[frontend] Failed to load subtitle font size:", err);
      applyFontSize(subtitleFontSizeControl.value);
    }

    subtitleFontSizeControl.addEventListener("input", () => {
      const size = applyFontSize(subtitleFontSizeControl.value);
      try {
        window.localStorage.setItem(storageKey, String(size));
      } catch (err) {
        console.warn("[frontend] Failed to save subtitle font size:", err);
      }
    });
  }

  function applyVideoMuteState() {
    if (player) player.muted = videoMuted;
    if (!muteToggleButton) return;
    muteToggleButton.setAttribute("aria-pressed", videoMuted ? "true" : "false");
    muteToggleButton.setAttribute(
      "aria-label",
      videoMuted ? "目前靜音，點擊切換為非靜音" : "目前非靜音，點擊切換為靜音"
    );
  }

  function setupVideoControls() {
    if (!player) return;
    player.controls = false;
    player.disablePictureInPicture = true;
    player.controlsList = "nodownload nofullscreen noremoteplayback";
    player.tabIndex = -1;
    player.addEventListener("contextmenu", (evt) => evt.preventDefault());

    if (muteToggleButton) {
      muteToggleButton.addEventListener("click", () => {
        videoMuted = !videoMuted;
        applyVideoMuteState();
      });
    }
    applyVideoMuteState();
  }

  // 等待配置載入
  function waitForConfig() {
    if (!window.FRONTEND_CONFIG) {
      console.log("[frontend] Waiting for config...");
      setTimeout(waitForConfig, 100);
      return;
    }
    const cfg = window.FRONTEND_CONFIG;
    const defaultHost = cfg.host || window.location.hostname || "localhost";
    const streamUrlBase = (cfg.streamUrl || `rtmp://${defaultHost}/live`).replace(/\/+$/, "");
    const relayWsUrlBase = (cfg.relayWsUrl || `ws://${defaultHost}:9000/subtitles`).replace(/\/+$/, "");
    console.log("[frontend] Config loaded:", cfg);
    console.log("[frontend] Stream URL base:", streamUrlBase);
    console.log("[frontend] Relay WS URL base:", relayWsUrlBase);

    const key = getSrcFromURL();
    if (!key) {
      console.log("[frontend] No ?src= in URL; redirecting to /login.");
      window.location.replace("/login");
      return;
    }

    const registerUrl = deriveRegisterUrl(relayWsUrlBase);
    // abr.m3u8: OME ABR playlist (source + 360p rendition); the player
    // switches renditions based on its own measured throughput.
    const streamUrl = `${streamUrlBase}/${key}/abr.m3u8`;
    const relayWsUrl = `${relayWsUrlBase}/${key}`;
    const recentSubtitlesUrl = deriveRecentSubtitlesUrl(relayWsUrl);
    console.log("[frontend] Source key:", key);
    console.log("[frontend] Register URL:", registerUrl);
    console.log("[frontend] Final stream URL:", streamUrl);
    console.log("[frontend] Final relay WS URL:", relayWsUrl);
    console.log("[frontend] Recent subtitles URL:", recentSubtitlesUrl);

    startApp(streamUrl, relayWsUrl, recentSubtitlesUrl, registerUrl, key);
  }

  function startApp(streamUrl, relayWsUrl, recentSubtitlesUrl, registerUrl, key) {
    setupNotes(key);
    setupSubtitleFontSize();
    setupVideoControls();

    let ws = null;
    let wsBackoff = 1000;
    let idleTimer = null;
    let lastWsMessage = null;
    let liveCatchupTimer = null;
    let streamRetryTimer = null;
    let streamNoSignalTimer = null;
    let activeHls = null;
    let registerInFlight = false;
    let registerDone = false;
    // Subtitle rendering state (driven by ASR backend connection state).
    let asrState = "disconnected"; // "connected" | "connecting" | "disconnected" | "error"
    let captionItems = [];
    let subtitleMode = "both";
    const subtitleModeButtons = document.querySelectorAll("[data-subtitle-mode]");

    function appendLog(message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    console.log(`[frontend] ${line}`);
    if (!logEl) return;
    const div = document.createElement("div");
    div.textContent = line;
    logEl.prepend(div);
    const max = 80;
    while (logEl.childElementCount > max) {
      logEl.removeChild(logEl.lastChild);
    }
  }

    function setSubtitleStatus(text) {
      if (subtitleStatus) subtitleStatus.textContent = text;
    }

    function setVideoStatus(text) {
    if (videoStatus) videoStatus.textContent = text;

    // 根據狀態顯示/隱藏影片和訊息
    const hasSignal = text === "playing" || text === "loading...";
    const isLive = text === "playing";
    if (player) player.style.display = hasSignal ? "block" : "none";
    if (noSignalMessage) noSignalMessage.style.display = hasSignal ? "none" : "flex";
    if (liveBadge) liveBadge.classList.toggle("live-badge--active", isLive);
  }

  function clearStreamRetry() {
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
  }

  function clearStreamNoSignalTimeout() {
    if (streamNoSignalTimer) {
      clearTimeout(streamNoSignalTimer);
      streamNoSignalTimer = null;
    }
  }

  function destroyActiveHls() {
    if (!activeHls) return;
    try {
      activeHls.destroy();
    } catch {
      // ignore cleanup errors
    }
    activeHls = null;
  }

  // While offline, quietly poll the LL-HLS playlist without touching the
  // player or UI (the old timed reload loop re-ran the whole load path every
  // 10s, flashing between "loading" and "no signal" each cycle). The player
  // is only (re)created on the offline→live transition.
  const STREAM_POLL_MS = 5000;

  async function probeStreamStatus() {
    try {
      const res = await fetch(streamUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      return res.status;
    } catch {
      return 0; // network error: treat as offline, keep polling
    }
  }

  function scheduleStreamReload(reason, delayMs = STREAM_POLL_MS) {
    if (sessionExpired) return;
    if (streamRetryTimer) {
      appendLog(`Stream watch already active; skip duplicate (${reason})`);
      return;
    }
    appendLog(`Waiting for stream (${reason}); polling every ${STREAM_POLL_MS / 1000}s`);
    const poll = async () => {
      streamRetryTimer = null;
      if (sessionExpired) return;
      const status = await probeStreamStatus();
      if (status === 401) {
        appendLog("Stream probe: session expired");
        showSessionExpired();
        return;
      }
      if (status === 200) {
        appendLog("Stream is live; starting player");
        loadStream();
        return;
      }
      streamRetryTimer = setTimeout(poll, STREAM_POLL_MS);
    };
    streamRetryTimer = setTimeout(poll, delayMs);
  }

  function handleStreamLost(reason) {
    appendLog(`Stream lost: ${reason}; resetting registration/subtitles`);
    registerDone = false;
    registerInFlight = false;
    stopWs();
    setSubtitleStatus("waiting stream signal...");
    asrState = "disconnected";
  }

  function normalizeCaptionLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines.map((line) => {
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
    });
  }

  function setCaption(lines, options = {}) {
    if (!captionEl) return;
    // Never show captions while ASR is not connected.
    if (!options.force && asrState !== "connected") return;

    // 檢查是否已經滾動到底部（或接近底部，允許 5px 的誤差）
    const isAtBottom = captionEl.scrollHeight - captionEl.scrollTop - captionEl.clientHeight <= 5;

    applyCaptionUpdates(normalizeCaptionLines(lines));

    // 如果之前在底部，則自動滾動到新的底部
    if (isAtBottom) {
      captionEl.scrollTop = captionEl.scrollHeight;
    }
  }

  function handleCaptionPayload(payload, options = {}) {
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const hasUpdating = lines.some((line) => line && line.status === "updating");
    if (options.updateStatus !== false) {
      setSubtitleStatus(hasUpdating ? "receiving (updating)" : "receiving");
    }
    if (lines.length === 0) {
      if (options.logCaption !== false) appendLog("Caption dropped: missing lines[] payload");
      return false;
    }
    if (options.logCaption !== false) {
      appendLog(`Caption${hasUpdating ? " (updating)" : ""}: received ${lines.length} lines`);
    }
    setCaption(lines, { force: options.force === true });
    return true;
  }

  function updateCaptionItemElement(itemEl, item) {
    itemEl.textContent = "";
    itemEl.dataset.captionStatus = item.status;

    const originalEl = document.createElement("div");
    originalEl.className = "caption-original";
    originalEl.textContent = item.original || "";

    const translationEl = document.createElement("div");
    translationEl.className = "caption-translation";
    translationEl.textContent = item.translation || "";

    if (subtitleMode === "both" || subtitleMode === "zh") {
      itemEl.appendChild(originalEl);
    }
    if (subtitleMode === "both" || subtitleMode === "en") {
      itemEl.appendChild(translationEl);
    }
  }

  function createCaptionItemElement(item) {
    const itemEl = document.createElement("div");
    itemEl.className = "caption-item";
    updateCaptionItemElement(itemEl, item);
    return itemEl;
  }

  let currentUpdatingItem = null;
  let currentUpdatingEl = null;
  const segmentElementsByKey = new Map();

  // Mirrors relay_service/asr_link.py:segment_key — timestamps have 1-second
  // resolution, so the original text is part of the identity to keep two
  // short sentences starting in the same second apart.
  function captionSegmentKey(item) {
    return JSON.stringify([item.start ?? null, item.end ?? null, item.original ?? ""]);
  }

  function clearCurrentUpdating() {
    if (currentUpdatingEl) {
      currentUpdatingEl.remove();
    }
    currentUpdatingItem = null;
    currentUpdatingEl = null;
  }

  function applyCaptionUpdates(items) {
    if (!captionEl) return;
    clearCurrentUpdating();

    items.forEach((item) => {
      if (!item.original && !item.translation) return;
      if (item.status === "updating") {
        currentUpdatingItem = item;
        currentUpdatingEl = createCaptionItemElement(item);
        captionEl.appendChild(currentUpdatingEl);
        return;
      }
      if (item.status === "segment_update") {
        const segKey = captionSegmentKey(item);
        const existingEl = segmentElementsByKey.get(segKey);
        const existingItem = captionItems.find((candidate) => captionSegmentKey(candidate) === segKey);
        if (existingEl && existingItem) {
          Object.assign(existingItem, item, { status: "segment" });
          updateCaptionItemElement(existingEl, existingItem);
          return;
        }
        item.status = "segment";
      }
      item.status = "segment";
      captionItems.push(item);
      const itemEl = createCaptionItemElement(item);
      segmentElementsByKey.set(captionSegmentKey(item), itemEl);
      captionEl.appendChild(itemEl);
    });
  }

  function renderCaptionState() {
    if (!captionEl) return;
    captionEl.textContent = "";
    segmentElementsByKey.clear();
    const fragment = document.createDocumentFragment();
    captionItems.forEach((item) => {
      const itemEl = createCaptionItemElement(item);
      segmentElementsByKey.set(captionSegmentKey(item), itemEl);
      fragment.appendChild(itemEl);
    });
    if (currentUpdatingItem) {
      currentUpdatingEl = createCaptionItemElement(currentUpdatingItem);
      fragment.appendChild(currentUpdatingEl);
    }
    captionEl.appendChild(fragment);
  }

  subtitleModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.subtitleMode;
      if (!["both", "zh", "en"].includes(nextMode)) return;
      subtitleMode = nextMode;
      subtitleModeButtons.forEach((item) => {
        item.setAttribute("aria-pressed", item.dataset.subtitleMode === subtitleMode ? "true" : "false");
      });
      renderCaptionState();
    });
  });

  function scheduleIdleNotice() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const waited = lastWsMessage
        ? ((Date.now() - lastWsMessage) / 1000).toFixed(1)
        : "no messages yet";
      appendLog(`No subtitles/status received (${waited}); waiting for signal.`);
      scheduleIdleNotice();
    }, 8000);
  }

  function stopWs() {
    clearTimeout(idleTimer);
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  }

  function connectWs() {
    if (sessionExpired) return;
    if (!registerDone) {
      appendLog("Skip subtitles WS connect before register completes");
      setSubtitleStatus("waiting register...");
      return;
    }
    stopWs();
    const url = relayWsUrl;
    appendLog(`Connecting subtitles WS: ${url}`);
    setSubtitleStatus("connecting...");
    lastWsMessage = null;
    scheduleIdleNotice();

    let opened = false;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      appendLog(`Failed to open WebSocket: ${err}`);
      setSubtitleStatus("connection error");
      return;
    }

    ws.onopen = () => {
      opened = true;
      wsBackoff = 1000;
      appendLog("Subtitle WS connected");
      setSubtitleStatus("connected");
      scheduleIdleNotice();
    };

    ws.onclose = (evt) => {
      appendLog(`Subtitle WS closed (code=${evt.code}, reason=${evt.reason || "none"})`);
      if (!opened && evt.code === 1006) {
        appendLog("Subtitle WS auth failed or session expired");
        showSessionExpired();
        return;
      }
      setSubtitleStatus("disconnected");
      // Without relay connection, treat ASR as disconnected from the UI's perspective.
      asrState = "disconnected";
      scheduleIdleNotice();
      const delay = Math.min(wsBackoff, 15000);
      wsBackoff = Math.min(wsBackoff * 2, 15000);
      setTimeout(connectWs, delay);
    };

    ws.onerror = (err) => {
      appendLog(`Subtitle WS error: ${err?.message || err}`);
      setSubtitleStatus("error");
    };

    ws.onmessage = (event) => {
      lastWsMessage = Date.now();
      scheduleIdleNotice();

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        appendLog("Dropped non-JSON message");
        return;
      }

      // ASR backend connection status (from relay_service).
      if (payload.type === "asr_status") {
        const next = (payload.state || "disconnected").toString();
        const detail = (payload.detail || "").toString();
        appendLog(`ASR status: ${next}${detail ? ` (${detail})` : ""}`);
        asrState = next;
        setSubtitleStatus(`asr:${next}`);
        return;
      }

      if (payload.type === "caption") {
        handleCaptionPayload(payload);
        return;
      }

      if (payload.type === "status") {
        const detail = payload.detail || payload.state || "status update";
        appendLog(`Status: ${detail}`);
        setSubtitleStatus(payload.state || "status");
        return;
      }

      appendLog("Unknown message type; ignored");
    };
  }

  async function loadRecentSubtitles() {
    appendLog(`Loading recent subtitles: ${recentSubtitlesUrl}`);
    setSubtitleStatus("loading recent subtitles...");
    try {
      const payload = await fetchRecentSubtitles(recentSubtitlesUrl);
      const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
      let applied = 0;
      subtitles.forEach((item) => {
        if (!item || item.type !== "caption") return;
        if (
          handleCaptionPayload(item, {
            force: true,
            logCaption: false,
            updateStatus: false,
          })
        ) {
          applied += 1;
        }
      });
      appendLog(
        `Loaded recent subtitles: ${applied}/${subtitles.length} caption messages applied`
      );
      setSubtitleStatus("recent subtitles loaded");
    } catch (err) {
      if (isSessionExpiredError(err)) {
        appendLog("recent subtitles failed: session expired");
        showSessionExpired();
        return;
      }
      appendLog(`recent subtitles failed: ${err?.message || err}`);
      setSubtitleStatus("recent subtitles unavailable");
    }
  }

  async function ensureRegistered(source) {
    if (sessionExpired) return;
    if (registerDone || registerInFlight) return;
    registerInFlight = true;
    appendLog(`Registering relay session after stream playable (${source})`);
    setSubtitleStatus("registering...");
    try {
      const status = await registerKey(registerUrl, key);
      registerDone = true;
      appendLog(`register success: HTTP ${status}`);
      setSubtitleStatus("registered");
      connectWs();
    } catch (err) {
      if (isSessionExpiredError(err)) {
        appendLog("register failed: session expired");
        showSessionExpired();
        return;
      }
      if (err && String(err.message) === "RATE_LIMIT") {
        appendLog("register failed: rate limited");
        setSubtitleStatus("register rate limited; please try again later");
        if (window.LiveCaptionUI && typeof window.LiveCaptionUI.showRateLimitDialog === "function") {
          window.LiveCaptionUI.showRateLimitDialog(document.body, "請求頻率過高，請稍後再試。" );
        }
        return;
      }
      appendLog(`register failed (${source}): ${err?.message || err}`);
      setSubtitleStatus("register failed; waiting stream retry");
    } finally {
      registerInFlight = false;
    }
  }

  function onStreamPlayable(source) {
    ensureRegistered(source);
  }

  function loadStream() {
    if (sessionExpired) return;
    const url = streamUrl;
    clearStreamRetry();
    clearStreamNoSignalTimeout();
    destroyActiveHls();
    appendLog(`Loading stream: ${url}`);

    // Probe first; only switch the UI into "loading" once the stream is
    // confirmed live, so an offline stream never flashes the player.
    probeStreamStatus()
      .then(status => {
        if (status === 401) {
          throw new Error("SESSION_EXPIRED");
        }
        if (status !== 200) {
          throw new Error(status === 0 ? "network error" : `HTTP ${status}`);
        }
        setVideoStatus("loading...");
        loadHlsStream(url);
      })
      .catch(error => {
        if (isSessionExpiredError(error)) {
          appendLog("HLS auth failed: session expired");
          showSessionExpired();
          return;
        }
        appendLog(`Stream offline (${error.message}); waiting`);
        setVideoStatus("no signal");
        scheduleStreamReload("stream offline");
      });
  }

  function loadHlsStream(url) {
    const isHlsUrl = url.endsWith(".m3u8");
    const useHlsJs = window.Hls && window.Hls.isSupported() && isHlsUrl;
    // ── Latency / buffer tuning ──
    // Target latency: how far behind the live edge we aim to play. Kept as
    // low as possible for the classroom/lecture sync use case, but must leave
    // enough cushion for the network to survive brief throughput dips (WiFi
    // packet loss, congestion window collapse) without stalling.
    const LIVE_SYNC_TARGET_SECONDS = 2.5;
    // hls.js will start accelerating (1.05×) once latency exceeds this:
    const LIVE_MAX_LATENCY_SECONDS = 6;
    // Hard seek: last resort when hls.js's 1.05× catchup cannot close the
    // gap (e.g. after a long stall/rebuffer). Set well above
    // LIVE_MAX_LATENCY_SECONDS so the two mechanisms never fight each other.
    const LIVE_SEEK_THRESHOLD_SECONDS = 15;
    const LIVE_SEEK_COOLDOWN_MS = 10000;
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer);
      liveCatchupTimer = null;
    }

    if (useHlsJs) {
      const hls = new window.Hls({
        lowLatencyMode: true,
        // Stay close to the LL-HLS edge while keeping a small cushion for jitter.
        liveSyncDuration: LIVE_SYNC_TARGET_SECONDS,
        liveMaxLatencyDuration: LIVE_MAX_LATENCY_SECONDS,
        maxLiveSyncPlaybackRate: 1.02,
        liveDurationInfinity: true,
        maxBufferLength: 6,
        maxMaxBufferLength: 12,
        highBufferWatchdogPeriod: 2,
        maxBufferHole: 0.5,
        maxFragLookUpTolerance: 0.25,
        backBufferLength: 15,
        maxRetries: 6,
        startLevel: -1,
        // ABR: default up-switch needs ~1.4x headroom over the higher level's
        // bitrate; at the low rendition the tiny LL-HLS parts make bandwidth
        // estimates run low, so relax the threshold and let the slow EWMA
        // recover faster. These only affect rendition choice, not buffering.
        abrBandWidthUpFactor: 0.9,
        abrEwmaSlowLive: 5,
        enableWorker: true,
        debug: false,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      activeHls = hls;

      let hasManifestParsed = false;
      let hasFragLoaded = false;
      let isStreamPlayable = false;
      let lastCatchUpAt = 0;

      const markStreamPlayable = (source) => {
        if (isStreamPlayable) return;
        isStreamPlayable = true;
        appendLog(`Stream became playable (${source})`);
        clearStreamNoSignalTimeout();
        setVideoStatus("playing");
        onStreamPlayable(source);
      };

      const maybeRecoverLargeLatency = (source) => {
        if (player.seeking) return;
        const liveSyncPosition = hls.liveSyncPosition;
        if (!Number.isFinite(liveSyncPosition)) return;
        const delta = liveSyncPosition - player.currentTime;
        if (
          delta > LIVE_SEEK_THRESHOLD_SECONDS &&
          Date.now() - lastCatchUpAt > LIVE_SEEK_COOLDOWN_MS
        ) {
          appendLog(`Live sync recovery (${source}): behind ${delta.toFixed(1)}s`);
          player.currentTime = liveSyncPosition;
          lastCatchUpAt = Date.now();
        }
      };

      hls.on(window.Hls.Events.ERROR, (_, data) => {
        appendLog(`HLS error: ${data?.details || "unknown"}, type: ${data?.type}, fatal: ${data?.fatal}`);
        console.error("HLS Error:", data); // 在控制台顯示詳細錯誤
        const status = data?.response?.code || data?.response?.status;
        if (status === 401) {
          showSessionExpired();
          return;
        }
        if (data?.fatal) {
          handleStreamLost(`fatal HLS error: ${data?.details || "unknown"}`);
          clearStreamNoSignalTimeout();
          destroyActiveHls();
          setVideoStatus("error");
          scheduleStreamReload(`fatal HLS error: ${data?.details || "unknown"}`);
        }
      });

      hls.on(window.Hls.Events.MANIFEST_LOADING, () => {
        appendLog("HLS: Loading manifest");
      });

      hls.on(window.Hls.Events.MANIFEST_PARSED, (event, data) => {
        appendLog(`HLS: Manifest parsed, levels: ${data.levels?.length || 0}`);
        hasManifestParsed = true;
        // Manifest parsed does not guarantee media is actually playable yet.
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const lvl = hls.levels?.[data.level];
        if (lvl) {
          const est = hls.bandwidthEstimate;
          appendLog(
            `ABR: now playing ${lvl.height}p @ ${Math.round(lvl.bitrate / 1000)}kbps` +
            (Number.isFinite(est) ? ` (estimated bandwidth ${Math.round(est / 1000)}kbps)` : "")
          );
        }
      });

      // hls.on(window.Hls.Events.LEVEL_LOADING, (event, data) => {
      //   appendLog(`HLS: Loading level ${data.level}`);
      // });

      // hls.on(window.Hls.Events.FRAG_LOADING, (event, data) => {
      //   appendLog(`HLS: Loading fragment ${data.frag?.sn}`);
      // });

      hls.on(window.Hls.Events.FRAG_LOADED, (event, data) => {
        // appendLog(`HLS: Fragment loaded: ${data.frag?.sn}`);
        hasFragLoaded = true;
      });

      hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
        maybeRecoverLargeLatency("frag");
        if (player.readyState >= 2) {
          markStreamPlayable("fragment buffered");
        }
      });

      // Let hls.js stay close to the target latency; only intervene after large drift.
      hls.on(window.Hls.Events.LIVE_BACK_BUFFER_REACHED, () => {
        appendLog("Live sync: reached back buffer");
      });

      hls.on(window.Hls.Events.LIVE_SYNCING, () => {
        appendLog("Live sync: syncing toward target latency");
        maybeRecoverLargeLatency("sync");
      });

      // 如果超過 30 秒還沒有載入成功，認為沒有訊號
      streamNoSignalTimer = setTimeout(() => {
        if (!hasManifestParsed && !hasFragLoaded) {
          handleStreamLost("no signal timeout");
          appendLog("No stream signal detected after timeout (30s)");
          setVideoStatus("no signal");
          destroyActiveHls();
          scheduleStreamReload("no signal timeout");
        }
        streamNoSignalTimer = null;
      }, 30000);

      hls.loadSource(url);
      hls.attachMedia(player);
      player.addEventListener("canplay", () => markStreamPlayable("video canplay"), { once: true });
      player.addEventListener("playing", () => markStreamPlayable("video playing"), { once: true });

      let lastLoggedRate = 1;
      player.addEventListener("ratechange", () => {
        const r = player.playbackRate;
        if (r !== lastLoggedRate) {
          appendLog(`Catchup: playback rate ${lastLoggedRate}x → ${r}x`);
          lastLoggedRate = r;
        }
      });

      applyVideoMuteState();

      // 嘗試自動播放
      const tryPlay = () => {
        player.play().catch((err) => {
          appendLog(`Auto-play failed: ${err.message}, retrying...`);
          // 對於直播，重試播放而不是顯示用戶互動提示
          setTimeout(tryPlay, 1000);
        });
      };

      tryPlay();

      return;
    }

    // Native playback (e.g., MP4 progressive, WebRTC blob URL, etc.)
    player.src = url;
    applyVideoMuteState();
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer);
      liveCatchupTimer = null;
    }
    player.onloadeddata = () => {
      setVideoStatus("playing");
      onStreamPlayable("native loadeddata");
    };
    player.onerror = () => {
      handleStreamLost("native player error");
      appendLog("Video error while loading source");
      setVideoStatus("no signal");
      scheduleStreamReload("native player error");
    };

    if (isHlsUrl) {
      const maybeCatchUpNative = () => {
        if (player.seeking) return;
        if (!player.seekable || player.seekable.length === 0) return;
        const liveEdge = player.seekable.end(player.seekable.length - 1);
        const targetPosition = Math.max(0, liveEdge - LIVE_SYNC_TARGET_SECONDS);
        const delta = targetPosition - player.currentTime;
        if (delta > LIVE_SEEK_THRESHOLD_SECONDS) {
          appendLog(`Live sync recovery (native): behind ${delta.toFixed(1)}s`);
          player.currentTime = targetPosition;
        }
      };
      player.addEventListener("loadedmetadata", maybeCatchUpNative, { once: true });
      liveCatchupTimer = setInterval(maybeCatchUpNative, 5000);
    }

    // 對於原生播放也嘗試自動播放
    const tryNativePlay = () => {
      player.play().catch((err) => {
        appendLog(`Native auto-play failed: ${err.message}, retrying...`);
        setTimeout(tryNativePlay, 1000);
      });
    };

    tryNativePlay();
  }

    appendLog("Waiting for playable stream signal before register/subtitles connect");
    setSubtitleStatus("waiting stream signal...");

    loadRecentSubtitles();

    // Auto start; reconnections are automatic inside loaders/handlers.
    loadStream();
  }

  // 開始等待配置載入
  waitForConfig();
})();
