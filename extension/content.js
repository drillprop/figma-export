(() => {
  for (const el of document.querySelectorAll("[data-design-compare]")) el.remove();

  const PAGE = location.origin + location.pathname;
  const SETTINGS_KEY = "dc:" + PAGE;
  const DESIGN_KEY = "dc:design:" + PAGE;
  const UI_KEY = "dc:ui";

  const ACCENT = "#ff2d75";
  const Z_OVERLAY = "2147483646";
  const Z_UI = "2147483647";
  const MODES = {
    onion: { label: "Onion", key: "Digit1" },
    swipe: { label: "Swipe", key: "Digit2" },
    difference: { label: "Diff", key: "Digit3" },
  };
  const LOCKS = {
    free: { label: "✥ Free", tip: "Move in any direction", x: 1, y: 1 },
    x: { label: "↔ only", tip: "Move horizontally only", x: 1, y: 0 },
    y: { label: "↕ only", tip: "Move vertically only", x: 0, y: 1 },
  };
  const VIEWPORTS = ["off", "1920x1080", "1440x900", "1280x800", "1024x768", "390x844"];
  const STEPS = [1, 5, 10, 50];
  const MATCH = { patch: 96, radius: 12, minContrast: 8 }; // CSS px; contrast = std dev of gray levels
  const THUMB = { w: 160, h: 240 };

  let design = null; // { name, src, width, height, background }, width/height in CSS px, background "#rrggbb" or null
  const settings = {
    mode: "onion",
    opacity: 0.5,
    swipeX: 0.5,
    align: "center",
    offset: { x: 0, y: 0 },
    hidden: false,
    viewport: "off",
    flatten: false,
    pinned: false, // true: overlay sticks to the screen; false: it scrolls with the page
    step: 1,
    lock: "free",
    backdrop: true, // paint a colour behind the design so its transparent areas don't show the live page
    backdropColor: "", // "" means the frame's own fill from node.json
  };
  const ui = { panel: null, nav: null, minimized: false, navHidden: false }; // panel/nav: {left, top} once dragged
  let mounted = false;
  let moving = false; // hand tool: Space held or ✋ toggled
  let match = null; // { phase: "design" | "live" | "refining", point?: {x, y} }
  // The design each element last received. design.src is tens of MB, so reading it back to compare costs more than a render.
  let imgDesign = null;
  let thumbDesign = null;

  // --- DOM ------------------------------------------------------------------

  const own = (el, kind) => (el.setAttribute("data-design-compare", kind), el);
  const make = (kind, style) => {
    const el = own(document.createElement("div"), kind);
    Object.assign(el.style, style);
    return el;
  };

  // The layer clips the overlay to the page's own size, so a large design never adds scrollbars.
  const layer = make("layer", { position: "absolute", top: "0", left: "0", overflow: "clip", pointerEvents: "none" });
  const overlay = make("overlay", { position: "absolute", zIndex: Z_OVERLAY, margin: "0", padding: "0" });
  const img = document.createElement("img");
  img.draggable = false;
  Object.assign(img.style, { display: "block", width: "100%", height: "100%", maxWidth: "none", userSelect: "none" });
  overlay.append(img);
  layer.append(overlay);

  const handle = make("handle", {
    position: "fixed", top: "0", bottom: "0", width: "16px", marginLeft: "-8px",
    zIndex: Z_UI, cursor: "ew-resize", display: "none",
  });
  const tag = (side, bg, text) =>
    `<div style="position:absolute;${side}:14px;top:8px;font:600 11px system-ui;color:#fff;background:${bg};padding:2px 6px;border-radius:4px;white-space:nowrap">${text}</div>`;
  handle.innerHTML =
    `<div style="position:absolute;left:7px;top:0;bottom:0;width:2px;background:${ACCENT};box-shadow:0 0 0 1px #fff8"></div>` +
    `<div style="position:absolute;left:-6px;top:50%;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:${ACCENT};color:#fff;font:600 12px system-ui;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px #0006">⇔</div>` +
    tag("right", ACCENT, "Design") + tag("left", "#18181b", "Live");

  const banner = make("banner", {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: Z_UI,
    background: "#18181b", color: "#fff", font: "600 13px system-ui, sans-serif", padding: "10px 14px",
    borderRadius: "8px", boxShadow: "0 6px 20px #0008", pointerEvents: "none", display: "none",
  });
  const catcher = make("catcher", { position: "fixed", inset: "0", zIndex: Z_OVERLAY, cursor: "crosshair" });

  const BASE_CSS = `
  :host { all: initial; }
  button, select, input { font: inherit; color: inherit; background: #27272a; border: 1px solid #3f3f46;
       border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  input[type=number] { cursor: text; }
  button:hover { background: #3f3f46; }
  button:disabled { opacity: .3; cursor: default; }
  .seg { display: flex; border: 1px solid #3f3f46; border-radius: 6px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; flex: 1; background: transparent; }
  .seg button[aria-pressed=true], .on[aria-pressed=true] { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; }
  .muted { color: #a1a1aa; }
  kbd { font: 10px ui-monospace, monospace; background: #27272a; border-radius: 3px; padding: 0 3px; }
  [hidden] { display: none !important; }`;

  const panelHost = make("panel", { position: "fixed", right: "16px", bottom: "16px", zIndex: Z_UI });
  const panel = panelHost.attachShadow({ mode: "open" });
  panel.innerHTML = `
<style>${BASE_CSS}
  .p { width: 290px; background: #18181b; color: #e4e4e7; font: 12px/1.4 system-ui, sans-serif;
       border-radius: 10px; box-shadow: 0 8px 30px #0008; padding: 12px; display: grid; gap: 10px;
       max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; }
  .p.min { width: auto; max-width: 340px; padding: 8px 10px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .grow { flex: 1; }
  b { font-weight: 600; color: #fff; }
  h4 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #a1a1aa; }
  input[type=number] { width: 56px; }
  input[type=range] { width: 100%; accent-color: ${ACCENT}; padding: 0; border: 0; background: none; }
  input[type=checkbox] { accent-color: ${ACCENT}; margin: 0; }
  input[type=color] { width: 28px; height: 22px; padding: 1px 2px; }
  #backdropPresets button { padding: 2px 6px; }
  label.row { cursor: pointer; }
  .warn { background: #422006; color: #fdba74; border-radius: 6px; padding: 6px 8px; }
  .drop { border: 1px dashed #52525b; border-radius: 6px; padding: 8px; text-align: center; }
  .drop.over { border-color: ${ACCENT}; background: ${ACCENT}20; }
  .hdr { display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; }
  .hdr b { white-space: nowrap; }
  .hdr .info { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hdr button { padding: 2px 7px; }
  #body, .stack { display: grid; gap: 10px; }
</style>
<div class="p">
  <div class="hdr" id="hdr" title="Drag to move · double-click to minimize">
    <b>Design compare</b><span class="info muted" id="miniInfo"></span>
    <button id="navToggle" title="Show or hide the Navigator (Alt+N)">🧭</button>
    <button id="min" title="Minimize">–</button>
    <button id="close" title="Close (Alt+Shift+D)">×</button>
  </div>
  <div id="body">
    <div class="drop" id="drop">
      <div class="row" style="justify-content:center"><div id="dname" class="muted">No design loaded</div>
        <button id="remove" title="Remove this design from the page" hidden>✕ Remove</button></div>
      <div class="row" style="justify-content:center;margin-top:6px">
        <button id="pickDir">Export folder…</button>
        <button id="pickPng">PNG…</button>
        <select id="scale" title="PNG pixel density"><option value="1">@1x</option><option value="2" selected>@2x</option><option value="3">@3x</option></select>
      </div>
      <div class="muted" style="margin-top:4px">or drop a PNG here</div>
    </div>
    <div id="controls" class="stack" hidden>
      <div class="seg" id="modes">${Object.entries(MODES)
        .map(([id, m], i) => `<button data-mode="${id}">${m.label} <kbd>${i + 1}</kbd></button>`).join("")}</div>
      <div id="opRow"><div class="row"><span class="grow">Design opacity</span><span id="opVal"></span></div>
        <input type="range" id="opacity" min="0" max="1" step="0.01"></div>

      <div class="row" title="Transparent areas of the design image would show the live page through it. This paints a solid colour behind the design instead.">
        <label class="row grow"><input type="checkbox" id="backdrop"><span>Background</span></label>
        <div class="seg" id="backdropPresets">
          <button data-backdrop="" title="The frame's own fill from node.json">Frame</button>
          <button data-backdrop="#ffffff" title="Plain white">White</button>
        </div>
        <input type="color" id="backdropColor" title="Any other colour"></div>

      <h4>Page</h4>
      <div class="row"><span class="grow" title="Resizes the real Chrome window so the page area is exactly this size">Window</span>
        <input type="number" id="winW" min="200"> × <input type="number" id="winH" min="200">
        <button id="winSet">Set</button></div>
      <div class="warn" id="winNote" hidden></div>
      <div class="row"><span class="grow" title="Emulates an exact page size, even larger than your screen. Chrome shows a debugging bar while on.">Viewport (emulated)</span>
        <select id="viewport">${VIEWPORTS
          .map((v) => `<option value="${v}">${v === "off" ? "Window size" : v.replace("x", " × ")}</option>`).join("")}</select></div>
      <div class="warn" id="vpNote" hidden></div>
      <label class="row" title="Turns position: sticky/fixed into normal flow, so the page scrolls like the flat Figma frame">
        <input type="checkbox" id="flatten"><span class="grow">Flatten sticky &amp; fixed</span><span class="muted" id="flatCount"></span></label>
      <div class="warn" id="warn" hidden><div id="warnText"></div>
        <button id="resize" style="margin-top:6px">Resize window to fit</button></div>

      <h4>Position</h4>
      <div class="row">
        <span class="grow">Align</span>
        <div class="seg" id="aligns"><button data-align="left">Left</button><button data-align="center">Center</button></div>
      </div>
      <div class="row"><button id="hide" class="grow">Hide overlay <kbd>H</kbd></button></div>
      <div class="muted">Hold <kbd>Space</kbd> and drag to move (⇧ one axis) · Alt + <kbd>←↑→↓</kbd> nudge by step (⇧ ×10) · Alt + <kbd>1-3</kbd> mode · Alt + <kbd>H</kbd> hide · Alt + <kbd>N</kbd> Navigator</div>
    </div>
  </div>
</div>`;
  const $ = (id) => panel.getElementById(id);

  const navHost = make("navigator", { position: "fixed", right: "318px", bottom: "16px", zIndex: Z_UI });
  const nav = navHost.attachShadow({ mode: "open" });
  nav.innerHTML = `
<style>${BASE_CSS}
  .w { background: #18181b; color: #e4e4e7; font: 11px/1.3 system-ui, sans-serif; border-radius: 10px;
       box-shadow: 0 8px 30px #0008; padding: 6px; user-select: none; }
  button { border-radius: 5px; padding: 2px 6px; }
  .bar { display: flex; align-items: center; gap: 4px; padding: 0 2px 6px; cursor: move; }
  .bar span { flex: 1; color: #a1a1aa; }
  .thumb { position: relative; background-repeat: no-repeat; background-size: 100% 100%; cursor: pointer;
           outline: 1px solid #3f3f46; overflow: hidden; }
  .vp { position: absolute; border: 2px solid ${ACCENT}; background: ${ACCENT}22; box-sizing: border-box; cursor: grab; }
  .vp:active { cursor: grabbing; }
  .sec { margin-top: 8px; display: grid; gap: 6px; }
  .xy { display: flex; align-items: center; gap: 4px; }
  .scrub { cursor: ew-resize; color: ${ACCENT}; font-weight: 700; padding: 2px 3px; border-radius: 4px; }
  .scrub[data-axis=y] { cursor: ns-resize; }
  .scrub:hover { background: ${ACCENT}33; }
  input { border-radius: 5px; width: 46px; padding: 2px 4px; }
  .pad { display: flex; gap: 8px; align-items: center; }
  .dpad { display: grid; grid-template-columns: repeat(3, 24px); grid-template-rows: repeat(3, 24px); gap: 2px; }
  .dpad button { padding: 0; }
  .dpad .c { grid-area: 2 / 2; display: flex; align-items: center; justify-content: center; color: #71717a; font-size: 10px; }
  .steps { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; flex: 1; }
  .steps button { padding: 2px 0; }
  .seg button { padding: 3px 0; }
  .primary { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: 600; padding: 6px; }
  .primary:hover { background: #e11d63; }
</style>
<div class="w">
  <div class="bar" id="bar"><span>Navigator</span>
    <button id="hand" class="on" title="Hand tool: drag the design on the page (or hold Space)">✋</button>
    <button id="pin" class="on" title="Stick the design to the screen instead of scrolling with the page">📌</button>
    <button id="navHide" title="Hide the Navigator (Alt+N)">–</button>
  </div>
  <div class="thumb" id="thumb"><div class="vp" id="vp"></div></div>
  <div class="sec">
    <button class="primary" id="match" title="Click a spot on the design, then the same spot on the page">🎯 Match a point</button>
    <div class="seg" id="locks">${Object.entries(LOCKS)
      .map(([id, l]) => `<button data-lock="${id}" title="${l.tip}">${l.label}</button>`).join("")}</div>
    <div class="xy">
      <span class="scrub" data-axis="x" title="Drag left/right to adjust (⇧ ×10)">X</span><input type="number" id="ox">
      <span class="scrub" data-axis="y" title="Drag up/down to adjust (⇧ ×10)">Y</span><input type="number" id="oy">
      <button id="reset" title="Reset offset">⟲</button>
    </div>
    <div class="pad">
      <div class="dpad">
        <button data-dx="0" data-dy="-1" style="grid-area:1/2" title="Move up">↑</button>
        <button data-dx="-1" data-dy="0" style="grid-area:2/1" title="Move left">←</button>
        <span class="c" id="stepLabel"></span>
        <button data-dx="1" data-dy="0" style="grid-area:2/3" title="Move right">→</button>
        <button data-dx="0" data-dy="1" style="grid-area:3/2" title="Move down">↓</button>
      </div>
      <div class="steps" id="steps">${STEPS.map((n) => `<button data-step="${n}">${n}px</button>`).join("")}</div>
    </div>
  </div>
</div>`;
  const n$ = (id) => nav.getElementById(id);

  // --- persistence ----------------------------------------------------------

  let saveTimer = 0;
  const saveSettings = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {}), 250);
  };
  const saveDesign = () =>
    (design ? chrome.storage.local.set({ [DESIGN_KEY]: design }) : chrome.storage.local.remove(DESIGN_KEY)).catch(() => {});
  const saveUi = () => chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});

  function commit() {
    render();
    saveSettings();
  }

  // --- messages and banner --------------------------------------------------

  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));

  let bannerTimer = 0;
  function say(text, ms = 0, action = null) {
    clearTimeout(bannerTimer);
    banner.textContent = text;
    banner.style.display = text ? "block" : "none";
    banner.style.pointerEvents = action ? "auto" : "none";
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      Object.assign(b.style, {
        marginLeft: "12px", font: "inherit", color: "#fff", background: ACCENT, border: "0",
        borderRadius: "5px", padding: "3px 10px", cursor: "pointer",
      });
      b.onclick = () => { say(""); action.run(); };
      banner.append(b);
    }
    if (text && !banner.isConnected) document.documentElement.append(banner);
    if (ms) bannerTimer = setTimeout(() => say(""), ms);
  }

  const note = (el, text) => { el.hidden = !text; el.textContent = text; };

  // --- loading a design -----------------------------------------------------

  const readDataUrl = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const loadImage = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("not a readable image"));
    i.src = src;
  });

  async function designFromPng(file, scale, name) {
    const src = await readDataUrl(file);
    const image = await loadImage(src);
    return { name, src, width: image.naturalWidth / scale, height: image.naturalHeight / scale, background: null };
  }

  function frameFill(node) {
    const paint = [...(node.fills ?? []), ...(node.backgrounds ?? [])].find((p) => p.type === "SOLID" && p.visible !== false);
    if (!paint) return null;
    const hex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${hex(paint.color.r)}${hex(paint.color.g)}${hex(paint.color.b)}`;
  }

  const backdropColor = () => settings.backdropColor || design?.background || "#ffffff";

  async function designFromFolder(files) {
    const byPath = Object.fromEntries([...files].map((f) => [f.webkitRelativePath.split("/").slice(1).join("/"), f]));
    const png = byPath["preview.png"];
    if (!png) throw new Error("No preview.png in that folder. Pick a figma-export bundle folder.");
    const folder = png.webkitRelativePath.split("/")[0];
    if (!byPath["node.json"]) return designFromPng(png, Number($("scale").value), folder);
    let node;
    try {
      node = JSON.parse(await byPath["node.json"].text());
    } catch {
      throw new Error("node.json in that folder isn't valid JSON.");
    }
    if (!(node.width > 0 && node.height > 0)) throw new Error("node.json has no frame width and height.");
    return {
      name: String(node.name ?? folder), src: await readDataUrl(png),
      width: node.width, height: node.height, background: frameFill(node),
    };
  }

  async function load(promise) {
    try {
      setDesign(await promise);
    } catch (e) {
      say(`Couldn't load the design: ${e.message}`, 6000);
    }
  }

  function setDesign(next) {
    design = next;
    settings.offset = { x: 0, y: 0 };
    settings.backdropColor = "";
    saveDesign();
    commit();
  }

  function removeDesign() {
    const previous = { design, settings: structuredClone(settings) };
    cancelMatch();
    setMoving(false);
    design = null;
    Object.assign(settings, { offset: { x: 0, y: 0 }, pinned: false, viewport: "off", flatten: false });
    saveDesign();
    commit();
    say(`Removed “${previous.design.name}”.`, 8000, {
      label: "Undo",
      run: () => {
        design = previous.design;
        Object.assign(settings, previous.settings);
        saveDesign();
        commit();
      },
    });
  }

  // --- page effects: flatten, viewport emulation ---------------------------

  const flattened = new Map(); // element -> { value, priority } of its original inline position
  let flattenedOn = false;
  function syncFlatten() {
    const on = Boolean(design) && settings.flatten && mounted;
    if (on === flattenedOn) return;
    flattenedOn = on;
    if (!on) {
      for (const [el, { value, priority }] of flattened) {
        if (value) el.style.setProperty("position", value, priority);
        else el.style.removeProperty("position");
      }
      flattened.clear();
      return;
    }
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest("[data-design-compare]")) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== "sticky" && pos !== "fixed") continue;
      flattened.set(el, { value: el.style.getPropertyValue("position"), priority: el.style.getPropertyPriority("position") });
      el.style.setProperty("position", pos === "sticky" ? "relative" : "absolute", "important");
    }
  }

  let emulated = null; // last viewport sent to the background; null forces a sync after injection
  async function syncViewport() {
    const wanted = design && mounted ? settings.viewport : "off";
    if (wanted === emulated) return;
    emulated = wanted;
    const [width, height] = wanted === "off" ? [0, 0] : wanted.split("x").map(Number);
    const reply = await send({ type: "emulate", width, height });
    if (reply?.ok || wanted === "off") return note($("vpNote"), "");
    emulated = "off";
    settings.viewport = "off";
    note($("vpNote"), `Chrome refused to emulate ${wanted.replace("x", " × ")}: ${reply?.error ?? "no reply"}`);
    commit();
  }

  // --- window size ----------------------------------------------------------

  const pageSize = () => ({ width: document.documentElement.clientWidth, height: innerHeight });

  // Resolves 200ms after the last resize event (700ms if none arrives), and never later than 2s.
  const settledResize = () => new Promise((res) => {
    let quiet = setTimeout(done, 700);
    const cap = setTimeout(done, 2000);
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(done, 200); };
    function done() { clearTimeout(quiet); clearTimeout(cap); window.removeEventListener("resize", bump); res(); }
    window.addEventListener("resize", bump);
  });

  async function resizeWindowTo(width, height) {
    settings.viewport = "off";
    await syncViewport();
    await new Promise(requestAnimationFrame);
    note($("winNote"), "");
    let got = pageSize();
    for (let attempt = 0; attempt < 3 && (got.width !== width || got.height !== height); attempt++) {
      const resized = settledResize();
      const avail = { left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight };
      const reply = await send({ type: "resize-window", target: { width, height }, current: got, avail });
      if (!reply?.ok) return note($("winNote"), `Chrome refused the resize: ${reply?.error ?? "no reply"}`);
      await resized;
      const next = pageSize();
      if (next.width === got.width && next.height === got.height && reply.state === "normal") break;
      got = next;
    }
    const tooBig = [got.width < width && `${width}px wide`, got.height < height && `${height}px tall`].filter(Boolean);
    if (tooBig.length) {
      note($("winNote"), `Your screen can't fit ${tooBig.join(" and ")}; the page is ${got.width} × ${got.height}. Use Viewport (emulated) for larger sizes.`);
    } else if (got.width !== width || got.height !== height) {
      note($("winNote"), `Asked for ${width} × ${height}, got ${got.width} × ${got.height}.`);
    }
    commit();
  }

  // --- overlay geometry and look -------------------------------------------

  const lockAxes = () => LOCKS[settings.lock];
  const pageOrigin = () => (settings.pinned ? { x: 0, y: 0 } : { x: scrollX, y: scrollY });
  const overlayLeft = () =>
    (settings.align === "center" ? Math.round((document.documentElement.clientWidth - design.width) / 2) : 0) + settings.offset.x;

  function overlayLook() {
    const picking = match?.phase === "design";
    return {
      display: !design || (settings.hidden && !match) ? "none" : "block",
      visibility: match && !picking ? "hidden" : "visible",
      opacity: !match && settings.mode === "onion" ? String(settings.opacity) : "1",
      mixBlendMode: !match && settings.mode === "difference" ? "difference" : "normal",
      pointerEvents: moving || picking ? "auto" : "none",
      cursor: picking ? "crosshair" : moving ? "grab" : "",
      backgroundColor: settings.backdrop ? backdropColor() : "transparent",
    };
  }

  function swipeClip(rect) {
    const handleX = settings.swipeX * document.documentElement.clientWidth;
    const keep = Math.max(0, Math.min(rect.width, handleX - rect.left));
    return `inset(0 ${rect.width - keep}px 0 0)`;
  }

  function updateScrollBound() {
    if (!design) return;
    const swiping = settings.mode === "swipe" && !match && !settings.hidden;
    handle.style.display = swiping ? "block" : "none";
    handle.style.left = settings.swipeX * document.documentElement.clientWidth + "px";
    overlay.style.clipPath = swiping ? swipeClip(overlay.getBoundingClientRect()) : "none";
    placeNavigatorBox();
  }

  function measureLayer() {
    Object.assign(layer.style, { width: "0", height: "0" });
    const root = document.documentElement;
    Object.assign(layer.style, { width: root.scrollWidth + "px", height: root.scrollHeight + "px" });
  }

  function renderOverlay() {
    if (imgDesign !== design) {
      img.src = design.src;
      imgDesign = design;
    }
    Object.assign(overlay.style, overlayLook(), {
      position: settings.pinned ? "fixed" : "absolute",
      width: design.width + "px", height: design.height + "px",
      left: overlayLeft() + "px", top: settings.offset.y + "px",
    });
    if (!layer.isConnected) document.documentElement.append(layer);
    if (!handle.isConnected) document.documentElement.append(handle);
    measureLayer();
    updateScrollBound();
  }

  // --- navigator ------------------------------------------------------------

  const thumbScale = () => Math.min(THUMB.w / design.width, THUMB.h / design.height);

  function placeNavigatorBox() {
    if (!navHost.isConnected) return;
    const k = thumbScale();
    const origin = pageOrigin();
    Object.assign(n$("vp").style, {
      left: (origin.x - overlayLeft()) * k + "px",
      top: (origin.y - settings.offset.y) * k + "px",
      width: document.documentElement.clientWidth * k + "px",
      height: innerHeight * k + "px",
    });
  }

  function renderNavigator() {
    if (ui.navHidden) return navHost.remove();
    if (!navHost.isConnected) {
      document.documentElement.append(navHost);
      restoreBox(navHost, ui.nav);
    }
    const k = thumbScale();
    const thumb = n$("thumb");
    if (thumbDesign !== design) {
      thumb.style.backgroundImage = `url("${design.src}")`;
      thumbDesign = design;
    }
    Object.assign(thumb.style, { width: design.width * k + "px", height: design.height * k + "px" });
    const show = (v) => String(Number(v.toFixed(2)));
    if (nav.activeElement?.id !== "ox") n$("ox").value = show(settings.offset.x);
    if (nav.activeElement?.id !== "oy") n$("oy").value = show(settings.offset.y);
    n$("ox").step = n$("oy").step = settings.step;
    n$("stepLabel").textContent = settings.step;
    n$("hand").setAttribute("aria-pressed", moving);
    n$("pin").setAttribute("aria-pressed", settings.pinned);
    n$("match").setAttribute("aria-pressed", Boolean(match));
    for (const b of nav.querySelectorAll("[data-step]")) b.setAttribute("aria-pressed", Number(b.dataset.step) === settings.step);
    for (const b of nav.querySelectorAll("[data-lock]")) b.setAttribute("aria-pressed", b.dataset.lock === settings.lock);
    const axes = lockAxes();
    for (const b of nav.querySelectorAll("[data-dx]")) b.disabled = (b.dataset.dx !== "0" && !axes.x) || (b.dataset.dy !== "0" && !axes.y);
    placeNavigatorBox();
  }

  // --- panel ----------------------------------------------------------------

  function renderDesignName() {
    const name = $("dname");
    if (!design) return (name.textContent = "No design loaded");
    const title = document.createElement("b");
    title.textContent = design.name;
    const size = document.createElement("span");
    size.className = "muted";
    size.textContent = `${Math.round(design.width)} × ${Math.round(design.height)} px`;
    name.replaceChildren(title, document.createElement("br"), size);
  }

  function renderChrome() {
    panel.querySelector(".p").classList.toggle("min", ui.minimized);
    $("body").hidden = ui.minimized;
    $("min").textContent = ui.minimized ? "▢" : "–";
    $("min").title = ui.minimized ? "Expand" : "Minimize";
    $("miniInfo").textContent = ui.minimized && design ? `${design.name} · ${MODES[settings.mode].label}` : "";
    $("navToggle").hidden = !design;
    $("navToggle").setAttribute("aria-pressed", !ui.navHidden);
  }

  function renderPanel() {
    renderChrome();
    renderDesignName();
    $("remove").hidden = !design;
    $("controls").hidden = !design;
    if (!design) return;
    for (const b of panel.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", b.dataset.mode === settings.mode);
    for (const b of panel.querySelectorAll("[data-align]")) b.setAttribute("aria-pressed", b.dataset.align === settings.align);
    $("opRow").hidden = settings.mode !== "onion";
    $("opacity").value = settings.opacity;
    $("opVal").textContent = Math.round(settings.opacity * 100) + "%";
    $("viewport").value = settings.viewport;
    $("flatten").checked = settings.flatten;
    $("backdrop").checked = settings.backdrop;
    $("backdropColor").value = backdropColor();
    $("backdropColor").disabled = !settings.backdrop;
    for (const b of panel.querySelectorAll("[data-backdrop]")) {
      b.disabled = !settings.backdrop;
      b.setAttribute("aria-pressed", b.dataset.backdrop === settings.backdropColor);
    }
    $("flatCount").textContent = settings.flatten ? `${flattened.size} el` : "";
    $("hide").firstChild.textContent = settings.hidden ? "Show overlay " : "Hide overlay ";
    const size = pageSize();
    if (panel.activeElement?.id !== "winW") $("winW").value = size.width;
    if (panel.activeElement?.id !== "winH") $("winH").value = size.height;
    $("warn").hidden = Math.round(size.width) === Math.round(design.width);
    $("warnText").textContent = `Viewport is ${size.width}px, design is ${Math.round(design.width)}px. Layout may differ at this width.`;
  }

  function render() {
    if (!mounted) return;
    syncFlatten();
    syncViewport();
    renderPanel();
    if (!design) {
      for (const el of [layer, handle, navHost, catcher]) el.remove();
      return;
    }
    renderOverlay();
    renderNavigator();
  }

  // --- moving the design ----------------------------------------------------

  function moveBy(dx, dy) {
    const axes = lockAxes();
    settings.offset.x += dx * axes.x;
    settings.offset.y += dy * axes.y;
    renderOverlay();
    renderNavigator();
  }

  function finishMove() {
    settings.offset.x = Math.round(settings.offset.x);
    settings.offset.y = Math.round(settings.offset.y);
    commit();
  }

  function setPinned(pinned) {
    if (pinned === settings.pinned) return;
    const sign = pinned ? -1 : 1;
    settings.offset.x += sign * scrollX;
    settings.offset.y += sign * scrollY;
    settings.pinned = pinned;
    commit();
  }

  function setMoving(on) {
    if (on === moving) return;
    moving = on;
    if (design && mounted) {
      Object.assign(overlay.style, overlayLook());
      n$("hand").setAttribute("aria-pressed", moving);
    }
  }

  function drag(el, e, { move, end }) {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let last = start;
    let done = false;
    const onMove = (ev) => {
      move({ dx: ev.clientX - last.x, dy: ev.clientY - last.y, total: { x: ev.clientX - start.x, y: ev.clientY - start.y }, ev });
      last = { x: ev.clientX, y: ev.clientY };
    };
    const stop = () => {
      if (done) return;
      done = true;
      for (const [type, fn] of listeners) el.removeEventListener(type, fn);
      end?.();
    };
    const listeners = [["pointermove", onMove], ["pointerup", stop], ["pointercancel", stop], ["lostpointercapture", stop]];
    for (const [type, fn] of listeners) el.addEventListener(type, fn);
  }

  // --- match a point --------------------------------------------------------

  function startMatch() {
    if (match) return cancelMatch();
    setMoving(false);
    match = { phase: "design" };
    render();
    say("1 / 2  Click a sharp spot on the DESIGN (a corner, a letter, an icon edge).  Esc cancels");
  }

  function cancelMatch(message = "") {
    if (!match) return;
    match = null;
    catcher.remove();
    render();
    say(message, message ? 4000 : 0);
  }

  overlay.addEventListener("click", (e) => {
    if (match?.phase !== "design") return;
    const r = overlay.getBoundingClientRect();
    match = { phase: "live", point: { x: e.clientX - r.left, y: e.clientY - r.top } };
    document.documentElement.append(catcher);
    render();
    say("2 / 2  Now click the SAME spot on the live page.  Esc cancels");
  });

  catcher.addEventListener("click", async (e) => {
    const current = match;
    if (current?.phase !== "live") return;
    current.phase = "refining";
    catcher.remove();
    const D = current.point;
    const L = { x: e.clientX, y: e.clientY };
    const axes = lockAxes();
    const before = { ...settings.offset };
    const base = overlayLeft() - settings.offset.x;
    const origin = pageOrigin();
    say("Fine-tuning…");
    const fix = await refine(D, L).catch((err) => ({ error: err.message, dx: 0, dy: 0 }));
    if (match !== current) return;
    if (axes.x) settings.offset.x = L.x - D.x + origin.x - base - fix.dx;
    if (axes.y) settings.offset.y = L.y - D.y + origin.y - fix.dy;
    const moved = `${Math.round(settings.offset.x - before.x)}, ${Math.round(settings.offset.y - before.y)}`;
    cancelMatch(!fix.error
      ? `Matched. Moved ${moved} px (auto fine-tune ${-fix.dx}, ${-fix.dy}).`
      : `Moved ${moved} px. ${fix.error}`);
    saveSettings();
  });

  function grayPatch(image, sx, sy, sw, sh, size) {
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
    const rgba = g.getImageData(0, 0, size, size).data;
    const gray = new Float32Array(size * size);
    for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
    return gray;
  }

  async function captureLivePage() {
    const ours = [layer, handle, panelHost, navHost, banner, catcher];
    const saved = ours.map((el) => el.style.visibility);
    for (const el of ours) el.style.visibility = "hidden";
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    try {
      const shot = await send({ type: "capture" });
      if (!shot?.ok) throw new Error(`Couldn't capture the page: ${shot?.error ?? "no reply"}`);
      return await loadImage(shot.dataUrl);
    } finally {
      ours.forEach((el, i) => (el.style.visibility = saved[i]));
    }
  }

  // Find the shift d (within ±radius) where the design around D+d best matches the live page around L.
  async function refine(D, L) {
    const { patch: P, radius: R, minContrast } = MATCH;
    const shot = await captureLivePage();
    const source = await loadImage(design.src);
    const s = shot.naturalWidth / innerWidth;
    const ds = source.naturalWidth / design.width;
    const cx = Math.min(Math.max(L.x, P / 2), innerWidth - P / 2);
    const cy = Math.min(Math.max(L.y, P / 2), innerHeight - P / 2);
    const dc = { x: D.x + (cx - L.x), y: D.y + (cy - L.y) };

    const live = grayPatch(shot, (cx - P / 2) * s, (cy - P / 2) * s, P * s, P * s, P);
    const mean = live.reduce((a, v) => a + v, 0) / live.length;
    const contrast = Math.sqrt(live.reduce((a, v) => a + (v - mean) ** 2, 0) / live.length);
    if (contrast < minContrast) throw new Error("Spot too plain to fine-tune; pick an edge or text next time.");

    const W = P + 2 * R;
    const des = grayPatch(source, (dc.x - P / 2 - R) * ds, (dc.y - P / 2 - R) * ds, W * ds, W * ds, W);
    const axes = lockAxes();
    const rx = R * axes.x;
    const ry = R * axes.y;
    let best = { dx: 0, dy: 0, cost: Infinity };
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        let cost = 0;
        for (let y = 0; y < P; y++) {
          const row = (y + R + dy) * W + R + dx;
          for (let x = 0; x < P; x++) cost += Math.abs(live[y * P + x] - des[row + x]);
        }
        if (cost < best.cost) best = { dx, dy, cost };
      }
    }
    return best;
  }

  // --- panels: move, minimize, hide the navigator ---------------------------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  function placeBox(box, pos) {
    const r = box.getBoundingClientRect();
    Object.assign(box.style, {
      left: clamp(pos.left, 0, Math.max(0, innerWidth - r.width)) + "px",
      top: clamp(pos.top, 0, Math.max(0, innerHeight - r.height)) + "px",
      right: "auto", bottom: "auto",
    });
  }
  const restoreBox = (box, pos) => pos && box.isConnected && placeBox(box, pos);

  function makeDraggable(box, grip, key) {
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, select")) return;
      const r = box.getBoundingClientRect();
      const grab = { x: e.clientX - r.left, y: e.clientY - r.top };
      drag(grip, e, {
        move: ({ ev }) => placeBox(box, { left: ev.clientX - grab.x, top: ev.clientY - grab.y }),
        end: () => {
          const now = box.getBoundingClientRect();
          ui[key] = { left: now.left, top: now.top };
          saveUi();
        },
      });
    });
  }

  function setMinimized(on) {
    ui.minimized = on;
    saveUi();
    renderChrome();
    restoreBox(panelHost, ui.panel);
  }

  function setNavHidden(hidden) {
    ui.navHidden = hidden;
    saveUi();
    render();
  }

  new ResizeObserver(() => restoreBox(panelHost, ui.panel)).observe(panel.querySelector(".p"));
  new ResizeObserver(() => restoreBox(navHost, ui.nav)).observe(nav.querySelector(".w"));
  makeDraggable(panelHost, $("hdr"), "panel");
  makeDraggable(navHost, n$("bar"), "nav");

  // --- wiring ---------------------------------------------------------------

  const dirInput = Object.assign(document.createElement("input"), { type: "file", webkitdirectory: true });
  const pngInput = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/*" });
  const scale = () => Number($("scale").value);
  $("pickDir").onclick = () => dirInput.click();
  $("pickPng").onclick = () => pngInput.click();
  dirInput.onchange = () => dirInput.files.length && load(designFromFolder(dirInput.files));
  pngInput.onchange = () => pngInput.files[0] && load(designFromPng(pngInput.files[0], scale(), pngInput.files[0].name));
  const dropZone = $("drop");
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("over"); };
  dropZone.ondragleave = () => dropZone.classList.remove("over");
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) load(designFromPng(f, scale(), f.name));
  };

  const pick = (attr, apply) => (e) => {
    const b = e.target.closest(`[${attr}]`);
    if (b) { apply(b.getAttribute(attr)); commit(); }
  };
  $("modes").onclick = pick("data-mode", (v) => (settings.mode = v));
  $("aligns").onclick = pick("data-align", (v) => (settings.align = v));
  n$("locks").onclick = pick("data-lock", (v) => (settings.lock = v));
  n$("steps").onclick = pick("data-step", (v) => (settings.step = Number(v)));
  $("opacity").oninput = (e) => {
    settings.opacity = Number(e.target.value);
    overlay.style.opacity = String(settings.opacity);
    $("opVal").textContent = Math.round(settings.opacity * 100) + "%";
    saveSettings();
  };
  n$("ox").oninput = (e) => { settings.offset.x = Number(e.target.value) || 0; commit(); };
  n$("oy").oninput = (e) => { settings.offset.y = Number(e.target.value) || 0; commit(); };
  n$("reset").onclick = () => { settings.offset = { x: 0, y: 0 }; commit(); };
  $("hide").onclick = () => { settings.hidden = !settings.hidden; commit(); };
  $("viewport").onchange = (e) => { settings.viewport = e.target.value; commit(); };
  $("flatten").onchange = (e) => { settings.flatten = e.target.checked; commit(); };
  $("backdrop").onchange = (e) => { settings.backdrop = e.target.checked; commit(); };
  $("backdropColor").oninput = (e) => { settings.backdropColor = e.target.value; commit(); };
  $("backdropPresets").onclick = pick("data-backdrop", (v) => (settings.backdropColor = v));
  $("remove").onclick = () => removeDesign();
  $("close").onclick = () => toggle();
  $("min").onclick = () => setMinimized(!ui.minimized);
  $("hdr").ondblclick = (e) => { if (!e.target.closest("button")) setMinimized(!ui.minimized); };
  $("navToggle").onclick = () => setNavHidden(!ui.navHidden);
  n$("navHide").onclick = () => setNavHidden(true);
  n$("hand").onclick = () => setMoving(!moving);
  n$("pin").onclick = () => setPinned(!settings.pinned);
  n$("match").onclick = () => startMatch();

  const winInputs = () => [Number($("winW").value) || pageSize().width, Number($("winH").value) || pageSize().height];
  $("winSet").onclick = () => resizeWindowTo(...winInputs());
  for (const id of ["winW", "winH"]) $(id).onkeydown = (e) => { if (e.key === "Enter") resizeWindowTo(...winInputs()); };
  $("resize").onclick = () => resizeWindowTo(Math.round(design.width), pageSize().height);

  for (const label of nav.querySelectorAll(".scrub")) {
    label.addEventListener("pointerdown", (e) => drag(label, e, {
      move: ({ dx, dy, ev }) => {
        const k = ev.shiftKey ? 10 : 1;
        label.dataset.axis === "x" ? moveBy(dx * k, 0) : moveBy(0, dy * k);
      },
      end: finishMove,
    }));
  }
  for (const b of nav.querySelectorAll("[data-dx]")) {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const nudge = () => moveBy(Number(b.dataset.dx) * settings.step, Number(b.dataset.dy) * settings.step);
      nudge();
      let timer = setTimeout(function repeat() { nudge(); timer = setTimeout(repeat, 60); }, 350);
      const stop = () => {
        clearTimeout(timer);
        b.removeEventListener("pointerup", stop);
        b.removeEventListener("pointerleave", stop);
        finishMove();
      };
      b.addEventListener("pointerup", stop);
      b.addEventListener("pointerleave", stop);
    });
  }
  n$("vp").addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const k = thumbScale();
    drag(n$("vp"), e, { move: ({ dx, dy }) => moveBy(-dx / k, -dy / k), end: finishMove });
  });
  n$("thumb").addEventListener("pointerdown", (e) => {
    const k = thumbScale();
    const box = n$("vp").getBoundingClientRect();
    moveBy(-(e.clientX - (box.left + box.width / 2)) / k, -(e.clientY - (box.top + box.height / 2)) / k);
    finishMove();
  });
  overlay.addEventListener("pointerdown", (e) => {
    if (!moving) return;
    overlay.style.cursor = "grabbing";
    drag(overlay, e, {
      move: ({ dx, dy, total, ev }) => {
        if (!ev.shiftKey) return moveBy(dx, dy);
        Math.abs(total.x) >= Math.abs(total.y) ? moveBy(dx, 0) : moveBy(0, dy);
      },
      end: finishMove,
    });
  });
  handle.addEventListener("pointerdown", (e) => drag(handle, e, {
    move: ({ ev }) => {
      settings.swipeX = clamp(ev.clientX / document.documentElement.clientWidth, 0, 1);
      updateScrollBound();
    },
    end: saveSettings,
  }));

  const typing = (e) => e.composedPath().some((el) => el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  const onSpace = (e) => {
    if (e.code !== "Space" || e.altKey || e.metaKey || e.ctrlKey || !design || typing(e)) return;
    e.preventDefault();
    setMoving(e.type === "keydown");
  };

  const onKey = (e) => {
    if (e.code === "Escape" && match) {
      e.preventDefault();
      return cancelMatch();
    }
    if (!e.altKey || !design || typing(e)) return;
    const step = settings.step * (e.shiftKey ? 10 : 1);
    const nudges = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const mode = Object.keys(MODES).find((id) => MODES[id].key === e.code);
    if (nudges[e.code]) moveBy(...nudges[e.code]);
    else if (mode) settings.mode = mode;
    else if (e.code === "KeyH") settings.hidden = !settings.hidden;
    else if (e.code === "KeyN") {
      ui.navHidden = !ui.navHidden;
      saveUi();
    } else return;
    e.preventDefault();
    commit();
  };

  const onLayout = () => {
    render();
    restoreBox(panelHost, ui.panel);
    restoreBox(navHost, ui.nav);
  };
  const onBlur = () => setMoving(false);
  const listeners = [
    ["keydown", onKey, true], ["keydown", onSpace, true], ["keyup", onSpace, true],
    ["resize", onLayout], ["scroll", updateScrollBound, { passive: true }], ["blur", onBlur],
  ];

  function mount() {
    mounted = true;
    document.documentElement.append(panelHost);
    for (const [type, fn, opt] of listeners) window.addEventListener(type, fn, opt);
    render();
    restoreBox(panelHost, ui.panel);
  }

  function teardown() {
    cancelMatch();
    setMoving(false);
    mounted = false;
    syncFlatten();
    for (const el of [panelHost, layer, handle, navHost, catcher, banner]) el.remove();
    for (const [type, fn, opt] of listeners) window.removeEventListener(type, fn, opt);
  }

  function unmount() {
    teardown();
    syncViewport();
  }

  function toggle() {
    mounted ? unmount() : mount();
  }

  const alive = () => Boolean(chrome.runtime?.id);
  window.__designCompare = { toggle, alive };

  // Reloading the extension orphans this script: its chrome.* calls start failing. Clean up and say so.
  const watchdog = setInterval(() => {
    if (alive()) return;
    clearInterval(watchdog);
    teardown();
    delete window.__designCompare;
    say("Design compare was updated. Click its icon again.", 6000);
  }, 1000);

  chrome.storage.local.get([SETTINGS_KEY, DESIGN_KEY, UI_KEY]).then((saved) => {
    const stored = saved[SETTINGS_KEY] ?? {};
    for (const key of Object.keys(settings)) if (key in stored) settings[key] = stored[key];
    design = saved[DESIGN_KEY] ?? null;
    Object.assign(ui, saved[UI_KEY]);
    mount();
  });
})();
