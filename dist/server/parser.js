import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { InputError, LIMITS } from './domain.js';
const utf8 = new TextDecoder('utf-8', { fatal: true });
function text(bytes) { let value; try {
    value = utf8.decode(bytes);
}
catch {
    throw new InputError('File must contain valid UTF-8 text. Export CSV as UTF-8.');
} if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new InputError('Unsupported control character in text.'); return value; }
function sheet(name, records) {
    const nonempty = records.filter(r => r.cells.some(c => c.trim() !== ''));
    const first = nonempty.shift();
    if (!first)
        throw new InputError('The sheet is empty.');
    const headers = first.cells.map(h => h.trim());
    if (headers.length > LIMITS.columns || headers.some(h => !h || h.length > 100))
        throw new InputError('Use 1–40 non-empty column headers of at most 100 characters.');
    if (new Set(headers.map(h => h.toLowerCase())).size !== headers.length)
        throw new InputError('Column headers must be unique (ignoring case).');
    if (first.issues.length)
        throw new InputError('Header cells cannot contain formulas or Excel errors.');
    if (nonempty.length > LIMITS.rows)
        throw new InputError('Maximum ' + LIMITS.rows + ' data rows per sheet.');
    for (const row of nonempty) {
        if (row.cells.length > headers.length)
            throw new InputError('Row ' + row.row_number + ' has more columns than the header.');
        row.cells = Array.from({ length: headers.length }, (_, i) => row.cells[i] ?? '');
    }
    return { name, header_row: first.row_number, headers, rows: nonempty };
}
export function parseCSV(input) {
    input = input.replace(/^\uFEFF/, '');
    let quotes = false, hasText = false;
    const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '"') {
            if (quotes && input[i + 1] === '"') {
                i++;
                continue;
            }
            quotes = !quotes;
        }
        if (c.trim() !== '' && !counts.has(c))
            hasText = true;
        if (!quotes) {
            if (c === '\n' || c === '\r') {
                if (hasText)
                    break;
                for (const key of counts.keys())
                    counts.set(key, 0);
                continue;
            }
            if (counts.has(c))
                counts.set(c, counts.get(c) + 1);
        }
    }
    const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const records = [];
    let cells = [];
    let value = '';
    let quoted = false;
    let afterQuote = false;
    let physical = 1;
    let start = 1;
    const finishCell = () => { if (value.length > LIMITS.cell)
        throw new InputError('A cell exceeds ' + LIMITS.cell + ' characters.'); cells.push(value); value = ''; afterQuote = false; if (cells.length > LIMITS.columns)
        throw new InputError('Maximum ' + LIMITS.columns + ' columns.'); };
    const finishRow = () => { finishCell(); records.push({ row_number: start, cells, issues: [] }); cells = []; if (records.length > LIMITS.rows + 100)
        throw new InputError('Too many rows.'); };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (quoted) {
            if (c === '"') {
                if (input[i + 1] === '"') {
                    value += '"';
                    i++;
                }
                else {
                    quoted = false;
                    afterQuote = true;
                }
            }
            else {
                value += c;
                if (c === '\n' || (c === '\r' && input[i + 1] !== '\n'))
                    physical++;
            }
            continue;
        }
        if (c === delimiter) {
            finishCell();
            continue;
        }
        if (c === '\n' || c === '\r') {
            finishRow();
            if (c === '\r' && input[i + 1] === '\n')
                i++;
            physical++;
            start = physical;
            continue;
        }
        if (c === '"') {
            if (value !== '' || afterQuote)
                throw new InputError('Unexpected quote on source row ' + physical + '.');
            quoted = true;
            continue;
        }
        if (afterQuote) {
            if (c === ' ' || c === '\t')
                continue;
            throw new InputError('Unexpected text after a quoted field on row ' + physical + '.');
        }
        value += c;
    }
    if (quoted)
        throw new InputError('Unclosed quoted CSV field.');
    if (value !== '' || cells.length || afterQuote)
        finishRow();
    return sheet('CSV', records);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++)
    n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer)
    c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function unzip(buffer) {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
        if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
            end = i;
            break;
        }
    if (end < 0)
        throw new InputError('Invalid XLSX ZIP directory.');
    if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6))
        throw new InputError('Split ZIP archives are not supported.');
    const entries = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
    if (entries !== buffer.readUInt16LE(end + 8) || entries > 150 || entries === 65535 || offset + size !== end)
        throw new InputError('Unsupported XLSX ZIP layout or too many entries.');
    const files = new Map();
    let cursor = offset, total = 0;
    for (let i = 0; i < entries; i++) {
        if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
            throw new InputError('Invalid ZIP member.');
        const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), expanded = buffer.readUInt32LE(cursor + 24), nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), disk = buffer.readUInt16LE(cursor + 34), local = buffer.readUInt32LE(cursor + 42);
        const next = cursor + 46 + nameLength + extra + comment;
        if (next > end || disk || flags & 1 || ![0, 8].includes(method))
            throw new InputError('Encrypted or unsupported ZIP entry.');
        const name = text(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
        if (name.includes('..') || name.includes('\\') || name.startsWith('/') || name.includes(':') || files.has(name))
            throw new InputError('Unsafe or duplicate ZIP path.');
        if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50)
            throw new InputError('Invalid local ZIP header.');
        const localNameLength = buffer.readUInt16LE(local + 26), localExtra = buffer.readUInt16LE(local + 28);
        const dataStart = local + 30 + localNameLength + localExtra;
        if (dataStart + compressed > offset || text(buffer.subarray(local + 30, local + 30 + localNameLength)) !== name || buffer.readUInt16LE(local + 8) !== method)
            throw new InputError('Inconsistent ZIP entry.');
        total += expanded;
        if (expanded > LIMITS.expandedBytes || total > LIMITS.expandedBytes)
            throw new InputError('Expanded workbook exceeds 20 MiB.');
        let bytes;
        try {
            bytes = method === 0 ? buffer.subarray(dataStart, dataStart + compressed) : inflateRawSync(buffer.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, expanded) });
        }
        catch {
            throw new InputError('Corrupt or oversized compressed workbook member.');
        }
        if (bytes.length !== expanded || crc32(bytes) !== crc)
            throw new InputError('Workbook member checksum or size mismatch.');
        files.set(name, bytes);
        cursor = next;
    }
    if (cursor !== end)
        throw new InputError('Inconsistent ZIP directory length.');
    return files;
}
function entities(value) {
    if (value.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, '').includes('&'))
        throw new InputError('Invalid or unsupported XML entity.');
    return value.replace(/&([^;]+);/g, (_, entity) => {
        const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (Object.hasOwn(predefined, entity))
            return predefined[entity];
        if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity))
            throw new InputError('Unknown XML entity.');
        const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        if (!Number.isInteger(n) || n < 0x20 && ![9, 10, 13].includes(n) || n > 0x10ffff || n === 0xfffe || n === 0xffff || n >= 0xd800 && n <= 0xdfff)
            throw new InputError('Invalid XML character.');
        return String.fromCodePoint(n);
    });
}
export function xml(input) {
    if (/<!DOCTYPE|<!ENTITY/i.test(input))
        throw new InputError('DTD and entity declarations are not supported.');
    const root = { name: '#document', attrs: {}, children: [] }, stack = [root];
    let cursor = 0, nodes = 0;
    while (cursor < input.length) {
        if (input[cursor] !== '<') {
            const end = input.indexOf('<', cursor);
            const stop = end < 0 ? input.length : end;
            stack.at(-1).children.push(entities(input.slice(cursor, stop)));
            cursor = stop;
            continue;
        }
        if (input.startsWith('<!--', cursor)) {
            const end = input.indexOf('-->', cursor + 4);
            if (end < 0)
                throw new InputError('Unclosed XML comment.');
            cursor = end + 3;
            continue;
        }
        if (input.startsWith('<?', cursor)) {
            const end = input.indexOf('?>', cursor + 2);
            if (end < 0)
                throw new InputError('Unclosed XML instruction.');
            cursor = end + 2;
            continue;
        }
        if (input.startsWith('<![CDATA[', cursor)) {
            const end = input.indexOf(']]>', cursor + 9);
            if (end < 0)
                throw new InputError('Unclosed CDATA.');
            stack.at(-1).children.push(input.slice(cursor + 9, end));
            cursor = end + 3;
            continue;
        }
        let end = cursor + 1, quote = '';
        for (; end < input.length; end++) {
            const c = input[end];
            if (quote) {
                if (c === quote)
                    quote = '';
            }
            else if (c === '"' || c === "'")
                quote = c;
            else if (c === '>')
                break;
        }
        if (end === input.length)
            throw new InputError('Unclosed XML tag.');
        const tag = input.slice(cursor + 1, end).trim();
        cursor = end + 1;
        if (tag.startsWith('/')) {
            const expected = tag.slice(1).trim().split(':').at(-1);
            if (stack.length < 2 || (stack.at(-1).qualified ?? stack.at(-1).name) !== tag.slice(1).trim())
                throw new InputError('Mismatched XML close tag.');
            stack.pop();
            continue;
        }
        const match = /^([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)$/.exec(tag);
        if (!match)
            throw new InputError('Invalid XML element.');
        const attrs = Object.create(null);
        let rest = match[2];
        while (rest.trim()) {
            const a = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
            if (!a)
                throw new InputError('Invalid XML attributes.');
            if (a[1] in attrs)
                throw new InputError('Duplicate XML attribute.');
            attrs[a[1]] = entities(a[2] ?? a[3] ?? '');
            rest = rest.slice(a[0].length);
        }
        const node = { name: match[1].split(':').at(-1), qualified: match[1], attrs, children: [] };
        stack.at(-1).children.push(node);
        if (++nodes > 250000)
            throw new InputError('Workbook XML is too complex.');
        if (!match[3])
            stack.push(node);
        if (stack.length > 64)
            throw new InputError('Workbook XML is nested too deeply.');
    }
    const elements = root.children.filter((n) => typeof n !== 'string');
    if (stack.length !== 1 || elements.length !== 1 || root.children.some(n => typeof n === 'string' && n.trim() !== ''))
        throw new InputError('Invalid XML document structure.');
    return elements[0];
}
const children = (node, name) => node.children.filter((n) => typeof n !== 'string' && n.name === name);
const child = (node, name) => children(node, name)[0];
function content(node) { return node ? node.children.map(c => typeof c === 'string' ? c : content(c)).join('') : ''; }
function inlineText(node) { if (!node)
    return ''; if (node.name === 't')
    return content(node); return node.children.filter((n) => typeof n !== 'string' && !['rPr', 'rPh'].includes(n.name)).map(inlineText).join(''); }
function column(reference) {
    const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(reference);
    if (!match)
        throw new InputError('Invalid worksheet cell reference.');
    let index = 0;
    for (const c of match[1])
        index = index * 26 + c.charCodeAt(0) - 64;
    if (index > LIMITS.columns)
        throw new InputError('Workbook has data beyond column ' + LIMITS.columns + '.');
    return index - 1;
}
export function parseXLSX(buffer) {
    const files = unzip(buffer);
    if ([...files.keys()].some(n => /vbaProject|externalLinks/i.test(n)))
        throw new InputError('Macros and external workbook links are not supported.');
    const get = (name) => { const bytes = files.get(name); if (!bytes)
        throw new InputError('Missing workbook component: ' + name); return xml(text(bytes)); };
    const workbook = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
    const relationships = new Map();
    for (const r of children(rels, 'Relationship')) {
        if (r.attrs.TargetMode === 'External')
            throw new InputError('External workbook relationships are not supported.');
        if (r.attrs.Type?.endsWith('/worksheet')) {
            const target = r.attrs.Target ?? '';
            if (target.includes('\\') || target.includes(':'))
                throw new InputError('Unsafe worksheet target.');
            const path = posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
            if (!path.startsWith('xl/'))
                throw new InputError('Worksheet target escapes workbook.');
            relationships.set(r.attrs.Id ?? '', path);
        }
    }
    const shared = files.has('xl/sharedStrings.xml') ? children(get('xl/sharedStrings.xml'), 'si').map(inlineText) : [];
    const list = child(workbook, 'sheets');
    if (!list)
        throw new InputError('Workbook has no sheets.');
    const names = new Set();
    const sheets = [];
    for (const entry of children(list, 'sheet')) {
        const target = relationships.get(entry.attrs['r:id'] ?? Object.entries(entry.attrs).find(([k]) => k.endsWith(':id'))?.[1] ?? '');
        if (!target)
            throw new InputError('Missing worksheet relationship.');
        const name = entry.attrs.name ?? 'Sheet';
        if (names.has(name))
            throw new InputError('Duplicate worksheet name.');
        names.add(name);
        const rows = [];
        const data = child(get(target), 'sheetData');
        if (!data)
            continue;
        const usedRows = new Set();
        for (const row of children(data, 'row')) {
            const number = Number(row.attrs.r);
            if (!Number.isSafeInteger(number) || number < 1 || usedRows.has(number))
                throw new InputError('Invalid or duplicate worksheet row number.');
            usedRows.add(number);
            const cells = [], issues = [];
            const used = new Set();
            for (const cell of children(row, 'c')) {
                const ref = cell.attrs.r ?? '';
                if (Number(ref.match(/[0-9]+$/)?.[0]) !== number)
                    throw new InputError('Worksheet cell row mismatch.');
                const index = column(ref);
                if (used.has(index))
                    throw new InputError('Duplicate worksheet cell.');
                used.add(index);
                let value = '';
                const raw = content(child(cell, 'v')), type = cell.attrs.t;
                if (child(cell, 'f'))
                    issues.push('Formula cell ' + ref + ' is not evaluated. Paste values before importing.');
                if (type === 'e')
                    issues.push('Excel error in cell ' + ref + '.');
                if (type === 's') {
                    const i = Number(raw);
                    if (!/^\d+$/.test(raw) || !Number.isInteger(i) || shared[i] === undefined)
                        throw new InputError('Invalid shared-string reference.');
                    value = shared[i];
                }
                else if (type === 'inlineStr')
                    value = inlineText(child(cell, 'is'));
                else if (type === 'b') {
                    value = raw === '1' ? 'TRUE' : 'FALSE';
                }
                else
                    value = raw;
                if (value.length > LIMITS.cell)
                    throw new InputError('Workbook cell exceeds ' + LIMITS.cell + ' characters.');
                cells[index] = value;
            }
            rows.push({ row_number: number, cells: Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''), issues });
            if (rows.length > LIMITS.rows + 100)
                throw new InputError('Worksheet has too many rows.');
        }
        if (rows.some(r => r.cells.some(c => c.trim() !== '')))
            sheets.push(sheet(name, rows.sort((a, b) => a.row_number - b.row_number)));
        if (sheets.length > LIMITS.sheets)
            throw new InputError('Maximum ' + LIMITS.sheets + ' non-empty sheets.');
    }
    if (!sheets.length)
        throw new InputError('Workbook has no non-empty sheets.');
    return { format: 'xlsx', sheets };
}
export function parseFile(buffer, filename) {
    if (!buffer.length || buffer.length > LIMITS.fileBytes)
        throw new InputError('Upload a non-empty file up to 5 MiB.');
    if (filename.toLowerCase().endsWith('.csv'))
        return { format: 'csv', sheets: [parseCSV(text(buffer))] };
    if (filename.toLowerCase().endsWith('.xlsx'))
        return parseXLSX(buffer);
    throw new InputError('Supported formats are UTF-8 .csv and value-based .xlsx. Legacy .xls and .xlsm are not supported.');
}
