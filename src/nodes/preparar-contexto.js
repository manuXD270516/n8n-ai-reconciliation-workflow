// Nodo Code: "Preparar contexto y CSV" (Run Once for All Items).
// Arma el tenant aislado de esta ejecución, el id de lote, los CSV canónicos que exige la
// API (13 columnas, mismo orden) y los claims de los JWT de servicio (TTL corto).

const v = $input.first().json;
const h = v.header;
const COLUMNS = ['tenant_id', 'source_record_id', 'revision', 'provider_id', 'merchant_account', 'operation',
  'payment_ref', 'attempt_ref', 'amount', 'currency', 'status', 'occurred_at', 'received_at'];
// Un tenant por ejecución: los datos de cada corrida quedan aislados en la API.
const tenant = `${$env.RECON_TENANT_PREFIX || 'n8n'}-x${$execution.id}`;
// Falla inyectada 'api_error' (sólo con RECON_FAULT_INJECTION=true): un batch_id que la API
// rechaza con 422, para ejercitar el camino de error real (nodo falla -> Error Trigger).
const batchId = v.test_fault === 'api_error' ? 'id inválido (falla inyectada)' : `b-${h.statement_id}`.slice(0, 120);

const cell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toCsv = (rows) => [COLUMNS.join(',')]
  .concat(rows.map((r) => COLUMNS.map((c) => cell(String({
    ...r, tenant_id: tenant, provider_id: h.provider_id, merchant_account: h.merchant_account,
  }[c] ?? ''))).join(',')))
  .join('\n') + '\n';

const now = Math.floor(Date.now() / 1000);
const claims = (sub, role) => ({
  iss: $env.RECON_JWT_ISSUER || 'recon-dev-idp',
  aud: $env.RECON_JWT_AUDIENCE || 'recon-api',
  sub, tenant_id: tenant, roles: [role], iat: now, nbf: now, exp: now + 900,
});

return [{
  json: {
    tenant,
    batch_id: batchId,
    header: h,
    test_fault: v.test_fault,
    counts: v.counts,
    warnings: v.warnings,
    ledger_csv: toCsv(v.ledger_rows),
    statement_csv: toCsv(v.statement_rows),
    // Montos y estados de entrada por referencia: base del grounding de la IA y del reporte.
    by_ref: Object.fromEntries([
      ...v.ledger_rows.map((r) => [r.payment_ref, null]),
      ...v.statement_rows.map((r) => [r.payment_ref, null]),
    ].map(([ref]) => [ref, {
      ledger: v.ledger_rows.filter((r) => r.payment_ref === ref).map((r) => ({ amount: r.amount, status: r.status, operation: r.operation, occurred_at: r.occurred_at })),
      statement: v.statement_rows.filter((r) => r.payment_ref === ref).map((r) => ({ amount: r.amount, status: r.status, operation: r.operation, occurred_at: r.occurred_at })),
    }])),
    claims: {
      integration: claims('svc-n8n-ingest', 'integration'),
      analyst: claims('svc-n8n-analyst', 'analyst'),
    },
    api: $env.RECON_API_BASE_URL,
    started_at: v.received_at,
    prepared_at: new Date().toISOString(),
  },
}];
