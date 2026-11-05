import { auth } from "@/auth/server";
import { toNextJsHandler } from "better-auth/next-js";
import { withRoute } from "@/services/logging/with-route";

const handlers = toNextJsHandler(auth);
// Wrapped like every other route: one JSON access line per auth call, with
// the client's trace id honoured and mirrored back in `x-trace-id`.
export const POST = withRoute(handlers.POST);
export const GET = withRoute(handlers.GET);
