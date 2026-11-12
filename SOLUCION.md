# SOLUCION — Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase

El maestro de contratos de Periferia está congelado desde el 2026-05-30 y solo reciben los contratos que exigen póliza, así que **gerencia no sabe qué contratos están vigentes, cuáles vencen ni qué pólizas están sin constituir**; le duele a la analista administrativa (dueña del maestro), a gerencia (sin visibilidad) y a la compañía (riesgo contractual por pólizas sin renovar y un proceso que murió con una persona).

## 2. Arquitectura

```
┌────────────┐  HTTP   ┌──────────────────────────────────────────────┐
│ web/ chat  │ ──────▶ │ src/server.ts  (API: /api/chat, /sessions…)  │
│ tool calls │ ◀────── │   └─ src/agent/ciclo.ts  (ciclo del agente)  │
│ confirmar  │         │        ├─ src/llm/adapter.ts ─▶ anthropic.ts │──▶ API del modelo
└────────────┘         │        └─ src/tools/registry.ts              │
                       │             └─ src/tools/contratos.ts (zod)  │
                       │                  └─ src/core/*  (negocio)    │
                       └───────────────┬───────────────┬──────────────┘
                                       │               │
                              fixtures/ (solo lectura)  out/ (escritura)
                              buzon, maestro, comerciales  sharepoint/, log, alertas…
```

| Capa | Dónde vive | Qué es |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | System prompt: reglas de oro (solo afirmar lo que dijo una herramienta), flujo y confirmación humana. |
| **Conocimiento** | `src/knowledge/registro-contratos.md` | Reglas del proceso (clasificación, umbral 0.8, pólizas, alertas). Se anexa al prompt al arrancar. |
| **Ejecución** | `src/tools/contratos.ts` + `src/core/` | Herramientas tipadas con zod y la lógica determinista. Importables sin servidor (`demo.ts`, `modulo/`). |

Un cambio de reglas de negocio toca `src/core/` y el `.md` de conocimiento, no el servidor. `fixtures/` nunca se escribe; el maestro se copia a `out/sharepoint/` la primera vez (RN6).

## 3. Ciclo del agente

Implementado a mano en `src/agent/ciclo.ts` (~170 líneas), sin framework:

1. Se agrega el mensaje del usuario y se llama al modelo con `system + historial + herramientas`.
2. Si el modelo pide herramientas, el backend **valida los argumentos con zod**, las ejecuta, registra la llamada y devuelve los resultados en un único mensaje; repite.
3. Termina cuando el modelo responde sin herramientas.

- **Tope de iteraciones (CA1):** `MAX_ITERACIONES` (25 por defecto). Al llegar, se hace una última llamada con `tool_choice: none` y una instrucción para que responda qué logró y qué falta. Además hay tope de tokens por sesión (`MAX_TOKENS_SESION`), tope de longitud de mensaje (4000) y una sola solicitud en vuelo por sesión.
- **Confirmación humana (CA3), en dos capas:** (a) el prompt obliga a terminar el turno con una pregunta explícita; (b) **el backend lo hace cumplir**: `contratos_registrar` con `confirmado: true` solo se acepta si en un turno *anterior* ese mensaje quedó pendiente de revisión (por `validar` o por un rechazo de `registrar`). Si el modelo intenta saltarse la pregunta, la llamada se bloquea y queda en el log. La respuesta de la API incluye `needsConfirmation` y el front resalta ese estado (borde ámbar y aviso).
- **CA2:** el modelo no tiene otra fuente de valores que las herramientas; `registrar` además **recalcula** extracción y validación por dentro, de modo que un valor "alucinado" no puede colarse al maestro: o sale de la herramienta, o llega como corrección explícita del usuario con `confirmado: true`.
- **CA4/RN7:** cada llamada queda en el historial visible del chat (nombre, argumentos y resultado en tarjetas desplegables) y en `out/log.jsonl` (`{ ts, herramienta, mensaje_id, ok, resumen }`).
- **CA5:** los errores de herramienta vuelven al modelo como `{ ok: false, error }`; los del proveedor (timeout, 429, 401, conexión) se traducen a mensajes claros en el chat y la sesión sigue viva.

