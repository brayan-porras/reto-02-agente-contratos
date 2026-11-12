import { dirname } from "node:path"
import {
  agregarHistorial, archivar, asegurarSharepoint, buscarContrato, escribirMaestro, extensionDe, leerComerciales,
  leerCorreo, leerMaestro, leerProcesados, marcarProcesado,
} from "./almacen.js"
import { extraerContrato } from "./extraccion.js"
import { hoyIso } from "./fechas.js"
import { slugCliente } from "./numeros.js"
import type { Cambios, Contrato, FilaMaestro } from "./tipos.js"
import { resolverRemitente, validarContrato, type ResultadoValidacion } from "./validacion.js"

export interface Analisis {
  contrato: Contrato | null
  validacion: ResultadoValidacion
  adjunto: { nombre: string; rutaAbsoluta: string } | null
}

/** Lee el mensaje, extrae (o usa el contrato entregado) y valida contra el maestro. */
export function analizarMensaje(directory: string, mensajeId: string, contratoDado?: Contrato): Analisis {
  const correo = leerCorreo(directory, mensajeId)
  const { contrato: adjunto, motivo } = buscarContrato(directory, correo)
  const remitente = resolverRemitente(correo.de, leerComerciales(directory))
  const contrato = adjunto ? (contratoDado ?? extraerContrato(adjunto.texto)) : null
  const validacion = validarContrato(contrato, motivo, leerMaestro(directory), remitente)
  return { contrato, validacion, adjunto: adjunto ? { nombre: adjunto.nombre, rutaAbsoluta: adjunto.rutaAbsoluta } : null }
}

/** Extracción del contrato del mensaje (null si el mensaje no trae contrato). */
export function extraerDeMensaje(directory: string, mensajeId: string): Contrato | null {
  const { contrato } = buscarContrato(directory, leerCorreo(directory, mensajeId))
  return contrato ? extraerContrato(contrato.texto) : null
}

export class RevisionPendiente extends Error {
  constructor(public readonly campos: string[]) {
    super(`requiere revisión: ${campos.join("; ")}`)
  }
}

export interface ResultadoRegistro {
  id_contrato: string | null
  accion: "insertado" | "actualizado" | "duplicado" | "rechazado"
  ruta_archivo: string | null
  cambios?: Cambios
  motivo?: string
}

export interface OpcionesRegistro {
  confirmado: boolean
  fechaRegistro?: string
  contrato?: Contrato
}

/** HU-4: única función que escribe en el maestro, el archivo, el historial y procesados. */
export function registrarMensaje(directory: string, mensajeId: string, op: OpcionesRegistro): ResultadoRegistro {
  asegurarSharepoint(directory)
  if (leerProcesados(directory)[mensajeId]) throw new Error(`El mensaje ${mensajeId} ya fue procesado`)
  const { contrato, validacion, adjunto } = analizarMensaje(directory, mensajeId, op.contrato)
  const { clasificacion } = validacion

  if (clasificacion === "rechazado") {
    marcarProcesado(directory, mensajeId, { accion: "rechazado", id_contrato: null, motivo: validacion.motivo })
    return { id_contrato: null, accion: "rechazado", ruta_archivo: null, motivo: validacion.motivo }
  }
  if (!contrato || !adjunto) throw new Error("Estado inconsistente: clasificado sin contrato")

  const maestro = leerMaestro(directory)
  if (clasificacion === "duplicado") {
    const existente = maestro.find((f) => f.id_contrato === validacion.id_contrato_existente)
    marcarProcesado(directory, mensajeId, { accion: "duplicado", id_contrato: existente?.id_contrato ?? null })
    return { id_contrato: existente?.id_contrato ?? null, accion: "duplicado", ruta_archivo: existente?.ruta_sharepoint ?? null, motivo: validacion.motivo }
  }
  if (validacion.requiere_revision.length > 0 && !op.confirmado) throw new RevisionPendiente(validacion.requiere_revision)

  const fechaRegistro = op.fechaRegistro ?? hoyIso()
  const comercial = validacion.remitente.comercial ?? "Sin asignar"
  const resultado =
    clasificacion === "nuevo"
      ? insertar(directory, maestro, contrato, adjunto, comercial, fechaRegistro)
      : actualizar(directory, maestro, contrato, validacion, adjunto)

  agregarHistorial(directory, {
    id_contrato: resultado.id_contrato ?? "",
    accion: resultado.accion,
    cambios: resultado.cambios ?? {},
    mensaje_id: mensajeId,
  })
  marcarProcesado(directory, mensajeId, { accion: resultado.accion, id_contrato: resultado.id_contrato })
  return resultado
}

