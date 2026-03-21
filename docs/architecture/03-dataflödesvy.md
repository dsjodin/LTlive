# 03 — Dataflödesvy

## Huvuddataflöde

```mermaid
flowchart LR
    subgraph Externa["Externa API:er"]
        TL_Static["Trafiklab<br/>GTFS Static (ZIP)"]
        TL_RT["Trafiklab<br/>GTFS-RT (Protobuf)"]
        TV_REST["Trafikverket<br/>REST (XML)"]
        TV_SSE["Trafikverket<br/>SSE (JSON)"]
        OX["Oxyfi<br/>WebSocket (NMEA)"]
    end

    subgraph Providers["Providers"]
        BP["bus_provider"]
        TP["train_provider"]
        OP["oxyfi"]
    end

    subgraph Stores["Stores"]
        GS["GTFSStore"]
        VS["VehicleStore"]
        TS["TrainStore"]
    end

    subgraph Push["Push-lager"]
        SSE_Tasks["sse_tasks.py"]
    end

    subgraph Client["Klient"]
        Browser["Webbläsare<br/>(EventSource)"]
    end

    TL_Static -->|"Var 24:e timme"| BP
    TL_RT -->|"Var 5:e sekund"| BP
    TV_REST -->|"Var 60:e sekund"| TP
    TV_SSE -->|"Kontinuerlig ström"| TP
    OX -->|"Kontinuerlig ström"| OP

    BP --> GS
    BP --> VS
    TP --> TS
    OP --> TS

    VS --> SSE_Tasks
    TS --> SSE_Tasks
    GS --> SSE_Tasks

    SSE_Tasks -->|"SSE events:<br/>vehicles, vehicles_delta,<br/>alerts, traffic"| Browser
```

## Buss-dataflöde

### Statisk data (GTFS Static)

```mermaid
sequenceDiagram
    participant Scheduler as APScheduler
    participant BP as bus_provider
    participant TL as Trafiklab
    participant GS as GTFSStore

    Scheduler->>BP: refresh_gtfs_static() [var 24:e timme]
    BP->>TL: GET /gtfs/{operator}/{operator}.zip
    TL-->>BP: ZIP-fil (routes.txt, stops.txt, trips.txt, stop_times.txt, shapes.txt)
    BP->>BP: Packa upp och parsa CSV-filer
    BP->>GS: Uppdatera routes, stops, trips, shapes, trip_headsigns
    BP->>GS: Beräkna static_stop_departures, static_stop_arrivals
```

### Realtidsdata (GTFS-RT)

```mermaid
sequenceDiagram
    participant Scheduler as APScheduler
    participant BP as bus_provider
    participant TL as Trafiklab
    participant VS as VehicleStore

    Scheduler->>BP: poll_realtime() [var 5:e sekund]
    BP->>TL: GET VehiclePositions.pb
    BP->>TL: GET TripUpdates.pb
    BP->>TL: GET ServiceAlerts.pb
    TL-->>BP: Protobuf-svar
    BP->>BP: Deserialisera med gtfs-realtime-bindings
    BP->>VS: Uppdatera vehicles, stop_departures, alerts
```

## Tåg-dataflöde

### Trafikverket (annonseringar + positioner)

```mermaid
sequenceDiagram
    participant Scheduler as APScheduler
    participant TP as train_provider
    participant TV as Trafikverket API
    participant TS as TrainStore

    Scheduler->>TP: poll_trafikverket() [var 60:e sekund]
    TP->>TV: POST TrainAnnouncement (avgångar/ankomster)
    TV-->>TP: JSON med tågannonseringar
    TP->>TS: Uppdatera announcements per station

    Note over TP,TV: Separat tråd vid uppstart
    TP->>TV: POST TrainStation (metadata)
    TV-->>TP: Stationsdata
    TP->>TS: Uppdatera stations

    Note over TP,TV: Kontinuerlig SSE-ström
    TP->>TV: SSE TrainPosition
    TV-->>TP: Realtidspositioner (lat/lon)
    TP->>TS: Uppdatera positions
```

### Oxyfi (WebSocket-positioner)

