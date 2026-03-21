# Implementation Plan: Notifications/Alerts + Trip Planner

## Feature 1: Notifications & Alert Subscriptions

### Overview
Extend the existing GTFS-RT service alerts system with browser push notifications,
user-configurable subscriptions per favorite stop/route, and delay threshold alerts.

### Backend Changes

#### 1.1 New API endpoint: `/api/notifications/check` (GET)
**File:** `backend/api/notifications.py` (new blueprint)

- Accepts query params: `stops` (comma-sep stop_ids), `routes` (comma-sep route_ids), `delay_threshold` (seconds, default 300)
- Returns personalized alerts:
  - Service alerts affecting subscribed routes
  - Vehicles on subscribed routes exceeding delay threshold
  - Cancellations/deviations at subscribed stops (from Trafikverket)
- Lightweight endpoint for polling from notification worker

#### 1.2 Extend SSE with notification events
**File:** `backend/tasks/sse_tasks.py`

- Add new SSE event type: `notifications`
- Push delay alerts when a vehicle on any active route exceeds configurable threshold
- Push Trafikverket cancellation/deviation events for train stops

#### 1.3 Register blueprint
**File:** `backend/app.py`

- Register `notifications_bp`

### Frontend Changes

#### 1.4 Notification preferences module
**File:** `frontend/modules/notifications.js` (new)

- `NotificationPrefs` stored in localStorage:
  ```js
  { enabled: bool, delayThreshold: 300, stops: [stop_ids], routes: [route_ids] }
  ```
- `requestPermission()` — Browser Notification API permission
- `checkAndNotify()` — called on SSE alert/notification events
- `showBrowserNotification(title, body, data)` — creates Notification with click-to-focus
- Deduplication: track shown notification IDs to avoid repeats

#### 1.5 Notification settings UI
**File:** `frontend/index.html` + `frontend/modules/panels.js`

- Add notification bell icon to topbar (next to favorites)
- Notification panel with:
  - Master toggle (enable/disable)
  - Delay threshold slider (1-15 min)
  - List of subscribed stops/routes with toggles
  - "Subscribe" button added to stop departure panel and line panel
- Badge counter on bell icon for unread notifications

#### 1.6 Wire into existing modules
**Files:** `frontend/app.js`, `frontend/modules/sse.js`, `frontend/modules/favorites.js`

- SSE: listen for `notifications` event, forward to notifications module
- Favorites: add "notify me" toggle per favorite stop/saved trip
- App.js: register window callbacks, init notification module

### CSS
- Notification bell icon + badge styles
- Notification panel (reuse existing panel/bottom-sheet pattern)
- Toast-style in-app notification banner

---

## Feature 2: Trip Planner

### Overview
GTFS-based journey planner: select origin + destination stops, get step-by-step
itineraries with transfers, times, and route visualization on the map.

### Backend Changes

#### 2.1 Load transfer & stop_times data
**File:** `backend/gtfs_loader.py`

