(function () {
  const qs = (id) => document.getElementById(id);

  const appRoot = qs("app");

  const player = qs("player");
  const videoStatus = qs("videoStatus");
  const subtitleStatus = qs("subtitleStatus");
  const captionEl = qs("caption");
  const logEl = qs("log");
  const noSignalMessage = qs("noSignalMessage");

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

  async function registerKey(registerUrl, key) {
    const res = await fetch(`${registerUrl}?src=${encodeURIComponent(key)}`, {
      method: "POST",
    });
    // 200: session created; 409: already exists (another viewer). Both mean
    // "OK to subscribe"; anything else is fatal for this page load.
    if (res.status === 200 || res.status === 409) return res.status;
    throw new Error(`HTTP ${res.status}`);
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
      console.log("[frontend] No ?src= in URL; showing login view.");
      window.LiveCaptionUI.showLogin(document.body, {
        onSubmit: (k) => {
          // Navigate with the chosen key; the page reloads into the src branch.
          window.location.search = "?src=" + encodeURIComponent(k);
        },
      });
      return;
    }

    const registerUrl = deriveRegisterUrl(relayWsUrlBase);
    const streamUrl = `${streamUrlBase}/${key}/llhls.m3u8`;
    const relayWsUrl = `${relayWsUrlBase}/${key}`;
    console.log("[frontend] Source key:", key);
    console.log("[frontend] Register URL:", registerUrl);
    console.log("[frontend] Final stream URL:", streamUrl);
    console.log("[frontend] Final relay WS URL:", relayWsUrl);

    registerKey(registerUrl, key)
      .then((status) => {
        console.log(`[frontend] /register responded ${status}; starting app.`);
        startApp(streamUrl, relayWsUrl);
      })
      .catch((err) => {
        console.error("[frontend] register failed:", err);
        window.LiveCaptionUI.showFatal(
          document.body,
          `無法註冊 session (src=${key}): ${err.message}`
        );
      });
  }

  function startApp(streamUrl, relayWsUrl) {
    let ws = null;
    let wsBackoff = 1000;
    let idleTimer = null;
    let lastWsMessage = null;
    let liveCatchupTimer = null;
    let streamRetryTimer = null;
    let streamNoSignalTimer = null;
    let activeHls = null;
    // Subtitle rendering state (driven by ASR backend connection state).
    let asrState = "disconnected"; // "connected" | "connecting" | "disconnected" | "error"
    let captionItems = [];

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
    if (player) player.style.display = hasSignal ? "block" : "none";
    if (noSignalMessage) noSignalMessage.style.display = hasSignal ? "none" : "flex";
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

  function scheduleStreamReload(reason, delayMs = 10000) {
    if (streamRetryTimer) {
      appendLog(`Reload already scheduled; skip duplicate (${reason})`);
      return;
    }
    appendLog(`Scheduling stream reload in ${delayMs}ms (${reason})`);
    streamRetryTimer = setTimeout(() => {
      streamRetryTimer = null;
      loadStream();
    }, delayMs);
  }

  function normalizeCaptionLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines.map((line) => {
      if (typeof line === "string") {
        return { original: line, translation: "" };
      }
      if (!line || typeof line !== "object") {
        return { original: "", translation: "" };
      }
      return {
        original: String(line.text ?? ""),
        translation: String(line.translation ?? ""),
      };
    });
  }

  function setCaption(lines) {
    if (!captionEl) return;
    // Never show captions while ASR is not connected.
    if (asrState !== "connected") return;

    // 檢查是否已經滾動到底部（或接近底部，允許 5px 的誤差）
    const isAtBottom = captionEl.scrollHeight - captionEl.scrollTop - captionEl.clientHeight <= 5;

    captionItems = normalizeCaptionLines(lines);
    renderCaptionState();

    // 如果之前在底部，則自動滾動到新的底部
    if (isAtBottom) {
      captionEl.scrollTop = captionEl.scrollHeight;
    }
  }

  function renderCaptionState() {
    if (!captionEl) return;

    if (asrState !== "connected") {
      captionEl.textContent = "";
      return;
    }

    captionEl.textContent = "";
    const fragment = document.createDocumentFragment();
    captionItems.forEach((item) => {
      const itemEl = document.createElement("div");
      itemEl.className = "caption-item";

      const originalEl = document.createElement("div");
      originalEl.className = "caption-original";
      originalEl.textContent = item.original || "";

      const translationEl = document.createElement("div");
      translationEl.className = "caption-translation";
      translationEl.textContent = item.translation || "";

      itemEl.appendChild(originalEl);
      itemEl.appendChild(translationEl);
      fragment.appendChild(itemEl);
    });
    captionEl.appendChild(fragment);
  }

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
    stopWs();
    const url = relayWsUrl;
    appendLog(`Connecting subtitles WS: ${url}`);
    setSubtitleStatus("connecting...");
    lastWsMessage = null;
    scheduleIdleNotice();

    try {
      ws = new WebSocket(url);
    } catch (err) {
      appendLog(`Failed to open WebSocket: ${err}`);
      setSubtitleStatus("connection error");
      return;
    }

    ws.onopen = () => {
      wsBackoff = 1000;
      appendLog("Subtitle WS connected");
      setSubtitleStatus("connected");
      scheduleIdleNotice();
    };

    ws.onclose = (evt) => {
      appendLog(`Subtitle WS closed (code=${evt.code}, reason=${evt.reason || "none"})`);
      setSubtitleStatus("disconnected");
      // Without relay connection, treat ASR as disconnected from the UI's perspective.
      asrState = "disconnected";
      captionItems = [];
      renderCaptionState();
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
        if (asrState !== "connected") {
          // Reset caption state when ASR is not connected.
          captionItems = [];
        }
        renderCaptionState();
        return;
      }

      if (payload.type === "caption") {
        const isPartial = payload.partial || false;
        const lines = Array.isArray(payload.lines) ? payload.lines : [];
        setSubtitleStatus(isPartial ? "receiving (partial)" : "receiving");
        if (lines.length === 0) {
          appendLog("Caption dropped: missing lines[] payload");
          return;
        }
        appendLog(
          `Caption${isPartial ? " (partial)" : ""}: received ${lines.length} lines`
        );
        setCaption(lines);
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

  function loadStream() {
    const url = streamUrl;
    clearStreamRetry();
    clearStreamNoSignalTimeout();
    destroyActiveHls();
    appendLog(`Loading stream: ${url}`);
    setVideoStatus("loading...");

    // 先測試 URL 是否可以訪問
    fetch(url, {
      method: 'HEAD',
      mode: 'cors',  // 明確指定 CORS 模式
      credentials: 'omit'  // 不發送憑證
    })
      .then(response => {
        appendLog(`HLS URL accessible: ${response.status}, headers: ${response.headers.get('access-control-allow-origin')}`);
        // 只有在測試成功時才載入 HLS
        loadHlsStream(url);
      })
      .catch(error => {
        appendLog(`HLS URL fetch error: ${error.message}, type: ${error.name}`);
        console.error('Fetch error details:', error);
        setVideoStatus("no signal");
        scheduleStreamReload("HEAD fetch failed");
      });
  }

  function loadHlsStream(url) {
    const isHlsUrl = url.endsWith(".m3u8");
    const useHlsJs = window.Hls && window.Hls.isSupported() && isHlsUrl;
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer);
      liveCatchupTimer = null;
    }

    if (useHlsJs) {
      const hls = new window.Hls({
        lowLatencyMode: true,
        liveSyncDuration: 0.5, // time difference between live edge and player current time
        liveMaxLatencyDuration: 2, // maximum tolerance for live edge
        maxLiveSyncPlaybackRate: 1,
        liveDurationInfinity: true,
        maxBufferLength: 3,
        maxMaxBufferLength: 6,
        highBufferWatchdogPeriod: 1,
        maxBufferHole: 0.3,
        maxFragLookUpTolerance: 0.1,
        backBufferLength: 0,
        maxRetries: 6,
        startLevel: -1,
        enableWorker: true,
        debug: true,
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
      };

      const maybeCatchUp = (source) => {
        if (player.seeking) return;
        const liveSyncPosition = hls.liveSyncPosition;
        if (!Number.isFinite(liveSyncPosition)) return;
        const delta = liveSyncPosition - player.currentTime;
        if (delta > 5 && Date.now() - lastCatchUpAt > 4000) {
          appendLog(`Live sync jump (${source}): behind ${delta.toFixed(1)}s`);
          player.currentTime = liveSyncPosition;
          lastCatchUpAt = Date.now();
        }
      };

      hls.on(window.Hls.Events.ERROR, (_, data) => {
        appendLog(`HLS error: ${data?.details || "unknown"}, type: ${data?.type}, fatal: ${data?.fatal}`);
        console.error("HLS Error:", data); // 在控制台顯示詳細錯誤
        if (data?.fatal) {
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
        maybeCatchUp("frag");
        if (player.readyState >= 2) {
          markStreamPlayable("fragment buffered");
        }
      });

      // 直播同步事件 - 確保播放最新內容
      hls.on(window.Hls.Events.LIVE_BACK_BUFFER_REACHED, () => {
        appendLog("Live sync: reached back buffer");
      });

      hls.on(window.Hls.Events.LIVE_SYNCING, () => {
        appendLog("Live sync: syncing to live edge");
        maybeCatchUp("sync");
      });

      // 如果超過 30 秒還沒有載入成功，認為沒有訊號
      streamNoSignalTimer = setTimeout(() => {
        if (!hasManifestParsed && !hasFragLoaded) {
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

      // 對於直播，設置靜音以增加自動播放成功率
      player.muted = true;

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
    player.muted = true; // 設置靜音以增加自動播放成功率
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer);
      liveCatchupTimer = null;
    }
    player.onloadeddata = () => setVideoStatus("playing");
    player.onerror = () => {
      appendLog("Video error while loading source");
      setVideoStatus("no signal");
      scheduleStreamReload("native player error");
    };

    if (isHlsUrl) {
      const maybeCatchUpNative = () => {
        if (player.seeking) return;
        if (!player.seekable || player.seekable.length === 0) return;
        const liveEdge = player.seekable.end(player.seekable.length - 1);
        const delta = liveEdge - player.currentTime;
        if (delta > 5) {
          appendLog(`Live sync jump (native): behind ${delta.toFixed(1)}s`);
          player.currentTime = Math.max(0, liveEdge - 0.5);
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

    // Auto start; reconnections are automatic inside loaders/handlers.
    loadStream();

    // Delay initial relay_service WebSocket connection after page load/refresh.
    // (Reconnections from ws.onclose keep using their own backoff timing.)
    const initialWsConnectDelayMs = 2000;
    appendLog(`Delaying subtitles WS connect for ${initialWsConnectDelayMs}ms...`);
    setTimeout(() => connectWs(), initialWsConnectDelayMs);
  }

  // 開始等待配置載入
  waitForConfig();
})();
