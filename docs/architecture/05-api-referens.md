# 05 — API-referens

Alla endpoints nås via `/api/`-prefixet. Svar returneras som JSON om inget annat anges.

---

## Fordon och realtid

### `GET /api/vehicles`

Returnerar aktuella fordonspositioner (bussar + tåg) med linjeinformation.

**Svar:**
```json
{
  "vehicles": [
    {
      "vehicle_id": "9031005901234",
      "lat": 59.2753,
      "lon": 15.2134,
      "bearing": 180,
      "speed": 8.5,
      "route_id": "9011005010100",
      "route_short_name": "1",
      "route_color": "E4002B",
      "trip_id": "9015005010100_1",
      "trip_headsign": "Brickebacken",
      "delay_seconds": 120,
      "is_realtime": true,
      "update_time": 1711018200
    }
  ],
  "timestamp": 1711018200,
  "count": 42
}
```

### `GET /api/stream`

Server-Sent Events (SSE) ström för realtidsuppdateringar. Anslut via `EventSource`.

**Event-typer:**

| Event | Beskrivning |
|-------|-------------|
| `vehicles` | Fullständig fordonslista (vid anslutning + periodiskt) |
| `vehicles_delta` | Inkrementell uppdatering: `{updated: [...], removed: [...], timestamp}` |
| `alerts` | Trafikstörningar: `{alerts: [...], count}` |
| `traffic` | GeoJSON med trafikstatus |

**Begränsningar:**
- Max 4 SSE-anslutningar per IP
- Keepalive-ping var 25:e sekund om ingen data
- Kökapacitet: 20 meddelanden per klient

---

## Avgångar och ankomster

### `GET /api/departures/<stop_id>`

Avgångar för en hållplats, anrikade med linje- och Trafikverket-data.

**Parametrar:**

| Param | Typ | Standard | Beskrivning |
|-------|-----|----------|-------------|
| `limit` | int | 10 | Max antal rader (1–30) |
| `route_type` | string | — | `"train"` för att filtrera till tåg |

**Svar:**
```json
{
  "stop_id": "740000400",
  "departures": [
    {
      "route_short_name": "T53",
      "trip_short_name": "8753",
      "route_color": "2C6E37",
      "route_text_color": "FFFFFF",
      "operator": "ARRIVA",
      "product": "TiB",
      "headsign": "Hallsberg",
      "departure_time": 1711018800,
      "scheduled_time": 1711018500,
      "delay_minutes": 5,
      "is_realtime": true,
      "trip_id": "9015005010100_1",
      "platform": "2",
      "track_changed": false,
      "canceled": false,
      "deviation": [],
      "other_info": [],
      "preliminary": false,
      "traffic_type": "Tåg",
      "via": ["Kumla"]
    }
  ],
  "count": 1
}
```

**Beteende:**
- Om `stop_id` är en föräldrastation (`location_type=1`) slås barnhållplatsernas avgångar ihop automatiskt
- Trafikverket-annonseringar matchas mot GTFS-avgångar baserat på tidsfönster (±600s)
- Operatörer utanför GTFS (SJ, Mälartåg) visas som "TV-only"-avgångar vid tågfiltrering

### `GET /api/arrivals/<stop_id>`

Ankomster för en hållplats (främst tåg).

**Parametrar:** Samma som departures.

**Extra fält i svar:**
- `origin` — Avgångsstation
- `arrival_time` — Faktisk/beräknad ankomsttid
- `gps_at_station` — `true`/`false`/`null` — om tågets GPS visar att det är vid stationen

### `GET /api/station-messages/<stop_id>`

Trafikverkets stationsmeddelanden (utrop och plattformsmeddelanden).

**Svar:**
```json
{
  "announcements": [{"body": "...", "media_type": "Utrop", "status": "Normal"}],
  "platform_messages": {
    "2": [{"body": "Tåget till Hallsberg ankommer spår 2", "status": "Normal"}]
  },
  "station_name": "Örebro C"
}
```

---

## Hållplatser

### `GET /api/stops`

Alla hållplatser, valfritt filtrerade per linje.

**Parametrar:**

| Param | Typ | Beskrivning |
|-------|-----|-------------|
| `route_ids` | string | Kommaseparerade route_id:n |

**Svar:**
```json
{
  "stops": [
    {
      "stop_id": "740000400",
      "stop_name": "Örebro C",
      "stop_lat": 59.2753,
      "stop_lon": 15.2134,
      "location_type": 1,
      "parent_station": null,
      "platform_code": null
    }
  ],
  "count": 450
}
```

### `GET /api/stops/stations`

Enbart föräldrastationer (`location_type=1`).

### `GET /api/stops/next-departure`

Nästa avgång per hållplats (för kartbadges). Returnerar en dict med `stop_id` som nyckel.

**Svar:**
```json
{
  "740000400": {
    "time": 1711018800,
    "minutes": 5,
    "route_short_name": "1",
    "route_color": "E4002B",
    "route_text_color": "FFFFFF",
    "headsign": "Brickebacken"
  }
}
```

### `GET /api/nearby-departures`

Hållplatser och avgångar nära en GPS-position.

**Parametrar:**

| Param | Typ | Standard | Beskrivning |
|-------|-----|----------|-------------|
| `lat` | float | — | Latitud (obligatorisk) |
| `lon` | float | — | Longitud (obligatorisk) |
| `radius` | float | 400 | Sökradie i meter (50–5000) |

