import { existsSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { ejecutarTurno, nuevaSesion, type Sesion } from "./agent/ciclo.js"
import { reiniciarOut, rutas } from "./core/almacen.js"
import type { ProveedorLLM } from "./llm/adapter.js"
import { ProveedorAnthropic } from "./llm/anthropic.js"
import { ProveedorGroq } from "./llm/groq.js"
import { cargarHerramientas } from "./tools/registry.js"

/** API HTTP del chat. La lógica del agente está en src/agent/, las herramientas en src/tools/. */

export interface OpcionesServidor {
  directory: string
  proveedor: ProveedorLLM | null
  accessKey?: string
  maxIteraciones: number
  maxTokensSesion: number
  /** Proveedor declarado en la configuración (para /api/health aunque no haya clave). */
  nombreProveedor?: string
  modeloConfigurado?: string
}

const MAX_CUERPO = 64 * 1024
const MAX_MENSAJE = 4000
const MAX_SESIONES = 200
const ID_SESION = /^[A-Za-z0-9_-]{6,64}$/

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/index.html": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
}

const ARCHIVOS_OUT: Record<string, keyof ReturnType<typeof rutas>> = {
  alertas: "alertas",
  maestro: "maestro",
  historial: "historial",
  log: "log",
  procesados: "procesados",
}

export function cargarSistema(directory: string): string {
  const prompt = readFileSync(join(directory, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directory, "src", "knowledge", "registro-contratos.md"), "utf8")
  return `${prompt}\n\n---\n\n# Conocimiento del proceso (referencia)\n\n${conocimiento}`
}

function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const json = JSON.stringify(cuerpo)
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(json)
}

async function leerJson(req: IncomingMessage): Promise<unknown> {
  const trozos: Buffer[] = []
  let total = 0
  for await (const t of req) {
    const b = t as Buffer
    total += b.length
    if (total > MAX_CUERPO) throw new ErrorHttp(413, "Cuerpo demasiado grande")
    trozos.push(b)
  }
  try {
    return JSON.parse(Buffer.concat(trozos).toString("utf8"))
  } catch {
    throw new ErrorHttp(400, "JSON inválido")
  }
}

class ErrorHttp extends Error {
  constructor(public readonly estado: number, mensaje: string) {
    super(mensaje)
  }
}

export function crearServidor(op: OpcionesServidor): Server {
  const herramientas = cargarHerramientas()
  const sistema = cargarSistema(op.directory)
  const sesiones = new Map<string, Sesion>()
  reiniciarOut(op.directory)

  const autorizado = (req: IncomingMessage): boolean => !op.accessKey || req.headers["x-access-key"] === op.accessKey

  function obtenerSesion(id: string): Sesion {
    let s = sesiones.get(id)
    if (!s) {
      if (sesiones.size >= MAX_SESIONES) {
        const primera = sesiones.keys().next().value
        if (primera !== undefined) sesiones.delete(primera)
      }
      s = nuevaSesion(id)
      sesiones.set(id, s)
    }
    return s
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cuerpo = (await leerJson(req)) as { sessionId?: unknown; message?: unknown }
    const sessionId = typeof cuerpo.sessionId === "string" ? cuerpo.sessionId : ""
    const message = typeof cuerpo.message === "string" ? cuerpo.message.trim() : ""
    if (!ID_SESION.test(sessionId)) throw new ErrorHttp(400, "sessionId inválido (6–64 caracteres: letras, números, - o _)")
    if (!message) throw new ErrorHttp(400, "El mensaje está vacío")
    if (message.length > MAX_MENSAJE) throw new ErrorHttp(400, `El mensaje supera ${MAX_MENSAJE} caracteres`)
    if (!op.proveedor) {
      throw new ErrorHttp(503, "El servidor no tiene configurada la clave del modelo (ANTHROPIC_API_KEY o GROQ_API_KEY). Avisa al administrador.")
    }
    const sesion = obtenerSesion(sessionId)
    if (sesion.ocupada) throw new ErrorHttp(409, "La sesión aún está procesando el mensaje anterior")
    sesion.ocupada = true
    try {
      const r = await ejecutarTurno(
        { proveedor: op.proveedor, herramientas, sistema, directory: op.directory, maxIteraciones: op.maxIteraciones, maxTokensSesion: op.maxTokensSesion },
        sesion,
        message,
      )
      responder(res, 200, { reply: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, pendientes: r.pendientes, tokens: r.tokens })
    } finally {
      sesion.ocupada = false
    }
  }

  async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const ruta = url.pathname
    const metodo = req.method ?? "GET"

    const estatico = ESTATICOS[ruta]
    if (metodo === "GET" && estatico) {
      const archivo = join(op.directory, "web", estatico.archivo)
      if (!existsSync(archivo)) throw new ErrorHttp(404, "No encontrado")
      res.writeHead(200, { "content-type": estatico.tipo, "cache-control": "no-cache" })
      res.end(readFileSync(archivo))
      return
    }
    if (metodo === "GET" && ruta === "/api/health") {
      responder(res, 200, {
        ok: true,
        provider: op.proveedor?.nombre ?? op.nombreProveedor ?? "ninguno",
        model: op.proveedor?.modelo ?? op.modeloConfigurado ?? "",
        configured: op.proveedor !== null,
        accessKeyRequired: Boolean(op.accessKey),
      })
      return
    }
    if (!ruta.startsWith("/api/")) throw new ErrorHttp(404, "No encontrado")
    if (!autorizado(req)) throw new ErrorHttp(401, "Clave de acceso inválida o ausente")

    if (metodo === "POST" && ruta === "/api/chat") return chat(req, res)
    if (metodo === "POST" && ruta === "/api/reset") {
      sesiones.clear()
      reiniciarOut(op.directory)
      responder(res, 200, { ok: true })
      return
    }
    const sesionRuta = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
    if (metodo === "GET" && sesionRuta) {
      const s = sesiones.get(decodeURIComponent(sesionRuta[1] ?? ""))
      if (!s) throw new ErrorHttp(404, "Sesión no encontrada")
      responder(res, 200, { id: s.id, tokens: s.tokens, pendientes: [...s.pendientes], historial: s.historial })
      return
    }
    const salida = /^\/api\/out\/([a-z]+)$/.exec(ruta)
    if (metodo === "GET" && salida) {
      const clave = ARCHIVOS_OUT[salida[1] ?? ""]
      const archivo = clave ? rutas(op.directory)[clave] : undefined
      if (!archivo || !existsSync(archivo)) throw new ErrorHttp(404, "Archivo aún no generado")
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      res.end(readFileSync(archivo, "utf8"))
      return
    }
    throw new ErrorHttp(404, "No encontrado")
  }

  return createServer((req, res) => {
    manejar(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end()
      if (e instanceof ErrorHttp) return responder(res, e.estado, { ok: false, error: e.message })
      console.error("Error no controlado:", e instanceof Error ? e.message : e)
      return responder(res, 500, { ok: false, error: "Error interno del servidor" })
    })
  })
}

