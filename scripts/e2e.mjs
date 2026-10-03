// Validación end-to-end REAL del workflow (n8n + API de conciliación + Ollama + Mailpit).
//
//   node scripts/e2e.mjs            (o scripts/e2e.ps1, que antes corre setup.ps1)
//
// Escenarios:
//   A. Camino feliz: webhook -> conciliación -> IA -> correo -> formulario (Playwright) -> APPROVE
//   B. Entradas inválidas: 400 con errores claros (y 422 de n8n para JSON ilegible)
//   C. Ollama caído (falla inyectada: puerto cerrado) -> fallback determinístico -> REJECT
//   D. Respuesta inválida del modelo (texto libre real) -> validador -> fallback -> APPROVE
//   E. Error de la API (falla inyectada: batch_id inválido) -> Error Trigger -> correo sanitizado
//   F. Con la inyección deshabilitada, test_fault se rechaza con 400
//   G. Pedir más información: formulario -> NEEDS_INFORMATION registrado en la API
// Verifica en la API (token de auditor firmado aquí con la clave dev) y en Mailpit, y guarda
// la evidencia sanitizada en evidence/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const N8N = `http://localhost:${env.N8N_HOST_PORT || 15678}`;
const MAILPIT = `http://127.0.0.1:${env.MAILPIT_UI_PORT || 18825}`;
const API = 'http://127.0.0.1:18180';
const OLLAMA = 'http://127.0.0.1:11434';
const MAIN_ID = 'reconIaAprob0001';
const ERROR_ID = 'reconErrNotif001';
const EVIDENCE = join(root, 'evidence');
const IMG = join(root, 'docs', 'img');
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(IMG, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT redactado]'));
const save = (name, data) => writeFileSync(join(EVIDENCE, name), `${JSON.stringify(redact(data), null, 2)}\n`);
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const checks = [];
function check(scenario, name, ok, detail) {
  checks.push({ scenario, name, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'OK  ' : 'FAIL'} ${scenario} · ${name}${detail !== undefined ? ` · ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

async function http(method, url, { headers = {}, body, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* texto plano */ }
  return { status: res.status, json, text };
}
const n8nApi = (path) => http('GET', `${N8N}/api/v1${path}`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY } });

// --- JWT de verificación (auditor/supervisor) firmado con la clave dev del proyecto de conciliación
const keysDir = isAbsolute(env.RECON_DEV_KEYS_DIR) ? env.RECON_DEV_KEYS_DIR : join(root, env.RECON_DEV_KEYS_DIR);
const privatePem = readFileSync(join(keysDir, 'private.pem'), 'utf8');
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function devToken(sub, role, tenant) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: env.RECON_JWT_KID });
  const body = b64u({ iss: env.RECON_JWT_ISSUER, aud: env.RECON_JWT_AUDIENCE, sub, tenant_id: tenant, roles: [role], iat: now, nbf: now, exp: now + 300 });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privatePem).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const recon = (path, tenant, role = 'auditor', sub = 'e2e-auditor', method = 'GET', body) => http(method, `${API}${path}`, {
  headers: { authorization: `Bearer ${devToken(sub, role, tenant)}` }, body,
});

// --- n8n y Mailpit
async function waitExecution(id, statuses, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await n8nApi(`/executions/${id}?includeData=true`);
    if (r.status === 200 && statuses.includes(r.json.status)) return r.json;
    if (Date.now() > deadline) throw new Error(`ejecución ${id} no llegó a ${statuses} (última: ${r.json?.status})`);
    await sleep(1500);
  }
}
function nodeSummary(exec) {
  const runData = exec.data?.resultData?.runData || {};
  return Object.entries(runData).map(([name, runs]) => ({
    node: name,
    runs: runs.length,
    status: runs.at(-1).executionStatus,
    items: runs.at(-1).data?.main?.[0]?.length ?? 0,
    started_at: new Date(runs[0].startTime).toISOString(),
    execution_ms: runs.reduce((a, r) => a + (r.executionTime || 0), 0),
    error: runs.at(-1).error?.message ?? null,
  }));
}
const nodeOutput = (exec, name) => exec.data?.resultData?.runData?.[name]?.at(-1)?.data?.main?.[0]?.map((i) => i.json) ?? [];
async function waitMail(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await http('GET', `${MAILPIT}/api/v1/messages?limit=200`);
    const found = (list.json?.messages || []).find(predicate);
    if (found) return (await http('GET', `${MAILPIT}/api/v1/message/${found.ID}`)).json;
    if (Date.now() > deadline) throw new Error('correo no encontrado en Mailpit');
    await sleep(1000);
  }
}
const mailInfo = (m) => ({ id: m.ID, subject: m.Subject, from: m.From?.Address, to: (m.To || []).map((t) => t.Address), date: m.Date, size: m.Size });

function compose(args, extraEnv = {}) {
  execFileSync('docker', ['compose', ...args], { cwd: root, env: { ...process.env, ...extraEnv }, stdio: 'pipe' });
}
async function waitN8n() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${N8N}/healthz/readiness`)).ok) { await sleep(3000); return; } } catch { /* arrancando */ }
    await sleep(2000);
  }
  throw new Error('n8n no quedó listo');
}

