"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LayerGroup as LLayerGroup,
  Map as LMap,
  Polyline as LPolyline,
} from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LL } from "./geo";
import {
  inferJourney,
  type JourneyMatch,
  modeLabel,
  type TransitMode,
  type TransitNetwork,
} from "./transit";
import {
  fetchVbbTraceJourneys,
  formatDateTimeLocal,
  type LiveJourneyCandidate,
  type ModeFilter,
  VbbUnavailableError,
} from "./vbb";
import {
  type Attraction,
  type AttractionCategory,
  type CategoryFilter,
  ATTRACTION_CATEGORIES,
  CATEGORY_META,
  INITIAL_CATEGORY_FILTER,
  attractionWikiUrl,
} from "./attractions";

const BERLIN_CENTER: [number, number] = [52.52, 13.405];
const DRAW_COLOR = "#F05A28";
const PIN_ROUTE_STORAGE_KEY = "berlin-trace-pin-route-v1";
const MODE_ORDER: TransitMode[] = [
  "subway",
  "light_rail",
  "tram",
  "bus",
  "rail",
  "ferry",
];

const INITIAL_MODES: ModeFilter = {
  subway: true,
  light_rail: true,
  tram: true,
  bus: true,
  rail: true,
  ferry: true,
};

type RoutePin = {
  id: string;
  point: LL;
  kind: "attraction" | "bend";
  label: string;
  attractionId?: string;
  color?: string;
};

function createRoutePin(
  point: LL,
  input?: Pick<RoutePin, "kind" | "label" | "attractionId" | "color">
): RoutePin {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    point,
    kind: input?.kind ?? "bend",
    label: input?.label ?? "路线拐点",
    attractionId: input?.attractionId,
    color: input?.color,
  };
}

function isStoredRoutePin(value: unknown): value is RoutePin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoutePin>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "attraction" || candidate.kind === "bend") &&
    typeof candidate.label === "string" &&
    Array.isArray(candidate.point) &&
    candidate.point.length === 2 &&
    candidate.point.every((coordinate) => typeof coordinate === "number")
  );
}

function nailIcon(
  L: typeof import("leaflet"),
  options: { color: string; selected?: boolean; number?: number; bend?: boolean }
) {
  const classes = [
    "map-nail",
    options.selected ? "map-nail--selected" : "",
    options.bend ? "map-nail--bend" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const number = options.number
    ? `<span class="map-nail__number">${options.number}</span>`
    : "";
  return L.divIcon({
    className: "map-nail-icon",
    html: `<span class="${classes}" style="--nail-color:${options.color}"><span class="map-nail__shadow"></span><span class="map-nail__stem"></span><span class="map-nail__head">${number}</span><span class="map-nail__shine"></span></span>`,
    iconSize: [34, 42],
    iconAnchor: [17, 37],
    tooltipAnchor: [0, -34],
  });
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char
  );
}

function confidenceLabel(confidence: number) {
  if (confidence >= 0.78) return "较高";
  if (confidence >= 0.55) return "中等";
  return "较低";
}