## 4. Elección del modelo

- **Proveedor / modelo:** Anthropic, `claude-haiku-5-5` (configurable con `ANTHROPIC_MODEL`), vía el SDK oficial, con `effort: low`. También hay un adaptador para Groq (capa gratuita, `LLM_PROVIDER=groq`), útil para probar sin costo pero lento por su tope de 8.000 tokens por minuto.
- **Por qué:** el agente es un bucle de uso de herramientas con 5 funciones y poco razonamiento propio (la extracción es determinista), así que no hace falta el modelo más caro ni el que más razona. Haiku 5.5 es el más rápido y barato de la familia actual; si en pruebas orquesta peor de lo necesario, `claude-sonnet-5-5` es el siguiente paso. No se envían parámetros de muestreo (temperatura) porque estos modelos no los admiten.
- **Caché de prompt:** activada (`cache_control` automático), porque cada vuelta del ciclo reenvía el mismo prefijo (sistema + herramientas + historial).
- **Costo estimado por caso — es una estimación, no una medición** (en esta entrega no se midió el consumo real con Anthropic): precio de lista de Haiku 5.5 de US$0,10 / US$0,50 por millón de tokens de entrada / salida (prompts hasta 100 K tokens; consulta la página de precios de Anthropic para el valor vigente). Un lote de 6 mensajes necesita del orden de 12–16 llamadas con un prefijo de ~5–8 k tokens (prompt + conocimiento ≈ 2 k; esquemas de herramientas ≈ 1,5 k; historial creciente) y ~8 k tokens de salida: **≈ US$0,01–0,03 por lote, es decir del orden de US$0,002–0,005 por caso**. Con Sonnet 5.5 (US$2 / US$10) sería unas 20 veces más. Para medir el costo real basta sumar `usage` por sesión (el backend ya acumula `tokens` por sesión y los devuelve en `/api/chat`).

## 5. Estrategia de extracción

**Determinista primero** (`src/core/extraccion.ts`); el modelo no extrae valores, solo orquesta y explica.

| Dato | Cómo se encuentra | Confianza |
|---|---|---|
| `id_contrato` | Patrón `XX-AAAA-NN` en el documento (incl. el contrato referido por un otrosí). | 0,98 |
| Cliente / NIT | Regex `NOMBRE, (identificada con) NIT\|RUC\|RTN número`; se descarta Periferia; título en mayúsculas → "Título"; NIT sin puntos ni dígito de verificación. | 0,95 (0,75 si no se confirma el rol de contratante) |
| País | Palabras de domicilio del cliente (solo entre el cliente y Periferia); si falta, por moneda. | 0,9 / 0,6 |
| Objeto | Cláusula `OBJETO`, limpiando el prefijo "EL CONTRATISTA prestará…", ≤ 200 caracteres. | 0,9 (0,85 si se recortó) |
| Valor / moneda | Monto entre paréntesis `(COP $265.000.000)` en la cláusula `VALOR`; parser que distingue miles de decimales (`265.000.000`, `120,000.00`). Moneda fuera de COP/USD/PEN/PAB/HNL → error. | 0,97 |
| Valor por demanda | "no tiene un valor determinado" → `valor = 0`, `valor_indeterminado = true`. | **0,5** → revisión |
| Plazo | En `PLAZO`: "desde … hasta …" (fechas en letras con número entre paréntesis, ISO o numéricas; fecha inexistente → error). | 0,95 |
| Plazo en meses | Se deriva de la fecha de firma (completa o solo mes) + N meses. | inicio 0,8–0,9 · **fin 0,5–0,6** → revisión |
| Póliza | Cláusula `GARANTÍAS`: tipos (cumplimiento, calidad, responsabilidad civil, salarios y prestaciones, anticipo). Póliza condicionada a órdenes de servicio → no aplica al marco (observación). Sin cláusula → no requiere. | 0,95 / 0,8 / 0,85 |

