// Nodo Code: "Validar salida IA (o fallback)" (Run Once for All Items).
// Valida la respuesta de Ollama: JSON parseable, enums permitidos para la discrepancia,
// resumen en rango, menciona el payment_ref, no contiene montos que no estén en los datos y
// no contradice la discrepancia determinística. La prioridad la fija una regla, no la IA.
// Si algo falla (Ollama caído, timeout, JSON inválido, valores fuera de rango), usa un
// fallback determinístico. En ambos casos el resultado es una PROPUESTA: decide un humano.

const prepared = $('Preparar prompt IA').all();
const header = $('Preparar contexto y CSV').first().json.header;
const model = $env.OLLAMA_MODEL || 'qwen2.5:7b';

const FALLBACK_ACTION = {
  AMOUNT_MISMATCH: 'REQUEST_PROVIDER_INFO',
  STATUS_MISMATCH: 'REQUEST_PROVIDER_INFO',
  MISSING_EXTERNAL: 'REQUEST_PROVIDER_INFO',
  MISSING_INTERNAL: 'REQUEST_ADJUSTMENT_REVIEW',
};
const DESCRIPTION = {
  AMOUNT_MISMATCH: 'el monto del banco difiere del libro mayor',
  STATUS_MISMATCH: 'el estado informado por el banco no coincide con el del libro mayor',
  MISSING_EXTERNAL: 'el pago está en el libro mayor pero no aparece en el extracto bancario',
  MISSING_INTERNAL: 'el banco informa un pago que no está registrado en el libro mayor',
};

function knownAmounts(e) {
  const set = new Set();
  for (const r of [...e.input.ledger, ...e.input.statement]) set.add(Number(r.amount).toFixed(2));
  if (e.amount_difference_minor !== null && e.amount_difference_minor !== undefined) {
    set.add(Math.abs(e.amount_difference_minor / 100).toFixed(2));
  }
  return set;
}

// Prioridad por regla (no por IA): alta si falta el registro interno o el monto afectado es >= 1000.
function priority(e) {
  const primary = (e.discrepancy_types || [])[0] || e.match_status;
  const amounts = [...e.input.ledger, ...e.input.statement].map((r) => Math.abs(Number(r.amount)));
  const maxAmount = amounts.length ? Math.max(...amounts) : 0;
  return primary === 'MISSING_INTERNAL' || maxAmount >= 1000 ? 'alta' : 'media';
}

// Contradicciones evidentes entre el resumen y la discrepancia determinística.
const CONTRADICTIONS = {
  MISSING_EXTERNAL: /(falta|sin|no (tiene|existe|hay|figura|aparece|está)).{0,30}(registro interno|libro mayor)/i,
  MISSING_INTERNAL: /(falta|sin|no (tiene|existe|hay|figura|aparece|está)).{0,30}(extracto|banco|proveedor)/i,
};

function fallback(e, reasons) {
  const primary = (e.discrepancy_types || [])[0] || e.match_status;
  const diff = e.amount_difference_minor ? Math.abs(e.amount_difference_minor / 100) : 0;
  const prioridad = priority(e);
  const l = e.input.ledger[0];
  const s = e.input.statement[0];
  const parts = [`${e.payment_ref}: ${DESCRIPTION[primary] || `resultado ${e.match_status}`}.`];
  if (l) parts.push(`Libro mayor: ${l.amount} ${header.currency} (${l.status}).`);
  if (s) parts.push(`Banco: ${s.amount} ${header.currency} (${s.status}).`);
  if (diff) parts.push(`Diferencia: ${diff.toFixed(2)} ${header.currency}.`);
  parts.push('Resumen generado por reglas determinísticas (sin IA); requiere revisión humana.');
  return {
    source: 'fallback',
    model: null,
    valid: false,
    reasons,
    causa_probable: 'indeterminado',
    accion_sugerida: e.match_status === 'PROBABLE' ? 'REQUEST_PROVIDER_INFO' : (FALLBACK_ACTION[primary] || 'REQUEST_PROVIDER_INFO'),
    prioridad,
    resumen_es: parts.join(' '),
  };
}

function validate(content, ctx) {
  const reasons = [];
  let out;
  try {
    out = JSON.parse(content);
  } catch (err) {
    return { reasons: ['json_invalido'] };
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) return { reasons: ['no_es_objeto'] };
  const { causes, actions } = ctx.ai_request.allowed;
  if (!causes.includes(out.causa_probable)) reasons.push('causa_fuera_de_enum');
  if (!actions.includes(out.accion_sugerida)) reasons.push('accion_no_permitida');
  const summary = typeof out.resumen_es === 'string' ? out.resumen_es.trim() : '';
  const primary = (ctx.exception.discrepancy_types || [])[0];
  if (CONTRADICTIONS[primary] && CONTRADICTIONS[primary].test(summary)) reasons.push('resumen_contradice_discrepancia');
  if (summary.length < 40 || summary.length > 700) reasons.push('resumen_longitud');
  if (!summary.includes(ctx.exception.payment_ref)) reasons.push('resumen_sin_payment_ref');
  const known = knownAmounts(ctx.exception);
  const normalized = summary.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  const mentioned = (normalized.match(/\d+[.,]\d{2}(?!\d)/g) || []).map((m) => Number(m.replace(',', '.')).toFixed(2));
  const invented = mentioned.filter((m) => !known.has(m));
  if (invented.length) reasons.push(`montos_no_respaldados:${invented.join('|')}`);
  return {
    reasons,
    out: {
      causa_probable: out.causa_probable,
      accion_sugerida: out.accion_sugerida,
      prioridad: priority(ctx.exception),
      resumen_es: summary,
    },
  };
}

return $input.all().map((it, i) => {
  const ctx = prepared[i].json;
  const res = it.json;
  let ai;
  const latency = res.total_duration ? Math.round(res.total_duration / 1e6) : null;
  if (res.error || !res.message || typeof res.message.content !== 'string') {
    const msg = String(res.error?.message || res.error || 'respuesta vacía').slice(0, 160);
    ai = fallback(ctx.exception, [`ollama_no_disponible: ${msg}`]);
  } else {
    const { reasons, out } = validate(res.message.content, ctx);
    if (reasons.length === 0) {
      ai = { source: 'ollama', model, valid: true, reasons: [], latency_ms: latency, eval_count: res.eval_count ?? null, ...out };
    } else {
      ai = { ...fallback(ctx.exception, reasons), latency_ms: latency, rejected_output_excerpt: res.message.content.slice(0, 240) };
    }
  }
  const tag = ai.source === 'ollama'
    ? `[Borrador IA local ${model}; requiere revisión humana]`
    : `[Fallback determinístico: ${ai.reasons.join(', ').slice(0, 160)}]`;
  const rationale = `${tag} ${ai.resumen_es}`.slice(0, 1990);
  const { ai_request: request, ...rest } = ctx;
  return {
    json: { ...rest, ai: { ...ai, rationale }, ai_facts: request.facts, ai_validated_at: new Date().toISOString() },
    pairedItem: { item: i },
  };
});
