(() => {
  window.__t3QuotaMod?.dispose();
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{font:13px system-ui;color:var(--foreground,#eee)}
    button{font:inherit;color:inherit;background:var(--background,#191923);border:1px solid #7776;border-radius:8px;padding:7px 11px;cursor:pointer}
    #toggle{position:fixed;right:16px;bottom:16px;z-index:2147483000;box-shadow:0 2px 12px #0004}
    #panel{position:fixed;right:16px;bottom:58px;width:min(420px,calc(100vw - 32px));max-height:75vh;overflow:auto;z-index:2147483000;background:var(--background,#191923);border:1px solid #7776;border-radius:12px;box-shadow:0 12px 40px #0005;padding:16px;box-sizing:border-box}
    [hidden]{display:none!important}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:15px;margin:0}h3{margin:18px 0 8px;font-size:13px}
    .muted{opacity:.7;font-size:12px}.account{margin:12px 0;border-top:1px solid #7773;padding-top:10px}.name{overflow-wrap:anywhere}.tier{display:inline-block;margin:4px 0;border:1px solid #7776;border-radius:5px;padding:1px 5px}
    .line{display:flex;justify-content:space-between;gap:10px;margin:5px 0}.bar{height:5px;background:#7774;border-radius:4px;overflow:hidden}.fill{height:100%;background:#a78bfa}.pool{padding:8px;background:#7771;border-radius:7px;margin:6px 0}.error{color:#fda4af}
    a{color:inherit}button:focus-visible{outline:2px solid #a78bfa;outline-offset:2px}
  </style><button id="toggle" aria-expanded="false">CLIProxy</button><section id="panel" hidden aria-label="CLIProxy quotas"><header><h2>CLIProxy quotas</h2><button id="close" aria-label="Close quotas">×</button></header><p id="status" class="muted"></p><div id="content"></div><button id="refresh">Refresh</button></section>`;
  document.documentElement.append(host);
  const get = (id) => shadow.getElementById(id);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const reset = (time) => time ? new Date(time).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "reset unknown";
  let open = false;
  let timer;
  const request = () => {
    if (typeof window.__t3QuotaRequest === "function") {
      get("status").textContent = "Refreshing…";
      window.__t3QuotaRequest("read");
    } else get("status").textContent = "Reconnect through the T3 Code Ctrl-Tab launcher to load quotas.";
  };
  const show = (value) => {
    open = value;
    get("panel").hidden = !open;
    get("toggle").setAttribute("aria-expanded", String(open));
    clearInterval(timer);
    if (open) { request(); timer = setInterval(request, 60000); get("close").focus(); }
    else get("toggle").focus();
  };
  get("toggle").onclick = () => show(!open);
  get("close").onclick = () => show(false);
  get("refresh").onclick = request;
  const onKey = (event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); show(false); } };
  document.addEventListener("keydown", onKey, true);
  window.__t3QuotaReceive = (snapshot) => {
    get("content").replaceChildren();
    get("status").textContent = snapshot.error || `Updated ${new Date(snapshot.checkedAt).toLocaleTimeString()}`;
    get("status").className = snapshot.error ? "error" : "muted";
    if (snapshot.error) return;
    for (const pool of snapshot.pools) {
      const accounts = snapshot.accounts.filter((account) => account.provider === pool.provider);
      if (!accounts.length) continue;
      get("content").append(element("h3", pool.provider === "claude" ? "Claude" : "Codex"));
      for (const [kind, window] of Object.entries(pool.windows)) {
        if (!window) continue;
        const box = element("div", undefined, "pool");
        box.append(element("div", `${kind === "session" ? "5-hour" : "Weekly"}: ${window.remaining}% left`));
        box.append(element("div", `${window.weighted ? "Weighted by plan allowance" : "Average per account · capacity ratio unknown"}${window.incomplete ? " · some readings unavailable" : ""}`, "muted"));
        get("content").append(box);
      }
      for (const account of accounts) {
        const row = element("div", undefined, "account");
        row.append(element("div", account.name, "name"), element("span", account.plan, "tier"));
        if (account.unavailable) row.append(element("div", "Usage unavailable", "muted"));
        for (const [kind, window] of [...Object.entries(account.windows), ...(account.scoped ?? []).map((window) => [`${window.label ?? window.scope ?? "Other"} weekly`, window])]) {
          if (!window) continue;
          const line = element("div", undefined, "line");
          line.append(element("span", kind === "session" ? "5-hour" : kind === "weekly" ? "Weekly" : kind), element("span", `${Math.round(100 - window.used)}% left`));
          const bar = element("div", undefined, "bar");
          const fill = element("div", undefined, "fill");
          fill.style.width = `${100 - window.used}%`;
          bar.append(fill);
          row.append(line, bar, element("div", `Resets ${reset(window.resetAt)}`, "muted"));
        }
        get("content").append(row);
      }
    }
  };
  window.__t3QuotaMod = { dispose() { clearInterval(timer); document.removeEventListener("keydown", onKey, true); host.remove(); delete window.__t3QuotaReceive; } };
})();