**Regla de confianza:** cada campo trae un valor en [0,1]; ausente = `null` con 0, nunca inventado. En `validar`, un contrato `nuevo` exige ≥ 0,8 en cliente, NIT, país, objeto, valor, moneda, fechas y póliza; una `actualizacion` solo revisa los campos que el documento trae (un otrosí no repite todo). El humano puede confirmar baja confianza, pero **no** puede suplir un campo obligatorio ausente.

**Dónde entra el modelo:** orquesta el lote, explica cada campo dudoso, redacta la pregunta de confirmación y el resumen de alertas, y puede pasar una corrección dictada por el usuario. **Dónde no:** extraer, comparar, clasificar, escribir.

**Clasificación (RN1–RN4):** mismo `id_contrato` (o mismo NIT + objeto con similitud de Dice sobre bigramas ≥ 0,9) → existe; compara valor, moneda, fechas y póliza *solo si el documento los trae*: sin diferencias → `duplicado`; con diferencias → `actualizacion`. Sin coincidencia → `nuevo`. Sin adjunto de contrato o sin partes ni objeto → `rechazado` con motivo. El adjunto que es contrato se decide por nombre o por encabezado del texto (una cotización se rechaza).

## 6. Regla de gobierno (propuesta)

1. **Canal único.** Todo contrato firmado, otrosí, prórroga o acta de terminación se envía a **contratos@periferia-ficticia.com**. El buzón es administrado por la **Analista Administrativa** (dueña del maestro) con la **Gerencia Administrativa y Financiera** como respaldo y responsable final; el dueño del maestro queda nombrado por cargo, no por persona, para que el proceso sobreviva a la rotación.
2. **Obligación del comercial.** Enviar, **dentro de 2 días hábiles desde la firma**, el PDF firmado por ambas partes (con texto, no escaneo en baja calidad) **sin importar si exige póliza o no**; igual para cada otrosí y para actas de terminación. Asunto normalizado: `[CONTRATO|OTROSI|TERMINACION] <N.º contrato> - <Cliente> - <objeto corto>`. Una cotización o propuesta **no** se envía a este buzón.
3. **Acuse automático.** En **menos de 15 minutos** el agente responde al comercial con el estado: *registrado* (n.º y ruta), *actualizado*, *duplicado*, *rechazado (motivo)* o *en revisión (qué dato falta)*. El comercial no necesita preguntar a nadie. _(El acuse por correo es parte de la propuesta; en el reto se simula con carpetas y no se envía correo.)_
4. **Excepciones y escalamiento.**
   - *Sin firmar o ilegible:* el agente lo rechaza con motivo; el comercial tiene 2 días hábiles para reenviarlo; si no, la analista escala a su **director comercial**.
   - *Sin valor determinado (marco / por demanda) o plazo ambiguo:* queda **en revisión**; la analista confirma con el comercial en 2 días hábiles; pasados 5 días sin respuesta se escala a la **Gerencia**.
   - *Remitente desconocido (practicante, tercero):* se registra pero se notifica a la analista para asignar comercial responsable.
   - *Póliza exigida y sin constituir > 15 días:* alerta a Gerencia y al corredor.
