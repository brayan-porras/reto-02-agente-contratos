import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { ejecutarTurno, nuevaSesion } from "../src/agent/ciclo.js"
import { parseMonto } from "../src/core/numeros.js"
import type { MensajeLLM, ProveedorLLM, RespuestaLLM } from "../src/llm/adapter.js"
import { crearServidor } from "../src/server.js"
import { cargarHerramientas } from "../src/tools/registry.js"

const RAIZ = process.cwd()
let dir = ""
const herramientas = new Map(cargarHerramientas().map((h) => [h.nombre, h]))

interface Resp {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  requiere_revision?: string[]
}

async function llamar(nombre: string, args: Record<string, unknown> = {}): Promise<Resp> {
  const h = herramientas.get(nombre)
  assert.ok(h, `herramienta ${nombre}`)
  return JSON.parse(await h.ejecutar(args, { directory: dir, sessionId: "test" })) as Resp
}

function nuevoEntorno(): string {
  const d = mkdtempSync(join(tmpdir(), "reto02-"))
  cpSync(join(RAIZ, "fixtures"), join(d, "fixtures"), { recursive: true })
  cpSync(join(RAIZ, "agent"), join(d, "agent"), { recursive: true })
  cpSync(join(RAIZ, "web"), join(d, "web"), { recursive: true })
  cpSync(join(RAIZ, "src", "knowledge"), join(d, "src", "knowledge"), { recursive: true })
  return d
}

function agregarMensaje(id: string, adjunto: string, texto: string): void {
  const carpeta = join(dir, "fixtures", "reto-02", "buzon", id)
  mkdirSync(carpeta, { recursive: true })
  writeFileSync(join(carpeta, "correo.json"), JSON.stringify({
    id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com",
    asunto: `Prueba ${id}`, fecha: "2026-09-01T10:00:00-05:00", cuerpo: "", adjuntos: [adjunto],
  }))
  writeFileSync(join(carpeta, adjunto), texto)
}

before(() => { dir = nuevoEntorno() })
after(() => rmSync(dir, { recursive: true, force: true }))

