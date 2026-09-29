import { NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { listModels, toPublicModel } from "@/services/admin/models";
import { db } from "@/db";
import { userModelGrants } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Public read of enabled models with pricing. When a session is present the
 * response also carries the plan and per-user Pro-model grants so the AI
 * panel can render "visible but locked" states.
 */
export async function GET() {
	const models = (await listModels({ enabledOnly: true })).map(toPublicModel);

	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ models, plan: null, granted: [] });
	}

	const grants = await db
		.select({ modelId: userModelGrants.modelId })
		.from(userModelGrants)
		.where(eq(userModelGrants.userId, user.id));

	return NextResponse.json({
		models,
		plan: user.plan,
		granted: grants.map((grant) => grant.modelId),
	});
}
