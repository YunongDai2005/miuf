# 4 Building the Traveller Application

This chapter follows the order in which a traveller uses the app. Each section states the problem the screen or module had to solve, the decision taken, and how it was built.

## 4.1 Screens and the guards between them

The interface is not a fixed four-step wizard. It is a set of screens held in one union type — launch, describe, retrace, offices, report, case, tracking and settings — and the traveller can move between them in more than one order. The main path is:

> launch → describe the item → dates and photos → review the route → responsible offices → open one report → submit on the official site → mark as sent → tracking

*[Figure 4-1. The launch screen. The three steps are named before anything is asked of the traveller, and the footer states that nothing is sent for them.]*

Because the screens can be reached out of order, the guard conditions live in a separate module. Moving to the reconstruction screen needs a description of at least five characters. Moving to the offices screen needs at least one journey entry, or an explicit tick that the central office should be included. Without these guards a traveller could reach an empty offices screen and decide the app was broken, when it simply had nothing to work with. When a guard blocks a jump, the app sends the traveller back to the screen that can fix it and shows the reason there.

*[Figure 4-2. The item screen. Only the description is required; the category is a single row of optional chips.]*

Input was cut to the minimum over several rounds. The category became optional. The title, colour and free description were merged into one field. The date defaults to today in Berlin calendar terms, and the time window moved behind an expander. Contact details moved out of the first screen entirely and are stored under their own local-storage key, so deleting a case keeps the details the traveller would have to type again. The settings screen still offers an explicit delete for case data.

*[Figure 4-3. The date and photo screen. The traveller chooses one known day or an uncertain travel window before any photo is read.]*

The date choice comes before the photo step for a practical reason. A traveller who is unsure of the day would otherwise have to scan a whole library. Choosing one day or a travel window first bounds the query on iOS and filters the metadata on the web, so out-of-window points are discarded before any matching runs.

Photo-first does not mean photo-only. If the photos have no coordinates, or permission is refused, or the traveller simply skips the step, the same button leads to the map and search screen. When photos do work, the result still passes through a confirmation list where wrong anchors can be removed and missing lines or places added by hand.

*[Figure 4-4. The offices screen. Each card names the office, its scope, and the reason it is on the list.]*

One small piece of the interface is worth naming because it was cut back deliberately. The launch screen plays a short mark animation of about 1.4 seconds. It checks the reduced-motion setting first and skips straight to the finished state when that setting is on. An earlier version held the animation longer and put it between the traveller and the first question, which is the wrong trade for somebody who has just lost a phone.

## 4.2 Reading photos on two platforms

When a traveller selects fifty or sixty photos on the web, a naive implementation feels broken. The usual causes are reading whole files, parsing them one after another, creating too many promises at once, and re-rendering on every file. Each cause was addressed separately.

The metadata library is imported dynamically, so a session that never touches photos never loads it. GPS and the original capture time are read in one pass, so no file is opened twice. Reads are chunked at 64 KiB with a limit of five chunks, because the Exif segment sits at the front of the file: a 20 to 50 MB phone photo is never decoded for the sake of a few tags. A worker pool bounds concurrency at the smallest of twelve, twice the number of hardware threads, and the file count. Progress is reported about fifty times at most, so a large album does not cause continuous re-rendering. A damaged file, or one with no metadata, is skipped instead of failing the batch.

Day grouping uses the Berlin time zone and not UTC. This matters near midnight. A photo taken at 00:30 local time belongs to the same evening in the traveller's memory but to the next day in UTC, and grouping it wrongly would break the anchor order.

After sorting by capture time, two reductions run in order: photos within 60 seconds of each other collapse to one point, then consecutive points within 300 m merge. A merged point takes the plain average of the positions and keeps a count of how many photos it stands for. That count is later shown to the traveller as a measure of how strong the anchor is.

