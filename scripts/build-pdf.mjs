// Genera deliverables/evidencia-n8n.pdf (HTML -> PDF con Playwright/Chromium) y copia el
// workflow exportado a deliverables/workflow-n8n.json. Los números salen de evidence/*.json.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'deliverables');
mkdirSync(out, { recursive: true });
const REPO = 'https://github.com/manuXD270516/n8n-ai-reconciliation-workflow';
const ev = (f) => JSON.parse(readFileSync(join(root, 'evidence', f), 'utf8'));
const summary = ev('e2e-summary.json');
const A = ev('e2e-A_camino_feliz.json');
const C = ev('e2e-C_ollama_caido.json');
const D = ev('e2e-D_respuesta_invalida_modelo.json');
const E = ev('e2e-E_error_api_error_trigger.json');
const B = ev('e2e-B_entradas_invalidas.json');
const bug = ev('hallazgo-api-needs-information.json');
const workflow = JSON.parse(readFileSync(join(root, 'workflows', 'conciliacion-ia-aprobacion-humana.json'), 'utf8'));
copyFileSync(join(root, 'workflows', 'conciliacion-ia-aprobacion-humana.json'), join(out, 'workflow-n8n.json'));

const img = (f) => `data:image/png;base64,${readFileSync(join(root, 'docs', 'img', f)).toString('base64')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sec = (ms) => (ms == null ? 'n/d' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
const m = A.report.metrics;
const t = A.report.timings_ms;
const types = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote')
  .reduce((acc, n) => ({ ...acc, [n.type.replace('n8n-nodes-base.', '')]: (acc[n.type.replace('n8n-nodes-base.', '')] || 0) + 1 }), {});
const pick = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  return { name: n.name, type: n.type, typeVersion: n.typeVersion, parameters: n.parameters, ...(n.retryOnFail ? { retryOnFail: n.retryOnFail, maxTries: n.maxTries } : {}), ...(n.onError ? { onError: n.onError } : {}), ...(n.credentials ? { credentials: n.credentials } : {}) };
};
const excerpt = JSON.stringify([pick('Clasificar con Ollama (qwen2.5:7b)'), pick('Registrar decisión (API)')], null, 2);
const validatorExcerpt = readFileSync(join(root, 'src', 'nodes', 'validar-salida-ia.js'), 'utf8').split('\n').slice(70, 102).join('\n');

const mermaid = `flowchart TD
  A[Webhook POST extracto] --> B{Validar}
  B -- inválido --> R400[400 errores]
  B -- válido --> R202[202 + id]
  R202 --> I[Ingesta API]
  I --> L[Lote + run rules/v1]
  L --> P{Polling acotado}
  P --> X{Excepciones?}
  X -- sí --> C[Caso + investigación API]
  C --> O[Ollama qwen2.5:7b]
  O --> V{Validación}
  V -- ok --> RC[Propuesta en API]
  V -- falla --> FB[Fallback determinístico] --> RC
  RC --> M[Correo Mailpit]
  M --> W[[Wait: formulario humano]]
  W --> D[Decisión auditada por caso]
  D --> REP[Reporte final]
  X -- no --> REP
  ERR[[Error Trigger]] --> EM[Alerta sanitizada]`;

const rows = [
  ['A. Camino feliz', `#${A.execution_id}`, `success · ${m.reconciled_exact} EXACT / ${m.exceptions} excepciones · IA válida ${m.ai_classified_valid}/${m.exceptions} · ${m.decisions_registered} APPROVE auditadas · idempotencia replayed=${A.idempotency_replay?.replayed}`],
  ['B. Entradas inválidas', B.executions.map((e) => `#${e.execution_id}`).join(', '), B.cases.map((c) => `${c.case}: ${c.status}`).join(' · ')],
  ['C. Ollama caído (falla inyectada)', `#${C.execution_id}`, `success · fallback ${C.report.metrics.ai_fallback}/4 (ECONNREFUSED) · ${C.report.metrics.decisions_registered} REJECT auditadas`],
  ['D. Respuesta inválida del modelo', `#${D.execution_id}`, `success · validador rechazó 4/4 (json_invalido) · fallback · ${D.report.metrics.decisions_registered} APPROVE`],
  ['E. Error de API (falla inyectada)', `#${E.execution_id} / #${E.error_workflow_execution}`, `error en "${E.failed_node.node}" (422) · Error Trigger envió correo sanitizado`],
  ['F. Inyección deshabilitada', '—', 'test_fault rechazado con 400'],
];

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Evidencia n8n</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<style>
  @page { size: A4; margin: 14mm 13mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1f2937; font-size: 10.5pt; line-height: 1.4; }
  h1 { font-size: 19pt; margin: 0 0 4px; } h2 { font-size: 13pt; margin: 16px 0 6px; border-bottom: 2px solid #e5e7eb; padding-bottom: 3px; }
  .sub { color: #4b5563; margin: 0 0 10px; } .tag { display: inline-block; background: #eef2ff; color: #3730a3; border-radius: 4px; padding: 1px 6px; font-size: 9pt; margin-right: 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 9.2pt; } th, td { border: 1px solid #d1d5db; padding: 4px 6px; vertical-align: top; text-align: left; } th { background: #f3f4f6; }
  .kpi { display: flex; gap: 8px; margin: 8px 0; } .kpi div { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px; text-align: center; } .kpi b { display: block; font-size: 15pt; color: #1d4ed8; }
  img { width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; } figure { margin: 8px 0; } figcaption { font-size: 9pt; color: #6b7280; }
  pre { background: #f8fafc; border: 1px solid #e5e7eb; padding: 6px; font-size: 7.4pt; white-space: pre-wrap; word-break: break-all; }
  .page { page-break-before: always; } ul { margin: 4px 0; padding-left: 18px; } .mermaid { text-align: center; } .mermaid svg { max-height: 640px; }
</style></head><body>
<h1>Conciliación de pagos asistida por IA con aprobación humana (n8n)</h1>
<p class="sub">Manuel Saavedra · ${esc(summary.finished_at.slice(0, 10))} · Repositorio: <a href="${REPO}">${REPO}</a></p>
<p><span class="tag">n8n CE ${esc(summary.preflight.n8n_version)}</span><span class="tag">FastAPI (API propia)</span><span class="tag">Ollama ${esc(summary.preflight.model)}</span><span class="tag">Mailpit</span><span class="tag">Playwright</span><span class="tag">Docker Compose</span><span class="tag">datos sintéticos</span></p>

<h2>Qué proceso automatiza</h2>
<p>La conciliación de un extracto bancario contra el libro mayor interno. Un webhook recibe el extracto (CSV o JSON) y n8n lo valida. Luego n8n lo ingiere en la API de conciliación, lanza el run de reglas determinísticas y espera el resultado con polling acotado. Para cada excepción pide la investigación de la API y clasifica la excepción con un LLM local, cuya salida se valida y tiene fallback determinístico. Después envía un correo con un formulario de aprobación y espera la decisión humana (nodo Wait). Esa decisión se registra en la API como decisión auditada e idempotente, caso por caso. Al final, n8n envía un reporte con métricas y tiempos. La IA nunca decide.</p>

<h2>Sistemas, APIs y herramientas integradas</h2>
<ul>
  <li><b>n8n Community Edition</b>, self-hosted con imagen fijada por digest. Nodos usados: ${Object.entries(types).map(([k, v]) => `${v} ${k}`).join(', ')}, más un workflow con Error Trigger.</li>
  <li><b>API de conciliación</b> (FastAPI, proyecto propio <i>fintech-ai-reconciliation-agent</i>): artifacts, batches, runs, results, cases, investigations, recommendations, decisions y audit, con JWT RS256 firmado por el nodo JWT de n8n desde una credencial cifrada.</li>
  <li><b>Ollama</b> local con qwen2.5:7b vía <code>/api/chat</code>, salida JSON Schema con enums restringidos y temperatura 0.</li>
  <li><b>Mailpit</b> (SMTP local) para la aprobación, el reporte y las alertas. <b>Playwright/Chromium</b> para el e2e, las capturas y este PDF.</li>
</ul>

<h2>Qué desarrollé</h2>
<ul>
  <li>Diseñé el flujo según lo que la API permite. Escribí ${workflow.nodes.length - 4} nodos funcionales y el código de 13 nodos Code: validación, polling, prompt, validador de IA, fallback y reportes.</li>
  <li>Armé la infraestructura reproducible: Compose y un <code>setup.ps1</code> que importa credenciales y workflows con <code>n8n import</code> y los publica.</li>
  <li>Escribí la validación end-to-end real con 6 escenarios, incluidos los negativos, la verificación independiente en la API y en Mailpit, y la evidencia JSON.</li>
  <li>Hallazgo: el e2e detectó un bug real en la API (<code>NEEDS_INFORMATION</code> responde 500). Lo documenté y dejé el workflow seguro.</li>
</ul>

<h2>Resultado medido (corrida real, ejecución n8n #${esc(A.execution_id)})</h2>
<div class="kpi">
  <div><b>${m.transactions_received}</b>transacciones</div><div><b>${m.payments_evaluated}</b>pagos evaluados</div>
  <div><b>${m.reconciled_exact}</b>conciliados EXACT</div><div><b>${m.exceptions}</b>excepciones</div>
  <div><b>${m.ai_classified_valid}/${m.exceptions}</b>IA válida</div><div><b>${m.decisions_registered}</b>decisiones auditadas</div>
</div>
<p>Tiempos:</p>
<ul>
  <li><b>Automatizado: ${sec(t.automated)}</b> (validación + ingesta ${sec(t.validation_to_ingest_done)}, run en la API ${sec(t.run_in_api)}, investigaciones ${sec(t.investigations_wait)}, IA ${sec(t.ai_classification)}).</li>
  <li>Espera humana: ${sec(t.human_wait)}. Es el formulario llenado por el e2e con Playwright.</li>
</ul>
<p>Verificaciones del e2e: <b>${summary.passed} OK, ${summary.failed} fallidas</b>.</p>
<table><thead><tr><th>Escenario</th><th>Ejecución</th><th>Resultado verificado</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}
</tbody></table>

<div class="page"></div>
<h2>Diagrama del flujo</h2>
<pre class="mermaid">${esc(mermaid)}</pre>
<figure><img src="${img('workflow-canvas.png')}"><figcaption>Canvas del workflow en el editor de n8n (captura real, instancia local).</figcaption></figure>

<div class="page"></div>
<h2>Capturas de la ejecución</h2>
<figure><img src="${img('ejecucion-exitosa.png')}"><figcaption>Ejecución #${esc(A.execution_id)} del camino feliz: todos los nodos ejecutados en verde, incluida la reanudación del Wait.</figcaption></figure>
<figure><img src="${img('email-aprobacion.png')}"><figcaption>Correo de aprobación en Mailpit: propuestas por excepción, resumen de la IA validada y enlace firmado al formulario.</figcaption></figure>

<div class="page"></div>
<figure><img src="${img('formulario-aprobacion.png')}" style="width:75%"><figcaption>Formulario del nodo Wait, llenado por Playwright en el e2e.</figcaption></figure>
<figure><img src="${img('email-reporte.png')}"><figcaption>Reporte final: métricas, decisiones registradas (decision_id, aprobador) y entradas de auditoría.</figcaption></figure>

<div class="page"></div>
<figure><img src="${img('email-error.png')}" style="width:85%"><figcaption>Alerta del Error Trigger (escenario E), sanitizada sin tokens.</figcaption></figure>
<h2>Extracto del workflow exportado</h2>
<p>Dos nodos del JSON importable (<code>workflows/conciliacion-ia-aprobacion-humana.json</code>, copia en <code>deliverables/workflow-n8n.json</code>). Las credenciales sólo se referencian por id: no hay secretos embebidos.</p>
<pre>${esc(excerpt.length > 4200 ? `${excerpt.slice(0, 4200)}\n…` : excerpt)}</pre>
<p>Fragmento del validador de la salida de la IA (nodo Code):</p>
<pre>${esc(validatorExcerpt)}</pre>

<h2>Limitaciones</h2>
<ul>
  <li><b>Datos y alcance:</b> datos sintéticos y entorno local, sin producción. El modelo es local (7B): sus causas probables son sólo propuestas, la prioridad la fija una regla y decide un humano.</li>
  <li><b>Fallas inyectadas:</b> los escenarios C, D y E se provocan con <code>test_fault</code>, que sólo se acepta con <code>RECON_FAULT_INJECTION=true</code>. No se apagó el Ollama real.</li>
  <li><b>Decisión global:</b> la decisión del formulario aplica a todas las excepciones de la ejecución, aunque se registra caso por caso.</li>
  <li><b>Sin probar en el e2e:</b> el Schedule está desactivado y el timeout de 24 h del Wait no se ejercitó.</li>
  <li><b>Bug abierto en la API:</b> ${esc(bug.hallazgo)} (ejecución #${esc(bug.n8n_execution_id)}). Mientras tanto, el formulario sólo ofrece Aprobar y Rechazar.</li>
</ul>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', flowchart: { useMaxWidth: true } });</script>
</body></html>`;

const htmlPath = join(out, 'evidencia-n8n.html');
writeFileSync(htmlPath, html);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
try { await page.waitForSelector('.mermaid svg', { timeout: 15000 }); } catch { console.warn('mermaid no se renderizó; el PDF queda con el texto del diagrama'); }
await page.pdf({ path: join(out, 'evidencia-n8n.pdf'), format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' } });
await browser.close();
const size = statSync(join(out, 'evidencia-n8n.pdf')).size;
console.log(`deliverables/evidencia-n8n.pdf: ${(size / 1024 / 1024).toFixed(2)} MB`);
if (size > 10 * 1024 * 1024) { console.error('el PDF supera 10 MB'); process.exitCode = 1; }
