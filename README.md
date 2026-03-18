# LTlive

Live-kartan som visar bussar och tåg i Örebro län i realtid.

## Funktioner

### Karta & fordon
- Leaflet-karta med CartoDB-basemap — mörkt och ljust tema, växlingsbar via toggle
- Färgade fordonsikoner med riktningspil som visar positioner i realtid
- Smidig animering av fordonsförflyttning interpolerad mellan GPS-uppdateringar
- Spår (breadcrumbs) som visar fordonets senaste 10 positioner
- Linjesträckningar (shapes från GTFS) i linjens färg, laddas bulk vid start

### Tåg i Bergslagen
- Realtidspositioner för Tåg i Bergslagen via Oxyfis WebSocket-API (NMEA/GPRMC)
- Eget filter i `config.js` — endast konfigurerade TiB-tågnummer (9005–9068, 3190 m.fl.) visas
- Tågikonen visar lok + 2 vagnar i horisontell profil med tågnummer på loket
- **Rörliga tåg**: orange ikon med riktningspil, bearing från GPS-kursen
- **Stillastående tåg**: grå ikon utan pil, riktning snappas automatiskt till närmaste GTFS-spårsegment
- Spårlinjer (TiB-rutter T53, T54, T57, T62A, T63) ritas alltid på kartan — dedupade per `shape_id` så varje fysiskt spårsegment ritas en gång
- Tåg som inte rapporterar position visas kvar i 5 minuter (tåg sänder mer sällan än bussar)
- Oxyfi-fordon matchas automatiskt mot Trafikverkets tjänstenummer via positions- och tidsnärhet

### SJ och Mälartåg
- Realtidspositioner för SJ- och Mälartåg-tåg via Trafikverkets TrainPosition-API
- Visas på kartan med samma tågikon som TiB-tåg
- Avgångar och ankomster inkluderas i TiB-tavlan när tågen stannar vid konfigurerade stationer

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
- Stationsmeddelanden (TrainStationMessage) visas som banner på TiB-tavlan

### Prestanda & cache
- Svarscache på backend-sidan (invalideras vid ny realtidsuppdatering)
- Shapes laddas i bulk-endpoint för att minska antalet HTTP-anrop

### Verktyg & sidor
- **Avgångstavla** (`/board.html`) — tavla för enskild hållplats, öppnas från popup
- **TiB-tavla** (`/tib-board.html`) — avgångs- och ankomsttavla för Tåg i Bergslagen (Örebro C, Örebro Södra m.fl.) med live-tågindikatorer från Oxyfi, SJ och Mälartåg; avgångna/ankomna tåg visas kvar 10 minuter med statusetikett
- **Stadstrafiken** (`/stadstrafiken.html`) — dedikerad kartvy för stadsbusslinjerna i Örebro
- **Statistiksida** (`/stats.html`) — besöksstatistik per sida (30 dagar + senaste 20 besök)
- **Schematic Tracer** (`/tracer.html`) — ritverktyg för att skapa schematiska linjekartor
- **API-utforskare** (`/api.html`) — testa alla backend-endpoints direkt i webbläsaren
- **Diagnostik** (`/diag.html`) — se laddningsstatus, RT-feed och fältmappning

## Tech stack

- **Backend**: Python / Flask — hämtar GTFS Static + GTFS-RT från Trafiklab
- **Tågpositioner (TiB)**: Oxyfi WebSocket API (NMEA GPRMC med Oxyfi-tillägg)
- **Tågpositioner (SJ/Mälartåg/TiB)**: Trafikverkets öppna API (TrainPosition, TrainAnnouncement, TrainStation, TrainStationMessage)
- **Frontend**: Leaflet.js med CartoDB tiles, vanilla JS (ingen byggsteg)
- **Webbserver**: Nginx (reverse proxy + static files)
- **Container**: Docker Compose med namngiven volym för GTFS-data

## Data