5. **Cierre del gap (junio–agosto 2026), en una sola campaña de dos semanas.** (a) Cada comercial reenvía al buzón todo contrato, otrosí y acta firmados desde el 2026-05-30, con asunto `[CONTRATO] …`; (b) Finanzas entrega la lista de clientes facturados en el periodo y la analista la cruza contra el maestro para detectar contratos que nadie reportó; (c) el agente procesa el lote, la analista confirma las revisiones y `alertas.md` se entrega a Gerencia como cierre; (d) al terminar, la sección 3 del reporte (registrados desde el corte) debe cubrir el 100 % de la lista de facturación.
6. **Indicador mensual.** **% de contratos facturados en el mes que existen en el maestro** (meta ≥ 98 %). Complementarios: mediana de días entre firma y registro (meta ≤ 2 días hábiles) y n.º de pólizas pendientes con más de 15 días.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| **Extracción determinista** con confianza por regla; el modelo orquesta. | Pedirle al LLM que extraiga todos los campos. | El PRD prohíbe que el modelo afirme valores (CA2); regex + heurísticas son auditables, reproducibles, gratis y permiten `demo.ts` sin clave. Costo: menos flexible ante formatos nuevos (ver riesgos). |
| **La confirmación humana la hace cumplir el backend**, además del prompt. | Confiar solo en el prompt para que el modelo pregunte. | Un prompt no es una garantía; un `confirmado: true` sin pregunta previa podría escribir datos dudosos. Costo: una regla extra en el ciclo (probada en `tests/`). |
| **`registrar` recalcula** extracción y validación por dentro. | Confiar en lo que el modelo pasó desde `validar`. | Evita que se registre un `contrato` manipulado o desactualizado; `validar`/`registrar` aceptan omitir `contrato` y re-extraen. Costo: lectura repetida de un archivo pequeño. |
| **Servidor `node:http`** + front HTML plano. | Express/Fastify + React. | Son 5 rutas; cero dependencias de servidor, arranque rápido y menos superficie. Costo: sin middleware listo (CORS, rate limit por IP), documentado como mejora. |
| **Sin streaming**; una respuesta por turno. | Streaming SSE. | El PRD lo marca opcional; el front muestra el indicador "pensando" y las tarjetas de herramientas al final. Costo: mayor espera percibida en lotes largos. |
| **Sin fallback automático de proveedor** si el modelo declina (`refusal`). | Configurar el modelo de respaldo del proveedor. | Flujo de bajo riesgo y tarea acotada; se muestra un mensaje claro. Es una mejora de producción (ver riesgos). |
| CSV + carpetas locales como "SharePoint". | Base de datos. | Lo exige el PRD (no-objetivo). Escritura atómica (archivo temporal + rename). |

## 8. Supuestos

- **Vencidos cuentan en la alerta 1:** "vencen en ≤ 60 días" incluye contratos ya vencidos (días negativos, marcados `vencido`), porque son los más urgentes (p. ej. CT-2025-018 y CT-2026-002 al 2026-09-03).
- **msg-006:** solo trae "mes de agosto de 2026" como firma; asumo `fecha_inicio = 2026-08-31` (último día del mes, confianza 0,8) y `fecha_fin = inicio + 12 meses` (confianza 0,5), de ahí que la revisión pida confirmar valor y fecha fin (y la observación avisa de la fecha inicio aproximada). La póliza del marco es condicional a órdenes > COP 100 M, por lo que `requiere_poliza = false` con observación.
- **Otrosí con ampliación (msg-003):** exige ampliar las garantías, así que la póliza vuelve a `pendiente`; esto es adicional a valor y fecha fin y queda en `historial.jsonl`. El otrosí se archiva junto al contrato como `<id>-otrosi-<n>.txt`.
- Remitente desconocido → comercial "Sin asignar" (se reporta, no bloquea). `fecha_registro` es la fecha `hoy` que se pasa a `contratos_registrar` (en la demo, 2026-09-03; por defecto, la del sistema).
- La comparación de actualización usa valor, moneda, fechas y póliza; **no** objeto ni cliente, porque el objeto extraído es una redacción distinta de la del maestro y daría falsas actualizaciones.
- Los PDF llegan como texto (`contrato.txt`); `contratos_leer_pdf` (P1) no se implementó.
- `contratos_validar` sobre un mensaje sin contrato lo clasifica `rechazado`; `contratos_registrar` lo marca como procesado sin escribir en el maestro.

## 9. Cobertura

