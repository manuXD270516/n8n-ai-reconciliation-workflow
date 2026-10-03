// Nodo Code: "Consolidar para revisión humana" (Run Once for All Items -> 1 ítem).
// Junta casos, recomendaciones (propuestas por el analista de servicio) y el resumen de la
// IA o del fallback; arma el HTML del correo y el texto del formulario de aprobación.

const ctx = $('Preparar contexto y CSV').first().json;
const classified = $('Validar salida IA (o fallback)').all();
const recs = $input.all();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const cases = recs.map((r, i) => {
  const c = classified[i].json;
  return {
    case_id: c.case_id,
    recommendation_id: r.json.recommendation_id,
    recommendation_status: r.json.status,
    payment_ref: c.exception.payment_ref,
    ordinal: c.exception.ordinal,
    match_status: c.exception.match_status,
    discrepancy_types: c.exception.discrepancy_types,
    amount_difference: c.exception.amount_difference_minor == null ? null : (c.exception.amount_difference_minor / 100).toFixed(2),
    investigation: {
      id: c.investigation.id,
      state: c.investigation.state,
      review_result: c.investigation.review_result || null,
      model_kind: c.investigation.model_kind || null,
      attached_to_recommendation: c.investigation.state === 'DRAFTED' && c.investigation.review_result === 'SUPPORTED',
    },
    ai: {
      source: c.ai.source,
      model: c.ai.model,
      reasons: c.ai.reasons,
      causa_probable: c.ai.causa_probable,
      accion_sugerida: c.ai.accion_sugerida,
      prioridad: c.ai.prioridad,
      resumen_es: c.ai.resumen_es,
      latency_ms: c.ai.latency_ms ?? null,
    },
  };
});

const run = classified[0].json.run;
const aiOk = cases.filter((c) => c.ai.source === 'ollama').length;
const rows = cases.map((c) => `
  <tr>
    <td><code>${esc(c.payment_ref)}</code></td>
    <td>${esc(c.match_status)}<br><small>${esc(c.discrepancy_types.join(', '))}</small></td>
    <td>${esc(c.ai.accion_sugerida)}<br><small>prioridad ${esc(c.ai.prioridad)} · causa ${esc(c.ai.causa_probable)}</small></td>
    <td>${esc(c.ai.resumen_es)}<br><small>${c.ai.source === 'ollama' ? `IA local ${esc(c.ai.model)} (validada)` : `fallback determinístico (${esc(c.ai.reasons.join(', '))})`} · investigación API: ${esc(c.investigation.state)}${c.investigation.review_result ? ` / ${esc(c.investigation.review_result)}` : ''}</small></td>
  </tr>`).join('');

const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:900px">
  <h2 style="margin:0 0 8px">Aprobación requerida: conciliación ${esc(ctx.header.statement_id)}</h2>
  <p style="margin:0 0 12px">Datos <b>sintéticos</b>. Proveedor ${esc(ctx.header.provider_id)} · cuenta ${esc(ctx.header.merchant_account)} · ${esc(ctx.header.currency)} · tenant <code>${esc(ctx.tenant)}</code></p>
  <p style="margin:0 0 12px">Run <code>${esc(run.run_id)}</code> (${esc(run.ruleset_version)}): ${run.results} partidas, <b>${run.exact} conciliadas</b>, <b>${run.exceptions} excepciones</b>. Clasificación IA válida en ${aiOk}/${cases.length}; el resto usa fallback determinístico.</p>
  <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#d1d5db;font-size:13px">
    <thead style="background:#f3f4f6"><tr><th>Pago</th><th>Resultado</th><th>Propuesta</th><th>Resumen para el revisor</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin:16px 0">La IA no decide: cada fila es una propuesta registrada en la API. Su decisión quedará auditada caso por caso.</p>
  <p><a href="__RESUME_URL__" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Revisar y aprobar o rechazar</a></p>
  <p style="font-size:12px;color:#6b7280">Enlace de un solo uso, firmado por n8n. Expira en 24 h. Ejecución n8n #${esc($execution.id)}.</p>
</div>`;

const text = cases.map((c, i) => `${i + 1}. ${c.payment_ref} · ${c.match_status} (${c.discrepancy_types.join(', ')}) → ${c.ai.accion_sugerida}, prioridad ${c.ai.prioridad}. ${c.ai.resumen_es}`).join('\n');

return [{
  json: {
    tenant: ctx.tenant,
    statement_id: ctx.header.statement_id,
    run,
    cases,
    ai_valid: aiOk,
    ai_fallback: cases.length - aiOk,
    email_html: html,
    form_text: `Conciliación ${ctx.header.statement_id} (datos sintéticos): ${run.exact} conciliadas, ${run.exceptions} excepciones.\n\n${text}\n\nLa decisión se aplica a cada caso por separado y queda auditada en la API.`,
    approval_requested_at: new Date().toISOString(),
  },
}];
