/** CSV mínimo con comillas RFC 4180 (suficiente para el maestro). */
export function parseCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ""
  let comillas = false
  const limpio = texto.replace(/^﻿/, "")
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i]
    if (comillas) {
      if (c === '"' && limpio[i + 1] === '"') {
        celda += '"'
        i++
      } else if (c === '"') comillas = false
      else celda += c
    } else if (c === '"') comillas = true
    else if (c === ",") {
      fila.push(celda)
      celda = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && limpio[i + 1] === "\n") i++
      fila.push(celda)
      celda = ""
      if (fila.some((x) => x !== "")) filas.push(fila)
      fila = []
    } else celda += c
  }
  fila.push(celda)
  if (fila.some((x) => x !== "")) filas.push(fila)
  return filas
}

function escapar(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function serializarCsv(filas: string[][]): string {
  return filas.map((f) => f.map(escapar).join(",")).join("\n") + "\n"
}
