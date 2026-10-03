// Nodo Code: "Decisiones por caso" (1 ítem -> 1 ítem por caso).
// Cada caso recibe su propia decisión en la API, con una clave de idempotencia estable
// (ejecución + caso): los reintentos HTTP nunca duplican decisiones.

const review = $('Consolidar para revisión humana').first().json;
const d = $('Normalizar decisión humana').first().json;
return review.cases.map((c) => ({
  json: {
    case_id: c.case_id,
    payment_ref: c.payment_ref,
    recommendation_id: c.recommendation_id,
    decision: d.decision,
    reason: d.reason,
    idempotency_key: `n8n-${$execution.id}-${c.case_id}`,
  },
}));
