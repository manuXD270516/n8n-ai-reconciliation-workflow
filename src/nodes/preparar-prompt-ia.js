// Nodo Code: "Preparar prompt IA" (Run Once for All Items).
// Arma, por excepción, la llamada a Ollama /api/chat con un JSON Schema cuyo enum de
// causas y acciones se restringe a lo permitido para esa discrepancia. El modelo sólo ve
// hechos determinísticos (resultado del run, montos de entrada, borrador de la API).

const CAUSES_BY_DISCREPANCY = {
  AMOUNT_MISMATCH: ['comision_o_liquidacion_neta', 'error_de_datos_o_mapeo', 'indeterminado'],
  STATUS_MISMATCH: ['rechazo_o_reverso_del_proveedor', 'error_de_datos_o_mapeo', 'indeterminado'],
  MISSING_EXTERNAL: ['rezago_o_ausencia_en_reporte_proveedor', 'rechazo_o_reverso_del_proveedor', 'indeterminado'],
  MISSING_INTERNAL: ['registro_interno_faltante_o_tardio', 'duplicado_posible', 'error_de_datos_o_mapeo', 'indeterminado'],
};
const ALL_CAUSES = [...new Set(Object.values(CAUSES_BY_DISCREPANCY).flat())];
const ACTIONS_BY_DISCREPANCY = {
  AMOUNT_MISMATCH: ['REQUEST_PROVIDER_INFO', 'REQUEST_ADJUSTMENT_REVIEW'],
  STATUS_MISMATCH: ['REQUEST_PROVIDER_INFO', 'REQUEST_ADJUSTMENT_REVIEW'],
  MISSING_EXTERNAL: ['REQUEST_PROVIDER_INFO', 'REQUEST_ADJUSTMENT_REVIEW'],
  MISSING_INTERNAL: ['REQUEST_ADJUSTMENT_REVIEW', 'REQUEST_PROVIDER_INFO'],
};

const MEANING = {
  AMOUNT_MISMATCH: 'el pago existe en ambas fuentes pero el monto del banco difiere del libro mayor',
  STATUS_MISMATCH: 'el pago existe en ambas fuentes pero el estado del banco no coincide con el del libro mayor',
  MISSING_EXTERNAL: 'el pago está registrado en el libro mayor interno pero NO aparece en el extracto del banco',
  MISSING_INTERNAL: 'el banco informa el pago en su extracto pero NO está registrado en el libro mayor interno',
};

const fault = $('Preparar contexto y CSV').first().json.test_fault;
const header = $('Preparar contexto y CSV').first().json.header;
const model = $env.OLLAMA_MODEL || 'qwen2.5:7b';
const url = fault === 'ollama_unreachable'
  ? 'http://127.0.0.1:9/api/chat' // falla inyectada: puerto cerrado dentro del contenedor
  : `${$env.OLLAMA_BASE_URL}/api/chat`;

return $input.all().map((it, i) => {
  const c = it.json;
  const e = c.exception;
  const primary = (e.discrepancy_types || [])[0] || e.match_status;
  const causes = CAUSES_BY_DISCREPANCY[primary] || ALL_CAUSES;
  let actions = ACTIONS_BY_DISCREPANCY[primary] || ['REQUEST_PROVIDER_INFO', 'REQUEST_ADJUSTMENT_REVIEW'];
  if (e.match_status === 'PROBABLE') actions = ['ACCEPT_PROBABLE_MATCH', 'REQUEST_PROVIDER_INFO'];
  const diff = e.amount_difference_minor === null || e.amount_difference_minor === undefined
    ? null : (e.amount_difference_minor / 100).toFixed(2);
  const facts = {
    payment_ref: e.payment_ref,
    moneda: header.currency,
    proveedor: header.provider_id,
    estado_conciliacion: e.match_status,
    discrepancias: e.discrepancy_types,
    significado: MEANING[primary] || null,
    regla: e.rule,
    explicacion_regla: e.explanation,
    diferencia_proveedor_menos_libro: diff,
    libro_mayor: e.input.ledger,
    extracto_banco: e.input.statement,
    investigacion_api: {
      estado: c.investigation.state,
      revision: c.investigation.review_result || null,
      siguiente_paso_sugerido: c.investigation.recommended_next_step || null,
      hechos: c.investigation.facts || [],
      hipotesis: c.investigation.hypotheses || [],
    },
  };
  const schema = {
    type: 'object',
    properties: {
      causa_probable: { type: 'string', enum: causes },
      accion_sugerida: { type: 'string', enum: actions },
      resumen_es: { type: 'string' },
    },
    required: ['causa_probable', 'accion_sugerida', 'resumen_es'],
  };
  const invalidFault = fault === 'ollama_invalid_json';
  const system = invalidFault
    // Falla inyectada: se pide texto libre y se omite el schema para obtener una salida no JSON real.
    ? 'Eres un analista. Responde con un párrafo breve en texto libre, sin JSON ni llaves.'
    : [
      'Eres un asistente de conciliación de pagos. Tu salida es un BORRADOR para un revisor humano:',
      'no apruebas ni rechazas nada. Usa sólo los datos entregados; no inventes montos, fechas ni causas.',
      'Clasifica la excepción eligiendo causa_probable y accion_sugerida SOLO de los valores permitidos,',
      'Respeta el campo significado: indica en qué fuente falta o difiere el pago.',
      `y escribe resumen_es: 2 o 3 frases en español que incluyan el payment_ref ${e.payment_ref} y los montos`,
      'exactamente como aparecen (dos decimales). Responde únicamente con el objeto JSON.',
    ].join(' ');
  const body = {
    model,
    stream: false,
    options: { temperature: 0, num_predict: 400 },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Excepción a clasificar:\n${JSON.stringify(facts, null, 2)}` },
    ],
  };
  if (!invalidFault) body.format = schema;
  return {
    json: { ...c, ai_started_at: new Date().toISOString(), ai_request: { url, body, allowed: { causes, actions }, facts } },
    pairedItem: { item: i },
  };
});
