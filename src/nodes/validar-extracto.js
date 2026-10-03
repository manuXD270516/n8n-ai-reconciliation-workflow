// Nodo Code: "Validar y normalizar extracto" (Run Once for All Items).
// Valida el payload del webhook (o del Schedule), normaliza filas del extracto bancario
// (CSV o JSON) y del libro mayor, y devuelve { valid, errors, warnings, ... }.
// No llama a ninguna API: sólo reglas determinísticas.

const MAX_ROWS = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const AMOUNT_RE = /^-?\d{1,12}(\.\d{1,2})?$/;
const CURRENCIES = ['USD', 'BOB'];
const LEDGER_VOCAB = {
  statuses: ['PENDING', 'POSTED', 'FAILED', 'REVERSED'],
  operations: ['AUTH', 'CAPTURE', 'REFUND', 'CHARGEBACK'],
};
// Vocabularios del proveedor tal como los acepta la API (mappings/v1).
const PROVIDER_VOCAB = {
  'prov-alfa': { statuses: ['SETTLED', 'PENDING', 'DECLINED', 'REVERSED'], operations: ['AUTHORIZE', 'CAPTURE', 'REFUND', 'DISPUTE'] },
  'prov-beta': { statuses: ['OK', 'WAIT', 'KO', 'VOID'], operations: ['AUT', 'CAP', 'REF', 'CBK'] },
};
const ROW_FIELDS = ['source_record_id', 'payment_ref', 'operation', 'amount', 'currency', 'status', 'occurred_at', 'received_at'];
const FAULTS = ['ollama_invalid_json', 'ollama_unreachable', 'api_error'];

const errors = [];
const warnings = [];
const err = (field, message, row) => errors.push(row === undefined ? { field, message } : { field, row, message });

function parseCsv(text) {
  // CSV simple con comillas dobles (RFC 4180 básico). Devuelve { header, rows }.
  const lines = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) lines.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) lines.push(row);
  if (quoted) throw new Error('comillas sin cerrar');
  const [header = [], ...data] = lines;
  return {
    header: header.map((h) => h.trim()),
    rows: data.map((cells) => cells),
  };
}

function toRows(name, csvText, jsonRows) {
  if (typeof csvText === 'string' && csvText.trim() !== '') {
    let parsed;
    try { parsed = parseCsv(csvText); } catch (e) { err(`${name}_csv`, `CSV ilegible: ${e.message}`); return []; }
    const missing = ROW_FIELDS.filter((f) => !parsed.header.includes(f));
    if (missing.length) { err(`${name}_csv`, `faltan columnas: ${missing.join(', ')}`); return []; }
    return parsed.rows.map((cells, i) => {
      if (cells.length !== parsed.header.length) {
        err(`${name}_csv`, `la fila tiene ${cells.length} columnas y el encabezado ${parsed.header.length}`, i + 1);
      }
      return Object.fromEntries(parsed.header.map((h, j) => [h, (cells[j] ?? '').trim()]));
    });
  }
  if (Array.isArray(jsonRows)) return jsonRows;
  err(name, `se requiere "${name}" (arreglo JSON) o "${name}_csv" (texto CSV)`);
  return [];
}

