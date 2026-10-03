// Capturas reales con Playwright + Chromium para la documentación y el PDF:
//   docs/img/workflow-canvas.png       canvas del workflow en el editor de n8n
//   docs/img/ejecucion-exitosa.png     ejecución del camino feliz (nodos en verde)
//   docs/img/email-aprobacion.png      correo de aprobación en Mailpit
//   docs/img/email-reporte.png         correo del reporte final en Mailpit
//   docs/img/email-error.png           notificación del Error Trigger en Mailpit
// Requiere haber corrido scripts/e2e.mjs (lee los ids desde evidence/).
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const N8N = `http://localhost:${env.N8N_HOST_PORT || 15678}`;
const MAILPIT = `http://127.0.0.1:${env.MAILPIT_UI_PORT || 18825}`;
const IMG = join(root, 'docs', 'img');
mkdirSync(IMG, { recursive: true });
const evidence = (f) => JSON.parse(readFileSync(join(root, 'evidence', f), 'utf8'));
const happy = evidence('e2e-A_camino_feliz.json');
const failure = evidence('e2e-E_error_api_error_trigger.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1.5, locale: 'es-ES' });
const page = await context.newPage();

async function dismissPopups() {
  for (const sel of ['[data-test-id="close-button"]', 'button[aria-label="Close"]', '.el-dialog__headerbtn', '.el-message-box__headerbtn']) {
    const els = await page.$$(sel);
    for (const el of els) { try { if (await el.isVisible()) await el.click({ timeout: 1000 }); } catch { /* nada */ } }
  }
  await page.keyboard.press('Escape').catch(() => {});
}
async function fitCanvas() {
  await page.waitForSelector('.vue-flow__node', { timeout: 30000 });
  await sleep(1500);
  await dismissPopups();
  const fit = await page.$('[data-test-id="zoom-to-fit"]');
  if (fit) await fit.click(); else { await page.mouse.click(800, 500); await page.keyboard.press('1'); }
  await sleep(1500);
}

// 1. Login con la cuenta owner local de prueba (sólo existe en esta instancia; credenciales en .env)
await page.goto(`${N8N}/signin`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[type="email"], input[name="emailOrLdapLoginId"], input[name="email"]', env.N8N_OWNER_EMAIL);
await page.fill('input[type="password"]', env.N8N_OWNER_PASSWORD);
await page.keyboard.press('Enter');
await page.waitForURL((u) => !u.pathname.includes('signin'), { timeout: 30000 });

// 2. Canvas del workflow
await page.goto(`${N8N}/workflow/reconIaAprob0001`);
await fitCanvas();
await page.screenshot({ path: join(IMG, 'workflow-canvas.png') });
console.log('canvas listo');

// 3. Ejecución exitosa del camino feliz
await page.goto(`${N8N}/workflow/reconIaAprob0001/executions/${happy.execution_id}`);
await sleep(2500);
const frame = page.frames().find((f) => f.url().includes('/workflows/demo')) || null;
if (frame) {
  await frame.waitForSelector('.vue-flow__node', { timeout: 30000 });
  await sleep(1500);
} else {
  await fitCanvas();
}
await dismissPopups();
await page.screenshot({ path: join(IMG, 'ejecucion-exitosa.png') });
console.log(`ejecución #${happy.execution_id} capturada`);

// 4. Correos en Mailpit
const mailShot = async (id, file) => {
  await page.goto(`${MAILPIT}/view/${id}`);
  await page.waitForLoadState('networkidle');
  await sleep(1500);
  await page.screenshot({ path: join(IMG, file) });
};
await page.setViewportSize({ width: 1400, height: 1000 });
await mailShot(happy.mails[0].id, 'email-aprobacion.png');
await mailShot(happy.mails[1].id, 'email-reporte.png');
await mailShot(failure.mail.id, 'email-error.png');
console.log('correos capturados');
await browser.close();
