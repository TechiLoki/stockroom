import { createHash } from 'node:crypto';
import { InputError, validateConfig, validateRows } from './domain.js';
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export async function preview(db, uploadID, config) {
    const upload = await db.call('get_upload', { p_id: uploadID });
    const index = config?.sheet;
    if (!Number.isInteger(index) || index === undefined || index < 0 || !upload.parsed.sheets[index])
        throw new InputError('Choose an available sheet.');
    const sheet = upload.parsed.sheets[index];
    const c = validateConfig(config, sheet);
    const rows = validateRows(sheet, c);
    const existing = await db.call('inventory_lookup', { p_supplier: c.supplier, p_skus: rows.flatMap(r => r.data ? [r.data.sku] : []) });
    const inventory = new Map(existing.map(p => [p.sku, p]));
    const stats = { created: 0, updated: 0, unchanged: 0, stale: 0, invalid: 0 };
    const result = rows.map(row => {
        let action = 'invalid';
        const product = row.data, current = product ? inventory.get(product.sku) : undefined;
        if (product) {
            if (current?.currency && current.currency !== product.currency) {
                row.errors.push({ field: 'currency', code: 'CURRENCY_CONFLICT', message: 'This SKU already uses ' + current.currency + '. Currency conversion is never implicit.' });
                row.data = null;
            }
            else if (current && c.mode === 'add' && current.quantity + product.quantity > 1_000_000) {
                row.errors.push({ field: 'quantity', code: 'STOCK_LIMIT', message: 'Adding this quantity would exceed 1,000,000 units.' });
                row.data = null;
            }
            else if (!current)
                action = 'created';
            else if (c.mode === 'replace' && product.effective_date < current.effective_date)
                action = 'stale';
            else {
                const qty = c.mode === 'add' ? current.quantity + product.quantity : product.quantity;
                const older = c.mode === 'add' && product.effective_date < current.effective_date;
                const name = older ? current.name : product.name, price = older ? current.unit_price_minor : product.unit_price_minor;
                const date = product.effective_date > current.effective_date ? product.effective_date : current.effective_date;
                action = qty === current.quantity && name === current.name && price === current.unit_price_minor && date === current.effective_date ? 'unchanged' : 'updated';
            }
        }
        stats[action]++;
        return { ...row, action };
    });
    const fingerprint = hash(JSON.stringify({ source: upload.hash, config: { ...c, supplier: c.supplier.toLowerCase() } }));
    return { upload_id: upload.id, filename: upload.filename, config: c, rows: result, stats, fingerprint };
}
