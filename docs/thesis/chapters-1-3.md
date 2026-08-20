# 1 Introduction

## 1.1 The problem

Losing something in a city you do not know well is common. The usual advice is to contact the lost-property office. In Berlin that advice does not work, because there is no single office.

The central city office says that its online report only covers items handed in to that office. Items lost on a vehicle or at a station must be reported to the transport company (Bezirksamt Tempelhof-Schöneberg, n.d.; Service Berlin, n.d.). Berlin Brandenburg Airport splits the responsibility further. An item left on a plane belongs to the airline. An item left in a terminal belongs to the airport office. A lost passport belongs to the police (Flughafen Berlin Brandenburg, n.d.-a).

So the traveller has to answer several questions before they can contact anyone. Where was I today? Which lines did I use? Which company runs those lines? Did I enter a venue with its own office? Does the type of item change the rule? Only after that can they start writing the report.

German law splits responsibility the same way. § 965 BGB states the general duty to report a found item. § 978 assigns an item found in a public authority or a public-transport establishment to that authority or establishment (Bundesrepublik Deutschland, n.d.-a, n.d.-b). The task is to map one journey to a set of responsible organisations.

Four things make this hard in practice.

**Responsibility is hidden.** One trip across Berlin can cross several operators. An airport train, a regional train, an underground line, a tram and a bus may be run by different companies on the same ticket. The traveller sees one network and one fare zone. The lost-property system behind it is divided by company. Figure 1-1 shows how one ordinary day splits into separate branches.

*[Figure 1-1. One ordinary day in Berlin splits into five lost-property channels. A lost identity document adds a sixth and seventh branch that no transport operator can replace.]*

**The channels are separate.** Each organisation has its own scope, form and rules. BVG offers an online loss report and says that some low-value items never enter the electronic system (BVG, n.d.). S-Bahn Berlin has its own report, a ten-week storage period, and a rule that mixed stations may fall under DB InfraGO (S-Bahn Berlin GmbH, n.d.). Deutsche Bahn applies its own rules on item value, storage time and which railway companies take part (Deutsche Bahn, n.d.). The airport uses its own form and service point (Flughafen Berlin Brandenburg, n.d.-b). Venues differ too. Zoo Berlin sends enquiries to its service centre before items move on, and Olympiastadion Berlin routes reports by event (Zoo Berlin, n.d.; Olympiastadion Berlin, n.d.). No channel replaces another.

**Language is a barrier.** Official pages may exist in German and English, but the form fields, error messages and conditions do not match between the two. The traveller describes the same facts again for every channel and has to guess which German label fits which fact. The finished reports then differ from each other, which makes them harder to match against a found item.

**Information goes stale.** Travel guides and forum answers are not maintained. The period in which an item is still stored is short. A phone number that no longer works, or a form that has moved, costs the traveller part of that period. A service that publishes contact details needs more than a URL. It needs the source of the detail, a hash of the page, the date it was checked, a record of who accepted it, and a date by which it must be checked again.

## 1.2 Existing services and the gap

Three kinds of service already exist. They differ in where the data sits and in what has to be true before a loss is covered at all. Table 1-1 sets them against one another.

| Architecture | Example | How coverage is obtained | What it assumes | What the traveller still has to do |
| --- | --- | --- | --- | --- |
| Software inside one institution | NotLost | Sold to the organisation that already holds the item; the public reaches it through that organisation | The organisation has bought it and runs it | Identify the organisation, then find its reporting route |
| Consumer aggregator | Verlustsache.de / Nova Find | Member offices publish into one index the traveller can search | Each office has joined voluntarily | Know where and when the loss happened; a loss at a non-member office is absent with no signal |
| Public register | Japanese police system | Law places found items with the authority | An authority that can require participation | Work out the prefecture before searching |

*[Table 1-1. Three architectures for lost-property services, and what each leaves to the traveller.]*