- Load `transfers.txt` if present (from_stop_id, to_stop_id, transfer_type, min_transfer_time)
- Build `stop_times_by_trip`: trip_id → sorted list of {stop_id, stop_sequence, arrival_time, departure_time}
- Build `trips_by_stop`: stop_id → [{trip_id, departure_time, stop_sequence}] (for today's active services)
- Store in gtfs_store

#### 2.2 Extend GTFS store
**File:** `backend/stores/gtfs_store.py`

- Add fields: `stop_times_by_trip`, `trips_by_stop`, `transfers`, `stop_distances` (precomputed walking distances between nearby stops)

#### 2.3 Trip planner API endpoint
**File:** `backend/api/planner.py` (new blueprint)

- **GET `/api/plan`** — Main planning endpoint
  - Params: `from_stop` (stop_id), `to_stop` (stop_id), `time` (HH:MM, default now), `date` (YYYY-MM-DD, default today), `max_transfers` (0-3, default 2)
  - Algorithm: Time-expanded RAPTOR (Round-based Public Transit Optimized Router)
    - Round 0: Direct trips from origin to destination
    - Round 1+: Transfers at intermediate stops
    - Walking transfers between nearby stops (< 300m, ~4 min walk)
  - Returns up to 5 itineraries sorted by arrival time
  - Each itinerary: `{departure_time, arrival_time, duration_min, transfers, legs[]}`
  - Each leg: `{type: "transit"|"walk", from_stop, to_stop, route_id, route_short_name, route_color, departure_time, arrival_time, headsign, stop_count, shape_points[], intermediate_stops[]}`

- **GET `/api/plan/stops`** — Search stops by name for autocomplete
  - Params: `q` (search string), `limit` (default 8)
  - Returns matching stops with coordinates

#### 2.4 RAPTOR algorithm implementation
**File:** `backend/raptor.py` (new)

- `plan_journey(from_stop, to_stop, departure_time, max_transfers)`:
  - Build reachability from origin with each round adding one transfer
  - Use `trips_by_stop` for quick lookup of departures from any stop
  - Use `stop_times_by_trip` to trace each trip forward to destination
  - Walking transfers: precompute pairs of stops within 300m using haversine
  - Pareto-optimal: keep only trips that are better in arrival_time or fewer transfers
  - Return list of Journeys with legs

#### 2.5 Register blueprint
**File:** `backend/app.py`

- Register `planner_bp`

### Frontend Changes

#### 2.6 Trip planner panel
**File:** `frontend/modules/planner.js` (new)

- **Search UI**: Two autocomplete inputs (from/to) with swap button
- **Time picker**: departure time, "now" button, date selector
- **Options**: max transfers toggle
- **Results list**: Expandable itinerary cards showing:
  - Total duration, departure → arrival time
  - Color-coded legs with route badges
  - Transfer indicators with walking time
  - Click to expand: intermediate stops, platform info
- **Map integration**: Click itinerary → draw route on map with colored polylines per leg, markers at transfer points
- **"Plan from here" / "Plan to here"**: Context actions on stop departure panels

#### 2.7 Trip planner UI in index.html
**File:** `frontend/index.html`

- Add planner icon to topbar (route/directions icon)
- New panel `#planner-panel` with bottom sheet behavior
- Planner results container

#### 2.8 Map route drawing
**File:** `frontend/modules/planner.js`

- `drawItinerary(legs)` — Leaflet polylines per leg (colored by route)
- Walking legs: dashed gray line
- Transfer markers: circle markers at transfer stops
- `clearItinerary()` — remove drawn elements
- Fit map bounds to itinerary

#### 2.9 Wire into existing modules
**Files:** `frontend/app.js`, `frontend/modules/panels.js`, `frontend/modules/stops.js`

- App.js: init planner, register callbacks
- Panels: "Plan from here" button in stop departure popup
- Stops: right-click/long-press context → "Directions from/to here"

### CSS
- Planner panel styles (reuse panel pattern)
- Autocomplete dropdown styles
- Itinerary result cards (leg colors, transfer indicators)
- Walking leg dashed lines
- Time picker styling

---

## Implementation Order

1. **Phase 1 — Trip Planner Backend** (most complex, foundational)
   - 2.1: Load stop_times + transfers in gtfs_loader
   - 2.2: Extend gtfs_store
   - 2.4: RAPTOR algorithm
   - 2.3: Planner API endpoint

2. **Phase 2 — Trip Planner Frontend**
   - 2.7: HTML panel structure
   - 2.6: Planner module (search, results, API calls)
   - 2.8: Map route drawing
   - 2.9: Wire into existing modules

3. **Phase 3 — Notifications Backend**
   - 1.1: Notifications API endpoint
   - 1.2: SSE notification events

4. **Phase 4 — Notifications Frontend**
   - 1.4: Notification preferences module
   - 1.5: Notification panel UI
   - 1.6: Wire into SSE + favorites
