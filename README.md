# Berlin Lost & Found

Berlin Lost & Found helps visitors work out which lost-property offices to contact after losing something on public transport or at a venue. It preserves the useful details of the day, routes the traveller to the right operators, and drafts German and English reports.

This repository contains the complete research prototype: the traveller-facing
web application, the Capacitor/iOS wrapper, the reviewed contact-data pipeline,
the browser-assisted reporting extension, and the tests used to verify them.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | Next.js user flow, review interface, operations dashboard and API routes |
| `lib/` | Shared routing, review, publication and operations logic |
| `public/` | Versioned runtime datasets used by the web and mobile applications |
| `data/lost-found-crawler/` | Source records, review decisions and reproducible crawler outputs |
| `scripts/` | Transit/venue data builders, crawler commands, quality checks and Cloud Run jobs |
| `extension/` | Browser extension and supported form adapters |
| `ios/`, `native/` | Capacitor iOS project and the native PhotoKit bridge |
| `db/`, `drizzle/` | Review database schema and migrations |
| `tests/` | Unit, integration, rendering and pipeline tests |
| `docs/` | Architecture, evaluation and thesis-supporting documentation |

Generated builds, local review renders, evaluation fixtures and editor/assistant
state are intentionally excluded from version control. The tracked tree contains
source code, reviewed data, reproducible results and documentation only.

## Product flow

1. **Describe** — Write a short description of the item. That description is the only required field and the category is optional. The traveller is not forced to guess a loss date. Urgent document, wallet and phone actions appear immediately.
2. **Rebuild** — Choose either one known day or an uncertain travel-date range, then read the matching photo capture times and coordinates. Candidate days are shown separately, the route is reconstructed on device, and anything the photos missed can be added by hand. The photo step can still be skipped.
3. **Check** — Review each responsible operator or venue and why it applies. Passports and identity documents are also routed to Berlin Police and the traveller’s embassy.
4. **Send & track** — Review the prepared report, open the official destination, submit it yourself, save a receipt, and track follow-up.

The current case and contact details are stored locally in the browser. The app
does not submit a report in the background.

## Photo privacy

Photo originals never leave the device, on either platform. On iOS the PhotoKit plugin first restricts the asset query to the inclusive day or travel-date range, then reads each matching asset’s `location` and `creationDate` only; it never requests image data. On the web, the traveller chooses photos after selecting the date window, their EXIF GPS coordinates and capture times are read locally, and out-of-window metadata is discarded. Both paths then match the remaining points against nearby attractions on device.

