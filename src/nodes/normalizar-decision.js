// Nodo Code: "Normalizar decisión humana".
// Traduce el formulario a la decisión de la API (APPROVE / REJECT / NEEDS_INFORMATION),
// valida motivo y revisor, y arma los claims del JWT de supervisor con el revisor como
// sujeto (la API exige que quien decide no sea quien propuso ni quien pidió la investigación).

const review = $('Consolidar para revisión humana').first().json;
const form = $input.first().json;
const MAP = {
  'Aprobar las propuestas': 'APPROVE',
  'Rechazar las propuestas': 'REJECT',
  'Pedir más información': 'NEEDS_INFORMATION',
};
const raw = form['Decisión'];
const decision = MAP[raw] || null;
const reviewer = String(form['Correo del revisor'] || '').trim().toLowerCase();
const motive = String(form['Motivo'] || '').replace(/\s+/g, ' ').trim();
const decidedAt = new Date().toISOString();
const waitedMs = Date.parse(decidedAt) - Date.parse(review.approval_requested_at);

if (!decision) {
  // Sin envío del formulario: el Wait expiró. No se registra ninguna decisión.
  return [{ json: { decided: false, reason: 'el formulario no se envió antes del límite de espera', waited_ms: waitedMs } }];
}
const problems = [];
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reviewer)) problems.push('correo del revisor inválido');
if (motive.length < 10) problems.push('el motivo debe tener al menos 10 caracteres');
if (problems.length) throw new Error(`Formulario de aprobación inválido: ${problems.join('; ')}`);

const now = Math.floor(Date.now() / 1000);
const subject = `reviewer:${reviewer}`.slice(0, 120);
return [{
  json: {
    decided: true,
    decision,
    decision_label: raw,
    reviewer,
    reason: `${motive} (revisor ${reviewer}, formulario n8n, ejecución ${$execution.id})`.slice(0, 1990),
    decided_at: decidedAt,
    waited_ms: waitedMs,
    claims_supervisor: {
      iss: $env.RECON_JWT_ISSUER || 'recon-dev-idp',
      aud: $env.RECON_JWT_AUDIENCE || 'recon-api',
      sub: subject,
      tenant_id: review.tenant,
      roles: ['supervisor'],
      iat: now, nbf: now, exp: now + 600,
    },
  },
}];
