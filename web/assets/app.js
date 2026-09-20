export function connectState(onState, onStatus = () => {}) {
  let socket;
  let retry;
  let offlineTimer;
  let stopped = false;

  const connect = () => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      window.clearTimeout(offlineTimer);
      onStatus("connected");
    });
    socket.addEventListener("message", event => onState(JSON.parse(event.data)));
    socket.addEventListener("close", () => {
      if (stopped) return;
      onStatus("reconnecting");
      window.clearTimeout(offlineTimer);
      offlineTimer = window.setTimeout(() => onStatus("offline"), 5000);
      retry = window.setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => socket.close());
  };

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    window.clearTimeout(offlineTimer);
    socket?.close();
  };
}

export async function saveState(state) {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Unable to save settings");
  return body;
}
