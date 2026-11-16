async function openOrToggle(tab) {
  const [{ result: alive }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const dc = window.__designCompare;
      if (dc && typeof dc.alive === "function" && dc.alive()) return true;
      delete window.__designCompare;
      return false;
    },
  });
  if (alive) await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__designCompare.toggle() });
  else await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
}

chrome.action.onClicked.addListener((tab) => {
  openOrToggle(tab).catch(async () => {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "✕" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Design compare can't run on this page" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 3000);
  });
});

// Emulation belongs to the page it was set on: drop it when the tab navigates or reloads.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") chrome.debugger.detach({ tabId }).catch(() => {});
});

async function emulate(tabId, width, height) {
  const target = { tabId };
  if (!width) {
    await chrome.debugger.detach(target).catch(() => {});
    return {};
  }
  await chrome.debugger.attach(target, "1.3").catch(() => {});
  await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 0, mobile: width < 600,
  });
  return {};
}

async function resizeWindow(windowId, target, current, avail) {
  const win = await chrome.windows.get(windowId);
  if (win.state !== "normal") {
    await chrome.windows.update(windowId, { state: "normal" });
    return { state: win.state };
  }
  const width = Math.min(target.width + win.width - current.width, avail.width);
  const height = Math.min(target.height + win.height - current.height, avail.height);
  await chrome.windows.update(windowId, {
    state: "normal",
    width,
    height,
    left: Math.max(avail.left, Math.min(win.left, avail.left + avail.width - width)),
    top: Math.max(avail.top, Math.min(win.top, avail.top + avail.height - height)),
  });
  return { state: "normal" };
}

const handlers = {
  capture: (msg, sender) => chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then((dataUrl) => ({ dataUrl })),
  emulate: (msg, sender) => emulate(sender.tab.id, msg.width, msg.height),
  "resize-window": (msg, sender) => resizeWindow(sender.tab.windowId, msg.target, msg.current, msg.avail),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler || !sender.tab) return;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => reply({ ok: true, ...result }), (e) => reply({ ok: false, error: e?.message ?? String(e) }));
  return true;
});
