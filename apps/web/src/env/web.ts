import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url(),

	// Server
	DATABASE_URL: z.string().refine(
		(url) =>
			url.startsWith("postgres://") || url.startsWith("postgresql://"),
		"DATABASE_URL must be a postgres:// or postgresql:// URL",
	),

	BETTER_AUTH_SECRET: z.string(),
	REDIS_URL: z.string().refine(
		(value) => value.startsWith("redis://") || value.startsWith("rediss://"),
		"REDIS_URL must be a redis:// or rediss:// URL",
	),
	MARBLE_WORKSPACE_KEY: z.string(),
	FREESOUND_CLIENT_ID: z.string(),
	FREESOUND_API_KEY: z.string(),
	ARK_API_KEY: z.string().optional(),
	/** 32 bytes of hex; encrypts provider keys stored in the database. */
	MODEL_CREDENTIALS_KEY: z
		.string()
		.regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hex (64 hex chars)")
		.optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
