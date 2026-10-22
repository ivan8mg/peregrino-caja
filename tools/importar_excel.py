"""Convierte el catálogo y el inventario de Excel en el catálogo inicial de la app.

Uso: python3 importar_excel.py <catalogo.xlsx> <inventario.xlsx> <salida.js>

Reglas:
- Precio: el del inventario cuando el código aparece ahí (es el más reciente), si no el del catálogo.
- Códigos repetidos en el catálogo: gana la última fila.
- Artículos sin precio entran con precio 0 ("sin precio").
- Existencia: la del inventario; lo demás queda en 0.
- Los códigos 1, 2 y 3 (Efectivo, Transferencia, Tarjeta) no son productos: la app los usa como forma de pago.
- Precio negativo = descuento (como en el Excel de macros).
"""
import json, sys, re
import openpyxl

PAGOS = {"1", "2", "3"}

def codigo(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()

def limpiar(t):
    return re.sub(r"\s+", " ", str(t or "")).strip()

def main(cat_path, inv_path, out_path):
    productos, omitidos = {}, []
    ws = openpyxl.load_workbook(cat_path, data_only=True).active
    for r in ws.iter_rows(min_row=2, values_only=True):
        c, desc, precio = codigo(r[0]), limpiar(r[1]), r[2]
        if not c and not desc:
            continue
        if not c or c in PAGOS:
            omitidos.append((c, desc, precio))
            continue
        if not isinstance(precio, (int, float)):
            # Sin precio: entra con precio 0 y la app lo muestra en "Libros sin precio",
            # salvo que una fila anterior del mismo código sí tenga precio.
            if c in productos:
                continue
            precio = 0
        productos[c] = {"codigo": c, "titulo": desc, "precio": round(float(precio), 2), "existencia": 0}

    ws = openpyxl.load_workbook(inv_path, data_only=True).active
    for r in ws.iter_rows(min_row=3, values_only=True):
        c = codigo(r[0])
        if not c or not isinstance(r[2], (int, float)):
            continue
        p = productos.setdefault(c, {"codigo": c, "titulo": limpiar(r[1]), "precio": 0, "existencia": 0})
        p["existencia"] = int(r[2])
        if isinstance(r[3], (int, float)):
            p["precio"] = round(float(r[3]), 2)
        if "NO APLICA DESCUENTO" in str(r[1]).upper():
            p["titulo"] = limpiar(r[1])

    for p in productos.values():
        up = p["titulo"].upper()
        p["sinDescuento"] = "NO APLICA DESCUENTO" in up
        p["titulo"] = limpiar(re.sub(r"\(?NO APLICA DESCUENTOS?\)?", "", p["titulo"], flags=re.I))
        p["tipo"] = "descuento" if p["precio"] < 0 else ("libro" if len(p["codigo"]) == 13 and p["codigo"].startswith("97") else "articulo")
        p["autor"] = ""

    lista = sorted(productos.values(), key=lambda p: p["titulo"].lower())
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("// Generado por tools/importar_excel.py. No editar a mano.\n")
        f.write("window.CATALOGO_INICIAL = ")
        json.dump(lista, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"{len(lista)} productos, {sum(1 for p in lista if p['existencia'] > 0)} con existencia, omitidos: {omitidos}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
