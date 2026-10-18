const $ = selector => document.querySelector(selector);
let recentItems = [];
let activeItems = [];
let refreshTimer = null;
let messageTimer;
let requestSequence = 0;
let stateRequestSequence = 0;
let progressPollInFlight = false;
const COMPLETE_COUNT_LIMIT = 501;
const speedSamples = new Map();

function say(message, error = false) {
  const node = $('#popup-message');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.add('visible');
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => node.classList.remove('visible'), 2400);
}

function readableBytes(value) {
  if (value == null || value < 0) return '—';
  if (value < 1000) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1000, unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit++; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function basename(path) {
  return (path || '').split(/[\\/]/).pop() || 'Untitled download';
}

function kindOf(item) {
  if (item.state === 'complete') return 'complete';
  if (item.state === 'interrupted') return 'interrupted';
  if (item.paused) return 'paused';
  return 'active';
}

function percent(item) {
  if (item.state === 'complete') return 100;
  if (!item.totalBytes || item.totalBytes < 1) return 0;
  return Math.max(0, Math.min(100, item.bytesReceived / item.totalBytes * 100));
}

function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return 'Measuring';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let amount = rate, unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function rateLabel(item) {
  if (item.state !== 'in_progress' || item.paused) return item.paused ? 'Paused' : '—';
  return formatRate(speedSamples.get(item.id)?.rate ?? null);
}

function etaLabel(item) {
  if (kindOf(item) !== 'active') return '';
  const rate = speedSamples.get(item.id)?.rate;
  if (!(item.totalBytes > 0) || !Number.isFinite(rate) || rate < 1) return 'ETA —';
  const remaining = Math.max(0, item.totalBytes - Math.max(0, item.bytesReceived || 0));
  if (remaining === 0) return 'Finishing…';
  const seconds = Math.ceil(remaining / rate);
  if (seconds < 60) return `ETA ${seconds}s`;
  if (seconds < 3600) return `ETA ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `ETA ${hours}h ${minutes}m` : `ETA ${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `ETA ${days}d ${hours}h`;
}

function totalRateLabel() {
  const running = activeItems.filter(item => !item.paused);
  if (!running.length) return '—';
  const rates = running.map(item => speedSamples.get(item.id)?.rate);
  if (rates.some(rate => !Number.isFinite(rate))) return 'Measuring';
  return formatRate(rates.reduce((sum, rate) => sum + rate, 0));
}

function rememberSpeeds(active) {
  const now = performance.now();
  const activeIds = new Set();
  for (const item of active) {
    activeIds.add(item.id);
    const previous = speedSamples.get(item.id);
    let rate = null;
    if (!item.paused && previous && !previous.paused && now > previous.time && item.bytesReceived >= previous.bytes) {
      const measured = (item.bytesReceived - previous.bytes) * 1000 / (now - previous.time);
      rate = previous.rate == null ? measured : previous.rate * 0.35 + measured * 0.65;
    }
    speedSamples.set(item.id, {bytes:item.bytesReceived, time:now, rate, paused:item.paused});
  }
  for (const id of speedSamples.keys()) if (!activeIds.has(id)) speedSamples.delete(id);
}

function button(icon, label, action, id, danger = false) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `row-action${danger ? ' danger' : ''}`;
  node.title = label;
  node.setAttribute('aria-label', label);
  node.append(SteelBallIcons.create(icon));
  node.addEventListener('click', () => runAction(action, id));
  return node;
}

async function runAction(action, id) {
  const item = recentItems.find(entry => entry.id === id) || activeItems.find(entry => entry.id === id);
  try {
    if (action === 'pause') await chrome.downloads.pause(id);
    if (action === 'resume') await chrome.downloads.resume(id);
    if (action === 'cancel') await chrome.downloads.cancel(id);
    if (action === 'show') chrome.downloads.show(id);
    if (action === 'erase') {
      await chrome.downloads.erase({id});
      say('History entry cleared. The file stays on your device.');
    }
    if (action === 'retry' && item) {
      const filename = item.filename ? basename(item.filename) : '';
      await chrome.downloads.download({url:item.finalUrl || item.url, ...(filename ? {filename} : {}), conflictAction:'uniquify'});
      say('Download started again.');
    }
    await refresh();
  } catch (error) {
    say(error.message || 'That action could not be completed.', true);
  }
}

function render() {
  const list = $('#popup-list');
  list.replaceChildren();
  $('#total-speed').textContent = totalRateLabel();
  $('#total-speed').setAttribute('aria-label', `Combined active download speed: ${$('#total-speed').textContent}`);
  const count = new Map(recentItems.map(item => [item.id, item]));
  for (const item of activeItems) count.set(item.id, item);
  const combined = [...count.values()].sort((a,b) => (b.startTime || '').localeCompare(a.startTime || '')).slice(0, 10);
  const activeCount = activeItems.length;
  const completedCount = Number($('#complete-count').dataset.value || 0);
  $('#active-count').textContent = activeCount;
  $('#complete-count').textContent = completedCount > COMPLETE_COUNT_LIMIT - 1 ? `${COMPLETE_COUNT_LIMIT - 1}+` : completedCount;
  $('#clear-completed').disabled = completedCount === 0;

  if (!combined.length) {
    const empty = document.createElement('div');
    empty.className = 'popup-empty';
    const ball = document.createElement('img');
    ball.src = chrome.runtime.getURL('assets/steel-ball.svg');
    ball.alt = '';
    const text = document.createElement('span');
    text.textContent = 'No downloads yet. Start one in Chrome and it will appear here.';
    empty.append(ball, text);
    list.append(empty);
    syncPolling();
    return;
  }

  for (const item of combined) {
    const state = kindOf(item);
    const progress = percent(item);
    const row = document.createElement('article');
    row.className = 'download-row';
    const icon = document.createElement('div');
    icon.className = 'row-icon';
    const orb = document.createElement('img');
    orb.className = 'download-orb';
    orb.src = chrome.runtime.getURL('assets/steel-ball.svg');
    orb.alt = '';
    icon.append(orb);
    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = basename(item.filename || item.url);
    name.title = name.textContent;
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const amount = document.createElement('span');
    amount.textContent = item.totalBytes > 0 ? `${readableBytes(item.bytesReceived)} / ${readableBytes(item.totalBytes)}` : (item.totalBytes === 0 && state === 'complete' ? readableBytes(item.totalBytes) : state === 'paused' ? 'PAUSED' : state === 'interrupted' ? 'INTERRUPTED' : 'CONNECTING');
    const rate = document.createElement('span');
    rate.className = 'download-rate';
    rate.textContent = rateLabel(item);
    rate.title = 'Estimated speed from recent progress';
    rate.setAttribute('aria-label', `Estimated download speed: ${rate.textContent}`);
    const pct = document.createElement('span');
    pct.textContent = state === 'complete' ? 'DONE' : item.totalBytes > 0 ? `${Math.round(progress)}%` : '';
    meta.append(amount, rate, pct);
    main.append(name, meta);
    if (state === 'active') {
      const eta = document.createElement('span');
      eta.className = 'row-eta';
      eta.textContent = etaLabel(item);
      eta.title = 'Estimated remaining time based on recent speed';
      main.append(eta);
    }
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (state === 'active') actions.append(button('pause', 'Pause download', 'pause', item.id));
    if (state === 'paused') actions.append(button('play', 'Resume download', 'resume', item.id));
    if (state === 'interrupted') actions.append(button('retry', 'Try again', 'retry', item.id));
    if (state === 'active' || state === 'paused') actions.append(button('cancel', 'Cancel download', 'cancel', item.id, true));
    if (state === 'complete') actions.append(button('open-folder', 'Show in folder', 'show', item.id));
    row.append(icon, main, actions);
    const track = document.createElement('div');
    track.className = `row-progress${state === 'complete' ? ' complete' : ''}`;
    const fill = document.createElement('span');
    fill.style.width = `${progress}%`;
    track.append(fill);
    row.append(track);
    list.append(row);
  }
  syncPolling();
}

function syncPolling() {
  if (activeItems.some(item => !item.paused) && refreshTimer === null) {
    refreshTimer = setInterval(refreshProgress, 1400);
  } else if (!activeItems.some(item => !item.paused) && refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function refreshProgress() {
  if (document.visibilityState !== 'visible' || progressPollInFlight) return;
  progressPollInFlight = true;
  const sequence = ++stateRequestSequence;
  try {
    const [recent, active] = await Promise.all([
      chrome.downloads.search({orderBy:['-startTime'],limit:12}),
      chrome.downloads.search({state:'in_progress',limit:0})
    ]);
    if (sequence !== stateRequestSequence) return;
    rememberSpeeds(active);
    recentItems = recent;
    activeItems = active;
    render();
  } catch { /* A fresh popup open or the toolbar refresh action can retry. */ }
  finally { progressPollInFlight = false; }
}

async function refresh() {
  const sequence = ++requestSequence;
  const stateSequence = ++stateRequestSequence;
  try {
    const [recent, active, complete] = await Promise.all([
      chrome.downloads.search({orderBy:['-startTime'],limit:12}),
      chrome.downloads.search({state:'in_progress',limit:0}),
      // A bounded query keeps opening the popup fast even with years of history.
      chrome.downloads.search({state:'complete',limit:COMPLETE_COUNT_LIMIT})
    ]);
    if (sequence !== requestSequence) return true;
    $('#complete-count').dataset.value = String(complete.length);
    $('#complete-count').textContent = complete.length > COMPLETE_COUNT_LIMIT - 1 ? `${COMPLETE_COUNT_LIMIT - 1}+` : complete.length;
    $('#complete-count').title = complete.length > COMPLETE_COUNT_LIMIT - 1
      ? `At least ${COMPLETE_COUNT_LIMIT - 1} completed downloads. Clear removes all completed entries.`
      : `${complete.length} completed downloads`;
    if (stateSequence !== stateRequestSequence) {
      render();
      return true;
    }
    rememberSpeeds(active);
    recentItems = recent;
    activeItems = active;
    render();
    return true;
  } catch (error) {
    if (sequence === requestSequence) {
      say(error.message || 'Could not read download history.', true);
      return false;
    }
    return false;
  }
}

$('#open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')});
  window.close();
});

$('#open-downloads-folder').addEventListener('click', () => {
  try {
    chrome.downloads.showDefaultFolder();
    say('Opened Chrome downloads folder.');
  } catch (error) {
    say(error.message || 'Could not open Chrome downloads folder.', true);
  }
});

$('#clear-completed').addEventListener('click', async () => {
  const button = $('#clear-completed');
  button.disabled = true;
  try {
    const erased = await chrome.downloads.erase({state:'complete'});
    $('#complete-count').dataset.value = '0';
    $('#complete-count').textContent = '0';
    const refreshed = await refresh();
    if (refreshed) say(`${erased.length} finished entr${erased.length === 1 ? 'y' : 'ies'} cleared. Files stay on your device.`);
    else say(`${erased.length} finished entr${erased.length === 1 ? 'y' : 'ies'} cleared, but the list could not refresh.`, true);
  } catch (error) {
    say(error.message || 'Could not clear completed history.', true);
    button.disabled = false;
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'downloads-changed') refresh();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
  else {
    stateRequestSequence++;
    if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
    speedSamples.clear();
  }
});
refresh();
