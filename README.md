# LTlive

Live-kartan som visar alla stadsbussar och länsbussar i Örebro kommun i realtid.

## Funktioner

### Karta & fordon
- Leaflet-karta med CartoDB-basemap (mörkt och ljust tema, växlingsbar)
- Färgade bussikoner med riktningspil som visar fordonspositioner i realtid
- Smidig animering av fordonsförflyttning mellan GPS-uppdateringar
- Spår (breadcrumbs) som visar fordonets senaste 10 positioner
- Linjesträckningar (shapes från GTFS) i linjens färg

### Hållplatser & avgångar
- Hållplatsmarkeringar med nästa avgångsbricka (synlig från zoom 15+)
- Klicka på hållplats → popup med kommande avgångar och live-nedräkning
- Realtidsmärkning (RT) på avgångar med GTFS-RT TripUpdates-data

### GPS / Nära hållplatser
- GPS-knapp visar din position med noggrannhetscirkel på kartan
- Panel med hållplatser nära dig och deras kommande avgångar
- Konfigurerbar sökradie (standard 400 m, se `NEARBY_RADIUS_METERS`)
- Uppdateras automatiskt när du rör dig mer än 30 m

### Linjefiltrering & linjepanel
- Filtrera kartan per linje via linjeknapparna
- Klicka på en linje → sidopanel med alla hållplatser i båda riktningarna och realtidsnedräkningar

### Störningsinformation
- Rullande ticker längst ner med aktiva trafikstörningar (ServiceAlerts)
- Tickern kan fällas ihop och expanderas

### Övrigt
- Responsiv design (mobil + desktop) med hamburgermeny på små skärmar
- Avgångstavla för enskild hållplats (`/board.html`)
- Schematisk stadstrafikenkarta (`/stadstrafiken.html`)
- Diagnostikpanel (`/diag.html`)

## Tech stack

- **Backend**: Python / Flask — hämtar GTFS Static + GTFS-RT från Trafiklab
- **Frontend**: Leaflet.js med CartoDB tiles
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
| `FRONTEND_POLL_INTERVAL_MS` | `5000` | Hur ofta fordonspositoner uppdateras (ms) |
| `GTFS_REFRESH_HOURS` | `48` | Hur ofta GTFS Static laddas om |
| `RT_POLL_SECONDS` | `180` | Hur ofta GTFS-RT-feeds hämtas |

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
                     │ static files                │
                     │ /frontend/*                 │ GTFS-RT poll
                                                   ▼
                                          ┌──────────────────┐
                                          │   Trafiklab API  │
                                          │  (samtrafiken)   │
                                          └──────────────────┘
```

GTFS Static-data cachas i en Docker-volym (`gtfs-data`) och laddas endast om vid uppstart om cachen är äldre än `GTFS_REFRESH_HOURS` timmar.
