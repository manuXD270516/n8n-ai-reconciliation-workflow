// Nodo Code: "Verificar recibos de ingesta".
// La API devuelve un recibo por artefacto (aceptadas, duplicadas, conflictos, cuarentena).
// Si una fuente no dejó ninguna fila utilizable, se corta el flujo con un error explícito.

const ledger = $('Ingerir libro mayor (API)').first().json;
const statement = $('Ingerir extracto bancario (API)').first().json;
const summarize = (r) => ({
  artifact_id: r.artifact_id, replayed: r.replayed, row_count: r.row_count, accepted: r.accepted,
  duplicates: r.duplicates, conflicts: r.conflicts, rejected: r.rejected,
  rejections: (r.rejections || []).slice(0, 10),
});
const receipts = { ledger: summarize(ledger), statement: summarize(statement) };
for (const [name, r] of Object.entries(receipts)) {
  if ((r.accepted || 0) + (r.duplicates || 0) === 0) {
    throw new Error(`La API no aceptó ninguna fila de ${name}: ${JSON.stringify(r.rejections)}`);
  }
}
return [{ json: { receipts, ingested_at: new Date().toISOString() } }];