On iOS the same two fields come from the system photo library instead (CIPA, 2023; Apple, n.d.-a). The Swift plugin exposes two methods: one to request authorisation and one to fetch photo points. The fetch accepts a specific day, a number of recent days, or a limit on how many assets to scan, so the scan is bounded by the reported loss date and not by the size of the library. It returns the authorisation state, how many assets were scanned, how many had coordinates, and the array of points. It never requests image data.

The iOS path is faster because the system already maintains an index of asset metadata. Nothing crosses the bridge except a small array of numbers, while the web path has to open every selected file. On the TypeScript side the native result is reshaped into exactly the same point type the web extractor produces, so grouping, de-duplication, place matching and line inference are shared with no platform branches. One set of unit tests covers both.

*[Figure 4-5. Two platform paths converge on one point type, which is what allows one set of tests to cover both.]*

## 4.3 From photo points to lines

A photo gives time and position. It almost never gives evidence of a transport line: a photo taken on a platform does not record which train arrived. The design therefore separates two questions. The photos answer where and when the traveller was. The transit data answers which line could connect those points at that time.

Anchors are named by matching each point against nearby places within 220 m. A plain nearest-neighbour match performs badly here, because the place index also contains sculptures and memorial plaques that sit closer to the pavement than the building the traveller actually visited. Each candidate is therefore scored by distance multiplied by a weight for its category, with landmarks weighted at 0.60 and minor artworks at 1.30. Lower is better, so a landmark can win over a nearer artwork. A point that matches nothing is kept anyway, because it is still useful as route geometry even though it cannot be named.

Line inference then runs offline first. The path is resampled at 65 m. At each sample the matcher collects at most nine candidate lines within 230 m, plus one explicit walking-or-unknown state, and a dynamic program chooses the sequence with the lowest total cost. The cost combines a distance term for staying on a line, a fixed cost for the unknown state, and a penalty for switching lines. Segments shorter than three samples are removed afterwards, which suppresses single-sample flicker between parallel lines. Keeping the unknown state is essential; without it every point would be forced onto some line.

This is the same shape as hidden Markov map matching (Newson and Krumm, 2009; Quddus, Ochieng and Noland, 2007), with states, emission costs, transition costs and a best path. The costs here are hand-set rules tuned for transit corridors, not learned probabilities, so it is not a reproduction of that method.

When the network is available, the online journey service gives better evidence, because its answer names the company that actually operates the line. Its candidates are not chosen by shortest travel time. They are filtered by geometric agreement with the photo path, then ranked by four terms: how much of the path is covered within a tolerance, the mean distance from the path to the line, the discrete Fréchet distance, and the length ratio. A long or looping path is split into at most five parts, and later parts are queried in order of the arrival time of the earlier ones.

The privacy gate sits in front of this request. Nothing is sent until the photos produce at least two anchors spanning at least 150 m. Below that threshold no route coordinates leave the device at all. Above it the request carries the start, intermediate and end coordinates, the departure time and the transport modes, and nothing else — no image, no filename, no full metadata. If the request fails, the offline result is used.

The interface receives a search plan built from the geometric result. The chosen path becomes high priority, other lines in the same corridor become medium or low, and a night service is pushed down when the reference time is during the day. The offline geometric score itself is not displayed; it only sets those labels, because a percentage beside a line invites the reading that the system is certain to within one per cent, which the geometry does not support.

The online comparison is treated differently. When the journey service returns several candidates, each one is shown with its similarity as a percentage and with its departure time, so the traveller can pick between them. The number is defensible here because it compares one candidate against the photo path, and because the traveller is being asked to choose. The responsible-party list in section 4.4 carries no score at all: there the number would describe legal responsibility, which is a question of scope and evidence.

## 4.4 From lines to offices and reports

The resolver walks the journey once and collects parties into an ordered map. When a second anchor points at a party that already exists, it merges into that entry instead of creating a duplicate, and the order in which parties were first determined becomes the output order. The document category is handled before the loop, which is what fixes police and embassy guidance at the top of the list whatever the itinerary contains.

