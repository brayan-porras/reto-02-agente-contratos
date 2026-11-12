# Reto 02 — Agente conversacional "Registro de Contratos Vigentes"

Agente de chat (TypeScript, Node 20+) que actúa como **punto único de recepción de contratos**: lee un buzón simulado, extrae los datos de cada contrato con confianza por campo, detecta duplicados y otrosíes, archiva el documento en una estructura tipo SharePoint, alimenta el maestro y genera alertas de vencimiento y pólizas. Los campos de baja confianza (< 0.8) detienen el registro y piden confirmación humana.

- **Planteamiento, decisiones, costos y regla de gobierno:** [SOLUCION.md](SOLUCION.md)
- **Enunciado:** [PRD.md](PRD.md)
- **Link de prueba:** _<pegar aquí la URL pública tras desplegar>_ · **Clave de acceso:** _<si se protege con ACCESS_KEY, indicarla aquí>_

## Modelo utilizado

| | |
|---|---|
| **Proveedor** | Anthropic (SDK oficial `@anthropic-ai/sdk`) |
| **Modelo** | `claude-haiku-5-5` — rápido y barato; la extracción es determinista, el modelo solo orquesta las herramientas y explica |
| **Esfuerzo** | `low` (`ANTHROPIC_EFFORT`) |
| **Alternativa** | `claude-sonnet-5-5` cambiando `ANTHROPIC_MODEL`, si necesitas más calidad |
| **Costo estimado** | Del orden de centavos de dólar por corrida del buzón completo (estimación; ver `SOLUCION.md` §4) |

El proveedor se cambia solo con variables de entorno: el ciclo del agente no conoce al proveedor (interfaz en `src/llm/adapter.ts`).

## Requisitos

Node.js 20.12+ (usa `process.loadEnvFile`). Los scripts usan `tsx`, así que no hace falta instalar Bun.

## Levantar en local (un comando)

```bash
npm install
cp .env.example .env        # y completa ANTHROPIC_API_KEY (modelo por defecto: claude-haiku-5-5)
npm run dev                 # http://localhost:3000  (front + backend)
```

Sin clave el servidor arranca igual (el chat responde 503 con un mensaje claro); en ese caso usa la demo sin modelo.

## Demo sin modelo (no requiere ninguna clave)

```bash
npm install && npm run demo      # o: npx tsx demo.ts
```

Procesa los 6 mensajes de `fixtures/reto-02/buzon/` llamando directamente a las herramientas: clasificación, campos en revisión y acción por mensaje; `msg-006` queda **sin registrar** en la primera pasada y se registra en una segunda llamada con `confirmado: true`; termina generando `out/alertas.md`. `out/` se limpia al inicio, así que el resultado es el mismo en ejecuciones consecutivas (salvo timestamps).

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clave de Anthropic. **Solo backend**; nunca llega al front, a logs ni a respuestas. |
| `LLM_PROVIDER` | `anthropic` | Proveedor del modelo (ver `src/llm/`). |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Modelo (rápido y barato; `claude-sonnet-5-5` si necesitas más calidad). |
| `ANTHROPIC_EFFORT` | `medium` (el `.env.example` sugiere `low`) | `low` \| `medium` \| `high` (profundidad de razonamiento y gasto). |
| `PORT` | `3000` | Puerto HTTP. |
| `ACCESS_KEY` | — | Si se define, el chat exige la cabecera `x-access-key` (el front muestra un campo para escribirla). |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones herramienta→modelo por turno (CA1). |
| `MAX_TOKENS_SESION` | `200000` | Tope de tokens por sesión (control de costo). |
| `MAX_TOKENS_RESPUESTA` | `8000` | `max_tokens` por llamada al modelo. |
| `LLM_TIMEOUT_MS` | `60000` | Timeout hacia el proveedor. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes[], tokens }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes y llamadas a herramientas). |
| `GET` | `/api/health` | `{ ok, provider, model, configured, accessKeyRequired }` — sin claves. |
| `GET` | `/api/out/{alertas,maestro,historial,log,procesados}` | Archivos generados en `out/` (solo lectura, lista blanca). |
| `POST` | `/api/reset` | Borra sesiones y `out/` (para repetir la demo). |

Con `ACCESS_KEY` definida, todas las rutas `/api/*` excepto `health` exigen `x-access-key`.

## Prompt de prueba

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Luego: `confirmo el valor 0 y la fecha fin 2027-08-31` → `msg-006` queda registrado.

## Estructura

```
agent/prompt.md                 comportamiento: system prompt del agente
src/knowledge/                  conocimiento: reglas del proceso (se anexa al prompt)
src/tools/contratos.ts          ejecución: herramientas tipadas con zod (contratos_<export>)
src/tools/registry.ts           convierte cada export en herramienta validada
src/core/                       lógica de negocio: extracción, validación, registro, alertas, almacenamiento
src/agent/ciclo.ts              ciclo del agente (tope de iteraciones, confirmación humana)
src/llm/                        adaptador de proveedor (adapter.ts) + implementación Anthropic
src/server.ts                   API HTTP
web/                            front de chat (HTML plano)
fixtures/                       entregado por Periferia (solo lectura)
out/                            generado en ejecución (no se versiona)
demo.ts                         herramientas sin modelo
modulo/                         bonus: agente empaquetado (generado con `npm run build:modulo`)
tests/                          pruebas (`npm test`)
```

## Pruebas

```bash
npm test          # 18 pruebas: 6 casos del buzón, errores, ciclo del agente, API HTTP, módulo sincronizado
npm run typecheck
```

## Despliegue

Hay un `Dockerfile` listo (Render, Railway, Fly.io, Azure Container Apps…). Define `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-haiku-5-5`, `ANTHROPIC_EFFORT=low` (y opcionalmente `ACCESS_KEY`) como variables del servicio; **no** las pongas en el repositorio. El estado vive en `out/` y se reinicia al arrancar el servidor.
