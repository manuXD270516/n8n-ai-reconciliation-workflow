// Genera workflows/*.json a partir de src/nodes/*.js (el código de los nodos Code vive en
// archivos .js revisables). Sin credenciales embebidas: sólo referencias por id/nombre a
// credenciales que scripts/setup.ps1 crea en la instancia local.
//
//   node scripts/build-workflow.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (name) => readFileSync(join(root, 'src', 'nodes', `${name}.js`), 'utf8');
const uuid = (seed) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const MAIN_ID = 'reconIaAprob0001';
export const ERROR_ID = 'reconErrNotif001';
const JWT_CRED = { jwtAuth: { id: 'reconJwtDevKey01', name: 'Recon API - JWT dev (RS256)' } };
const SMTP_CRED = { smtp: { id: 'mailpitSmtpLocal1', name: 'Mailpit SMTP local' } };
const API = '{{ $env.RECON_API_BASE_URL }}';
const TOKEN = {
  integration: "{{ $('Firmar JWT integración').first().json.token }}",
  analyst: "{{ $('Firmar JWT analista').first().json.token }}",
  supervisor: "{{ $('Firmar JWT supervisor (revisor)').first().json.token }}",
};

const nodes = [];
const connections = {};
const node = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ parameters, id: uuid(`node:${name}`), name, type, typeVersion, position, ...extra });
  return name;
};
const connect = (from, to, output = 0) => {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
};
const chain = (...names) => names.slice(1).forEach((n, i) => connect(names[i], n));

