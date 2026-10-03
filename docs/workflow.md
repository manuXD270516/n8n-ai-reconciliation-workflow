# Workflow nodo por nodo

Hay dos workflows:

- **Conciliación de pagos asistida por IA con aprobación humana** (`reconIaAprob0001`): 46 nodos funcionales y 4 notas.
- **Conciliación: notificar errores** (`reconErrNotif001`): 3 nodos.

El JSON se genera con `node scripts/build-workflow.mjs` a partir de `src/nodes/*.js`, donde vive el código de cada nodo Code.

En las tablas, la columna «Reintentos» indica cuántos intentos se hacen en total. «Continúa ante error» significa que el nodo usa `onError: continueRegularOutput`.

Convenciones:

- La URL de la API sale de `$env.RECON_API_BASE_URL`.
- Cada llamada lleva `Authorization: Bearer <JWT>`, firmado en la misma ejecución.
- Los valores de configuración no secretos se leen con `$env` (`RECON_*`, `OLLAMA_*`, `MAIL_*`).

## 1. Entrada y validación

| Nodo | Tipo | Qué hace |
|---|---|---|
| Webhook: extracto bancario | Webhook v2 | Recibe `POST /webhook/conciliacion/extracto`. `responseMode: responseNode`. Si el JSON es ilegible, n8n responde 422 antes de ejecutar el workflow |
| Schedule (opcional) | Schedule Trigger | Cron `0 6 * * 1-5`. **Desactivado** por defecto |
| Extracto programado (demo sintética) | Code | Genera un extracto sintético mínimo con el mismo contrato que el webhook. En producción aquí iría la descarga desde SFTP o la API del banco |
| Validar y normalizar extracto | Code | Ver el detalle debajo de esta tabla |
| ¿Entrada válida? | If | Separa los caminos válido e inválido |
| Responder 400: entrada inválida | Respond to Webhook | `{status: rejected, errors[], warnings[]}`. No se llama a la API |
| Responder 202: aceptado | Respond to Webhook | `{status: accepted, execution_id, statement_id, transactions}`. El resto del flujo sigue de forma asíncrona |
| Preparar contexto y CSV | Code | Define el tenant aislado `n8n-x<execution_id>` y el `batch_id`. Arma los CSV canónicos de 13 columnas que exige la API y los claims de los JWT de servicio (TTL de 15 min) |
| Firmar JWT integración / analista | JWT (sign, RS256) | Firma con la credencial `Recon API - JWT dev (RS256)`, cifrada en n8n. El `kid` viene de `$env.RECON_JWT_KID` |
| Ingerir libro mayor (API) / Ingerir extracto bancario (API) | HTTP Request | `POST /v1/artifacts` con `idempotency_key` = tenant + fuente. 3 reintentos |
| Verificar recibos de ingesta | Code | Corta el flujo con un error explícito si una fuente no dejó ninguna fila aceptada |

«Validar y normalizar extracto» comprueba:

- **Content-Type:** debe ser `application/json`.
- **Cabecera:**
  - `statement_id` con formato válido;
  - un proveedor con vocabulario conocido (`prov-alfa` o `prov-beta`) y la moneda (`USD` o `BOB`);
  - fechas RFC 3339 con zona;
  - ventana `[inicio, fin)` válida y de 31 días como máximo, y un `cutoff` que no sea anterior al fin de la ventana.
- **Filas** (CSV o JSON):
  - columnas obligatorias;
  - formatos de los ids;
  - operación y estado según el vocabulario de cada fuente;
  - montos con punto decimal y como máximo 2 decimales;
  - moneda igual a la del extracto;
  - sin duplicados;
  - como máximo 500 filas.
- **Advertencias:** las filas fuera de la ventana no se rechazan, pero se avisan.
- **`test_fault`:** sólo se acepta con `RECON_FAULT_INJECTION=true`.

## 2. Conciliación determinística (API)

