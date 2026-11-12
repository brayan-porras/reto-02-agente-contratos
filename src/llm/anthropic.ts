import Anthropic from "@anthropic-ai/sdk"
import {
  ErrorProveedor,
  type Bloque, type HerramientaLLM, type MensajeLLM, type MotivoFin, type OpcionesEnvio, type ProveedorLLM, type RespuestaLLM,
} from "./adapter.js"

type Esfuerzo = "low" | "medium" | "high"

export interface ConfigAnthropic {
  apiKey: string
  modelo: string
  esfuerzo: Esfuerzo
  timeoutMs: number
  maxTokensRespuesta: number
}

/** Implementación para Anthropic (Claude) con el SDK oficial. La clave llega solo por configuración del backend. */
export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(private readonly config: ConfigAnthropic) {
    this.modelo = config.modelo
    this.cliente = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: MensajeLLM[], herramientas: HerramientaLLM[], opciones: OpcionesEnvio = {}): Promise<RespuestaLLM> {
    const sistema = mensajes
      .filter((m) => m.rol === "system")
      .flatMap((m) => m.contenido)
      .map((b) => (b.tipo === "texto" ? b.texto : ""))
      .join("\n\n")
    try {
      const r = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: this.config.maxTokensRespuesta,
        cache_control: { type: "ephemeral" }, // caché automática: el prefijo (sistema + herramientas + historial) se reutiliza en cada vuelta del ciclo
        system: sistema,
        output_config: { effort: this.config.esfuerzo },
        tools: herramientas.map(aHerramientaAnthropic),
        ...(opciones.sinHerramientas ? { tool_choice: { type: "none" as const } } : {}),
        messages: mensajes.filter((m) => m.rol !== "system").map(aMensajeAnthropic),
      })
      return {
        mensaje: { rol: "assistant", contenido: desdeBloques(r.content), crudo: r.content },
        fin: motivoDe(r.stop_reason),
        uso: { entrada: r.usage.input_tokens, salida: r.usage.output_tokens },
      }
    } catch (e) {
      throw traducirError(e)
    }
  }
}

function aHerramientaAnthropic(h: HerramientaLLM): Anthropic.Tool {
  return { name: h.nombre, description: h.descripcion, input_schema: h.esquema as Anthropic.Tool.InputSchema }
}

function aMensajeAnthropic(m: MensajeLLM): Anthropic.MessageParam {
  if (m.rol === "assistant" && Array.isArray(m.crudo)) {
    // Se devuelve el contenido original (incluye razonamiento) para no romper la continuidad del modelo.
    return { role: "assistant", content: m.crudo as Anthropic.ContentBlockParam[] }
  }
  return { role: m.rol === "assistant" ? "assistant" : "user", content: m.contenido.map(aBloqueAnthropic) }
}

function aBloqueAnthropic(b: Bloque): Anthropic.ContentBlockParam {
  switch (b.tipo) {
    case "texto":
      return { type: "text", text: b.texto }
    case "herramienta":
      return { type: "tool_use", id: b.id, name: b.nombre, input: b.args as Record<string, unknown> }
    case "resultado":
      return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.error === true }
  }
}

function desdeBloques(contenido: Anthropic.ContentBlock[]): Bloque[] {
  const bloques: Bloque[] = []
  for (const b of contenido) {
    if (b.type === "text") bloques.push({ tipo: "texto", texto: b.text })
    else if (b.type === "tool_use") bloques.push({ tipo: "herramienta", id: b.id, nombre: b.name, args: b.input })
  }
  return bloques
}

function motivoDe(stop: Anthropic.Message["stop_reason"]): MotivoFin {
  if (stop === "tool_use") return "herramientas"
  if (stop === "max_tokens") return "limite_tokens"
  if (stop === "refusal") return "rechazo"
  return "fin"
}

function traducirError(e: unknown): ErrorProveedor {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorProveedor("El modelo tardó demasiado en responder (timeout). Intenta de nuevo en unos segundos.", true)
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ErrorProveedor("El servidor no pudo autenticarse con el proveedor del modelo. Avisa al administrador.")
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorProveedor("El proveedor del modelo está limitando las solicitudes. Espera un momento e intenta de nuevo.", true)
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new ErrorProveedor(`El proveedor rechazó la solicitud (${e.status}): ${e.message}`)
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new ErrorProveedor("No se pudo conectar con el proveedor del modelo. Revisa la conexión e intenta de nuevo.", true)
  }
  if (e instanceof Anthropic.APIError) {
    return new ErrorProveedor(`Error del proveedor del modelo (${e.status ?? "sin código"}). Intenta de nuevo.`, (e.status ?? 0) >= 500)
  }
  return new ErrorProveedor("Fallo inesperado al consultar el modelo.")
}
