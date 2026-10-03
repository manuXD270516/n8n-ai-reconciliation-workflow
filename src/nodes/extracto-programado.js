// Nodo Code: "Extracto programado (demo sintética)".
// Camino opcional del Schedule Trigger (desactivado por defecto). En producción aquí iría la
// descarga del extracto (SFTP/API bancaria); en esta demo se genera un extracto sintético
// mínimo de prov-alfa para el día anterior, con el mismo contrato que el webhook.

const day = new Date(Date.now() - 86400000);
const ymd = day.toISOString().slice(0, 10);
const start = `${ymd}T04:00:00Z`;
const end = new Date(Date.parse(start) + 86400000).toISOString().replace('.000', '');
const cutoff = new Date(Date.parse(end) + 6 * 3600000).toISOString().replace('.000', '');
const at = (h) => new Date(Date.parse(start) + h * 3600000).toISOString().replace('.000', '');
const ref = (n) => `pay-sch-${ymd.replace(/-/g, '')}-${n}`;
return [{
  json: {
    origin: 'schedule',
    body: {
      statement_id: `stmt-sch-${ymd}`,
      provider_id: 'prov-alfa',
      merchant_account: 'merchant-01',
      currency: 'USD',
      window_start: start,
      window_end: end,
      business_timezone: 'America/La_Paz',
      cutoff_at: cutoff,
      statement: [
        { source_record_id: `alf-sch-${ymd}-1`, payment_ref: ref(1), operation: 'CAPTURE', amount: '120.00', currency: 'USD', status: 'SETTLED', occurred_at: at(2), received_at: at(3) },
        { source_record_id: `alf-sch-${ymd}-2`, payment_ref: ref(2), operation: 'CAPTURE', amount: '89.50', currency: 'USD', status: 'SETTLED', occurred_at: at(5), received_at: at(6) },
      ],
      ledger: [
        { source_record_id: `led-sch-${ymd}-1`, payment_ref: ref(1), operation: 'CAPTURE', amount: '120.00', currency: 'USD', status: 'POSTED', occurred_at: at(2), received_at: at(2) },
        { source_record_id: `led-sch-${ymd}-2`, payment_ref: ref(2), operation: 'CAPTURE', amount: '95.50', currency: 'USD', status: 'POSTED', occurred_at: at(5), received_at: at(5) },
      ],
    },
  },
}];
