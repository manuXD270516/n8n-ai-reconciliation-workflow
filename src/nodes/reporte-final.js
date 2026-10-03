// Nodo Code: "Reporte final" (Run Once for All Items -> 1 ítem).
// Se alcanza por tres caminos: sin excepciones, sin decisión (Wait expirado) o después de
// registrar las decisiones. Calcula métricas y tiempos con datos de la propia ejecución.

const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const ctx = $('Preparar contexto y CSV').first().json;
const ingest = $('Verificar recibos de ingesta').first().json;
const run = safe(() => $('Separar excepciones').first().json.run);
const review = safe(() => $('Consolidar para revisión humana').first().json);
const decisionInput = safe(() => $('Normalizar decisión humana').first().json);
const perCase = safe(() => $('Decisiones por caso').all(), []);
const registered = safe(() => $('Registrar decisión (API)').all(), []);
const audits = safe(() => $('Leer auditoría del caso (API)').all(), []);
const aiItems = safe(() => $('Validar salida IA (o fallback)').all(), []);

const now = new Date();
const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const decisions = registered.map((r, i) => {
  const audit = audits[i]?.json || {};
  const recorded = (audit.decisions || []).find((d) => d.id === r.json.decision_id);
  return {
    case_id: perCase[i]?.json.case_id,
    payment_ref: perCase[i]?.json.payment_ref,
    decision_id: r.json.decision_id,
    decision: r.json.decision,
    replayed: r.json.replayed,
    operational_effect: r.json.operational_effect,
    case_status: audit.case?.status ?? null,
    approver: recorded?.approver ?? null,
    audit_entries: (audit.audit || []).length,
    audit_actions: [...new Set((audit.audit || []).map((a) => a.action))],
  };
});

let outcome = 'COMPLETED_NO_EXCEPTIONS';
if (review && decisionInput && decisionInput.decided === false) outcome = 'NO_DECISION_TIMEOUT';
else if (review) outcome = 'COMPLETED_WITH_HUMAN_DECISION';

const aiMs = aiItems.length ? ms(aiItems[0].json.ai_started_at, aiItems[0].json.ai_validated_at) : null;
const total = ms(ctx.started_at, now.toISOString());
const humanWait = decisionInput?.waited_ms ?? null;
const report = {
  outcome,
  execution_id: $execution.id,
  statement_id: ctx.header.statement_id,
  tenant: ctx.tenant,
  batch_id: ctx.batch_id,
  data_origin: 'SYNTHETIC',
  metrics: {
    transactions_received: ctx.counts.ledger + ctx.counts.statement,
    ledger_rows: ctx.counts.ledger,
    statement_rows: ctx.counts.statement,
    rows_accepted_by_api: ingest.receipts.ledger.accepted + ingest.receipts.statement.accepted,
    rows_quarantined_by_api: ingest.receipts.ledger.rejected + ingest.receipts.statement.rejected,
    payments_evaluated: run?.results ?? 0,
    reconciled_exact: run?.exact ?? 0,
    exceptions: run?.exceptions ?? 0,
    match_status_counts: run?.counts ?? {},
    ai_classified_valid: review?.ai_valid ?? 0,
    ai_fallback: review?.ai_fallback ?? 0,
    decisions_registered: decisions.filter((d) => d.decision_id).length,
    decision: decisionInput?.decision ?? null,
    reviewer: decisionInput?.reviewer ?? null,
  },
  timings_ms: {
    total,
    validation_to_ingest_done: ms(ctx.started_at, ingest.ingested_at),
    run_in_api: run ? ms(run.requested_at, run.completed_at) : null,
    investigations_wait: aiItems[0]?.json.investigation_wait_ms ?? null,
    ai_classification: aiMs,
    human_wait: humanWait,
    automated: total !== null && humanWait !== null ? total - humanWait : total,
  },
  run: run ? { run_id: run.run_id, ruleset_version: run.ruleset_version, snapshot_hash: run.snapshot_hash } : null,
  cases: (review?.cases || []).map((c) => ({
    case_id: c.case_id,
    payment_ref: c.payment_ref,
    match_status: c.match_status,
    discrepancy_types: c.discrepancy_types,
    recommendation_id: c.recommendation_id,
    investigation_state: c.investigation.state,
    investigation_review: c.investigation.review_result,
    ai_source: c.ai.source,
    ai_reasons: c.ai.reasons,
    causa_probable: c.ai.causa_probable,
    accion_sugerida: c.ai.accion_sugerida,
    prioridad: c.ai.prioridad,
  })),
  decisions,
  warnings: ctx.warnings,
  finished_at: now.toISOString(),
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const m = report.metrics;
const t = report.timings_ms;
const sec = (v) => (v === null || v === undefined ? 'n/d' : `${(v / 1000).toFixed(1)} s`);
const decisionRows = decisions.map((d) => `<tr><td><code>${esc(d.payment_ref)}</code></td><td>${esc(d.decision)}</td><td>${esc(d.case_status)}</td><td><code>${esc(d.decision_id)}</code></td><td>${esc(d.approver)}</td><td>${d.audit_entries}</td></tr>`).join('');
const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:900px">
  <h2 style="margin:0 0 8px">Reporte de conciliación ${esc(report.statement_id)}: ${esc(outcome)}</h2>
  <p>Datos sintéticos · ejecución n8n #${esc(report.execution_id)} · tenant <code>${esc(report.tenant)}</code></p>
  <ul>
    <li>Transacciones recibidas: <b>${m.transactions_received}</b> (${m.ledger_rows} libro mayor + ${m.statement_rows} extracto); aceptadas por la API: ${m.rows_accepted_by_api}</li>
    <li>Pagos evaluados: <b>${m.payments_evaluated}</b> · conciliados EXACT: <b>${m.reconciled_exact}</b> · excepciones: <b>${m.exceptions}</b></li>
    <li>Clasificación IA válida: ${m.ai_classified_valid} · fallback determinístico: ${m.ai_fallback}</li>
    <li>Decisión humana: <b>${esc(m.decision ?? 'ninguna')}</b> por ${esc(m.reviewer ?? 'n/d')} · decisiones registradas en la API: <b>${m.decisions_registered}</b></li>
    <li>Tiempos: total ${sec(t.total)} · automatizado ${sec(t.automated)} · espera humana ${sec(t.human_wait)} · run en API ${sec(t.run_in_api)} · IA ${sec(t.ai_classification)}</li>
  </ul>
  ${decisionRows ? `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#d1d5db;font-size:13px"><thead style="background:#f3f4f6"><tr><th>Pago</th><th>Decisión</th><th>Estado del caso</th><th>decision_id</th><th>Aprobador</th><th>Entradas de auditoría</th></tr></thead><tbody>${decisionRows}</tbody></table>` : ''}
  <p style="font-size:12px;color:#6b7280">Aprobar sólo registra la decisión: la API no mueve dinero (operational_effect: none).</p>
</div>`;

return [{ json: { report, email_html: html, email_subject: `[Reporte] Conciliación ${report.statement_id}: ${m.reconciled_exact}/${m.payments_evaluated} conciliadas, ${m.exceptions} excepciones, ${m.decisions_registered} decisiones` } }];
