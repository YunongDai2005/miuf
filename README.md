# Berlin Lost & Found

Berlin Lost & Found helps visitors work out which lost-property offices to contact after losing something on public transport or at a venue. It preserves the useful details of the day, routes the traveller to the right operators, and drafts German and English reports.

## Product flow

1. **Describe** — Choose a category, describe the item, and enter the Berlin date and approximate time. Urgent document, wallet and phone actions appear immediately.
2. **Rebuild** — Add transit lines and places manually. Photo-based route suggestions are available as an optional helper.
3. **Check** — Review each responsible operator or venue and why it applies. Passports and identity documents are also routed to Berlin Police and the traveller’s embassy.
4. **Send & track** — Review the prepared report, open the official destination, submit it yourself, save a receipt, and track follow-up.

The current case and contact details are stored locally in the browser. The app
does not submit a report in the background.

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

## Refreshing venue sources

Refresh offline venue contact candidates from OSM/Overpass:

```bash
npm run data:venue-sources
```

## Reviewed lost-property channel pipeline

The channel pipeline keeps discovered pages separate from public data:

```bash
npm run data:lost-found:inventory
npm run data:lost-found:discover -- --domain=smb.museum --limit=20
npm run data:lost-found:review-export
```

`inventory` conservatively groups duplicate OSM objects and marks minor features
that still need a parent venue. Official-source operator assignments live in
`data/lost-found-crawler/operator-overrides.json`; each one names the exact
website host and the official page that proves common ownership. `discover` honours robots rules, follows a
bounded same-site queue, blocks private-network destinations, and extracts
static form fields. Dynamic or iframe forms can be inspected without submitting:

```bash
npm run data:lost-found:browser-install
npm run data:lost-found:extract -- --url=https://example.org/fundbuero --browser
```

Record a human decision, then publish only accepted candidates:

```bash
npm run data:lost-found:review -- \
  --candidate=channel_... \
  --decision=accept \
  --reviewer="Reviewer name" \
  --kind=dedicated_lost_found_form
npm run data:lost-found:publish
```

The private `/review` route presents the same queue with venue/operator scope,
official evidence, field-by-field checkboxes, accept/reject controls and a
downloadable `reviews.json` backup. Signed-in decisions are appended to a D1
audit log and immediately feed the live reviewed registry; a separate current
state table keeps registry reads bounded. A changed destination, scope,
evidence snapshot or assisted-fill form hash returns the candidate to pending
review instead of silently inheriting an old decision.

The app loads `public/berlin-lost-found-channels.json`. Reviewed forms expose a
field-by-field guide and an expiring autofill package. The optional browser
helper in `extension/` fills those reviewed fields after an explicit user
action and never fills consent or attachments. Submission is disabled by
default. It appears only for an explicitly published, exact-hash adapter and
still requires a second click, an in-page confirmation, complete required
fields and a reviewed success state. Channels lose assisted filling after
their 90-day human review deadline until they are reviewed again. After a
confirmed or uncertain adapter attempt, the helper can copy a result package
back to the report card. The app imports it only when the channel and exact
report fingerprint match, then stores the result and any receipt locally.
