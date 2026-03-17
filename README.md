# LTlive

Live-kartan som visar alla stadsbussar och länsbussar i Örebro kommun i realtid.

## Funktioner

### Karta & fordon
- Leaflet-karta med CartoDB-basemap — mörkt och ljust tema, växlingsbar via toggle
- Färgade bussikoner med riktningspil som visar fordonspositioner i realtid
- Smidig animering av fordonsförflyttning interpolerad mellan GPS-uppdateringar
- Spår (breadcrumbs) som visar fordonets senaste 10 positioner
- Linjesträckningar (shapes från GTFS) i linjens färg, laddas bulk vid start

### Hållplatser & avgångar
- Hållplatsmarkeringar med nästa avgångsbricka (linje + tid + läge, synlig från zoom 15+)
- Uppdateras var 60:e sekund automatiskt
- Klicka på hållplats → popup med kommande avgångar och live-nedräkning i sekunder
- Realtidsmärkning (RT) på avgångar med GTFS-RT TripUpdates-data
- Försenade bussar som visas i realtid ersätter korrekt motsvarande statiska avgång (tidsbaserad deduplicering även när GTFS-RT trip_id skiljer sig från statisk trip_id)

### GPS / Nära hållplatser
- GPS-knapp visar din position med noggrannhetscirkel på kartan
- Panel med hållplatser nära dig och deras kommande avgångar
- Konfigurerbar sökradie (standard 400 m, se `NEARBY_RADIUS_METERS`)
- Uppdateras automatiskt när du rör dig mer än 30 m

### Linjefiltrering & linjepanel
- Filtrera kartan per linje via linjeknapparna i verktygsfältet
- Klicka på en linje → sidopanel med alla hållplatser i båda riktningarna och realtidsnedräkningar
- Linjepanelen uppdateras automatiskt var 30:e sekund

### Realtidsstreaming (SSE)
- Fordonspositioner pushas via Server-Sent Events (`/api/stream`) i stället för polling
- Automatisk fallback till polling om SSE-anslutningen tappar
- Max 4 SSE-anslutningar per IP (DoS-skydd)

### Störningsinformation
- Rullande ticker längst ner med aktiva trafikstörningar (ServiceAlerts)
- Tickern kan fällas ihop och expanderas med en återöppnarknapp

### Prestanda & cache
- Svarscache på backend-sidan (invalideras vid ny realtidsuppdatering)
- Shapes laddas i bulk-endpoint för att minska antalet HTTP-anrop

### Verktyg & sidor
- **Avgångstavla** (`/board.html`) — tavla för enskild hållplats, öppnas från popup
- **Statistiksida** (`/stats.html`) — besöksstatistik per sida (30 dagar + senaste 20 besök)
- **Schematic Tracer** (`/tracer.html`) — ritverktyg för att skapa schematiska linjekartor
- **API-utforskare** (`/api.html`) — testa alla backend-endpoints direkt i webbläsaren
- **Diagnostik** (`/diag.html`) — se laddningsstatus, RT-feed och fältmappning

## Tech stack

- **Backend**: Python / Flask — hämtar GTFS Static + GTFS-RT från Trafiklab
- **Frontend**: Leaflet.js med CartoDB tiles, vanilla JS (ingen byggsteg)
- **Webbserver**: Nginx (reverse proxy + static files)
- **Container**: Docker Compose med namngiven volym för GTFS-data

## Data

Data hämtas från [Trafiklab](https://trafiklab.se) via GTFS Regional API:
- **GTFS Static** (orebro) — linjer, hållplatser, tidtabeller, linjesträckningar
- **GTFS-RT VehiclePositions** — realtids GPS-positioner
- **GTFS-RT TripUpdates** — realtidsavgångar och förseningar
- **GTFS-RT ServiceAlerts** — störningsinformation

Licens för data: CC0 1.0 Universal

## Snabbstart

### 1. Skaffa API-nycklar

1. Registrera dig på [trafiklab.se](https://www.trafiklab.se/)
2. Skapa ett projekt
3. Lägg till API:t "GTFS Regional" (behöver både Static och Realtime)
4. Kopiera dina API-nycklar

### 2. Konfigurera

```bash
cp .env.example .env
# Redigera .env med dina API-nycklar
```

### 3. Starta

```bash
docker compose up -d
```

Öppna http://localhost:8080 i webbläsaren.

## Konfiguration

| Variabel | Standard | Beskrivning |
|---|---|---|
| `TRAFIKLAB_GTFS_RT_KEY` | — | API-nyckel för GTFS-RT (realtid) |
| `TRAFIKLAB_GTFS_STATIC_KEY` | — | API-nyckel för GTFS Static (kan vara samma) |
| `TRAFIKLAB_API_KEY` | — | Alternativ: en nyckel för båda |
| `NEARBY_RADIUS_METERS` | `400` | Sökradie för GPS-funktionen (meter) |
| `FRONTEND_POLL_INTERVAL_MS` | `5000` | Fallback-pollintervall om SSE ej tillgänglig (ms) |
| `GTFS_REFRESH_HOURS` | `48` | Hur ofta GTFS Static laddas om |
| `RT_POLL_SECONDS` | `180` | Hur ofta GTFS-RT-feeds hämtas från Trafiklab |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Aktivera `/api/debug/*`-endpoints (ej i prod) |

## Utveckling

### Utan Docker

Backend:
```bash
cd backend
pip install -r requirements.txt
TRAFIKLAB_GTFS_RT_KEY=... TRAFIKLAB_GTFS_STATIC_KEY=... python app.py
```

Frontend (enkel HTTP-server):
```bash
cd frontend
python -m http.server 3000
```

## Arkitektur

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Webbläsare │────▶│    Nginx     │────▶│  Flask Backend   │
│  (Leaflet)  │◀────│  :8080       │◀────│  :5000           │
└─────────────┘     └──────────────┘     └────────┬─────────┘
   SSE stream        static files                  │
   /api/stream       /frontend/*                   │ GTFS-RT poll (var RT_POLL_SECONDS s)
                                                   ▼
                                          ┌──────────────────┐
                                          │   Trafiklab API  │
                                          │  (samtrafiken)   │
                                          └──────────────────┘
```

GTFS Static-data cachas i en Docker-volym (`gtfs-data`) och laddas endast om vid uppstart om cachen är äldre än `GTFS_REFRESH_HOURS` timmar. Statiska avgångar för aktuell dag laddas om vid midnatt.
