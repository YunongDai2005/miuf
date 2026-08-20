"use client";

import { useMemo, useState } from "react";
import { berlinDateKey } from "./time";
import type { LossDateCertainty, LostItem } from "./types";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function monthKey(dateKey: string): string {
  return /^\d{4}-\d{2}/.test(dateKey) ? dateKey.slice(0, 7) : berlinDateKey().slice(0, 7);
}

function moveMonth(value: string, amount: number): string {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1)).toISOString().slice(0, 7);
}

function monthDays(value: string): Array<string | null> {
  const [year, month] = value.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    ...Array<null>(leading).fill(null),
    ...Array.from({ length: count }, (_, index) =>
      `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`
    ),
  ];
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function conciseDate(value: string): string {
  if (!value) return "Select";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

type TimeChoice = "any" | "morning" | "afternoon" | "evening" | "exact";

function selectedTime(item: LostItem): TimeChoice {
  const from = item.timeFrom?.trim();
  const to = item.timeTo?.trim();
  if (!from && !to) return "any";
  if (from === "06:00" && to === "12:00") return "morning";
  if (from === "12:00" && to === "18:00") return "afternoon";
  if (from === "18:00" && to === "23:59") return "evening";
  return "exact";
}

export default function DateWindowPicker({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: LostItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (patch: Partial<LostItem>) => void;
}) {
  const today = berlinDateKey();
  const [mode, setMode] = useState<LossDateCertainty>(
    item.dateCertainty === "range" ? "range" : "exact"
  );
  const [exactDay, setExactDay] = useState(item.lostDate || today);
  const [rangeStart, setRangeStart] = useState(item.travelStartDate || "");
  const [rangeEnd, setRangeEnd] = useState(item.travelEndDate || today);
  const [rangeTarget, setRangeTarget] = useState<"start" | "end">(
    item.travelStartDate ? "end" : "start"
  );
  const [timeChoice, setTimeChoice] = useState<TimeChoice>(selectedTime(item));
  const [exactTime, setExactTime] = useState(item.timeFrom || "12:00");
  const initialCalendarDay =
    mode === "exact" ? exactDay : rangeTarget === "start" ? rangeStart || rangeEnd : rangeEnd;
  const [visibleMonth, setVisibleMonth] = useState(monthKey(initialCalendarDay));
  // Which way the calendar last moved, so the month label and grid slide in
  // from the side the traveller pushed them from.
  const [pageDir, setPageDir] = useState<"next" | "prev">("next");
  const days = useMemo(() => monthDays(visibleMonth), [visibleMonth]);
  const currentMonth = monthKey(today);

  const showMonth = (next: string) => {
    setPageDir(next < visibleMonth ? "prev" : "next");
    setVisibleMonth(next);
  };

  const chooseMode = (next: LossDateCertainty) => {
    setMode(next);
    if (next === "exact") showMonth(monthKey(exactDay));
    else showMonth(monthKey(rangeStart || rangeEnd || today));
  };

  const chooseDay = (day: string) => {
    if (day > today) return;
    if (mode === "exact") {
      setExactDay(day);
      return;
    }
    if (rangeTarget === "start") {
      setRangeStart(day);
      if (!rangeEnd || day > rangeEnd) setRangeEnd(day);
      setRangeTarget("end");
      return;
    }
    if (!rangeStart || day < rangeStart) {
      setRangeStart(day);
      setRangeTarget("end");
      return;
    }
    setRangeEnd(day);
    setRangeTarget("start");
  };

  const confirm = () => {
    if (mode === "range") {
      if (!rangeStart || !rangeEnd) return;
      onConfirm({
        dateCertainty: "range",
        travelStartDate: rangeStart,
        travelEndDate: rangeEnd,
        lostDate: rangeEnd,
        timeFrom: "",
        timeTo: "",
      });
      return;
    }
    const ranges: Record<Exclude<TimeChoice, "exact">, [string, string]> = {
      any: ["", ""],
      morning: ["06:00", "12:00"],
      afternoon: ["12:00", "18:00"],
      evening: ["18:00", "23:59"],
    };
    const [timeFrom, timeTo] =
      timeChoice === "exact" ? [exactTime, exactTime] : ranges[timeChoice];
    onConfirm({
      dateCertainty: "exact",
      lostDate: exactDay,
      timeFrom,
      timeTo,
    });
  };

  const rangeReady = Boolean(rangeStart && rangeEnd && rangeStart <= rangeEnd);
  const summary =
    mode === "exact"
      ? conciseDate(exactDay)
      : `${conciseDate(rangeStart)} – ${conciseDate(rangeEnd)}`;

  return (
    <div className="lf-date-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="lf-date-picker" role="dialog" aria-modal="true" aria-labelledby="lf-date-title">
        <div className="lf-date-picker-head">
          <div>
            <span className="lf-section-label">Photo search window</span>
            <h2 id="lf-date-title">When could it have gone missing?</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close date picker">×</button>
        </div>

        <div className="lf-date-mode" role="group" aria-label="How certain is the loss date?">
          <button type="button" className={mode === "exact" ? "is-active" : undefined} onClick={() => chooseMode("exact")}>
            <strong>I know the day</strong><small>Scan one day</small>
          </button>
          <button type="button" className={mode === "range" ? "is-active" : undefined} onClick={() => chooseMode("range")}>
            <strong>I&apos;m not sure</strong><small>Use my trip dates</small>
          </button>
        </div>

        {mode === "range" && (
          <>
            <p className="lf-date-explainer">Choose the first and last possible day. The last day starts as today; you can change it.</p>
            <div className="lf-range-fields" role="group" aria-label="Selected travel date range">
              <button type="button" className={rangeTarget === "start" ? "is-active" : undefined} onClick={() => { setRangeTarget("start"); showMonth(monthKey(rangeStart || rangeEnd)); }}>
                <small>FROM</small><strong>{conciseDate(rangeStart)}</strong>
              </button>
              <span aria-hidden="true">→</span>
              <button type="button" className={rangeTarget === "end" ? "is-active" : undefined} onClick={() => { setRangeTarget("end"); showMonth(monthKey(rangeEnd)); }}>
                <small>TO</small><strong>{conciseDate(rangeEnd)}</strong>
              </button>
            </div>
          </>
        )}

        <div className="lf-calendar-head" data-dir={pageDir}>
          <button type="button" onClick={() => showMonth(moveMonth(visibleMonth, -1))} aria-label="Previous month">‹</button>
          <strong key={visibleMonth}>{monthLabel(visibleMonth)}</strong>
          <button type="button" onClick={() => showMonth(moveMonth(visibleMonth, 1))} disabled={visibleMonth >= currentMonth} aria-label="Next month">›</button>
        </div>
        <div key={visibleMonth} className="lf-calendar-grid" data-dir={pageDir} aria-label={monthLabel(visibleMonth)}>
          {WEEKDAYS.map((weekday, index) => <small key={`${weekday}-${index}`}>{weekday}</small>)}
          {days.map((day, index) => {
            if (!day) return <i key={`blank-${index}`} />;
            const exactSelected = mode === "exact" && day === exactDay;
            const rangeEdge = mode === "range" && (day === rangeStart || day === rangeEnd);
            const inRange = mode === "range" && Boolean(rangeStart && rangeEnd && day > rangeStart && day < rangeEnd);
            return (
              <button
                key={day}
                type="button"
                className={`${exactSelected || rangeEdge ? "is-selected" : ""}${inRange ? " is-in-range" : ""}`}
                disabled={day > today}
                onClick={() => chooseDay(day)}
                aria-pressed={exactSelected || rangeEdge || inRange}
              >
                {Number(day.slice(-2))}
              </button>
            );
          })}
        </div>

        {mode === "exact" && (
          <div className="lf-date-time">
            <span className="lf-section-label">Time (optional)</span>
            <div role="group" aria-label="Approximate loss time">
              {(["any", "morning", "afternoon", "evening"] as const).map((choice) => (
                <button key={choice} type="button" className={timeChoice === choice ? "is-active" : undefined} onClick={() => setTimeChoice(choice)}>
                  {choice === "any" ? "Any time" : choice[0].toUpperCase() + choice.slice(1)}
                </button>
              ))}
              <label className={timeChoice === "exact" ? "is-active" : undefined}>
                <span>Exact</span>
                <input type="time" value={exactTime} onFocus={() => setTimeChoice("exact")} onChange={(event) => { setExactTime(event.target.value); setTimeChoice("exact"); }} aria-label="Exact loss time" />
              </label>
            </div>
          </div>
        )}

        <div className="lf-date-confirm">
          <p><strong>{summary}</strong><small>Only photo time and GPS are read on this device.</small></p>
          <button type="button" className="lf-primary" disabled={busy || (mode === "range" && !rangeReady)} onClick={confirm}>
            {busy ? "Reading photos…" : mode === "exact" ? "Read this day" : "Read this date range"}
          </button>
        </div>
      </section>
    </div>
  );
}
