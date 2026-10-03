// Nodo Code: "Esperar investigaciones (polling acotado)" (Run Once for All Items).
// Para cada excepción consulta GET /v1/investigations/{id} hasta un estado terminal o hasta
// agotar el presupuesto de tiempo (RECON_INVESTIGATION_TIMEOUT_S). Si la API rechazó la
// investigación (p. ej. 503 ai_disabled por kill switch) el caso sigue sin borrador.
// La investigación de la API produce BORRADORES sin efecto operativo; no decide nada.

const TERMINAL = ['NOT_NEEDED', 'DRAFTED', 'ABSTAINED', 'ESCALATED', 'FAILED'];
const base = $env.RECON_API_BASE_URL;
const token = $('Firmar JWT analista').first().json.token;
const budgetMs = Number($env.RECON_INVESTIGATION_TIMEOUT_S || 90) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const inputs = $input.all();
const cases = $('Abrir caso (API)').all();
const exceptions = $('Separar excepciones').all();
const pending = new Map();
const results = inputs.map((it, i) => {
  const accepted = it.json;
  const caseOpened = cases[i].json;
  const row = { ...exceptions[i].json, case_id: caseOpened.case_id, case_created: caseOpened.created };
  if (!accepted || accepted.error || !accepted.investigation_id) {
    const reason = accepted?.error?.message || accepted?.error || 'sin investigation_id';
    return { ...row, investigation: { id: null, state: 'NOT_REQUESTED', error: String(reason).slice(0, 200) } };
  }
  pending.set(i, accepted.investigation_id);
  return { ...row, investigation: { id: accepted.investigation_id, state: accepted.status || 'REQUESTED' } };
});

let polls = 0;
while (pending.size > 0 && Date.now() - started < budgetMs) {
  for (const [i, id] of [...pending.entries()]) {
    polls++;
    let body;
    try {
      body = await this.helpers.httpRequest({
        method: 'GET',
        url: `${base}/v1/investigations/${id}`,
        headers: { Authorization: `Bearer ${token}` },
        json: true,
        timeout: 10000,
      });
    } catch (e) {
      continue; // error transitorio: se reintenta en la próxima vuelta dentro del presupuesto
    }
    if (TERMINAL.includes(body.state)) {
      const draft = body.record?.draft || null;
      results[i].investigation = {
        id,
        state: body.state,
        model_kind: body.record?.model_kind || null,
        model: body.record?.model || null,
        reason: body.record?.reason || null,
        review_result: draft?.review_result?.result || null,
        recommended_next_step: draft?.recommended_next_step || null,
        operational_effect: draft?.operational_effect || null,
        confidence: draft?.confidence_assessment || null,
        facts: (draft?.facts || []).map((f) => f.statement).slice(0, 6),
        inferences: (draft?.inferences || []).map((f) => f.statement).slice(0, 4),
        hypotheses: (draft?.hypotheses || []).map((f) => f.statement).slice(0, 4),
        missing_evidence: (draft?.missing_evidence || []).slice(0, 4),
        elapsed_ms: Date.parse(body.updated_at) - Date.parse(body.created_at),
      };
      pending.delete(i);
    }
  }
  if (pending.size > 0) await sleep(1500);
}
for (const i of pending.keys()) results[i].investigation.state = 'TIMEOUT';

const waitedMs = Date.now() - started;
return results.map((r, i) => ({
  json: { ...r, investigation_wait_ms: waitedMs, investigation_polls: polls },
  pairedItem: { item: i },
}));
