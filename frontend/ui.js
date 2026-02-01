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

    const video = document.createElement("video");
    video.id = "player";
    video.controls = true;
    video.playsInline = true;
    video.muted = true;
    panel.appendChild(video);

    const noSignal = document.createElement("div");
    noSignal.id = "noSignalMessage";
    noSignal.className = "no-signal-message";
    noSignal.textContent = "No signal";
    panel.appendChild(noSignal);

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
      layout.className = "layout layout--simple";
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

  window.LiveCaptionUI = {
    mount,
    createVideoPanel,
    createSubtitlePanel,
  };

  mount();
})();
