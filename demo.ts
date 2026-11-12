/**
 * Demo sin modelo: ejecuta las herramientas directamente sobre los 6 mensajes del buzón.
 * No necesita ninguna clave. Uso: npm run demo
 */
import { reiniciarOut } from "./src/core/almacen.js"
import { cargarHerramientas } from "./src/tools/registry.js"

const HOY = "2026-09-03"
const ctx = { directory: process.cwd(), sessionId: "demo" }
const herramientas = new Map(cargarHerramientas().map((h) => [h.nombre, h]))

interface Respuesta {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  requiere_revision?: string[]
}

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Respuesta> {
  const h = herramientas.get(nombre)
  if (!h) throw new Error(`Herramienta desconocida: ${nombre}`)
  return JSON.parse(await h.ejecutar(args, ctx)) as Respuesta
}

function linea(texto = ""): void {
  console.log(texto)
}

async function procesar(id: string): Promise<void> {
  linea(`\n── ${id} ${"─".repeat(60)}`)
  const val = await llamar("contratos_validar", { mensaje_id: id })
  if (!val.ok || !val.data) {
    linea(`  validar → ERROR: ${val.error}`)
    return
  }
  const revision = (val.data.requiere_revision as string[]) ?? []
  const remitente = val.data.remitente as { email: string; conocido: boolean }
  linea(`  clasificación : ${val.data.clasificacion}${val.data.id_contrato_existente ? ` (existente ${val.data.id_contrato_existente})` : ""}`)
  if (val.data.motivo) linea(`  motivo        : ${val.data.motivo}`)
  if (!remitente.conocido) linea(`  remitente     : ${remitente.email} NO está en comerciales.json (se reporta, no bloquea)`)
  linea(`  en revisión   : ${revision.length ? revision.join(" | ") : "—"}`)

  const reg = await llamar("contratos_registrar", { mensaje_id: id, fecha_registro: HOY })
  if (reg.ok && reg.data) {
    linea(`  acción        : ${reg.data.accion} ${reg.data.id_contrato ?? ""} ${reg.data.ruta_archivo ? `→ ${reg.data.ruta_archivo}` : ""}`)
    return
  }
  linea(`  acción        : NO registrado — ${reg.error}`)
  linea(`  ↳ segunda llamada con confirmado: true (el usuario confirmó los campos)`)
  const conf = await llamar("contratos_registrar", { mensaje_id: id, confirmado: true, fecha_registro: HOY })
  linea(conf.ok && conf.data
    ? `  acción        : ${conf.data.accion} ${conf.data.id_contrato} → ${conf.data.ruta_archivo}`
    : `  acción        : ERROR ${conf.error}`)
}

async function main(): Promise<void> {
  reiniciarOut(ctx.directory)
  linea(`DEMO sin modelo · fecha de referencia ${HOY}`)

  const buzon = await llamar("contratos_leer_buzon", {})
  const mensajes = (buzon.data?.mensajes as Array<{ id: string; asunto: string; tiene_contrato: boolean }>) ?? []
  linea(`\nBuzón: ${mensajes.length} mensajes pendientes`)
  for (const m of mensajes) linea(`  ${m.id}  contrato=${m.tiene_contrato ? "sí" : "no"}  ${m.asunto}`)

  for (const m of mensajes) await procesar(m.id)

  const alertas = await llamar("contratos_alertas", { hoy: HOY })
  const d = alertas.data as { vencen: unknown[]; polizas_pendientes: unknown[]; registrados_desde_corte: unknown[] }
  linea(`\n── Alertas ${"─".repeat(56)}`)
  linea(`  vencen ≤ 60 días: ${d.vencen.length} · pólizas pendientes: ${d.polizas_pendientes.length} · registrados desde el corte: ${d.registrados_desde_corte.length}`)
  linea("  Reporte: out/alertas.md")

  const pendientes = await llamar("contratos_leer_buzon", {})
  linea(`\nBuzón tras procesar: ${(pendientes.data as { total: number }).total} pendientes`)
}

main().catch((e: unknown) => {
  console.error("Fallo inesperado:", e instanceof Error ? e.message : e)
  process.exit(1)
})