const fixture = JSON.parse(readFileSync(join(root, 'fixtures', 'statement-ok.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const results = { started_at: new Date().toISOString(), scenarios: {} };

async function approveViaForm(page, url, choice, motive, reviewer, screenshot) {
  await page.goto(url);
  await page.waitForSelector('#field-0');
  await page.selectOption('#field-0', { label: choice });
  await page.fill('#field-1', motive);
  await page.fill('#field-2', reviewer);
  if (screenshot) await page.screenshot({ path: join(IMG, screenshot), fullPage: true });
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type=submit]')]);
  await sleep(1500);
  return (await page.textContent('body')).replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function runWithApproval(key, { statementId, fault, choice, expectDecision, expectAi, screenshot }) {
  const payload = { ...fixture, statement_id: statementId, ...(fault ? { test_fault: fault } : {}) };
  const t0 = Date.now();
  const resp = await http('POST', `${N8N}/webhook/conciliacion/extracto`, { body: payload });
  check(key, 'webhook responde 202 con execution_id', resp.status === 202 && resp.json?.execution_id, { status: resp.status, execution_id: resp.json?.execution_id });
  const execId = resp.json.execution_id;
  const waiting = await waitExecution(execId, ['waiting', 'error', 'success']);
  check(key, 'la ejecución queda esperando la decisión humana (Wait)', waiting.status === 'waiting', waiting.status);
  const automatedUntilWait = Date.now() - t0;
  const approvalMail = await waitMail((m) => m.Subject.includes(statementId) && m.Subject.startsWith('[Aprobación'));
  const link = (approvalMail.HTML.match(/href="([^"]*form-waiting[^"]*)"/) || [])[1];
  check(key, 'correo de aprobación en Mailpit con enlace firmado', Boolean(link) && link.includes('signature='), mailInfo(approvalMail));
  const validated = nodeOutput(waiting, 'Validar salida IA (o fallback)');
  const sources = validated.map((v) => v.ai.source);
  const aiLabel = expectAi === 'ollama' ? 'al menos una clasificación de Ollama validada (el resto, fallback con motivo)' : 'todas las excepciones usan el fallback determinístico';
  check(key, aiLabel, expectAi === 'ollama' ? sources.includes('ollama') : sources.every((s) => s === 'fallback'),
    validated.map((v) => ({ ref: v.exception.payment_ref, source: v.ai.source, reasons: v.ai.reasons, causa: v.ai.causa_probable, accion: v.ai.accion_sugerida })));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const tForm = Date.now();
  const formText = await approveViaForm(page, link, choice, `E2E ${key}: revisado contra el extracto sintético.`, 'revisora.demo@example.test', screenshot);
  await browser.close();
  const done = await waitExecution(execId, ['success', 'error']);
  check(key, 'la ejecución termina en success', done.status === 'success', done.status);
  const report = nodeOutput(done, 'Resultado de la ejecución')[0];
  const reportMail = await waitMail((m) => m.Subject.includes(statementId) && m.Subject.startsWith('[Reporte'));
  check(key, 'correo de reporte final en Mailpit (revisor + operaciones)', (reportMail.To || []).length === 2, mailInfo(reportMail));

  // Verificación independiente en la API (token de auditor del tenant de la ejecución)
  const apiCases = [];
  for (const d of report.decisions) {
    const audit = await recon(`/v1/cases/${d.case_id}/audit`, report.tenant, 'auditor');
    const rec = audit.json?.decisions?.find((x) => x.id === d.decision_id);
    apiCases.push({
      case_id: d.case_id, payment_ref: d.payment_ref, http: audit.status, case_status: audit.json?.case?.status,
      decision: rec?.decision, approver: rec?.approver, reason: rec?.reason, audit_actions: (audit.json?.audit || []).map((a) => a.action),
    });
  }
  const expectedStatus = { APPROVE: 'APPROVED', REJECT: 'REJECTED', NEEDS_INFORMATION: 'NEEDS_INFORMATION' }[expectDecision];
  check(key, `API: ${report.decisions.length} decisiones ${expectDecision} registradas y auditadas`,
    apiCases.length === 4 && apiCases.every((c) => c.decision === expectDecision && c.approver === 'reviewer:revisora.demo@example.test' && c.audit_actions.includes('decision.record')),
    apiCases.map((c) => ({ ref: c.payment_ref, status: c.case_status, decision: c.decision })));
  check(key, `API: estado de los casos = ${expectedStatus}`, apiCases.every((c) => c.case_status === expectedStatus), apiCases.map((c) => c.case_status));
  const run = await recon(`/v1/runs/${report.run.run_id}`, report.tenant, 'auditor');
  check(key, 'API: run completado con 6 EXACT y 4 UNMATCHED (etiquetas del fixture)', run.json?.counts?.EXACT === 6 && run.json?.counts?.UNMATCHED === 4, run.json?.counts);

  let idempotency = null;
  if (key === 'A_camino_feliz') {
    // Repetir la misma decisión (mismo cuerpo y misma idempotency_key) devuelve la original
    // (replayed: true); con otro cuerpo la API responde 409.
    const d = report.decisions[0];
    const again = await recon(`/v1/cases/${d.case_id}/decisions`, report.tenant, 'supervisor', 'reviewer:revisora.demo@example.test', 'POST', {
      recommendation_id: report.cases.find((c) => c.case_id === d.case_id).recommendation_id,
      decision: d.decision, reason: apiCases[0].reason, expected_version: 2,
      idempotency_key: `n8n-${execId}-${d.case_id}`,
    });
    idempotency = { status: again.status, decision_id: again.json?.decision_id, replayed: again.json?.replayed };
    check(key, 'API: reintento con la misma idempotency_key no duplica (replayed)', again.json?.replayed === true && again.json?.decision_id === d.decision_id, idempotency);
  }
  const scenario = {
    execution_id: execId,
    statement_id: statementId,
    tenant: report.tenant,
    test_fault: fault ?? null,
    webhook_response: resp.json,
    seconds_until_waiting: +(automatedUntilWait / 1000).toFixed(1),
    form_choice: choice,
    form_response_excerpt: formText,
    report,
    api_verification: apiCases,
    idempotency_replay: idempotency,
    mails: [mailInfo(approvalMail), mailInfo(reportMail)],
    seconds_form_to_success: +((Date.now() - tForm) / 1000).toFixed(1),
    nodes: nodeSummary(done),
  };
  save(`e2e-${key}.json`, scenario);
  results.scenarios[key] = { execution_id: execId, status: done.status, outcome: report.outcome, metrics: report.metrics, timings_ms: report.timings_ms };
  return scenario;
}

async function invalidInputs() {
  const key = 'B_entradas_invalidas';
  const cases = [
    { name: 'campos y filas inválidas', body: { ...fixture, statement_id: 'x', currency: 'EUR', statement_csv: undefined, statement: [{ source_record_id: 'a1', payment_ref: 'p1', operation: 'CAPTURE', amount: '12,5', currency: 'USD', status: 'PAID', occurred_at: '2026-09-01 10:00', received_at: '2026-09-01T10:00:00Z' }] } },
    { name: 'CSV con encabezado incompleto', body: { ...fixture, statement_id: `stmt-bad-csv-${stamp}`, statement_csv: 'payment_ref,amount\npay-1,10.00\n' } },
    { name: 'ventana invertida y cutoff anterior', body: { ...fixture, statement_id: `stmt-bad-win-${stamp}`, window_start: '2026-09-03T04:00:00Z', window_end: '2026-09-01T04:00:00Z', cutoff_at: '2026-08-01T00:00:00Z' } },
    { name: 'cuerpo no JSON (text/csv)', raw: 'source_record_id,payment_ref\nx,y\n', contentType: 'text/csv' },
    { name: 'JSON ilegible', raw: '{"statement_id": "x", roto', contentType: 'application/json' },
  ];
  const out = [];
  for (const c of cases) {
    const r = c.raw
      ? await http('POST', `${N8N}/webhook/conciliacion/extracto`, { body: c.raw, raw: true, headers: { 'content-type': c.contentType } })
      : await http('POST', `${N8N}/webhook/conciliacion/extracto`, { body: c.body });
    out.push({ case: c.name, status: r.status, response: r.json ?? r.text });
    const ok = c.name === 'JSON ilegible' ? r.status === 422 : r.status === 400 && r.json?.status === 'rejected' && r.json.errors.length > 0;
    check(key, `${c.name} -> ${c.name === 'JSON ilegible' ? '422 (parser de n8n)' : '400 con errores'}`, ok, { status: r.status, errors: r.json?.errors?.slice(0, 4) ?? r.json?.message });
  }
  // Ninguna ejecución inválida llegó a llamar a la API.
  await sleep(2000);
  const list = await n8nApi(`/executions?workflowId=${MAIN_ID}&limit=10&includeData=true`);
  const recent = (list.json?.data || []).filter((e) => Date.parse(e.startedAt) > Date.parse(results.started_at));
  const rejected = recent.filter((e) => e.data?.resultData?.runData?.['Responder 400: entrada inválida']);
  check(key, 'las ejecuciones rechazadas no ejecutan nodos de la API', rejected.length >= 4 && rejected.every((e) => !e.data.resultData.runData['Ingerir libro mayor (API)']),
    rejected.map((e) => ({ execution_id: e.id, status: e.status })));
  save(`e2e-${key}.json`, { cases: out, executions: rejected.map((e) => ({ execution_id: e.id, status: e.status, nodes: nodeSummary(e).map((n) => n.node) })) });
  results.scenarios[key] = { cases: out.map((o) => ({ case: o.case, status: o.status })), executions: rejected.map((e) => e.id) };
}

async function apiErrorPath() {
  const key = 'E_error_api_error_trigger';
  const statementId = `stmt-e2e-err-${stamp}`;
  const r = await http('POST', `${N8N}/webhook/conciliacion/extracto`, { body: { ...fixture, statement_id: statementId, test_fault: 'api_error' } });
  check(key, 'webhook acepta (202) antes del fallo', r.status === 202, r.json);
  const exec = await waitExecution(r.json.execution_id, ['error', 'success']);
  const failed = nodeSummary(exec).find((n) => n.status === 'error');
  check(key, 'la ejecución falla en "Crear lote (API)" por 422 de la API', exec.status === 'error' && failed?.node === 'Crear lote (API)', { status: exec.status, node: failed?.node, error: failed?.error });
  const mail = await waitMail((m) => m.Subject.startsWith('[ERROR]') && m.Subject.includes(`#${r.json.execution_id} `));
  check(key, 'Error Trigger envía correo a operaciones', (mail.To || []).some((t) => t.Address === env.MAIL_OPS), mailInfo(mail));
  const leaked = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(mail.HTML + mail.Text) || /BEGIN [A-Z ]*PRIVATE KEY/.test(mail.HTML);
  check(key, 'el correo de error no contiene JWT ni claves', !leaked);
  const errExecs = await n8nApi(`/executions?workflowId=${ERROR_ID}&limit=5`);
  const errExec = (errExecs.json?.data || [])[0];
  check(key, 'workflow de errores ejecutado con éxito', errExec?.status === 'success', { execution_id: errExec?.id, status: errExec?.status });
  save(`e2e-${key}.json`, { execution_id: r.json.execution_id, status: exec.status, failed_node: failed, error_workflow_execution: errExec?.id, mail: mailInfo(mail), mail_text: mail.Text, nodes: nodeSummary(exec) });
  results.scenarios[key] = { execution_id: r.json.execution_id, status: exec.status, failed_node: failed?.node, error_workflow_execution: errExec?.id };
}

async function faultDisabled() {
  const key = 'F_inyeccion_deshabilitada';
  const r = await http('POST', `${N8N}/webhook/conciliacion/extracto`, { body: { ...fixture, statement_id: `stmt-e2e-nofault-${stamp}`, test_fault: 'ollama_unreachable' } });
  check(key, 'con RECON_FAULT_INJECTION=false, test_fault se rechaza con 400', r.status === 400 && r.json?.errors?.some((e) => e.field === 'test_fault'), r.json?.errors);
  results.scenarios[key] = { status: r.status, errors: r.json?.errors };
}

// ------------------------------------------------------------------------------------------
async function main() {
  const pre = {
    api_ready: (await http('GET', `${API}/health/ready`)).json?.status,
    ollama_models: (await http('GET', `${OLLAMA}/api/tags`)).json?.models?.map((m) => m.name),
    n8n_version: execFileSync('docker', ['compose', 'exec', '-T', 'n8n', 'n8n', '--version'], { cwd: root }).toString().trim(),
    model: env.OLLAMA_MODEL,
  };
  check('preflight', 'API de conciliación lista', pre.api_ready === 'ready', pre.api_ready);
  check('preflight', `Ollama tiene ${env.OLLAMA_MODEL}`, pre.ollama_models?.includes(env.OLLAMA_MODEL), pre.ollama_models);
  results.preflight = pre;

  log('habilitando inyección de fallas en n8n (sólo para el e2e)');
  compose(['up', '-d', '--wait', 'n8n'], { RECON_FAULT_INJECTION: 'true' });
  await waitN8n();
  await http('DELETE', `${MAILPIT}/api/v1/messages`);

  try {
    await runWithApproval('A_camino_feliz', { statementId: `stmt-e2e-ok-${stamp}`, choice: 'Aprobar las propuestas', expectDecision: 'APPROVE', expectAi: 'ollama', screenshot: 'formulario-aprobacion.png' });
    await invalidInputs();
    await runWithApproval('C_ollama_caido', { statementId: `stmt-e2e-down-${stamp}`, fault: 'ollama_unreachable', choice: 'Rechazar las propuestas', expectDecision: 'REJECT', expectAi: 'fallback' });
    await runWithApproval('D_respuesta_invalida_modelo', { statementId: `stmt-e2e-inv-${stamp}`, fault: 'ollama_invalid_json', choice: 'Aprobar las propuestas', expectDecision: 'APPROVE', expectAi: 'fallback' });
    await runWithApproval('G_pedir_informacion', { statementId: `stmt-e2e-info-${stamp}`, choice: 'Pedir más información', expectDecision: 'NEEDS_INFORMATION', expectAi: 'ollama' });
    await apiErrorPath();
  } finally {
    log('deshabilitando inyección de fallas');
    compose(['up', '-d', '--wait', 'n8n'], { RECON_FAULT_INJECTION: 'false' });
    await waitN8n();
  }
  await faultDisabled();

  // Exportado sin secretos
  const exported = ['conciliacion-ia-aprobacion-humana.json', 'notificar-errores.json'].map((f) => readFileSync(join(root, 'workflows', f), 'utf8')).join('\n');
  const leaks = [/eyJ[A-Za-z0-9_-]{10,}\./, /BEGIN [A-Z ]*PRIVATE KEY/, /"password"\s*:\s*"[^"]+"/i, /N8N_ENCRYPTION_KEY=/].filter((re) => re.test(exported)).map(String);
  check('seguridad', 'workflows exportados sin JWT, claves ni contraseñas', leaks.length === 0, leaks);

  results.finished_at = new Date().toISOString();
  results.checks = checks;
  results.passed = checks.filter((c) => c.ok).length;
  results.failed = checks.filter((c) => !c.ok).length;
  save('e2e-summary.json', results);
  log(`resultado: ${results.passed} OK, ${results.failed} FAIL -> evidence/e2e-summary.json`);
  process.exitCode = results.failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  results.fatal = String(e.stack || e);
  results.checks = checks;
  save('e2e-summary.json', results);
  process.exitCode = 1;
});
