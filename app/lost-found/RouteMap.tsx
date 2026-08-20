"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import type { LL } from "../berlin-transit/geo";
import type { SearchItem, SourceIndex } from "./data";
import type { RoutePreview } from "./routePreview";
import type { ItineraryEntry } from "./types";

const BERLIN_CENTRE: LL = [52.52, 13.405];

interface MappedVenue {
  refId: string;
  label: string;
  point: LL;
}

function selectedVenues(
  itinerary: ItineraryEntry[],
  index: SourceIndex | null
): MappedVenue[] {
  if (!index) return [];
  const byRef = new Map<string, SearchItem>(
    index.items.map((item) => [item.refId, item])
  );
  return itinerary.flatMap((entry) => {
    const source = byRef.get(entry.refId);
    return source?.point
      ? [{ refId: entry.refId, label: entry.label, point: source.point }]
      : [];
  });
}

function timeLabel(value: number | null): string | null {
  if (value == null) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default function RouteMap({
  preview,
  index,
  itinerary,
  bottomInset,
}: {
  preview: RoutePreview | null;
  index: SourceIndex | null;
  itinerary: ItineraryEntry[];
  bottomInset: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [ready, setReady] = useState(false);

  const venues = useMemo(
    () => selectedVenues(itinerary, index),
    [index, itinerary]
  );
  const allPoints = useMemo(() => {
    const anchors = preview?.anchors.map((anchor) => anchor.point) ?? [];
    const journey = preview?.journey?.polyline ?? [];
    const offline = preview?.offlinePlan
      ? [
          ...preview.offlinePlan.segments,
          ...preview.offlinePlan.alternatives,
        ].flatMap((line) => line.matchedPolylines.flat())
      : [];
    return [...journey, ...offline, ...anchors, ...venues.map((venue) => venue.point)];
  }, [preview, venues]);

  const sourceLabel = preview?.journey
    ? "VBB route matched to your photos"
    : preview?.offlinePlan
      ? "On-device route estimate"
      : preview?.anchors.length
        ? "Route drawn from photo locations"
        : venues.length
          ? "Places you added"
          : null;

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((leaflet) => {
      if (cancelled || !hostRef.current || mapRef.current) return;
      const map = leaflet.map(hostRef.current, {
        attributionControl: false,
        zoomControl: false,
        minZoom: 9,
        maxZoom: 19,
      });
      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          crossOrigin: true,
        })
        .addTo(map);
      const overlay = leaflet.layerGroup().addTo(map);
      map.setView(BERLIN_CENTRE, 11);
      leafletRef.current = leaflet;
      overlayRef.current = overlay;
      mapRef.current = map;
      setReady(true);
    });
    return () => {
      cancelled = true;
      overlayRef.current = null;
      leafletRef.current = null;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!ready || !leaflet || !map || !overlay) return;
    overlay.clearLayers();

    const anchors = preview?.anchors ?? [];
    const anchorPoints = anchors.map((anchor) => anchor.point);

    if (anchorPoints.length >= 2) {
      leaflet.polyline(anchorPoints, {
        className: "lf-route-line lf-route-line--photo",
        color: "#D8232A",
        weight: 3,
        opacity: 0.8,
        dashArray: "7 7",
        lineCap: "round",
      }).addTo(overlay);
    }

    if (preview?.journey) {
      for (const leg of preview.journey.legs) {
        if (leg.polyline.length < 2) continue;
        leaflet.polyline(leg.polyline, {
          className: "lf-route-line lf-route-line--primary",
          color: leg.walking ? "#4B5563" : leg.color || "#224F86",
          weight: leg.walking ? 4 : 7,
          opacity: leg.walking ? 0.75 : 0.92,
          dashArray: leg.walking ? "4 7" : undefined,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(overlay);
      }
    } else if (preview?.offlinePlan) {
      for (const line of preview.offlinePlan.alternatives) {
        for (const polyline of line.matchedPolylines) {
          if (polyline.length < 2) continue;
          leaflet.polyline(polyline, {
            className: "lf-route-line lf-route-line--alternative",
            color: line.color || "#64748B",
            weight: 5,
            opacity: line.priority === "medium" ? 0.38 : 0.2,
            lineCap: "round",
          }).addTo(overlay);
        }
      }
      for (const line of preview.offlinePlan.segments) {
        for (const polyline of line.matchedPolylines) {
          if (polyline.length < 2) continue;
          leaflet.polyline(polyline, {
            className: "lf-route-line lf-route-line--primary",
            color: line.color || "#224F86",
            weight: line.priority === "high" ? 7 : 5,
            opacity: line.priority === "high" ? 0.92 : 0.45,
            lineCap: "round",
          }).addTo(overlay);
        }
      }
    }

    anchors.forEach((anchor, anchorIndex) => {
      const label = anchor.venue?.label ?? `Photo location ${anchorIndex + 1}`;
      const time = timeLabel(anchor.time);
      leaflet
        .marker(anchor.point, {
          icon: leaflet.divIcon({
            className: "lf-route-anchor-icon",
            html: `<span>${anchorIndex + 1}</span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
          keyboard: false,
        })
        .bindTooltip(time ? `${time} · ${label}` : label, { direction: "top" })
        .addTo(overlay);
    });

    const anchorVenueRefs = new Set(
      anchors.map((anchor) => anchor.venue?.refId).filter(Boolean)
    );
    for (const venue of venues) {
      if (anchorVenueRefs.has(venue.refId)) continue;
      leaflet
        .circleMarker(venue.point, {
          className: "lf-route-venue-marker",
          radius: 8,
          color: "#FFFFFF",
          weight: 3,
          fillColor: "#10161C",
          fillOpacity: 1,
        })
        .bindTooltip(venue.label, { direction: "top" })
        .addTo(overlay);
    }

    window.requestAnimationFrame(() => {
      map.invalidateSize(false);
      if (allPoints.length) {
        const bounds = leaflet.latLngBounds(allPoints);
        map.fitBounds(bounds, {
          animate: false,
          maxZoom: allPoints.length === 1 ? 15 : 17,
          paddingTopLeft: [36, 128],
          paddingBottomRight: [36, bottomInset],
        });
      } else {
        map.setView(BERLIN_CENTRE, 11, { animate: false });
      }
    });
  }, [allPoints, bottomInset, preview, ready, venues]);

  return (
    <div
      className="lf-route-map"
      style={{ "--lf-map-bottom-inset": `${bottomInset}px` } as React.CSSProperties}
    >
      <div ref={hostRef} className="lf-route-map-canvas" aria-label="Map of your reconstructed route through Berlin" role="img" />
      {sourceLabel && <span className="lf-map-source-label">{sourceLabel}</span>}
      {!allPoints.length && (
        <div className="lf-map-empty">
          <strong>No route to draw yet</strong>
          <span>Read photo locations or add a place below.</span>
        </div>
      )}
      <a
        className="lf-map-attribution"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap contributors
      </a>
    </div>
  );
}
