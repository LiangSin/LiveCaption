(function () {
  const qs = (id) => document.getElementById(id);

  const appRoot = qs("app");
  const captionMode = appRoot?.dataset?.captionMode || "original"; // "original" | "translation"
  const wantTranslation = captionMode === "translation";

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
    let liveCatchupTimer = null;
    let liveDelay = null; // 直播延遲時間（毫秒）
    let lastLiveDelayUpdate = null; // 上次更新 liveDelay 的時間
    let pendingCaptions = []; // 待顯示的字幕隊列
    let captionTimer = null; // 字幕顯示計時器

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

  // 更新直播延遲
  function updateLiveDelay(hlsInstance) {
    if (!hlsInstance || !player) return;
    
    const now = Date.now();
    // 如果 liveDelay 不存在，或超過 10 秒沒更新，則重新計算
    if (liveDelay === null || !lastLiveDelayUpdate || (now - lastLiveDelayUpdate) > 10000) {
      const liveSyncPos = hlsInstance.liveSyncPosition;
      const currentTime = player.currentTime;
      
      if (Number.isFinite(liveSyncPos) && Number.isFinite(currentTime)) {
        const delaySeconds = liveSyncPos - currentTime;
        if (delaySeconds >= 0) {
          liveDelay = delaySeconds * 1000; // 轉換為毫秒
          lastLiveDelayUpdate = now;
          appendLog(`Live delay updated: ${delaySeconds.toFixed(2)}s`);
        }
      }
    }
  }

  // 處理待顯示的字幕隊列
  function processCaptionQueue() {
    if (captionTimer) {
      clearTimeout(captionTimer);
      captionTimer = null;
    }

    if (pendingCaptions.length === 0) return;

    const now = Date.now();
    const caption = pendingCaptions[0];

    if (now >= caption.displayTime) {
      // 時間到了，顯示字幕
      pendingCaptions.shift();
      setCaption(caption.text);
      
      // 繼續處理下一個
      if (pendingCaptions.length > 0) {
        processCaptionQueue();
      }
    } else {
      // 還沒到時間，設置計時器
      const delay = caption.displayTime - now;
      captionTimer = setTimeout(processCaptionQueue, delay);
    }
  }

  // 添加字幕到隊列（帶延遲）
  function scheduleCaption(text, isPartial) {
    const receiveTime = Date.now();
    const delay = liveDelay !== null ? liveDelay : 0;
    const displayTime = receiveTime + delay;

    // 如果是部分字幕，替換隊列中的最後一個部分字幕（如果存在）
    if (isPartial && pendingCaptions.length > 0) {
      const lastCaption = pendingCaptions[pendingCaptions.length - 1];
      if (lastCaption.isPartial) {
        lastCaption.text = text;
        lastCaption.displayTime = displayTime;
        return;
      }
    }

    pendingCaptions.push({
      text,
      isPartial,
      receiveTime,
      displayTime
    });

    // 開始處理隊列
    processCaptionQueue();
  }

    function setSubtitleStatus(text) {
      if (subtitleStatus) subtitleStatus.textContent = text;

      // 根據狀態更新字幕顯示
      const hasSignal = text === "receiving" || text === "receiving (partial)" || text === "connected";
      if (captionEl) {
        if (hasSignal) {
          // 有訊號時顯示正常字幕（如果沒有字幕就顯示等待）
          if (captionEl.textContent === "No signal") {
            captionEl.textContent = "Waiting for subtitles…";
          }
        } else {
          // 沒有訊號時顯示 "No signal"
          captionEl.textContent = "No signal";
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
    if (!captionEl) return;
    
    // 檢查是否已經滾動到底部（或接近底部，允許 5px 的誤差）
    const isAtBottom = captionEl.scrollHeight - captionEl.scrollTop - captionEl.clientHeight <= 5;
    
    // 更新文字內容
    captionEl.textContent = text || "—";
    
    // 如果之前在底部，則自動滾動到新的底部
    if (isAtBottom) {
      captionEl.scrollTop = captionEl.scrollHeight;
    }
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

      // Caption routing: main page shows transcription; /translate shows translation.
      if (!wantTranslation && payload.type === "caption") {
          const text = payload.text || "";
          const isPartial = payload.partial || false;
          appendLog(`Caption${isPartial ? " (partial)" : ""}: ${text}`);
          setSubtitleStatus(isPartial ? "receiving (partial)" : "receiving");
          scheduleCaption(text, isPartial);
          return;
      }

      if (wantTranslation) {
        // Preferred: relay emits caption_translation messages.
        if (payload.type === "caption_translation") {
          const text = payload.text || "";
          const isPartial = payload.partial || false;
          appendLog(`Translation${isPartial ? " (partial)" : ""}: ${text}`);
          setSubtitleStatus(isPartial ? "receiving (partial)" : "receiving");
          scheduleCaption(text, isPartial);
          return;
        }

        // Fallback: if upstream ever embeds translation in caption payload.
        if (payload.type === "caption") {
          const translated = (payload.translation || payload.text_translation || "").toString();
          if (translated.trim().length > 0) {
            const isPartial = payload.partial || false;
            appendLog(`Translation${isPartial ? " (partial)" : ""}: ${translated}`);
            setSubtitleStatus(isPartial ? "receiving (partial)" : "receiving");
            scheduleCaption(translated, isPartial);
            return;
          }
        }
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
    const isHlsUrl = url.endsWith(".m3u8");
    const useHlsJs = window.Hls && window.Hls.isSupported() && isHlsUrl;
    if (liveCatchupTimer) {
      clearInterval(liveCatchupTimer);
      liveCatchupTimer = null;
    }

    if (useHlsJs) {
      const hls = new window.Hls({
        lowLatencyMode: true,
        liveSyncDuration: 3, // time difference between live edge and player current time
        liveMaxLatencyDuration: 7, // maximum tolerance for live edge
        maxLiveSyncPlaybackRate: 1,
        liveDurationInfinity: true,
        maxBufferLength: 6,
        maxMaxBufferLength: 12,
        backBufferLength: 3,
        maxRetries: 6,
        startLevel: -1,
        enableWorker: true,
        debug: true,
      });

      let hasManifestParsed = false;
      let hasFragLoaded = false;
      let lastCatchUpAt = 0;

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
        // 開始定期更新 live delay
        updateLiveDelay(hls);
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
        // 每次載入新片段時更新 live delay
        updateLiveDelay(hls);
      });

      hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
        maybeCatchUp("frag");
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

      // 定期更新 live delay（每 5 秒檢查一次）
      const liveDelayUpdateInterval = setInterval(() => {
        updateLiveDelay(hls);
      }, 5000);

      // 在 HLS 銷毀時清除定時器
      const originalDestroy = hls.destroy.bind(hls);
      hls.destroy = function() {
        clearInterval(liveDelayUpdateInterval);
        if (captionTimer) {
          clearTimeout(captionTimer);
          captionTimer = null;
        }
        pendingCaptions = [];
        liveDelay = null;
        lastLiveDelayUpdate = null;
        originalDestroy();
      };

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
      // attempt reload with backoff - 增加到 10 秒避免瘋狂刷新
      setTimeout(loadStream, 10000);
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
