"use client";

import { ITEM_CATEGORY_META, type ItemCategory, type LostItem } from "../types";

const CATEGORY_ICONS: Record<ItemCategory, string> = {
  bag: "M4.5 8.5h15v11h-15z M9 8.5V6.2a3 3 0 016 0v2.3",
  wallet: "M3.5 7h17v11h-17z M15.5 12.5h3.5",
  phone: "M8 3.5h8v17H8z M11 18h2",
  electronics: "M4 6h16v10H4z M9 20h6",
  documents: "M6.5 3.5h8l3.5 3.5v13.5h-11.5z M9.5 9h5M9.5 12.5h5M9.5 16h3.5",
  keys: "M15 7.5a4 4 0 100 8 4 4 0 000-8z M11 11.5H3.5M5.5 11.5v3",
  camera: "M3.5 8.5h4l2-2h5l2 2h4v10.5h-17z M12 17a3.8 3.8 0 100-7.6 3.8 3.8 0 000 7.6z",
  clothing: "M9 4.2l3 1.8 3-1.8 4.5 2.8-2 3-1-.8v11.3H7.5V9.2l-1 .8-2-3z",
  other: "M6.5 12h.01M12 12h.01M17.5 12h.01",
};

const CATEGORIES = Object.keys(ITEM_CATEGORY_META) as ItemCategory[];

export default function StepItem({
  item,
  onItem,
}: {
  item: LostItem;
  onItem: (patch: Partial<LostItem>) => void;
}) {
  const urgent =
    item.category === "documents"
      ? {
          title: "Report the loss to the police first",
          body: "A lost passport or ID must be reported immediately. Your embassy can issue travel papers.",
          href: "https://www.berlin.de/en/tourism/travel-information/1735948-2862820-lost-and-found-and-lost-property-offices.en.html",
        }
      : item.category === "wallet"
        ? {
            title: "Block your cards first",
            body: "Call your bank now. If the wallet may have been stolen, report the theft to the police.",
            href: "https://www.berlin.de/en/tourism/travel-information/2832639-2862820-pickpockets.en.html",
          }
        : item.category === "phone"
          ? {
              title: "Secure the device first",
              body: "Block the SIM and keep the IMEI number for a police report.",
              href: "https://www.berlin.de/en/tourism/travel-information/2832639-2862820-pickpockets.en.html",
            }
          : null;

  return (
    <div className="lf-describe-form">
      <div className="lf-category-grid lf-stagger" role="group" aria-label="Item category">
        {CATEGORIES.map((category) => {
          const active = item.category === category;
          const label = ITEM_CATEGORY_META[category].label.split(" /")[0].replace("Electronics", "Device").replace("Documents", "Documents");
          return (
            <button
              key={category}
              type="button"
              className={active ? "is-active" : undefined}
              onClick={() => onItem({ category: category })}
              aria-pressed={active}
            >
              <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none">
                <path d={CATEGORY_ICONS[category]} />
              </svg>
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {urgent && (
        <div className="lf-urgent">
          <strong>{urgent.title}</strong>
          <p>{urgent.body}</p>
          <a href={urgent.href} target="_blank" rel="noopener noreferrer">Official guidance ↗</a>
        </div>
      )}

      <label className="lf-field-block">
        <span className="lf-section-label">Description</span>
        <textarea
          value={item.description}
          onChange={(event) => onItem({ description: event.target.value })}
          placeholder="Black Fjällräven backpack, notebook inside, panda charm on the zip"
        />
        <small>Colour, brand, what is inside.</small>
      </label>

      <div className="lf-date-next">
        <span aria-hidden="true">02</span>
        <p>
          <strong>Choose the time window next</strong>
          <small>Know the day? Pick it. Not sure? Select the start and end of your trip, then we only read photos from that range.</small>
        </p>
      </div>

      <label className="lf-unsure">
        <input type="checkbox" checked={Boolean(item.includeCentralOffice)} onChange={(event) => onItem({ includeCentralOffice: event.target.checked })} />
        <i aria-hidden="true">✓</i>
        <span><strong>I am not sure where I lost it</strong><small>Adds Berlin&apos;s city-wide office for streets and taxis.</small></span>
      </label>

      <details className="lf-more-details">
        <summary>More details (optional)</summary>
        <div>
          <label><span>Brand</span><input value={item.brand ?? ""} onChange={(event) => onItem({ brand: event.target.value })} placeholder="e.g. Fjällräven" /></label>
          <label><span>Colour</span><input value={item.color ?? ""} onChange={(event) => onItem({ color: event.target.value })} placeholder="e.g. black" /></label>
          <label><span>Identifying features</span><input value={item.identifyingFeatures ?? ""} onChange={(event) => onItem({ identifyingFeatures: event.target.value })} placeholder="e.g. panda charm" /></label>
          <label><span>Approximate value</span><input value={item.estimatedValue ?? ""} onChange={(event) => onItem({ estimatedValue: event.target.value })} placeholder="e.g. €80" /></label>
          <label><span>City or postcode</span><input value={item.lossCity ?? ""} onChange={(event) => onItem({ lossCity: event.target.value })} placeholder="Berlin 10117" /></label>
        </div>
      </details>
    </div>
  );
}
