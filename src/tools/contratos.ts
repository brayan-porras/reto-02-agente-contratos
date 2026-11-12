import { z } from "zod"
import {
  agregarLog, buscarContrato, leerComerciales, leerCorreo, leerMaestro, leerProcesados, listarIdsBuzon, rutas,
  asegurarSharepoint,
} from "../core/almacen.js"
import { calcularAlertas, renderizarAlertas } from "../core/alertas.js"
import { extraerContrato } from "../core/extraccion.js"
import { esFechaIso } from "../core/fechas.js"
import { analizarMensaje, extraerDeMensaje, registrarMensaje, RevisionPendiente } from "../core/registro.js"
import { resolverRemitente } from "../core/validacion.js"
import { ContratoSchema, type Contrato } from "../core/tipos.js"
import { mkdirSync, writeFileSync } from "node:fs"

/**
 * Cada export de este archivo es una herramienta del agente (`contratos_<export>`).
 * Contrato: { description, args (zod), execute(args, ctx) → string JSON }. execute NUNCA lanza.
 * Los helpers viven en src/core/: aquí solo se exportan herramientas.
 */

export interface ContextoHerramienta {
  directory: string
  sessionId: string
}

interface Exito {
  data: unknown
  resumen: string
}

class FalloControlado extends Error {
  constructor(mensaje: string, public readonly extra: Record<string, unknown> = {}) {
    super(mensaje)
  }
}

/** Envuelve la lógica: captura errores, escribe out/log.jsonl (RN7) y serializa { ok, data | error }. */
async function ejecutar(
  herramienta: string,
  ctx: ContextoHerramienta,
  mensajeId: string | null,
  logica: () => Exito,
): Promise<string> {
  let ok = true
  let resumen = ""
  let salida: Record<string, unknown>
  try {
    const r = logica()
    resumen = r.resumen
    salida = { ok: true, data: r.data }
  } catch (e) {
    ok = false
    resumen = e instanceof Error ? e.message : String(e)
    salida = { ok: false, error: resumen, ...(e instanceof FalloControlado ? e.extra : {}) }
  }
  try {
    agregarLog(ctx.directory, { herramienta, mensaje_id: mensajeId, ok, resumen })
  } catch {
    // El log nunca debe tumbar la herramienta.
  }
  return JSON.stringify(salida)
}

const mensajeId = z.string().min(1).describe('Identificador del mensaje del buzón, por ejemplo "msg-001"')
// Esquema liviano para el modelo (ahorra tokens); la forma exacta se valida con ContratoSchema dentro de la herramienta.
const contratoOpcional = z.record(z.string(), z.unknown()).optional().describe(
  "OPCIONAL. Solo los campos del contrato que el usuario corrigió (por ejemplo {\"valor\":0,\"fecha_fin\":\"2027-08-31\"}); se combinan con la extracción del mensaje. Normalmente se omite.",
)

/** Combina las correcciones parciales con la extracción del mensaje y valida el resultado completo. */
function leerContrato(directory: string, mensajeId: string, crudo: Record<string, unknown> | undefined): Contrato | undefined {
  if (crudo === undefined) return undefined
  const base = extraerDeMensaje(directory, mensajeId)
  const confianza = typeof crudo.confianza === "object" && crudo.confianza !== null ? (crudo.confianza as Record<string, unknown>) : {}
  const candidato = base ? { ...base, ...crudo, confianza: { ...base.confianza, ...confianza } } : crudo
  const r = ContratoSchema.safeParse(candidato)
  if (r.success) return r.data
  const detalle = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  throw new FalloControlado(`El argumento contrato no es válido (${detalle}). Envía solo campos corregidos con su tipo correcto, o omítelo.`)
}

export const leer_buzon = {
  description: "Lista los mensajes del buzón que aún no se han procesado, indicando si traen un contrato adjunto.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar("contratos_leer_buzon", ctx, null, () => {
      const procesados = leerProcesados(ctx.directory)
      const pendientes = listarIdsBuzon(ctx.directory).filter((id) => !procesados[id])
      const comerciales = leerComerciales(ctx.directory)
      const mensajes = pendientes.map((id) => {
        const correo = leerCorreo(ctx.directory, id)
        const { contrato, motivo } = buscarContrato(ctx.directory, correo)
        const remitente = resolverRemitente(correo.de, comerciales)
        return {
          id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos: correo.adjuntos,
          tiene_contrato: contrato !== null,
          ...(contrato ? { adjunto_contrato: contrato.nombre } : { clasificacion: "rechazado", motivo }),
          remitente_conocido: remitente.conocido,
        }
      })
      return {
        data: { total: mensajes.length, ids: mensajes.map((m) => m.id), ya_procesados: Object.keys(procesados).length, mensajes },
        resumen: `${mensajes.length} mensajes pendientes`,
      }
    })
  },
}

