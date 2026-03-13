# LTlive

Live-kartan som visar alla stadsbussar och länsbussar i Örebro kommun i realtid.

## Funktioner

- Leaflet-karta med CartoDB-basemap (mörkt tema)
- Färgade prickar som visar fordonspositioner i realtid (uppdateras var 5:e sekund)
- Stationsmarkeringar (hållplatser)
- Linjesträckningar (shapes från GTFS)
- Linjefärger från GTFS-data
- Filtrering per linje
- Störningsinformation (ServiceAlerts)
- Responsiv design (mobil + desktop)

## Tech stack

- **Backend**: Python / Flask — hämtar GTFS static + GTFS-RT data från Trafiklab
- **Frontend**: Leaflet.js med CartoDB tiles
- **Webbserver**: Nginx (reverse proxy + static files)
- **Container**: Docker Compose

## Data

Data hämtas från [Trafiklab](https://trafiklab.se) via GTFS Regional API:
- **GTFS Static** (orebro) — linjer, hållplatser, tidtabeller, linjesträckningar
- **GTFS-RT VehiclePositions** — realtids GPS-positioner
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

## Utveckling

### Utan Docker

Backend:
```bash
cd backend
pip install -r requirements.txt
TRAFIKLAB_GTFS_RT_KEY=... TRAFIKLAB_GTFS_STATIC_KEY=... python app.py
```

Frontend serveras av nginx i Docker, eller kör en enkel HTTP-server:
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
