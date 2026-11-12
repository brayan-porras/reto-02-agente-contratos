// Front de chat en JS plano. Todo texto del servidor/modelo entra al DOM escapado (nunca innerHTML sin escapar).
const EJEMPLO =
  "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme."

const $ = (id) => document.getElementById(id)
const el = { mensajes: $("mensajes"), texto: $("texto"), form: $("form"), enviar: $("btn-enviar"), pensando: $("pensando"),
  aviso: $("aviso-confirmacion"), modelo: $("estado-modelo"), clave: $("clave"), panel: $("panel"), archivo: $("contenido-archivo") }

let sessionId = nuevoId()
let ocupado = false
let claveAcceso = ""
try { claveAcceso = sessionStorage.getItem("clave") || "" } catch { /* sin storage */ }

function nuevoId() {
  const alfabeto = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return "s-" + Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("")
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// Markdown mínimo y seguro: tablas, listas, negrita, código en línea, encabezados.
function inline(t) {
  return esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}
function markdown(texto) {
  const lineas = texto.replace(/\r/g, "").split("\n")
  const out = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] || "")) {
      const celdas = (s) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      out.push("<table><thead><tr>" + cab.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
        filas.map((f) => "<tr>" + f.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>")
    } else if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*[-*]\s+/, ""))
      out.push("<ul>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>")
    } else if (/^#{1,4}\s+/.test(l)) {
      out.push(`<p><strong>${inline(l.replace(/^#{1,4}\s+/, ""))}</strong></p>`)
      i++
    } else if (l.trim() === "") {
      i++
    } else {
      const parrafo = []
      while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*(\||[-*]\s|#{1,4}\s)/.test(lineas[i])) parrafo.push(lineas[i++])
      out.push(`<p>${parrafo.map(inline).join("<br>")}</p>`)
    }
  }
  return out.join("")
}

function cabeceras() {
  const h = { "content-type": "application/json" }
  if (claveAcceso) h["x-access-key"] = claveAcceso
  return h
}

function bajar() { el.mensajes.scrollTop = el.mensajes.scrollHeight }

function burbuja(clase, html, etiqueta) {
  const d = document.createElement("div")
  d.className = `burbuja ${clase}`
  d.innerHTML = (etiqueta ? `<span class="etiqueta-confirm">${esc(etiqueta)}</span><br>` : "") + html
  el.mensajes.append(d)
  bajar()
  return d
}

function resumenResultado(json) {
  try {
    const r = JSON.parse(json)
    if (r.ok === false) return `ERROR: ${r.error}`
    return "OK"
  } catch { return "(resultado truncado)" }
}

function tarjetaHerramienta(t) {
  const d = document.createElement("details")
  d.className = "tool" + (t.ok ? "" : " fallo")
  const args = JSON.stringify(t.args ?? {}, null, 2)
  d.innerHTML = `<summary><span>${t.ok ? "🛠" : "⚠"}</span><span class="nombre">${esc(t.nombre)}</span>` +
    `<span>${esc(resumenResultado(t.resultado))}</span><span class="meta">${t.ms} ms</span></summary>` +
    `<div class="rotulo">Argumentos</div><pre>${esc(args)}</pre><div class="rotulo">Resultado</div><pre>${esc(t.resultado)}</pre>`
  return d
}

function pintarRespuesta(r, esError) {
  if (r.toolCalls?.length) {
    const cont = document.createElement("div")
    cont.className = "herramientas"
    r.toolCalls.forEach((t) => cont.append(tarjetaHerramienta(t)))
    el.mensajes.append(cont)
  }
  const clase = esError ? "agente error" : r.needsConfirmation ? "agente confirmar" : "agente"
  burbuja(clase, markdown(r.reply || "(sin texto)"), r.needsConfirmation && !esError ? "Requiere tu confirmación" : "")
  el.aviso.hidden = !(r.needsConfirmation && !esError)
  bajar()
}

function fijarOcupado(v) {
  ocupado = v
  el.enviar.disabled = v
  el.pensando.hidden = !v
}

async function enviar(mensaje) {
  if (ocupado || !mensaje.trim()) return
  burbuja("usuario", `<p>${esc(mensaje).replace(/\n/g, "<br>")}</p>`)
  el.texto.value = ""
  el.aviso.hidden = true
  fijarOcupado(true)
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: cabeceras(), body: JSON.stringify({ sessionId, message: mensaje }) })
    const datos = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (res.status === 401) mostrarClave()
      pintarRespuesta({ reply: datos.error || `Error ${res.status}`, toolCalls: [], needsConfirmation: false }, true)
    } else {
      pintarRespuesta(datos, false)
    }
  } catch {
    pintarRespuesta({ reply: "No se pudo contactar al servidor. Revisa tu conexión e intenta de nuevo.", toolCalls: [], needsConfirmation: false }, true)
  } finally {
    fijarOcupado(false)
    el.texto.focus()
  }
}

function mostrarClave() {
  el.clave.hidden = false
  el.clave.focus()
}

async function cargarSalud() {
  try {
    const s = await (await fetch("/api/health")).json()
    el.modelo.textContent = s.configured ? `${s.provider} · ${s.model}` : `${s.provider} · sin clave configurada en el servidor`
    if (s.accessKeyRequired) { el.clave.hidden = false; el.clave.value = claveAcceso }
  } catch { el.modelo.textContent = "Servidor no disponible" }
}

async function verArchivo(nombre) {
  document.querySelectorAll(".pestanas button").forEach((b) => b.classList.toggle("activa", b.dataset.f === nombre))
  el.archivo.textContent = "Cargando…"
  try {
    const res = await fetch(`/api/out/${nombre}`, { headers: cabeceras() })
    el.archivo.textContent = res.ok ? await res.text() : ((await res.json().catch(() => ({}))).error || `Error ${res.status}`)
  } catch { el.archivo.textContent = "No se pudo cargar el archivo." }
}

el.form.addEventListener("submit", (e) => { e.preventDefault(); enviar(el.texto.value) })
el.texto.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(el.texto.value) } })
$("btn-ejemplo").addEventListener("click", () => { el.texto.value = EJEMPLO; el.texto.focus() })
$("btn-archivos").addEventListener("click", () => { el.panel.hidden = !el.panel.hidden; if (!el.panel.hidden) verArchivo("alertas") })
$("cerrar-panel").addEventListener("click", () => { el.panel.hidden = true })
document.querySelectorAll(".pestanas button").forEach((b) => b.addEventListener("click", () => verArchivo(b.dataset.f)))
el.clave.addEventListener("change", () => {
  claveAcceso = el.clave.value
  try { sessionStorage.setItem("clave", claveAcceso) } catch { /* sin storage */ }
})
$("btn-nueva").addEventListener("click", async () => {
  if (!confirm("Esto borra la sesión y todo lo generado en out/. ¿Continuar?")) return
  await fetch("/api/reset", { method: "POST", headers: cabeceras() }).catch(() => undefined)
  sessionId = nuevoId()
  el.mensajes.innerHTML = ""
  el.aviso.hidden = true
  el.archivo.textContent = "Selecciona un archivo."
  burbuja("agente", "<p>Demo reiniciada. Puedes pedirme: <em>procesa el buzón de contratos</em>.</p>")
})

burbuja("agente", markdown("Hola, soy el agente de **registro de contratos**. Puedo leer el buzón, extraer y validar cada contrato, registrarlo en el maestro y generar alertas.\n\nPrueba con el botón **Usar prompt de ejemplo**."))
cargarSalud()
