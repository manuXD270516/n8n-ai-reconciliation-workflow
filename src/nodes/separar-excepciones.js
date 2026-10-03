// Nodo Code: "Separar excepciones" (Run Once for All Items).
// Resume el run (conteos por estado) y emite un ítem por partida no conciliada. Las
// conciliadas EXACT no pasan a investigación. Si no hay excepciones emite un único ítem
// con exception = null para que el flujo vaya directo al reporte.

const ctx = $('Preparar contexto y CSV').first().json;
const run = $('¿Run completado?').first().json;
const items = $input.first().json.items || [];
const counts = {};
for (const it of items) counts[it.match_status] = (counts[it.match_status] || 0) + 1;
const exceptions = items.filter((it) => it.match_status !== 'EXACT');
const summary = {
  run_id: run.run_id,
  run_number: run.run_number,
  ruleset_version: run.ruleset_version,
  snapshot_hash: run.snapshot_hash,
  observation_count: run.observation_count,
  requested_at: run.requested_at,
  completed_at: run.completed_at,
  results: items.length,
  counts,
  exact: counts.EXACT || 0,
  exceptions: exceptions.length,
};
if (exceptions.length === 0) return [{ json: { exception: null, run: summary } }];
return exceptions.map((it) => ({
  json: {
    exception: {
      run_id: run.run_id,
      ordinal: it.ordinal,
      payment_ref: it.payment_ref,
      operation_type: it.operation_type,
      match_status: it.match_status,
      rule: it.rule,
      discrepancy_types: it.discrepancy_types,
      amount_difference_minor: it.amount_difference_minor,
      explanation: it.explanation,
      input: ctx.by_ref[it.payment_ref] || { ledger: [], statement: [] },
    },
    run: summary,
  },
}));
