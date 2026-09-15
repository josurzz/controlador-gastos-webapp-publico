#!/usr/bin/env python3
"""
Wizard interactivo para crear una instalacion nueva de la webapp (una
carpeta por persona) - te pregunta lo que hace falta y arma el index.html
solo, en vez de copiar `_example/` y editarlo a mano.

Sirve tanto para la primera instalacion como para agregar una persona
nueva despues: si ya hay alguna instalacion, te ofrece reusar el OAuth
Client ID (se comparte entre todas) en vez de volver a pedirlo.

Uso: python3 setup.py
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESERVADOS = {"shared", "_example", "docs", ".git", "node_modules"}


def instalaciones_existentes():
    salida = []
    for p in sorted(ROOT.iterdir()):
        if not p.is_dir() or p.name in RESERVADOS or p.name.startswith("."):
            continue
        index = p / "index.html"
        if index.exists() and "GASTOS_CONFIG" in index.read_text(encoding="utf-8"):
            salida.append(p)
    return salida


def extraer(index_html: str, patron: str):
    m = re.search(patron, index_html)
    return m.group(1) if m else None


def pedir_nombre():
    existentes = instalaciones_existentes()
    print("\nInstalaciones ya configuradas:", ", ".join(p.name for p in existentes) or "(ninguna todavia)")
    while True:
        nombre = input(
            "\nNombre de esta instalacion (va a ser el nombre de la carpeta Y parte de la URL - "
            "si preferis que no se note de quien es, usa un slug al azar, ej: 'a3f9c1'): "
        ).strip().lower()
        if not re.fullmatch(r"[a-z0-9_-]+", nombre or ""):
            print("  Invalido: solo minusculas, numeros, '-' o '_', sin espacios.")
            continue
        if nombre in RESERVADOS:
            print("  Ese nombre esta reservado, elegi otro.")
            continue
        if (ROOT / nombre).exists():
            print(f"  Ya existe la carpeta '{nombre}/' - elegi otro nombre (o borra esa carpeta primero si fue un error).")
            continue
        return nombre


def pedir_client_id(existentes):
    opciones = []
    for p in existentes:
        val = extraer((p / "index.html").read_text(encoding="utf-8"), r'clientId:\s*"([^"]+)"')
        if val and "TU_OAUTH_CLIENT_ID" not in val:
            opciones.append((p.name, val))

    if opciones:
        print("\nOAuth Client ID (el mismo se puede reusar para todas las instalaciones):")
        for i, (nombre, val) in enumerate(opciones, 1):
            print(f"  {i}) reusar el de '{nombre}' ({val})")
        print("  0) ingresar uno nuevo")
        while True:
            eleccion = input("Elegi una opcion [0]: ").strip() or "0"
            if eleccion == "0":
                break
            if eleccion.isdigit() and 1 <= int(eleccion) <= len(opciones):
                return opciones[int(eleccion) - 1][1]
            print("  Opcion invalida.")

    return input("OAuth Client ID (Google Cloud Console -> Credenciales, ver README paso 1): ").strip()


def pedir_categorias(existentes):
    opciones = []
    for p in existentes:
        texto = (p / "index.html").read_text(encoding="utf-8")
        m = re.search(r"categorias:\s*\[(.*?)\],", texto, re.DOTALL)
        if m:
            items = re.findall(r'"([^"]+)"', m.group(1))
            if items:
                opciones.append((p.name, items))

    if opciones:
        print("\nCategorias:")
        for i, (nombre, items) in enumerate(opciones, 1):
            print(f"  {i}) copiar las de '{nombre}' ({', '.join(items[:4])}{'...' if len(items) > 4 else ''})")
        print("  0) ingresar las propias (o Enter para dejar las del ejemplo)")
        eleccion = input("Elegi una opcion [0]: ").strip() or "0"
        if eleccion.isdigit() and 1 <= int(eleccion) <= len(opciones):
            return opciones[int(eleccion) - 1][1]

    cat_in = input("Categorias propias, separadas por coma (Enter para dejar las del ejemplo): ").strip()
    if not cat_in:
        return None
    return [c.strip() for c in cat_in.split(",") if c.strip()]


def main():
    print("=== Setup de una instalacion nueva de la webapp ===")

    existentes = instalaciones_existentes()
    nombre = pedir_nombre()

    print(f"\n--- Datos PROPIOS de esta instalacion ---")
    sheet_id = input("ID de la Google Sheet (la parte de la URL entre /d/ y /edit): ").strip()
    email = input(
        "Email de Google de la persona que va a usar esto (solo se usa para calcular un hash, nunca se guarda en texto plano): "
    ).strip()
    email_hash = hashlib.sha256(email.strip().lower().encode()).hexdigest() if email else "TU_HASH_SHA256_ACA"
    titulo = input("Titulo de la pagina [Gastos]: ").strip() or "Gastos"

    print(f"\n--- Datos que se pueden REUSAR entre instalaciones ---")
    client_id = pedir_client_id(existentes)
    categorias = pedir_categorias(existentes)

    # Recien aca se toca el disco. Se usa _example/ como base si existe (repo
    # publico); si no (ej. un repo privado que usa carpetas reales en vez de
    # _example/), se usa cualquier instalacion existente como base en su
    # lugar - los reemplazos de abajo son por regex sobre los campos, no por
    # texto de placeholder literal, asi que funcionan igual en los dos casos.
    if (ROOT / "_example").exists():
        origen = ROOT / "_example"
    elif existentes:
        origen = existentes[0]
    else:
        print("No encontre '_example/' ni ninguna instalacion existente para usar de base.")
        sys.exit(1)

    destino = ROOT / nombre
    destino.mkdir(parents=True)
    for archivo in ["index.html", "manifest.json", "sw.js"]:
        origen_archivo = origen / archivo
        if origen_archivo.exists():
            (destino / archivo).write_text(origen_archivo.read_text(encoding="utf-8"), encoding="utf-8")

    index_path = destino / "index.html"
    texto = index_path.read_text(encoding="utf-8")
    texto = re.sub(r'sheetId:\s*"[^"]*"', f'sheetId: "{sheet_id}"', texto, count=1)
    texto = re.sub(r'clientId:\s*"[^"]*"', f'clientId: "{client_id}"', texto, count=1)
    texto = re.sub(r'allowedEmailHash:\s*"[^"]*"', f'allowedEmailHash: "{email_hash}"', texto, count=1)
    texto = re.sub(r'titulo:\s*"[^"]*"', f'titulo: "{titulo}"', texto, count=1)
    texto = re.sub(r'gastos-tema-[^"]*', f'gastos-tema-{sheet_id}', texto, count=1)
    if categorias:
        bloque = ",\n".join(f'        "{c}"' for c in categorias)
        texto = re.sub(r"categorias:\s*\[.*?\],", f"categorias: [\n{bloque},\n      ],", texto, count=1, flags=re.DOTALL)
    index_path.write_text(texto, encoding="utf-8")

    sw_path = destino / "sw.js"
    if sw_path.exists():
        sw_texto = sw_path.read_text(encoding="utf-8")
        sw_texto = re.sub(r'CACHE_NAME = "[^"]*"', f'CACHE_NAME = "gastos-{nombre}-shell-v1"', sw_texto, count=1)
        sw_path.write_text(sw_texto, encoding="utf-8")

    print(f"\n✅ Listo: {nombre}/ creada a partir de {origen.name}/.")
    print(f"""
Proximos pasos:

1) Probarlo local antes de desplegar:
   python3 -m http.server 8000
   # abrir http://localhost:8000/{nombre}/
   (agregá http://localhost:8000 a las Authorized JavaScript origins del
   OAuth Client para que el login funcione en local)

2) Compartir la Google Sheet con la cuenta de Google de esta persona,
   permiso Editor (ver README paso 1.4).

3) Si vas a desplegar en Vercel, sumá esta linea a vercel.json (raiz del repo):
   {{ "source": "/{nombre}", "destination": "/{nombre}/", "permanent": false }}
   (otros hostings no lo necesitan - ver README seccion 3)
""")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelado.")
        sys.exit(1)
