const $ = (id) => { const el = document.getElementById(id); if (!el)
    throw new Error('Missing element ' + id); return el; };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
const labels = { created: 'New products', updated: 'Updates', unchanged: 'No change', stale: 'Older snapshots', invalid: 'Needs correction', queued: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed' };
const fields = ['sku', 'name', 'quantity', 'unit_price', 'currency', 'effective_date'];
const fieldLabels = { sku: 'SKU', name: 'Product name', quantity: 'Quantity', unit_price: 'Unit price', currency: 'Currency', effective_date: 'Effective date' };
const state = { view: 'import', step: 1, upload: null, preview: null, batch: null, history: [], previewFilter: 'all', previewOffset: 0, inventoryOffset: 0, inventoryTotal: 0, authenticated: false, polling: false, again: false, detailID: null, selection: 0 };
let toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => $('toast').hidden = true, 6000); }
function money(amount, currency) { try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const decimals = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(amount / 10 ** decimals);
}
catch {
    return amount + ' ' + currency + ' minor units';
} }
function badge(status) { const safe = Object.hasOwn(labels, status) ? status : 'invalid'; return `<span class="badge ${safe}">${esc(labels[status] ?? status)}</span>`; }
function showLogin() { state.authenticated = false; const dialog = $('login-dialog'); if (!dialog.open)
    dialog.showModal(); }
async function send(path, data) {
    const response = await fetch(path, data === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Stockroom-Request': '1' }, body: JSON.stringify(data) });
    if (response.status === 401 && path != '/api/login')
        showLogin();
    if (!response.ok) {
        let message = 'Request failed.';
        try {
            message = (await response.json()).error;
        }
        catch { }
        throw new Error(message);
    }
    return response;
}
async function api(path, data) { return (await send(path, data)).json(); }
async function action(button, fn) { if (button.disabled)
    return; button.disabled = true; try {
    await fn();
}
catch (error) {
    toast(error instanceof Error ? error.message : String(error));
}
finally {
    button.disabled = false;
    if (button.id === 'commit-import')
        renderCommit();
} }
function setStep(step) { state.step = step; for (let i = 1; i <= 4; i++) {
    const el = $('step-' + i);
    el.classList.toggle('active', i === step);
    el.classList.toggle('done', i < step);
} for (const [id, n] of [['upload-panel', 1], ['mapping-panel', 2], ['review-panel', 3], ['result-panel', 4]])
    $(id).hidden = n !== step; }
function setView(view) { state.view = ['import', 'inventory', 'history', 'guide'].includes(view) ? view : 'import'; const titles = { import: ['New import', 'Good inventory starts with good data.', 'Turn supplier spreadsheets into inventory you can trust.'], inventory: ['Inventory', 'Everything in its right place.', 'Current stock, prices and effective dates across suppliers.'], history: ['Import history', 'A record you can come back to.', 'Every file, reference and inventory change accounted for.'], guide: ['How it works', 'A clear path from file to inventory.', 'Understand the rules before you confirm your next import.'] }; const t = titles[state.view]; $('breadcrumb').textContent = t[0]; $('page-title').textContent = t[1]; $('page-subtitle').textContent = t[2]; for (const name of ['import', 'inventory', 'history', 'guide'])
    $(name + '-view').hidden = name !== state.view; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view)); document.body.classList.remove('menu-open'); void refresh(); }
