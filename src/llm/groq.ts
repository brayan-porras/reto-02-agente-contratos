import {
  ErrorProveedor,
  type Bloque, type HerramientaLLM, type MensajeLLM, type MotivoFin, type OpcionesEnvio, type ProveedorLLM, type RespuestaLLM,
} from "./adapter.js"

/**
 * Implementación para Groq (API compatible con "chat completions" con herramientas).
 * La capa gratuita limita los tokens por minuto (TPM), así que este adaptador:
 *  - espera de forma proactiva para no pasarse del TPM (ventana deslizante de 60 s),
 *  - reintenta ante 429 respetando el tiempo que indica el proveedor,
 *  - recorta los resultados de herramientas antiguos del historial que envía.
 */

export interface ConfigGroq {
  apiKey: string
  modelo: string
  timeoutMs: number
  maxTokensRespuesta: number
  baseUrl?: string
  /** Tokens por minuto permitidos por el plan (8000 en la capa gratuita). */
  tpm?: number
  /** Piso de la espera entre reintentos ante 429 (ms). */
  esperaMinimaMs?: number
  /** Reintentos ante 429 antes de rendirse. */
  reintentos?: number
}

interface LlamadaGroq {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type MensajeGroq =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlamadaGroq[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface RespuestaGroq {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; tool_calls?: LlamadaGroq[] }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string; code?: string }
}

const VENTANA_MS = 60_000
const ESPERA_MAX_MS = 65_000
const CARACTERES_POR_TOKEN = 3.2
/** Cuántos resultados de herramientas recientes se envían completos; los anteriores se recortan. */
const RESULTADOS_COMPLETOS = 4
const MAX_RESULTADO_ANTIGUO = 500

const dormir = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

export class ProveedorGroq implements ProveedorLLM {
  readonly nombre = "groq"
  readonly modelo: string
  private readonly url: string
  private readonly tpm: number
  private readonly esperaMinimaMs: number
  private readonly reintentos: number
  private consumos: Array<{ ts: number; tokens: number }> = []
  /** Tokens de entrada que Groq sirvió desde caché en la última llamada: no cuentan para el límite por minuto. */
  private ultimoCacheado = 0

  constructor(private readonly config: ConfigGroq) {
    this.modelo = config.modelo
    this.url = `${config.baseUrl ?? "https://api.groq.com/openai/v1"}/chat/completions`
    this.tpm = config.tpm ?? 8000
    this.esperaMinimaMs = config.esperaMinimaMs ?? 2000
    this.reintentos = config.reintentos ?? 4
  }

  async enviar(mensajes: MensajeLLM[], herramientas: HerramientaLLM[], opciones: OpcionesEnvio = {}): Promise<RespuestaLLM> {
    const cuerpo: Record<string, unknown> = {
      model: this.modelo,
      max_tokens: this.config.maxTokensRespuesta,
      messages: compactar(mensajes).flatMap(aMensajesGroq),
      tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.esquema } })),
      tool_choice: opciones.sinHerramientas ? "none" : "auto",
      // Los modelos gpt-oss razonan: "low" gasta menos tokens por minuto.
      ...(this.modelo.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
    }
    await this.esperarCupo(Math.max(0, estimarTokens(cuerpo) - this.ultimoCacheado) + 500)
    const respuesta = await this.llamar(cuerpo, 0)
    const eleccion = respuesta.choices?.[0]
    if (!eleccion?.message) throw new ErrorProveedor("El proveedor respondió sin contenido. Intenta de nuevo.", true)
    const bloques: Bloque[] = []
    if (eleccion.message.content) bloques.push({ tipo: "texto", texto: eleccion.message.content })
    for (const t of eleccion.message.tool_calls ?? []) {
      bloques.push({ tipo: "herramienta", id: t.id, nombre: t.function.name, args: parsearArgumentos(t.function.arguments) })
    }
    const uso = { entrada: respuesta.usage?.prompt_tokens ?? 0, salida: respuesta.usage?.completion_tokens ?? 0 }
    this.ultimoCacheado = respuesta.usage?.prompt_tokens_details?.cached_tokens ?? 0
    this.consumos.push({ ts: Date.now(), tokens: Math.max(0, uso.entrada - this.ultimoCacheado) + uso.salida })
    return { mensaje: { rol: "assistant", contenido: bloques }, fin: motivoDe(eleccion.finish_reason, bloques), uso }
  }

  /** Espera (sin bloquear el resto del servidor) hasta que la ventana de 60 s tenga cupo para esta solicitud. */
  private async esperarCupo(necesarios: number): Promise<void> {
    for (;;) {
      const ahora = Date.now()
      this.consumos = this.consumos.filter((c) => ahora - c.ts < VENTANA_MS)
      const usados = this.consumos.reduce((suma, c) => suma + c.tokens, 0)
      const primero = this.consumos[0]
      if (!primero || usados + necesarios <= this.tpm) return
      await dormir(Math.min(primero.ts + VENTANA_MS - ahora + 250, ESPERA_MAX_MS))
    }
  }

  /** Una llamada HTTP con timeout; ante 429 espera lo que indique el proveedor y reintenta. */
  private async llamar(cuerpo: unknown, intento: number): Promise<RespuestaGroq> {
    let res: Response
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ErrorProveedor("El modelo tardó demasiado en responder (timeout). Intenta de nuevo en unos segundos.", true)
      }
      throw new ErrorProveedor("No se pudo conectar con el proveedor del modelo. Revisa la conexión e intenta de nuevo.", true)
    }
    const datos = (await res.json().catch(() => ({}))) as RespuestaGroq
    if (res.ok) return datos
    if (res.status === 429 && intento < this.reintentos) {
      await dormir(esperaSugerida(res.headers, datos.error?.message, this.esperaMinimaMs))
      return this.llamar(cuerpo, intento + 1)
    }
    throw traducirError(res.status, datos.error)
  }
}

