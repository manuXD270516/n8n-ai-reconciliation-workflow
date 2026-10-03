// Nodo Code: "Sanitizar error" (workflow de errores).
// Arma la notificación a operaciones sin secretos: borra JWT, encabezados Authorization y
// claves PEM que pudieran aparecer en mensajes de error, y recorta el texto.

const e = $input.first().json;
const scrub = (s) => String(s ?? '')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT redactado]')
  .replace(/(authorization|bearer)\s*[:=]?\s*[^\s,;"]+/gi, '$1 [redactado]')
  .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[PEM redactado]')
  .slice(0, 1500);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const info = {
  workflow: e.workflow?.name ?? 'desconocido',
  workflow_id: e.workflow?.id ?? null,
  execution_id: e.execution?.id ?? null,
  execution_url: e.execution?.url ?? null,
  mode: e.execution?.mode ?? null,
  failed_node: e.execution?.lastNodeExecuted ?? e.execution?.error?.node?.name ?? null,
  error_message: scrub(e.execution?.error?.message ?? e.trigger?.error?.message ?? 'sin mensaje'),
  error_description: scrub(e.execution?.error?.description ?? ''),
  at: new Date().toISOString(),
};
const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <h2 style="color:#b91c1c;margin:0 0 8px">Falla en ${esc(info.workflow)}</h2>
  <ul>
    <li>Ejecución: <b>#${esc(info.execution_id)}</b> (${esc(info.mode)})</li>
    <li>Nodo: <b>${esc(info.failed_node)}</b></li>
    <li>Error: ${esc(info.error_message)}</li>
    ${info.error_description ? `<li>Detalle: ${esc(info.error_description)}</li>` : ''}
  </ul>
  ${info.execution_url ? `<p><a href="${esc(info.execution_url)}">Abrir la ejecución en n8n</a></p>` : ''}
  <p style="font-size:12px;color:#6b7280">Mensaje sanitizado: sin tokens ni encabezados de autenticación.</p>
</div>`;
return [{ json: { ...info, email_html: html } }];
