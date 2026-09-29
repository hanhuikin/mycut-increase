import { gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiModels, creditLedger } from "@/db/schema";

export type StatsRange = "24h" | "7d" | "30d";
export type StatsGranularity = "hour" | "day";

export const STATS_RANGES: StatsRange[] = ["24h", "7d", "30d"];

/**
 * Consumption is not the sum of `settle` rows. The books record a job as
 * `freeze` (−estimate), then `settle` (+ the unused remainder) on success or
 * `refund` (+ the whole estimate) on failure. Those three net to −actual, so
 * real usage is `−(freeze + settle + refund)`.
 */
const CONSUMPTION_KINDS = sql`('freeze', 'settle', 'refund')`;
const TOPUP_KINDS = sql`('grant', 'redeem', 'adjust')`;

export interface StatsTotals {
	calls: number;
	consumed: number;
	failed: number;
	/** null when nothing ran in the window — not "0%" which would read as broken. */
	successRate: number | null;
	seconds: number;
	activeUsers: number;
	granted: number;
	averageRpm: number;
}

export interface ModelUsage {
	/** null for rows written before per-model attribution existed. */
	modelId: string | null;
	label: string;
	calls: number;
	consumed: number;
	seconds: number;
}

export interface TrendPoint {
	/** ISO timestamp of the bucket start (UTC). */
	bucket: string;
	calls: number;
	consumed: number;
}

export interface ModelSeries {
	/** null for rows written before per-model attribution existed. */
	modelId: string | null;
	/** Consumed points per bucket, index-aligned with `trend`. */
	consumed: number[];
}

export interface StatsResult {
	range: StatsRange;
	granularity: StatsGranularity;
	from: string;
	/** Echoed so the client can label buckets in the same frame. */
	offsetMinutes: number;
	totals: StatsTotals;
	byModel: ModelUsage[];
	trend: TrendPoint[];
	/** Same buckets as `trend`, split by model — feeds the stacked chart. */
	modelSeries: ModelSeries[];
}

