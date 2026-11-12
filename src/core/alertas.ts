import { diasEntre } from "./fechas.js"
import type { FilaMaestro } from "./tipos.js"

export const FECHA_CORTE = "2026-05-30"
export const VENTANA_DIAS = 60

export interface AlertaVencimiento {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias_restantes: number
  estado: "vencido" | "por_vencer"
  comercial: string
}

export interface AlertaPoliza {
  id_contrato: string
  cliente: string
  tipo_poliza: string
  estado_poliza: string
  fecha_fin: string
  comercial: string
}

export interface FilaCorte {
  id_contrato: string
  cliente: string
  fecha_registro: string
  fuente: string
}

export interface ResultadoAlertas {
  vencen: AlertaVencimiento[]
  polizas_pendientes: AlertaPoliza[]
  registrados_desde_corte: FilaCorte[]
}

export function calcularAlertas(maestro: FilaMaestro[], hoy: string): ResultadoAlertas {
  const vencen = maestro
    .map((f) => ({ f, dias: diasEntre(hoy, f.fecha_fin) }))
    .filter(({ dias }) => dias <= VENTANA_DIAS)
    .sort((a, b) => a.dias - b.dias)
    .map(({ f, dias }): AlertaVencimiento => ({
      id_contrato: f.id_contrato,
      cliente: f.cliente,
      fecha_fin: f.fecha_fin,
      dias_restantes: dias,
      estado: dias < 0 ? "vencido" : "por_vencer",
      comercial: f.comercial,
    }))

  const polizas_pendientes = maestro
    .filter((f) => f.requiere_poliza && f.estado_poliza !== "vigente")
    .map((f): AlertaPoliza => ({
      id_contrato: f.id_contrato,
      cliente: f.cliente,
      tipo_poliza: f.tipo_poliza,
      estado_poliza: f.estado_poliza,
      fecha_fin: f.fecha_fin,
      comercial: f.comercial,
    }))

  const registrados_desde_corte = maestro
    .filter((f) => f.fecha_registro >= FECHA_CORTE)
    .map((f): FilaCorte => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, fuente: f.fuente }))

  return { vencen, polizas_pendientes, registrados_desde_corte }
}

function tabla(cabeceras: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Sin elementos._\n"
  const sep = cabeceras.map(() => "---").join(" | ")
  const cuerpo = filas.map((f) => `| ${f.join(" | ")} |`).join("\n")
  return `| ${cabeceras.join(" | ")} |\n| ${sep} |\n${cuerpo}\n`
}

export function renderizarAlertas(r: ResultadoAlertas, hoy: string): string {
  const vencidos = r.vencen.filter((v) => v.estado === "vencido").length
  return [
    "# Reporte de alertas de contratos",
    "",
    `Fecha de referencia: **${hoy}** · Ventana de vencimiento: ${VENTANA_DIAS} días · Corte del maestro congelado: ${FECHA_CORTE}`,
    "",
    `## 1. Contratos que vencen en ≤ ${VENTANA_DIAS} días (${r.vencen.length}; ${vencidos} ya vencidos)`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "Días", "Estado", "Comercial"],
      r.vencen.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(v.dias_restantes), v.estado, v.comercial]),
    ),
    `## 2. Pólizas pendientes o vencidas (${r.polizas_pendientes.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de póliza", "Estado póliza", "Fecha fin", "Comercial"],
      r.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza || "—", p.estado_poliza, p.fecha_fin, p.comercial]),
    ),
    `## 3. Registrados desde el corte ${FECHA_CORTE} — gap cubierto (${r.registrados_desde_corte.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha de registro", "Fuente"],
      r.registrados_desde_corte.map((c) => [c.id_contrato, c.cliente, c.fecha_registro, c.fuente]),
    ),
  ].join("\n")
}
