const $ = (selector) => document.querySelector(selector);
const PAGE_SIZE = 100;
let items = [];
let activeFilter = 'all';
let activeDownloads = [];
let toastTimer;
let progressTimer = null;
let progressPollInFlight = false;
let refreshSequence = 0;
let nextPageBefore = null;
let hasMorePages = false;
let loadingOlder = false;
let historyMutationInProgress = false;
const speedSamples = new Map();
const selectedIds = new Set();

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 2600);
}

function setRefreshIndicator(refreshing) {
  const button = $('#refresh-button');
  button.classList.toggle('is-refreshing', refreshing);
  button.title = refreshing ? 'Refreshing downloads…' : 'Refresh downloads';
  button.setAttribute('aria-label', refreshing ? 'Refreshing downloads' : 'Refresh downloads');
  if (refreshing) {
    const ball = document.createElement('img');
    ball.className = 'refresh-ball';
    ball.src = 'assets/steel-ball-green.svg';
    ball.alt = '';
    ball.setAttribute('aria-hidden', 'true');
    button.replaceChildren(ball);
  } else {
    button.replaceChildren(SteelBallIcons.create('refresh'));
  }
}

function setRefreshStatus(state, message, title = message) {
  const status = $('#refresh-status');
  status.dataset.state = state;
  status.textContent = message;
  status.title = title;
}