/** Postgres `date_trunc` works in UTC here, so bucket in UTC to match it. */
function truncateUtc(ms: number, granularity: StatsGranularity): number {
	const d = new Date(ms);
	return granularity === "hour"
		? Date.UTC(
				d.getUTCFullYear(),
				d.getUTCMonth(),
				d.getUTCDate(),
				d.getUTCHours(),
			)
		: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const RANGE_MS: Record<StatsRange, number> = {
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

export async function getStats({
	range,
	now = Date.now(),
	offsetMinutes = 0,
}: {
	range: StatsRange;
	now?: number;
	/** Viewer's UTC offset in minutes, so buckets follow their local day. */
	offsetMinutes?: number;
}): Promise<StatsResult> {
	const granularity: StatsGranularity = range === "24h" ? "hour" : "day";
	const bucketMs = granularity === "hour" ? 3_600_000 : 86_400_000;
	const bucketCount = range === "24h" ? 24 : range === "7d" ? 7 : 30;

	const offsetMs = offsetMinutes * 60_000;

	// Bucket bounds are computed in the viewer's local frame; `since` is
	// converted back so it compares against the raw (UTC) column.
	const firstBucketMs = truncateUtc(
		now + offsetMs - (bucketCount - 1) * bucketMs,
		granularity,
	);
	const since = new Date(firstBucketMs - offsetMs);

	// The shift is an inlined integer (never user text). Inlining also keeps the
	// SELECT and GROUP BY expressions textually identical — with a bound
	// parameter Postgres treats them as two different expressions and rejects
	// the query.
	const shift = sql.raw(String(Math.trunc(offsetMinutes)));
	const bucketExpr =
		granularity === "hour"
			? sql`date_trunc('hour', ${creditLedger.createdAt} + make_interval(mins => ${shift}))`
			: sql`date_trunc('day', ${creditLedger.createdAt} + make_interval(mins => ${shift}))`;

	const [modelRows, summaryRows, trendRows, modelTrendRows] = await Promise.all([
		db
			.select({
				modelId: creditLedger.modelId,
				calls: sql<number>`count(*) filter (where ${creditLedger.kind} = 'freeze')`,
				net: sql<number>`coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.kind} in ${CONSUMPTION_KINDS}), 0)`,
				seconds: sql<number>`coalesce(sum(${creditLedger.seconds}) filter (where ${creditLedger.kind} = 'freeze'), 0)`,
			})
			.from(creditLedger)
			.where(gte(creditLedger.createdAt, since))
			.groupBy(creditLedger.modelId),
		db
			.select({
				activeUsers: sql<number>`count(distinct ${creditLedger.userId}) filter (where ${creditLedger.kind} = 'freeze')`,
				failed: sql<number>`count(*) filter (where ${creditLedger.kind} = 'refund')`,
				granted: sql<number>`coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.kind} in ${TOPUP_KINDS}), 0)`,
			})
			.from(creditLedger)
			.where(gte(creditLedger.createdAt, since)),
		db
			.select({
				bucket: sql<Date | string>`${bucketExpr}`,
				calls: sql<number>`count(*) filter (where ${creditLedger.kind} = 'freeze')`,
				net: sql<number>`coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.kind} in ${CONSUMPTION_KINDS}), 0)`,
			})
			.from(creditLedger)
			.where(gte(creditLedger.createdAt, since))
			.groupBy(bucketExpr)
			.orderBy(bucketExpr),
		db
			.select({
				modelId: creditLedger.modelId,
				bucket: sql<Date | string>`${bucketExpr}`,
				net: sql<number>`coalesce(sum(${creditLedger.amount}) filter (where ${creditLedger.kind} in ${CONSUMPTION_KINDS}), 0)`,
			})
			.from(creditLedger)
			.where(gte(creditLedger.createdAt, since))
			.groupBy(creditLedger.modelId, bucketExpr),
	]);

	// postgres-js hands back bigint aggregates as strings; coerce once here.
	const toNumber = (value: unknown) => Number(value ?? 0);

	const modelIds = modelRows
		.map((row) => row.modelId)
		.filter((id): id is string => Boolean(id));
	const labelRows = modelIds.length
		? await db
				.select({ id: aiModels.id, label: aiModels.label })
				.from(aiModels)
				.where(inArray(aiModels.id, modelIds))
		: [];
	const labels = new Map(labelRows.map((row) => [row.id, row.label]));

	const byModel: ModelUsage[] = modelRows
		.map((row) => ({
			modelId: row.modelId,
			label: row.modelId ? (labels.get(row.modelId) ?? row.modelId) : "",
			calls: toNumber(row.calls),
			consumed: -toNumber(row.net),
			seconds: toNumber(row.seconds),
		}))
		.sort((a, b) => b.consumed - a.consumed || b.calls - a.calls);

	const summary = summaryRows[0];
	const calls = byModel.reduce((sum, entry) => sum + entry.calls, 0);
	const failed = toNumber(summary?.failed);

	const trendMap = new Map<number, { calls: number; consumed: number }>();
	for (const row of trendRows) {
		const key = truncateUtc(new Date(row.bucket).getTime(), granularity);
		trendMap.set(key, {
			calls: toNumber(row.calls),
			consumed: -toNumber(row.net),
		});
	}

	// Fill empty buckets so the chart's x-axis stays continuous.
	const trend: TrendPoint[] = Array.from({ length: bucketCount }, (_, index) => {
		const bucketMsValue = firstBucketMs + index * bucketMs;
		const point = trendMap.get(bucketMsValue);
		return {
			bucket: new Date(bucketMsValue).toISOString(),
			calls: point?.calls ?? 0,
			consumed: point?.consumed ?? 0,
		};
	});

	// Same buckets, split by model, so the stacked chart is index-aligned.
	const seriesByModel = new Map<string | null, number[]>();
	for (const row of modelTrendRows) {
		const key = row.modelId;
		const values = seriesByModel.get(key) ?? new Array(bucketCount).fill(0);
		const index = Math.round(
			(truncateUtc(new Date(row.bucket).getTime(), granularity) -
				firstBucketMs) /
				bucketMs,
		);
		if (index >= 0 && index < bucketCount) {
			values[index] = -toNumber(row.net);
		}
		seriesByModel.set(key, values);
	}

	const modelSeries: ModelSeries[] = [...seriesByModel.entries()].map(
		([modelId, consumed]) => ({ modelId, consumed }),
	);

	return {
		range,
		granularity,
		from: new Date(firstBucketMs - offsetMs).toISOString(),
		offsetMinutes,
		totals: {
			calls,
			consumed: byModel.reduce((sum, entry) => sum + entry.consumed, 0),
			failed,
			successRate: calls > 0 ? Math.max(0, 1 - failed / calls) : null,
			seconds: byModel.reduce((sum, entry) => sum + entry.seconds, 0),
			activeUsers: toNumber(summary?.activeUsers),
			granted: toNumber(summary?.granted),
			averageRpm: calls / (RANGE_MS[range] / 60_000),
		},
		byModel,
		trend,
		modelSeries,
	};
}
