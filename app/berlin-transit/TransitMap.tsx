"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CircleMarker as LCircleMarker,
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

const BERLIN_CENTER: [number, number] = [52.52, 13.405];
const DRAW_COLOR = "#F05A28";
const MODE_ORDER: TransitMode[] = [
  "subway",
  "light_rail",
  "tram",
  "bus",
  "rail",
  "ferry",
];

type ModeFilter = Record<TransitMode, boolean>;

const INITIAL_MODES: ModeFilter = {
  subway: true,
  light_rail: true,
  tram: true,
  bus: true,
  rail: true,
  ferry: true,
};

function confidenceLabel(confidence: number) {
  if (confidence >= 0.78) return "较高";
  if (confidence >= 0.55) return "中等";
  return "较低";
}

export default function TransitMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const drawingRef = useRef(false);
  const pointerDownRef = useRef(false);
  const keyboardDrawingRef = useRef(false);
  const keyboardMarkerRef = useRef<LCircleMarker | null>(null);
  const pointsRef = useRef<LL[]>([]);
  const previewRef = useRef<LPolyline | null>(null);
  const drawnLayerRef = useRef<LPolyline | null>(null);
  const resultsGroupRef = useRef<LLayerGroup | null>(null);
  const resultLayersRef = useRef<Map<string, LPolyline[]>>(new Map());
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const commitPathRef = useRef<(path: LL[]) => void>(() => {});

  const [network, setNetwork] = useState<TransitNetwork | null>(null);
  const [ready, setReady] = useState(false);
  const [drawing, setDrawing] = useState(true);
  const [drawnPath, setDrawnPath] = useState<LL[] | null>(null);
  const [journey, setJourney] = useState<JourneyMatch | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [modes, setModes] = useState<ModeFilter>(INITIAL_MODES);
  const [error, setError] = useState<string | null>(null);

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

        resultsGroupRef.current = L.layerGroup().addTo(map);
        const element = containerRef.current;
        const toLatLng = (event: PointerEvent): LL => {
          const rect = element.getBoundingClientRect();
          const point = map.containerPointToLatLng([
            event.clientX - rect.left,
            event.clientY - rect.top,
          ]);
          return [point.lat, point.lng];
        };

        const onPointerDown = (event: PointerEvent) => {
          if (!drawingRef.current || event.button !== 0) return;
          if ((event.target as HTMLElement)?.closest(".leaflet-control")) return;
          event.preventDefault();
          keyboardDrawingRef.current = false;
          keyboardMarkerRef.current?.remove();
          keyboardMarkerRef.current = null;
          pointerDownRef.current = true;
          try {
            element.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture may already belong to the map.
          }
          pointsRef.current = [toLatLng(event)];
          previewRef.current?.remove();
          previewRef.current = L.polyline(pointsRef.current, {
            color: DRAW_COLOR,
            weight: 5,
            opacity: 0.9,
            dashArray: "8 7",
          }).addTo(map);
        };

        const onPointerMove = (event: PointerEvent) => {
          if (!pointerDownRef.current) return;
          pointsRef.current.push(toLatLng(event));
          previewRef.current?.setLatLngs(pointsRef.current);
        };

        const onPointerUp = (event: PointerEvent) => {
          if (!pointerDownRef.current) return;
          pointerDownRef.current = false;
          try {
            element.releasePointerCapture(event.pointerId);
          } catch {
            // The browser may release capture before pointercancel.
          }
          const path = pointsRef.current.slice();
          previewRef.current?.remove();
          previewRef.current = null;
          if (path.length >= 2) commitPathRef.current(path);
        };

        const onKeyDown = (event: KeyboardEvent) => {
          if (!drawingRef.current) return;
          const arrows: Record<string, [number, number]> = {
            ArrowUp: [0, -28],
            ArrowDown: [0, 28],
            ArrowLeft: [-28, 0],
            ArrowRight: [28, 0],
          };

          if (event.code === "Space") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!keyboardDrawingRef.current) {
              const center = map.getCenter();
              const start: LL = [center.lat, center.lng];
              keyboardDrawingRef.current = true;
              pointsRef.current = [start];
              previewRef.current?.remove();
              previewRef.current = L.polyline(pointsRef.current, {
                color: DRAW_COLOR,
                weight: 5,
                opacity: 0.9,
                dashArray: "8 7",
              }).addTo(map);
              keyboardMarkerRef.current?.remove();
              keyboardMarkerRef.current = L.circleMarker(start, {
                radius: 6,
                color: "#FFFFFF",
                weight: 2,
                fillColor: DRAW_COLOR,
                fillOpacity: 1,
              }).addTo(map);
            } else {
              keyboardDrawingRef.current = false;
              const path = pointsRef.current.slice();
              previewRef.current?.remove();
              previewRef.current = null;
              keyboardMarkerRef.current?.remove();
              keyboardMarkerRef.current = null;
              if (path.length >= 2) commitPathRef.current(path);
            }
            return;
          }

          if (event.key === "Escape" && keyboardDrawingRef.current) {
            event.preventDefault();
            event.stopImmediatePropagation();
            keyboardDrawingRef.current = false;
            previewRef.current?.remove();
            previewRef.current = null;
            keyboardMarkerRef.current?.remove();
            keyboardMarkerRef.current = null;
            return;
          }

          const delta = arrows[event.key];
          if (!delta || !keyboardDrawingRef.current) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const current = pointsRef.current[pointsRef.current.length - 1];
          const screenPoint = map.latLngToContainerPoint(current);
          const next = map.containerPointToLatLng([screenPoint.x + delta[0], screenPoint.y + delta[1]]);
          const point: LL = [next.lat, next.lng];
          pointsRef.current.push(point);
          previewRef.current?.setLatLngs(pointsRef.current);
          keyboardMarkerRef.current?.setLatLng(point);
        };

        element.addEventListener("pointerdown", onPointerDown);
        element.addEventListener("pointermove", onPointerMove);
        element.addEventListener("pointerup", onPointerUp);
        element.addEventListener("pointercancel", onPointerUp);
        element.addEventListener("keydown", onKeyDown, true);
        cleanupInput = () => {
          element.removeEventListener("pointerdown", onPointerDown);
          element.removeEventListener("pointermove", onPointerMove);
          element.removeEventListener("pointerup", onPointerUp);
          element.removeEventListener("pointercancel", onPointerUp);
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
      keyboardDrawingRef.current = false;
      keyboardMarkerRef.current?.remove();
      keyboardMarkerRef.current = null;
      previewRef.current?.remove();
      previewRef.current = null;
      map.dragging.enable();
      map.doubleClickZoom.enable();
      map.boxZoom.enable();
      element.style.cursor = "grab";
      element.style.touchAction = "";
    }
  }, [drawing, ready]);

  const commitPath = useCallback((path: LL[]) => {
    setDrawnPath(path);
    setJourney(null);
  }, []);

  useEffect(() => {
    commitPathRef.current = commitPath;
  }, [commitPath]);

  // This effect also fixes the loading race: an existing drawing is evaluated
  // as soon as the network arrives, and again whenever filters change.
  useEffect(() => {
    if (!drawnPath || !network) return;
    let frame = 0;
    const timeout = window.setTimeout(() => {
      setAnalyzing(true);
      frame = window.requestAnimationFrame(() => {
        const enabledLines = network.lines.filter((line) => modes[line.mode]);
        setJourney(inferJourney(drawnPath, enabledLines));
        setAnalyzing(false);
      });
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
    };
  }, [drawnPath, modes, network]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    drawnLayerRef.current?.remove();
    drawnLayerRef.current = drawnPath
      ? L.polyline(drawnPath, {
          color: DRAW_COLOR,
          weight: 5,
          opacity: 0.9,
          dashArray: "8 7",
          interactive: false,
        }).addTo(map)
      : null;
  }, [drawnPath]);

  useEffect(() => {
    const L = LRef.current;
    const group = resultsGroupRef.current;
    if (!L || !group) return;
    group.clearLayers();
    resultLayersRef.current.clear();
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
  }, [journey]);

  useEffect(() => {
    resultLayersRef.current.forEach((layers, lineId) => {
      const active = lineId === hovered;
      layers.forEach((layer) => {
        layer.setStyle({ weight: active ? 9 : 6, opacity: active ? 1 : 0.96 });
        if (active) layer.bringToFront();
      });
    });
  }, [hovered]);

  const clearAll = useCallback(() => {
    setDrawnPath(null);
    setJourney(null);
    setAnalyzing(false);
    setHovered(null);
    drawnLayerRef.current?.remove();
    drawnLayerRef.current = null;
    resultsGroupRef.current?.clearLayers();
    resultLayersRef.current.clear();
  }, []);

  const toggleMode = (mode: TransitMode) => {
    setModes((current) => ({ ...current, [mode]: !current[mode] }));
  };

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-stone-200 font-sans text-stone-950 dark:bg-stone-900 dark:text-stone-50">
      <div
        ref={containerRef}
        className="absolute inset-0 z-0"
        role="application"
        tabIndex={0}
        aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape"
        aria-label="柏林交互地图。可按住并拖动来画轨迹；也可先平移到起点，再按空格开始、用方向键画线、再次按空格完成。"
      />

      <section className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex justify-center p-3 sm:justify-start sm:p-5">
        <div className="pointer-events-auto w-full max-w-[420px] rounded-[22px] border border-white/70 bg-white/92 p-4 shadow-[0_18px_55px_rgba(28,25,23,0.18)] backdrop-blur-xl dark:border-white/10 dark:bg-stone-950/90 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold tracking-[0.16em] text-orange-600 uppercase">
                Berlin Trace
              </p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight">从手绘轨迹推测乘车路线</h1>
            </div>
            <span className="mt-0.5 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              仅限柏林
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-stone-600 dark:text-stone-400">
            沿着你走过的路径画一笔。系统会按顺序推测线路、上下车站和可能的换乘。
          </p>
          <p className="mt-1 text-[10px] leading-4 text-stone-400">
            键盘：平移至起点后，空格开始，方向键画线，再按空格完成。
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
              绘制路线
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

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-200 pt-3 dark:border-stone-800">
            <p className="min-w-0 truncate text-[10px] text-stone-500" aria-live="polite">
              {error
                ? error
                : network
                  ? `${network.lines.length} 条线路 · VBB ${network.sourceUpdatedAt}`
                  : "正在加载 VBB 交通网络…"}
            </p>
            <button
              type="button"
              onClick={clearAll}
              disabled={!drawnPath}
              className="shrink-0 text-[11px] font-semibold text-orange-600 transition hover:text-orange-700 disabled:cursor-not-allowed disabled:text-stone-300 dark:disabled:text-stone-700"
            >
              清除轨迹
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
                正在组合可能的乘车路段…
              </div>
            ) : !journey ? (
              <div>
                <h2 className="text-sm font-semibold">暂未识别到连续的公共交通路段</h2>
                <p className="mt-2 text-xs leading-5 text-stone-500">
                  轨迹可能太短、离线路较远，或当前交通方式已被关闭。请画得更长一些，或者重新打开筛选项。
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-bold tracking-[0.14em] text-stone-400 uppercase">推测行程</p>
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
              结果仅依据轨迹与线路的空间接近度推测，不能证明实际乘坐。线路与站点数据：
              {network ? (
                <a
                  href={network.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-stone-300 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-200"
                >
                  VBB GTFS（{network.license}）
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