const codeNode = (name, pos, file, extra = {}) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: code(file) }, extra);
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 1500 };
const http = (name, pos, { method = 'GET', path, role, body, retry = true, onError, timeout = 15000 }) => {
  const parameters = {
    method,
    url: `=${API}${path}`,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: `=Bearer ${TOKEN[role]}` }] },
    options: { timeout },
  };
  if (body) Object.assign(parameters, { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}` });
  const extra = retry ? { ...RETRY } : {};
  if (onError) extra.onError = onError;
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, parameters, extra);
};
const ifNode = (name, pos, left, operator, right) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uuid(`cond:${name}`), leftValue: left, rightValue: right ?? '', operator }],
    combinator: 'and',
  },
  looseTypeValidation: true,
  options: {},
});
const jwt = (name, pos, claimsExpr) => node(name, 'n8n-nodes-base.jwt', 1, pos, {
  operation: 'sign',
  useJson: true,
  claimsJson: `={{ JSON.stringify(${claimsExpr}) }}`,
  options: { kid: '={{ $env.RECON_JWT_KID }}' },
}, { credentials: JWT_CRED });
const email = (name, pos, to, subject, html) => node(name, 'n8n-nodes-base.emailSend', 2.1, pos, {
  fromEmail: '={{ $env.MAIL_FROM }}',
  toEmail: to,
  subject,
  emailFormat: 'html',
  html,
  options: { appendAttribution: false },
}, { credentials: SMTP_CRED, ...RETRY });
const sticky = (name, pos, width, height, content, color) => node(name, 'n8n-nodes-base.stickyNote', 1, pos, { content, height, width, color });

// ---------------------------------------------------------------------------------------
// 1. Entrada y validación
const Y1 = 0, Y2 = 520, Y3 = 1040, Y4 = 1560;
sticky('Nota 1', [-60, Y1 - 160], 2500, 470, '## 1. Entrada y validación\nWebhook POST `/webhook/conciliacion/extracto` (o Schedule opcional, desactivado). Valida y normaliza el extracto (CSV o JSON) y responde 400 con errores claros o 202 con el id de ejecución.', 7);
node('Webhook: extracto bancario', 'n8n-nodes-base.webhook', 2, [0, Y1], {
  httpMethod: 'POST', path: 'conciliacion/extracto', responseMode: 'responseNode', options: {},
}, { webhookId: uuid('webhook:extracto') });
node('Schedule (opcional)', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, Y1 + 200], {
  rule: { interval: [{ field: 'cronExpression', expression: '0 6 * * 1-5' }] },
}, { disabled: true });
codeNode('Extracto programado (demo sintética)', [220, Y1 + 200], 'extracto-programado');
codeNode('Validar y normalizar extracto', [440, Y1 + 80], 'validar-extracto');
ifNode('¿Entrada válida?', [660, Y1 + 80], '={{ $json.valid }}', { type: 'boolean', operation: 'true', singleValue: true }, '');
node('Responder 400: entrada inválida', 'n8n-nodes-base.respondToWebhook', 1.1, [900, Y1 + 200], {
  respondWith: 'json',
  responseBody: "={{ JSON.stringify({ status: 'rejected', message: 'El extracto no pasó la validación; no se llamó a la API.', error_count: $json.error_count, errors: $json.errors, warnings: $json.warnings }) }}",
  options: { responseCode: 400 },
});
node('Responder 202: aceptado', 'n8n-nodes-base.respondToWebhook', 1.1, [900, Y1 - 20], {
  respondWith: 'json',
  responseBody: "={{ JSON.stringify({ status: 'accepted', execution_id: $execution.id, statement_id: $json.header.statement_id, transactions: $json.counts.ledger + $json.counts.statement, warnings: $json.warnings, next: 'Conciliación en curso; el revisor recibirá un correo de aprobación y el reporte final llegará por correo.' }) }}",
  options: { responseCode: 202 },
});
codeNode('Preparar contexto y CSV', [1120, Y1 - 20], 'preparar-contexto');
jwt('Firmar JWT integración', [1340, Y1 - 20], "$('Preparar contexto y CSV').first().json.claims.integration");
jwt('Firmar JWT analista', [1560, Y1 - 20], "$('Preparar contexto y CSV').first().json.claims.analyst");
http('Ingerir libro mayor (API)', [1780, Y1 - 20], {
  method: 'POST', path: '/v1/artifacts', role: 'integration',
  body: "{ source: 'internal_ledger', provider_id: $('Preparar contexto y CSV').first().json.header.provider_id, idempotency_key: $('Preparar contexto y CSV').first().json.tenant + '-ledger', content: $('Preparar contexto y CSV').first().json.ledger_csv }",
});
http('Ingerir extracto bancario (API)', [2000, Y1 - 20], {
  method: 'POST', path: '/v1/artifacts', role: 'integration',
  body: "{ source: 'provider_report', provider_id: $('Preparar contexto y CSV').first().json.header.provider_id, idempotency_key: $('Preparar contexto y CSV').first().json.tenant + '-statement', content: $('Preparar contexto y CSV').first().json.statement_csv }",
});
codeNode('Verificar recibos de ingesta', [2220, Y1 - 20], 'verificar-ingesta');

chain('Webhook: extracto bancario', 'Validar y normalizar extracto', '¿Entrada válida?');
chain('Schedule (opcional)', 'Extracto programado (demo sintética)', 'Validar y normalizar extracto');
connect('¿Entrada válida?', 'Responder 202: aceptado', 0);
connect('¿Entrada válida?', 'Responder 400: entrada inválida', 1);
chain('Responder 202: aceptado', 'Preparar contexto y CSV', 'Firmar JWT integración', 'Firmar JWT analista',
  'Ingerir libro mayor (API)', 'Ingerir extracto bancario (API)', 'Verificar recibos de ingesta');

// 2. Conciliación determinística en la API
const CTX = "$('Preparar contexto y CSV').first().json";
sticky('Nota 2', [-60, Y2 - 160], 2700, 470, '## 2. Conciliación determinística (API fintech)\nCrea el lote, marca ambas fuentes completas, lanza el run (reglas `rules/v1`) y hace polling con límite (`RECON_RUN_POLL_MAX` x 1 s). Sólo reintenta llamadas idempotentes.', 4);
http('Crear lote (API)', [0, Y2], {
  method: 'POST', path: '/v1/batches', role: 'analyst', retry: false,
  body: `{ batch_id: ${CTX}.batch_id, provider_id: ${CTX}.header.provider_id, merchant_account: ${CTX}.header.merchant_account, currency: ${CTX}.header.currency, window_start: ${CTX}.header.window_start, window_end: ${CTX}.header.window_end, business_timezone: ${CTX}.header.business_timezone, cutoff_at: ${CTX}.header.cutoff_at }`,
});
http('Cerrar fuente: libro mayor', [220, Y2], { method: 'POST', path: `/v1/batches/{{ ${CTX}.batch_id }}/sources/internal_ledger/complete`, role: 'integration' });
http('Cerrar fuente: extracto', [440, Y2], { method: 'POST', path: `/v1/batches/{{ ${CTX}.batch_id }}/sources/provider_report/complete`, role: 'integration' });
http('Lanzar run de conciliación (API)', [660, Y2], { method: 'POST', path: `/v1/batches/{{ ${CTX}.batch_id }}/runs`, role: 'analyst', retry: false });
node('Esperar 1 s', 'n8n-nodes-base.wait', 1.1, [880, Y2], { amount: 1, unit: 'seconds' }, { webhookId: uuid('wait:run') });
http('Consultar estado del run', [1100, Y2], { path: "/v1/runs/{{ $('Lanzar run de conciliación (API)').first().json.run_id }}", role: 'analyst' });
ifNode('¿Run completado?', [1320, Y2], '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'completed');
ifNode('¿Quedan intentos?', [1540, Y2 + 180], "={{ $runIndex < Number($env.RECON_RUN_POLL_MAX || 30) && $json.status !== 'failed' }}", { type: 'boolean', operation: 'true', singleValue: true }, '');
node('Error: run sin completar', 'n8n-nodes-base.stopAndError', 1, [1760, Y2 + 300], {
  errorMessage: "=El run {{ $json.run_id }} no completó dentro del límite de polling (estado: {{ $json.status }}).",
});
http('Leer resultados del run', [1540, Y2 - 20], { path: '/v1/runs/{{ $json.run_id }}/results?limit=500', role: 'analyst' });
codeNode('Separar excepciones', [1760, Y2 - 20], 'separar-excepciones');
ifNode('¿Hay excepciones?', [1980, Y2 - 20], '={{ $json.exception !== null }}', { type: 'boolean', operation: 'true', singleValue: true }, '');

chain('Verificar recibos de ingesta', 'Crear lote (API)', 'Cerrar fuente: libro mayor', 'Cerrar fuente: extracto',
  'Lanzar run de conciliación (API)', 'Esperar 1 s', 'Consultar estado del run', '¿Run completado?');
connect('¿Run completado?', 'Leer resultados del run', 0);
connect('¿Run completado?', '¿Quedan intentos?', 1);
connect('¿Quedan intentos?', 'Esperar 1 s', 0);
connect('¿Quedan intentos?', 'Error: run sin completar', 1);
chain('Leer resultados del run', 'Separar excepciones', '¿Hay excepciones?');

// 3. Excepciones: investigación de la API + clasificación con IA local
const VAL = "$('Validar salida IA (o fallback)').item.json";
sticky('Nota 3', [-60, Y3 - 160], 2700, 470, '## 3. Excepciones: investigación (API) + IA local acotada\nPor cada partida no conciliada: abre el caso, pide la investigación de la API (borrador sin efecto operativo), clasifica con Ollama `qwen2.5:7b` (JSON Schema + validación + fallback determinístico) y registra una **propuesta** del analista de servicio. La IA nunca decide.', 6);
http('Abrir caso (API)', [0, Y3], { method: 'POST', path: '/v1/runs/{{ $json.exception.run_id }}/results/{{ $json.exception.ordinal }}/cases', role: 'analyst' });
http('Solicitar investigación (API)', [220, Y3], {
  method: 'POST', role: 'analyst', onError: 'continueRegularOutput',
  path: "/v1/runs/{{ $('Separar excepciones').item.json.exception.run_id }}/results/{{ $('Separar excepciones').item.json.exception.ordinal }}/investigations",
});
codeNode('Esperar investigaciones (polling acotado)', [440, Y3], 'esperar-investigaciones');
codeNode('Preparar prompt IA', [660, Y3], 'preparar-prompt-ia');
node('Clasificar con Ollama (qwen2.5:7b)', 'n8n-nodes-base.httpRequest', 4.2, [880, Y3], {
  method: 'POST',
  url: '={{ $json.ai_request.url }}',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.ai_request.body) }}',
  options: {
    timeout: '={{ Number($env.OLLAMA_TIMEOUT_MS || 90000) }}',
    batching: { batch: { batchSize: 1, batchInterval: 0 } },
  },
}, { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput' });
codeNode('Validar salida IA (o fallback)', [1100, Y3], 'validar-salida-ia');
http('Leer caso (API)', [1320, Y3], { path: '/v1/cases/{{ $json.case_id }}', role: 'analyst' });
http('Proponer recomendación (API)', [1540, Y3], {
  method: 'POST', path: `/v1/cases/{{ ${VAL}.case_id }}/recommendations`, role: 'analyst', retry: false,
  body: `{ action: ${VAL}.ai.accion_sugerida, rationale: ${VAL}.ai.rationale, expected_version: $json.version, investigation_id: (${VAL}.investigation.state === 'DRAFTED' && ${VAL}.investigation.review_result === 'SUPPORTED') ? ${VAL}.investigation.id : null }`,
});
codeNode('Consolidar para revisión humana', [1760, Y3], 'consolidar-revision');
email('Enviar solicitud de aprobación', [1980, Y3], '={{ $env.MAIL_REVIEWER }}',
  "=[Aprobación requerida] Conciliación {{ $json.statement_id }}: {{ $json.run.exceptions }} excepciones",
  "={{ $json.email_html.replace('__RESUME_URL__', $execution.resumeFormUrl) }}");

connect('¿Hay excepciones?', 'Abrir caso (API)', 0);
chain('Abrir caso (API)', 'Solicitar investigación (API)', 'Esperar investigaciones (polling acotado)', 'Preparar prompt IA',
  'Clasificar con Ollama (qwen2.5:7b)', 'Validar salida IA (o fallback)', 'Leer caso (API)', 'Proponer recomendación (API)',
  'Consolidar para revisión humana', 'Enviar solicitud de aprobación');

// 4. Aprobación humana, registro auditado y cierre
const DEC = "$('Decisiones por caso').item.json";
sticky('Nota 4', [-60, Y4 - 160], 2700, 470, '## 4. Aprobación humana, decisión auditada y cierre\nEl Wait se reanuda con un formulario firmado (enlace del correo, expira en 24 h). El revisor firma como supervisor; cada caso recibe su decisión en la API con `idempotency_key` estable. Reporte final por correo y como salida de la ejecución.', 5);
node('Esperar decisión humana (formulario)', 'n8n-nodes-base.wait', 1.1, [0, Y4], {
  resume: 'form',
  formTitle: 'Aprobación de conciliación (datos sintéticos)',
  formDescription: "={{ $('Consolidar para revisión humana').first().json.form_text }}",
  formFields: {
    values: [
      { fieldLabel: 'Decisión', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Aprobar las propuestas' }, { option: 'Rechazar las propuestas' }, { option: 'Pedir más información' }] }, requiredField: true },
      { fieldLabel: 'Motivo', fieldType: 'textarea', placeholder: 'Mínimo 10 caracteres. Queda en la auditoría de la API.', requiredField: true },
      { fieldLabel: 'Correo del revisor', fieldType: 'email', placeholder: 'revisor@example.test', requiredField: true },
    ],
  },
  responseMode: 'onReceived',
  limitWaitTime: true,
  limitType: 'afterTimeInterval',
  resumeAmount: 24,
  resumeUnit: 'hours',
  options: { respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Decisión recibida. n8n la registrará en la API caso por caso y enviará el reporte final por correo.' } } },
}, { webhookId: uuid('wait:human') });
codeNode('Normalizar decisión humana', [220, Y4], 'normalizar-decision');
ifNode('¿Decisión recibida?', [440, Y4], '={{ $json.decided }}', { type: 'boolean', operation: 'true', singleValue: true }, '');
jwt('Firmar JWT supervisor (revisor)', [660, Y4 - 20], "$('Normalizar decisión humana').first().json.claims_supervisor");
codeNode('Decisiones por caso', [880, Y4 - 20], 'decisiones-por-caso');
http('Leer versión vigente (API)', [1100, Y4 - 20], { path: '/v1/cases/{{ $json.case_id }}', role: 'supervisor' });
http('Registrar decisión (API)', [1320, Y4 - 20], {
  method: 'POST', path: `/v1/cases/{{ ${DEC}.case_id }}/decisions`, role: 'supervisor',
  body: `{ recommendation_id: ${DEC}.recommendation_id, decision: ${DEC}.decision, reason: ${DEC}.reason, expected_version: $json.version, idempotency_key: ${DEC}.idempotency_key }`,
});
http('Leer auditoría del caso (API)', [1540, Y4 - 20], { path: `/v1/cases/{{ ${DEC}.case_id }}/audit`, role: 'supervisor' });
codeNode('Reporte final', [1760, Y4 + 80], 'reporte-final');
email('Enviar reporte final', [1980, Y4 + 80], '={{ $env.MAIL_REVIEWER }}, {{ $env.MAIL_OPS }}', '={{ $json.email_subject }}', '={{ $json.email_html }}');
node('Resultado de la ejecución', 'n8n-nodes-base.code', 2, [2200, Y4 + 80], {
  jsCode: "// Salida final de la ejecución (consultable por la API pública de n8n).\nreturn [{ json: $('Reporte final').first().json.report }];",
});

chain('Enviar solicitud de aprobación', 'Esperar decisión humana (formulario)', 'Normalizar decisión humana', '¿Decisión recibida?');
connect('¿Decisión recibida?', 'Firmar JWT supervisor (revisor)', 0);
connect('¿Decisión recibida?', 'Reporte final', 1);
chain('Firmar JWT supervisor (revisor)', 'Decisiones por caso', 'Leer versión vigente (API)', 'Registrar decisión (API)',
  'Leer auditoría del caso (API)', 'Reporte final', 'Enviar reporte final', 'Resultado de la ejecución');
connect('¿Hay excepciones?', 'Reporte final', 1);

const main = {
  id: MAIN_ID,
  name: 'Conciliación de pagos asistida por IA con aprobación humana',
  active: false,
  nodes: [...nodes],
  connections: structuredClone(connections),
  pinData: {},
  settings: {
    executionOrder: 'v1',
    errorWorkflow: ERROR_ID,
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: true,
    timezone: 'America/La_Paz',
    callerPolicy: 'workflowsFromSameOwner',
  },
  meta: { templateCredsSetupCompleted: true },
};

// ---------------------------------------------------------------------------------------
// Workflow de errores (Error Trigger)
nodes.length = 0;
for (const k of Object.keys(connections)) delete connections[k];
node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {});
codeNode('Sanitizar error', [240, 0], 'sanitizar-error');
email('Notificar a operaciones', [480, 0], '={{ $env.MAIL_OPS }}', '=[ERROR] {{ $json.workflow }}: ejecución #{{ $json.execution_id }} falló en {{ $json.failed_node }}', '={{ $json.email_html }}');
chain('Error Trigger', 'Sanitizar error', 'Notificar a operaciones');
const errorWf = {
  id: ERROR_ID,
  name: 'Conciliación: notificar errores',
  active: false,
  nodes: [...nodes],
  connections: structuredClone(connections),
  pinData: {},
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', timezone: 'America/La_Paz' },
  meta: { templateCredsSetupCompleted: true },
};

mkdirSync(join(root, 'workflows'), { recursive: true });
writeFileSync(join(root, 'workflows', 'conciliacion-ia-aprobacion-humana.json'), `${JSON.stringify(main, null, 2)}\n`);
writeFileSync(join(root, 'workflows', 'notificar-errores.json'), `${JSON.stringify(errorWf, null, 2)}\n`);
console.log(`workflows generados: ${main.nodes.length} nodos (principal), ${errorWf.nodes.length} nodos (errores)`);