export const extraer = {
  description:
    "Extrae del adjunto del mensaje los datos estructurados del contrato (partes, valor, plazo, póliza) con confianza por campo.",
  args: { mensaje_id: mensajeId },
  async execute(args: { mensaje_id: string }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar("contratos_extraer", ctx, args.mensaje_id, () => {
      const correo = leerCorreo(ctx.directory, args.mensaje_id)
      const { contrato: adjunto, motivo } = buscarContrato(ctx.directory, correo)
      if (!adjunto) throw new FalloControlado(`El mensaje no trae contrato: ${motivo}`, { clasificacion: "rechazado" })
      const contrato = extraerContrato(adjunto.texto)
      const dudosos = Object.entries(contrato.confianza).filter(([, c]) => c > 0 && c < 0.8).map(([k]) => k)
      return {
        data: { ...contrato, adjunto: adjunto.nombre },
        resumen: `${contrato.id_contrato ?? "sin id"} · ${contrato.cliente ?? "?"} · dudosos: ${dudosos.join(",") || "ninguno"}`,
      }
    })
  },
}

export const validar = {
  description:
    "Clasifica el mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: mensajeId, contrato: contratoOpcional },
  async execute(args: { mensaje_id: string; contrato?: Record<string, unknown> }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar("contratos_validar", ctx, args.mensaje_id, () => {
      const { validacion } = analizarMensaje(ctx.directory, args.mensaje_id, leerContrato(ctx.directory, args.mensaje_id, args.contrato))
      return {
        data: validacion,
        resumen: `${validacion.clasificacion}${validacion.id_contrato_existente ? ` (${validacion.id_contrato_existente})` : ""} · revisión: ${validacion.requiere_revision.length}`,
      }
    })
  },
}

export const registrar = {
  description:
    "Registra el contrato en el maestro y lo archiva; si hay campos en revisión solo escribe con confirmado=true tras la confirmación explícita del usuario.",
  args: {
    mensaje_id: mensajeId,
    contrato: contratoOpcional,
    confirmado: z.boolean().optional().describe("true SOLO si el usuario confirmó explícitamente los campos en revisión"),
    fecha_registro: z.string().optional().describe("YYYY-MM-DD; por defecto la fecha del sistema. Usar la fecha 'hoy' que dio el usuario."),
  },
  async execute(
    args: { mensaje_id: string; contrato?: Record<string, unknown>; confirmado?: boolean; fecha_registro?: string },
    ctx: ContextoHerramienta,
  ): Promise<string> {
    return ejecutar("contratos_registrar", ctx, args.mensaje_id, () => {
      if (args.fecha_registro !== undefined && !esFechaIso(args.fecha_registro)) {
        throw new FalloControlado(`fecha_registro inválida: "${args.fecha_registro}" (use YYYY-MM-DD)`)
      }
      try {
        const r = registrarMensaje(ctx.directory, args.mensaje_id, {
          confirmado: args.confirmado === true,
          fechaRegistro: args.fecha_registro,
          contrato: leerContrato(ctx.directory, args.mensaje_id, args.contrato),
        })
        return { data: r, resumen: `${r.accion} ${r.id_contrato ?? ""}${args.confirmado ? " (confirmado)" : ""}`.trim() }
      } catch (e) {
        if (e instanceof RevisionPendiente) throw new FalloControlado(e.message, { requiere_revision: e.campos })
        throw e
      }
    })
  },
}

export const alertas = {
  description:
    "Genera out/alertas.md con contratos que vencen en 60 días o menos, pólizas pendientes y contratos registrados desde el corte del 2026-05-30.",
  args: { hoy: z.string().describe("Fecha de referencia YYYY-MM-DD (ej. 2026-09-03)") },
  async execute(args: { hoy: string }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar("contratos_alertas", ctx, null, () => {
      if (!esFechaIso(args.hoy)) throw new FalloControlado(`Fecha inválida: "${args.hoy}". Use YYYY-MM-DD`)
      asegurarSharepoint(ctx.directory)
      const resultado = calcularAlertas(leerMaestro(ctx.directory), args.hoy)
      const r = rutas(ctx.directory)
      mkdirSync(r.out, { recursive: true })
      writeFileSync(r.alertas, renderizarAlertas(resultado, args.hoy), "utf8")
      return {
        data: { ruta: "out/alertas.md", ...resultado },
        resumen: `vencen ${resultado.vencen.length} · pólizas ${resultado.polizas_pendientes.length} · desde corte ${resultado.registrados_desde_corte.length}`,
      }
    })
  },
}

