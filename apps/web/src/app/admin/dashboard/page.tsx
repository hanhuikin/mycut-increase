"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useLocale } from "@/locale/locale-context";
import {
	GateErrorView,
	LoadErrorView,
	type GateStatus,
	isGateStatus,
} from "../gate-error-view";

type StatsRange = "24h" | "7d" | "30d";
type Granularity = "hour" | "day";

interface StatsResponse {
	range: StatsRange;
	granularity: Granularity;
	offsetMinutes: number;
	totals: {
		calls: number;
		consumed: number;
		failed: number;
		successRate: number | null;
		seconds: number;
		activeUsers: number;
		granted: number;
		averageRpm: number;
	};
	byModel: Array<{
		modelId: string | null;
		label: string;
		calls: number;
		consumed: number;
		seconds: number;
	}>;
	trend: Array<{ bucket: string; calls: number; consumed: number }>;
	modelSeries: Array<{ modelId: string | null; consumed: number[] }>;
}

interface RegistryModel {
	id: string;
	label: string;
}

/**
 * Categorical hues, in fixed order. These are the app's own `--chart-*` tokens;
 * the dark-mode steps are re-derived in globals.css and validated against the
 * dark surface. The residual bucket is neutral ink, not a sixth hue — it holds
 * "other models" plus rows recorded before per-model attribution existed.
 */
const SERIES_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];
const RESIDUAL_KEY = "__residual__";

const RANGES: StatsRange[] = ["24h", "7d", "30d"];

const fmtInt = (value: number) => value.toLocaleString();
const fmtDecimals = (value: number) =>
	value >= 0.1 ? value.toFixed(2) : value.toFixed(3);

/** Bucket labels are local wall times; read them back with UTC getters. */
function bucketLabel(iso: string, granularity: Granularity): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	const monthDay = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	return granularity === "hour"
		? `${pad(d.getUTCHours())}:00`
		: monthDay;
}

function bucketTooltipLabel(iso: string, granularity: Granularity): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	return granularity === "hour"
		? `${date} ${pad(d.getUTCHours())}:00`
		: date;
}

interface SeriesMeta {
	key: string;
	label: string;
	color: string;
}

