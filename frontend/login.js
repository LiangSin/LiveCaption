(function () {
  const form = document.getElementById("loginForm");
  const keySelect = document.getElementById("loginKey");
  const passkeyLabel = document.getElementById("loginPasskeyLabel");
  const passkeyInput = document.getElementById("loginPasskey");
  const errorEl = document.getElementById("loginError");
  let keyCheckSeq = 0;

  function setError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function showRateLimitDialog(message) {
    const existing = document.getElementById("rateLimitDialog");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "rateLimitDialog";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "1000";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.padding = "24px";
    overlay.style.background = "rgba(246, 247, 251, 0.96)";

    const panel = document.createElement("div");
    panel.style.width = "100%";
    panel.style.maxWidth = "360px";
    panel.style.padding = "24px";
    panel.style.background = "var(--panel, #fff)";
    panel.style.border = "1px solid var(--border, #d0d7de)";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 10px 30px rgba(15, 20, 40, 0.08)";

    const title = document.createElement("h1");
    title.style.margin = "0 0 12px";
    title.style.fontSize = "1.25rem";
    title.textContent = "請求頻率過高";
    panel.appendChild(title);

    const body = document.createElement("p");
    body.style.margin = "0 0 16px";
    body.style.color = "var(--muted, #4b5563)";
    body.textContent = message || "請求頻率過高，請稍後再試。";
    panel.appendChild(body);

    const button = document.createElement("button");
    button.type = "button";
    button.style.width = "100%";
    button.style.padding = "10px 12px";
    button.style.fontSize = "1rem";
    button.style.color = "#fff";
    button.style.background = "var(--accent, #0f62fe)";
    button.style.border = "none";
    button.style.borderRadius = "8px";
    button.style.cursor = "pointer";
    button.textContent = "關閉";
    button.addEventListener("click", () => overlay.remove());
    panel.appendChild(button);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return overlay;
  }

  function redirectForKey(key, redirect) {
    window.location.href = redirect || `/?src=${encodeURIComponent(key)}`;
  }

  function setPasskeyVisible(visible) {
    if (passkeyLabel) passkeyLabel.hidden = !visible;
    passkeyInput.hidden = !visible;
    passkeyInput.required = visible;
  }

  async function checkCookieForKey(key) {
    if (!key) return;
    const seq = ++keyCheckSeq;
    try {
      const res = await fetch(`/auth/session?key=${encodeURIComponent(key)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (seq !== keyCheckSeq) return;
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) return;
      if (payload.can_auto_login) {
        redirectForKey(key, payload.redirect);
        return;
      }
      passkeyInput.focus();
    } catch (err) {
      if (seq === keyCheckSeq) {
        passkeyInput.focus();
      }
    }
  }

  async function loadKeys() {
    try {
      const res = await fetch("/auth/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const keys = Array.isArray(payload.keys) ? payload.keys : [];
      keySelect.textContent = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a key";
      placeholder.disabled = true;
      placeholder.selected = true;
      keySelect.appendChild(placeholder);
      keys.forEach((key) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = key;
        keySelect.appendChild(option);
      });
      if (keys.length === 0) setError("No keys are configured.");
    } catch (err) {
      setError(`Failed to load keys: ${err.message || err}`);
    }
  }

  keySelect.addEventListener("change", () => {
    const key = keySelect.value;
    setError("");
    passkeyInput.value = "";
    setPasskeyVisible(Boolean(key));
    checkCookieForKey(key);
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    setError("");
    const key = keySelect.value;
    const passkey = passkeyInput.value;
    if (!key) {
      setError("Please select a key.");
      keySelect.focus();
      return;
    }
    if (!passkey) {
      setError("Please enter the passkey.");
      passkeyInput.focus();
      return;
    }
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, passkey }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) {
          showRateLimitDialog(payload.error || "請求頻率過高，請稍後再試。"
          );
          return;
        }
        setError(payload.error || "Invalid key or passkey.");
        return;
      }
      redirectForKey(key, payload.redirect);
    } catch (err) {
      setError(`Login failed: ${err.message || err}`);
    }
  });

  setPasskeyVisible(false);
  loadKeys().then(() => keySelect.focus());
})();
