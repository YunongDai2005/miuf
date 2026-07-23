# Berlin Lost & Found

Berlin Lost & Found helps visitors work out which lost-property offices to contact after losing something on public transport or at a venue. It preserves the useful details of the day, routes the traveller to the right operators, and drafts German and English reports.

## Product flow

1. **Item** — Choose a category, describe the item, and enter the Berlin date and approximate time.
2. **Retrace** — Add transit lines and places manually, or read GPS and capture times from selected photos on the device.
3. **Contacts** — See each responsible operator or venue contact and the reason it applies. Passports and identity documents are also routed to Berlin Police and the traveller’s embassy.
4. **Report** — Open the verified official form, copy a report that includes boarding stop, alighting stop, departure time and direction, track progress, download a follow-up calendar reminder, or print a case sheet.

The current case and contact details are stored locally in the browser.

## Photo privacy

Photo originals never leave the device. Selecting photos only reads their EXIF GPS coordinates and capture times locally and matches nearby attractions.

Route comparison is a separate, optional action. Only after the traveller presses **Compare this route with VBB** are the route’s start, intermediate and end coordinates plus a departure timestamp sent to the community-run [`v6.vbb.transport.rest`](https://v6.vbb.transport.rest/) API. The full 2.9 MB transit geometry is also loaded only at that point.

## Contact-data trust

Every curated transport contact and operational field in [`app/lost-found/parties.ts`](app/lost-found/parties.ts) has:

- a `lastVerifiedAt` date;
- an official source URL in `fieldSources`;
- a visible source link in the report UI.

The current records were checked in July 2026. `npm run check:party-links` probes every official destination with `HEAD` (and a small `GET` fallback where required). The same check runs in CI and on a weekly schedule.

Venue website, phone and email candidates come from the bundled OpenStreetMap and Wikidata snapshots and are visibly marked as needing verification. No itinerary is sent to a venue-discovery service at runtime.

## Data and licences

- Transit lines, stops and geometry: VBB GTFS, CC BY 4.0.
- Attractions: © OpenStreetMap contributors, Open Database License (ODbL). Official website candidates may also use Wikidata (CC0).

`public/berlin-lines.json` is the lightweight first-load line index. `public/berlin-transit.json` contains the full geometry used by optional photo-route inference. `public/berlin-attractions.json` contains the OpenStreetMap attraction index.

## Local development

```bash
npm install
npm run dev
```

Fast inner-loop checks:

```bash
npm run test:unit
npm run lint
npm run typecheck
```

Full deployment-equivalent verification:

```bash
npm test
npm run check:party-links
```

## Refreshing transit data

Download the latest official VBB GTFS ZIP, then run:

```bash
python3 scripts/build-berlin-transit.py /path/to/GTFS.zip
```

The generator updates both the full geometry and the lightweight line index. If only `public/berlin-transit.json` has changed, regenerate its index with:

```bash
npm run data:lines
```

## Refreshing venue contacts

Refresh offline venue contact candidates from OSM/Overpass:

```bash
npm run data:venue-sources
```

To scan those official homepages for likely lost-property or contact pages, without publishing unreviewed links:

```bash
npm run data:discover-venues
```

The discovery output is a review queue in `data/venue-responsibility-candidates.json`; a candidate is not treated as verified automatically.
