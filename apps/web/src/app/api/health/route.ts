import { withRoute } from "@/services/logging/with-route";
async function getHandler() {
	return new Response("OK", { status: 200 });
}

export const GET = withRoute(getHandler);
