export function playbackProgress(state, now = new Date()) {
  let progress = Number(state.playback_position) || 0;
  if (state.playback_running && state.playback_started_at) {
    const elapsed = Math.max(0, now.getTime() - new Date(state.playback_started_at).getTime());
    progress += elapsed / (state.playback_duration_seconds * 1000);
  }
  if (state.playback_loop) return ((progress % 1) + 1) % 1;
  return Math.max(0, Math.min(1, progress));
}

export function displayTimestamp(state, snapshot, now = new Date()) {
  if (state?.wspr_mode !== "historical" || !snapshot?.fetched_at) return now;
  const windowEnd = new Date(snapshot.fetched_at);
  const windowStart = new Date(windowEnd.getTime() - state.history_hours * 3_600_000);
  return new Date(windowStart.getTime() + playbackProgress(state, now) * (windowEnd - windowStart));
}
