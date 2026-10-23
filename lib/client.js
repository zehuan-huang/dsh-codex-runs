/**
 * dsh-codex-runs · the top-right run-history panel (client half).
 *
 * Loaded by the Harness web client, never by Node: it registers itself with
 * `window.__ModuleLoader__.load({ id, factory })` exactly like the shipped
 * client plugins do, and keeps the same `exports.apply` / `exports.inject`
 * contract. There is no build step and no React import — the panel is plain
 * DOM, so it cannot disturb the shell's own render tree.
 *
 * What it does, and all it does:
 *  - mounts one fixed panel at the top-RIGHT (right:18px; top:64px);
 *  - polls the host's read-only `GET /api/codex-runs` every 10s;
 *  - renders one collapsible row per Codex run: `HH:MM · <cwd basename> ·
 *    ●done/◐running/✕aborted · duration`, expanded into sessionId / model /
 *    cwd / totalTokens / lastMessage;
 *  - remembers the collapsed state in `localStorage["dsh-codex-runs:open"]`.
 *
 * Failure policy: a failed poll only flips the title-row badge to `读取失败`
 * (with the reason in its tooltip). The existing list is never cleared and no
 * exception escapes the poll.
 */

window.__ModuleLoader__.load({
  id: "dsh-codex-runs",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Stable DOM ids so a hot-reloaded instance replaces the previous one. */
    const PANEL_ID = "dsh-codex-runs-panel";
    const STYLE_ID = "dsh-codex-runs-style";

    /** Collapsed state: "1" = open, "0" = collapsed (absent = open). */
    const OPEN_KEY = "dsh-codex-runs:open";

    /** A stale instance's interval handle, kept on window so it can be stopped. */
    const TIMER_KEY = "__dshCodexRunsTimer";

    /** The host route registered by lib/index.js. */
    const ENDPOINT = "/api/codex-runs";
    const POLL_MS = 10000;
    const MAX_RUNS = 50;

    /** Status glyphs + colours, keyed by the host's `status` vocabulary. */
    const STATUSES = {
      done: { icon: "●", cls: "dcr-done", label: "done" },
      running: { icon: "◐", cls: "dcr-running", label: "running" },
      aborted: { icon: "✕", cls: "dcr-aborted", label: "aborted" },
      unknown: { icon: "?", cls: "dcr-unknown", label: "unknown" },
    };

    const CSS = [
      "#dsh-codex-runs-panel{position:fixed;right:18px;top:64px;z-index:2147483000;width:320px;max-width:calc(100vw - 200px);max-height:60vh;display:flex;flex-direction:column;font:12px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",ui-sans-serif,system-ui,sans-serif;color:#e6e6ea;background:#1b1b1f;border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden;color-scheme:dark;text-align:left;}",
      "#dsh-codex-runs-panel *{box-sizing:border-box;}",
      "#dsh-codex-runs-panel .dcr-head{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:7px 9px;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;user-select:none;}",
      "#dsh-codex-runs-panel .dcr-head:hover{background:rgba(255,255,255,.06);}",
      "#dsh-codex-runs-panel .dcr-head:focus-visible{outline:1px solid #6aa6ff;outline-offset:-1px;}",
      "#dsh-codex-runs-panel .dcr-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px;letter-spacing:.01em;}",
      "#dsh-codex-runs-panel .dcr-badge{flex:none;padding:1px 5px;border-radius:999px;background:rgba(248,113,113,.16);color:#f87171;font-size:10.5px;font-weight:600;line-height:1.5;}",
      "#dsh-codex-runs-panel .dcr-badge[hidden]{display:none;}",
      "#dsh-codex-runs-panel .dcr-chevron{flex:none;color:#8e8e93;font-size:10px;line-height:1;}",
      "#dsh-codex-runs-panel .dcr-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-top:1px solid rgba(255,255,255,.09);}",
      "#dsh-codex-runs-panel .dcr-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;}",
      "#dsh-codex-runs-panel .dcr-list::-webkit-scrollbar{width:8px;}",
      "#dsh-codex-runs-panel .dcr-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px;}",
      "#dsh-codex-runs-panel .dcr-list::-webkit-scrollbar-track{background:transparent;}",
      "#dsh-codex-runs-panel .dcr-empty{padding:12px 10px;color:#8e8e93;}",
      "#dsh-codex-runs-panel .dcr-row{border-bottom:1px solid rgba(255,255,255,.06);}",
      "#dsh-codex-runs-panel .dcr-row:last-child{border-bottom:0;}",
      "#dsh-codex-runs-panel .dcr-line{display:flex;align-items:center;gap:5px;padding:5px 9px;cursor:pointer;list-style:none;color:#d6d6db;}",
      "#dsh-codex-runs-panel .dcr-line::-webkit-details-marker{display:none;}",
      "#dsh-codex-runs-panel .dcr-line:hover{background:rgba(255,255,255,.05);}",
      "#dsh-codex-runs-panel .dcr-time{flex:none;color:#98989f;font-size:11px;font-variant-numeric:tabular-nums;}",
      "#dsh-codex-runs-panel .dcr-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      "#dsh-codex-runs-panel .dcr-sep{flex:none;color:#5f5f66;}",
      "#dsh-codex-runs-panel .dcr-state{flex:none;font-size:11px;line-height:1;white-space:nowrap;}",
      "#dsh-codex-runs-panel .dcr-state .dcr-icon{font-size:11px;}",
      "#dsh-codex-runs-panel .dcr-done{color:#4ade80;}",
      "#dsh-codex-runs-panel .dcr-aborted{color:#f87171;}",
      "#dsh-codex-runs-panel .dcr-running{color:#fbbf24;}",
      "#dsh-codex-runs-panel .dcr-unknown{color:#8e8e93;}",
      "#dsh-codex-runs-panel .dcr-dur{flex:none;color:#98989f;font-size:11px;font-variant-numeric:tabular-nums;}",
      "#dsh-codex-runs-panel .dcr-detail{padding:4px 9px 8px;background:rgba(0,0,0,.18);}",
      "#dsh-codex-runs-panel .dcr-field{margin-bottom:6px;}",
      "#dsh-codex-runs-panel .dcr-field:last-child{margin-bottom:0;}",
      "#dsh-codex-runs-panel .dcr-k{display:block;font-size:10px;letter-spacing:.03em;text-transform:uppercase;color:#8e8e93;margin-bottom:2px;}",
      "#dsh-codex-runs-panel .dcr-v{margin:0;padding:5px 6px;border-radius:6px;background:rgba(0,0,0,.3);color:#d4d4d8;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:22vh;overflow-y:auto;}",
      "#dsh-codex-runs-panel .dcr-muted{color:#7c7c83;font-style:italic;}",
      "#dsh-codex-runs-panel .dcr-tid{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:6px;}",
      "#dsh-codex-runs-panel .dcr-tid .dcr-k{margin:0;display:inline;}",
      "#dsh-codex-runs-panel .dcr-tidv{flex:1 1 120px;min-width:0;font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8ab4f8;overflow-wrap:anywhere;user-select:all;}",
      "#dsh-codex-runs-panel .dcr-copy{flex:none;padding:1px 5px;border:1px solid rgba(255,255,255,.18);border-radius:5px;background:transparent;color:#b8b8bf;font-size:10.5px;font-family:inherit;line-height:1.4;cursor:pointer;}",
      "#dsh-codex-runs-panel .dcr-copy:hover{background:rgba(255,255,255,.08);color:#fff;}",
    ].join("");

    let panel = null;
    let headEl = null;
    let titleEl = null;
    let statusEl = null;
    let chevronEl = null;
    let bodyEl = null;
    let listEl = null;

    let timer = null;
    let inFlight = false;
    let runs = [];
    let rootMissing = false;
    let lastError = "";
    let isOpen = true;
    const openIds = new Set();

    function el(tag, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    function text(value) {
      if (value === null || value === undefined) return "";
      return String(value);
    }

    // ---- formatting ------------------------------------------------------

    function pad(n) {
      return String(n).padStart(2, "0");
    }

    /**
     * `HH:MM` for today's runs; `MM-DD HH:MM` for older ones, because the host
     * serves a 7-day window and a bare clock would repeat. The full ISO range
     * is always in the row tooltip.
     */
    function formatTime(value) {
      const raw = text(value);
      if (raw === "") return "--:--";
      const date = new Date(raw);
      if (!Number.isFinite(date.getTime())) return "--:--";
      const clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
      const now = new Date();
      const sameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
      return sameDay ? clock : pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + clock;
    }

    function formatDuration(value, status, startedAt) {
      let ms = typeof value === "number" && Number.isFinite(value) ? value : null;
      if (ms === null && status === "running" && text(startedAt) !== "") {
        const started = Date.parse(startedAt);
        if (Number.isFinite(started)) ms = Date.now() - started;
      }
      if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
      if (ms < 1000) return Math.round(ms) + "ms";
      const seconds = ms / 1000;
      if (seconds < 60) return (seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)) + "s";
      const minutes = Math.floor(seconds / 60);
      const restSeconds = Math.round(seconds % 60);
      if (minutes < 60) return restSeconds > 0 ? minutes + "m" + restSeconds + "s" : minutes + "m";
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      return restMinutes > 0 ? hours + "h" + restMinutes + "m" : hours + "h";
    }

    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
      if (value < 1000) return String(value);
      if (value < 1000000) return (Math.round(value / 100) / 10).toFixed(1) + "K";
      return (Math.round(value / 100000) / 10).toFixed(1) + "M";
    }

    function statusOf(status) {
      return STATUSES[status] || STATUSES.unknown;
    }

    /** Last path segment of a cwd, for both POSIX and Windows paths. */
    function basenameOf(value) {
      const raw = text(value).replace(/[\\/]+$/, "");
      if (raw === "") return "(未知目录)";
      const parts = raw.split(/[\\/]/);
      const last = parts[parts.length - 1];
      return last === "" || last === undefined ? raw : last;
    }

    // ---- clipboard (best effort; failures never throw) --------------------

    function copyText(value) {
      const payload = text(value);
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(payload).then(
            () => true,
            () => legacyCopy(payload)
          );
        }
      } catch {
        /* fall through */
      }
      return Promise.resolve(legacyCopy(payload));
    }

    function legacyCopy(payload) {
      try {
        const area = document.createElement("textarea");
        area.value = payload;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok === true;
      } catch {
        return false;
      }
    }

    // ---- panel construction ----------------------------------------------

    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    function readOpen() {
      try {
        const saved = window.localStorage.getItem(OPEN_KEY);
        return saved === null ? true : saved !== "0";
      } catch {
        return true;
      }
    }

    function writeOpen(open) {
      try {
        window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
      } catch {
        /* storage may be unavailable (private mode); the panel still works */
      }
    }

    function setOpen(open, persist) {
      isOpen = open === true;
      if (bodyEl !== null) bodyEl.style.display = isOpen ? "" : "none";
      if (chevronEl !== null) chevronEl.textContent = isOpen ? "▾" : "▸";
      if (headEl !== null) headEl.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (persist) writeOpen(isOpen);
    }

    function mount() {
      injectStyle();

      // A previous instance (hot reload) may still own a timer and a node.
      try {
        const previousTimer = window[TIMER_KEY];
        if (previousTimer !== undefined && previousTimer !== null) {
          window.clearInterval(previousTimer);
          window[TIMER_KEY] = null;
        }
      } catch {
        /* ignore */
      }
      const stale = document.getElementById(PANEL_ID);
      if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale);

      panel = el("div", "dcr-panel");
      panel.id = PANEL_ID;
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Codex 运行记录");

      headEl = el("button", "dcr-head");
      headEl.type = "button";
      headEl.setAttribute("aria-expanded", "true");
      headEl.title = "折叠 / 展开";

      titleEl = el("span", "dcr-title");
      titleEl.textContent = "Codex 运行记录 (0)";

      statusEl = el("span", "dcr-badge");
      statusEl.hidden = true;

      chevronEl = el("span", "dcr-chevron");
      chevronEl.textContent = "▾";

      headEl.appendChild(titleEl);
      headEl.appendChild(statusEl);
      headEl.appendChild(chevronEl);
      headEl.addEventListener("click", () => {
        setOpen(!isOpen, true);
        if (isOpen) void refresh();
      });

      bodyEl = el("div", "dcr-body");
      listEl = el("div", "dcr-list");
      bodyEl.appendChild(listEl);

      panel.appendChild(headEl);
      panel.appendChild(bodyEl);
      (document.body || document.documentElement).appendChild(panel);

      setOpen(readOpen(), false);
      renderHeader();
      renderList();

      const onVisibility = () => {
        if (document.hidden !== true) void refresh();
      };
      document.addEventListener("visibilitychange", onVisibility);

      timer = window.setInterval(() => {
        if (document.hidden === true) return;
        void refresh();
      }, POLL_MS);
      window[TIMER_KEY] = timer;

      void refresh();

      return () => {
        const handle = timer;
        timer = null;
        if (handle !== null) {
          try {
            window.clearInterval(handle);
          } catch {
            /* ignore */
          }
          try {
            if (window[TIMER_KEY] === handle) window[TIMER_KEY] = null;
          } catch {
            /* ignore */
          }
        }
        document.removeEventListener("visibilitychange", onVisibility);
        if (panel !== null && panel.parentNode !== null) panel.parentNode.removeChild(panel);
        panel = null;
        headEl = null;
        titleEl = null;
        statusEl = null;
        chevronEl = null;
        bodyEl = null;
        listEl = null;
      };
    }

    // ---- data ------------------------------------------------------------

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(ENDPOINT, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const payload = await response.json();
        if (payload === null || typeof payload !== "object" || !Array.isArray(payload.runs)) {
          throw new Error("响应里没有 runs 数组");
        }
        runs = payload.runs.slice(0, MAX_RUNS);
        rootMissing = payload.rootMissing === true;
        lastError = "";
      } catch (error) {
        const message = error && error.message ? String(error.message) : String(error);
        if (message !== lastError) console.warn("[codex-runs] 读取失败: " + message);
        lastError = message;
        renderHeader();
        return;
      } finally {
        inFlight = false;
      }
      renderHeader();
      renderList();
    }

    // ---- rendering -------------------------------------------------------

    function renderHeader() {
      if (titleEl !== null) titleEl.textContent = "Codex 运行记录 (" + runs.length + ")";
      if (statusEl === null) return;
      if (lastError !== "") {
        statusEl.textContent = "读取失败";
        statusEl.title = lastError;
        statusEl.hidden = false;
      } else {
        statusEl.textContent = "";
        statusEl.title = "";
        statusEl.hidden = true;
      }
    }

    function appendWithSeparators(parent, nodes) {
      nodes.forEach((node, index) => {
        if (index > 0) {
          const separator = el("span", "dcr-sep");
          separator.textContent = "·";
          parent.appendChild(separator);
        }
        parent.appendChild(node);
      });
    }

    function field(kind, value, fallback) {
      const wrap = el("div", "dcr-field");
      const key = el("div", "dcr-k");
      key.textContent = kind;
      const pre = el("pre", "dcr-v");
      const payload = text(value);
      if (payload !== "") {
        pre.textContent = payload;
      } else {
        pre.textContent = fallback;
        pre.classList.add("dcr-muted");
      }
      wrap.appendChild(key);
      wrap.appendChild(pre);
      return wrap;
    }

    function sessionIdField(sessionId) {
      const wrap = el("div", "dcr-field dcr-tid");
      const key = el("span", "dcr-k");
      key.textContent = "sessionId";
      const value = el("code", "dcr-tidv");
      value.textContent = text(sessionId);
      value.title = text(sessionId);
      const copy = el("button", "dcr-copy");
      copy.type = "button";
      copy.textContent = "复制";
      copy.title = "复制 sessionId";
      copy.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(sessionId).then((ok) => {
          copy.textContent = ok ? "已复制" : "复制失败";
          window.setTimeout(() => {
            copy.textContent = "复制";
          }, 1200);
        });
      });
      wrap.appendChild(key);
      wrap.appendChild(value);
      wrap.appendChild(copy);
      return wrap;
    }

    function rowFor(run) {
      const status = statusOf(run.status);
      const id = text(run.id);
      const cwd = text(run.cwd);
      const details = el("details", "dcr-row");
      details.dataset.id = id;
      if (openIds.has(id)) details.open = true;

      const line = el("summary", "dcr-line");
      const stamps = [text(run.startedAt), text(run.endedAt)].filter((part) => part !== "");
      line.title = [
        "cwd: " + (cwd !== "" ? cwd : "(未知)"),
        "session: " + (id !== "" ? id : "(未知)"),
        "status: " + status.label,
        "tokens: " + (typeof run.totalTokens === "number" ? run.totalTokens : "—"),
        stamps.join(" → "),
      ].join("\n");

      const time = el("span", "dcr-time");
      time.textContent = formatTime(run.startedAt || run.endedAt);

      const name = el("span", "dcr-name");
      name.textContent = basenameOf(cwd);

      const state = el("span", "dcr-state " + status.cls);
      const icon = el("span", "dcr-icon");
      icon.textContent = status.icon;
      state.appendChild(icon);
      state.appendChild(document.createTextNode(" " + status.label));

      const duration = el("span", "dcr-dur");
      duration.textContent = formatDuration(run.durationMs, run.status, run.startedAt);

      appendWithSeparators(line, [time, name, state, duration]);
      details.appendChild(line);

      const detail = el("div", "dcr-detail");
      detail.appendChild(sessionIdField(id));
      detail.appendChild(field("model", run.model, "未记录"));
      detail.appendChild(field("cwd", cwd, "未记录"));
      const tokens = formatTokens(run.totalTokens);
      detail.appendChild(field("totalTokens", tokens, "未记录"));
      detail.appendChild(field("lastMessage", run.lastMessage, run.status === "running" ? "运行中，尚未产生最终消息" : "没有消息"));
      details.appendChild(detail);

      details.addEventListener("toggle", () => {
        if (details.open) openIds.add(id);
        else openIds.delete(id);
      });
      return details;
    }

    function renderList() {
      if (listEl === null) return;
      const scrollTop = listEl.scrollTop;
      while (listEl.firstChild !== null) listEl.removeChild(listEl.firstChild);

      if (runs.length === 0) {
        const empty = el("div", "dcr-empty");
        empty.textContent = rootMissing
          ? "未找到 ~/.codex/sessions（本机还没有 Codex 运行记录）"
          : "最近 7 天没有 Codex 运行记录";
        listEl.appendChild(empty);
      } else {
        const fragment = document.createDocumentFragment();
        for (const run of runs) fragment.appendChild(rowFor(run));
        listEl.appendChild(fragment);
      }
      listEl.scrollTop = scrollTop;
    }

    // ---- plugin contract -------------------------------------------------

    function apply(ctx) {
      const cleanup = mount();
      if (ctx && typeof ctx.effect === "function") {
        try {
          ctx.effect(() => () => cleanup(), "codex-runs: top-right run history panel");
        } catch {
          /* the panel stays mounted; disposal is best-effort */
        }
      }
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