The second row is the closest existing answer to the problem above. Verlustsache.de, the public front end of the Nova Find platform, states coverage of more than 800 institutions in Germany and more than 2,500 across Europe, and names S-Bahn Berlin as a member (Fundservice Deutschland, n.d.). A traveller can register a loss there and be contacted if a matching item appears. The limit is coverage. An operator that has not joined is simply absent, and the interface gives no way to tell that apart from an operator with no matching item. In Berlin the main transport operators each still run their own report.

The third row shows that this split is not permanent. In Japan a legal duty sends found property to the police. The registers are still organised by prefecture, and a person searching is directed to each force's website in turn (National Police Agency, n.d.). Even where one authority holds the items, scope still has to be worked out first.

All three services begin after the traveller knows which organisation to ask. This thesis works on the step before that.

## 1.3 What this thesis builds

The thesis designs and builds a service that treats lost-property reporting as an attribution problem: given one traveller's day, decide which organisations are responsible, then prepare a separate report for each of them. It makes three contributions.

**An attribution model.** Transport lines, places, the real operating company and special item types are mapped into one list of responsible parties with no duplicates. Every entry keeps the reasons that produced it, so the traveller can see why an office is on the list.

**Journey reconstruction on the device.** On iOS the app reads only the capture time and location of each photo through the system photo library. On the web it parses only the Exif fields of files the user selected. Day grouping, time and distance merging, and weighted matching against nearby places produce the anchors. No image leaves the device.

**A channel database with evidence and expiry.** Official pages are crawled under robots rules and a fixed budget, contact details are extracted from HTML, rendered pages and PDF, and every published contact carries an official source, a quoted piece of evidence, a content hash, a review date and an expiry date. Chapter 5 also reports where the review gate had to change: a human decision on every candidate did not scale past a few hundred places, so the decision is now made by a language model whose output is only accepted when deterministic checks against the fetched page pass.

Chapter 2 gives the background, the legal frame and the requirements. Chapter 3 shows the system as a whole. Chapter 4 describes how the traveller application was built. Chapter 5 describes the channel data pipeline. Chapter 6 reports what was measured, checks the requirements, and states what the work does not show.

---

# 2 Background and Requirements

## 2.1 What research and existing services already cover

Published work on lost-property software is mostly about one institution. A campus, a museum or an operator records found items in a database, a claimant describes what they lost, and the system proposes matches. Recent work changes how the matching is done, moving from keyword comparison of free text towards image and text similarity. All of it starts after the item is already held by one known organisation.

A smaller literature studies behaviour instead of software. A large field experiment used dropped wallets to measure return rates in many countries, and found honesty higher than people predicted (Cohn et al., 2019). Experimental work shows that an object can be valued more highly after being lost and recovered (Gärling and Hansla, 2023). Guidance for museum visitor services treats lost property as a working procedure with a collection point, staff awareness and a standard find form (Schäfer, 2016). A venue can therefore not always be reached through its general contact page.

Using the time and position stored in photos to rebuild where somebody has been is an established technique. Studies from the early 2010s onwards mine geotagged photos, mostly from public Flickr collections, to find visited places, put them in order, and derive route recommendations or city-level visitor patterns. The pipeline is close to the one used here: group photos by time and position, order the groups, match the path onto a known network. Two things differ. That work studies many users to reach an aggregate result, while here there is one user, the path is the product, and it stays on the device. That work needs a plausible route, while this work needs the company that runs the line, because the company decides which office applies.

The methods this project borrows are introduced where they are used: map matching in section 4.3, photo metadata in section 4.2, and web extraction and human-in-the-loop review in chapter 5.

## 2.2 Legal and data-protection frame

German law splits responsibility the way the system has to model it. § 965 BGB states the finder's duty to report. § 978 assigns an item found in a public authority or a public-transport establishment to that body (Bundesrepublik Deutschland, n.d.-a, n.d.-b). The attribution model in section 3.2 restates that split in code. It is not an independent theory of who is responsible.