Route comparison then runs **automatically**, as soon as the photos yield at least two anchors spanning at least 150 m. At that point the route’s start, intermediate and end coordinates plus a departure timestamp are sent to the community-run [`v6.vbb.transport.rest`](https://v6.vbb.transport.rest/) API, and the full 2.9 MB transit geometry is loaded. Below that threshold no route coordinates are sent to VBB. If the VBB request fails, the route falls back to an on-device, geometry-only estimate against the bundled transit data.

## Contact-data trust

Every curated transport contact and operational field in [`app/lost-found/parties.ts`](app/lost-found/parties.ts) has:

- a `lastVerifiedAt` date;
- an official source URL in `fieldSources`;
- a visible source link in the report UI.

The current records were checked in July 2026. `npm run check:party-links` probes every official destination with `HEAD` (and a small `GET` fallback where required). The same check runs in CI and on a weekly schedule.

Venue website, phone and email candidates come from the bundled OpenStreetMap
and Wikidata snapshots. A separate responsibility index assigns every venue to
one of four explicit tiers: current human-reviewed channel, audited/official
contact candidate, nearby parent-venue candidate, or Berlin venue guidance.
Parent proximity never inherits a form automatically, and all non-reviewed
destinations are visibly marked before the traveller shares personal details.
No itinerary is sent to a venue-discovery service at runtime.

## Data and licences

- Transit lines, stops and geometry: VBB GTFS, CC BY 4.0.
- Attractions: © OpenStreetMap contributors, Open Database License (ODbL). Official website candidates may also use Wikidata (CC0).

`public/berlin-lines.json` is the lightweight first-load line index.
`public/berlin-transit.json` contains the full geometry loaded when eligible
photo anchors trigger route inference. `public/berlin-attractions.json`
contains the OpenStreetMap attraction index.
`public/berlin-lost-found-responsibilities.json` is the compact offline
responsibility index; it contains no itinerary or personal data.

## Local development

Requires Node.js 22.19 or newer.

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

The pipeline is endpoint-first. The open OSM/Wikidata attraction snapshot is
the canonical venue index; venues are grouped by audited operator and official
site, each site is crawled within a bounded scope, and candidates are finally
collapsed by the exact Lost & Found page, form action, email or phone. One
reviewed endpoint can therefore cover several venues that independently reach
that destination, without reviewing the same form dozens of times.

To rebuild the current 4,850-record inventory and crawl every official website
known for those records, run:

```bash
npm run data:lost-found:scan-all
```

`scan-all` runs six origin-partitioned workers by default. Different official
sites are fetched concurrently, while every scope for one origin stays in one
worker and retains the 900 ms per-request delay. Tune the bounded pool with
`--concurrency=1..8`; lowering `--delay` is not recommended unless the target's
published crawl policy explicitly permits it. On the first accelerated run,
completed scopes are seeded from `channels.candidates.json`; override that with
`--resume-from=...` or use `--fresh` for an intentional restart.

The current snapshot contains 2,048 venue website seeds plus audited operator
seeds. The crawler resumes from atomic owner/site checkpoints. After crawling,
it normalises duplicate candidates into one endpoint with the union of the
independently proven venue scopes. Use `--fresh` only when an intentional full
restart is needed; use `npm run data:lost-found:quality` for live counts rather
than copying snapshot totals into reports.

It writes two different artifacts:

- `channels.candidates.json`: the evidence-rich candidate pages, forms,
  public emails and phones found by the crawler;
- `venue-endpoint-scan.json`: exactly one result per venue, including the best
  `pageUrl`, optional form action/method, field count, CAPTCHA/login flags and
  contact value, or an explicit reason no endpoint is available yet.

Existing Google-seeded candidates can be included without another billable
Places scan:

```bash
npm run data:lost-found:scan-all -- \
  --inputs=data/lost-found-crawler/google.channels.candidates.json
```

Rebuild only the per-venue result from already collected candidates, without
network crawling:

```bash
npm run data:lost-found:scan-report -- \
  --inputs=data/lost-found-crawler/channels.candidates.json
```

Here “endpoint” means the official Lost & Found page, HTML form destination,
email or phone exposed by a venue. Most venues do not provide a machine API,
so the pipeline must not label an ordinary contact page as an API or a verified
Lost & Found form.

The channel pipeline keeps discovered pages separate from public data:

```bash
npm run data:lost-found:inventory
npm run data:lost-found:discover -- --domain=smb.museum --limit=20
npm run data:lost-found:coverage
npm run data:lost-found:review-export
```

The inventory stores the SHA-256 of the attraction snapshot. Discovery,
coverage and publication stop if the source changed without rebuilding the
inventory. The quality command also reports unique pages, unique endpoints,
pending Google canonicalisation, trusted acceptances and published coverage:

```bash
npm run data:lost-found:quality
```

Legacy or bulk-generated acceptances are never silently reused. Preview and
then quarantine them; rejection history remains in `reviews.json`, while the
full removed records stay recoverable in `reviews.quarantine.json`:

```bash
npm run data:lost-found:review-sanitize
npm run data:lost-found:review-sanitize -- --apply
```

Long ad-hoc `discover` jobs also write an atomic checkpoint after each bounded
owner/site scope. Restart the same output safely with `--resume`; exact
candidate IDs and completed scopes are deduplicated:

```bash
npm run data:lost-found:discover -- --resume
```

Google Places is a gap-finding layer, not the persistent venue database. Use it
for categories or official websites missing from OSM/Wikidata, then map the
result back to the open index before publication. The code uses the official
Places API rather than scraping Google Maps. Check the minimum and maximum
billable request count before enabling it:

```bash
npm run data:lost-found:google-discover -- --dry-run
read -s "GOOGLE_MAPS_API_KEY?Google Places API key: "
export GOOGLE_MAPS_API_KEY
npm run data:lost-found:google-discover -- \
  --confirm-billing --max-requests=180 --max-pages=20 --crawl-shards=4
unset GOOGLE_MAPS_API_KEY
```

The scan rotates across place categories, recursively divides Berlin cells that
return the 20-result API limit, deduplicates by Place ID, and matches runtime names and coordinates to the
bundled open venue index. Every place with a valid `websiteUri` is then crawled,
including places that do not yet match OSM/Wikidata. The tracked link artifact
retains Place IDs and matched OSM IDs only; Google names, coordinates,
categories, and website values are not stored. URLs and evidence independently
fetched from venue websites are written to
`data/lost-found-crawler/google.channels.candidates.json`. Review that file,
then merge it into the main queue:

```bash
npm run data:lost-found:merge -- \
  --inputs=data/lost-found-crawler/channels.candidates.json,data/lost-found-crawler/google.channels.candidates.json
npm run data:lost-found:review-export
```

Google-discovered candidates that have no open-data venue match carry
`canonicalizationStatus: "pending"`, an empty `venueIds` list and their allowed
`sourcePlaceIds`. They can be inspected or rejected, but both the review API and
publisher refuse to accept them until a reviewer supplies a real OSM/Wikidata
venue assignment. This keeps Google as the discovery source while the offline
map database remains independently licensed and publishable.

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

Run the source-grounded DeepSeek reviewer in dry-run mode first. The API key is
read only from the process environment; do not put it in a tracked file:

```bash
read -s "DEEPSEEK_API_KEY?DeepSeek API key: "
export DEEPSEEK_API_KEY
npm run data:lost-found:ai-review -- --limit=25
```

AI review uses four bounded workers by default and shares one fetched source
page across candidates from that page. Use `--concurrency=1` if the provider
returns rate-limit responses, or at most `--concurrency=8` for an account whose
limits are known.

The command fetches the current candidate page through the existing SSRF guard,
removes scripts, event handlers and pre-filled values, and asks DeepSeek for a
JSON classification. A model acceptance is applied only when its quoted
lost-property evidence exists in the current source and the local provenance,
scope, form/contact and confidence checks also pass. Existing decisions are not
overwritten. The model can publish only `open_only` destinations; it cannot
approve assisted filling or a submission adapter.

Inspect `data/lost-found-crawler/ai-review-report.json`, then apply the grounded
accept/reject decisions and rebuild the public data:

```bash
npm run data:lost-found:ai-review -- --limit=152 --apply
unset DEEPSEEK_API_KEY
npm run data:lost-found:publish
```

Publication refuses to reduce the number of reviewed venue scopes silently.
If a deliberate removal has been audited, the exceptional command is
`npm run data:lost-found:publish -- --allow-coverage-regression`; ordinary
candidate refreshes must not use that override.

Use the human command only for inconclusive candidates left in the queue:

```bash
npm run data:lost-found:review -- \
  --candidate=channel_... \
  --decision=accept \
  --reviewer="Reviewer name" \
  --kind=dedicated_lost_found_form
```

Useful AI-review controls are `--candidate=channel_...[,channel_...]`,
`--model=deepseek-v4-flash`, `--accept-threshold=0.9`,
`--reject-threshold=0.95`, and `--timeout-ms=60000`. `--overwrite` is required
to replace an existing decision and should be used only for an intentional
re-audit.

After the reviewed artifacts pass publication, copy a versioned public snapshot
into the `yulid.org` site repository:

```bash
npm run data:lost-found:publish-site -- \
  --site=/Users/daiyuli/Documents/susan
```

That command validates the public channel and responsibility schemas, writes
`/berlin-lost-found/v1/manifest.json` plus the data resources, and records each
resource's byte length and SHA-256. Commit and push the resulting changes in the
site repository to deploy them. The app checks this endpoint at startup and
when the traveller selects **Refresh reviewed data** in Settings. Only a valid,
same-origin, hash-matched snapshot is cached; the packaged snapshot remains the
offline fallback.

`coverage` and `publish` regenerate the detailed private responsibility graph,
the aggregate coverage report, and the compact public runtime index.

### Current coverage (2026-07-28 snapshot)

All figures below are computed from `venue-endpoint-scan.json`,
`coverage-report.json`, `quality-report.json` and
`public/berlin-lost-found-channels.json`, all generated at
2026-07-28T20:18Z. Regenerate them with `npm run data:lost-found:quality`
rather than quoting these totals; they are a dated snapshot, not a constant.

**What the app shows after a sync**

| Value | Count |
| --- | --- |
| Published channels | 362 |
| Reviewed places covered | 539 |

The 362 channels are 312 emails, 41 phones, 8 general contact forms and 1
dedicated lost-property form; 353 are venue-scoped and 9 operator-scoped. By
purpose, 32 are explicitly bound to lost property and 320 are labelled general
contact fallbacks (10 legacy records carry no `purpose` field and are
interpreted by `publishedChannelPurpose`). The separate responsibility index
still resolves a destination for all 4,850 venues, but that functional fallback
rate must never be presented as reviewed coverage.

**Venue population and crawl reach**

| Stage | Count | Share of all venues |
| --- | --- | --- |
| Venues in the open attraction index | 4,850 | 100% |
| Addressable venues (a staffed entity is plausible) | 2,132 | 44.0% |
| Venues with an official website | 2,048 | 42.2% |
| Websites actually crawled | 1,979 | 40.8% (96.6% of those with a site) |

The 2,802 venues without a website are dominated by objects that cannot have a
lost-property desk at all: 1,894 artworks, 428 memorials, plus viewpoints and
similar. 1,241 of them are held as parent-venue candidates and 1,541 have no
official source.

**Venues where the crawler found any usable contact** — a form, an email or a
phone number, whether or not the page is a dedicated lost-property route:

| Denominator | Share of the 963 venues with a contact |
| --- | --- |
| Venues with an official website (2,048) | 47.0% |
| Websites actually crawled (1,979) | 48.7% |
| Addressable venues (2,132) | 45.2% |
| All venues (4,850) | 19.9% |

Their best endpoint is an email for 545 venues, a general contact form for 225,
a phone number for 164, evidence-only pending manual judgement for 28, and a
dedicated lost-property form for 1. For 664 of the 963 (69.0%) the contact value
is locally bound to explicit lost-property wording in the source; the remaining
299 are official general contacts.

**End to end**: 4,850 venues → 2,048 with a website (42.2%) → 1,979 crawled
(96.6%) → 963 with a contact (47.0% of those with a website) → 539 published as
reviewed after the model-plus-guard review (56.0% of 963, 26.3% of the venues
with a website, 11.1% of all venues), served by 362 deduplicated channels. The
responsibility tiers behind those numbers are 539 reviewed channel, 1,512
official contact, 1,217 parent candidate and 1,582 manual guidance, giving a
42.3% actionable rate and a 25.7% addressable-route rate.

An accepted operator channel expands only across venues whose shared operator
has independent official-source audit evidence. A reviewer can always pin an
explicit venue list. Nearby parent candidates never join that expansion.

The private `/review` route presents the same queue with venue/operator scope,
official evidence, field-by-field checkboxes, accept/reject controls and a
downloadable `reviews.json` backup. Signed-in decisions are appended to a D1
audit log and immediately feed the live reviewed registry; a separate current
state table keeps registry reads bounded. A changed destination, scope,
evidence snapshot or assisted-fill form hash returns the candidate to pending
review instead of silently inheriting an old decision.

The app prefers the versioned update feed at
`https://yulid.org/berlin-lost-found/v1/manifest.json`, then a last verified
device cache, the app service and finally
`public/berlin-lost-found-channels.json`. Reviewed forms expose a
field-by-field guide and an expiring autofill package. The optional browser
helper in `extension/` fills those reviewed fields after an explicit user
action and never fills consent or attachments. Three exact-origin, path and
content-hash `fill_only` adapters are currently published for reviewed official
forms. They can fill fields but cannot submit. Submission remains disabled by
default and requires a separate `reviewed_submit` adapter, a second click, an
in-page confirmation, complete required fields and a reviewed success state.
No `reviewed_submit` adapter is currently published. Channels lose assisted filling after
their 90-day review deadline until their current source is reviewed again. After a
confirmed or uncertain adapter attempt, the helper can copy a result package
back to the report card. The app imports it only when the channel and exact
report fingerprint match, then stores the result and any receipt locally.