type Adjunto = { nombre: string; rutaAbsoluta: string }

function insertar(
  directory: string, maestro: FilaMaestro[], c: Contrato, adjunto: Adjunto, comercial: string, fechaRegistro: string,
): ResultadoRegistro {
  const faltantes = camposFaltantes(c)
  if (faltantes.length > 0) {
    throw new Error(`Faltan campos obligatorios que ni siquiera una confirmación puede suplir: ${faltantes.join(", ")}`)
  }
  const inicio = c.fecha_inicio as string
  const id = c.id_contrato ?? siguienteIdAuto(maestro, inicio.slice(0, 4))
  const ruta = `Contratos/${inicio.slice(0, 4)}/${slugCliente(c.cliente as string)}/${id}${extensionDe(adjunto.nombre)}`
  const requierePoliza = c.requiere_poliza as boolean
  const fila: FilaMaestro = {
    id_contrato: id,
    cliente: c.cliente as string,
    nit_cliente: c.nit_cliente as string,
    pais: c.pais as FilaMaestro["pais"],
    objeto: c.objeto as string,
    valor: c.valor as number,
    moneda: c.moneda as FilaMaestro["moneda"],
    fecha_inicio: inicio,
    fecha_fin: c.fecha_fin as string,
    requiere_poliza: requierePoliza,
    tipo_poliza: requierePoliza ? (c.tipo_poliza ?? "") : "",
    estado_poliza: requierePoliza ? "pendiente" : "no_aplica",
    comercial,
    ruta_sharepoint: ruta,
    fecha_registro: fechaRegistro,
    fuente: "buzon",
  }
  archivar(directory, adjunto.rutaAbsoluta, ruta)
  escribirMaestro(directory, [...maestro, fila])
  return { id_contrato: id, accion: "insertado", ruta_archivo: ruta }
}

function camposFaltantes(c: Contrato): string[] {
  const obligatorios: Array<keyof Contrato> = [
    "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza",
  ]
  return obligatorios.filter((k) => c[k] === null || c[k] === undefined)
}

function siguienteIdAuto(maestro: FilaMaestro[], anio: string): string {
  const usados = maestro.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}-`)).length
  return `AUTO-${anio}-${String(usados + 1).padStart(3, "0")}`
}

function actualizar(
  directory: string, maestro: FilaMaestro[], c: Contrato, v: ResultadoValidacion, adjunto: Adjunto,
): ResultadoRegistro {
  const indice = maestro.findIndex((f) => f.id_contrato === v.id_contrato_existente)
  const actual = maestro[indice]
  if (!actual) throw new Error(`No se encontró en el maestro el contrato ${v.id_contrato_existente}`)
  const cambios: Cambios = { ...(v.diferencias ?? {}) }
  const nueva: FilaMaestro = { ...actual }
  for (const [campo, cambio] of Object.entries(cambios)) {
    Object.assign(nueva, { [campo]: cambio.despues })
  }
  // Un otrosí que amplía plazo/valor obliga a ampliar la póliza: queda pendiente hasta que llegue la nueva.
  if (c.amplia_poliza && actual.requiere_poliza && actual.estado_poliza !== "pendiente") {
    cambios.estado_poliza = { antes: actual.estado_poliza, despues: "pendiente" }
    nueva.estado_poliza = "pendiente"
  }
  const carpeta = dirname(actual.ruta_sharepoint)
  const destino = `${carpeta}/${actual.id_contrato}-otrosi-${numeroOtrosi(directory, actual.id_contrato)}${extensionDe(adjunto.nombre)}`
  archivar(directory, adjunto.rutaAbsoluta, destino)
  cambios.documento_archivado = { antes: null, despues: destino }
  const copia = [...maestro]
  copia[indice] = nueva
  escribirMaestro(directory, copia)
  return { id_contrato: actual.id_contrato, accion: "actualizado", ruta_archivo: destino, cambios }
}

/** Numera los otrosíes archivados leyendo los ya procesados como actualización del mismo contrato. */
function numeroOtrosi(directory: string, idContrato: string): number {
  const previos = Object.values(leerProcesados(directory)).filter((p) => p.id_contrato === idContrato && p.accion === "actualizado")
  return previos.length + 1
}
