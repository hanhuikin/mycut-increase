"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/locale/locale-context";

export function MigrationDialog() {
	const editor = useEditor();
	const migrationState = editor.project.getMigrationState();
	const { t } = useLocale();

	if (!migrationState.isMigrating) return null;

	const title = migrationState.projectName
		? t["project.updating_project"]
		: t["project.updating_projects"];
	const description = migrationState.projectName
		? `${t["project.upgrading"]} "${migrationState.projectName}" from v${migrationState.fromVersion} to v${migrationState.toVersion}`
		: `${t["project.upgrading"]} projects from v${migrationState.fromVersion} to v${migrationState.toVersion}`;

	return (
		<Dialog open={true}>
			<DialogContent
				className="sm:max-w-md"
				onPointerDownOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-center py-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
				</div>
			</DialogContent>
		</Dialog>
	);
}
