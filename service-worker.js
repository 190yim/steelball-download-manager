function notifyDashboard(kind, id) {
  chrome.runtime.sendMessage({type:'downloads-changed',kind,id}, () => { void chrome.runtime.lastError; });
}
chrome.downloads.onCreated.addListener((item) => notifyDashboard('created', item.id));
chrome.downloads.onChanged.addListener((delta) => {
  // Byte progress is polled by the open popup/dashboard; only send state changes.
  if (delta.state || delta.paused || delta.error || delta.danger || delta.filename) {
    notifyDashboard('changed', delta.id);
  }
});
chrome.downloads.onErased.addListener((id) => notifyDashboard('erased', id));