function entero(valor: string | undefined, porDefecto: number): number {
  const n = Number(valor)
  return Number.isInteger(n) && n > 0 ? n : porDefecto
}

const MODELO_POR_DEFECTO: Record<string, string> = { anthropic: "claude-haiku-5-5", groq: "openai/gpt-oss-120b" }

function nombreProveedor(): string {
  return process.env.LLM_PROVIDER === "groq" ? "groq" : "anthropic"
}

function modeloConfigurado(): string {
  const nombre = nombreProveedor()
  const variable = nombre === "groq" ? process.env.GROQ_MODEL : process.env.ANTHROPIC_MODEL
  return variable || (MODELO_POR_DEFECTO[nombre] ?? "")
}

function proveedorDesdeEntorno(): ProveedorLLM | null {
  const timeoutMs = entero(process.env.LLM_TIMEOUT_MS, 60_000)
  if (nombreProveedor() === "groq") {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) return null
    return new ProveedorGroq({
      apiKey,
      modelo: modeloConfigurado(),
      timeoutMs: Math.max(timeoutMs, 120_000), // incluye las esperas por el límite de tokens por minuto
      maxTokensRespuesta: entero(process.env.MAX_TOKENS_RESPUESTA, 1500),
      tpm: entero(process.env.GROQ_TPM, 8000),
    })
  }
  const maxTokensRespuesta = entero(process.env.MAX_TOKENS_RESPUESTA, 8000)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const esfuerzo = process.env.ANTHROPIC_EFFORT
  return new ProveedorAnthropic({
    apiKey,
    modelo: modeloConfigurado(),
    esfuerzo: esfuerzo === "low" || esfuerzo === "high" ? esfuerzo : "medium",
    timeoutMs,
    maxTokensRespuesta,
  })
}

function iniciar(): void {
  try {
    process.loadEnvFile()
  } catch {
    // Sin .env: se usan las variables del entorno del proceso.
  }
  const puerto = entero(process.env.PORT, 3000)
  const proveedor = proveedorDesdeEntorno()
  const servidor = crearServidor({
    directory: process.cwd(),
    proveedor,
    accessKey: process.env.ACCESS_KEY || undefined,
    maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
    maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 200_000),
    nombreProveedor: nombreProveedor(),
    modeloConfigurado: modeloConfigurado(),
  })
  servidor.listen(puerto, () => {
    console.log(`Agente de contratos en http://localhost:${puerto}`)
    console.log(proveedor ? `Modelo: ${proveedor.nombre}/${proveedor.modelo}` : "⚠ Sin clave del modelo (ANTHROPIC_API_KEY o GROQ_API_KEY): el chat responderá 503 (usa 'npm run demo' para probar las herramientas).")
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) iniciar()
