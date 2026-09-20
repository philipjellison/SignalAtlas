const endpoint = process.argv[2] || "http://127.0.0.1:9222";
const targets = await fetch(`${endpoint}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === "page" && item.url.includes("127.0.0.1:3000"));
if (!target) throw new Error("SignalAtlas page target not found");
const socketUrl = target.webSocketDebuggerUrl.replace("127.0.0.1:9222", new URL(endpoint).host);
const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await command("Page.enable");
await command("Runtime.enable");
await command("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__signalAtlasLongTasks = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__signalAtlasLongTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });`,
});

const started = Date.now();
await command("Page.reload", { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 20_000));
const result = await command("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => ({
    elapsedMs: performance.now(),
    clock: document.querySelector("#utc-time")?.textContent,
    mapStyle: document.querySelector("#style-name")?.textContent,
    terminatorTimestamp: document.querySelector("#terminator")?.dataset.timestamp,
    canvases: [...document.querySelectorAll("canvas")].map(canvas => ({ id: canvas.id, width: canvas.width, height: canvas.height })),
    resources: performance.getEntriesByType("resource").map(entry => ({ name: entry.name.split("/").pop(), duration: Math.round(entry.duration), bytes: entry.transferSize })),
    longTasks: window.__signalAtlasLongTasks || [],
    heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null,
  }))()`,
});
console.log(JSON.stringify({ wallMs: Date.now() - started, ...result.result.value }, null, 2));
socket.close();