The middle branch of the loop is where data quality becomes visible to the traveller. When the transit data names a company that has no reviewed lost-property channel, the system still creates a party from that company's official website, marks it as unverified, and tells the traveller to look for the lost-property section themselves. The alternatives would be to hide the company or to substitute a different office silently. Both would take away the one solid fact available, which is who ran the service.

Reports are generated separately for each party, in German and in English. Empty fields are left out instead of printed as blanks. Each text contains only the context that belongs to that party: the lines that party operates, the places in its scope, the boarding and alighting stops and the direction. One long generic message sent to every organisation would be easier to build, but harder for each office to act on, and it would tell every recipient more about the traveller's day than that office needs to know.

*[Figure 4-6. The report screen. The traveller switches between English and German, copies the text, and opens the official form; the app never submits.]*

The report screen also carries the contact prompt. If no email or phone has been stored yet, a short block appears above the draft asking where the office should reply. This is the only point in the flow where contact details are required, and it is placed here because the traveller can now see exactly what the details will be used for.

## 4.5 Tracking, assisted filling and the day card

Progress is tracked locally with three states: to do, sent and replied. Each recorded submission carries a fingerprint of the exact report, so marking the same unchanged report as sent twice does not create a second entry, while a real edit does. The history per party is capped and sorted by time.

Assisted filling is an optional desktop browser extension. The app produces a package containing the channel identifier, the official page, a short fingerprint of the report, creation and expiry times, the field list, and the fields the traveller must complete personally. Before filling anything the extension checks that the current origin and path match the package exactly, that the package is less than about two hours old, and that it carries no more than one hundred fields. It never fills hidden inputs, file inputs, checkboxes, radio buttons or privacy-consent controls.

A guarded submission capability exists behind the same mechanism, but it is off by default and requires a published adapter whose identifier, channel, origin, path pattern and form content hash all match. No such adapter is published. All five adapters in the current feed are fill-only, so in the deployed system the final submission is always an action the traveller takes on the official site. That boundary is deliberate: submitting a loss report is a statement made by the traveller, and consent controls cannot be ticked on somebody else's behalf.

The reviewed channel data is refreshed separately from the app itself. At startup, and when the traveller presses **Refresh reviewed data**, the client requests a versioned manifest with an eight-second timeout. Resource URLs must stay on HTTPS, on the manifest origin, and below its version path. Each response is limited to 8 MB, matched against the declared byte length and SHA-256 digest, parsed against the public schema, and checked for a consistent generation time. A valid snapshot that is not older than the bundled data is cached and used. On failure the client falls back to the last verified cache, then the app service, then the snapshot built into the app. The interface names the active source and the counts, so the traveller can see which data they are looking at. No case, photo or journey data is sent in this exchange.

The app also produces a shareable day card: an offline vector image of the reconstructed day with no map tiles, which can be generated and shared without contacting any server. It exists because most travellers who rebuild a day did not lose anything, and the card gives that work a second purpose.

---

# 5 The Channel Data Pipeline

The attribution model is only as good as the contact data behind it. This chapter describes how that data is collected, checked and published, and reports where the original design had to change.

## 5.1 Discovery and extraction

The pipeline starts from an open place index built from OpenStreetMap and Wikidata: 4,850 places in Berlin, of which 2,048 have an official website. Places are grouped by stated operator, by linked data entity, or by a nearby parent candidate, and operators are merged only where official evidence supports it.

Discovery reads robots rules and up to three sitemaps, then walks a same-site queue with a budget of pages per domain and a pause of 900 ms between requests. News, ticketing and endless pagination are filtered out. Extraction prefers a static HTML parser, renders with a real browser only when a page builds its form through scripting, reads official PDFs, aborts every non-GET request, and never clicks a submit button. Field names are then mapped onto fixed slots such as loss date, loss location, item description and privacy consent (Ferrara et al., 2014). Crawling follows the robots exclusion protocol, which states a site's preference and is neither an access permission nor a legal clearance (Koster et al., 2022).

