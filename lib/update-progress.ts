// Shared in-memory state for the GitHub download step. Both the download
// route (writer) and the progress route (reader) import this same module, so
// the polling endpoint can report live byte counts without any persistence.
// Reset on every download start; cleared when the server restarts.

export type DownloadProgress = {
  downloaded: number;
  total: number;
  startedAt: number;
};

let state: DownloadProgress | null = null;

export function startDownload(total: number) {
  state = { downloaded: 0, total, startedAt: Date.now() };
}

export function bumpDownload(delta: number) {
  if (state) state.downloaded += delta;
}

export function finishDownload() {
  state = null;
}

export function getDownloadProgress(): DownloadProgress | null {
  return state;
}