function bytes(value) {
  if (value == null || value < 0) return '—';
  if (value < 1000) return `${value} B`;
  const units = ['KB','MB','GB','TB'];
  let amount = value / 1000, unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function statusOf(item) {
  if (item.state === 'complete') return {label:'Completed',kind:'complete'};
  if (item.state === 'interrupted') return {label:'Interrupted',kind:'interrupted'};
  if (item.paused) return {label:'Paused',kind:'paused'};
  return {label:'Downloading',kind:'in_progress'};
}

function extensionOf(item) {
  let name = item.filename || '';
  if (!name) {
    try { name = new URL(item.url).pathname; }
    catch { name = (item.url || '').split(/[?#]/, 1)[0]; }
  }
  const leaf = name.split(/[\\/]/).pop() || '';
  const lowerLeaf = leaf.toLowerCase();
  for (const compound of ['tar.bz2','tar.gz','tar.xz','tar.zst','tar.br']) {
    if (lowerLeaf.endsWith(`.${compound}`)) return compound.toUpperCase();
  }
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0 || dot === leaf.length - 1) return 'FILE';
  return leaf.slice(dot + 1).toUpperCase();
}

function sourceOf(item) {
  try { return new URL(item.url).hostname; } catch { return item.url || 'Unknown source'; }
}

function percentOf(item) {
  if (item.state === 'complete') return 100;
  if (!item.totalBytes || item.totalBytes < 1) return 0;
  return Math.max(0, Math.min(100, item.bytesReceived / item.totalBytes * 100));
}

function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return 'Measuring';
  const units = ['B/s','KB/s','MB/s','GB/s'];
  let amount = rate, unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function rateLabel(item) {
  if (item.state !== 'in_progress' || item.paused) return item.paused ? 'Paused' : '—';
  return formatRate(speedSamples.get(item.id)?.rate ?? null);
}

function etaLabel(item) {
  if (item.state !== 'in_progress' || item.paused) return '';
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

function totalRateLabel(active) {
  const running = active.filter(item => item.state === 'in_progress' && !item.paused);
  if (!running.length) return '—';
  const rates = running.map(item => speedSamples.get(item.id)?.rate);
  if (rates.some(rate => !Number.isFinite(rate))) return 'Measuring';
  return formatRate(rates.reduce((sum, rate) => sum + rate, 0));
}

function updateTotalSpeed() {
  const node = $('#total-speed');
  node.textContent = totalRateLabel(activeDownloads);
  node.setAttribute('aria-label', `Combined active download speed: ${node.textContent}`);
}

function isSelectable(item) {
  return item.state === 'complete' || item.state === 'interrupted';
}

function matchesDate(item, range) {
  if (range === 'all') return true;
  const started = Date.parse(item.startTime || '');
  if (!Number.isFinite(started)) return false;
  const now = Date.now();
  if (range === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return started >= today.getTime();
  }
  const days = range === '7days' ? 7 : 30;
  return started >= now - days * 24 * 60 * 60 * 1000;
}

function updateTypeOptions() {
  const select = $('#type-filter');
  const previous = select.value || 'all';
  const types = [...new Set(items.map(extensionOf))].sort((a, b) => a.localeCompare(b));
  const options = [new Option('All types', 'all'), ...types.map(type => new Option(type, type))];
  select.replaceChildren(...options);
  select.value = types.includes(previous) ? previous : 'all';
}

function updateBulkControls(visible) {
  const eligible = visible.filter(isSelectable);
  const selectedVisible = eligible.filter(item => selectedIds.has(item.id)).length;
  const selectVisible = $('#select-visible');
  selectVisible.disabled = eligible.length === 0 || historyMutationInProgress;
  selectVisible.checked = eligible.length > 0 && selectedVisible === eligible.length;
  selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < eligible.length;
  $('#selected-count').textContent = `${selectedIds.size} selected`;
  $('#remove-selected-button').disabled = selectedIds.size === 0 || historyMutationInProgress;
  $('#clear-completed-button').disabled = historyMutationInProgress;
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

function filteredItems() {
  const term = $('#search-input').value.trim().toLowerCase();
  const sort = $('#sort-select').value;
  const type = $('#type-filter').value;
  const date = $('#date-filter').value;
  let visible = items.filter(item => {
    const state = statusOf(item).kind;
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'in_progress' ? ['in_progress','paused'].includes(state) : state === activeFilter);
    const matchesType = type === 'all' || extensionOf(item) === type;
    const haystack = `${item.filename || ''} ${item.url || ''} ${sourceOf(item)}`.toLowerCase();
    return matchesFilter && matchesType && matchesDate(item, date) && (!term || haystack.includes(term));
  });
  visible.sort((a,b) => {
    if (sort === 'oldest') return (a.startTime || '').localeCompare(b.startTime || '');
    if (sort === 'name') return (a.filename || '').localeCompare(b.filename || '', undefined, {sensitivity:'base'});
    if (sort === 'size') return (b.totalBytes || 0) - (a.totalBytes || 0);
    return (b.startTime || '').localeCompare(a.startTime || '');
  });
  return visible;
}

function updateCounts() {
  const counts = {all:items.length,in_progress:0,complete:0,interrupted:0};
  for (const item of items) {
    const kind = statusOf(item).kind;
    if (kind === 'in_progress' || kind === 'paused') counts.in_progress++;
    else counts[kind]++;
  }
  $('#count-all').textContent = `${counts.all}${hasMorePages ? '+' : ''}`;
  $('#count-active').textContent = counts.in_progress;
  $('#count-complete').textContent = counts.complete;
  $('#count-interrupted').textContent = counts.interrupted;
  $('#item-count').textContent = `${counts.all}${hasMorePages ? '+' : ''}`;
  $('#history-note').textContent = hasMorePages
    ? `Showing the newest ${items.length} downloads. Search, filters, and sorting use loaded entries; load older entries below.`
    : `Showing all ${items.length} downloads in Chrome history.`;
}

function updateProgressCard(item) {
  const card = document.querySelector(`.download-card[data-download-id="${item.id}"]`);
  if (!card) return;
  const amount = card.querySelector('[data-progress-amount]');
  const percent = card.querySelector('[data-progress-percent]');
  const rate = card.querySelector('[data-download-rate]');
  const track = card.querySelector('[role="progressbar"]');
  const fill = card.querySelector('[data-progress-fill]');
  const progress = percentOf(item);
  if (amount) amount.textContent = `${bytes(item.bytesReceived)}${item.totalBytes > 0 ? ` / ${bytes(item.totalBytes)}` : ''}`;
  if (percent) percent.textContent = item.totalBytes > 0 ? `${Math.round(progress)}%` : (item.paused ? '—' : '…');
  if (rate) {
    rate.textContent = rateLabel(item);
    rate.setAttribute('aria-label', `Estimated download speed: ${rate.textContent}`);
  }
  const eta = card.querySelector('[data-download-eta]');
  if (eta) eta.textContent = etaLabel(item);
  if (track) track.setAttribute('aria-valuenow', String(Math.round(progress)));
  if (fill) fill.style.width = `${progress}%`;
}

function syncProgressPolling() {
  const shouldPoll = document.visibilityState === 'visible' && activeDownloads.some(item => item.state === 'in_progress' && !item.paused);
  if (shouldPoll && progressTimer === null) {
    progressTimer = setInterval(refreshProgress, 1200);
  } else if (!shouldPoll && progressTimer !== null) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

async function refreshProgress() {
  if (progressPollInFlight) return;
  progressPollInFlight = true;
  try {
    // This query is limited to currently running downloads; it does not scan history.
    const active = await chrome.downloads.search({state:'in_progress',limit:0});
    activeDownloads = active;
    rememberSpeeds(active);
    const activeIds = new Set(active.map(item => item.id));
    for (const id of selectedIds) if (activeIds.has(id)) selectedIds.delete(id);
    updateTotalSpeed();
    syncProgressPolling();
    let stateChanged = false;
    for (const latest of active) {
      const current = items.find(item => item.id === latest.id);
      if (!current) continue;
      current.bytesReceived = latest.bytesReceived;
      current.totalBytes = latest.totalBytes;
      updateProgressCard(current);
    }
    const finished = items.filter(item => item.state === 'in_progress' && !activeIds.has(item.id));
    if (finished.length) {
      const latestItems = await Promise.all(finished.map(item => chrome.downloads.search({id:item.id})));
      for (const [index, result] of latestItems.entries()) {
        const current = items.find(item => item.id === finished[index].id);
        if (!current) continue;
        if (result[0]) Object.assign(current, result[0]);
        else items = items.filter(item => item.id !== current.id);
        stateChanged = true;
      }
    }
    if (stateChanged) render();
  } catch {
    // The regular download events and manual refresh remain available if a progress poll fails.
  } finally {
    progressPollInFlight = false;
  }
}

function actionButton(iconName, title, action, id, danger = false) {
  const button = document.createElement('button');
  button.className = `action-button${danger ? ' danger' : ''}`;
  button.type = 'button'; button.title = title; button.setAttribute('aria-label',title);
  button.append(SteelBallIcons.create(iconName));
  button.addEventListener('click', () => perform(action,id));
  return button;
}

async function perform(action,id) {
  const item = items.find(entry => entry.id === id);
  try {
    if (action === 'pause') await chrome.downloads.pause(id);
    if (action === 'resume') await chrome.downloads.resume(id);
    if (action === 'cancel') await chrome.downloads.cancel(id);
    if (action === 'show') chrome.downloads.show(id);
    if (action === 'erase') {
      await chrome.downloads.erase({id});
      toast('Removed from download history. The file stays on your device.');
    }
    if (action === 'retry' && item) {
      const filename = (item.filename || '').split(/[\\/]/).pop();
      await chrome.downloads.download({url:item.finalUrl || item.url, ...(filename ? {filename} : {}), conflictAction:'uniquify'});
      toast('Download started again.');
    }
  } catch(error) { toast(error.message || 'That action could not be completed.',true); }
}

function render() {
  updateCounts();
  syncProgressPolling();
  updateTotalSpeed();
  updateTypeOptions();
  const list = $('#download-list');
  list.replaceChildren();
  const visible = filteredItems();
  updateBulkControls(visible);
  if (!visible.length) {
    const unfiltered = activeFilter === 'all' && !$('#search-input').value && $('#type-filter').value === 'all' && $('#date-filter').value === 'all';
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const icon = document.createElement('div'); icon.className = 'empty-illustration'; icon.append(SteelBallIcons.create(unfiltered ? 'sparkle' : 'search'));
    const title = document.createElement('h3'); title.textContent = unfiltered ? 'The trail is clear.' : 'No downloads found.';
    const message = document.createElement('p'); message.textContent = unfiltered ? 'Downloads started in Chrome will appear here.' : 'Try another filter or search term.';
    empty.append(icon,title,message); list.append(empty);
    appendLoadOlderButton(list);
    return;
  }
  for (const item of visible) {
    const status = statusOf(item), percent = percentOf(item);
    const card = document.createElement('article'); card.className = 'download-card';
    card.dataset.downloadId = String(item.id);
    const badge = document.createElement('div'); badge.className = 'file-badge'; badge.dataset.tone = String(item.id % 4); badge.title=`${extensionOf(item)} file`;
    const orb = document.createElement('img'); orb.className='download-orb'; orb.src='assets/steel-ball.svg'; orb.alt=''; orb.setAttribute('aria-hidden','true'); badge.append(orb);
    const main = document.createElement('div'); main.className = 'file-main';
    const filename = document.createElement(item.state === 'complete' ? 'button' : 'span');
    filename.className = 'filename'; filename.textContent = (item.filename || item.url || 'Untitled download').split(/[\\/]/).pop();
    if (item.state === 'complete') { filename.type='button'; filename.title='Show in folder'; filename.style.cssText='border:0;padding:0;background:none;text-align:left;cursor:pointer;font:inherit'; filename.addEventListener('click',()=>perform('show',item.id)); }
    const source = document.createElement('span'); source.className='file-source'; source.textContent=sourceOf(item);
    main.append(filename,source);
    const progress = document.createElement('div'); progress.className='progress-area';
    const meta = document.createElement('div'); meta.className='progress-meta';
    const amount = document.createElement('span'); amount.dataset.progressAmount=''; amount.textContent=`${bytes(item.bytesReceived)}${item.totalBytes > 0 ? ` / ${bytes(item.totalBytes)}` : ''}`;
    const rate = document.createElement('span'); rate.className='download-rate'; rate.dataset.downloadRate=''; rate.textContent=rateLabel(item); rate.title='Estimated speed from recent progress'; rate.setAttribute('aria-label',`Estimated download speed: ${rate.textContent}`);
    const pct = document.createElement('span'); pct.dataset.progressPercent=''; pct.textContent=item.state==='complete'?'100%':item.totalBytes>0?`${Math.round(percent)}%`:(item.paused?'—':'…');
    meta.append(amount,rate,pct);
    const track=document.createElement('div');track.className='progress-track';track.setAttribute('role','progressbar');track.setAttribute('aria-label',`Download progress: ${(item.filename || 'file').split(/[\\/]/).pop()}`);track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(Math.round(percent)));const fill=document.createElement('div');fill.className=`progress-fill${status.kind==='interrupted'?' danger':item.state==='complete'?' complete':''}`;fill.dataset.progressFill='';fill.style.width=`${percent}%`;track.append(fill);
    const state=document.createElement('div');state.className='file-state';
    const stateIcon=item.danger&&item.danger!=='safe'?'warning':status.kind==='complete'?'check':status.kind==='paused'?'pause':status.kind==='interrupted'?'warning':'download';
    state.append(SteelBallIcons.create(stateIcon));
    const stateText=document.createElement('span');stateText.textContent=(item.danger&&item.danger!=='safe'?'Chrome safety warning · ':'')+status.label+(item.error?` · ${item.error.replace(/^NETWORK_/, '').replaceAll('_',' ').toLowerCase()}`:'');state.append(stateText);
    if (item.state === 'in_progress') {
      const eta=document.createElement('span');eta.className='download-eta';eta.dataset.downloadEta='';eta.textContent=etaLabel(item);eta.title='Estimated remaining time based on recent speed';state.append(eta);
    }
    progress.append(meta,track,state);
    const actions=document.createElement('div');actions.className='card-actions';
    if (isSelectable(item)) {
      const selection=document.createElement('input');selection.type='checkbox';selection.className='bulk-select';selection.checked=selectedIds.has(item.id);selection.disabled=historyMutationInProgress;selection.title='Select for bulk removal from history';selection.setAttribute('aria-label',`Select ${filename.textContent} for removal from history`);
      selection.addEventListener('change',()=>{if(selection.checked)selectedIds.add(item.id);else selectedIds.delete(item.id);render();});
      actions.append(selection);
    }
    if(item.state==='in_progress'&&!item.paused) actions.append(actionButton('pause','Pause download','pause',item.id));
    if(item.state==='in_progress'&&item.paused) actions.append(actionButton('play','Resume download','resume',item.id));
    if(item.state==='interrupted') actions.append(actionButton('retry','Try again','retry',item.id));
    if(item.state==='in_progress') actions.append(actionButton('cancel','Cancel download','cancel',item.id,true));
    if(item.state==='complete') actions.append(actionButton('open-folder','Show in folder','show',item.id));
    actions.append(actionButton('minus','Remove from history (keeps the file)','erase',item.id));
    card.append(badge,main,progress,actions);list.append(card);
  }
  appendLoadOlderButton(list);
}

function appendLoadOlderButton(list) {
  if (!hasMorePages) return;
  const more = document.createElement('button');
  more.className = 'load-more-button';
  more.type = 'button';
  more.disabled = loadingOlder;
  more.textContent = loadingOlder ? 'Loading older downloads…' : 'Load older downloads';
  more.addEventListener('click', loadOlder);
  list.append(more);
}

async function refresh() {
  const sequence = ++refreshSequence;
  const visualStartedAt = performance.now();
  let refreshed = false;
  let refreshError = '';
  let updatedAt = null;
  setRefreshIndicator(true);
  setRefreshStatus('refreshing', 'REFRESHING…', 'Refreshing Chrome download history…');
  loadingOlder = false;
  try {
    const [latest, active] = await Promise.all([
      chrome.downloads.search({orderBy:['-startTime'],limit:PAGE_SIZE + 1}),
      chrome.downloads.search({state:'in_progress',limit:0})
    ]);
    if (sequence !== refreshSequence) return;
    items = latest.slice(0, PAGE_SIZE);
    activeDownloads = active;
    for (const id of selectedIds) if (active.some(item => item.id === id)) selectedIds.delete(id);
    rememberSpeeds(active);
    hasMorePages = latest.length > PAGE_SIZE;
    nextPageBefore = items.length ? items[items.length - 1].startTime : null;
    render();
    updatedAt = new Date();
    refreshed = true;
  } catch(error) {
    if (sequence === refreshSequence) {
      refreshError = error.message || 'Could not read downloads.';
      toast(refreshError, true);
    }
  } finally {
    if (sequence === refreshSequence) {
      const remaining = Math.max(0, 700 - (performance.now() - visualStartedAt));
      if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
      if (sequence === refreshSequence) {
        setRefreshIndicator(false);
        if (refreshed && updatedAt) {
          const time = updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false});
          setRefreshStatus('updated', `UPDATED AT ${time}`, `Download list last refreshed at ${updatedAt.toLocaleString()}.`);
        } else if (refreshError) {
          setRefreshStatus('error', 'UPDATE FAILED', refreshError);
        }
      }
    }
  }
}

async function loadOlder() {
  if (loadingOlder || !hasMorePages || !nextPageBefore) return;
  const sequence = refreshSequence;
  const boundaryTime = nextPageBefore;
  loadingOlder = true;
  render();
  try {
    const [page, boundaryItems] = await Promise.all([
      chrome.downloads.search({
        orderBy:['-startTime'],
        startedBefore: boundaryTime,
        limit: PAGE_SIZE + 1
      }),
      // startedBefore is strict: also fetch every item at the cursor time so
      // downloads with identical startTime values cannot disappear between pages.
      chrome.downloads.search({startTime:boundaryTime,limit:0})
    ]);
    if (sequence !== refreshSequence) return;
    const visiblePage = page.slice(0, PAGE_SIZE);
    const existingIds = new Set(items.map(item => item.id));
    items.push(...[...boundaryItems, ...visiblePage].filter(item => !existingIds.has(item.id)));
    hasMorePages = page.length > PAGE_SIZE;
    nextPageBefore = visiblePage.length ? visiblePage[visiblePage.length - 1].startTime : null;
    if (!visiblePage.length) hasMorePages = false;
  } catch(error) {
    if (sequence === refreshSequence) toast(error.message || 'Could not load older downloads.',true);
  } finally {
    if (sequence === refreshSequence) {
      loadingOlder = false;
      render();
    }
  }
}

$('#clear-completed-button').addEventListener('click', async () => {
  const button = $('#clear-completed-button');
  if (historyMutationInProgress) return;
  historyMutationInProgress = true;
  updateBulkControls(filteredItems());
  button.disabled = true;
  try {
    const erased = await chrome.downloads.erase({state:'complete'});
    await refresh();
    toast(`${erased.length} completed ${erased.length === 1 ? 'entry' : 'entries'} cleared. Files stay on your device.`);
  } catch (error) {
    toast(error.message || 'Could not clear completed history.', true);
  } finally {
    historyMutationInProgress = false;
    button.disabled = false;
    render();
  }
});
$('#select-visible').addEventListener('change', event => {
  const eligible = filteredItems().filter(isSelectable);
  for (const item of eligible) {
    if (event.target.checked) selectedIds.add(item.id);
    else selectedIds.delete(item.id);
  }
  render();
});
$('#remove-selected-button').addEventListener('click', async () => {
  const button = $('#remove-selected-button');
  const ids = [...selectedIds];
  if (!ids.length || historyMutationInProgress) return;
  historyMutationInProgress = true;
  updateBulkControls(filteredItems());
  button.disabled = true;
  try {
    const results = [];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      results.push(...await Promise.allSettled(batch.map(async id => {
        const [latest] = await chrome.downloads.search({id});
        if (!latest || !isSelectable(latest)) return false;
        const erased = await chrome.downloads.erase({id});
        return erased.length > 0;
      })));
    }
    const removed = results.filter(result => result.status === 'fulfilled' && result.value).length;
    const skipped = ids.length - removed;
    selectedIds.clear();
    await refresh();
    toast(`${removed} ${removed === 1 ? 'entry' : 'entries'} removed from history${skipped ? ` · ${skipped} skipped` : ''}. Files stay on your device.`);
  } catch (error) {
    toast(error.message || 'Could not remove the selected entries.', true);
  } finally {
    historyMutationInProgress = false;
    render();
  }
});
$('#type-filter').addEventListener('change',render);
$('#date-filter').addEventListener('change',render);
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{activeFilter=button.dataset.filter;document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));render();}));
$('#search-input').addEventListener('input',render);
$('#sort-select').addEventListener('change',render);
$('#refresh-button').addEventListener('click',refresh);
$('#open-downloads-folder').addEventListener('click',()=>{
  try {
    chrome.downloads.showDefaultFolder();
    toast('Opened Chrome downloads folder.');
  } catch(error) {
    toast(error.message || 'Could not open Chrome downloads folder.',true);
  }
});
chrome.runtime.onMessage.addListener(message=>{
  if (message?.type !== 'downloads-changed') return;
  if (message.kind === 'erased') {
    speedSamples.delete(message.id);
    selectedIds.delete(message.id);
    activeDownloads = activeDownloads.filter(item => item.id !== message.id);
    items = items.filter(item => item.id !== message.id);
    render();
    return;
  }
  if (message.id == null) return;
  chrome.downloads.search({id:message.id}).then(result => {
    const latest = result[0];
    if (!latest) return;
    const index = items.findIndex(item => item.id === latest.id);
    const previous = index >= 0 ? items[index] : null;
    if (index >= 0) items[index] = latest;
    else if (message.kind === 'created') {
      items.push(latest);
      hasMorePages = true;
    } else return;
    activeDownloads = activeDownloads.filter(item => item.id !== latest.id);
    if (latest.state === 'in_progress') activeDownloads.push(latest);
    else selectedIds.delete(latest.id);
    if (latest.state === 'in_progress' && (latest.paused || !previous || previous.paused)) {
      speedSamples.set(latest.id, {bytes:latest.bytesReceived, time:performance.now(), rate:null, paused:latest.paused});
    }
    render();
  }).catch(() => {});
});
document.addEventListener('visibilitychange',()=>{
  if (document.visibilityState !== 'visible') speedSamples.clear();
  updateTotalSpeed();
  syncProgressPolling();
});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#search-input').focus();}});
$('#search-shortcut').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
refresh();
