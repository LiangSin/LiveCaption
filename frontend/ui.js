(function () {
  function createStatusRow(labelText, valueId, defaultText) {
    const row = document.createElement("div");
    row.className = "status-row";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = labelText;

    const value = document.createElement("span");
    value.id = valueId;
    value.textContent = defaultText;

    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function createVideoPanel(options = {}) {
    const showStatus = options.showStatus !== false;
    const panel = document.createElement("div");
    panel.className = options.panel === false ? "video-panel" : "video-panel panel";
    if (options.overlay) {
      panel.classList.add("video-panel--overlay");
    }
    if (showStatus) {
      panel.appendChild(createStatusRow("Video status:", "videoStatus", "waiting for signal"));
    }

    if (!options.overlay) {
      const toolbar = document.createElement("div");
      toolbar.className = "media-toolbar media-toolbar--video";

      const backButton = document.createElement("button");
      backButton.type = "button";
      backButton.className = "toolbar-back-button";
      backButton.setAttribute("aria-label", "回上一頁");
      backButton.addEventListener("click", () => {
        window.location.href = "/login";
      });
      toolbar.appendChild(backButton);

      const liveBadge = document.createElement("span");
      liveBadge.id = "liveBadge";
      liveBadge.className = "live-badge";
      liveBadge.textContent = "live";
      toolbar.appendChild(liveBadge);

      panel.appendChild(toolbar);
    }

    const video = document.createElement("video");
    video.id = "player";
    video.controls = true;
    video.playsInline = true;
    video.muted = true;
    panel.appendChild(video);

    const noSignal = document.createElement("div");
    noSignal.id = "noSignalMessage";
    noSignal.className = "no-signal-message";
    noSignal.textContent = "Streaming has not started";
    panel.appendChild(noSignal);

    if (!options.overlay) {
      const noteArea = document.createElement("textarea");
      noteArea.id = "noteArea";
      noteArea.className = "note-area";
      noteArea.placeholder = "筆記區 -- 輸入任何屬於你的內容";
      noteArea.setAttribute("aria-label", "筆記區");
      noteArea.spellcheck = false;
      panel.appendChild(noteArea);
    }

    return panel;
  }

  function createSubtitlePanel(options = {}) {
    const showLog = options.showLog === true;
    const showStatus = options.showStatus !== false;

    const caption = document.createElement("div");
    caption.id = "caption";
    caption.className = "caption";
    // When connected but no valid subtitles, show nothing (empty string).
    caption.textContent = "";

    if (options.overlay) {
      caption.classList.add("caption--overlay");
      const overlay = document.createElement("div");
      overlay.className = "subtitle-overlay";
      overlay.appendChild(caption);
      return overlay;
    }

    const panel = document.createElement("div");
    panel.className = options.panel === false ? "subtitle-panel" : "subtitle-panel panel";
    if (showStatus) {
      panel.appendChild(createStatusRow("Subtitle status:", "subtitleStatus", "disconnected"));
    }

    const toolbar = document.createElement("div");
    toolbar.className = "media-toolbar media-toolbar--subtitle";

    const modes = [
      ["both", "中+英"],
      ["zh", "中"],
      ["en", "英"],
    ];
    modes.forEach(([mode, label], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "subtitle-mode-button";
      button.dataset.subtitleMode = mode;
      button.setAttribute("aria-pressed", mode === "both" ? "true" : "false");
      button.textContent = label;
      toolbar.appendChild(button);

      if (index < modes.length - 1) {
        const separator = document.createElement("span");
        separator.className = "subtitle-mode-separator";
        separator.textContent = "|";
        toolbar.appendChild(separator);
      }
    });

    const fontSizeControl = document.createElement("div");
    fontSizeControl.className = "subtitle-font-size-control";

    const fontSizeLabel = document.createElement("span");
    fontSizeLabel.className = "subtitle-font-size-label";
    fontSizeLabel.textContent = "A";
    fontSizeControl.appendChild(fontSizeLabel);

    const fontSizeInput = document.createElement("input");
    fontSizeInput.id = "subtitleFontSize";
    fontSizeInput.className = "subtitle-font-size-slider";
    fontSizeInput.type = "range";
    fontSizeInput.min = "16";
    fontSizeInput.max = "32";
    fontSizeInput.step = "1";
    fontSizeInput.value = "20";
    fontSizeInput.setAttribute("aria-label", "調整字幕字體大小");
    fontSizeControl.appendChild(fontSizeInput);

    toolbar.appendChild(fontSizeControl);

    panel.appendChild(toolbar);

    panel.appendChild(caption);

    if (showLog) {
      const log = document.createElement("div");
      log.id = "log";
      log.className = "log";
      panel.appendChild(log);
    }

    return panel;
  }

  function createHeader(titleText) {
    const header = document.createElement("header");
    header.className = "header";
    const title = document.createElement("h1");
    title.textContent = titleText;
    header.appendChild(title);
    return header;
  }

  function mount() {
    const root = document.getElementById("app");
    if (!root) return;
    const showLog = root.dataset.showLog === "true";
    const showHeader = root.dataset.showHeader !== "false";
    const showStatus = root.dataset.showStatus !== "false";
    const subtitleOverlay = root.dataset.subtitleOverlay === "true";
    const titleText = root.dataset.title || "LiveCaption";
    const layoutMode = root.dataset.layout || "default";

    const main = document.createElement("main");
    main.className = "page";
    if (layoutMode === "simple") {
      main.classList.add("page--simple");
      if (subtitleOverlay) {
        main.classList.add("page--overlay");
      }
    }

    if (showHeader) {
      main.appendChild(createHeader(titleText));
    }

    const usePanel = layoutMode !== "simple";
    
    if (layoutMode === "simple" && subtitleOverlay) {
      // Overlay mode: video and subtitle in one container
      const layout = document.createElement("section");
      layout.className = "layout";
      const videoPanel = createVideoPanel({ showStatus, panel: usePanel, overlay: true });
      videoPanel.appendChild(createSubtitlePanel({ overlay: true }));
      layout.appendChild(videoPanel);
      main.appendChild(layout);
    } else if (layoutMode === "simple") {
      // Simple mode: video and subtitle in separate containers
      const videoContainer = document.createElement("section");
      videoContainer.className = "video-container";
      videoContainer.appendChild(createVideoPanel({ showStatus, panel: usePanel }));
      main.appendChild(videoContainer);

      const subtitleContainer = document.createElement("section");
      subtitleContainer.className = "subtitle-container";
      subtitleContainer.appendChild(createSubtitlePanel({ showLog, showStatus, panel: usePanel }));
      main.appendChild(subtitleContainer);
    } else {
      // Default mode: both in one layout container
      const layout = document.createElement("section");
      layout.className = "layout";
      layout.appendChild(createVideoPanel({ showStatus, panel: usePanel }));
      layout.appendChild(createSubtitlePanel({ showLog, showStatus, panel: usePanel }));
      main.appendChild(layout);
    }

    root.appendChild(main);
  }

  function showLogin(root, { onSubmit } = {}) {
    // Injected when the URL has no ?src=<key>; a minimal form for the user to
    // type a streaming key. Pattern mirrors the backend's KEY_RE.
    const existing = document.getElementById("loginView");
    if (existing) existing.remove();

    const view = document.createElement("div");
    view.id = "loginView";
    view.className = "login-view";

    const form = document.createElement("form");
    form.className = "login-view__form";
    form.autocomplete = "off";
    form.noValidate = true;

    const title = document.createElement("h1");
    title.className = "login-view__title";
    title.textContent = "輸入 streaming key";
    form.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.name = "src";
    input.className = "login-view__input";
    input.placeholder = "e.g. demo";
    input.pattern = "[A-Za-z0-9_-]{1,64}";
    input.maxLength = 64;
    input.required = true;
    input.autocapitalize = "off";
    input.spellcheck = false;
    form.appendChild(input);

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "login-view__button";
    button.textContent = "觀看";
    form.appendChild(button);

    const error = document.createElement("p");
    error.className = "login-view__error";
    error.hidden = true;
    form.appendChild(error);

    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const key = (input.value || "").trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
        error.textContent = "Key 格式錯誤：僅允許 A-Z / a-z / 0-9 / _ / -，長度 1-64";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      if (typeof onSubmit === "function") onSubmit(key);
    });

    view.appendChild(form);
    (root || document.body).appendChild(view);
    // Hide the auto-mounted main panels so the login view owns the viewport.
    const appNode = document.getElementById("app");
    if (appNode) appNode.style.display = "none";

    setTimeout(() => input.focus(), 0);
    return view;
  }

  function showFatal(root, message) {
    const existing = document.getElementById("fatalBanner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = "fatalBanner";
    banner.className = "fatal";
    banner.textContent = message;
    (root || document.body).appendChild(banner);
    return banner;
  }

  function showSessionExpired(root) {
    const existing = document.getElementById("sessionExpiredView");
    if (existing) existing.remove();

    const view = document.createElement("div");
    view.id = "sessionExpiredView";
    view.className = "session-expired";

    const panel = document.createElement("div");
    panel.className = "session-expired__panel";

    const title = document.createElement("h1");
    title.className = "session-expired__title";
    title.textContent = "Session expired";
    panel.appendChild(title);

    const message = document.createElement("p");
    message.className = "session-expired__message";
    message.textContent = "Please log in again to continue watching.";
    panel.appendChild(message);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-expired__button";
    button.textContent = "Go to login";
    button.addEventListener("click", () => {
      window.location.href = "/login";
    });
    panel.appendChild(button);

    view.appendChild(panel);
    (root || document.body).appendChild(view);
    return view;
  }

  function showRateLimitDialog(root, message = "請求頻率過高，請稍後再試。") {
    const existing = document.getElementById("rateLimitDialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "rateLimitDialog";
    overlay.className = "rate-limit-dialog";

    const panel = document.createElement("div");
    panel.className = "rate-limit-dialog__panel";

    const title = document.createElement("h1");
    title.className = "rate-limit-dialog__title";
    title.textContent = "請求頻率過高";
    panel.appendChild(title);

    const body = document.createElement("p");
    body.className = "rate-limit-dialog__message";
    body.textContent = message;
    panel.appendChild(body);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rate-limit-dialog__button";
    button.textContent = "關閉";
    button.addEventListener("click", () => overlay.remove());
    panel.appendChild(button);

    overlay.appendChild(panel);
    (root || document.body).appendChild(overlay);
    return overlay;
  }

  window.LiveCaptionUI = {
    mount,
    createVideoPanel,
    createSubtitlePanel,
    showLogin,
    showFatal,
    showSessionExpired,
    showRateLimitDialog,
  };

  mount();
})();
