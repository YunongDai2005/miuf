# Berlin Lost & Found

Lost property in Berlin is not held by one office. The central city office
covers only what was handed in to it. An item left on a vehicle belongs to the
transport company that ran the service, and the airport divides the case again
between the airline, the terminal office and the police. Before a traveller can
report anything, they have to decide who is responsible.

This repository contains a service that treats that decision as the problem
itself. Given one traveller's day, it determines which organisations are
responsible and prepares a separate report for each of them. The day is rebuilt
from photo time and location metadata on the device, and no image leaves it.
Contact data comes from an offline pipeline that crawls official websites and
publishes every contact with a source, quoted evidence, a content hash and an
expiry date.

The tracked tree holds the traveller-facing web application, the Capacitor and
iOS wrapper, the contact-data pipeline, the browser extension for assisted
filling, and the tests used to verify them. Generated builds, local review
renders, evaluation fixtures and editor state are excluded from version
control.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | Next.js traveller flow, review interface, operations dashboard and API routes |
| `lib/` | Shared routing, review, publication and operations logic |
| `public/` | Versioned runtime datasets used by the web and mobile applications |
| `data/lost-found-crawler/` | Source records, review decisions and reproducible crawler outputs |
| `data/evaluation/` | Captured output of the two measurement scripts |
| `scripts/` | Transit and venue data builders, crawler commands, quality checks and Cloud Run jobs |
| `extension/` | Browser extension and the published form adapters |
| `ios/`, `native/` | Capacitor iOS project and the native PhotoKit bridge |
| `db/`, `drizzle/` | Review database schema and migrations |
| `tests/` | Unit, integration, rendering and pipeline tests |
| `docs/` | Architecture, evaluation and thesis-supporting documentation |

## The traveller flow

The interface is not a fixed wizard. The screens are held in one union type and
can be reached in more than one order, with guard conditions in a separate
module. The main path has four stages.

The traveller first describes the item. That description is the only required
field and it is guarded at five characters. The category stays optional, and no
one is asked to guess the date on which the item was lost. Identity documents,
wallets and phones raise their urgent actions immediately.

The day is then rebuilt. The traveller chooses one known day or an uncertain
travel window before any photo is read, which bounds the query on iOS and
filters the metadata on the web. Candidate days are listed separately, the
route is reconstructed on the device, and anything the photos missed can be
added by hand. The whole photo step can be skipped, in which case the same
button leads to the map and search screen.

The responsible parties follow from the route. Each card names the office, its
scope, and the reason it is on the list. Identity documents also route to
Berlin Police and the traveller's own embassy, and de-duplication never moves
them down, because a replacement document cannot be obtained from a transport
operator.

Finally the traveller reads the prepared report, opens the official
destination, submits it there, saves a receipt and tracks the follow-up. The
case and the contact details are stored in browser local storage. The
application does not submit a report in the background.

## Reading photos

Photo originals never leave the device on either platform.

On iOS the PhotoKit plugin restricts the asset query to the chosen day or
travel window first, then reads the `location` and `creationDate` of each
matching asset. Image data is never requested. On the web the traveller selects
photos after the date window has been set, the Exif coordinates and capture
times are read locally, and out-of-window metadata is discarded. Both paths
produce the same point type, so grouping, de-duplication and place matching are
shared and one set of tests covers both.

Photos are grouped into days by Berlin time rather than UTC, because a photo
taken at 00:30 local time still belongs to the previous evening in the
traveller's memory. Points within 60 seconds of each other collapse into one,
and consecutive points within 300 m are then merged.

In front of the journey service stands a privacy gate. Nothing is sent until
the photos have produced at least two anchors spanning at least 150 m. Above
that threshold the request carries the start, intermediate and end coordinates,
the departure time and the transport modes, and nothing else. The full 2.9 MB
transit geometry is loaded at the same point. If the request fails, an
on-device geometric estimate against the bundled transit data is used instead.

## Attribution

A journey is an ordered list of anchors, and each anchor is either a transport
line or a place. For a line the system prefers the operating company reported
by the transit data. For a place it chooses in order of decreasing evidence: a
current reviewed channel, then an official contact that can be explained, then
general guidance for that type of venue.