Data-protection law shapes the design more directly. The principles of data minimisation and of data protection by design and by default (European Union, 2016; European Data Protection Board, 2020) are the reason photo metadata is processed on the device, cases are held in local storage, and only limited route-query data is sent once the comparison threshold is met. These principles are used here as engineering constraints. A formal legal compliance assessment is outside the scope of this thesis.

## 2.3 Users and scenarios

Three roles use the system, and they have different permissions. The traveller creates a case on their own device, selects photos, edits the route, opens official forms and records progress. The channel reviewer signs in to a private route and accepts, rejects or clears candidate contacts, and cannot submit anything for a traveller. Scheduled maintenance reads public pages only, follows robots rules and budgets, and cannot publish on its own. Keeping the roles apart is what makes the data governance credible: the person who gains from a channel is never the person who approves it.

Three scenarios show what the system has to do.

**A phone left on an underground train.** The traveller writes a short description of the phone and confirms the date. The app reads the times and coordinates of that day's photos, rebuilds anchors around two central stations, and compares them with transit candidates. The traveller confirms the suggested line. The system maps the operating company to its lost-property office, prepares a German and an English report, and links to the official form. After submitting on that site the traveller returns and marks the report as sent.

**A coat left in a museum.** The photo anchors match a museum. The system prefers a reviewed lost-property channel for that museum or for its parent organisation. If only a general contact form exists, the interface says clearly that this is a fallback and not a dedicated route. The central city office is added only when the traveller states that part of the day was in public space, or that they are unsure.

**A lost passport.** The item type triggers a special rule. Police reporting and the guidance of the traveller's own embassy are shown first, above the transport and venue channels that follow from the journey. The ordinary de-duplication rules must not move them down, because a replacement document cannot be obtained from a transport operator.

## 2.4 Requirements

Five public Reddit threads about Berlin, posted between 2019 and 2024, were reviewed as exploratory evidence. A thread was included when it described a real lost-or-found case and contained a decision about where to report or what to try next. The posts and their substantive replies were coded by hand for uncertainty about time, responsibility, channel availability, language and urgency. No usernames were collected, the evidence is paraphrased, and no private messages were used (Reddit, 2019, 2020, 2021, 2024a, 2024b).

The scale of the problem makes these frictions matter. BVG reports that roughly 50,000 items enter its lost-property office each year, and that about 35 per cent are returned within the six-week storage period (BVG, 2025). The central Berlin office states that its own report does not cover losses on transport services, and that items handed to the police or to citizens' offices can take at least three working days to arrive (Bezirksamt Tempelhof-Schöneberg, n.d.). These are not city-wide recovery rates. They do show a large case volume and a short recovery window.

| Public case | Observed difficulty | Design consequence |
| --- | --- | --- |
| S7 iPhone (Reddit, 2020) | The traveller could not identify the exact loss moment, used limited German, and tried the S-Bahn database while also considering BVG and DB | Accept a date range, infer route candidates from photos, write reports in both languages, and keep more than one plausible operator visible |
| Berlin guide (Reddit, 2019) | A widely shared guide grouped BVG and S-Bahn together; commenters corrected that they are separate channels even at one physical location | Keep office identity separate from address, and explain why each party is on the list |
| S-Bahn documents (Reddit, 2021) | Replies disagreed over whether found documents belonged with BVG or with DB and S-Bahn, and the finder was still unsure afterwards | Map the actual line and operator, keep the uncertainty visible, and never select a generic office silently |
| U9 phone (Reddit, 2024b) | A finder asked which office to use, called the BVG office, and then handed the phone in at a BVG customer centre | Return concrete reporting or hand-in instructions, not only the name of an organisation |
| BER wallet (Reddit, 2024a) | The airport lost-property website was unavailable and the phone line was closed; replies suggested both the airport and the police | Track channel status and label fallbacks clearly, without suggesting that a fallback equals the official channel |

