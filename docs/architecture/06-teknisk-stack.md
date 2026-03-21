# 06 — Teknisk stack

## Backend

| Teknologi | Version | Syfte |
|-----------|---------|-------|
| Python | 3.12 | Programmeringsspråk |
| Flask | 3.1.0 | Webbramverk för REST API |
| flask-cors | 5.0.1 | Cross-Origin Resource Sharing |
| Gunicorn | 23.0.0 | WSGI-applikationsserver (1 worker, 16 trådar) |
| APScheduler | 3.11.0 | Bakgrundsschemaläggare för polling-uppgifter |
| gtfs-realtime-bindings | 1.0.0 | Protobuf-deserialisering av GTFS-RT-feeds |
| protobuf | 5.29.3 | Protocol Buffers-runtime |
| requests | 2.32.3 | HTTP-klient för externa API-anrop |
| websocket-client | 1.8.0 | WebSocket-klient för Oxyfi-anslutning |
| python-dotenv | 1.0.1 | Läser `.env`-filer till miljövariabler |

## Frontend

| Teknologi | Version | Syfte |
|-----------|---------|-------|
| Vanilla JavaScript | ES6 modules | Applikationslogik — inget ramverk |
| Leaflet.js | 1.9.4 | Interaktiv kartbibliotek |
| CartoDB Basemaps | — | Kartunderlag (mörkt/ljust tema) |
| CSS3 Custom Properties | — | Temafärger och responsiv design |
| EventSource API | — | Server-Sent Events för realtidsuppdateringar |
| localStorage API | — | Persistent lagring (favoriter, tema, sparade resor) |

## Infrastruktur

| Teknologi | Version | Syfte |
|-----------|---------|-------|
| Docker | — | Containerisering av backend och Nginx |
| Docker Compose | — | Orkestrering av tjänster och volymer |
| Nginx | Alpine | Reverse proxy, statisk filservering, rate limiting, säkerhetsheaders |
| Traefik | Extern | SSL/TLS-terminering med Let's Encrypt |

## Datakällor

| Källa | Leverantör | Protokoll | Data |
|-------|------------|-----------|------|
| GTFS Static | Trafiklab (Samtrafiken) | HTTP (ZIP) | Hållplatser, linjer, resor, tidtabeller, ruttgeometrier |
| GTFS-RT | Trafiklab (Samtrafiken) | HTTP (Protobuf) | Fordonspositioner, uppdaterade avgångstider, trafikstörningar |
| TrainAnnouncement | Trafikverket | REST (XML/JSON) | Tågavgångar/-ankomster, spår, förseningar, inställda tåg |
| TrainPosition | Trafikverket | SSE (JSON) | Realtids GPS-positioner för tåg |
| TrainStation | Trafikverket | REST (XML/JSON) | Stationsmetadata och stationsmeddelanden |
| Oxyfi Realtidspositionering | Oxyfi/Trafiklab | WebSocket (NMEA GPRMC) | Tågpositioner (lat/lon/speed/bearing) |

## Lagring

| Typ | Teknologi | Syfte | Plats |
|-----|-----------|-------|-------|
| In-memory stores | Python dicts + `threading.Lock` | Primär datalagring — snabb åtkomst, trådsäker | RAM |
| SQLite | sqlite3 | Analytikdata (förseningsobservationer, fordonsantal) | `/app/data/stats/analytics.db` |
| Filcache | ZIP + JSON-filer | GTFS-data och trafikbaslinjer | `/app/data/gtfs/`, `/app/data/traffic/` |
| Docker Volumes | Named volumes | Persistent lagring över container-omstarter | `gtfs-data`, `stats-data`, `traffic-data` |

## Arkitekturella val och motiveringar

### Varför in-memory stores istället för databas?

- All data är kortlivad (uppdateras var 5–60 sekund)
- Datamängden är hanterbar i RAM (hundratals hållplatser, tiotals fordon)
- Undviker latens och komplexitet med databas-queries
- `threading.Lock` ger tillräcklig trådsäkerhet för Gunicorns thread-baserade modell

### Varför Vanilla JS istället för React/Vue?

- Applikationen har begränsad UI-komplexitet (karta + paneler)
- Leaflet.js hanterar den huvudsakliga DOM-manipulationen
- Inget byggsteg behövs — snabb utvecklingscykel
- Mindre bundle-storlek och snabbare laddning

### Varför SSE istället för WebSocket?

- Envägs-kommunikation (server → klient) räcker
- SSE fungerar genom HTTP/1.1 utan speciell proxy-konfiguration
- Automatisk återanslutning inbyggd i `EventSource`
- Enklare att hantera i Nginx (jämfört med WebSocket-upgrade)

### Varför APScheduler?

- Enkel konfiguration av periodiska uppgifter
- `max_instances=1` förhindrar överlappande körningar
- Cron-stöd för dagliga uppgifter (tidtabellsuppdatering, dataretention)
- Körs i samma process som Flask (inget separat worker-system behövs)
