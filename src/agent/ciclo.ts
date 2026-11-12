import { agregarLog } from "../core/almacen.js"
import { ErrorProveedor, type Bloque, type MensajeLLM, type ProveedorLLM } from "../llm/adapter.js"
import type { ContextoHerramienta, Herramienta } from "../tools/registry.js"

/** Ciclo del agente: prompt → modelo → herramientas → modelo … hasta respuesta final o tope de iteraciones. */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
  ok: boolean
  /** Resultado JSON (truncado para la UI; el modelo recibe el completo). */
  resultado: string
  ms: number
}

export interface EntradaHistorial {
  rol: "user" | "assistant"
  texto: string
  ts: string
  toolCalls?: LlamadaHerramienta[]
  needsConfirmation?: boolean
  error?: boolean
}

export interface Sesion {
  id: string
  mensajes: MensajeLLM[]
  historial: EntradaHistorial[]
  tokens: number
  /** Mensajes cuyo registro quedó pendiente de confirmación humana. */
  pendientes: Set<string>
  /** Mensajes por los que ya se preguntó al usuario en un turno anterior: solo ellos admiten confirmado=true. */
  confirmables: Set<string>
  ocupada: boolean
}

export interface DependenciasCiclo {
  proveedor: ProveedorLLM
  herramientas: Herramienta[]
  sistema: string
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
}

export interface ResultadoTurno {
  reply: string
  toolCalls: LlamadaHerramienta[]
  needsConfirmation: boolean
  pendientes: string[]
  tokens: number
}

const LIMITE_UI = 3000

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], historial: [], tokens: 0, pendientes: new Set(), confirmables: new Set(), ocupada: false }
}

function textoDe(bloques: Bloque[]): string {
  return bloques.map((b) => (b.tipo === "texto" ? b.texto : "")).join("").trim()
}

function recortar(s: string): string {
  return s.length <= LIMITE_UI ? s : `${s.slice(0, LIMITE_UI)}… (${s.length - LIMITE_UI} caracteres más)`
}

function analizar(resultado: string): { ok: boolean; datos: Record<string, unknown> } {
  try {
    const j = JSON.parse(resultado) as Record<string, unknown>
    return { ok: j.ok === true, datos: j }
  } catch {
    return { ok: false, datos: {} }
  }
}

function mensajeIdDe(args: unknown): string | null {
  if (typeof args === "object" && args !== null && "mensaje_id" in args) {
    const v = (args as { mensaje_id: unknown }).mensaje_id
    return typeof v === "string" ? v : null
  }
  return null
}

function confirmaSinPregunta(nombre: string, args: unknown, sesion: Sesion): boolean {
  if (nombre !== "contratos_registrar" || typeof args !== "object" || args === null) return false
  if ((args as { confirmado?: unknown }).confirmado !== true) return false
  const id = mensajeIdDe(args)
  return id === null || !sesion.confirmables.has(id)
}

/** Actualiza qué mensajes esperan confirmación según el resultado de la herramienta. */
function seguirPendientes(nombre: string, args: unknown, resultado: string, pendientes: Set<string>): void {
  const id = mensajeIdDe(args)
  if (!id) return
  const { ok, datos } = analizar(resultado)
  if (nombre === "contratos_validar" && ok) {
    const d = datos.data as { clasificacion?: string; requiere_revision?: string[] } | undefined
    const dudoso = (d?.requiere_revision?.length ?? 0) > 0 && d?.clasificacion !== "duplicado" && d?.clasificacion !== "rechazado"
    if (dudoso) pendientes.add(id)
  }
  if (nombre === "contratos_registrar") {
    if (ok) pendientes.delete(id)
    else if (Array.isArray(datos.requiere_revision) && datos.requiere_revision.length > 0) pendientes.add(id)
  }
}