**Svar:**
```json
{
  "stops": [
    {
      "stop_id": "9022005001001",
      "stop_name": "Stortorget",
      "distance_m": 120,
      "departures": [
        {
          "route_short_name": "1",
          "headsign": "Brickebacken",
          "departure_time": 1711018800,
          "minutes": 3,
          "is_realtime": true
        }
      ]
    }
  ]
}
```

---

## Linjer och ruttgeometrier

### `GET /api/routes`

Busslinjer (GTFS `route_type` 3 eller 700–799).

### `GET /api/routes/trains`

Tåglinjer (GTFS `route_type` 2 eller 100–199).

### `GET /api/routes/all`

Alla linjer oavsett typ.

**Svar (alla routes-endpoints):**
```json
{
  "routes": [
    {
      "route_id": "9011005010100",
      "route_short_name": "1",
      "route_long_name": "Brickebacken - Universitetssjukhuset",
      "route_color": "E4002B",
      "route_text_color": "FFFFFF",
      "route_type": 3
    }
  ],
  "count": 25
}
```

### `GET /api/shapes/<route_id>`

Ruttgeometri (shape-koordinater) för en specifik linje.

### `GET /api/shapes/trains`

Representativa tåglinjegeometrier (den mest detaljerade shapen per riktning per linje).

### `GET /api/shapes/bulk`

Bulk-hämtning av shapes för flera linjer.

**Parametrar:**

| Param | Typ | Beskrivning |
|-------|-----|-------------|
| `route_ids` | string | Kommaseparerade route_id:n (max 2000 tecken) |

---

## Linjeinformation

### `GET /api/line/<route_id>`

Detaljerad information om en specifik linje.

**Svar:**
```json
{
  "route": { "route_id": "...", "route_short_name": "1", "..." : "..." },
  "shapes": { "shape_1": [[59.27, 15.21], ...] },
  "active_vehicles": [{ "vehicle_id": "...", "lat": 59.27, "..." : "..." }],
  "trip_count": 45
}
```

### `GET /api/line-departures/<route_id>`

Tidtabell hållplats-för-hållplats per riktning.

**Svar:**
```json
{
  "route_id": "9011005010100",
  "route_short_name": "1",
  "route_color": "E4002B",
  "directions": [
    {
      "direction_id": "0",
      "headsign": "Brickebacken",
      "stops": [
        {"stop_id": "...", "stop_name": "Stortorget", "time": 1711018800, "minutes": 5, "is_realtime": true}
      ]
    }
  ]
}
```

---

## Status och konfiguration

### `GET /api/health`

Hälsokontroll (används av Docker healthcheck).

**Svar:** `{"status": "ok", "gtfs_loaded": true}`

### `GET /api/status`

Frontend-konfiguration från backend.

**Svar:**
```json
{
  "gtfs_loaded": true,
  "gtfs_error": false,
  "routes_count": 25,
  "nearby_radius_meters": 400,
  "frontend_poll_interval_ms": 5000,
  "map_center_lat": 59.2753,
  "map_center_lon": 15.2134,
  "map_default_zoom": 13
}
```

### `GET /api/alerts`

Aktiva trafikstörningar (GTFS-RT ServiceAlerts).

**Svar:** `{"alerts": [...], "count": 2}`

---

## Trafik

### `GET /api/traffic`

GeoJSON FeatureCollection med infererad trafikpåverkan baserat på bussrörelser.

**Parametrar:**

| Param | Typ | Standard | Beskrivning |
|-------|-----|----------|-------------|
| `min_confidence` | float | 0.3 | Minsta konfidensnivå |
| `min_severity` | string | "low" | Minsta allvarlighetsgrad: `none`, `low`, `medium`, `high` |

### `GET /api/traffic/summary`

Sammanfattning av trafikstatus (antal segment per allvarlighetsgrad).

### `GET /api/traffic/monitor`

Dashboard-data för trafikövervakning (segment, observationer, baslinjetäckning, aktiva fordon).

### `GET /api/traffic/zones`

Zonpositioner (terminaler, signaler) för kartöverlägg.

---

## Statistik

### `POST /api/stats/visit`

Registrera sidbesök.

**Body:** `{"session_id": "abc123", "page": "/"}`

**Svar:** `204 No Content`

### `POST /api/stats/leave`

Registrera sessionsavslut.

**Body:** `{"session_id": "abc123", "duration": 300}`

### `GET /api/stats`

Besöksstatistik (senaste 30 dagarna).

---

## Debug (LAN-only)

Kräver `ENABLE_DEBUG_ENDPOINTS=true` och åtkomst från lokalt nätverk.

| Endpoint | Beskrivning |
|----------|-------------|
| `GET /api/debug/status` | Full diagnostikinformation |
| `GET /api/debug/matching` | Fordon-till-resa-matchningsanalys |
| `GET /api/debug/agencies` | GTFS agencies |
| `GET /api/debug/stops` | Alla GTFS-hållplatser |
| `GET /api/debug/tv-stations` | Trafikverkets stationskoder |
| `GET /api/debug/gtfs-status` | GTFS-laddningsstatus |
| `GET /api/traffic/debug` | Trafikinferens-diagnostik |