describe("herramientas sobre el buzón de referencia (RN1–RN7)", () => {
  it("lista 6 mensajes y marca la cotización sin contrato", async () => {
    const r = await llamar("contratos_leer_buzon")
    const mensajes = r.data?.mensajes as Array<{ id: string; tiene_contrato: boolean; clasificacion?: string }>
    assert.equal(mensajes.length, 6)
    const m5 = mensajes.find((m) => m.id === "msg-005")
    assert.equal(m5?.tiene_contrato, false)
    assert.equal(m5?.clasificacion, "rechazado")
  })

  it("msg-001 y msg-002 son nuevos y se registran; póliza pendiente / no_aplica", async () => {
    for (const id of ["msg-001", "msg-002"]) {
      const v = await llamar("contratos_validar", { mensaje_id: id })
      assert.equal(v.data?.clasificacion, "nuevo")
      assert.deepEqual(v.data?.requiere_revision, [])
      const r = await llamar("contratos_registrar", { mensaje_id: id, fecha_registro: "2026-09-03" })
      assert.equal(r.data?.accion, "insertado")
    }
    const csv = readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8")
    assert.match(csv, /CT-2026-015,.*,true,cumplimiento,pendiente,/)
    assert.match(csv, /CT-2026-016,.*,false,,no_aplica,/)
  })

  it("msg-003 es actualización: modifica la fila y deja historial", async () => {
    const v = await llamar("contratos_validar", { mensaje_id: "msg-003" })
    assert.equal(v.data?.clasificacion, "actualizacion")
    assert.equal(v.data?.id_contrato_existente, "CT-2026-011")
    const r = await llamar("contratos_registrar", { mensaje_id: "msg-003", fecha_registro: "2026-09-03" })
    assert.equal(r.data?.accion, "actualizado")
    const csv = readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8")
    assert.match(csv, /CT-2026-011,.*,520000,PEN,2026-05-02,2027-11-01,/)
    const historial = readFileSync(join(dir, "out", "sharepoint", "historial.jsonl"), "utf8")
    assert.match(historial, /"id_contrato":"CT-2026-011".*"accion":"actualizado".*"mensaje_id":"msg-003"/)
  })

  it("msg-004 es duplicado y no escribe nada", async () => {
    const antes = readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8")
    const r = await llamar("contratos_registrar", { mensaje_id: "msg-004" })
    assert.equal(r.data?.accion, "duplicado")
    assert.equal(readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8"), antes)
  })

  it("msg-005 se rechaza con motivo", async () => {
    const v = await llamar("contratos_validar", { mensaje_id: "msg-005" })
    assert.equal(v.data?.clasificacion, "rechazado")
    assert.match(String(v.data?.motivo), /cotización/)
    const r = await llamar("contratos_registrar", { mensaje_id: "msg-005" })
    assert.equal(r.data?.accion, "rechazado")
  })

  it("msg-006 exige revisión (valor, fecha_fin), no se registra sin confirmar y sí con confirmado=true", async () => {
    const v = await llamar("contratos_validar", { mensaje_id: "msg-006" })
    const revision = (v.data?.requiere_revision as string[]).join("|")
    assert.match(revision, /valor/)
    assert.match(revision, /fecha_fin/)
    assert.equal((v.data?.remitente as { conocido: boolean }).conocido, false)

    const sin = await llamar("contratos_registrar", { mensaje_id: "msg-006" })
    assert.equal(sin.ok, false)
    assert.match(String(sin.error), /^requiere revisión/)
    assert.ok(!readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8").includes("CM-2026-03"))

    const con = await llamar("contratos_registrar", { mensaje_id: "msg-006", confirmado: true, fecha_registro: "2026-09-03" })
    assert.equal(con.data?.accion, "insertado")
    assert.ok(existsSync(join(dir, "out", "sharepoint", "Contratos", "2026", "distribuidora-caribe", "CM-2026-03.txt")))
  })

  it("el buzón queda vacío y el fixture del maestro no se modificó", async () => {
    const r = await llamar("contratos_leer_buzon")
    assert.equal((r.data?.mensajes as unknown[]).length, 0)
    const original = readFileSync(join(RAIZ, "fixtures", "reto-02", "maestro-contratos.csv"), "utf8")
    assert.equal(readFileSync(join(dir, "fixtures", "reto-02", "maestro-contratos.csv"), "utf8"), original)
  })

  it("alertas: vencen ≤ 60 días, pólizas pendientes y registrados desde el corte", async () => {
    const r = await llamar("contratos_alertas", { hoy: "2026-09-03" })
    const d = r.data as { vencen: Array<{ id_contrato: string }>; polizas_pendientes: Array<{ id_contrato: string }>; registrados_desde_corte: unknown[] }
    assert.deepEqual(d.vencen.map((v) => v.id_contrato), ["CT-2025-018", "CT-2026-002", "CT-2026-009", "CT-2026-004"])
    assert.deepEqual(d.polizas_pendientes.map((p) => p.id_contrato).sort(), ["CT-2026-004", "CT-2026-011", "CT-2026-015"])
    assert.equal(d.registrados_desde_corte.length, 3)
    assert.ok(existsSync(join(dir, "out", "alertas.md")))
  })

  it("registra cada llamada en out/log.jsonl (RN7)", () => {
    const lineas = readFileSync(join(dir, "out", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.ok(lineas.length > 10)
    for (const l of lineas) assert.deepEqual(Object.keys(l).sort(), ["herramienta", "mensaje_id", "ok", "resumen", "ts"])
  })
})

describe("manejo de errores (HU-6)", () => {
  it("texto vacío, fecha inválida y moneda desconocida devuelven ok:false sin lanzar", async () => {
    agregarMensaje("err-vacio", "contrato.txt", "   ")
    agregarMensaje("err-fecha", "contrato.txt",
      "CONTRATO No. CT-2026-099\n\nEntre ACME S.A.S., NIT 800.111.222-3, domicilio en Bogotá (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7.\n\nPRIMERA. OBJETO. Soporte.\n\nSEGUNDA. VALOR. Es de (COP $1.000.000).\n\nTERCERA. PLAZO. Desde el treinta y uno (31) de febrero de 2026 hasta el primero (1) de marzo de 2027.")
    agregarMensaje("err-moneda", "contrato.txt",
      "CONTRATO No. CT-2026-098\n\nEntre ACME S.A.S., NIT 800.111.222-3, domicilio en Bogotá (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7.\n\nPRIMERA. OBJETO. Soporte.\n\nSEGUNDA. VALOR. Es de (EUR 5.000).\n\nTERCERA. PLAZO. Desde el uno (1) de enero de 2026 hasta el treinta y uno (31) de diciembre de 2026.")
    for (const [id, patron] of [["err-vacio", /vacío/], ["err-fecha", /Fecha inválida/], ["err-moneda", /Moneda desconocida/]] as const) {
      const r = await llamar("contratos_extraer", { mensaje_id: id })
      assert.equal(r.ok, false, id)
      assert.match(String(r.error), patron)
    }
  })

  it("argumentos inválidos y mensajes inexistentes devuelven error legible", async () => {
    const a = await llamar("contratos_alertas", { hoy: "03/09/2026" })
    assert.equal(a.ok, false)
    const b = await llamar("contratos_extraer", { mensaje_id: "../../etc/passwd" })
    assert.equal(b.ok, false)
    const c = await llamar("contratos_extraer", {})
    assert.equal(c.ok, false)
    assert.match(String(c.error), /Argumentos inválidos/)
  })

  it("parseMonto interpreta separadores de miles y decimales", () => {
    assert.equal(parseMonto("265.000.000"), 265000000)
    assert.equal(parseMonto("120,000.00"), 120000)
    assert.equal(parseMonto("60.000"), 60000)
    assert.equal(parseMonto("1.234,56"), 1234.56)
  })
})

/** Proveedor simulado: reproduce un guion de respuestas para probar el ciclo sin modelo real. */
class ProveedorGuionado implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "simulado"
  llamadas = 0
  constructor(private readonly guion: RespuestaLLM[]) {}
  async enviar(_m: MensajeLLM[]): Promise<RespuestaLLM> {
    const r = this.guion[this.llamadas++]
    if (!r) throw new Error("guion agotado")
    return r
  }
}

const herramientaLLM = (id: string, nombre: string, args: unknown): RespuestaLLM => ({
  mensaje: { rol: "assistant", contenido: [{ tipo: "herramienta", id, nombre, args }] },
  fin: "herramientas", uso: { entrada: 10, salida: 5 },
})
const textoLLM = (texto: string): RespuestaLLM => ({
  mensaje: { rol: "assistant", contenido: [{ tipo: "texto", texto }] }, fin: "fin", uso: { entrada: 10, salida: 5 },
})

describe("correcciones parciales del usuario", () => {
  it("registrar acepta solo los campos corregidos y los combina con la extracción", async () => {
    dir = nuevoEntorno()
    const r = await llamar("contratos_registrar", {
      mensaje_id: "msg-006", confirmado: true, fecha_registro: "2026-09-03",
      contrato: { valor: 0, fecha_fin: "2027-08-30" },
    })
    assert.equal(r.ok, true, String(r.error))
    const csv = readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8")
    assert.match(csv, /CM-2026-03,Distribuidora Caribe S\.A\.S\.,800222333,CO,.*,0,COP,2026-08-31,2027-08-30,/)
    const mala = await llamar("contratos_validar", { mensaje_id: "msg-001", contrato: { valor: "no-es-numero" } })
    assert.equal(mala.ok, false)
    assert.match(String(mala.error), /no es válido/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("ciclo del agente", () => {
  const dep = (proveedor: ProveedorLLM, maxIteraciones = 25) => ({
    proveedor, herramientas: [...herramientas.values()], sistema: "sistema", directory: dir, maxIteraciones, maxTokensSesion: 100000,
  })

  it("bloquea confirmado=true sin pregunta previa y exige confirmación después", async () => {
    dir = nuevoEntorno()
    const sesion = nuevaSesion("sesion-prueba-1")
    // Turno 1: el modelo intenta saltarse la confirmación.
    const p1 = new ProveedorGuionado([
      herramientaLLM("t1", "contratos_registrar", { mensaje_id: "msg-006", confirmado: true }),
      textoLLM("No pude registrar."),
    ])
    const t1 = await ejecutarTurno(dep(p1), sesion, "procesa msg-006")
    assert.equal(t1.toolCalls[0]?.ok, false)
    assert.match(t1.toolCalls[0]?.resultado ?? "", /solo se acepta después de preguntar/)
    assert.ok(!existsSync(join(dir, "out", "sharepoint", "Contratos")))

    // Turno 2: valida (queda pendiente) y pregunta.
    const p2 = new ProveedorGuionado([
      herramientaLLM("t2", "contratos_validar", { mensaje_id: "msg-006" }),
      textoLLM("¿Confirmas valor 0 y fecha_fin 2027-08-31?"),
    ])
    const t2 = await ejecutarTurno(dep(p2), sesion, "valida msg-006")
    assert.equal(t2.needsConfirmation, true)
    assert.deepEqual(t2.pendientes, ["msg-006"])

    // Turno 3: el usuario confirma → ahora sí se admite confirmado=true.
    const p3 = new ProveedorGuionado([
      herramientaLLM("t3", "contratos_registrar", { mensaje_id: "msg-006", confirmado: true, fecha_registro: "2026-09-03" }),
      textoLLM("Registrado."),
    ])
    const t3 = await ejecutarTurno(dep(p3), sesion, "confirmo el valor 0 y la fecha fin 2027-08-31")
    assert.equal(t3.toolCalls[0]?.ok, true)
    assert.equal(t3.needsConfirmation, false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("respeta el tope de iteraciones y responde con lo que tiene", async () => {
    dir = nuevoEntorno()
    const sesion = nuevaSesion("sesion-prueba-2")
    const infinito = Array.from({ length: 10 }, (_, i) => herramientaLLM(`x${i}`, "contratos_leer_buzon", {}))
    const p = new ProveedorGuionado([...infinito.slice(0, 3), textoLLM("Hasta aquí llegué: faltan mensajes.")])
    const t = await ejecutarTurno(dep(p, 3), sesion, "procesa todo")
    assert.equal(t.toolCalls.length, 3)
    assert.match(t.reply, /faltan mensajes/)
    rmSync(dir, { recursive: true, force: true })
  })

  it("un error del proveedor se convierte en mensaje claro y la sesión sigue viva", async () => {
    dir = nuevoEntorno()
    const sesion = nuevaSesion("sesion-prueba-3")
    const t = await ejecutarTurno(dep(new ProveedorGuionado([])), sesion, "hola")
    assert.match(t.reply, /error inesperado/i)
    const ok = await ejecutarTurno(dep(new ProveedorGuionado([textoLLM("Hola")])), sesion, "hola otra vez")
    assert.equal(ok.reply, "Hola")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("API HTTP", () => {
  it("health no expone claves, chat valida entrada y exige clave de acceso", async () => {
    dir = nuevoEntorno()
    const proveedor = new ProveedorGuionado([textoLLM("Hola desde el modelo simulado")])
    const servidor = crearServidor({ directory: dir, proveedor, accessKey: "secreta", maxIteraciones: 5, maxTokensSesion: 1000 })
    await new Promise<void>((ok) => servidor.listen(0, ok))
    const puerto = (servidor.address() as { port: number }).port
    const base = `http://127.0.0.1:${puerto}`
    try {
      const salud = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>
      assert.deepEqual(Object.keys(salud).sort(), ["accessKeyRequired", "configured", "model", "ok", "provider"])

      const sinClave = await fetch(`${base}/api/chat`, { method: "POST", body: "{}" })
      assert.equal(sinClave.status, 401)

      const h = { "content-type": "application/json", "x-access-key": "secreta" }
      const mala = await fetch(`${base}/api/chat`, { method: "POST", headers: h, body: JSON.stringify({ sessionId: "x", message: "hola" }) })
      assert.equal(mala.status, 400)

      const buena = await fetch(`${base}/api/chat`, { method: "POST", headers: h, body: JSON.stringify({ sessionId: "sesion-http-1", message: "hola" }) })
      assert.equal(buena.status, 200)
      const cuerpo = await buena.json() as { reply: string; toolCalls: unknown[]; needsConfirmation: boolean }
      assert.equal(cuerpo.reply, "Hola desde el modelo simulado")
      assert.equal(cuerpo.needsConfirmation, false)

      const historial = await (await fetch(`${base}/api/sessions/sesion-http-1`, { headers: h })).json() as { historial: unknown[] }
      assert.equal(historial.historial.length, 2)

      const index = await fetch(`${base}/`)
      assert.equal(index.status, 200)
    } finally {
      servidor.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