When the same office is reached from several anchors, the reasons, lines and
places are merged as sets, so the traveller sees every reason the office is on
the list. Parties are never ranked by a score. Legal responsibility is a
question of scope and evidence, and a single confidence number would suggest a
precision the data does not have.

Every curated transport contact in
[`app/lost-found/parties.ts`](app/lost-found/parties.ts) carries a
`lastVerifiedAt` date, an official source URL in `fieldSources`, and a source
link that stays visible in the report interface. `npm run check:party-links`
probes every official destination with `HEAD`, falling back to a small `GET`
where a server requires it. The same check runs in CI and on a weekly
schedule.

## The channel pipeline

The attribution model is only as good as the contact data behind it. The
pipeline is endpoint-first. The open OpenStreetMap and Wikidata attraction
snapshot is the canonical venue index, venues are grouped by audited operator
and official site, each site is crawled within a bounded scope, and candidates
are collapsed by the exact lost-property page, form action, email or phone. One
reviewed endpoint can therefore cover several venues that reach it
independently, without reviewing the same form dozens of times.

Here an endpoint means the official lost-property page, HTML form destination,
email or phone exposed by a venue. Most venues provide no machine API, so the
pipeline must not label an ordinary contact page as an API or as a verified
lost-property form.

### Discovery and extraction

To rebuild the 4,850-record inventory and crawl every official website known
for those records:

```bash
npm run data:lost-found:scan-all
```

`scan-all` runs six origin-partitioned workers by default. Different official
sites are fetched concurrently, while every scope for one origin stays in one
worker and keeps its 900 ms per-request delay. The bounded pool is tuned with
`--concurrency=1..8`. Lowering `--delay` is not recommended unless the target's
published crawl policy explicitly permits it. On the first accelerated run
completed scopes are seeded from `channels.candidates.json`, which
`--resume-from=...` overrides and `--fresh` discards.

The current snapshot holds 2,048 venue website seeds together with audited
operator seeds. The crawler resumes from atomic owner and site checkpoints.
After crawling it normalises duplicate candidates into one endpoint carrying
the union of the independently proven venue scopes. Live counts come from
`npm run data:lost-found:quality` rather than from snapshot totals copied into
a report.

Two artifacts are written. `channels.candidates.json` holds the evidence-rich
candidate pages, forms, public emails and phones. `venue-endpoint-scan.json`
holds exactly one result per venue, with the best `pageUrl`, the optional form
action and method, the field count, the CAPTCHA and login flags and the contact
value, or an explicit reason why no endpoint is available yet.

Google-seeded candidates can be included without another billable Places scan:

```bash
npm run data:lost-found:scan-all -- \
  --inputs=data/lost-found-crawler/google.channels.candidates.json
```

The per-venue result can also be rebuilt from candidates already collected,
with no network access:

```bash
npm run data:lost-found:scan-report -- \
  --inputs=data/lost-found-crawler/channels.candidates.json
```

Discovered pages are kept separate from public data:

```bash
npm run data:lost-found:inventory
npm run data:lost-found:discover -- --domain=smb.museum --limit=20
npm run data:lost-found:coverage
npm run data:lost-found:review-export
```

The inventory stores the SHA-256 of the attraction snapshot. Discovery,
coverage and publication stop if the source changed without the inventory being
rebuilt. The quality command reports unique pages, unique endpoints, pending
Google canonicalisation, trusted acceptances and published coverage:

```bash
npm run data:lost-found:quality
```

`inventory` groups duplicate OSM objects conservatively and marks minor
features that still need a parent venue. Operator assignments taken from an
official source live in `data/lost-found-crawler/operator-overrides.json`, and
each one names the exact website host and the page that proves common
ownership. `discover` honours robots rules, follows a bounded same-site queue,
blocks private-network destinations and extracts static form fields. Long
ad-hoc jobs write an atomic checkpoint after each bounded scope, so the same
output can be restarted safely:

```bash
npm run data:lost-found:discover -- --resume
```

Forms built by scripting or held in an iframe can be inspected without
submitting anything:

```bash
npm run data:lost-found:browser-install
npm run data:lost-found:extract -- --url=https://example.org/fundbuero --browser
```