*[Table 2-1. Public-post evidence and the requirement it supports.]*

Across the five cases the repeated need was guidance under uncertainty. Users did not always know the exact moment of the loss, the operator, or whether a channel was reachable at all. The sample is small, self-selected and mostly English-speaking, so it gives no estimate of how often each problem occurs and is treated as exploratory. It was checked against desk research on the central Berlin office, BVG, S-Bahn Berlin, Deutsche Bahn and the airport, which recorded jurisdiction, exclusions, storage periods and submission channels, and confirmed that one journey can involve several offices that do not replace each other.

Prototype testing on an iPhone and in a mobile browser found delays after selecting 50 to 60 photos, photo-permission failures, unintended zooming and scrolling, and a review screen where the map could hide the route list. These observations produced the requirements for visible progress, recoverable permission states, a responsive layout and an explicit route summary. One informal conversation with a traveller showed that they could recall the whole trip but not the exact day, which led to the date-range option.

| ID | Function | Acceptance condition |
| --- | --- | --- |
| F1 | Minimal case creation | Only the description is required; the category is optional; the date defaults to today in Berlin time; an empty description blocks the next step and says why |
| F2 | Photo-first reconstruction | Shows how many photos were scanned, how many had coordinates, the day grouping, the anchors and the transit candidates; the step can be skipped |
| F3 | Manual correction on the map | The map and the day list stay in step; entries can be added and removed at any time |
| F4 | Responsible-party attribution | A list without duplicates, where every entry carries its reasons, its scope, an official source and a verification state |
| F5 | Report text and official channel | German and English text with empty fields left out; the correct official page opens; nothing is sent in the background |
| F6 | Local tracking and assisted filling | States for to do, sent and replied, with a report fingerprint that prevents an identical duplicate; assistance packages expire after about two hours |
| F7 | Channel data with evidence and expiry | A closed loop from discovery to decision, versioned publication, verified client refresh and re-verification |

*[Table 2-2. Functional requirements F1 to F7.]*

The non-functional requirements carry most of the design weight, so each one is written with a condition that can be checked. Section 6.3 returns to this table and reports the result.

| Category | Requirement | How it is checked |
| --- | --- | --- |
| Privacy | Minimise data and process it locally | No pixel data is read on iOS; selected web files are not uploaded; cases, contacts and full journeys never reach the server database |
| Trust | Parties and channels must be explainable | Every published channel has an official URL, a quoted piece of evidence, a content hash, a review time and a review version; a changed hash or a passed deadline stops it counting as current |
| Compliance | Do not work around site rules, and do not give consent for the user | Disallowed paths are not fetched; browser exploration aborts every write request; the extension never fills consent boxes; a final submission needs a second confirmation |
| Security | Resist request forgery, redirects and oversized responses | Unit tests cover private IPv4 and IPv6 ranges, loopback, credential URLs, redirect re-validation and DNS pinning, with a timeout and a body-size limit |
| Offline use | Reporting must survive a failed update service | The mobile build bundles lines, places and a channel snapshot; a failed refresh uses the last verified cache; offline geometry is shown when the online query fails |
| Maintainability | Reuse logic across targets while data evolves separately | Shared logic imports no native bridge; the public schema and manifest are versioned; data resources are hash checked |
| Performance | A large photo selection must give feedback quickly | Bounded concurrency and about fifty progress updates at most on the web; metadata only on iOS; measured times for 1, 10, 30, 60 and 100 photos |

*[Table 2-3. Non-functional requirements and how each is checked.]*

The boundary of the implementation is itself a result, so it is stated plainly. **Implemented:** the web application, the standalone single-page build, the iOS shell and its photo-metadata bridge, the web Exif fallback, photo-based and manual journeys, offline and online route matching, party attribution, German and English reports, local progress tracking, the channel pipeline with automated review and versioned publication, and the security rules for assisted filling. **Partly implemented:** reviewed channels cover the main transport operators and part of the venue inventory; the interface language is mainly English; assisted filling fills fields but never submits. **Not implemented:** an Android photo plugin, a second city, an official receiving API with receipts, automatic submission, account sync across devices, and a study with real users.