Every request passes through one fail-closed guard. It accepts only public HTTP and HTTPS destinations, rejects credentials and local host names, resolves both IPv4 and IPv6, and refuses any private, loopback or link-local address. Connections are pinned to the verified address, redirects are followed manually and re-validated, and time and body-size limits are enforced. This is the standard threat model for fetching arbitrary URLs (OWASP, n.d.).

Several extraction faults were only found by running the pipeline at full scale. Contact details often sit on a second-level page — a contact page, a visitor-service page, an FAQ or an imprint — that the first version of the crawler did not reach. Some sites obscure addresses as `name(at)example.org` or `name[at]example.org`. Others place an address directly against the following sentence with no separator, which produced addresses with body text attached. A single venue could also yield several equally valid addresses, so the pipeline now keeps one best public contact per venue. Slow sites were capped at twelve seconds each, because a handful of unresponsive hosts otherwise held up the whole run, and the 140 sites that timed out are recorded separately instead of being counted as having no contact.

## 5.2 The review gate, and how it had to change

The original design put a human decision at the end of the pipeline, and that decision was the only way into the published feed. At a few hundred places this worked. At 4,850 places, with more than two thousand candidates, it did not: reviewing every candidate by hand became the bottleneck for the entire project, and an earlier attempt to clear the queue by accepting candidates in bulk produced 754 acceptances that had never been checked against their source page.

Those bulk acceptances were not silently reused. A sanitation command quarantines any acceptance that cannot be tied to a current candidate and a current source, and 1,047 old decisions now sit in a quarantine file, kept as audit history and excluded from publication.

The gate was then rebuilt around a language model constrained by deterministic checks. For each candidate the pipeline fetches the current page through the same request guard, strips scripts, event handlers and pre-filled values, and asks the model to classify the destination and to quote the evidence it used. The model's answer is only accepted when every local check also passes: the quoted text must exist in the page that was just fetched; the contact value must appear inside that quote; the candidate must have official provenance; the destination must be reachable on the same official site; and the model may only publish destinations that the traveller opens themselves. It cannot approve assisted filling, and it cannot approve a submission adapter. Confidence thresholds are separate for acceptance and rejection, and an existing decision is never overwritten without an explicit flag.

Every automated acceptance stores an audit record with the policy version, the model, the hash of the fetched source, the hash of the quoted evidence and the final URL. A publication refuses an automated acceptance that has no such record.

The result is that the human gate moved rather than disappeared. Humans no longer decide each contact detail; they write and version the policy, review the quarantine, and remain the only way an assisted-filling adapter can be published. All five adapters in the current feed were added by hand.

*[Figure 5-1. The channel state machine. A model decision can reach Published only through the deterministic checks; assisted filling and submission adapters still need a person.]*

Publication itself is guarded. It refuses to reduce the number of covered places without an explicit override, validates the public schema, and writes a versioned manifest with a byte length and SHA-256 digest for each resource. Deploying a snapshot can correct contact data without releasing a new iOS binary. It cannot replace code.

## 5.3 Running the crawl at scale

A full pass over 2,048 websites does not fit into one local process at a polite request rate. The crawl was therefore packaged as a container and run as a Cloud Run job in eight parallel tasks, partitioned by origin so that every page of one site stays in one task and keeps its 900 ms delay. Each task writes its shard to object storage; a separate merge task then combines the shards, rebuilds the per-venue endpoint report and the quality audit, and writes a run manifest.

*[Figure 5-2. The eight-task crawl and the merge stage in Cloud Run.]*

A private operations dashboard reads the inventory, the candidate file, the review file, the published registry and the quality report, and reconciles them with the live public feed. It reports the stage that is blocking, the domains worth attacking next, and any decision that no longer joins a current candidate. It exists because the pipeline has five artifacts that can disagree with each other, and reading five JSON files by hand is how stale numbers reach a report.

*[Figure 5-3. The operations dashboard after the full Berlin run.]*

---

# 6 Evaluation and Conclusion

## 6.1 What was measured