function parseTs(value) {
  if (typeof value !== 'string' || !TS_RE.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeRows(name, rows, vocab, header, windowStart, windowEnd) {
  if (rows.length === 0) err(name, 'no hay filas');
  if (rows.length > MAX_ROWS) err(name, `máximo ${MAX_ROWS} filas por extracto (llegaron ${rows.length})`);
  const seen = new Set();
  const out = [];
  rows.slice(0, MAX_ROWS).forEach((raw, i) => {
    const n = i + 1;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { err(name, 'la fila debe ser un objeto', n); return; }
    const r = {};
    for (const f of ROW_FIELDS) r[f] = raw[f] === undefined || raw[f] === null ? '' : String(raw[f]).trim();
    r.attempt_ref = raw.attempt_ref ? String(raw.attempt_ref).trim() : '';
    r.revision = raw.revision === undefined || raw.revision === '' ? '1' : String(raw.revision).trim();
    for (const f of ROW_FIELDS) if (r[f] === '') err(`${name}.${f}`, 'obligatorio', n);
    if (r.source_record_id && !ID_RE.test(r.source_record_id)) err(`${name}.source_record_id`, 'formato inválido', n);
    if (r.payment_ref && !ID_RE.test(r.payment_ref)) err(`${name}.payment_ref`, 'formato inválido', n);
    if (r.attempt_ref && !ID_RE.test(r.attempt_ref)) err(`${name}.attempt_ref`, 'formato inválido', n);
    if (!/^[1-9]\d{0,5}$/.test(r.revision)) err(`${name}.revision`, 'debe ser un entero positivo', n);
    if (seen.has(`${r.source_record_id}@${r.revision}`)) err(`${name}.source_record_id`, `duplicado: ${r.source_record_id}`, n);
    seen.add(`${r.source_record_id}@${r.revision}`);
    r.operation = r.operation.toUpperCase();
    r.status = r.status.toUpperCase();
    r.currency = r.currency.toUpperCase();
    if (r.operation && !vocab.operations.includes(r.operation)) err(`${name}.operation`, `"${r.operation}" no está en ${vocab.operations.join('/')}`, n);
    if (r.status && !vocab.statuses.includes(r.status)) err(`${name}.status`, `"${r.status}" no está en ${vocab.statuses.join('/')}`, n);
    if (r.amount) {
      const a = r.amount.replace(/\s/g, '');
      if (!AMOUNT_RE.test(a)) err(`${name}.amount`, `monto inválido "${r.amount}" (usar punto decimal, máx. 2 decimales)`, n);
      else r.amount = Number(a).toFixed(2);
    }
    if (r.currency && r.currency !== header.currency) err(`${name}.currency`, `moneda ${r.currency} distinta de la del extracto (${header.currency})`, n);
    const occurred = parseTs(r.occurred_at);
    if (r.occurred_at && !occurred) err(`${name}.occurred_at`, 'fecha RFC 3339 con zona horaria requerida', n);
    if (r.received_at && !parseTs(r.received_at)) err(`${name}.received_at`, 'fecha RFC 3339 con zona horaria requerida', n);
    if (occurred && windowStart && windowEnd && (occurred < windowStart || occurred >= windowEnd)) {
      warnings.push({ field: `${name}.occurred_at`, row: n, message: 'fuera de la ventana del lote; la API no la conciliará en este lote' });
    }
    out.push(r);
  });
  return out;
}

const first = $input.first().json;
const body = first.body !== undefined ? first.body : first;
const origin = first.origin === 'schedule' ? 'schedule' : 'webhook';
let header = {};
let ledger = [];
let statement = [];
let testFault = null;

const contentType = String(first.headers?.['content-type'] ?? 'application/json').toLowerCase();
if (origin === 'webhook' && !contentType.includes('application/json')) {
  err('content-type', `se esperaba application/json (llegó "${contentType}"); el CSV va dentro del campo statement_csv`);
} else if (body === null || typeof body !== 'object' || Array.isArray(body)) {
  err('body', 'se esperaba un objeto JSON (Content-Type: application/json)');
} else {
  header = {
    statement_id: String(body.statement_id ?? '').trim(),
    provider_id: String(body.provider_id ?? '').trim(),
    merchant_account: String(body.merchant_account ?? '').trim(),
    currency: String(body.currency ?? '').trim().toUpperCase(),
    window_start: String(body.window_start ?? '').trim(),
    window_end: String(body.window_end ?? '').trim(),
    business_timezone: String(body.business_timezone ?? 'America/La_Paz').trim(),
    cutoff_at: String(body.cutoff_at ?? '').trim(),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,48}$/.test(header.statement_id)) err('statement_id', 'obligatorio, 3-49 caracteres [A-Za-z0-9._-]');
  if (!PROVIDER_VOCAB[header.provider_id]) err('provider_id', `proveedor desconocido; válidos: ${Object.keys(PROVIDER_VOCAB).join(', ')}`);
  if (!ID_RE.test(header.merchant_account)) err('merchant_account', 'obligatorio, formato [A-Za-z0-9._:-]');
  if (!CURRENCIES.includes(header.currency)) err('currency', `moneda no soportada; válidas: ${CURRENCIES.join(', ')}`);
  if (!/^[A-Za-z]+\/[A-Za-z_]+$/.test(header.business_timezone)) err('business_timezone', 'zona IANA inválida');
  const ws = parseTs(header.window_start);
  const we = parseTs(header.window_end);
  const co = parseTs(header.cutoff_at);
  if (!ws) err('window_start', 'fecha RFC 3339 con zona horaria requerida');
  if (!we) err('window_end', 'fecha RFC 3339 con zona horaria requerida');
  if (!co) err('cutoff_at', 'fecha RFC 3339 con zona horaria requerida');
  if (ws && we && we <= ws) err('window_end', 'debe ser posterior a window_start');
  if (we && co && co < we) err('cutoff_at', 'no puede ser anterior a window_end');
  if (ws && we && we - ws > 31 * 86400000) err('window_end', 'la ventana no puede superar 31 días');

  if (body.test_fault !== undefined && body.test_fault !== null) {
    if ($env.RECON_FAULT_INJECTION !== 'true') err('test_fault', 'inyección de fallas deshabilitada en este entorno');
    else if (!FAULTS.includes(body.test_fault)) err('test_fault', `valores permitidos: ${FAULTS.join(', ')}`);
    else testFault = body.test_fault;
  }

  const vocab = PROVIDER_VOCAB[header.provider_id];
  if (vocab && CURRENCIES.includes(header.currency)) {
    statement = normalizeRows('statement', toRows('statement', body.statement_csv, body.statement), vocab, header, ws, we);
    ledger = normalizeRows('ledger', toRows('ledger', body.ledger_csv, body.ledger), LEDGER_VOCAB, header, ws, we);
  }
}

const valid = errors.length === 0;
return [{
  json: {
    valid,
    origin,
    errors: errors.slice(0, 50),
    error_count: errors.length,
    warnings: warnings.slice(0, 50),
    header,
    ledger_rows: valid ? ledger : [],
    statement_rows: valid ? statement : [],
    counts: { ledger: ledger.length, statement: statement.length },
    test_fault: testFault,
    received_at: new Date().toISOString(),
  },
}];
