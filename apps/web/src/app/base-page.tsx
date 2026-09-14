import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { cn } from "@/utils/ui";

interface BasePageProps {
	children: React.ReactNode;
	className?: string;
	mainClassName?: string;
	maxWidth?: "3xl" | "6xl" | "full";
	title?: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
}

export function BasePage({
	children,
	className = "",
	mainClassName = "",
	maxWidth = "3xl",
	title,
	description,
	action,
}: BasePageProps) {
	const maxWidthClass = {
		"3xl": "max-w-3xl",
		"6xl": "max-w-6xl",
		full: "max-w-full",
	}[maxWidth];

	return (
		<section className={cn("relative min-h-screen overflow-hidden", className)}>
			{/* Animated Background */}
			<div className="fixed inset-0 -z-50">
				{/* Gradient Background */}
				<div className="absolute inset-0 bg-gradient-to-br from-blue-50/30 via-indigo-50/30 to-purple-50/30 dark:from-gray-950 dark:via-blue-950/30 dark:to-purple-950/30" />

				{/* Animated Grid */}
				<div
					className="absolute inset-0 opacity-10 dark:opacity-5"
					style={{
						backgroundImage: `linear-gradient(to right, rgb(99 102 241 / 0.2) 1px, transparent 1px),
						                  linear-gradient(to bottom, rgb(99 102 241 / 0.2) 1px, transparent 1px)`,
						backgroundSize: '4rem 4rem',
					}}
				/>

				{/* Glowing Orbs */}
				<div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-600/10" />
				<div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-purple-400/15 blur-3xl dark:bg-purple-600/10" />
			</div>

			<Header />
			<main
				className={cn(
					"relative container mx-auto flex flex-col gap-12 px-6 pt-12 pb-24 md:pt-24",
					maxWidthClass,
					mainClassName,
				)}
			>
				{title && description && (
					<div className="flex flex-col gap-8 text-center">
						<h1 className="bg-gradient-to-r from-gray-900 via-indigo-900 to-purple-900 bg-clip-text text-5xl font-bold tracking-tight text-transparent dark:from-white dark:via-indigo-200 dark:to-purple-200 md:text-6xl">
							{title}
						</h1>
						<p className="text-muted-foreground mx-auto max-w-2xl text-xl leading-relaxed">
							{description}
						</p>
						{action}
					</div>
				)}
				{children}
			</main>
			<Footer />
		</section>
	);
}