| Nodo | Tipo | Qué hace |
|---|---|---|
| Crear lote (API) | HTTP Request | `POST /v1/batches` (rol analista). **Sin reintento**, porque no es idempotente |
| Cerrar fuente: libro mayor / extracto | HTTP Request | `POST /v1/batches/{id}/sources/{source}/complete` (rol integración). 3 reintentos |
| Lanzar run de conciliación (API) | HTTP Request | `POST /v1/batches/{id}/runs`, que devuelve 202. Sin reintento |
| Esperar 1 s | Wait | Pausa del polling |
| Consultar estado del run | HTTP Request | `GET /v1/runs/{run_id}` |
| ¿Run completado? | If | `status == completed` |
| ¿Quedan intentos? | If | `$runIndex < RECON_RUN_POLL_MAX` (30 por defecto) y el run no está en `failed`. Si quedan intentos, vuelve a «Esperar 1 s» |
| Error: run sin completar | Stop and Error | Falla con un mensaje claro, lo que dispara el Error Trigger |
| Leer resultados del run | HTTP Request | `GET /v1/runs/{id}/results?limit=500` |
| Separar excepciones | Code | Cuenta los resultados por `match_status` y emite un ítem por partida no `EXACT`, con los montos y estados de entrada de esa referencia |
| ¿Hay excepciones? | If | Si no hay, salta directo a «Reporte final» |

## 3. Excepciones: investigación de la API + IA local

| Nodo | Tipo | Qué hace |
|---|---|---|
| Abrir caso (API) | HTTP Request | `POST /v1/runs/{run}/results/{ordinal}/cases`. Es idempotente |
| Solicitar investigación (API) | HTTP Request | `POST .../investigations`. Continúa ante error: si la IA de la API está apagada (kill switch, 503), el caso sigue sin borrador |
| Esperar investigaciones (polling acotado) | Code | Consulta `GET /v1/investigations/{id}` con `this.helpers.httpRequest` hasta llegar a un estado terminal (`DRAFTED`, `NOT_NEEDED`, `ABSTAINED`, `ESCALATED`, `FAILED`) o hasta `RECON_INVESTIGATION_TIMEOUT_S`. Conserva hechos, hipótesis, revisión y siguiente paso. El resultado es un borrador sin efecto operativo |
| Preparar prompt IA | Code | Ver el detalle debajo de esta tabla |
| Clasificar con Ollama (qwen2.5:7b) | HTTP Request | `POST /api/chat`, con lotes de 1, timeout de `OLLAMA_TIMEOUT_MS`, 2 reintentos y continúa ante error |
| Validar salida IA (o fallback) | Code | Ver el detalle debajo de esta tabla |
| Leer caso (API) | HTTP Request | Lee la versión vigente del caso para `expected_version` |
| Proponer recomendación (API) | HTTP Request | Ver el detalle debajo de esta tabla. Sin reintento |
| Consolidar para revisión humana | Code | Un solo ítem con los casos, las métricas, el HTML del correo y el texto del formulario |
| Enviar solicitud de aprobación | Email (SMTP Mailpit) | Tabla de excepciones con propuesta, causa, prioridad y resumen, más el botón con `$execution.resumeFormUrl` (enlace firmado) |

«Preparar prompt IA» arma la llamada de cada excepción:

- Al modelo sólo le pasa hechos determinísticos:
  - el resultado del run, con el significado de la discrepancia en lenguaje claro;
  - los montos y estados de las dos fuentes;
  - los hechos y las hipótesis de la investigación de la API.
- El `format` es un **JSON Schema** cuyos enums de `causa_probable` y `accion_sugerida` se restringen a lo permitido para esa discrepancia. Por ejemplo, `ACCEPT_PROBABLE_MATCH` sólo aparece si el resultado es `PROBABLE`.

«Validar salida IA (o fallback)» rechaza la respuesta del modelo si pasa algo de esto:

- no hay respuesta o hay error de red;
- el JSON es inválido;
- un valor está fuera de enum;
- el resumen tiene menos de 40 o más de 700 caracteres;
- el resumen no menciona el `payment_ref`;
- el resumen trae montos que no están en los datos (*grounding*);
- el resumen contradice la discrepancia (por ejemplo, dice «falta en el libro mayor» cuando falta en el banco).