Three kinds of claim are made in this thesis, and they can be evidenced to very different degrees. Claims about internal behaviour — that a threshold is applied, that a hash is checked, that a state cannot be reached — are settled by the test suite and by reading the code. Claims about cost can be measured on one machine. Claims about whether the system helps somebody recover an item need field data from people who have actually lost something, and no such study was made.

| Measure | Value on 28 July 2026 |
| --- | --- |
| Unit tests | 137 passed, 0 failed, about 2.8 s |
| Test files | 13: twelve TypeScript groups and one rendered-HTML group |
| Main script | about 337 kB, 107 kB compressed |
| Metadata library, lazy chunk | about 74 kB, 26 kB compressed |
| Map library, lazy chunk | about 149 kB, 43 kB compressed |
| Light line index | 41,766 bytes |
| Full line geometry | 3,049,455 bytes, loaded only when anchors qualify |
| Place index | 4,850 places |

*[Table 6-1. Repository and test figures. Build times depend on the machine and are not cross-device performance results.]*

**Distance approximation.** All metre-based decisions rest on a flat projection fixed at 52.52° N. Its error was measured against WGS-84 geodesics over 10,000 random pairs drawn from the 89,494 coordinates in the shipped data, with separations from 1 m to 400 m. The median error was 0.12 m and the largest 2.7 m, at the southern edge of the data. Over the same pairs the textbook spherical formula had a larger median error, so the projection is the more accurate of the two at these distances. A smartphone's own horizontal error is roughly 7 m in the open and 10 to 13 m beside tall buildings (Merry and Bettinger, 2019), so the projection error is an order of magnitude below the uncertainty of the coordinates it is applied to. The full table is in Appendix C.

**Photo metadata cost.** Fixtures carrying a real Exif segment, padded to 4 MB each, were read through the same extraction function the app uses, ten times per batch size. The median total time was 1.3 ms for one photo and 8.2 ms for a hundred, so the cost per photo fell from about 1.3 ms to about 0.08 ms. Progress was reported 50 times at the largest batch, matching the stated limit. A batch of one hundred photos occupies 400 MB on disk, of which 6.3 MB was read. These are desktop figures under Node, not handset figures; the measurement the requirement actually asks for has not been made.

## 6.2 What the pipeline produced

The place index holds 4,850 places, but not all of them can have a lost-property desk. It doubles as the vocabulary for naming where a photo was taken, so it contains 1,894 artworks, 428 memorials, viewpoints and similar objects that have no staff at all. Measuring channel coverage against all 4,850 understates the result and describes the wrong problem, so the addressable population is reported separately.

| Stage | Count | Share of all places |
| --- | --- | --- |
| Places in the index | 4,850 | 100% |
| Addressable places | 2,132 | 44.0% |
| Places with an official website | 2,048 | 42.2% |
| Websites crawled | 1,979 | 96.6% of those with a site |
| Places with a usable contact found | 963 | 47.0% of those with a site |
| Places published as reviewed | 539 | 26.3% of those with a site |

*[Table 6-2. From the place index to published channels.]*

A usable contact means a form, an email address or a phone number, whether or not the page is a dedicated lost-property route. The best contact is an email for 545 places, a general contact form for 225, a phone number for 164, and a dedicated lost-property form for one. For 664 of the 963 the contact value is bound to explicit lost-property wording in the source; the other 299 are official general contacts and are labelled as such.

The review stage made 582 decisions on the current candidate set: 352 acceptances and 230 rejections. Those 539 places are served by 362 de-duplicated channels, because one reviewed destination often covers several places that independently reach it.

| Resolution tier | Places | Share |
| --- | --- | --- |
| Reviewed channel | 539 | 11.1% |
| Official website of the venue or operator | 1,512 | 31.2% |
| Parent venue awaiting an ownership decision | 1,217 | 25.1% |
| General venue or public-space guidance | 1,582 | 32.6% |

*[Table 6-3. How the 4,850 places resolve.]*

Counting the first two tiers as directly actionable gives 42.3 per cent. Every place resolves to something, but the interface must say plainly when what it offers is a fallback and not a dedicated lost-property route.