Every request passes through one fail-closed guard. It accepts only public HTTP
and HTTPS destinations, rejects credentials and local host names, resolves both
IPv4 and IPv6, and refuses any private, loopback or link-local address.
Connections are pinned to the verified address, redirects are followed manually
and re-validated, and time and body-size limits are enforced.

### Google Places as a gap-finding layer

Google Places finds categories and official websites missing from OpenStreetMap
and Wikidata. It is not the persistent venue database, and results are mapped
back to the open index before publication. The code uses the official Places
API rather than scraping Maps. The billable request count should be checked
before it is enabled:

```bash
npm run data:lost-found:google-discover -- --dry-run
read -s "GOOGLE_MAPS_API_KEY?Google Places API key: "
export GOOGLE_MAPS_API_KEY
npm run data:lost-found:google-discover -- \
  --confirm-billing --max-requests=180 --max-pages=20 --crawl-shards=4
unset GOOGLE_MAPS_API_KEY
```

The scan rotates across place categories, recursively divides any Berlin cell
that returns the 20-result API limit, deduplicates by Place ID, and matches
runtime names and coordinates against the bundled open venue index. Every place
with a valid `websiteUri` is then crawled, including places that do not yet
match OSM or Wikidata. What is committed is deliberately thin: the tracked link
artifact retains Place IDs and matched OSM IDs only, while Google names,
coordinates, categories and website values are not stored. URLs and evidence
fetched independently from venue websites are written to
`data/lost-found-crawler/google.channels.candidates.json`.

Candidates with no open-data venue match carry `canonicalizationStatus:
"pending"`, an empty `venueIds` list and their allowed `sourcePlaceIds`. They
can be inspected or rejected, but the review API and the publisher both refuse
to accept them until a reviewer supplies a real OSM or Wikidata assignment.
This keeps Google as a discovery source while the offline map database stays
independently licensed and publishable. Reviewed candidates are then merged
into the main queue:

```bash
npm run data:lost-found:merge -- \
  --inputs=data/lost-found-crawler/channels.candidates.json,data/lost-found-crawler/google.channels.candidates.json
npm run data:lost-found:review-export
```

### The review gate

The original design put a human decision on every candidate. At a few hundred
places that worked. At 4,850 places it did not, and an earlier attempt to clear
the queue in bulk produced acceptances that had never been checked against
their source page. Those are not silently reused: the sanitation command
quarantines any acceptance that cannot be tied to a current candidate and a
current source, keeping the removed records recoverable in
`reviews.quarantine.json` while the rejection history stays in `reviews.json`.

```bash
npm run data:lost-found:review-sanitize
npm run data:lost-found:review-sanitize -- --apply
```

The gate was rebuilt around a language model constrained by deterministic
checks. The API key is read only from the process environment and must not be
placed in a tracked file. Run the reviewer in dry-run mode first:

```bash
read -s "DEEPSEEK_API_KEY?DeepSeek API key: "
export DEEPSEEK_API_KEY
npm run data:lost-found:ai-review -- --limit=25
```

The command fetches the current candidate page through the guard above, strips
scripts, event handlers and pre-filled values, and asks the model for a JSON
classification. An acceptance is applied only when the quoted lost-property
evidence exists in the page that was just fetched and the local provenance,
scope, form and confidence checks also pass. Existing decisions are not
overwritten. The model may publish only `open_only` destinations, which the
traveller opens themselves. It cannot approve assisted filling, and it cannot
approve a submission adapter.

Review uses four bounded workers by default and shares one fetched source page
across the candidates that came from it. `--concurrency=1` suits a provider
returning rate-limit responses, and at most `--concurrency=8` an account whose
limits are known. The remaining controls are
`--candidate=channel_...[,channel_...]`, `--model=deepseek-v4-flash`,
`--accept-threshold=0.9`, `--reject-threshold=0.95` and `--timeout-ms=60000`.
`--overwrite` is required to replace an existing decision and belongs only to
an intentional re-audit.

After inspecting `data/lost-found-crawler/ai-review-report.json`, the grounded
decisions are applied and the public data rebuilt:

```bash
npm run data:lost-found:ai-review -- --limit=152 --apply
unset DEEPSEEK_API_KEY
npm run data:lost-found:publish
```

