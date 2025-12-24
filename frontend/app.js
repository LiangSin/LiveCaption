(function () {
  const qs = (id) => document.getElementById(id);

  const player = qs("player");
  const videoStatus = qs("videoStatus");
  const subtitleStatus = qs("subtitleStatus");
  const captionEl = qs("caption");
  const logEl = qs("log");
  const noSignalMessage = qs("noSignalMessage");

  // 等待配置載入
  function waitForConfig() {
    if (window.FRONTEND_CONFIG) {
      const cfg = window.FRONTEND_CONFIG;
      const defaultHost = cfg.host || window.location.hostname || "localhost";
      const streamUrl = cfg.streamUrl || `rtmp://${defaultHost}/live`;
      const relayWsUrl = cfg.relayWsUrl || `ws://${defaultHost}:9000/subtitles`;

      console.log("[frontend] Config loaded:", cfg);
      console.log("[frontend] Stream URL:", streamUrl);
      console.log("[frontend] Relay WS URL:", relayWsUrl);
      startApp(streamUrl, relayWsUrl);
    } else {
      console.log("[frontend] Waiting for config...");
      setTimeout(waitForConfig, 100);
    }
  }

  function startApp(streamUrl, relayWsUrl) {
    let ws = null;
    let wsBackoff = 1000;
    let idleTimer = null;
    let lastWsMessage = null;

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

      // 根據狀態更新字幕顯示
      const hasSignal = text === "receiving" || text === "receiving (partial)" || text === "connected";
      if (captionEl) {
        if (hasSignal) {
          // 有訊號時顯示正常字幕（如果沒有字幕就顯示等待）
          if (captionEl.textContent === "沒有訊號") {
            captionEl.textContent = "Waiting for subtitles…";
          }
        } else {
          // 沒有訊號時顯示"沒有訊號"
          captionEl.textContent = "沒有訊號";
        }
      }
    }

    function setVideoStatus(text) {
    if (videoStatus) videoStatus.textContent = text;

    // 根據狀態顯示/隱藏影片和訊息
    const hasSignal = text === "playing" || text === "loading...";
    if (player) player.style.display = hasSignal ? "block" : "none";
    if (noSignalMessage) noSignalMessage.style.display = hasSignal ? "none" : "flex";
  }

  function setCaption(text) {
    if (captionEl) captionEl.textContent = text || "—";
  }

  function scheduleIdleNotice() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const waited = lastWsMessage
        ? ((Date.now() - lastWsMessage) / 1000).toFixed(1)
        : "no messages yet";
      appendLog(`No subtitles/status received (${waited}); waiting for signal.`);
      setSubtitleStatus("waiting for signal");
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

      if (payload.type === "caption") {
        const text = payload.text || "";
        appendLog(`Caption${payload.partial ? " (partial)" : ""}: ${text}`);
        setSubtitleStatus(payload.partial ? "receiving (partial)" : "receiving");
        setCaption(text);
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
        // 增加重試間隔到 10 秒，避免瘋狂刷新
        setTimeout(loadStream, 10000);
      });
  }

  function loadHlsStream(url) {
    const useHlsJs = window.Hls && window.Hls.isSupported() && url.endsWith(".m3u8");

    if (useHlsJs) {
      const hls = new window.Hls({
        // 放寬直播配置以增加相容性
        liveSyncDuration: 10, // 與直播邊緣保持10秒同步（放寬）
        liveMaxLatencyDuration: 30, // 最大延遲30秒（放寬）
        liveDurationInfinity: true,
        maxBufferLength: 30, // 最大緩衝30秒（放寬）
        maxMaxBufferLength: 60,
        backBufferLength: 30, // 後緩衝30秒（放寬）
        maxRetries: 6, // 增加重試次數
        startLevel: -1,
        enableWorker: true,
        // 調試選項
        debug: true,
      });

      let hasManifestParsed = false;
      let hasFragLoaded = false;

      hls.on(window.Hls.Events.ERROR, (_, data) => {
        appendLog(`HLS error: ${data?.details || "unknown"}, type: ${data?.type}, fatal: ${data?.fatal}`);
        console.error("HLS Error:", data); // 在控制台顯示詳細錯誤
        if (data?.fatal) {
          hls.destroy();
          setVideoStatus("error");
          // 增加重試間隔到 10 秒，避免瘋狂刷新
          setTimeout(loadStream, 10000);
        }
      });

      hls.on(window.Hls.Events.MANIFEST_LOADING, () => {
        appendLog("HLS: Loading manifest");
      });

      hls.on(window.Hls.Events.MANIFEST_PARSED, (event, data) => {
        appendLog(`HLS: Manifest parsed, levels: ${data.levels?.length || 0}`);
        hasManifestParsed = true;
        setVideoStatus("playing");
      });

      hls.on(window.Hls.Events.LEVEL_LOADING, (event, data) => {
        appendLog(`HLS: Loading level ${data.level}`);
      });

      hls.on(window.Hls.Events.FRAG_LOADING, (event, data) => {
        appendLog(`HLS: Loading fragment ${data.frag?.sn}`);
      });

      hls.on(window.Hls.Events.FRAG_LOADED, (event, data) => {
        appendLog(`HLS: Fragment loaded: ${data.frag?.sn}`);
        hasFragLoaded = true;
        setVideoStatus("playing");
      });

      // 直播同步事件 - 確保播放最新內容
      hls.on(window.Hls.Events.LIVE_BACK_BUFFER_REACHED, () => {
        appendLog("Live sync: reached back buffer");
      });

      hls.on(window.Hls.Events.LIVE_SYNCING, () => {
        appendLog("Live sync: syncing to live edge");
      });

      // 如果超過 30 秒還沒有載入成功，認為沒有訊號
      setTimeout(() => {
        if (!hasManifestParsed && !hasFragLoaded) {
          appendLog("No stream signal detected after timeout (30s)");
          setVideoStatus("no signal");
          hls.destroy();
          // 繼續定期檢查
          setTimeout(loadStream, 10000);
        }
      }, 30000);

      hls.loadSource(url);
      hls.attachMedia(player);

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
    player.onloadeddata = () => setVideoStatus("playing");
    player.onerror = () => {
      appendLog("Video error while loading source");
      setVideoStatus("no signal");
      // attempt reload with backoff - 增加到 10 秒避免瘋狂刷新
      setTimeout(loadStream, 10000);
    };

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
    connectWs();
  }

  // 開始等待配置載入
  waitForConfig();
})();

