# LTlive — Kodanalys & Förbättringsplan

> Genererad: 2026-03-21 | Stack: Flask/Python + Vanilla JS/Leaflet + Docker/Nginx

## Projektöversikt

LTlive är en realtidskarttjänst för kollektivtrafiken i Örebro som visar bussar
(GTFS-RT via Trafiklab) och tåg (Trafikverket + Oxyfi WebSocket) med live
GPS-positioner på en Leaflet-karta.

**Live**: https://ltlive.storavalla.se

---

## Arkitektursammanfattning

```
Browser (Leaflet + ES6 modules)
    │
    ├─ SSE /api/stream (realtid)
    └─ REST /api/* (departures, stops, vehicles, traffic)
    │
    v
Nginx (rate limiting, CSP, HSTS, static files)
    │
    v
Flask Backend (Gunicorn, 1 worker, 16 threads)
    ├─ 9 blueprints (api/)
    ├─ 3 typed stores (stores/) — gtfs, vehicles, trains
    ├─ APScheduler bakgrundsjobb
    └─ Data providers (bus_provider, train_provider)
    │
    v
Datakällor: Trafiklab GTFS-RT | Trafikverket API | Oxyfi WebSocket
```

---

## Styrkor

| Område | Styrka |
|--------|--------|
| **Backend** | Trådsäkra stores med per-store lås, SSE med delta-uppdateringar, robust felhantering |
| **Frontend** | Ingen build-step, modulär ES6, mobilanpassad med bottom sheets |
| **Infra** | Rate limiting, CSP, debug-endpoints LAN-begränsade, Docker health checks |
| **Data** | Flera datakällor korrekt aggregerade, GTFS-caching, automatisk retry |

---

## Identifierade förbättringsområden

### Prioritet 1 — Grundläggande (implementerat i denna branch)

- [x] **Linting**: `ruff` konfigurerat via `pyproject.toml` + `pre-commit` hooks
- [x] **Testning**: pytest-suite för `gtfs_rt.py` och alla stores (`stores/*.py`)
- [x] **HSTS**: `Strict-Transport-Security` header tillagd i Nginx

### Prioritet 2 — Kort sikt (rekommenderat nästa steg)

- [ ] **Rensa `store.py` legacy-shim**: 8 filer importerar `_data`/`_lock` — migrera till typed stores
- [ ] **Frontend ESLint**: Fånga undefined-variabler och oanvända imports
- [ ] **Lokal Leaflet-kopia**: Eliminera CDN-beroende (unpkg.com)
- [ ] **CI/CD**: GitHub Actions med lint → test → Docker build

### Prioritet 3 — Medellång sikt

- [ ] **Refaktorera `departures.py`** (596 rader med duplicerad TV-matchningslogik)
- [ ] **API-versioning** (`/api/v1/` prefix)
- [ ] **Ersätt `window._` callbacks** i `app.js` med event bus-modul
- [ ] **State management**: Pub/sub i `state.js` istället för direkt mutation
- [ ] **Tillgänglighet (a11y)**: ARIA-labels, keyboard-navigering, kontrastförbättringar
- [ ] **CSS-uppdelning**: `style.css` (1886 rader) → komponent-specifika filer
- [ ] **Strukturerad loggning**: Ersätt ~30 `print()` med `logging`-modul
- [ ] **Frontend felhantering**: `api.js` kollar inte `response.ok` före `.json()`
- [ ] **Förbättra `/api/health`**: Inkludera RT poll-ålder, Oxyfi-status, GTFS-ålder

### Prioritet 4 — Feature-möjligheter

- [ ] **PWA**: manifest.json + service worker (offline-stöd)
- [ ] **Historisk punktlighetsdata**: Trendgrafer (data finns redan i `analytics.py`)
- [ ] **Push-notiser**: Förseningsvarningar på sparade linjer
- [ ] **Multi-operator**: Stöd för fler städer (grundstrukturen finns via `OPERATOR`-env)

---

## Säkerhet

**Bra idag**: CSP ✓ | Rate limiting ✓ | Debug LAN-only ✓ | IP-hashning ✓ | HSTS ✓ (tillagd)

**Att förbättra**:
- Säkerställ att `ALLOWED_ORIGINS` alltid är explicit satt i produktion
- Logga aldrig URL-strängar som innehåller API-nycklar (`config.py`)
- Överväg `SameSite` cookie-attribut om cookies införs

---

## Prioriteringsmatris

| # | Åtgärd | Insats | Effekt |
|---|--------|--------|--------|
| 1 | Rensa `store.py` legacy | Låg-Med | Medium |
| 2 | CI/CD pipeline | Medium | Hög |
| 3 | Refaktorera `departures.py` | Medium | Medium |
| 4 | Frontend ESLint | Låg | Medium |
| 5 | Lokal Leaflet-fallback | Låg | Medium |
| 6 | a11y-förbättringar | Medium | Medium |
| 7 | Strukturerad loggning | Medium | Hög |
| 8 | API-versioning | Låg | Medium |
| 9 | PWA + offline | Låg-Med | Medium |
| 10 | TypeScript-migrering | Hög | Hög |