The human command is then used only for the inconclusive candidates left in the
queue:

```bash
npm run data:lost-found:review -- \
  --candidate=channel_... \
  --decision=accept \
  --reviewer="Reviewer name" \
  --kind=dedicated_lost_found_form
```

The human gate was moved rather than removed. People no longer decide on each
contact detail. They write the policy, they work through the quarantine, and
they remain the only route by which an assisted-filling adapter can be
published.

The private `/review` route presents the same queue with venue and operator
scope, the official evidence, field-by-field checkboxes, accept and reject
controls and a downloadable `reviews.json` backup. Signed-in decisions are
appended to a D1 audit log and feed the live registry immediately, while a
separate current-state table keeps registry reads bounded. A changed
destination, scope, evidence snapshot or assisted-fill form hash returns the
candidate to pending review instead of silently inheriting the old decision.

An accepted operator channel expands only across venues whose shared operator
has independent official-source audit evidence. A reviewer can always pin an
explicit venue list, and nearby parent candidates never join that expansion.

### Publication

Publication refuses to reduce the number of reviewed venue scopes silently. An
audited removal uses the exceptional command below, and an ordinary candidate
refresh must not use that override.

```bash
npm run data:lost-found:publish -- --allow-coverage-regression
```

A versioned public snapshot is copied into the site repository:

```bash
npm run data:lost-found:publish-site -- --site=/path/to/site-repository
```

That command validates the public channel and responsibility schemas, writes
`/berlin-lost-found/v1/manifest.json` together with the data resources, and
records the byte length and SHA-256 of each resource. Committing and pushing in
the site repository is what deploys them.

The application reads that feed at startup and when the traveller selects
**Refresh reviewed data** in Settings. Resource URLs must stay on HTTPS, on the
manifest origin and below its version path. Every response is limited to 8 MB,
compared against the declared byte length and digest, parsed against the public
schema and checked for a consistent generation time. Only a valid snapshot that
is not older than the bundled data is cached. On failure the client falls back
to the last verified cache, then the app service, then
`public/berlin-lost-found-channels.json`. No case, photo or journey data is
sent in this exchange.

### Assisted filling

Reviewed forms expose a field-by-field guide and an autofill package that
expires after about two hours. The optional browser helper in `extension/`
fills those fields after an explicit user action, and never fills consent
controls or attachments.

Five `fill_only` adapters are currently published, each pinned to an exact
origin, path and form content hash. They fill fields and cannot submit.
Submission stays disabled by default and would require a separate
`reviewed_submit` adapter, a second click, an in-page confirmation, complete
required fields and a reviewed success state. No such adapter is published, so
in the deployed system the final submission is always an action the traveller
takes on the official site.

Channels lose assisted filling once their 90-day review deadline passes, until
their current source is reviewed again. After an attempt the helper can copy a
result package back to the report card, which the application imports only when
the channel and the exact report fingerprint match.

## Coverage of the 2026-07-28 snapshot

The figures below are computed from `venue-endpoint-scan.json`,
`coverage-report.json`, `quality-report.json` and
`public/berlin-lost-found-channels.json`, all generated at 2026-07-28T20:18Z.
They are a dated snapshot rather than a constant, and
`npm run data:lost-found:quality` regenerates them.

The place index doubles as the vocabulary for naming where a photo was taken,
so it contains many objects that can have no lost-property desk at all.
Measuring coverage against all 4,850 venues therefore understates the result
and describes the wrong problem, and the addressable population is reported
separately.

| Stage | Count | Share of all venues |
| --- | --- | --- |
| Venues in the open attraction index | 4,850 | 100% |
| Addressable venues, where a staffed entity is plausible | 2,132 | 44.0% |
| Venues with an official website | 2,048 | 42.2% |
| Websites actually crawled | 1,979 | 40.8% |
| Venues with a usable contact | 963 | 19.9% |
| Venues published as reviewed | 539 | 11.1% |

The 2,802 venues without a website are dominated by objects that cannot hold
lost property: 1,894 artworks, 428 memorials, and viewpoints and similar
features. Of those, 1,241 are held as parent-venue candidates and 1,541 have no
official source.