Two figures describe the cost of the automated gate. The largest single batch classified 627 candidates and produced 5 acceptances, 201 rejections and 417 candidates left for a human, using about 1.67 million tokens. A second pass over the remainder, after the extraction faults in section 5.1 were fixed, classified 421 candidates and produced 312 acceptances. The difference is the point: the model was not the limiting factor, the quality of the extracted evidence was.

## 6.3 Requirements check

| ID | Result |
| --- | --- |
| F1 | Met. Only the description is required and it is guarded at five characters; the date defaults to today in Berlin time |
| F2 | Met. Scanned, located and grouped counts are shown; the step can be skipped and the flow continues manually |
| F3 | Met. The map and the day list share one state; entries can be added and removed at any point |
| F4 | Met. Parties are de-duplicated with merged reasons, scope, official source and verification state |
| F5 | Met. German and English drafts omit empty fields; the official page opens; nothing is sent by the app |
| F6 | Met. Three states with a report fingerprint; assistance packages expire after about two hours |
| F7 | Partly met. Discovery, decision, versioned publication and verified refresh all work end to end, but the decision is now made by a model with deterministic checks and not by a person for each candidate |

*[Table 6-4. Functional requirements against the implementation.]*

The non-functional requirements of Table 2-3 hold with two qualifications. The performance condition asks for measured times on a handset, and only desktop figures exist. The trust condition holds as written — every published channel has a source, a quoted piece of evidence, a hash, a review time and an expiry — but the meaning of "reviewed" changed during the project and section 5.2 states how.

## 6.4 What this does not show

The measurements bound two costs and confirm several internal behaviours. They do not show that photographs reconstruct a day accurately, that the resolved organisations are the legally responsible ones, or that a traveller using this system recovers an item more often. Those are the questions the work exists to answer and they remain open. The most consequential gap is the accuracy of journey reconstruction itself, which is the system's central claim and is untested.

Both measurements were made by the author on one desktop machine. The photo fixtures are synthetic: they carry a real Exif segment but filler in place of image data, which is faithful for a metadata read and unfaithful for anything that decodes the image. The projection measurement characterises the shipped dataset, not Berlin as an administrative area. The Reddit material of section 2.4 is exploratory and self-selected, and no participant has used the system after a real loss.

The smallest useful studies that remain are an accuracy study over labelled photo points and journeys, a timing study on a real handset and two mobile browsers, an attribution study over labelled journey and category cases, and a small usability study over the three scenarios. Each should record the device, the repetitions, the raw observations and the failures alongside any summary.

## 6.5 Conclusion and future work

Lost property in Berlin can be treated as attribution and routing from a traveller's own day, and not as a search for one universal office. The implemented flow rebuilds anchors from photo metadata on the device, accepts manual correction, combines offline and online transit evidence, resolves the responsible organisations while keeping the reasons, and prepares separate bilingual reports linked to official channels. It runs as a web application, a standalone build and an iOS shell over one logic module.

The transferable result is the governance boundary. Personal case data stays on the client. Third-party contact data is published only with a source, quoted evidence, a hash and an expiry. Submission stays with the traveller. A versioned feed lets contact data change without an app release.

The project also produced a negative result worth stating. A human decision on every candidate is the right design at a few hundred places and does not survive a few thousand. Replacing it with a model constrained by deterministic checks raised published coverage from 12 channels to 362, and moved the human role from per-item approval to writing the policy and holding the two capabilities the model may never grant.

Three things follow directly. The projection's reference latitude should be anchored per journey rather than to the city centre, which would cut the worst-case error and requires changing a constant into a value computed once. The photo timing should be repeated on a real handset before the performance requirement can be called met. The 1,217 parent-venue candidates need an ownership decision, which is the largest single block of unresolved coverage. Beyond that, a reusable city package holding the projection, transit feed, operator rules and licences would let the attribution model move to another city, and an Android metadata plugin would close the remaining cross-platform gap.