| Historia | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer el buzón | **Hecho** | Lista no procesados con `tiene_contrato`; cotización → `rechazado` con motivo. Falta conexión real a Exchange. |
| HU-2 Extraer | **Hecho** | Esquema 7.2 con confianza por campo; ausentes = `null`/0. Falta OCR y lectura de PDF nativo (P1). |
| HU-3 Validar y clasificar | **Hecho** | RN1–RN5, remitente contra `comerciales.json`. Falta similitud semántica más robusta para NIT + objeto. |
| HU-4 Registrar y archivar | **Hecho** | Maestro en `out/`, archivo, `historial.jsonl`, `procesados.json`. Falta SharePoint real y control de concurrencia multiusuario. |
| HU-5 Alertar | **Hecho** | `out/alertas.md` con las 3 secciones y `hoy` como argumento. Falta envío automático (correo/Teams). |
| HU-6 Errores | **Hecho** | Texto vacío, fecha inválida y moneda desconocida → `{ok:false,error}`; el lote continúa (probado). |
| Front, API, adaptador, prompt aparte, `demo.ts` | **Hecho** | Ver README. |
| Link público | **Parcial** | `Dockerfile` listo; el despliegue y la URL los pone quien entrega. |
| Bonus `modulo/` | **Hecho** | Generado desde las mismas fuentes; un test falla si diverge. |
| `contratos_leer_pdf` (P1) | **No hecho** | Opcional. |
| Acuse automático por correo | **No hecho** | Parte de la propuesta de gobierno, fuera del alcance del reto. |

Verificación: 18 pruebas automáticas (`npm test`) — los 6 casos del buzón, errores (HU-6), el ciclo del agente con un proveedor simulado (tope de iteraciones, bloqueo de confirmación, error del proveedor), la API HTTP y la sincronía de `modulo/`. **No se ha ejecutado el chat contra el modelo real en esta entrega:** el comportamiento del modelo (calidad del resumen, orden de llamadas) debe validarse con la clave propia siguiendo el prompt de ejemplo del README.

## 10. Uso de IA

> _Sección a revisar y completar por la persona que entrega: debe poder explicar cada línea._

- **Claude Code (modelo Claude Sonnet 5.5)**, en el editor, para: leer el PRD y los fixtures, proponer la arquitectura, escribir el código (núcleo, herramientas, ciclo, servidor, front), las pruebas, el `Dockerfile` y estos documentos, y ejecutar `demo.ts` y las pruebas para verificar los resultados esperados de los 6 mensajes.
- **Lo que se consideró y se descartó** (para no sobre-construir o por riesgo): extracción con LLM (por CA2 y por costo); Express/React (innecesario); streaming SSE (opcional); fallback automático de proveedor (no se puede probar sin la API real). Estas decisiones están justificadas en la sección 7.
- El modelo del agente en ejecución es Claude Haiku 5.5 (sección 4); no se usó otra IA para el runtime.

## 11. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o con formatos distintos rompen las regex. | OCR + extracción asistida por LLM **con validación determinista posterior** (misma regla de confianza); conjunto de contratos reales como pruebas de regresión. |
| Falsos duplicados o actualizaciones por variaciones de nombre/objeto. | Dedupe por NIT primero (ya hecho); revisión humana cuando la similitud esté entre 0,7 y 0,9; llave natural por n.º de contrato. |
| El modelo "redondea" un valor o infiere una fecha. | Valores solo desde herramientas; `registrar` recalcula; confirmación exigida por el backend (ya implementado). |
| Inyección de instrucciones dentro de contratos o correos. | El prompt los trata como datos; las herramientas no ejecutan shell, solo escriben en `out/`; validación zod; agregar clasificador de entrada y registro de auditoría inmutable. |
| Abuso del link público (gasto de la clave). | Topes de iteraciones y tokens por sesión (ya), `ACCESS_KEY`; en producción: rate limit por IP/usuario, autenticación (SSO) y presupuesto en el proveedor. |
| Concurrencia y pérdida de datos en CSV. | Hoy escritura atómica de un solo proceso; en producción, base de datos o SharePoint/Graph con control de versiones. |
| El modelo declina (`refusal`) o el proveedor cae. | Mensaje claro hoy; en producción, fallback server-side del proveedor y reintentos con backoff. |
| Dependencia del cumplimiento del comercial. | La regla de gobierno + el indicador mensual cruzado con facturación; sin ella el agente solo ve lo que llega. |
| Datos personales/contractuales sensibles en logs y sesiones. | Los logs guardan resúmenes, no el texto del contrato; en producción, retención acotada, cifrado y control de acceso. |