A usable contact means a form, an email address or a phone number, whether or
not the page is a dedicated lost-property route. That is 47.0 per cent of the
venues with a website, 48.7 per cent of those actually crawled and 45.2 per
cent of the addressable venues. The best endpoint is an email for 545 venues, a
general contact form for 225, a phone number for 164, evidence awaiting manual
judgement for 28, and a dedicated lost-property form for one. For 664 of the
963 the contact value is bound to explicit lost-property wording in the source,
and the remaining 299 are official general contacts labelled as such.

The 539 reviewed venues are served by 362 published channels after
de-duplication, because one reviewed destination often covers several venues
that reach it independently. Those channels are 312 emails, 41 phones, 8
general contact forms and one dedicated lost-property form. By scope, 353 are
venue-scoped and 9 operator-scoped.

| Resolution tier | Venues | Share |
| --- | --- | --- |
| Reviewed channel | 539 | 11.1% |
| Official website of the venue or operator | 1,512 | 31.2% |
| Parent venue awaiting an ownership decision | 1,217 | 25.1% |
| General venue or public-space guidance | 1,582 | 32.6% |

Counting the first two tiers as directly actionable gives 42.3 per cent. Every
venue resolves to something, but that functional fallback rate must never be
presented as reviewed coverage, and the interface has to state clearly when
what it offers is a fallback rather than a dedicated lost-property route.

## Running the project

Node.js 22.19 or newer is required.

```bash
npm install
npm run dev
```

The fast inner loop:

```bash
npm run test:unit
npm run lint
npm run typecheck
```

The full verification, which additionally asserts on server-rendered HTML:

```bash
npm test
npm run check:party-links
```

## Reproducing the reported figures

The unit suite is run with `npm run test:unit` and reports 137 passing tests
across 13 files in about two seconds. The full suite is run with `npm test`.

The two measurements are produced by the scripts under `scripts/evaluation`.
`projection-error.mts` samples the bundled coordinate files and prints the
projection figures and the error distribution by latitude band.
`make-exif-fixtures.mts` followed by `photo-pipeline-performance.mts` generates
the photograph fixtures and prints the metadata timing. Both use fixed random
seeds, and their captured output is stored under `data/evaluation`.

The channel figures are read from `data/lost-found-crawler`, and the published
feed is identified by the dataset version recorded in its manifest.

## Refreshing the source data

Transit data comes from the official VBB GTFS export. The current ZIP is
downloaded, then:

```bash
python3 scripts/build-berlin-transit.py /path/to/GTFS.zip
```

The generator updates both the full geometry and the lightweight line index. If
only `public/berlin-transit.json` has changed, its index is rebuilt on its own:

```bash
npm run data:lines
```

Offline venue contact candidates are refreshed from OSM and Overpass:

```bash
npm run data:venue-sources
```

`public/berlin-lines.json` is the small line index loaded on first paint.
`public/berlin-transit.json` holds the full geometry, fetched only when photo
anchors qualify. `public/berlin-attractions.json` is the OpenStreetMap
attraction index, and `public/berlin-lost-found-responsibilities.json` is the
compact offline responsibility index, which contains no itinerary or personal
data.

## What this repository does not show

The tests settle claims about internal behaviour, and the two measurements
bound two costs on one desktop machine. They do not show that photographs
reconstruct a day accurately, that the resolved organisations are the legally
responsible ones, or that a traveller using this system recovers an item more
often. The accuracy of journey reconstruction is the central claim and remains
untested. The photo fixtures are synthetic, carrying a real Exif segment with
filler in place of image data, which is faithful for a metadata read and
unfaithful for anything that decodes the image.

## Data sources and licences

| Data | Source | Licence and attribution |
| --- | --- | --- |
| Transit lines, stops and route geometry | VBB GTFS feed | Creative Commons Attribution 4.0; attribute VBB |
| Attractions and place geometry | OpenStreetMap | Open Database License; attribute © OpenStreetMap contributors |
| Official website and operator candidates | Wikidata | CC0 public domain dedication |
| Journey candidates | Community journey service on VBB data | Community operated, with no availability guarantee; underlying data attributed to VBB |
| Lost-property contact details | Official operator, venue and municipal pages | Public contact information, each record carrying its official source URL and review date |