export default function AdminDashboardPage() {
	const { t } = useLocale();
	const [stats, setStats] = useState<StatsResponse | null>(null);
	const [registry, setRegistry] = useState<RegistryModel[]>([]);
	const [gateError, setGateError] = useState<GateStatus | null>(null);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [range, setRange] = useState<StatsRange>("24h");

	// The registry is fetched together with the stats: it decides each model's
	// colour slot, so losing it silently would fold every model into one bucket.
	const load = useCallback(async (nextRange: StatsRange) => {
		const offset = -new Date().getTimezoneOffset();
		const params = new URLSearchParams({
			range: nextRange,
			offset: String(offset),
		});
		const [statsRes, registryRes] = await Promise.all([
			fetch(`/api/admin/stats?${params.toString()}`),
			fetch("/api/admin/models"),
		]);
		for (const res of [statsRes, registryRes]) {
			if (res.ok) continue;
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			setLoadFailure(String(res.status));
			return;
		}
		setLoadFailure(null);
		setStats((await statsRes.json()) as StatsResponse);
		setRegistry(((await registryRes.json()) as { models: RegistryModel[] }).models);
	}, []);

	useEffect(() => {
		load(range);
	}, [load, range]);

	/**
	 * Colour follows the entity, not its rank: each model's slot comes from the
	 * registry order, so changing the range can never repaint a model. Models
	 * beyond the five hues, and unattributed rows, share one neutral bucket.
	 */
	const series = useMemo<SeriesMeta[]>(() => {
		const slot = new Map(registry.map((model, index) => [model.id, index]));
		const named: SeriesMeta[] = [];
		for (const model of registry) {
			const index = slot.get(model.id) ?? 0;
			if (index >= SERIES_COLORS.length) continue;
			named.push({
				key: model.id,
				label: model.label,
				color: SERIES_COLORS[index],
			});
		}
		return [
			...named,
			{
				key: RESIDUAL_KEY,
				label: t["admin.dashboard.unattributed"],
				color: "var(--muted-foreground)",
			},
		];
	}, [registry, t]);

	const namedKeys = useMemo(
		() => new Set(series.map((entry) => entry.key).filter((key) => key !== RESIDUAL_KEY)),
		[series],
	);

	/** Buckets as chart rows, folding every unnamed model into the residual. */
	const chartRows = useMemo(() => {
		if (!stats) return [];
		return stats.trend.map((point, index) => {
			const row: Record<string, number | string> = {
				bucket: bucketLabel(point.bucket, stats.granularity),
				fullLabel: bucketTooltipLabel(point.bucket, stats.granularity),
			};
			for (const entry of series) {
				row[entry.key] = 0;
			}
			for (const modelSeries of stats.modelSeries) {
				const key =
					modelSeries.modelId && namedKeys.has(modelSeries.modelId)
						? modelSeries.modelId
						: RESIDUAL_KEY;
				row[key] = Number(row[key]) + (modelSeries.consumed[index] ?? 0);
			}
			return row;
		});
	}, [stats, series, namedKeys]);

	/** Per-series totals for the table — the numbers behind the stacked fills. */
	const tableRows = useMemo(() => {
		if (!stats) return [];
		const totals = new Map<string, { calls: number; consumed: number; seconds: number }>();
		for (const entry of series) {
			totals.set(entry.key, { calls: 0, consumed: 0, seconds: 0 });
		}
		for (const model of stats.byModel) {
			const key = model.modelId && namedKeys.has(model.modelId) ? model.modelId : RESIDUAL_KEY;
			const current = totals.get(key) ?? { calls: 0, consumed: 0, seconds: 0 };
			totals.set(key, {
				calls: current.calls + model.calls,
				consumed: current.consumed + model.consumed,
				seconds: current.seconds + model.seconds,
			});
		}
		return series.map((entry) => ({
			...entry,
			...(totals.get(entry.key) ?? { calls: 0, consumed: 0, seconds: 0 }),
		}));
	}, [stats, series, namedKeys]);

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}
	if (loadFailure) {
		return <LoadErrorView status={loadFailure} onRetry={() => load(range)} />;
	}

	const totals = stats?.totals;
	const hasData = (totals?.calls ?? 0) > 0;
	const rangeLabel = t[`admin.dashboard.range_${range}`];

	const cards = [
		{
			key: "calls",
			label: t["admin.dashboard.calls"],
			value: totals ? fmtInt(totals.calls) : null,
			caption: rangeLabel,
		},
		{
			key: "consumed",
			label: t["admin.dashboard.consumed"],
			value: totals ? fmtInt(totals.consumed) : null,
			caption: rangeLabel,
		},
		{
			key: "seconds",
			label: t["admin.dashboard.seconds"],
			value: totals ? fmtInt(totals.seconds) : null,
			caption: rangeLabel,
		},
		{
			key: "rpm",
			label: t["admin.dashboard.rpm"],
			value: totals ? fmtDecimals(totals.averageRpm) : null,
			caption: t["admin.dashboard.rpm_hint"],
		},
		{
			key: "rate",
			label: t["admin.dashboard.success_rate"],
			value: totals
				? totals.successRate === null
					? t["admin.dashboard.rate_none"]
					: `${(totals.successRate * 100).toFixed(totals.successRate === 1 ? 0 : 1)}%`
				: null,
			caption: totals?.failed
				? `${t["admin.dashboard.failed"]} ${fmtInt(totals.failed)}`
				: rangeLabel,
		},
	];

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center gap-2">
				<div className="border-border flex overflow-hidden rounded-md border">
					{RANGES.map((entry) => (
						<button
							key={entry}
							type="button"
							onClick={() => setRange(entry)}
							data-active={range === entry}
							className="text-muted-foreground hover:text-foreground data-[active=true]:bg-primary/10 data-[active=true]:text-primary px-2.5 py-1 text-[13.5px]"
						>
							{t[`admin.dashboard.range_${entry}`]}
						</button>
					))}
				</div>
				{stats && (
					<span className="text-muted-foreground font-mono text-[12.5px]">
						{t[
							stats.granularity === "hour"
								? "admin.dashboard.bucket_hour"
								: "admin.dashboard.bucket_day"
						]}
					</span>
				)}
			</div>

			<div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
				{cards.map((card) => (
					<div
						key={card.key}
						className="bg-card border-border flex flex-col gap-1.5 rounded-xl border px-4 py-3.5"
					>
						<span className="text-muted-foreground text-[12.5px]">
							{card.label}
						</span>
						{card.value === null ? (
							<Skeleton className="h-8 w-20" />
						) : (
							<span className="text-[28px] leading-none font-semibold tabular-nums">
								{card.value}
							</span>
						)}
						<span className="text-muted-foreground text-[12px]">
							{card.caption}
						</span>
					</div>
				))}
			</div>

			<div className="bg-card border-border flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-2.5 text-[13.5px]">
				{[
					{
						label: t["admin.dashboard.active_users"],
						value: totals ? fmtInt(totals.activeUsers) : "—",
					},
					{
						label: t["admin.dashboard.failed"],
						value: totals ? fmtInt(totals.failed) : "—",
					},
					{
						label: t["admin.dashboard.granted"],
						value: totals ? fmtInt(totals.granted) : "—",
					},
				].map((item) => (
					<span key={item.label} className="inline-flex items-center gap-2">
						<span className="text-muted-foreground">{item.label}</span>
						<span className="font-mono tabular-nums">{item.value}</span>
					</span>
				))}
			</div>

			<Card title={t["admin.dashboard.by_model"]} hint={t["admin.dashboard.legend_hint"]}>
				{!hasData ? (
					<EmptyNote label={t["admin.dashboard.no_data"]} />
				) : (
					<>
						<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
							{series.map((entry) => (
								<span
									key={entry.key}
									className="text-muted-foreground inline-flex items-center gap-1.5 text-[12.5px]"
								>
									<span
										className="size-2.5 rounded-[3px]"
										style={{ background: entry.color }}
									/>
									{entry.label}
								</span>
							))}
						</div>
						<div className="h-[260px] w-full">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={chartRows} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
									<CartesianGrid
										vertical={false}
										stroke="var(--border)"
										strokeDasharray="3 3"
									/>
									<XAxis
										dataKey="bucket"
										tickLine={false}
										axisLine={false}
										minTickGap={20}
										tickMargin={8}
										tick={{ fill: "var(--muted-foreground)", fontSize: 12.5 }}
									/>
									<YAxis
										tickLine={false}
										axisLine={false}
										allowDecimals={false}
										tick={{ fill: "var(--muted-foreground)", fontSize: 12.5 }}
									/>
									<Tooltip
										cursor={{ fill: "var(--accent)" }}
										content={<ChartTooltip formatter={fmtInt} />}
									/>
									{series.map((entry, index) => (
										<Bar
											key={entry.key}
											dataKey={entry.key}
											name={entry.label}
											stackId="spend"
											fill={entry.color}
											stroke="var(--background)"
											strokeWidth={2}
											radius={
												index === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
											}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							</ResponsiveContainer>
						</div>

						<div className="border-border mt-4 overflow-hidden rounded-lg border">
							<Table className="text-[13.5px]">
								<TableHeader>
									<TableRow>
										<TableHead>{t["admin.dashboard.table_model"]}</TableHead>
										<TableHead className="text-right">
											{t["admin.dashboard.table_calls"]}
										</TableHead>
										<TableHead className="text-right">
											{t["admin.dashboard.table_consumed"]}
										</TableHead>
										<TableHead className="text-right">
											{t["admin.dashboard.table_seconds"]}
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{tableRows.map((row) => (
										<TableRow key={row.key}>
											<TableCell>
												<span className="inline-flex items-center gap-2">
													<span
														className="size-2.5 rounded-[3px]"
														style={{ background: row.color }}
													/>
													{row.label}
												</span>
											</TableCell>
											<TableCell className="text-right font-mono tabular-nums">
												{fmtInt(row.calls)}
											</TableCell>
											<TableCell className="text-right font-mono tabular-nums">
												{fmtInt(row.consumed)}
											</TableCell>
											<TableCell className="text-right font-mono tabular-nums">
												{fmtInt(row.seconds)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</>
				)}
			</Card>

			<Card title={t["admin.dashboard.trend"]} hint={t["admin.dashboard.trend_hint"]}>
				{!hasData ? (
					<EmptyNote label={t["admin.dashboard.no_data"]} />
				) : (
					<div className="h-[220px] w-full">
						<ResponsiveContainer width="100%" height="100%">
							<AreaChart
								data={chartRows}
								margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
							>
								<defs>
									<linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
										<stop
											offset="0%"
											stopColor="var(--primary)"
											stopOpacity={0.26}
										/>
										<stop
											offset="100%"
											stopColor="var(--primary)"
											stopOpacity={0.02}
										/>
									</linearGradient>
								</defs>
								<CartesianGrid
									vertical={false}
									stroke="var(--border)"
									strokeDasharray="3 3"
								/>
								<XAxis
									dataKey="bucket"
									tickLine={false}
									axisLine={false}
									minTickGap={20}
									tickMargin={8}
									tick={{ fill: "var(--muted-foreground)", fontSize: 12.5 }}
								/>
								<YAxis
									tickLine={false}
									axisLine={false}
									allowDecimals={false}
									tick={{ fill: "var(--muted-foreground)", fontSize: 12.5 }}
								/>
								<Tooltip
									cursor={{ stroke: "var(--border)" }}
									content={<ChartTooltip formatter={fmtInt} />}
								/>
								<Area
									type="monotone"
									dataKey="calls"
									name={t["admin.dashboard.calls"]}
									stroke="var(--primary)"
									strokeWidth={2}
									fill="url(#callsFill)"
									isAnimationActive={false}
								/>
							</AreaChart>
						</ResponsiveContainer>
					</div>
				)}
			</Card>
		</div>
	);
}

function Card({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="bg-card border-border rounded-xl border p-4">
			<div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 className="text-[15px] font-semibold">{title}</h2>
				{hint && (
					<p className="text-muted-foreground text-[12.5px]">{hint}</p>
				)}
			</div>
			{children}
		</section>
	);
}

function EmptyNote({ label }: { label: string }) {
	return (
		<div className="text-muted-foreground border-border flex h-[200px] items-center justify-center rounded-lg border border-dashed text-[13.5px]">
			{label}
		</div>
	);
}

/** Text wears ink tokens; the swatch beside it carries series identity. */
function ChartTooltip({
	active,
	payload,
	formatter,
}: {
	active?: boolean;
	payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string; payload?: Record<string, unknown> }>;
	formatter?: (value: number) => string;
}) {
	if (!active || !payload?.length) return null;
	const rows = payload.filter((item) => Number(item.value) > 0);
	if (rows.length === 0) return null;
	const fullLabel = payload[0]?.payload?.fullLabel as string | undefined;

	return (
		<div className="bg-popover border-border min-w-36 rounded-md border px-2.5 py-2 shadow-md">
			{fullLabel && (
				<p className="text-muted-foreground mb-1.5 font-mono text-[12px]">
					{fullLabel}
				</p>
			)}
			{rows.map((item) => (
				<div
					key={item.dataKey}
					className="flex items-center gap-2 text-[13px]"
				>
					<span
						className="size-2.5 shrink-0 rounded-[3px]"
						style={{ background: item.color }}
					/>
					<span className="text-foreground">{item.name}</span>
					<span className="text-foreground ml-auto pl-4 font-mono tabular-nums">
						{formatter ? formatter(Number(item.value ?? 0)) : item.value}
					</span>
				</div>
			))}
		</div>
	);
}
