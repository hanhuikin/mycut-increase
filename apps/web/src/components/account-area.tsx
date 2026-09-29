"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/auth/client";
import { useLocale } from "@/locale/locale-context";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Header slot: a sign-in button for guests, an account menu for users. */
export function AccountArea() {
	const { t } = useLocale();
	const router = useRouter();
	const { data, isPending } = authClient.useSession();
	const [menuOpen, setMenuOpen] = useState(false);

	if (isPending) {
		return <div className="bg-muted size-8 animate-pulse rounded-full" />;
	}

	const user = data?.user;
	if (!user) {
		return (
			<Link href="/login">
				<Button variant="outline" className="text-sm">
					{t["auth.menu.login"]}
				</Button>
			</Link>
		);
	}

	const isAdmin = (user as { role?: string }).role === "admin";
	const initial = (user.name || user.email || "?").slice(0, 1).toUpperCase();

	const handleSignOut = async () => {
		await authClient.signOut();
		setMenuOpen(false);
		router.push("/");
		router.refresh();
	};

	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={t["auth.menu.account"]}
					className="bg-primary text-primary-foreground hover:bg-primary/90 flex size-8 items-center justify-center rounded-full text-sm font-semibold"
				>
					{initial}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<div className="text-muted-foreground border-b px-2.5 pb-2 pt-1.5 text-xs">
					{user.email}
				</div>
				<DropdownMenuItem asChild>
					<Link href="/settings/account">{t["auth.menu.account"]}</Link>
				</DropdownMenuItem>
				{isAdmin && (
					<DropdownMenuItem asChild>
						<Link href="/admin/users">{t["auth.menu.admin"]}</Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onClick={handleSignOut}>
					{t["auth.menu.signout"]}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