async function ejecutarLlamada(
  h: Herramienta | undefined, id: string, nombre: string, args: unknown, sesion: Sesion, dep: DependenciasCiclo,
): Promise<{ llamada: LlamadaHerramienta; completo: string }> {
  const t0 = Date.now()
  const ctx: ContextoHerramienta = { directory: dep.directory, sessionId: sesion.id }
  let completo: string
  if (!h) {
    completo = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  } else if (confirmaSinPregunta(nombre, args, sesion)) {
    completo = JSON.stringify({
      ok: false,
      error: "confirmado=true solo se acepta después de preguntar al usuario y recibir su confirmación explícita en un mensaje posterior. Si el mensaje NO tiene campos en revisión, llama contratos_registrar SIN el parámetro confirmado; si los tiene, pregunta primero al usuario.",
    })
    agregarLog(dep.directory, { herramienta: nombre, mensaje_id: mensajeIdDe(args), ok: false, resumen: "confirmado=true bloqueado: no hubo confirmación previa del usuario" })
  } else {
    completo = await h.ejecutar(args, ctx)
  }
  const ok = analizar(completo).ok
  return { llamada: { id, nombre, args, ok, resultado: recortar(completo), ms: Date.now() - t0 }, completo }
}

export async function ejecutarTurno(dep: DependenciasCiclo, sesion: Sesion, textoUsuario: string): Promise<ResultadoTurno> {
  const toolCalls: LlamadaHerramienta[] = []
    const pendientesTurno = new Set(sesion.pendientes)
  const ahora = (): string => new Date().toISOString()

  sesion.mensajes.push({ rol: "user", contenido: [{ tipo: "texto", texto: textoUsuario }] })
  sesion.historial.push({ rol: "user", texto: textoUsuario, ts: ahora() })

  const sistema: MensajeLLM = { rol: "system", contenido: [{ tipo: "texto", texto: dep.sistema }] }
  const llmHerramientas = dep.herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.description, esquema: h.jsonSchema }))
  let reply = ""
  let error = false

  try {
    for (let i = 0; ; i++) {
      if (sesion.tokens >= dep.maxTokensSesion) {
        reply = "Se alcanzó el tope de tokens de esta sesión. Inicia una sesión nueva para continuar."
        break
      }
      const ultimaVuelta = i >= dep.maxIteraciones
      if (ultimaVuelta) {
        sesion.mensajes.push({
          rol: "user",
          contenido: [{ tipo: "texto", texto: "[Sistema] Llegaste al tope de iteraciones de este turno. Responde ahora, sin llamar herramientas: qué lograste y qué falta." }],
        })
      }
      const r = await dep.proveedor.enviar([sistema, ...sesion.mensajes], llmHerramientas, { sinHerramientas: ultimaVuelta })
      sesion.tokens += r.uso.entrada + r.uso.salida
      sesion.mensajes.push(r.mensaje)

      if (r.fin === "rechazo") {
        reply = "El modelo declinó atender esta solicitud por sus políticas de seguridad. Reformúlala o continúa con otra tarea."
        error = true
        break
      }
      const usos = r.mensaje.contenido.filter((b): b is Extract<Bloque, { tipo: "herramienta" }> => b.tipo === "herramienta")
      if (r.fin !== "herramientas" || usos.length === 0 || ultimaVuelta) {
        reply = textoDe(r.mensaje.contenido)
        if (r.fin === "limite_tokens") reply += "\n\n(La respuesta se cortó por el límite de longitud; pídeme que continúe.)"
        break
      }
      const resultados: Bloque[] = []
      for (const u of usos) {
        const h = dep.herramientas.find((x) => x.nombre === u.nombre)
        const { llamada, completo } = await ejecutarLlamada(h, u.id, u.nombre, u.args, sesion, dep)
        toolCalls.push(llamada)
        seguirPendientes(u.nombre, u.args, completo, pendientesTurno)
        resultados.push({ tipo: "resultado", id: u.id, contenido: completo, error: !llamada.ok })
      }
      sesion.mensajes.push({ rol: "user", contenido: resultados })
    }
  } catch (e) {
    error = true
    reply = e instanceof ErrorProveedor ? e.message : "Ocurrió un error inesperado en el agente. La sesión sigue activa; intenta de nuevo."
    if (!(e instanceof ErrorProveedor)) console.error("Error en el ciclo del agente:", e instanceof Error ? e.message : e)
  }

  sesion.pendientes = pendientesTurno
  sesion.confirmables = new Set(pendientesTurno)
  const needsConfirmation = pendientesTurno.size > 0 && !error
  sesion.historial.push({ rol: "assistant", texto: reply, ts: ahora(), toolCalls, needsConfirmation, error })
  return { reply, toolCalls, needsConfirmation, pendientes: [...pendientesTurno], tokens: sesion.tokens }
}
