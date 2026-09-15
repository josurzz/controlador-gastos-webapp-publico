# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static PWA dashboard for a personal expense tracker: **zero backend**, runs entirely in the browser, reads/writes a Google Sheet directly.

**This is the "frontend"** — a dashboard to view/edit expenses (plus add income), but it doesn't log new expenses by voice on its own. Pairs naturally with a sibling repo, the "backend" — [`controlador-gastos-bot-publico`](https://github.com/josurzz/controlador-gastos-bot-publico): a Telegram bot that transcribes voice notes and logs expenses into that same Sheet via AI. Also works fully standalone against any Sheet with the same column structure (expenses entered by hand). Neither depends on the other to work, and they share no code.

**One installation per person**, each its own folder with its own `index.html`/`manifest.json`/`sw.js`, sharing `shared/app.js`/`shared/style.css`. `_example/` is the template folder — copy it to create a new installation, or run `python3 setup.py` (interactive wizard: validates the folder name doesn't collide, computes the email hash for you, and offers to reuse the OAuth Client ID / categorias from an existing installation instead of re-asking). See `README.md` for the human-facing setup steps.

## Architecture

Talks directly to the Google Sheets API v4 using an OAuth token from Google Identity Services (`google.accounts.oauth2.initTokenClient`). Every installation shares one `shared/app.js`/`style.css`, differing only via each installation's `index.html`:

```js
window.GASTOS_CONFIG = { sheetId, clientId, titulo, allowedEmailHash, categorias, nombreNoCredito, categoriasExcluidasPorDia }
```

`allowedEmailHash` is a SHA-256 hash (never the plaintext email) checked client-side against the logged-in Google account — a UX guard, not real access control (real control is who the Sheet is shared with). Silent rejection on mismatch (no error text — don't add one, it would leak which emails are expected). `categorias`/`nombreNoCredito`/`categoriasExcluidasPorDia` let one installation customize category lists, color assignment priority, and chart exclusions without affecting others — when a change is personal to one installation, add it as a new optional `CONFIG` key with a sensible default, don't hardcode it into shared logic.

**Categories/payment methods can be edited from this webapp if you also seed a "Config" tab in the Sheet** (a companion bot can do this — see the sibling project). `cargarCategoriasDesdeSheet()` fetches `Config!A2:C` once per session and populates three module-level variables: `CATEGORIAS_ORDEN` (column A, category names), `COLOR_SLOT_POR_CATEGORIA` (column B, an explicit `categoria -> 1..14` map — **not** positional; this is what makes a color persist correctly even as categories get added over time), and `MEDIOS_PAGO_ORDEN` (column C). `CONFIG.categorias` (hardcoded in `index.html`) is only the fallback for a Sheet whose "Config" tab doesn't exist yet.

**Adding a category or payment method** (`abrirModalCategoria`/`guardarCategoriaNueva`, `abrirModalMedioPagoNuevo`/`guardarMedioPagoNuevo`) appends a row to "Config" via a targeted range write — **never a blanket rewrite of the whole tab**, because categories (columns A/B) and payment methods (column C) are two independent series sharing the same rows, and a naive whole-tab overwrite would clobber whichever series didn't just change. `_proximaFilaLibreEnConfig(columna)` finds the next free row **for that one column specifically** before writing. A new category can only pick an unused `ColorSlot` (1-14) — the UI disables slots already taken (`slotsUsados` in `abrirModalCategoria`) rather than allowing dupes; past 14 categories, new ones simply get no slot and fall back to the shared gray (same rule as `colorDeCategoria()`'s overflow behavior). After either save, `categoriasCargadasDesdeSheet` is reset to `false` so the next `cargarDatos()` actually re-fetches "Config" instead of trusting the stale in-memory copy.

**Categorical color palette is capped at 14 colors** (`MAX_CATEGORIAS_CON_COLOR` in `colorDeCategoria()`, `--series-1` through `--series-14` in `style.css`). Only the first 8 are a colorblind-validated set — if an installation has more than 8 categories and wants them all colored, colors 9-14 are ordinary distinct hues with no CVD guarantee. Categories beyond the first 14, or literally named "Otros", fall back to the shared gray.

**Shared month/year navigation state**: `mesGlobal` is shared across the Actividad mensual, Ingreso vs Gastos, Gastos detalle, and Calendario tabs — moving the month (arrows or the month-search box) in any one of them re-renders all four (`sincronizarMesGlobal()`). Gastos detalle additionally supports a free-form Desde/Hasta custom range that stays local to that tab unless it happens to resolve to one clean calendar month. `anioSeleccionado` is the equivalent for the separate Anual tab (year, not month). When adding a new month-scoped element to any of the four synced tabs, drive it off `mesGlobal`, not a fresh local variable.

**Sheets money-out-vs-committed distinction**, load-bearing across several features: a purchase on a credit card doesn't leave your account until it's billed. "Actividad mensual" totals are by purchase date ("Total demandado" — everything charged, regardless of when it's actually paid). "Ingreso vs Gastos" computes the real cash picture instead: this month's débito/efectivo + crédito whose **"Mes de pago"** resolves to this month (see below), plus that month's ahorro treated as another line item that reduces disponible. Don't blend these two conventions in one chart/card without a clear label.

**"Mes de pago" column** (written by a companion bot, read here, if you're pairing this with one): a credit card's real statement-close date isn't a fixed day of the month, so a bot can ask (with buttons) when a purchase falls in an ambiguous window near month-end/month-start, and write the resolved billing month into this column — separate from "Fecha y hora" (purchase date, unaffected). It's independent per row, even across a cuota (installment) chain, so `Gastos detalle` can offer a correction on a single installment without touching the others. In `app.js`, `mesPagoEfectivo(m)` reads it with a fallback to "purchase month + 1" for rows written before this column existed (or if you don't have a bot writing it at all).

Chart.js gotchas already fixed once, don't reintroduce: (a) vertical vs horizontal bar tooltips need separate `ctx.parsed.y`/`ctx.parsed.x` callbacks — `ctx.parsed.x ?? ctx.parsed.y` is always truthy on vertical bars and silently shows the wrong value; (b) any chart whose canvas isn't already covered by the batch `destruirGraficos()` call in `renderizarResumenSuperior()` must self-destroy on re-render (`Chart.getChart(canvasId)?.destroy()` at the top of the draw function) or repeated navigation throws/leaks.

**Service worker (`sw.js`) must bypass HTTP cache, not just prefer network.** A plain `fetch(event.request)` can honor a stale HTTP cache-control header and silently return an old `app.js` even under a "network-first" strategy. The fetch call must use `fetch(event.request, { cache: "no-store" })`. Bump `CACHE_NAME` (`-v2`, `-v3`, ...) whenever the fetch strategy itself changes, to force old clients to drop their Cache Storage entry.

## Running / deploying

No test suite, no build step (plain HTML/CSS/JS, no bundler). To test locally without deploying (Google login needs an `http(s)://` origin, `file://` won't work):

```bash
python3 -m http.server 8000
# open http://localhost:8000/_example/
```

Add `http://localhost:8000` to the OAuth Client's Authorized JavaScript origins to test login locally (can remove it later).

Before writing to `shared/app.js`, a cheap sanity check that catches the most common editing mistakes (mismatched braces, an HTML id the JS looks up that no longer exists) — run from this repo's root:

```bash
python3 - <<'EOF'
s = open("shared/app.js", encoding="utf-8").read()
depth = 0
for ch in s:
    depth += (ch == "{") - (ch == "}")
print("final depth:", depth)  # must be 0
EOF
grep -oP 'getElementById\("\K[^"]+' shared/app.js | sort -u | while read -r id; do
  grep -q "id=\"$id\"" _example/index.html || echo "MISSING in _example: $id"
done
```

See `README.md` for hosting-agnostic deploy notes (Vercel is used as the concrete example, but this is plain static hosting — any static host works, see the "Desplegar" section there).
