import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { webEnv } from "@/env/web";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getDb() {
	if (!_db) {
		// Pool size is tunable so instance count × pool stays under the
		// database server's max_connections (postgres.js defaults to 10).
		const poolMax = Number.parseInt(process.env.PGPOOL_MAX ?? "", 10);
		_client = postgres(webEnv.DATABASE_URL, {
			max:
				Number.isFinite(poolMax) && poolMax > 0
					? poolMax
					: 10,
			// Fail fast when the database host is unreachable. The default is
			// 30s, and Windows' TCP SYN retry alone burns ~21s — long enough
			// that 5s-polling API routes pile up behind a dead connection and
			// surface as 19s/500s (e.g. session lookup during a DB restart).
			connect_timeout: 5,
		});
		_db = drizzle(_client, { schema });
	}

	return _db;
}

export const db = getDb();

export * from "./schema";