function formatTime(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function formatDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Europe/Berlin",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}

function journeyLineSummary(journey: LiveJourneyCandidate) {
  return journey.legs
    .filter((leg) => !leg.walking)
    .map((leg) => leg.lineRef)
    .filter((line, index, all) => line && line !== all[index - 1])
    .join(" → ");
}

export default function TransitMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const drawingRef = useRef(false);
  const previewRef = useRef<LPolyline | null>(null);
  const threadGroupRef = useRef<LLayerGroup | null>(null);
  const threadLinesRef = useRef<LPolyline[]>([]);
  const routePinsRef = useRef<RoutePin[]>([]);
  const drawnPathRef = useRef<LL[] | null>(null);
  const resultsGroupRef = useRef<LLayerGroup | null>(null);
  const resultLayersRef = useRef<Map<string, LPolyline[]>>(new Map());
  const attractionsGroupRef = useRef<LLayerGroup | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const commitPathRef = useRef<(path: LL[]) => void>(() => {});
  const addBendPinRef = useRef<(point: LL) => void>(() => {});
  const finishThreadRef = useRef<() => void>(() => {});
  const undoPinRef = useRef<() => void>(() => {});

  const [network, setNetwork] = useState<TransitNetwork | null>(null);
  const [ready, setReady] = useState(false);
  const [drawing, setDrawing] = useState(true);
  const [routePins, setRoutePins] = useState<RoutePin[]>([]);
  const [routeHydrated, setRouteHydrated] = useState(false);
  const [drawnPath, setDrawnPath] = useState<LL[] | null>(null);
  const [journey, setJourney] = useState<JourneyMatch | null>(null);
  const [liveJourneys, setLiveJourneys] = useState<LiveJourneyCandidate[]>([]);
  const [selectedJourneyIndex, setSelectedJourneyIndex] = useState(0);
  const [departure, setDeparture] = useState(() => formatDateTimeLocal(new Date()));
  const [journeyNotice, setJourneyNotice] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [modes, setModes] = useState<ModeFilter>(INITIAL_MODES);
  const [error, setError] = useState<string | null>(null);
  const [attractions, setAttractions] = useState<Attraction[] | null>(null);
  const [showAttractions, setShowAttractions] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(
    INITIAL_CATEGORY_FILTER
  );
  const liveJourney = liveJourneys[selectedJourneyIndex] ?? null;

  useEffect(() => {
    let cancelled = false;
    fetch("/berlin-transit.json")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setNetwork(data as TransitNetwork);
      })
      .catch((reason) => {
        if (!cancelled) setError(`无法加载柏林交通数据：${reason.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the sightseeing layer. A failure here is non-fatal for the core app.
  useEffect(() => {
    let cancelled = false;
    fetch("/berlin-attractions.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const set = data as { attractions?: Attraction[] } | null;
        if (!cancelled && set?.attractions) setAttractions(set.attractions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(PIN_ROUTE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as unknown;
          if (Array.isArray(parsed)) {
            setRoutePins(parsed.filter(isStoredRoutePin).slice(0, 80));
          }
        }
      } catch {
        // A blocked or invalid local store should never stop the map from working.
      } finally {
        setRouteHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    routePinsRef.current = routePins;
    if (!routeHydrated) return;
    try {
      window.localStorage.setItem(PIN_ROUTE_STORAGE_KEY, JSON.stringify(routePins));
    } catch {
      // Device persistence is a convenience; in-memory routing still works.
    }
  }, [routeHydrated, routePins]);

  useEffect(() => {
    drawnPathRef.current = drawnPath;
  }, [drawnPath]);

  useEffect(() => {
    let disposed = false;
    let cleanupInput: (() => void) | undefined;

    (async () => {
      try {
        const L = await import("leaflet");
        if (disposed || !containerRef.current) return;
        LRef.current = L;

        const map = L.map(containerRef.current, {
          center: BERLIN_CENTER,
          zoom: 12,
          zoomControl: true,
          maxBounds: L.latLngBounds([52.28, 12.98], [52.72, 13.86]),
          maxBoundsViscosity: 0.7,
          minZoom: 10,
        });
        mapRef.current = map;

        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
        L.tileLayer(
          `https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`,
          {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: "abcd",
            maxZoom: 19,
          }
        ).addTo(map);

        const threadPane = map.createPane("threadPane");
        threadPane.style.zIndex = "450";
        threadPane.style.pointerEvents = "none";

        // Pins sit above the map, with the thread and matched routes beneath them.
        attractionsGroupRef.current = L.layerGroup().addTo(map);
        threadGroupRef.current = L.layerGroup().addTo(map);
        resultsGroupRef.current = L.layerGroup().addTo(map);
        const element = containerRef.current;
        const clearPreview = () => {
          previewRef.current?.remove();
          previewRef.current = null;
        };

        const onMapClick = (event: import("leaflet").LeafletMouseEvent) => {
          if (!drawingRef.current) return;
          addBendPinRef.current([event.latlng.lat, event.latlng.lng]);
        };

        const onMapMove = (event: import("leaflet").LeafletMouseEvent) => {
          const pins = routePinsRef.current;
          if (!drawingRef.current || pins.length === 0) {
            clearPreview();
            return;
          }
          const positions: LL[] = [
            pins[pins.length - 1].point,
            [event.latlng.lat, event.latlng.lng],
          ];
          if (!previewRef.current) {
            previewRef.current = L.polyline(positions, {
              pane: "threadPane",
              className: "thread-preview",
              color: DRAW_COLOR,
              weight: 3,
              opacity: 0.72,
              dashArray: "4 7",
              interactive: false,
            }).addTo(map);
          } else {
            previewRef.current.setLatLngs(positions);
          }
        };

        const onKeyDown = (event: KeyboardEvent) => {
          if (!drawingRef.current) return;
          if (event.code === "Space") {
            event.preventDefault();
            event.stopImmediatePropagation();
            const center = map.getCenter();
            addBendPinRef.current([center.lat, center.lng]);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopImmediatePropagation();
            finishThreadRef.current();
            return;
          }
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            event.stopImmediatePropagation();
            undoPinRef.current();
          }
        };

        map.on("click", onMapClick);
        map.on("mousemove", onMapMove);
        map.on("mouseout", clearPreview);
        element.addEventListener("keydown", onKeyDown, true);
        cleanupInput = () => {
          map.off("click", onMapClick);
          map.off("mousemove", onMapMove);
          map.off("mouseout", clearPreview);
          element.removeEventListener("keydown", onKeyDown, true);
        };

        const resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(element);
        resizeObsRef.current = resizeObserver;
        setReady(true);
        setTimeout(() => map.invalidateSize(), 0);
      } catch (reason) {
        if (!disposed) {
          const message = reason instanceof Error ? reason.message : "未知错误";
          setError(`无法初始化地图：${message}`);
        }
      }
    })();

    return () => {
      disposed = true;
      cleanupInput?.();
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    drawingRef.current = drawing;
    const map = mapRef.current;
    const element = containerRef.current;
    if (!map || !element) return;
    if (drawing) {
      map.dragging.disable();
      map.doubleClickZoom.disable();
      map.boxZoom.disable();
      element.style.cursor = "crosshair";
      element.style.touchAction = "none";
    } else {
      previewRef.current?.remove();
      previewRef.current = null;
      map.dragging.enable();
      map.doubleClickZoom.enable();
      map.boxZoom.enable();
      element.style.cursor = "grab";
      element.style.touchAction = "";
    }
  }, [drawing, ready]);

  const resetAnalysis = useCallback(() => {
    setDrawnPath(null);
    setJourney(null);
    setLiveJourneys([]);
    setSelectedJourneyIndex(0);
    setJourneyNotice(null);
    setAnalyzing(false);
    setHovered(null);
    resultsGroupRef.current?.clearLayers();
    resultLayersRef.current.clear();
  }, []);

  const commitPath = useCallback((path: LL[]) => {
    setDrawnPath(path);
    setJourney(null);
    setLiveJourneys([]);
    setSelectedJourneyIndex(0);
    setJourneyNotice(null);
  }, []);

  useEffect(() => {
    commitPathRef.current = commitPath;
  }, [commitPath]);

  const addBendPin = useCallback(
    (point: LL) => {
      resetAnalysis();
      setRoutePins((current) => [
        ...current,
        createRoutePin(point, {
          kind: "bend",
          label: `拐点 ${current.filter((pin) => pin.kind === "bend").length + 1}`,
          color: DRAW_COLOR,
        }),
      ]);
    },
    [resetAnalysis]
  );

  const addAttractionPin = useCallback(
    (attraction: Attraction) => {
      if (routePinsRef.current[routePinsRef.current.length - 1]?.attractionId === attraction.id) {
        return;
      }
      resetAnalysis();
      setRoutePins((current) => {
        if (current[current.length - 1]?.attractionId === attraction.id) return current;
        const meta = CATEGORY_META[attraction.category];
        return [
          ...current,
          createRoutePin(attraction.point, {
            kind: "attraction",
            label: attraction.name,
            attractionId: attraction.id,
            color: meta.color,
          }),
        ];
      });
    },
    [resetAnalysis]
  );

  const finishThread = useCallback(() => {
    const positions = routePinsRef.current.map((pin) => pin.point);
    if (positions.length < 2) return;
    previewRef.current?.remove();
    previewRef.current = null;
    commitPath(positions);
  }, [commitPath]);

  const undoPin = useCallback(() => {
    if (routePinsRef.current.length === 0) return;
    resetAnalysis();
    setRoutePins((current) => current.slice(0, -1));
  }, [resetAnalysis]);

  const removePin = useCallback(
    (id: string) => {
      resetAnalysis();
      setRoutePins((current) => current.filter((pin) => pin.id !== id));
    },
    [resetAnalysis]
  );

  useEffect(() => {
    addBendPinRef.current = addBendPin;
    finishThreadRef.current = finishThread;
    undoPinRef.current = undoPin;
  }, [addBendPin, finishThread, undoPin]);

  // Ask VBB for journeys that were actually possible at the selected time,
  // then use the drawing only to rank those schedule-valid alternatives.
  useEffect(() => {
    if (!drawnPath || !network) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setAnalyzing(true);
      setJourneyNotice(null);
      setJourney(null);
      setLiveJourneys([]);
      try {
        const candidates = await fetchVbbTraceJourneys({
          drawn: drawnPath,
          departure,
          modes,
          lines: network.lines,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setLiveJourneys(candidates);
        setSelectedJourneyIndex(0);
      } catch (reason) {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "VBB 查询失败";
        if (reason instanceof VbbUnavailableError) {
          const enabledLines = network.lines.filter((line) => modes[line.mode]);
          setJourney(inferJourney(drawnPath, enabledLines));
          setJourneyNotice(`${message} 已切换为离线几何估算。`);
        } else {
          setJourney(null);
          setJourneyNotice(message);
        }
      } finally {
        if (!controller.signal.aborted) setAnalyzing(false);
      }
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [departure, drawnPath, modes, network]);

  useEffect(() => {
    const L = LRef.current;
    const group = threadGroupRef.current;
    if (!L || !group) return;
    group.clearLayers();
    threadLinesRef.current = [];
    const positions = routePins.map((pin) => pin.point);

    if (positions.length >= 2) {
      const shadow = L.polyline(positions, {
        pane: "threadPane",
        className: "thread-line thread-line--shadow",
        color: "#4b1f18",
        weight: 7,
        opacity: 0.28,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(group);
      const yarn = L.polyline(positions, {
        pane: "threadPane",
        className: "thread-line thread-line--yarn",
        color: DRAW_COLOR,
        weight: 4,
        opacity: 0.98,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(group);
      const highlight = L.polyline(positions, {
        pane: "threadPane",
        className: "thread-line thread-line--highlight",
        color: "#ffb393",
        weight: 1,
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(group);
      threadLinesRef.current = [shadow, yarn, highlight];
    }

    routePins.forEach((pin, index) => {
      const marker = L.marker(pin.point, {
        icon: nailIcon(L, {
          color: pin.color ?? DRAW_COLOR,
          selected: true,
          number: index + 1,
          bend: pin.kind === "bend",
        }),
        draggable: pin.kind === "bend",
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: 800 + index,
        title: `${index + 1}. ${pin.label}`,
      })
        .addTo(group)
        .bindTooltip(
          `${index + 1}. ${pin.label}${pin.kind === "bend" ? " · 可拖动调整" : ""}`,
          { direction: "top", offset: [0, -28] }
        );
      marker.on("click", (event) => event.originalEvent?.stopPropagation());
      if (pin.kind === "bend") {
        marker.on("drag", () => {
          const next = marker.getLatLng();
          const nextPositions = routePinsRef.current.map((current, currentIndex) =>
            currentIndex === index
              ? ([next.lat, next.lng] as LL)
              : current.point
          );
          threadLinesRef.current.forEach((line) => line.setLatLngs(nextPositions));
        });
        marker.on("dragend", () => {
          const next = marker.getLatLng();
          const updated = routePinsRef.current.map((current, currentIndex) =>
            currentIndex === index
              ? { ...current, point: [next.lat, next.lng] as LL }
              : current
          );
          setRoutePins(updated);
          if (drawnPathRef.current) {
            commitPathRef.current(updated.map((current) => current.point));
          }
        });
      }
    });
  }, [ready, routePins]);

  useEffect(() => {
    const L = LRef.current;
    const group = resultsGroupRef.current;
    if (!L || !group) return;
    group.clearLayers();
    resultLayersRef.current.clear();
    if (liveJourney) {
      liveJourney.legs.forEach((leg, index) => {
        if (leg.polyline.length < 2) return;
        const layers = resultLayersRef.current.get(leg.id) ?? [];
        if (!leg.walking) {
          L.polyline(leg.polyline, {
            color: "#FFFFFF",
            weight: 10,
            opacity: 0.8,
            interactive: false,
          }).addTo(group);
        }
        const layer = L.polyline(leg.polyline, {
          color: leg.color,
          weight: leg.walking ? 4 : 6,
          opacity: leg.walking ? 0.72 : 0.98,
          dashArray: leg.walking ? "4 7" : undefined,
        })
          .addTo(group)
          .bindTooltip(
            leg.walking
              ? `步行 · ${leg.originName} → ${leg.destinationName}`
              : `${leg.lineRef} 往 ${leg.direction ?? leg.destinationName} · ${formatTime(leg.departure)}–${formatTime(leg.arrival)}`,
            { sticky: true }
          );
        layer.on("mouseover", () => setHovered(leg.id));
        layer.on("mouseout", () => setHovered(null));
        layers.push(layer);
        resultLayersRef.current.set(leg.id, layers);

        const start = leg.polyline[0];
        if (index === 0 || (!leg.walking && liveJourney.legs[index - 1])) {
          L.circleMarker(start, {
            radius: index === 0 ? 6 : 5,
            color: "#FFFFFF",
            weight: 2,
            fillColor: leg.color,
            fillOpacity: 1,
            interactive: false,
          }).addTo(group);
        }
        if (index === liveJourney.legs.length - 1) {
          L.circleMarker(leg.polyline[leg.polyline.length - 1], {
            radius: 6,
            color: "#FFFFFF",
            weight: 2,
            fillColor: leg.color,
            fillOpacity: 1,
            interactive: false,
          }).addTo(group);
        }
      });
      return;
    }

    if (!journey) return;

    journey.alternatives.forEach((alternative) => {
      alternative.matchedPolylines.forEach((polyline) => {
        L.polyline(polyline, {
          color: alternative.line.color,
          weight: 4,
          opacity: 0.38,
          dashArray: "5 7",
          interactive: false,
        }).addTo(group);
      });
    });

    journey.segments.forEach((segment, index) => {
      const layers = resultLayersRef.current.get(segment.line.id) ?? [];
      segment.matchedPolylines.forEach((polyline) => {
        L.polyline(polyline, {
          color: "#FFFFFF",
          weight: 10,
          opacity: 0.78,
          interactive: false,
        }).addTo(group);
        const layer = L.polyline(polyline, {
          color: segment.line.color,
          weight: 6,
          opacity: 0.96,
        })
          .addTo(group)
          .bindTooltip(
            `${index + 1}. ${segment.line.ref} · ${segment.boardStop?.name ?? "轨迹起点"} → ${segment.alightStop?.name ?? "轨迹终点"}`,
            { sticky: true }
          );
        layer.on("mouseover", () => setHovered(segment.line.id));
        layer.on("mouseout", () => setHovered(null));
        layers.push(layer);
      });
      resultLayersRef.current.set(segment.line.id, layers);

      L.circleMarker(segment.start, {
        radius: 5,
        color: "#FFFFFF",
        weight: 2,
        fillColor: segment.line.color,
        fillOpacity: 1,
        interactive: false,
      }).addTo(group);
      if (index === journey.segments.length - 1) {
        L.circleMarker(segment.end, {
          radius: 5,
          color: "#FFFFFF",
          weight: 2,
          fillColor: segment.line.color,
          fillOpacity: 1,
          interactive: false,
        }).addTo(group);
      }
    });
  }, [journey, liveJourney]);

  useEffect(() => {
    resultLayersRef.current.forEach((layers, lineId) => {
      const active = lineId === hovered;
      layers.forEach((layer) => {
        layer.setStyle({ weight: active ? 9 : 6, opacity: active ? 1 : 0.96 });
        if (active) layer.bringToFront();
      });
    });
  }, [hovered]);

  // Render attraction markers for the enabled categories.
  useEffect(() => {
    const L = LRef.current;
    const group = attractionsGroupRef.current;
    const map = mapRef.current;
    if (!L || !group || !map) return;
    group.clearLayers();
    if (!showAttractions || !attractions) return;
    for (const attraction of attractions) {
      if (!categoryFilter[attraction.category]) continue;
      const meta = CATEGORY_META[attraction.category];
      const marker = L.marker(attraction.point, {
        icon: nailIcon(L, { color: meta.color }),
        keyboard: true,
        riseOnHover: true,
        title: attraction.name,
      })
        .addTo(group)
        .bindTooltip(`${meta.emoji} ${attraction.name} · ${drawing ? "点击穿线" : "点击查看"}`, {
          direction: "top",
          offset: [0, -28],
        });
      const url = attractionWikiUrl(attraction);
      const popupHtml =
        `<div style="min-width:150px;line-height:1.4">` +
          `<div style="font-weight:600">${meta.emoji} ${escapeHtml(attraction.name)}</div>` +
          (attraction.nameEn
            ? `<div style="color:#78716c;font-size:11px">${escapeHtml(attraction.nameEn)}</div>`
            : "") +
          `<div style="color:${meta.color};font-size:11px;margin-top:2px">${meta.label}</div>` +
          (url
            ? `<a href="${url}" target="_blank" rel="noreferrer" style="color:#ea580c;font-size:11px">维基百科 ↗</a>`
            : "") +
          `</div>`;
      marker.on("click", (event) => {
        event.originalEvent?.stopPropagation();
        if (drawingRef.current) {
          addAttractionPin(attraction);
          return;
        }
        L.popup({ offset: [0, -28] })
          .setLatLng(attraction.point)
          .setContent(popupHtml)
          .openOn(map);
      });
    }
  }, [addAttractionPin, attractions, showAttractions, categoryFilter, drawing, ready]);

  const clearAll = useCallback(() => {
    previewRef.current?.remove();
    previewRef.current = null;
    setRoutePins([]);
    resetAnalysis();
  }, [resetAnalysis]);

  const toggleMode = (mode: TransitMode) => {
    setModes((current) => ({ ...current, [mode]: !current[mode] }));
  };

  const toggleCategory = (category: AttractionCategory) => {
    setCategoryFilter((current) => ({
      ...current,
      [category]: !current[category],
    }));
  };

  const visibleAttractions =
    showAttractions && attractions
      ? attractions.filter((attraction) => categoryFilter[attraction.category])
          .length
      : 0;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-stone-200 font-sans text-stone-950 dark:bg-stone-900 dark:text-stone-50">
      <div
        ref={containerRef}
        className="absolute inset-0 z-0"
        role="application"
        tabIndex={0}
        aria-keyshortcuts="Space Enter Backspace Delete"
        aria-label="柏林图钉路线地图。在穿线模式中点击景点图钉或地图空白处记录节点；空格在地图中心加拐点，回车完成，退格撤销。"
      />

      <section className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex justify-center p-3 sm:justify-start sm:p-5">
        <div className="pointer-events-auto max-h-[74dvh] w-full max-w-[430px] overflow-y-auto rounded-[22px] border border-white/70 bg-white/92 p-4 shadow-[0_18px_55px_rgba(28,25,23,0.18)] backdrop-blur-xl dark:border-white/10 dark:bg-stone-950/90 sm:max-h-[calc(100dvh-2.5rem)] sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold tracking-[0.16em] text-orange-600 uppercase">
                Berlin Trace
              </p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight">用图钉与丝线串起柏林轨迹</h1>
            </div>
            <span className="mt-0.5 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              仅限柏林
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-stone-600 dark:text-stone-400">
            点一个景点钉开始，移动时丝线会跟着你；继续点景点，或在空白处落下一个可拖动的拐点。
          </p>
          <p className="mt-1 text-[10px] leading-4 text-stone-400">
            每个落点都会记录坐标并保存在本机。至少两个点后即可完成穿线并推测行程。
          </p>

          <div className="mt-4 grid grid-cols-2 rounded-xl bg-stone-100 p-1 dark:bg-stone-800" aria-label="地图操作模式">
            <button
              type="button"
              aria-pressed={drawing}
              onClick={() => setDrawing(true)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                drawing
                  ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white"
                  : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-white"
              }`}
            >
              穿线模式
            </button>
            <button
              type="button"
              aria-pressed={!drawing}
              onClick={() => setDrawing(false)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                !drawing
                  ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white"
                  : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-white"
              }`}
            >
              平移地图
            </button>
          </div>

          <div className="mt-3 rounded-2xl border border-orange-200/80 bg-orange-50/85 p-3 dark:border-orange-900/70 dark:bg-orange-950/35">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-[0.12em] text-orange-700 uppercase dark:text-orange-300">
                  {drawnPath ? "丝线已固定" : routePins.length ? "正在拉线" : "等待第一枚图钉"}
                </p>
                <p className="mt-1 text-xs leading-5 text-stone-700 dark:text-stone-200" aria-live="polite">
                  {drawnPath
                    ? `已用 ${routePins.length} 个节点固定路线；继续点击可延长。`
                    : routePins.length
                      ? `已记录 ${routePins.length} 个节点，点击下一处让丝线转向。`
                      : "点击任意景点钉，或点击地图空白处开始。"}
                </p>
              </div>
              <span className="relative mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-black text-white shadow-[0_4px_10px_rgba(194,65,12,0.35)] ring-2 ring-white dark:ring-stone-900">
                {routePins.length || "+"}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-[1fr_1.35fr] gap-2">
              <button
                type="button"
                onClick={undoPin}
                disabled={routePins.length === 0}
                className="rounded-xl border border-orange-200 bg-white/75 px-3 py-2 text-[11px] font-semibold text-stone-600 transition hover:border-orange-400 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-orange-900 dark:bg-stone-900/60 dark:text-stone-300"
              >
                撤回上一钉
              </button>
              <button
                type="button"
                onClick={finishThread}
                disabled={routePins.length < 2}
                className="rounded-xl bg-orange-600 px-3 py-2 text-[11px] font-bold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-orange-300 dark:disabled:bg-orange-950 dark:disabled:text-orange-700"
              >
                {drawnPath ? "重新匹配路线" : "固定丝线并匹配"}
              </button>
            </div>

            {routePins.length > 0 && (
              <details className="mt-2 border-t border-orange-200/80 pt-2 dark:border-orange-900/70">
                <summary className="cursor-pointer text-[10px] font-semibold text-orange-800 outline-none dark:text-orange-300">
                  节点记录 · {routePins.length} 个精确坐标
                </summary>
                <ol className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1">
                  {routePins.map((pin, index) => (
                    <li
                      key={pin.id}
                      className="grid grid-cols-[20px_1fr_auto] items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5 text-[10px] dark:bg-stone-900/60"
                    >
                      <span
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black text-white"
                        style={{ backgroundColor: pin.color ?? DRAW_COLOR }}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-stone-700 dark:text-stone-200">
                          {pin.label}
                        </span>
                        <span className="block font-mono text-[9px] text-stone-400">
                          {pin.point[0].toFixed(5)}, {pin.point[1].toFixed(5)}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removePin(pin.id)}
                        className="rounded-full px-1.5 py-1 text-stone-400 transition hover:bg-stone-100 hover:text-red-600 dark:hover:bg-stone-800"
                        aria-label={`删除节点 ${index + 1}：${pin.label}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="交通方式筛选">
            {MODE_ORDER.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={modes[mode]}
                onClick={() => toggleMode(mode)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                  modes[mode]
                    ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950"
                    : "border-stone-300 bg-white/60 text-stone-500 hover:border-stone-500 dark:border-stone-700 dark:bg-transparent dark:text-stone-500"
                }`}
              >
                {modeLabel(mode)}
              </button>
            ))}
          </div>

          <label className="mt-3 block">
            <span className="mb-1.5 flex items-center justify-between text-[10px] font-semibold text-stone-500">
              <span>出发日期与时间</span>
              <span className="font-normal text-stone-400">柏林当地时间</span>
            </span>
            <input
              type="datetime-local"
              value={departure}
              onChange={(event) => setDeparture(event.target.value)}
              className="w-full rounded-xl border border-stone-200 bg-white/70 px-3 py-2 text-xs text-stone-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:focus:ring-orange-950"
              aria-label="历史行程的出发日期与时间"
            />
          </label>

          <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-800">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-stone-500">
                景点图层
                {showAttractions && attractions ? ` · ${visibleAttractions}` : ""}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={showAttractions}
                onClick={() => setShowAttractions((value) => !value)}
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold transition ${
                  showAttractions
                    ? "bg-orange-500 text-white"
                    : "bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-400"
                }`}
              >
                {showAttractions ? "显示中" : "已隐藏"}
              </button>
            </div>
            {showAttractions && (
              <div className="mt-2 flex flex-wrap gap-1" aria-label="景点分类筛选">
                {ATTRACTION_CATEGORIES.map((category) => {
                  const meta = CATEGORY_META[category];
                  const on = categoryFilter[category];
                  return (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleCategory(category)}
                      style={on ? { borderColor: meta.color } : undefined}
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
                        on
                          ? "bg-white text-stone-800 dark:bg-stone-800 dark:text-stone-100"
                          : "border-stone-200 text-stone-400 dark:border-stone-700"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: on ? meta.color : "transparent",
                          border: on ? undefined : `1px solid ${meta.color}`,
                        }}
                      />
                      {meta.emoji} {meta.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-200 pt-3 dark:border-stone-800">
            <p className="min-w-0 truncate text-[10px] text-stone-500" aria-live="polite">
              {error
                ? error
                : network
                  ? `${network.lines.length} 条线路 · VBB 实时行程接口已启用`
                  : "正在加载 VBB 交通网络…"}
            </p>
            <button
              type="button"
              onClick={clearAll}
              disabled={routePins.length === 0}
              className="shrink-0 text-[11px] font-semibold text-orange-600 transition hover:text-orange-700 disabled:cursor-not-allowed disabled:text-stone-300 dark:disabled:text-stone-700"
            >
              清空图钉
            </button>
          </div>
        </div>
      </section>

      {drawnPath && (
        <section
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex justify-center p-3 sm:right-5 sm:left-auto sm:justify-end sm:p-5"
          aria-live="polite"
          aria-busy={analyzing}
        >
          <div className="pointer-events-auto max-h-[48dvh] w-full max-w-[420px] overflow-y-auto rounded-[22px] border border-white/70 bg-white/94 p-4 shadow-[0_18px_55px_rgba(28,25,23,0.2)] backdrop-blur-xl dark:border-white/10 dark:bg-stone-950/92 sm:max-h-[62dvh] sm:p-5">
            {analyzing ? (
              <div className="flex items-center gap-3 py-2 text-sm text-stone-600 dark:text-stone-300">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-orange-500" />
                正在查询 VBB 当时可乘方案并比对轨迹…
              </div>
            ) : liveJourney ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[10px] font-bold tracking-[0.14em] text-emerald-700 uppercase dark:text-emerald-400">
                        VBB 可乘方案
                      </p>
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        时刻表验证
                      </span>
                    </div>
                    <h2 className="mt-1 truncate text-base font-semibold">{journeyLineSummary(liveJourney)}</h2>
                    <p className="mt-1 text-[10px] text-stone-400">
                      {formatDate(liveJourney.departure)} · {formatTime(liveJourney.departure)}–{formatTime(liveJourney.arrival)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-bold text-orange-600">
                      {Math.round(liveJourney.similarity)}%
                    </div>
                    <div className="text-[10px] text-stone-400">轨迹相似度</div>
                  </div>
                </div>

                {liveJourneys.length > 1 && (
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="真实行程候选">
                    {liveJourneys.slice(0, 4).map((candidate, index) => (
                      <button
                        key={candidate.id}
                        type="button"
                        aria-pressed={selectedJourneyIndex === index}
                        onClick={() => setSelectedJourneyIndex(index)}
                        className={`shrink-0 rounded-xl border px-2.5 py-2 text-left transition ${
                          selectedJourneyIndex === index
                            ? "border-orange-500 bg-orange-50 dark:bg-orange-950/50"
                            : "border-stone-200 bg-white/50 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-900"
                        }`}
                      >
                        <span className="block text-[10px] font-semibold">方案 {index + 1} · {Math.round(candidate.similarity)}%</span>
                        <span className="mt-0.5 block max-w-32 truncate text-[9px] text-stone-400">
                          {formatTime(candidate.departure)} · {journeyLineSummary(candidate)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-3 grid grid-cols-3 divide-x divide-stone-200 rounded-xl bg-stone-100 px-1 py-2 text-center dark:divide-stone-700 dark:bg-stone-800">
                  <div>
                    <div className="text-xs font-semibold">{liveJourney.durationMinutes} 分钟</div>
                    <div className="mt-0.5 text-[9px] text-stone-400">总耗时</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold">{liveJourney.transfers} 次</div>
                    <div className="mt-0.5 text-[9px] text-stone-400">换乘</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold">{Math.round(liveJourney.coverage * 100)}%</div>
                    <div className="mt-0.5 text-[9px] text-stone-400">轨迹覆盖</div>
                  </div>
                </div>

                {liveJourney.viaStopName && (
                  <p className="mt-2 rounded-lg bg-sky-50 px-2.5 py-1.5 text-[10px] leading-4 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
                    为贴合手绘弯折，候选经过 {liveJourney.viaStopName}。
                  </p>
                )}

                {liveJourney.checkpointCount > 0 && (
                  <p className="mt-2 rounded-lg bg-sky-50 px-2.5 py-1.5 text-[10px] leading-4 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
                    长轨迹已按 {liveJourney.checkpointCount} 个有序检查点逐段验证，后一段只会在前一段到达后出发。
                  </p>
                )}

                <ol className="mt-4 space-y-1">
                  {liveJourney.legs.map((leg) => (
                    <li key={leg.id}>
                      <button
                        type="button"
                        onMouseEnter={() => setHovered(leg.id)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(leg.id)}
                        onBlur={() => setHovered(null)}
                        className={`flex w-full items-start gap-3 rounded-xl p-2 text-left transition ${
                          hovered === leg.id
                            ? "bg-stone-100 dark:bg-stone-800"
                            : "hover:bg-stone-50 dark:hover:bg-stone-900"
                        }`}
                      >
                        <span
                          className="inline-flex h-8 min-w-10 items-center justify-center rounded-lg px-1.5 text-[11px] font-extrabold shadow-sm"
                          style={{ backgroundColor: leg.color, color: leg.textColor }}
                        >
                          {leg.walking ? "步行" : leg.lineRef}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold">
                              {formatTime(leg.departure)} → {formatTime(leg.arrival)}
                            </span>
                            {typeof leg.delayMinutes === "number" && leg.delayMinutes !== 0 && (
                              <span className={`text-[9px] font-semibold ${leg.delayMinutes > 0 ? "text-red-600" : "text-emerald-600"}`}>
                                {leg.delayMinutes > 0 ? `晚 ${leg.delayMinutes}` : `早 ${Math.abs(leg.delayMinutes)}`} 分
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-[11px] text-stone-500">
                            {leg.originName} → {leg.destinationName}
                          </span>
                          {!leg.walking && leg.direction && (
                            <span className="mt-0.5 block truncate text-[10px] text-stone-400">
                              方向：{leg.direction}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            ) : !journey ? (
              <div>
                <h2 className="text-sm font-semibold">
                  {journeyNotice ? "没有可信的真实可乘方案" : "暂未识别到连续的公共交通路段"}
                </h2>
                <p className="mt-2 text-xs leading-5 text-stone-500">
                  {journeyNotice
                    ? "系统已停止展示低相似度路线，避免把只连接起终点的无关行程误认为你的历史路径。"
                    : "轨迹可能太短、离线路较远，或当前交通方式已被关闭。请画得更长一些，或者重新打开筛选项。"}
                </p>
                {journeyNotice && (
                  <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-2 text-[10px] leading-4 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300">
                    {journeyNotice}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[10px] font-bold tracking-[0.14em] text-amber-700 uppercase dark:text-amber-400">离线估算</p>
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">未验证时刻表</span>
                    </div>
                    <h2 className="mt-1 text-base font-semibold">
                      {journey.segments.length === 1
                        ? `${journey.segments[0].line.ref} 直达`
                        : `${journey.segments.length} 段 · ${journey.segments.length - 1} 次可能换乘`}
                    </h2>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-orange-600">
                      {Math.round(journey.confidence * 100)}%
                    </div>
                    <div className="text-[10px] text-stone-400">
                      {confidenceLabel(journey.confidence)}置信度
                    </div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl bg-stone-100 px-3 py-2 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                  约 {journey.totalLengthKm.toFixed(1)} km · 已解释 {Math.round(journey.coverage * 100)}% 的手绘轨迹
                </div>

                {journeyNotice && (
                  <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                    {journeyNotice}
                  </p>
                )}

                <ol className="mt-4 space-y-0">
                  {journey.segments.map((segment, index) => (
                    <li key={`${segment.line.id}-${index}`}>
                      {index > 0 && (
                        <div className="ml-[17px] border-l border-dashed border-stone-300 py-2 pl-5 text-[10px] text-stone-400 dark:border-stone-700">
                          在 {segment.boardStop?.name ?? "轨迹交汇处"} 附近换乘
                        </div>
                      )}
                      <button
                        type="button"
                        onMouseEnter={() => setHovered(segment.line.id)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(segment.line.id)}
                        onBlur={() => setHovered(null)}
                        className={`flex w-full items-start gap-3 rounded-xl p-2 text-left transition ${
                          hovered === segment.line.id
                            ? "bg-stone-100 dark:bg-stone-800"
                            : "hover:bg-stone-50 dark:hover:bg-stone-900"
                        }`}
                      >
                        <span
                          className="inline-flex h-8 min-w-9 items-center justify-center rounded-lg px-1.5 text-xs font-extrabold shadow-sm"
                          style={{ backgroundColor: segment.line.color, color: segment.line.textColor }}
                        >
                          {segment.line.ref}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold">{modeLabel(segment.line.mode)}</span>
                            <span className="text-[10px] text-stone-400">
                              约 {segment.matchedLengthKm.toFixed(1)} km
                            </span>
                          </span>
                          <span className="mt-1 block truncate text-[11px] text-stone-500">
                            {segment.boardStop?.name ?? "轨迹起点"} → {segment.alightStop?.name ?? "轨迹终点"}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>

                {journey.alternatives.length > 0 && (
                  <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-800">
                    <h3 className="text-[11px] font-semibold text-stone-500">同一路廊的其他候选</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {journey.alternatives.map((alternative) => (
                        <span
                          key={alternative.line.id}
                          className="rounded-full border border-stone-200 px-2 py-1 text-[10px] font-semibold dark:border-stone-700"
                        >
                          {alternative.line.ref} · {Math.round(alternative.coverage * 100)}%
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <p className="mt-4 border-t border-stone-200 pt-3 text-[10px] leading-4 text-stone-400 dark:border-stone-800">
              {liveJourney
                ? "结果来自 VBB 时刻表中的真实可乘方案，再按手绘轨迹排序；它仍不能证明你实际乘坐了该班次。数据："
                : journey
                  ? "离线结果仅依据轨迹与线路空间接近度估算，未验证班次、方向和换乘是否可行。数据："
                  : "低匹配结果不会展示。线路与站点参考数据："}
              {network ? (
                <a
                  href={liveJourney ? "https://v6.vbb.transport.rest/" : network.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-stone-300 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-200"
                >
                  {liveJourney ? "VBB transport.rest" : `VBB GTFS（${network.license}）`}
                </a>
              ) : (
                "VBB GTFS"
              )}
              。
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
