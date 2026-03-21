# Arkitekturdokumentation — LTlive

LTlive är en realtidsapplikation för kollektivtrafikspårning i Örebro. Systemet aggregerar data från Trafiklab (bussar), Trafikverket (tåg) och Oxyfi (tågpositioner) och visar fordon live på en interaktiv karta.

## Arkitekturvyer

| Vy | Beskrivning |
|----|-------------|
| [01 — Systemöversikt](01-systemöversikt.md) | Syfte, kontextdiagram och nyckelkoncept |
| [02 — Komponentvy](02-komponentvy.md) | Backend- och frontendkomponenter med relationer |
| [03 — Dataflödesvy](03-dataflödesvy.md) | Hur data rör sig genom systemet |
| [04 — Driftsvy](04-driftsvy.md) | Docker, Nginx och infrastruktur |
| [05 — API-referens](05-api-referens.md) | Alla REST- och SSE-endpoints |
| [06 — Teknisk stack](06-teknisk-stack.md) | Teknologier, versioner och syfte |

## Snabböversikt

```
Trafiklab ──► bus_provider ──► GTFSStore ──┐
                                           │
Trafikverket ► train_provider ► TrainStore ├──► SSE Push ──► Webbläsare (Leaflet-karta)
                                           │
Oxyfi ──────► oxyfi.py ──────► TrainStore ─┘
```

---

*Senast uppdaterad: 2026-03-21*