---

# 3 System Overview

## 3.1 Four layers and three builds

The system has four layers. The **client layer** holds three delivery targets over one shared logic module. The **edge layer** holds two small HTTP endpoints and the review database. The **governance layer** is an offline command-line pipeline that never runs inside a user request. The **source layer** is external data the project does not control: the VBB transit feed (VBB, n.d.), a community journey service built on the same network (transport.rest, n.d.), OpenStreetMap place geometry and Wikidata website candidates (OpenStreetMap, n.d.; Wikidata, n.d.), and the official websites of operators and venues.

*[Figure 3-1. The four layers. The traveller's client reads only the public channel feed; the review database is reachable only from the private review interface.]*

Public and private routes are server components and never reach the browser. Photo selection, mapping, local storage and the review workbench are client components. The edge layer runs on a serverless JavaScript runtime with web-standard APIs and stores review events in a managed SQLite-compatible database. The mobile target wraps the same web build in a native shell with one small Swift plugin.

Three builds share one logic module: a server-rendered web application, a standalone single-page build, and an iOS shell. This works because of four boundaries that can be checked in code. Shared logic never imports the native bridge. Native capability is detected at run time, so the same module also works in a browser. App-service requests go through a small transport abstraction, while the public data feed stays ordinary read-only HTTPS. The review interface, the crawler and the database code are excluded from the mobile bundle.

## 3.2 The attribution model

A journey is an ordered list of anchors, and each anchor is either a transport line or a place. Let *c* be the item category, and let *u* be true when the traveller says part of the day was in public space or that they are unsure.

For a line anchor the system prefers the operating company reported by the transit data, and falls back to a conservative mapping by transport mode only when no company is known. For a place anchor it chooses in three steps, in order of decreasing evidence: a current reviewed channel, then an official contact that can be explained, then general guidance for that type of venue. Identity documents add police and embassy guidance, and *u* adds the central city office.

The result is the union of these sets with duplicates removed by party identity:

> P = dedup( S(c) ∪ operators(lines) ∪ venues(places) ∪ Z(u) )

De-duplication keeps the evidence. When the same office is reached from several anchors, the reasons, lines, places and journey details are merged as sets, so the traveller sees every reason the office is on the list.

*[Figure 3-2. The attribution model. Two line anchors collapse into one office and the reasons from both are kept.]*

The system does not rank parties by a score that looks like a probability. Parties appear in the order they were first determined, with the facts that produced them. Legal responsibility is a question of scope and evidence. A single confidence number would suggest a precision the data does not have, and would make the output harder for a traveller to question.

## 3.3 Where each kind of data lives

The most important property of the data model is location. Personal data stays on the device. Only channel data reaches the server.

| Object | Where it is stored | Privacy character |
| --- | --- | --- |
| Lost case: item, contact, itinerary, progress, submissions | Browser local storage | Personal; never sent to the server database |
| Photo points and anchors | Component memory and a temporary preview | The full photo geometry is never written into the stored case |
| Party and resolved party | Public static data plus run-time inference | Public institutional data |
| Channel candidate: page, fields, confidence, evidence hash | Private maintenance files | Public web evidence, not published as it stands |
| Review decision: accept or reject, candidate version, content hash | Server database and versioned JSON | The reviewer's real address stays in the private table |
| Published channel: scope, fields, submission mode, verified date, expiry | Versioned public JSON, cached on the device | Reviewed public information only |

*[Table 3-1. Data objects and where each one is stored.]*

The review database uses two tables. The event table is append-only, so a later change never deletes what happened before. The current-state table is keyed by candidate, so serving the public registry does not require scanning the history.