function resetImport() { state.upload = null; state.preview = null; state.batch = null; $('file-input').value = ''; setStep(1); setView('import'); }
function mapping() { return Object.fromEntries(fields.map(f => { const v = $('map-' + f).value; return [f, v === '' ? null : Number(v)]; })); }
function configuration() { return { supplier: $('supplier').value, reference: $('reference').value, mode: $('mode').value, currency: $('currency').value, date: $('date').value, mapping: mapping(), sheet: Number($('sheet').value) }; }
function renderMapping() {
    const upload = state.upload;
    if (!upload)
        return;
    const index = Number($('sheet').value), sheet = upload.parsed.sheets[index];
    if (!sheet)
        return;
    $('file-summary').textContent = `${upload.filename} · ${sheet.rows.length} data rows · ${sheet.headers.length} columns`;
    const suggestions = upload.suggestions[index];
    $('mapping-fields').innerHTML = fields.map(field => `<div class="mapping-field"><label for="map-${field}">${esc(fieldLabels[field])}<small>${['currency', 'effective_date'].includes(field) ? 'Optional' : 'Required'}</small></label><select id="map-${field}" ${['currency', 'effective_date'].includes(field) ? '' : 'required'}><option value="">${['currency', 'effective_date'].includes(field) ? 'Use batch default' : 'Choose column'}</option>${sheet.headers.map((header, i) => `<option value="${i}" ${suggestions?.[field] === i ? 'selected' : ''}>${esc(header)}</option>`).join('')}</select></div>`).join('');
    $('source-preview').innerHTML = `<table><thead><tr>${sheet.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${sheet.rows.slice(0, 3).map(r => `<tr>${r.cells.map(c => `<td title="${esc(c)}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
async function upload(file) {
    const response = await fetch('/api/uploads?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'X-Stockroom-Request': '1' }, body: file, credentials: 'same-origin' });
    if (response.status === 401)
        showLogin();
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.error ?? 'Upload failed.');
    state.upload = result;
    state.preview = null;
    state.batch = null;
    $('sheet').innerHTML = result.parsed.sheets.map((s, i) => `<option value="${i}">${esc(s.name)} · ${s.rows.length} rows</option>`).join('');
    $('reference').value = file.name.replace(/\.[^.]+$/, '').slice(0, 100).toUpperCase();
    if (file.name.startsWith('supplier-demo'))
        $('supplier').value = 'Northline Supply';
    const today = new Date();
    $('date').value = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    renderMapping();
    setView('import');
    setStep(2);
}
function statsHTML(stats) { return ['created', 'updated', 'unchanged', 'stale', 'invalid'].map(key => `<div><strong>${stats[key] ?? 0}</strong><span>${esc(labels[key])}</span></div>`).join(''); }
function renderCommit() { const p = state.preview; if (!p)
    return; const invalid = p.stats.invalid ?? 0, valid = p.rows.filter(r => r.data).length; const partial = $('allow-partial').checked; $('commit-import').disabled = valid === 0 || invalid > 0 && !partial; $('commit-note').textContent = invalid ? `${invalid} rows need correction. ${valid} validated rows can be imported only with your explicit valid-only selection.` : `${valid} rows validated. Preview counts are estimates; the worker checks current inventory again before applying.`; }
function reviewRows() { const rows = state.preview?.rows ?? []; return rows.filter(r => state.previewFilter === 'all' || (state.previewFilter === 'invalid' ? r.errors.length > 0 : r.errors.length === 0)); }
function rowHTML(row) { const p = row.data; return `<tr><td>${row.row_number}</td><td><strong>${esc(p?.sku ?? '—')}</strong><small>${esc(p?.name ?? row.original.join(' · ').slice(0, 160))}</small></td><td>${p?.quantity ?? '—'}</td><td>${p ? esc(money(p.unit_price_minor, p.currency)) : '—'}</td><td>${badge(row.outcome ?? row.action ?? (row.errors.length ? 'invalid' : 'unchanged'))}${row.errors.map(e => `<small>${esc(e.field)}: ${esc(e.message)}</small>`).join('')}</td></tr>`; }
function renderReview() {
    const preview = state.preview;
    if (!preview)
        return;
    $('preview-stats').innerHTML = statsHTML(preview.stats);
    $('review-description').textContent = `${preview.config.supplier} · ${preview.config.reference} · ${preview.config.mode === 'add' ? 'Add delivery quantities' : 'Replace stock counts'}`;
    const rows = reviewRows();
    $('preview-rows').innerHTML = rows.slice(state.previewOffset, state.previewOffset + 50).map(rowHTML).join('') || '<tr><td colspan="5">No rows match this filter.</td></tr>';
    $('preview-page').textContent = `${rows.length ? state.previewOffset + 1 : 0}–${Math.min(state.previewOffset + 50, rows.length)} of ${rows.length} rows`;
    $('preview-prev').disabled = state.previewOffset === 0;
    $('preview-next').disabled = state.previewOffset + 50 >= rows.length;
    renderCommit();
}
function renderResult(batch) {
    state.batch = batch;
    const done = batch.status === 'completed', failed = batch.status === 'failed';
    $('result-icon').textContent = done ? '✓' : failed ? '!' : '◷';
    $('result-title').textContent = done ? 'Your import is complete.' : failed ? 'This import needs attention.' : 'Your import is ' + batch.status + '.';
    $('result-description').textContent = failed ? batch.error ?? 'Review the import and retry.' : done ? `${batch.reference} · ${(batch.stats?.created ?? 0) + (batch.stats?.updated ?? 0)} product records changed. Invalid rows stayed out; check details for final outcomes.` : 'The worker applies the entire batch in a single transaction. You can leave this screen and return to its history.';
    $('result-stats').innerHTML = statsHTML(batch.stats ?? {});
}
async function download(path, name, data) { const response = await send(path, data); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function renderInventory(data) {
    state.inventoryTotal = data.total;
    $('inventory-rows').innerHTML = data.items.map(p => `<tr><td><strong>${esc(p.sku)}</strong><small>${esc(p.name)}</small></td><td>${esc(p.supplier)}</td><td><strong>${p.quantity.toLocaleString()}</strong></td><td>${esc(money(p.unit_price_minor, p.currency))}</td><td>${esc(p.effective_date)}</td><td>${p.version}</td></tr>`).join('');
    $('inventory-empty').hidden = data.items.length > 0;
    $('inventory-page').textContent = data.total ? `${state.inventoryOffset + 1}–${Math.min(state.inventoryOffset + 50, data.total)} of ${data.total} products` : 'No products found';
    $('inventory-prev').disabled = state.inventoryOffset === 0;
    $('inventory-next').disabled = state.inventoryOffset + 50 >= data.total;
}
function renderHistory(batches) {
    state.history = batches;
    $('history-rows').innerHTML = batches.map(b => `<tr><td><button class="link-button" data-batch="${esc(b.id)}">${esc(b.reference)}</button><small>${esc(b.filename)}</small></td><td>${esc(b.supplier)}</td><td>${esc(b.mode)}</td><td>${badge(b.status)}${b.error ? `<small>${esc(b.error)}</small>` : ''}</td><td>${b.stats ? `${b.stats.created ?? 0} created · ${b.stats.updated ?? 0} updated<small>${b.stats.invalid ?? 0} invalid · ${b.stats.stale ?? 0} older</small>` : 'Waiting for worker'}</td><td><button class="icon-button" data-batch="${esc(b.id)}" aria-label="Inspect ${esc(b.reference)}">↗</button></td></tr>`).join('');
    $('history-empty').hidden = batches.length > 0;
    const select = $('inventory-supplier'), selected = select.value;
    const suppliers = [...new Set(batches.map(b => b.supplier))];
    select.innerHTML = '<option value="">All suppliers</option>' + suppliers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    select.value = selected;
}
function renderDetails(batch) {
    $('details-title').textContent = batch.reference;
    const rejected = batch.rows.filter(r => r.errors.length);
    const outcomeRows = batch.rows.slice(0, 100);
    $('details-content').innerHTML = `<div class="details-body"><p>${esc(batch.supplier)} · ${esc(batch.config.mode)} stock · ${badge(batch.status)}</p>${batch.error ? `<p class="form-error">${esc(batch.error)}</p>` : ''}<div class="details-controls"><button class="button subtle small" data-errors="${esc(batch.id)}">↓ Download error report (${rejected.length})</button>${batch.status === 'failed' ? `<button class="button primary small" data-retry="${esc(batch.id)}">Retry import</button>` : ''}</div><div class="preview-stats">${statsHTML(batch.stats ?? {})}</div><h3>Row outcomes · first ${Math.min(100, batch.rows.length)} of ${batch.rows.length}</h3><div class="table-scroll"><table><thead><tr><th>ROW</th><th>PRODUCT</th><th>QTY</th><th>PRICE</th><th>OUTCOME</th></tr></thead><tbody>${outcomeRows.map(rowHTML).join('')}</tbody></table></div><h3>Before / after changes</h3>${batch.changes.slice(0, 100).map(change => `<div class="change-card"><strong>${esc(change.sku)} · ${esc(change.action)}</strong><p>Stock: ${change.before_value?.quantity ?? 'new'} → ${change.after_value.quantity} · Price: ${change.before_value ? esc(money(change.before_value.unit_price_minor, change.before_value.currency)) : 'new'} → ${esc(money(change.after_value.unit_price_minor, change.after_value.currency))}</p></div>`).join('') || '<p>No inventory mutations recorded yet.</p>'}<p>Up to 100 changes are shown here; complete row outcomes are retained in the batch record.</p></div>`;
}
async function openDetails(id) { state.detailID = id; const version = ++state.selection; $('details-title').textContent = 'Loading import…'; $('details-content').textContent = 'Fetching saved outcomes.'; const dialog = $('details-dialog'); if (!dialog.open)
    dialog.showModal(); try {
    const batch = await api('/api/batches/' + id);
    if (state.detailID === id && state.selection === version)
        renderDetails(batch);
}
catch (error) {
    $('details-content').textContent = String(error);
} }
async function refresh() {
    if (state.polling) {
        state.again = true;
        return;
    }
    state.polling = true;
    const view = state.view;
    try {
        const overview = await api('/api/overview');
        state.authenticated = true;
        $('connection').textContent = 'Connected';
        $('connection-dot').classList.remove('offline');
        $('page-error').hidden = true;
        for (const [id, key] of [['metric-products', 'products'], ['metric-units', 'units'], ['metric-imports', 'imports'], ['metric-errors', 'rejected_rows']])
            $(id).textContent = overview[key].toLocaleString();
        $('nav-products').textContent = String(overview.products);
        $('worker-dot').classList.toggle('offline', !overview.worker_ready);
        $('worker-label').textContent = overview.worker_ready ? 'Import worker ready' : 'Worker starting or offline';
        if (view === 'inventory') {
            const query = new URLSearchParams({ search: $('inventory-search').value, supplier: $('inventory-supplier').value, offset: String(state.inventoryOffset) });
            const page = await api('/api/inventory?' + query);
            if (state.view === view)
                renderInventory(page);
        }
        if (view === 'history' || view === 'inventory') {
            const history = await api('/api/batches');
            if (state.view === view)
                renderHistory(history);
        }
        if (state.batch && state.step === 4) {
            const id = state.batch.id;
            const b = await api('/api/batches/' + id);
            if (state.batch?.id === id)
                renderResult(b);
        }
        if (state.detailID) {
            const id = state.detailID, version = state.selection;
            const b = await api('/api/batches/' + id);
            if (state.detailID === id && version === state.selection)
                renderDetails(b);
        }
        $('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }
    catch (error) {
        $('connection').textContent = 'Reconnecting';
        $('connection-dot').classList.add('offline');
        if (state.authenticated) {
            $('page-error').textContent = error instanceof Error ? error.message : String(error);
            $('page-error').hidden = false;
        }
    }
    finally {
        state.polling = false;
        if (state.again) {
            state.again = false;
            void refresh();
        }
    }
}
$('login-form').onsubmit = event => { event.preventDefault(); const button = $('login-form').querySelector('button'); void action(button, async () => { try {
    await api('/api/login', { token: $('login-token').value });
    $('login-token').value = '';
    $('login-dialog').close();
    state.authenticated = true;
    await refresh();
}
catch (error) {
    $('login-error').textContent = String(error);
} }); };
$('login-dialog').onkeydown = e => { if (e.key === 'Escape')
    e.preventDefault(); };
$('logout').onclick = () => void action($('logout'), async () => { await api('/api/logout', {}); showLogin(); });
$('menu').onclick = () => document.body.classList.toggle('menu-open');
$('refresh').onclick = () => void refresh();
$('new-import').onclick = resetImport;
$('change-file').onclick = resetImport;
$('choose-file').onclick = () => $('file-input').click();
$('file-input').onchange = () => { const file = $('file-input').files?.[0]; if (file)
    void action($('choose-file'), () => upload(file)); };
const zone = $('dropzone');
zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag-over'); };
zone.ondragleave = () => zone.classList.remove('drag-over');
zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag-over'); const file = e.dataTransfer?.files[0]; if (file)
    void action($('choose-file'), () => upload(file)); };
$('sheet').onchange = renderMapping;
$('mapping-form').onsubmit = event => { event.preventDefault(); const button = event.submitter; void action(button, async () => { if (!state.upload)
    return; state.preview = await api('/api/preview', { upload_id: state.upload.id, config: configuration() }); state.previewOffset = 0; state.previewFilter = 'all'; $('allow-partial').checked = false; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all')); renderReview(); setStep(3); }); };
$('back-to-mapping').onclick = () => setStep(2);
$('allow-partial').onchange = renderCommit;
$('preview-prev').onclick = () => { state.previewOffset = Math.max(0, state.previewOffset - 50); renderReview(); };
$('preview-next').onclick = () => { state.previewOffset += 50; renderReview(); };
$('download-preview-errors').onclick = () => void action($('download-preview-errors'), async () => { if (state.preview)
    await download('/api/preview-errors', 'validation-errors.csv', { upload_id: state.preview.upload_id, config: state.preview.config }); });
$('commit-import').onclick = () => void action($('commit-import'), async () => { if (!state.preview)
    return; const receipt = await api('/api/commit', { upload_id: state.preview.upload_id, config: state.preview.config, allow_partial: $('allow-partial').checked }); state.batch = await api('/api/batches/' + receipt.id); renderResult(state.batch); setStep(4); if (receipt.duplicate)
    toast('This supplier reference already exists. Showing its saved import; stock was not added again.'); await refresh(); });
$('result-details').onclick = () => { if (state.batch)
    void openDetails(state.batch.id); };
$('result-inventory').onclick = () => setView('inventory');
let searchTimer;
$('inventory-search').oninput = () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { state.inventoryOffset = 0; void refresh(); }, 250); };
$('inventory-supplier').onchange = () => { state.inventoryOffset = 0; void refresh(); };
$('inventory-prev').onclick = () => { state.inventoryOffset = Math.max(0, state.inventoryOffset - 50); void refresh(); };
$('inventory-next').onclick = () => { state.inventoryOffset += 50; void refresh(); };
$('close-details').onclick = () => $('details-dialog').close();
$('details-dialog').addEventListener('close', () => { state.detailID = null; state.selection++; });
document.addEventListener('click', event => { const target = event.target; if (!(target instanceof Element))
    return; const view = target.closest('[data-view]'); if (view)
    setView(view.dataset.view ?? 'import'); const filter = target.closest('[data-filter]'); if (filter) {
    state.previewFilter = filter.dataset.filter ?? 'all';
    state.previewOffset = 0;
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === filter));
    renderReview();
} const batch = target.closest('[data-batch]'); if (batch)
    void openDetails(batch.dataset.batch); const errors = target.closest('[data-errors]'); if (errors)
    void action(errors, () => download('/api/batches/' + errors.dataset.errors + '/errors', 'import-errors.csv')); const retry = target.closest('[data-retry]'); if (retry)
    void action(retry, async () => { await api('/api/batches/' + retry.dataset.retry + '/retry', {}); toast('Import queued for retry.'); await refresh(); }); const sample = target.closest('[data-sample]'); if (sample)
    void action(sample, async () => { const name = 'supplier-demo.' + sample.dataset.sample; const bytes = await (await send('/api/samples/' + name)).arrayBuffer(); await upload(new File([bytes], name)); }); });
void refresh();
setInterval(() => { if (state.authenticated)
    void refresh(); }, 2000);
export {};
