"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  OpsBatchTarget,
  OpsDashboardSnapshot,
  OpsSeverity,
  OpsStageStatus,
} from "../../lib/lost-found-ops";

export type RemoteFeedStatus = {
  state: "current" | "behind" | "unavailable";
  generatedAt?: string;
  publishedAt?: string;
  datasetVersion?: string;
  channels?: number;
  reviewedVenues?: number;
  message: string;
};

type Props = {
  snapshot: OpsDashboardSnapshot;
  remote: RemoteFeedStatus;
  operatorName: string;
};

const STATUS_STYLE: Record<OpsStageStatus, string> = {
  healthy: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  blocked: "border-red-200 bg-red-50 text-red-800",
};

const SEVERITY_STYLE: Record<OpsSeverity, string> = {
  critical: "bg-red-700 text-white",
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-900",
  low: "bg-slate-100 text-slate-700",
};

function shortDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

function safeFileStem(domain: string): string {
  return domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

function commandsFor(targets: OpsBatchTarget[]): string {
  const outputs = targets.map(
    (target) => `.codex_tmp/ops/${safeFileStem(target.domain)}.json`
  );
  const discovery = targets.map(
    (target, index) =>
      `npm run data:lost-found:discover -- --domain=${target.domain} --limit=1 --max-pages=8 --depth=2 --delay=250 --fresh --output=${outputs[index]}`
  );
  return [
    "mkdir -p .codex_tmp/ops",
    ...discovery,
    `npm run data:lost-found:merge -- --inputs=${outputs.join(",")} --output=.codex_tmp/ops/batch.candidates.json`,
    "npm run data:lost-found:scan-report -- --inputs=.codex_tmp/ops/batch.candidates.json --report=.codex_tmp/ops/batch.scan.json",
    "# Inspect the batch report before merging it into the tracked candidate registry.",
  ].join("\n");
}

function BarList({
  values,
  total,
  palette = "navy",
}: {
  values: Array<{ id: string; label: string; value: number }>;
  total: number;
  palette?: "navy" | "status";
}) {
  const colors = ["#16385c", "#3f6487", "#7590a8", "#a9bac8", "#d7dfe5"];
  const statusColors: Record<string, string> = {
    pending: "#a9bac8",
    accepted: "#1b7f4b",
    rejected: "#d8232a",
  };
  return (
    <div className="space-y-3">
      {values.map((entry, index) => {
        const ratio = total > 0 ? entry.value / total : 0;
        return (
          <div key={entry.id}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-slate-700">{entry.label}</span>
              <span className="tabular-nums text-slate-500">
                {entry.value.toLocaleString("en-US")} · {percent(ratio)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-sm bg-slate-100">
              <div
                className="h-full rounded-sm transition-[width] duration-500"
                style={{
                  width: `${Math.max(ratio * 100, entry.value > 0 ? 0.8 : 0)}%`,
                  background:
                    palette === "status"
                      ? statusColors[entry.id] ?? colors[index % colors.length]
                      : colors[index % colors.length],
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OpsDashboard({ snapshot, remote, operatorName }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(() =>
    snapshot.batchTargets.slice(0, 5).map((target) => target.domain)
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const selectedTargets = useMemo(
    () =>
      snapshot.batchTargets.filter((target) => selected.includes(target.domain)),
    [selected, snapshot.batchTargets]
  );
  const batchCommands = useMemo(
    () => commandsFor(selectedTargets),
    [selectedTargets]
  );
  const remoteStyle =
    remote.state === "current"
      ? STATUS_STYLE.healthy
      : remote.state === "behind"
        ? STATUS_STYLE.warning
        : STATUS_STYLE.blocked;
  const overallLabel =
    snapshot.overallStatus === "healthy"
      ? "Operational"
      : snapshot.overallStatus === "warning"
        ? "Attention needed"
        : "Blocked";

  const toggleTarget = (domain: string) => {
    setSelected((current) => {
      if (current.includes(domain)) {
        return current.length <= 3
          ? current
          : current.filter((value) => value !== domain);
      }
      return current.length >= 5 ? current : [...current, domain];
    });
  };

  const copyCommands = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(batchCommands);
      setCopyState("copied");
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = batchCommands;
      textArea.setAttribute("readonly", "");
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      const copied = document.execCommand("copy");
      textArea.remove();
      setCopyState(copied ? "copied" : "failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1_500);
  };

  return (
    <main className="min-h-screen bg-[#e7e8e4] px-4 py-5 text-[#10161c] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1480px]">
        <header className="rounded-sm border border-slate-300 bg-white px-5 py-4 shadow-[0_8px_24px_rgba(16,22,28,0.06)] sm:px-7 sm:py-6">
          <nav className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            <div className="flex items-center gap-4">
              <Link href="/" className="hover:text-[#16385c]">
                Traveller app
              </Link>
              <span className="h-3 w-px bg-slate-300" />
              <Link href="/review" className="hover:text-[#16385c]">
                Review queue
              </Link>
            </div>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="border border-slate-300 bg-white px-3 py-2 text-[#16385c] hover:border-[#16385c]"
            >
              Refresh snapshot
            </button>
          </nav>
          <div className="mt-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#d8232a]">
                Berlin Lost &amp; Found · private operations
              </p>
              <h1 className="mt-2 max-w-4xl text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
                Channel pipeline control room
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                Monitor discovery, evidence quality, review and publication. This
                page never submits a lost-property report and never executes local
                shell commands.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={`border px-3 py-2 font-semibold ${STATUS_STYLE[snapshot.overallStatus]}`}
              >
                {overallLabel}
              </span>
              <span className="text-slate-500">
                {operatorName} · {shortDate(snapshot.generatedAt)}
              </span>
            </div>
          </div>
        </header>

        <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            {
              label: "Venue inventory",
              value: compactNumber(snapshot.headline.totalVenues),
              detail: "All indexed Berlin places",
            },
            {
              label: "Current crawl",
              value: percent(snapshot.headline.crawlRate),
              detail: `${snapshot.headline.crawlCompleted}/${snapshot.headline.crawlTotal} scopes`,
            },
            {
              label: "Candidate queue",
              value: compactNumber(snapshot.headline.candidates),
              detail: "Destinations awaiting disposition",
            },
            {
              label: "Current accepts",
              value: snapshot.headline.currentAcceptances.toString(),
              detail: "Joined to current candidate versions",
            },
            {
              label: "Published channels",
              value: snapshot.headline.publishedChannels.toString(),
              detail: `${snapshot.headline.coveredVenues} reviewed venues`,
            },
            {
              label: "Direct fallback candidates",
              value: compactNumber(
                snapshot.headline.directContactFallbackCandidateVenues
              ),
              detail: "Official general forms, emails or phones",
            },
          ].map((metric) => (
            <article
              key={metric.label}
              className="min-h-32 border border-slate-300 bg-white p-4"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {metric.label}
              </p>
              <p className="mt-4 text-3xl font-bold tabular-nums tracking-tight text-[#16385c]">
                {metric.value}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {metric.detail}
              </p>
            </article>
          ))}
        </section>

        <section className="mt-4 border border-slate-300 bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Pipeline state
              </p>
              <h2 className="mt-1 text-xl font-bold">From inventory to public feed</h2>
            </div>
            <span className={`border px-3 py-2 text-xs font-semibold ${remoteStyle}`}>
              Public feed · {remote.state}
            </span>
          </div>
          <div className="mt-5 grid gap-3 lg:grid-cols-5">
            {snapshot.stages.map((stage, index) => (
              <article
                key={stage.id}
                className="relative border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-400">
                    0{index + 1}
                  </span>
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      stage.status === "healthy"
                        ? "bg-emerald-600"
                        : stage.status === "warning"
                          ? "bg-amber-500"
                          : "bg-red-600"
                    }`}
                    aria-label={stage.status}
                  />
                </div>
                <h3 className="mt-4 text-sm font-semibold">{stage.label}</h3>
                <p className="mt-1 text-xl font-bold text-[#16385c]">{stage.value}</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">{stage.detail}</p>
              </article>
            ))}
            <article className={`border p-4 ${remoteStyle}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] opacity-60">05</span>
                <span className="h-2.5 w-2.5 rounded-full bg-current" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Remote feed</h3>
              <p className="mt-1 text-xl font-bold">
                {remote.channels ?? "—"} channels
              </p>
              <p className="mt-2 text-xs leading-5 opacity-80">{remote.message}</p>
            </article>
          </div>
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <section className="border border-slate-300 bg-white p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Queue composition
            </p>
            <h2 className="mt-1 text-xl font-bold">What the crawler produced</h2>
            <div className="mt-6 grid gap-7 md:grid-cols-2">
              <div>
                <h3 className="mb-4 text-sm font-semibold text-slate-700">
                  Candidate kind
                </h3>
                <BarList
                  values={snapshot.candidateMix}
                  total={snapshot.headline.candidates}
                />
              </div>
              <div>
                <h3 className="mb-4 text-sm font-semibold text-slate-700">
                  Current disposition
                </h3>
                <BarList
                  values={snapshot.reviewMix}
                  total={snapshot.headline.candidates}
                  palette="status"
                />
              </div>
            </div>
          </section>

          <section className="border border-slate-300 bg-white p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Coverage model
            </p>
            <h2 className="mt-1 text-xl font-bold">Do not confuse a website with a route</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              The denominator for route coverage is staffed/addressable venues,
              not every sculpture, plaque or public-space object in the place index.
            </p>
            <div className="mt-6">
              <BarList
                values={snapshot.coverage.tiers}
                total={snapshot.headline.totalVenues}
              />
            </div>
          </section>
        </div>

        <section className="mt-4 border border-slate-300 bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Exceptions
              </p>
              <h2 className="mt-1 text-xl font-bold">What needs attention</h2>
            </div>
            <span className="text-xs text-slate-500">
              {snapshot.issues.length} active finding{snapshot.issues.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-300 text-[11px] uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="pb-3 pr-4">Severity</th>
                  <th className="pb-3 pr-4">Finding</th>
                  <th className="pb-3 pr-4">Evidence</th>
                  <th className="pb-3">Next action</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.issues.map((issue) => (
                  <tr key={issue.id} className="border-b border-slate-100 align-top">
                    <td className="py-4 pr-4">
                      <span
                        className={`inline-block px-2 py-1 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[issue.severity]}`}
                      >
                        {issue.severity}
                      </span>
                    </td>
                    <td className="py-4 pr-4 font-semibold">{issue.title}</td>
                    <td className="py-4 pr-4 text-slate-600">{issue.evidence}</td>
                    <td className="py-4 text-slate-600">{issue.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-4 border border-slate-300 bg-white p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Small-batch planner
              </p>
              <h2 className="mt-1 text-xl font-bold">Select 3–5 domains for the next run</h2>
              <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
                Commands write only to <code>.codex_tmp/ops</code>. Inspect the
                generated batch report before merging anything into tracked data.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-600">
                {selected.length}/5 selected
              </span>
              <button
                type="button"
                onClick={() => void copyCommands()}
                disabled={selected.length < 3}
                className="bg-[#16385c] px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy batch commands"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {snapshot.batchTargets.slice(0, 12).map((target) => {
              const checked = selected.includes(target.domain);
              const disabled = !checked && selected.length >= 5;
              return (
                <label
                  key={target.domain}
                  className={`cursor-pointer border p-4 transition-colors ${
                    checked
                      ? "border-[#16385c] bg-[#eef3f7]"
                      : "border-slate-200 bg-white hover:border-slate-400"
                  } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="break-all text-sm font-semibold">
                      {target.domain}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleTarget(target.domain)}
                      className="mt-0.5"
                    />
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    {target.reason}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
                    <span>{target.candidates} candidates</span>
                    <span>{target.pages} pages</span>
                    <span>{target.needsReview} review</span>
                  </div>
                </label>
              );
            })}
          </div>

          <details className="mt-5 border border-slate-200 bg-slate-950 text-slate-100">
            <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">
              Preview generated commands
            </summary>
            <pre className="max-h-80 overflow-auto border-t border-slate-800 p-4 text-[11px] leading-5 text-slate-300">
              {batchCommands}
            </pre>
          </details>
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
          <div className="border border-slate-300 bg-white p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Source freshness
            </p>
            <div className="mt-4 divide-y divide-slate-100">
              {snapshot.sources.map((source) => (
                <div
                  key={source.label}
                  className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto_auto] sm:gap-6"
                >
                  <span className="font-semibold">{source.label}</span>
                  <span className="tabular-nums text-slate-500">
                    {source.records.toLocaleString("en-US")} records
                  </span>
                  <span className="text-slate-500">{shortDate(source.generatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={`border p-5 sm:p-6 ${remoteStyle}`}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-70">
              Public update feed
            </p>
            <h2 className="mt-2 text-xl font-bold capitalize">{remote.state}</h2>
            <p className="mt-3 text-sm leading-6">{remote.message}</p>
            <dl className="mt-5 grid grid-cols-2 gap-4 text-xs">
              <div>
                <dt className="opacity-65">Generated</dt>
                <dd className="mt-1 font-semibold">{shortDate(remote.generatedAt)}</dd>
              </div>
              <div>
                <dt className="opacity-65">Dataset</dt>
                <dd className="mt-1 break-all font-mono font-semibold">
                  {remote.datasetVersion ?? "—"}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <footer className="px-1 py-6 text-xs leading-5 text-slate-500">
          Metrics are built from the tracked inventory, candidate, review,
          quality, coverage and published-registry artifacts. “Official contact”
          is never counted as a reviewed lost-property route.
        </footer>
      </div>
    </main>
  );
}
