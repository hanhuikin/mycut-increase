import { redirect } from "next/navigation";

/** /admin has no panel of its own — land on the dashboard. */
export default function AdminIndexPage() {
	redirect("/admin/dashboard");
}