Si la respuesta se rechaza, entra el **fallback determinístico**: causa `indeterminado`, una acción por regla y un resumen armado con plantilla. La prioridad siempre la fija una regla (alta si falta el registro interno o si el monto es de 1000 o más). La IA no fija la prioridad.

«Proponer recomendación (API)» llama a `POST /v1/cases/{id}/recommendations` con el analista de servicio, enviando:

- la acción;
- un `rationale` etiquetado como `[Borrador IA local …]` o `[Fallback determinístico: motivo]`;
- `expected_version`;
- el `investigation_id`, sólo si la revisión de la API fue `SUPPORTED`.

## 4. Aprobación humana, decisión auditada y cierre

| Nodo | Tipo | Qué hace |
|---|---|---|
| Esperar decisión humana (formulario) | Wait (resume: form) | Formulario con Decisión (Aprobar o Rechazar), Motivo y Correo del revisor. Muestra el resumen. Expira a las 24 h |
| Normalizar decisión humana | Code | Mapea la opción a `APPROVE` o `REJECT` y valida el correo y el motivo (10 caracteres o más). Arma los claims del supervisor con `sub = reviewer:<correo>`, porque la API exige que decida alguien distinto de quien propuso |
| ¿Decisión recibida? | If | Si el Wait expiró, va al reporte con el resultado `NO_DECISION_TIMEOUT` |
| Firmar JWT supervisor (revisor) | JWT | TTL de 10 min |
| Decisiones por caso | Code | Un ítem por caso, con `idempotency_key = n8n-<ejecución>-<caso>` |
| Leer versión vigente (API) | HTTP Request | `GET /v1/cases/{id}` |
| Registrar decisión (API) | HTTP Request | `POST /v1/cases/{id}/decisions`. 3 reintentos, seguros gracias a la clave de idempotencia. La API registra la decisión pero no mueve dinero |
| Leer auditoría del caso (API) | HTTP Request | `GET /v1/cases/{id}/audit`, que confirma el aprobador y `decision.record` |
| Reporte final | Code | Ver el detalle debajo de esta tabla |
| Enviar reporte final | Email | Al revisor y a operaciones |
| Resultado de la ejecución | Code | Deja el reporte como salida final, consultable por la API pública de n8n |

«Reporte final» calcula:

- **métricas:** transacciones recibidas y aceptadas, pagos evaluados, `EXACT`, excepciones, IA válida contra fallback, decisiones y aprobador;
- **tiempos:** total, ingesta, run, investigaciones, IA, espera humana y tiempo automatizado.

## Workflow de errores

| Nodo | Tipo | Qué hace |
|---|---|---|
| Error Trigger | Error Trigger | Se activa porque el workflow principal lo declara como `settings.errorWorkflow` |
| Sanitizar error | Code | Redacta JWT, `Authorization`/`Bearer` y bloques PEM, y recorta el mensaje |
| Notificar a operaciones | Email | Workflow, ejecución, nodo que falló, error y enlace a la ejecución |

## Configuración (`.env`)

| Variable | Uso |
|---|---|
| `N8N_ENCRYPTION_KEY`, `N8N_OWNER_*`, `N8N_API_KEY` | Secretos de desarrollo generados por `setup.ps1`. Nunca se commitean |
| `RECON_API_BASE_URL`, `RECON_JWT_KID`, `RECON_JWT_ISSUER`, `RECON_JWT_AUDIENCE`, `RECON_DEV_KEYS_DIR` | API de conciliación y JWT de desarrollo |
| `RECON_RUN_POLL_MAX`, `RECON_INVESTIGATION_TIMEOUT_S`, `OLLAMA_TIMEOUT_MS` | Límites del polling y del modelo |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Modelo local |
| `MAIL_FROM`, `MAIL_REVIEWER`, `MAIL_OPS` | Correos (Mailpit) |
| `RECON_FAULT_INJECTION` | `false` por defecto. El e2e lo activa sólo mientras corre |