Data hämtas från [Trafiklab](https://trafiklab.se) via GTFS Regional API:
- **GTFS Static** (orebro) — linjer, hållplatser, tidtabeller, linjesträckningar
- **GTFS-RT VehiclePositions** — realtids GPS-positioner (bussar)
- **GTFS-RT TripUpdates** — realtidsavgångar och förseningar
- **GTFS-RT ServiceAlerts** — störningsinformation

Tågpositioner (TiB) hämtas från [Oxyfi](https://oxyfi.com) via WebSocket (separat API-nyckel):
- **Oxyfi Realtidspositionering** — GPS-position, hastighet och kurs för TiB-fordon

Tåginformation (alla operatörer) hämtas från [Trafikverket](https://api.trafikinfo.trafikverket.se):
- **TrainPosition** — realtidspositioner för alla aktiva tåg i Sverige
- **TrainAnnouncement** — avgångar och ankomster med realtidstider per station
- **TrainStation** — stationskoordinater och metadata
- **TrainStationMessage** — aktiva stationsmeddelanden och driftstörningar

Licens för data: CC0 1.0 Universal

## Snabbstart

### 1. Skaffa API-nycklar

**Trafiklab (Örebro bussar):**
1. Registrera dig på [trafiklab.se](https://www.trafiklab.se/)
2. Skapa ett projekt och lägg till API:t "GTFS Regional" (behöver både Static och Realtime)
3. Kopiera dina API-nycklar

**Oxyfi (TiB-tågpositioner, valfritt):**
1. Lägg till "Oxyfi-Realtidspositionering" i ditt Trafiklab-projekt

**Trafikverket (SJ/Mälartåg/TiB-positioner och tavlor, valfritt):**
1. Registrera dig på [api.trafikinfo.trafikverket.se](https://api.trafikinfo.trafikverket.se/)
2. Generera en API-nyckel
3. Ange vilka stationer som ska visas på TiB-tavlan via `TRAFIKVERKET_STATIONS`

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
| `OXYFI_API_KEY` | — | API-nyckel för Oxyfi tågpositionering |
| `TRAFIKVERKET_API_KEY` | — | API-nyckel för Trafikverkets öppna API (tågpositioner, tavlor) |
| `TRAFIKVERKET_STATIONS` | — | Kommaseparerad lista `gtfs_stop_id:loc_sig` som kopplar GTFS-hållplatser till Trafikverkets stationssignaturer, t.ex. `9022:Örc,9023:Örs` |
| `TRAFIKVERKET_OPERATORS` | *(alla)* | Kommaseparerad lista med operatörer att filtrera på, t.ex. `Arriva Sverige AB`. Tom = visa alla. |
| `TRAFIKVERKET_LOOKAHEAD_MINUTES` | `120` | Hur långt fram (minuter) att hämta tågannonseringar |
| `TRAFIKVERKET_POLL_SECONDS` | `60` | Hur ofta Trafikverkets API pollas |
| `NEARBY_RADIUS_METERS` | `400` | Sökradie för GPS-funktionen (meter) |
| `FRONTEND_POLL_INTERVAL_MS` | `5000` | Fallback-pollintervall om SSE ej tillgänglig (ms) |
| `GTFS_REFRESH_HOURS` | `48` | Hur ofta GTFS Static laddas om |
| `RT_POLL_SECONDS` | `180` | Hur ofta GTFS-RT-feeds hämtas från Trafiklab |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Aktivera `/api/debug/*`-endpoints (ej i prod) |

### Trafikverket stationskoder

Stationssignaturer (`loc_sig`) hittas via [Trafikverkets API-explorer](https://api.trafikinfo.trafikverket.se/API/TheRequest) eller via debug-endpoint `/api/debug/tv-stations` när `ENABLE_DEBUG_ENDPOINTS=true`.

Exempel på vanliga stationer i Örebro-området:

| Station | loc_sig |
|---|---|
| Örebro C | Örc |
| Örebro Södra | Örs |
| Hallsberg | Hb |
| Kumla | Kml |
| Laxå | Lxå |

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
   /api/stream       /frontend/*                   ├─ GTFS-RT poll (var RT_POLL_SECONDS s)
                                                   │         ▼
                                                   │  ┌──────────────────┐
                                                   │  │   Trafiklab API  │
                                                   │  │  (samtrafiken)   │
                                                   │  └──────────────────┘
                                                   │
                                                   ├─ TV API poll (var TRAFIKVERKET_POLL_SECONDS s)
                                                   │         ▼
                                                   │  ┌──────────────────┐
                                                   │  │ Trafikverket API │
                                                   │  │ TrainPosition    │
                                                   │  │ TrainAnnouncement│
                                                   │  └──────────────────┘
                                                   │
                                                   └─ WebSocket (persistent)
                                                             ▼
                                                    ┌──────────────────┐
                                                    │   Oxyfi API      │
                                                    │  (TiB-positioner)│
                                                    └──────────────────┘
```

GTFS Static-data cachas i en Docker-volym (`gtfs-data`) och laddas endast om vid uppstart om cachen är äldre än `GTFS_REFRESH_HOURS` timmar. Statiska avgångar för aktuell dag laddas om vid midnatt.

Oxyfi-anslutningen är en persistent WebSocket med automatisk återanslutning (exponentiell backoff, max 20 försök). Tågpositioner buffras i minnet och inkluderas i samma SSE-ström som bussarna.

Trafikverket-integrationen pollar tre datakällor: TrainPosition (alla aktiva tåg i Sverige, filtreras sedan till konfigurerade stationer), TrainAnnouncement (avgångar/ankomster med realtidstider) och TrainStationMessage (stationsmeddelanden). Oxyfi-fordon matchas automatiskt mot Trafikverkets tjänstenummer via positionsnärhet (< 300 m) och tidsmatchning (± 20 min).