```mermaid
sequenceDiagram
    participant OX as Oxyfi WebSocket
    participant OP as oxyfi.py
    participant TS as TrainStore

    Note over OX,OP: Persistent WebSocket-anslutning
    OX-->>OP: NMEA GPRMC-meddelande (lat, lon, speed, bearing, vehicleId, trainNo)
    OP->>OP: Parsa GPRMC + extrafält
    OP->>TS: Uppdatera tågposition
```

## Realtidsuppdateringar till klient

```mermaid
sequenceDiagram
    participant SSE as sse_tasks.py
    participant VS as VehicleStore
    participant TS as TrainStore
    participant Q as Klientkö (Queue)
    participant Browser as Webbläsare

    Note over SSE: push_vehicle_update() körs var 5:e sekund
    SSE->>VS: Hämta aktuella fordonspositioner
    SSE->>TS: Hämta tågpositioner (Oxyfi + Trafikverket)
    SSE->>SSE: Beräkna delta (nya, uppdaterade, borttagna)
    SSE->>Q: Lägg meddelande i alla klienters köer

    Note over Q,Browser: Klienten läser från /api/stream
    Q-->>Browser: event: vehicles_delta
    Browser->>Browser: Uppdatera Leaflet-markörer
```

### SSE Event-typer

| Event | Innehåll | Frekvens |
|-------|----------|----------|
| `vehicles` | Fullständig lista av alla fordon | Vid anslutning + periodiskt |
| `vehicles_delta` | `{updated: [...], removed: [...]}` | Var 5:e sekund |
| `alerts` | Aktiva trafikstörningar | Vid ändring |
| `traffic` | GeoJSON med trafikstatus | Periodiskt |

### Fallback-polling

Om SSE inte är tillgängligt (t.ex. proxy-problem) faller frontend tillbaka till polling av `/api/vehicles` med konfigurerbart intervall (standard 5000 ms).

## Avgångstavla-flöde

```mermaid
sequenceDiagram
    participant User as Användare
    participant FE as Frontend
    participant BE as Backend (/api/departures)
    participant GS as GTFSStore
    participant VS as VehicleStore
    participant TS as TrainStore

    User->>FE: Klickar på hållplats
    FE->>BE: GET /api/departures/{stop_id}
    BE->>GS: Hämta statiska avgångar + linje-/reseinformation
    BE->>VS: Hämta realtidsavgångar
    BE->>TS: Hämta Trafikverket-annonseringar (om tågstation)
    BE->>BE: Sammanfoga statisk + RT data (merge_rt_static)
    BE->>BE: Matcha GTFS-avgångar med TV-annonseringar (spår, inställt, via)
    BE-->>FE: JSON med avgångslista
    FE->>FE: Visa i hållplatspanel / avgångstavla
```

## Bakgrundsschemaläggning

| Uppgift | Funktion | Intervall | Beskrivning |
|---------|----------|-----------|-------------|
| GTFS-RT polling | `poll_realtime()` | `RT_POLL_SECONDS` (standard 5s) | Hämtar fordonspositioner, trip updates och service alerts |
| SSE-push | `push_vehicle_update()` | `RT_POLL_SECONDS` | Sammanfogar bussar/tåg och pushar till SSE-klienter |
| GTFS Static refresh | `refresh_gtfs_static()` | `GTFS_REFRESH_HOURS` (standard 24h) | Laddar ner ny GTFS-data |
| Statiska avgångar | `refresh_static_departures()` | Dagligen kl 00:01 | Laddar om dagens tidtabell |
| GTFS retry | `retry_gtfs_if_needed()` | 60s | Exponentiell backoff vid misslyckad GTFS-laddning |
| Trafikverket | `poll_trafikverket()` | `TRAFIKVERKET_POLL_SECONDS` (standard 60s) | Hämtar tågannonseringar och stationsmeddelanden |
| Trafikbaslinje | `save_baseline()` | 30 min | Sparar trafikbaslinjedata till fil |
| Dataretention | `cleanup_old_data()` | Dagligen kl 03:00 | Rensar analysdata äldre än 30 dagar |
