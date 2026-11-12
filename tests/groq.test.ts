import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, it } from "node:test"
import { ErrorProveedor, type MensajeLLM } from "../src/llm/adapter.js"
import { duracionAMs, ProveedorGroq } from "../src/llm/groq.js"

interface Peticion {
  auth: string | undefined
  cuerpo: { model: string; tool_choice: string; messages: Array<Record<string, unknown>>; tools: unknown[] }
}

/** Servidor que imita /chat/completions de Groq: responde lo que se le programe, en orden. */
async function conServidor(
  respuestas: Array<{ estado: number; cuerpo: unknown }>,
  prueba: (proveedor: ProveedorGroq, peticiones: Peticion[]) => Promise<void>,
): Promise<void> {
  const peticiones: Peticion[] = []
  const servidor = createServer((req, res) => {
    const trozos: Buffer[] = []
    req.on("data", (t: Buffer) => trozos.push(t))
    req.on("end", () => {
      peticiones.push({ auth: req.headers.authorization, cuerpo: JSON.parse(Buffer.concat(trozos).toString("utf8")) as Peticion["cuerpo"] })
      const r = respuestas[peticiones.length - 1] ?? { estado: 500, cuerpo: {} }
      res.writeHead(r.estado, { "content-type": "application/json", "retry-after": "0" })
      res.end(JSON.stringify(r.cuerpo))
    })
  })
  await new Promise<void>((ok) => servidor.listen(0, ok))
  const puerto = (servidor.address() as { port: number }).port
  try {
    const proveedor = new ProveedorGroq({ apiKey: "clave-de-prueba", modelo: "m", timeoutMs: 5000, maxTokensRespuesta: 100, baseUrl: `http://127.0.0.1:${puerto}`, esperaMinimaMs: 0, reintentos: 2 })
    await prueba(proveedor, peticiones)
  } finally {
    servidor.close()
  }
}

const sistema: MensajeLLM = { rol: "system", contenido: [{ tipo: "texto", texto: "eres un agente" }] }
const herramienta = { nombre: "contratos_leer_buzon", descripcion: "lista", esquema: { type: "object", properties: {} } }

describe("adaptador Groq", () => {
  it("traduce llamadas a herramientas y resultados en ambos sentidos", async () => {
    await conServidor(
      [
        { estado: 200, cuerpo: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "contratos_leer_buzon", arguments: "{}" } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10 } } },
        { estado: 200, cuerpo: { choices: [{ finish_reason: "stop", message: { content: "Listo" } }], usage: { prompt_tokens: 150, completion_tokens: 5 } } },
      ],
      async (p, peticiones) => {
        const usuario: MensajeLLM = { rol: "user", contenido: [{ tipo: "texto", texto: "procesa" }] }
        const r1 = await p.enviar([sistema, usuario], [herramienta])
        assert.equal(r1.fin, "herramientas")
        assert.deepEqual(r1.mensaje.contenido, [{ tipo: "herramienta", id: "c1", nombre: "contratos_leer_buzon", args: {} }])
        assert.deepEqual(r1.uso, { entrada: 100, salida: 10 })

        const resultado: MensajeLLM = { rol: "user", contenido: [{ tipo: "resultado", id: "c1", contenido: '{"ok":true}' }] }
        const r2 = await p.enviar([sistema, usuario, r1.mensaje, resultado], [herramienta], { sinHerramientas: true })
        assert.equal(r2.fin, "fin")

        assert.equal(peticiones[0]?.auth, "Bearer clave-de-prueba")
        assert.equal(peticiones[0]?.cuerpo.tool_choice, "auto")
        assert.equal(peticiones[1]?.cuerpo.tool_choice, "none")
        const roles = peticiones[1]?.cuerpo.messages.map((m) => m.role)
        assert.deepEqual(roles, ["system", "user", "assistant", "tool"])
        assert.equal(peticiones[1]?.cuerpo.messages[3]?.tool_call_id, "c1")
      },
    )
  })

  it("argumentos que no son JSON no rompen: se pasan vacíos para que zod responda el error", async () => {
    await conServidor(
      [{ estado: 200, cuerpo: { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c9", type: "function", function: { name: "x", arguments: "{no-json" } }] } }] } }],
      async (p) => {
        const r = await p.enviar([sistema], [herramienta])
        assert.deepEqual(r.mensaje.contenido[0], { tipo: "herramienta", id: "c9", nombre: "x", args: {} })
      },
    )
  })

  it("traduce 401 y 429 a mensajes claros sin filtrar la clave", async () => {
    await conServidor([{ estado: 401, cuerpo: { error: { message: "Invalid API Key clave-de-prueba" } } }], async (p) => {
      await assert.rejects(p.enviar([sistema], [herramienta]), (e: unknown) => {
        assert.ok(e instanceof ErrorProveedor)
        assert.ok(!e.message.includes("clave-de-prueba"))
        assert.match(e.message, /autenticarse/)
        return true
      })
    })
    await conServidor([{ estado: 429, cuerpo: {} }, { estado: 429, cuerpo: {} }, { estado: 429, cuerpo: {} }], async (p, peticiones) => {
      await assert.rejects(p.enviar([sistema], [herramienta]), /límite gratuito/)
      assert.equal(peticiones.length, 3, "1 intento + 2 reintentos ante 429")
    })
  })

  it("se recupera de un 429 pasajero y reintenta con la misma solicitud", async () => {
    await conServidor(
      [{ estado: 429, cuerpo: { error: { message: "rate limit" } } }, { estado: 200, cuerpo: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }],
      async (p, peticiones) => {
        const r = await p.enviar([sistema, { rol: "user", contenido: [{ tipo: "texto", texto: "hola" }] }], [herramienta])
        assert.equal(r.fin, "fin")
        assert.equal(peticiones.length, 2)
      },
    )
  })

  it("recorta resultados de herramientas antiguos pero conserva los recientes", async () => {
    await conServidor([{ estado: 200, cuerpo: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }], async (p, peticiones) => {
      const largo = "x".repeat(2000)
      const historial: MensajeLLM[] = [sistema, { rol: "user", contenido: [{ tipo: "texto", texto: "hola" }] }]
      for (let i = 0; i < 6; i++) {
        historial.push({ rol: "assistant", contenido: [{ tipo: "herramienta", id: `c${i}`, nombre: "contratos_leer_buzon", args: {} }] })
        historial.push({ rol: "user", contenido: [{ tipo: "resultado", id: `c${i}`, contenido: largo }] })
      }
      await p.enviar(historial, [herramienta])
      const tools = (peticiones[0]?.cuerpo.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content).length)
      assert.equal(tools.length, 6)
      assert.ok(tools.slice(0, 2).every((n) => n < 600), "los 2 más antiguos se recortan")
      assert.ok(tools.slice(2).every((n) => n === 2000), "los 4 recientes van completos")
    })
  })

  it("interpreta duraciones de límite de Groq", () => {
    assert.equal(duracionAMs("697ms"), 697)
    assert.equal(duracionAMs("2.5s"), 2500)
    assert.equal(duracionAMs("5m45.6s"), 345600)
    assert.equal(duracionAMs("basura"), null)
  })
})
