"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LayerGroup as LLayerGroup,
  Map as LMap,
  Polyline as LPolyline,
} from "leaflet";
import "leaflet/dist/leaflet.css";
import { polylineLength, type LL } from "./geo";
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
  options: {
    color: string;
    selected?: boolean;
    number?: number;
    bend?: boolean;
    ambient?: boolean;
    muted?: boolean;
  }
) {
  const classes = [
    "map-nail",
    options.selected ? "map-nail--selected" : "",
    options.bend ? "map-nail--bend" : "",
    options.ambient ? "map-nail--ambient" : "",
    options.muted ? "map-nail--muted" : "",
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

function visibleJourneyLegs(journey: LiveJourneyCandidate) {
  return journey.legs.filter((leg) => {
    if (!leg.walking) return true;
    const duration = Date.parse(leg.arrival) - Date.parse(leg.departure);
    return !(
      Number.isFinite(duration) &&
      duration <= 0 &&
      (leg.originName === leg.destinationName || polylineLength(leg.polyline) < 50)
    );
  });
}

function legDurationLabel(departure: string, arrival: string) {
  const duration = Date.parse(arrival) - Date.parse(departure);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const minutes = Math.max(1, Math.round(duration / 60_000));
  return `${minutes} 分钟`;
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
  const [controlsOpen, setControlsOpen] = useState(true);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(true);
  const [renderedAttractionCount, setRenderedAttractionCount] = useState(0);
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
  const displayedLiveLegs = liveJourney ? visibleJourneyLegs(liveJourney) : [];

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
          zoomControl: false,
          maxBounds: L.latLngBounds([52.28, 12.98], [52.72, 13.86]),
          maxBoundsViscosity: 0.7,
          minZoom: 10,
        });
        mapRef.current = map;
        L.control.zoom({ position: "bottomleft" }).addTo(map);

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
    setResultsOpen(true);
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
    const showingResult = Boolean(liveJourney || journey);
    threadLinesRef.current.forEach((line, index) => {
      const focusedStyles = [
        { weight: 5, opacity: 0.12 },
        { weight: 3, opacity: 0.45 },
        { weight: 1, opacity: 0.32 },
      ];
      const defaultStyles = [
        { weight: 7, opacity: 0.28 },
        { weight: 4, opacity: 0.98 },
        { weight: 1, opacity: 0.9 },
      ];
      line.setStyle((showingResult ? focusedStyles : defaultStyles)[index]);
    });
    if (liveJourney) {
      const legs = visibleJourneyLegs(liveJourney);
      legs.forEach((leg, index) => {
        if (leg.polyline.length < 2) return;
        const layers = resultLayersRef.current.get(leg.id) ?? [];
        if (!leg.walking) {
          L.polyline(leg.polyline, {
            color: "#FFFFFF",
            weight: 11,
            opacity: 0.86,
            interactive: false,
          }).addTo(group);
        }
        const layer = L.polyline(leg.polyline, {
          color: leg.color,
          weight: leg.walking ? 3 : 7,
          opacity: leg.walking ? 0.54 : 1,
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
        if (index === 0 || (!leg.walking && legs[index - 1])) {
          L.circleMarker(start, {
            radius: index === 0 ? 6 : 5,
            color: "#FFFFFF",
            weight: 2,
            fillColor: leg.color,
            fillOpacity: 1,
            interactive: false,
          }).addTo(group);
        }
        if (index === legs.length - 1) {
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
    let frame = 0;
    const renderPins = () => {
      group.clearLayers();
      if (!showAttractions || !attractions) {
        setRenderedAttractionCount(0);
        return;
      }

      const zoom = map.getZoom();
      const focusScale = drawnPath && resultsOpen ? 1.65 : 1;
      const gridSize =
        (zoom <= 10 ? 76 : zoom === 11 ? 62 : zoom === 12 ? 50 : zoom === 13 ? 38 : zoom === 14 ? 28 : 18) *
        focusScale;
      const bounds = map.getBounds().pad(0.08);
      const occupied = new Set<string>();
      const candidates = attractions
        .filter(
          (attraction) =>
            categoryFilter[attraction.category] && bounds.contains(attraction.point)
        )
        .sort(
          (first, second) =>
            ATTRACTION_CATEGORIES.indexOf(first.category) -
            ATTRACTION_CATEGORIES.indexOf(second.category)
        );
      let rendered = 0;

      for (const attraction of candidates) {
        const projected = map.latLngToContainerPoint(attraction.point);
        const gridKey = `${Math.floor(projected.x / gridSize)}:${Math.floor(projected.y / gridSize)}`;
        if (zoom < 16 && occupied.has(gridKey)) continue;
        occupied.add(gridKey);
        const meta = CATEGORY_META[attraction.category];
        const marker = L.marker(attraction.point, {
          icon: nailIcon(L, {
            color: meta.color,
            ambient: true,
            muted: Boolean(drawnPath && resultsOpen),
          }),
          keyboard: true,
          riseOnHover: true,
          title: attraction.name,
        })
          .addTo(group)
          .bindTooltip(
            `${meta.emoji} ${attraction.name} · ${drawing ? "加入线迹" : "查看详情"}`,
            { direction: "top", offset: [0, -24] }
          );
        const url = attractionWikiUrl(attraction);
        const popupHtml =
          `<div style="min-width:164px;line-height:1.5">` +
          `<div style="font-weight:700">${meta.emoji} ${escapeHtml(attraction.name)}</div>` +
          (attraction.nameEn
            ? `<div style="color:#78716c;font-size:11px">${escapeHtml(attraction.nameEn)}</div>`
            : "") +
          `<div style="color:${meta.color};font-size:11px;margin-top:3px">${meta.label}</div>` +
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
          L.popup({ offset: [0, -24] })
            .setLatLng(attraction.point)
            .setContent(popupHtml)
            .openOn(map);
        });
        rendered += 1;
      }
      setRenderedAttractionCount(rendered);
    };

    const scheduleRender = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(renderPins);
    };
    scheduleRender();
    map.on("moveend zoomend", scheduleRender);
    return () => {
      window.cancelAnimationFrame(frame);
      map.off("moveend zoomend", scheduleRender);
    };
  }, [addAttractionPin, attractions, showAttractions, categoryFilter, drawing, drawnPath, ready, resultsOpen]);

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

  const availableAttractions =
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

      <section className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex justify-center p-3 sm:justify-start sm:p-4 lg:p-5">
        <div
          className={`pointer-events-auto w-full overflow-hidden rounded-[26px] border border-white/75 bg-white/88 shadow-[0_24px_70px_rgba(38,30,23,0.16)] backdrop-blur-2xl transition-[max-width] duration-300 dark:border-white/10 dark:bg-stone-950/88 ${
            controlsOpen ? "max-w-[390px]" : "max-w-[248px]"
          }`}
        >
          <header className="flex items-center gap-3 px-4 py-3.5">
            <span className="brand-mark" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] font-black tracking-[0.2em] text-orange-600 uppercase">
                Berlin Trace
              </p>
              <p className="truncate text-[11px] font-semibold text-stone-500 dark:text-stone-400">
                图钉线迹规划器
              </p>
            </div>
            <span
              className={`h-2 w-2 rounded-full ${network ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" : "animate-pulse bg-amber-400"}`}
              title={network ? "VBB 网络已连接" : "正在连接 VBB 网络"}
            />
            <button
              type="button"
              onClick={() => setControlsOpen((value) => !value)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-sm font-semibold text-stone-500 transition hover:bg-stone-200 hover:text-stone-900 dark:bg-stone-800 dark:text-stone-400 dark:hover:text-white"
              aria-expanded={controlsOpen}
              aria-label={controlsOpen ? "收起控制台" : "展开控制台"}
            >
              {controlsOpen ? "−" : "+"}
            </button>
          </header>

          {controlsOpen && (
            <div className="max-h-[calc(100dvh-96px)] overflow-y-auto border-t border-stone-200/70 px-4 pb-4 dark:border-stone-800">
              <div className="pt-4">
                <div className="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.08em] text-stone-400 uppercase">
                  <span className={routePins.length ? "text-orange-600" : "text-stone-700 dark:text-stone-200"}>01 落钉</span>
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" />
                  <span className={routePins.length >= 2 ? "text-orange-600" : ""}>02 拉线</span>
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" />
                  <span className={drawnPath ? "text-emerald-600" : ""}>03 匹配</span>
                </div>
                <h1 className="mt-3 text-xl font-semibold tracking-[-0.025em] text-stone-950 dark:text-white">
                  {drawnPath ? "路线已经固定" : routePins.length ? "继续选择下一站" : "从一个地点开始"}
                </h1>
                <p className="mt-1.5 text-[11px] leading-[1.65] text-stone-500 dark:text-stone-400">
                  {drawnPath
                    ? "匹配结果已生成。你仍可继续落钉延长路线。"
                    : routePins.length
                      ? "点景点继续串联；点地图空白处添加可拖动拐点。"
                      : "选择地图上的景点钉，丝线会自动跟随到下一处。"}
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 rounded-[14px] bg-stone-100/90 p-1 dark:bg-stone-800" aria-label="地图操作模式">
                <button
                  type="button"
                  aria-pressed={drawing}
                  onClick={() => setDrawing(true)}
                  className={`rounded-[10px] px-3 py-2 text-[11px] font-bold transition ${
                    drawing
                      ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white"
                      : "text-stone-500 hover:text-stone-800 dark:text-stone-400"
                  }`}
                >
                  ◎ 穿线
                </button>
                <button
                  type="button"
                  aria-pressed={!drawing}
                  onClick={() => setDrawing(false)}
                  className={`rounded-[10px] px-3 py-2 text-[11px] font-bold transition ${
                    !drawing
                      ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white"
                      : "text-stone-500 hover:text-stone-800 dark:text-stone-400"
                  }`}
                >
                  ✥ 浏览
                </button>
              </div>

              <div className={`mt-3 rounded-[18px] border p-3.5 transition ${
                routePins.length
                  ? "border-orange-200 bg-[linear-gradient(145deg,rgba(255,247,237,.96),rgba(255,255,255,.9))] dark:border-orange-900/80 dark:bg-orange-950/30"
                  : "border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-900/50"
              }`}>
                <div className="flex items-center gap-3">
                  <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black ${
                    routePins.length ? "bg-orange-600 text-white shadow-[0_7px_18px_rgba(234,88,12,.28)]" : "bg-stone-100 text-stone-400 dark:bg-stone-800"
                  }`}>
                    {routePins.length || "+"}
                  </span>
                  <div className="min-w-0 flex-1" aria-live="polite">
                    <p className="text-[11px] font-bold text-stone-800 dark:text-stone-100">
                      {drawnPath ? "线迹已固定" : routePins.length ? `${routePins.length} 个节点正在串联` : "等待第一个落点"}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-stone-400">
                      {routePins.length ? routePins[routePins.length - 1].label : "点击任意景点或地图空白处"}
                    </p>
                  </div>
                </div>

                {routePins.length > 0 && (
                  <div className="mt-3 flex items-center overflow-hidden rounded-xl bg-white/80 px-2.5 py-2 dark:bg-stone-900/70" aria-label="线迹节点概览">
                    {routePins.slice(-6).map((pin, index, visible) => (
                      <div key={pin.id} className="flex min-w-0 flex-1 items-center last:flex-none">
                        <span
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[8px] font-black text-white ring-2 ring-white dark:ring-stone-900"
                          style={{ backgroundColor: pin.color ?? DRAW_COLOR }}
                          title={pin.label}
                        >
                          {routePins.length - visible.length + index + 1}
                        </span>
                        {index < visible.length - 1 && <span className="h-0.5 min-w-2 flex-1 bg-orange-300 dark:bg-orange-800" />}
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-3 grid grid-cols-[auto_auto_1fr] gap-2">
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={routePins.length === 0}
                    className="rounded-xl px-3 py-2 text-[10px] font-semibold text-stone-400 transition hover:bg-white hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-stone-900"
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    onClick={undoPin}
                    disabled={routePins.length === 0}
                    className="rounded-xl border border-stone-200 bg-white/80 px-3 py-2 text-[10px] font-semibold text-stone-600 transition hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-35 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
                  >
                    ↶ 撤回
                  </button>
                  <button
                    type="button"
                    onClick={finishThread}
                    disabled={routePins.length < 2}
                    className="rounded-xl bg-stone-950 px-3 py-2 text-[10px] font-bold text-white shadow-sm transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-stone-300 dark:bg-white dark:text-stone-950 dark:hover:bg-orange-500 dark:disabled:bg-stone-800 dark:disabled:text-stone-600"
                  >
                    {drawnPath ? "重新匹配 →" : "完成并匹配 →"}
                  </button>
                </div>

                {routePins.length > 0 && (
                  <details className="mt-2 border-t border-stone-200/80 pt-2 dark:border-stone-800">
                    <summary className="cursor-pointer text-[10px] font-semibold text-stone-500 outline-none hover:text-stone-900 dark:hover:text-white">
                      查看 {routePins.length} 个坐标记录
                    </summary>
                    <ol className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1">
                      {routePins.map((pin, index) => (
                        <li key={pin.id} className="grid grid-cols-[20px_1fr_auto] items-center gap-2 rounded-lg bg-white/80 px-2 py-1.5 text-[10px] dark:bg-stone-900/70">
                          <span className="font-black text-orange-600">{String(index + 1).padStart(2, "0")}</span>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-stone-700 dark:text-stone-200">{pin.label}</span>
                            <span className="block font-mono text-[8px] text-stone-400">{pin.point[0].toFixed(5)}, {pin.point[1].toFixed(5)}</span>
                          </span>
                          <button type="button" onClick={() => removePin(pin.id)} className="rounded-full px-1.5 py-1 text-stone-400 hover:bg-stone-100 hover:text-red-600 dark:hover:bg-stone-800" aria-label={`删除节点 ${index + 1}：${pin.label}`}>×</button>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>

              <button
                type="button"
                onClick={() => setPreferencesOpen((value) => !value)}
                className="mt-3 flex w-full items-center justify-between rounded-[14px] border border-stone-200 bg-white/60 px-3.5 py-3 text-left transition hover:border-stone-300 hover:bg-white dark:border-stone-800 dark:bg-stone-900/40 dark:hover:bg-stone-900"
                aria-expanded={preferencesOpen}
              >
                <span>
                  <span className="block text-[11px] font-bold text-stone-800 dark:text-stone-100">路线偏好</span>
                  <span className="mt-0.5 block text-[9px] text-stone-400">时间、交通方式与景点图层</span>
                </span>
                <span className={`text-sm text-stone-400 transition-transform ${preferencesOpen ? "rotate-180" : ""}`}>⌄</span>
              </button>

              {preferencesOpen && (
                <div className="mt-2 space-y-4 rounded-[16px] border border-stone-200/80 bg-white/65 p-3.5 dark:border-stone-800 dark:bg-stone-900/50">
                  <label className="block">
                    <span className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-stone-500">
                      <span>出发时间</span>
                      <span className="font-normal text-stone-400">柏林当地时间</span>
                    </span>
                    <input type="datetime-local" value={departure} onChange={(event) => setDeparture(event.target.value)} className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] text-stone-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100" aria-label="历史行程的出发日期与时间" />
                  </label>

                  <div>
                    <p className="mb-2 text-[9px] font-bold text-stone-500">交通方式</p>
                    <div className="flex flex-wrap gap-1.5" aria-label="交通方式筛选">
                      {MODE_ORDER.map((mode) => (
                        <button key={mode} type="button" aria-pressed={modes[mode]} onClick={() => toggleMode(mode)} className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition ${modes[mode] ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950" : "border-stone-200 text-stone-400 hover:border-stone-400 dark:border-stone-700"}`}>{modeLabel(mode)}</button>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-stone-200 pt-3 dark:border-stone-800">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-stone-500">景点钉 · 当前显示 {renderedAttractionCount}/{availableAttractions}</span>
                      <button type="button" role="switch" aria-checked={showAttractions} onClick={() => setShowAttractions((value) => !value)} className={`relative h-5 w-9 rounded-full transition ${showAttractions ? "bg-orange-500" : "bg-stone-300 dark:bg-stone-700"}`}>
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${showAttractions ? "translate-x-4" : "translate-x-0.5"}`} />
                        <span className="sr-only">{showAttractions ? "隐藏景点" : "显示景点"}</span>
                      </button>
                    </div>
                    {showAttractions && (
                      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="景点分类筛选">
                        {ATTRACTION_CATEGORIES.map((category) => {
                          const meta = CATEGORY_META[category];
                          const on = categoryFilter[category];
                          return (
                            <button key={category} type="button" aria-pressed={on} onClick={() => toggleCategory(category)} className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-medium transition ${on ? "border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100" : "border-transparent bg-stone-100 text-stone-400 dark:bg-stone-800/60"}`}>
                              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: on ? meta.color : "transparent", boxShadow: on ? undefined : `inset 0 0 0 1px ${meta.color}` }} />
                              {meta.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-center justify-between px-1 text-[9px] text-stone-400" aria-live="polite">
                <span>{error ? "地图数据连接失败" : network ? `${network.lines.length} 条 VBB 线路已就绪` : "正在连接 VBB 网络…"}</span>
                <span>自动保存</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {drawnPath && !resultsOpen && (
        <button
          type="button"
          onClick={() => setResultsOpen(true)}
          className="absolute right-3 bottom-4 z-[1000] inline-flex items-center gap-2 rounded-full border border-white/80 bg-stone-950 px-4 py-2.5 text-[11px] font-bold text-white shadow-[0_14px_35px_rgba(28,25,23,.28)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-orange-600 sm:right-5 sm:bottom-auto sm:top-5"
        >
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          查看行程
          {(liveJourney || journey) && (
            <span className="text-orange-300">
              {liveJourney ? Math.round(liveJourney.similarity) : Math.round((journey?.confidence ?? 0) * 100)}%
            </span>
          )}
        </button>
      )}

      {drawnPath && resultsOpen && (
        <section
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex justify-center p-3 lg:inset-y-4 lg:right-4 lg:left-auto lg:w-[440px] lg:p-0"
          aria-live="polite"
          aria-busy={analyzing}
        >
          <div className="pointer-events-auto flex max-h-[68dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[26px] border border-white/75 bg-white/94 shadow-[0_24px_70px_rgba(28,25,23,0.22)] backdrop-blur-2xl dark:border-white/10 dark:bg-stone-950/94 sm:rounded-[26px] lg:h-full lg:max-h-none">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-stone-300 sm:hidden dark:bg-stone-700" />
            <header className="flex shrink-0 items-center justify-between border-b border-stone-200/80 px-4 py-3.5 dark:border-stone-800">
              <div>
                <p className="text-[9px] font-black tracking-[0.18em] text-emerald-600 uppercase">Journey Match</p>
                <p className="mt-0.5 text-[11px] font-semibold text-stone-500 dark:text-stone-400">VBB 行程建议</p>
              </div>
              <button
                type="button"
                onClick={() => setResultsOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-sm text-stone-500 transition hover:bg-stone-200 hover:text-stone-950 dark:bg-stone-800 dark:text-stone-400 dark:hover:text-white"
                aria-label="收起行程结果"
              >
                ×
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {analyzing ? (
              <div className="py-3">
                <div className="flex items-center gap-3 text-sm font-semibold text-stone-700 dark:text-stone-200">
                  <span className="relative h-3 w-3 rounded-full bg-orange-500 after:absolute after:inset-[-5px] after:animate-ping after:rounded-full after:bg-orange-400/30" />
                  正在生成行程建议
                </div>
                <p className="mt-2 pl-6 text-[11px] leading-5 text-stone-400">比对 VBB 时刻表、路线方向和你的线迹拐点…</p>
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

                <div className="mt-4 grid grid-cols-3 divide-x divide-stone-200 rounded-2xl border border-stone-200/70 bg-stone-50 px-1 py-3 text-center dark:divide-stone-700 dark:border-stone-800 dark:bg-stone-900">
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
                    已按 {liveJourney.checkpointCount} 个路径节点分段核验，并保持行程时间顺序。
                  </p>
                )}

                <div className="mt-5 flex items-center justify-between">
                  <h3 className="text-[11px] font-bold text-stone-800 dark:text-stone-100">行程时间线</h3>
                  <span className="text-[9px] text-stone-400">{displayedLiveLegs.length} 段</span>
                </div>
                <ol className="relative mt-2 space-y-1 before:absolute before:top-4 before:bottom-4 before:left-[19px] before:w-px before:bg-stone-200 dark:before:bg-stone-800">
                  {displayedLiveLegs.map((leg) => (
                    <li key={leg.id} className="relative">
                      <button
                        type="button"
                        onMouseEnter={() => setHovered(leg.id)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(leg.id)}
                        onBlur={() => setHovered(null)}
                        className={`relative flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left transition ${
                          hovered === leg.id
                            ? "bg-stone-100 dark:bg-stone-800"
                            : "hover:bg-stone-50 dark:hover:bg-stone-900"
                        }`}
                      >
                        <span
                          className="relative z-10 inline-flex h-8 min-w-10 items-center justify-center rounded-lg border-2 border-white px-1.5 text-[11px] font-extrabold shadow-sm dark:border-stone-950"
                          style={{ backgroundColor: leg.color, color: leg.textColor }}
                        >
                          {leg.walking ? "步行" : leg.lineRef}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold tabular-nums">
                              {formatTime(leg.departure)} → {formatTime(leg.arrival)}
                            </span>
                            {legDurationLabel(leg.departure, leg.arrival) && (
                              <span className="text-[9px] font-medium text-stone-400">
                                {legDurationLabel(leg.departure, leg.arrival)}
                              </span>
                            )}
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
          </div>
        </section>
      )}
    </main>
  );
}