/** "697ms", "2.5s" o "5m45.6s" → milisegundos; null si no se entiende. */
export function duracionAMs(texto: string | null | undefined): number | null {
  if (!texto) return null
  const m = /^(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(texto.trim())
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null
  return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0)
}

function esperaSugerida(cabeceras: Headers, mensaje: string | undefined, minimo: number): number {
  const retryAfter = Number(cabeceras.get("retry-after"))
  const candidatos = [
    Number.isFinite(retryAfter) && cabeceras.get("retry-after") !== null ? retryAfter * 1000 : null,
    duracionAMs(cabeceras.get("x-ratelimit-reset-tokens")),
    duracionAMs(/try again in ([\d.]+(?:ms|s|m[\d.]+s))/i.exec(mensaje ?? "")?.[1]),
  ].filter((v): v is number => v !== null)
  const sugerida = candidatos.length ? Math.max(...candidatos) : 5000
  return Math.min(Math.max(sugerida + 500, minimo), ESPERA_MAX_MS)
}

function estimarTokens(cuerpo: unknown): number {
  return Math.ceil(JSON.stringify(cuerpo).length / CARACTERES_POR_TOKEN)
}

/** Recorta los resultados de herramientas antiguos (ya fueron usados por el modelo) para no gastar tokens por minuto. */
function compactar(mensajes: MensajeLLM[]): MensajeLLM[] {
  const total = mensajes.reduce((n, m) => n + m.contenido.filter((b) => b.tipo === "resultado").length, 0)
  let visto = 0
  return mensajes.map((m) => {
    if (!m.contenido.some((b) => b.tipo === "resultado")) return m
    const contenido = m.contenido.map((b): Bloque => {
      if (b.tipo !== "resultado") return b
      visto++
      const antiguo = visto <= total - RESULTADOS_COMPLETOS
      if (!antiguo || b.contenido.length <= MAX_RESULTADO_ANTIGUO) return b
      return { ...b, contenido: `${b.contenido.slice(0, MAX_RESULTADO_ANTIGUO)}…[resultado anterior recortado]` }
    })
    return { ...m, contenido }
  })
}

function aMensajesGroq(m: MensajeLLM): MensajeGroq[] {
  if (m.rol === "system") return [{ role: "system", content: textoDe(m.contenido) }]
  if (m.rol === "assistant") {
    const llamadas = m.contenido
      .filter((b): b is Extract<Bloque, { tipo: "herramienta" }> => b.tipo === "herramienta")
      .map((b): LlamadaGroq => ({ id: b.id, type: "function", function: { name: b.nombre, arguments: JSON.stringify(b.args ?? {}) } }))
    const texto = textoDe(m.contenido)
    return [{ role: "assistant", content: texto || null, ...(llamadas.length ? { tool_calls: llamadas } : {}) }]
  }
  const resultados = m.contenido.filter((b): b is Extract<Bloque, { tipo: "resultado" }> => b.tipo === "resultado")
  const salida: MensajeGroq[] = resultados.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.contenido }))
  const texto = textoDe(m.contenido)
  if (texto) salida.push({ role: "user", content: texto })
  return salida
}

function textoDe(bloques: Bloque[]): string {
  return bloques.map((b) => (b.tipo === "texto" ? b.texto : "")).join("")
}

/** Si el modelo emite argumentos que no son JSON, se pasa {} y la validación zod devuelve un error legible al modelo. */
function parsearArgumentos(crudo: string): unknown {
  try {
    return JSON.parse(crudo || "{}")
  } catch {
    return {}
  }
}

function motivoDe(fin: string | undefined, bloques: Bloque[]): MotivoFin {
  if (bloques.some((b) => b.tipo === "herramienta")) return "herramientas"
  if (fin === "length") return "limite_tokens"
  return "fin"
}

function traducirError(estado: number, error?: { message?: string; code?: string }): ErrorProveedor {
  if (estado === 401 || estado === 403) {
    return new ErrorProveedor("El servidor no pudo autenticarse con el proveedor del modelo. Avisa al administrador.")
  }
  if (estado === 429) {
    return new ErrorProveedor("Se alcanzó el límite gratuito del proveedor (solicitudes o tokens por minuto) incluso después de esperar. Espera un minuto y escribe «continúa».", true)
  }
  if (estado === 413) {
    return new ErrorProveedor("La conversación ya es demasiado grande para el límite del proveedor. Pulsa «Reiniciar demo» y empieza de nuevo.")
  }
  if (estado === 400 && error?.code === "tool_use_failed") {
    return new ErrorProveedor("El modelo generó una llamada a herramienta mal formada. Escribe «continúa» para reintentar.", true)
  }
  if (estado === 400) return new ErrorProveedor(`El proveedor rechazó la solicitud: ${error?.message ?? "sin detalle"}`)
  return new ErrorProveedor(`Error del proveedor del modelo (${estado}). Intenta de nuevo.`, estado >= 500)
}
