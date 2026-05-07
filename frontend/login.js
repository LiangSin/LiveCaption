(function () {
  const form = document.getElementById("loginForm");
  const keySelect = document.getElementById("loginKey");
  const passkeyInput = document.getElementById("loginPasskey");
  const errorEl = document.getElementById("loginError");

  function setError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  async function loadKeys() {
    try {
      const res = await fetch("/auth/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const keys = Array.isArray(payload.keys) ? payload.keys : [];
      keySelect.textContent = "";
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

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    setError("");
    const key = keySelect.value;
    const passkey = passkeyInput.value;
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, passkey }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload.error || "Invalid key or passkey.");
        return;
      }
      window.location.href = payload.redirect || `/?src=${encodeURIComponent(key)}`;
    } catch (err) {
      setError(`Login failed: ${err.message || err}`);
    }
  });

  loadKeys().then(() => passkeyInput.focus());
})();
