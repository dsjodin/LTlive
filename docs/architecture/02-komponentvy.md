# 02 — Komponentvy

## Backend-arkitektur

```mermaid
graph TB
    subgraph Flask["Flask-applikation (app.py)"]
        subgraph Blueprints["API Blueprints"]
            VehiclesBP["vehicles<br/>/api/vehicles, /api/stream"]
            DeparturesBP["departures<br/>/api/departures, /api/arrivals"]
            StopsBP["stops<br/>/api/stops, /api/nearby-departures"]
            RoutesBP["routes_shapes<br/>/api/routes, /api/shapes"]
            StatusBP["status<br/>/api/health, /api/status, /api/line"]
            TrafficBP["traffic<br/>/api/traffic"]
            WeatherBP["weather<br/>/api/weather"]
            AnalyticsBP["analytics_api<br/>/api/analytics"]
            DebugBP["debug<br/>/api/debug/*"]
        end
    end

    subgraph Providers["Dataproviders"]
        BusProv["bus_provider.py<br/>GTFS Static + GTFS-RT"]
        TrainProv["train_provider.py<br/>Trafikverket REST/SSE"]
        OxyfiProv["oxyfi.py<br/>WebSocket-klient"]
    end

    subgraph Stores["In-memory Stores"]
        GTFS["GTFSStore<br/>routes, stops, trips, shapes,<br/>trip_headsigns, static_departures"]
        Vehicle["VehicleStore<br/>vehicles, vehicle_trips,<br/>stop_departures, alerts"]
        Train["TrainStore<br/>announcements, positions,<br/>stations, messages"]
        Traffic["TrafficStore<br/>segments, segment_states,<br/>baseline_speeds"]
        Cache["Cache<br/>TTL-baserad response-cache"]
    end

    subgraph Tasks["Bakgrundsuppgifter"]
        Scheduler["APScheduler<br/>(scheduler.py)"]
        SSETasks["sse_tasks.py<br/>Klientregister + push-logik"]
    end

    subgraph Support["Stödmoduler"]
        Config["config.py<br/>Miljövariabler"]
        Enrichment["enrichment.py<br/>Fordonsanrikning"]
        TrainLogic["train_logic.py<br/>Tågmatchning"]
        TrafficInf["traffic_inference.py<br/>Trafikinferens"]
        Analytics["analytics.py<br/>SQLite-analys"]
    end

    Scheduler --> BusProv
    Scheduler --> TrainProv
    Scheduler --> SSETasks
    Scheduler --> TrafficInf

    BusProv --> GTFS
    BusProv --> Vehicle
    TrainProv --> Train
    OxyfiProv --> Train

    Blueprints --> Stores
    Blueprints --> Enrichment
    Blueprints --> TrainLogic
    SSETasks --> Vehicle
    SSETasks --> Train
```

### Backend-komponenter i detalj

#### API Blueprints (`backend/api/`)

| Blueprint | Fil | Endpoints | Ansvar |
|-----------|-----|-----------|--------|
| vehicles | `vehicles.py` | `/api/vehicles`, `/api/stream` | Fordonspositioner och SSE-ström |
| departures | `departures.py` | `/api/departures/<id>`, `/api/arrivals/<id>`, `/api/station-messages/<id>` | Avgångs-/ankomsttavlor med Trafikverket-anrikning |
| stops | `stops.py` | `/api/stops`, `/api/stops/stations`, `/api/stops/next-departure`, `/api/nearby-departures` | Hållplatsdata och GPS-baserad sökning |
| routes_shapes | `routes_shapes.py` | `/api/routes`, `/api/routes/trains`, `/api/routes/all`, `/api/shapes/*` | Linjer och ruttgeometrier |
| status | `status.py` | `/api/health`, `/api/status`, `/api/alerts`, `/api/line/<id>`, `/api/line-departures/<id>`, `/api/stats/*` | Hälsokontroll, konfiguration, linjeinformation, besöksstatistik |
| traffic | `traffic.py` | `/api/traffic`, `/api/traffic/summary`, `/api/traffic/monitor`, `/api/traffic/zones`, `/api/traffic/debug` | Trafikinferens-data som GeoJSON |
| weather | `weather.py` | `/api/weather` | Väderdata |
| analytics_api | `analytics_api.py` | `/api/analytics/*` | Förseningsanalys och trender |
| debug | `debug.py` | `/api/debug/*` | Diagnostik (LAN-only) |

#### Dataproviders (`backend/providers/`)

| Provider | Fil | Datakälla | Protokoll | Lagring |
|----------|-----|-----------|-----------|---------|
| bus_provider | `bus_provider.py` | Trafiklab (Samtrafiken) | HTTP + Protobuf | GTFSStore, VehicleStore |
| train_provider | `train_provider.py` | Trafikverket | REST (XML) + SSE | TrainStore |
| oxyfi | `oxyfi.py` | Oxyfi | WebSocket (NMEA GPRMC) | TrainStore |

#### In-memory Stores (`backend/stores/`)

| Store | Fil | Nyckeldata | Trådsäkerhet |
|-------|-----|------------|-------------|
| GTFSStore | `gtfs_store.py` | Linjer, hållplatser, resor, shapes, tidtabeller | `threading.Lock` |
| VehicleStore | `vehicle_store.py` | Fordonspositioner, realtidsavgångar, larm | `threading.Lock` |
| TrainStore | `train_store.py` | Tågannonseringar, GPS-positioner, stationsdata | `threading.Lock` |
| TrafficStore | `traffic_store.py` | Vägsegment, trafikstatus, baslinjer | `threading.Lock` |
| Cache | `cache.py` | TTL-baserade API-svar (4–30s) | `threading.Lock` |

---

## Frontend-arkitektur

```mermaid
graph TB
    subgraph Pages["HTML-sidor"]
        Index["index.html<br/>Livekarta"]
        Busboard["busboard.html<br/>Bussavgångar"]
        Trainboard["trainboard.html<br/>Tågavgångar"]
        Dashboard["dashboard.html<br/>Dashboard"]
        Stats["stats.html<br/>Statistik"]
        Diag["diag.html<br/>Diagnostik"]
        AnalPage["analytics-page.html<br/>Analys"]
    end

    subgraph Core["Kärnmoduler"]
        State["state.js<br/>Centraliserat tillstånd"]
        API["api.js<br/>HTTP-klient"]
        SSE["sse.js<br/>SSE-anslutning + fallback"]
    end

    subgraph Map["Kartmoduler"]
        MapCore["mapCore.js<br/>Leaflet-initiering"]
        Vehicles["vehicles.js<br/>Fordonsmarkörer + animering"]
        Stops["stops.js<br/>Hållplatsladdning + rutter"]
        Colors["colors.js<br/>Färghantering"]
    end

    subgraph UI["UI-komponenter"]
        Panels["panels.js<br/>Hållplats-/linjepaneler"]
        Filters["filters.js<br/>Linjefiltrering"]
        BottomSheet["bottomSheet.js<br/>Mobil bottom sheet"]
        Search["search.js<br/>Hållplatssökning"]
    end

    subgraph Features["Funktioner"]
        Favorites["favorites.js<br/>Favorithållplatser (localStorage)"]
        Nearby["nearby.js<br/>GPS-baserade hållplatser"]
        Delays["delays.js<br/>Förseningsöversikt"]
        TrafficMod["traffic.js<br/>Trafiklagret"]
        Weather["weather.js<br/>Väderwidget"]
        TrainAnn["trainAnnounce.js<br/>Tågannonseringar"]
        DashMod["dashboard.js<br/>Dashboard-data"]
    end

    Index --> Core
    Index --> Map
    Index --> UI
    Index --> Features

    Core --> State
    Map --> State
    UI --> State
    Features --> State

    API --> |"fetch()"|Backend["Backend API"]
    SSE --> |"EventSource"|Backend
```

### Frontend-moduler i detalj

#### Kärnmoduler

| Modul | Fil | Ansvar |
|-------|-----|--------|
| state | `modules/state.js` | Centraliserat applikationstillstånd — ett mutbart objekt som alla moduler importerar |
| api | `modules/api.js` | Wrappers kring `fetch()` för alla API-anrop |
| sse | `modules/sse.js` | SSE-anslutning med automatisk fallback till polling |

#### Kartmoduler

| Modul | Fil | Ansvar |
|-------|-----|--------|
| mapCore | `modules/mapCore.js` | Leaflet-kartinitiering, tile-lager (CartoDB dark/light) |
| vehicles | `modules/vehicles.js` | Fordonsmarkörer med animering, spår-rendering, popup-logik |
| stops | `modules/stops.js` | Hållplatsmarkörer, ruttlinjer, badge-uppdatering |
| colors | `modules/colors.js` | Linjefärger från GTFS med custom overrides |

#### UI-komponenter

| Modul | Fil | Ansvar |
|-------|-----|--------|
| panels | `modules/panels.js` | Paneler för hållplatsinfo, linjeinformation, fordons-popups |
| filters | `modules/filters.js` | Filterknappar per linje och filtreringslogik |
| bottomSheet | `modules/bottomSheet.js` | Dragbar bottom sheet för mobil-UI |
| search | `modules/search.js` | Hållplatssökning med autocomplete |

#### Funktionsmoduler

| Modul | Fil | Ansvar |
|-------|-----|--------|
| favorites | `modules/favorites.js` | Sparade favorithållplatser (localStorage) |
| nearby | `modules/nearby.js` | GPS-baserad "hållplatser nära mig" |
| delays | `modules/delays.js` | Översikt av mest försenade fordon |
| traffic | `modules/traffic.js` | Trafikinferenslagret på kartan |
| weather | `modules/weather.js` | Väderwidget |
| trainAnnounce | `modules/trainAnnounce.js` | Tågavgångs-/ankomsttavla |
| dashboard | `modules/dashboard.js` | Dashboard-panelens data och rendering |

### State-hantering

Frontend använder ett **centraliserat tillståndsobjekt** (`state.js`) utan ramverk:

```javascript
// state.js — förenklat exempel
export default {
    map: null,              // Leaflet-kartinstans
    vehicles: {},           // Fordonsmarkörer (vehicle_id → marker)
    stops: {},              // Hållplatsdata
    activeFilters: new Set(), // Aktiva linjefilter
    favorites: [],          // Sparade favoriter
    darkMode: true,         // Mörkt/ljust tema
    // ...
};
```

**Kommunikation mellan moduler** sker via:
- Direkt import av `state`-objektet
- Callbacks registrerade på `window._xxx` (för att undvika cirkulära beroenden)
- `app.js` fungerar som orkestrator som kopplar ihop alla moduler
