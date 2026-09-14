"use client";

import { Button } from "../ui/button";
import { ArrowRight, Sparkles, Zap, Video, Wand2 } from "lucide-react";
import Link from "next/link";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useLocale } from "@/locale/locale-context";

export function Hero() {
	const [mounted, setMounted] = useState(false);
	const { t } = useLocale();

	useEffect(() => {
		setMounted(true);
	}, []);

	const features = [
		{
			icon: Sparkles,
			title: t["landing.feature_ai_powered"],
			description: t["landing.feature_ai_powered_desc"],
		},
		{
			icon: Zap,
			title: t["landing.feature_lightning_fast"],
			description: t["landing.feature_lightning_fast_desc"],
		},
		{
			icon: Video,
			title: t["landing.feature_pro_features"],
			description: t["landing.feature_pro_features_desc"],
		},
		{
			icon: Wand2,
			title: t["landing.feature_smart_effects"],
			description: t["landing.feature_smart_effects_desc"],
		},
	];

	return (
		<div className="relative flex min-h-[calc(100svh-4.5rem)] flex-col items-center justify-center overflow-hidden px-4">
			{/* Animated Background */}
			<div className="absolute inset-0 -z-50">
				{/* Gradient Background */}
				<div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-950 dark:via-blue-950 dark:to-purple-950" />

				{/* Animated Grid */}
				<div
					className="absolute inset-0 opacity-20 dark:opacity-10"
					style={{
						backgroundImage: `linear-gradient(to right, rgb(99 102 241 / 0.3) 1px, transparent 1px),
						                  linear-gradient(to bottom, rgb(99 102 241 / 0.3) 1px, transparent 1px)`,
						backgroundSize: '4rem 4rem',
					}}
				/>

				{/* Glowing Orbs */}
				<div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-blue-400/30 blur-3xl dark:bg-blue-600/20" />
				<div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-purple-400/30 blur-3xl dark:bg-purple-600/20" />
				<div className="absolute top-1/2 left-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-400/20 blur-3xl dark:bg-indigo-600/10" />
			</div>

			{/* Main Content */}
			<div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col items-center">
				{/* Badge */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 20 }}
					transition={{ duration: 0.5 }}
					className="mb-8"
				>
					<div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/50 px-4 py-2 text-sm backdrop-blur-sm dark:border-indigo-800 dark:bg-gray-900/50">
						<Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
						<span className="font-medium text-gray-900 dark:text-gray-100">
							{t["landing.badge"]}
						</span>
					</div>
				</motion.div>

				{/* Title */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 20 }}
					transition={{ duration: 0.5, delay: 0.1 }}
					className="text-center"
				>
					<h1 className="bg-gradient-to-r from-gray-900 via-indigo-900 to-purple-900 bg-clip-text text-5xl font-bold tracking-tight text-transparent dark:from-white dark:via-indigo-200 dark:to-purple-200 md:text-7xl">
						{t["landing.title_line1"]}
						<br />
						<span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text dark:from-indigo-400 dark:to-purple-400">
							{t["landing.title_line2"]}
						</span>
					</h1>
				</motion.div>

				{/* Description */}
				<motion.p
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 20 }}
					transition={{ duration: 0.5, delay: 0.2 }}
					className="mx-auto mt-6 max-w-2xl text-center text-lg text-gray-600 dark:text-gray-300 md:text-xl"
				>
					{t["landing.description"]}
				</motion.p>

				{/* CTA Buttons */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 20 }}
					transition={{ duration: 0.5, delay: 0.3 }}
					className="mt-10 flex flex-col gap-4 sm:flex-row"
				>
					<Link href="/projects">
						<Button
							size="lg"
							className="group h-12 bg-gradient-to-r from-indigo-600 to-purple-600 px-8 text-base font-semibold hover:from-indigo-700 hover:to-purple-700"
						>
							{t["landing.cta_primary"]}
							<ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-1" />
						</Button>
					</Link>
				</motion.div>

				{/* Feature Cards */}
				<motion.div
					initial={{ opacity: 0, y: 40 }}
					animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 40 }}
					transition={{ duration: 0.7, delay: 0.4 }}
					className="mt-20 grid w-full max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"
				>
					{features.map((feature, index) => (
						<motion.div
							key={feature.title}
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: mounted ? 1 : 0, y: mounted ? 0 : 20 }}
							transition={{ duration: 0.5, delay: 0.5 + index * 0.1 }}
							className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white/50 p-6 backdrop-blur-sm transition-all hover:border-indigo-300 hover:shadow-lg dark:border-gray-800 dark:bg-gray-900/50 dark:hover:border-indigo-700"
						>
							<div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 transition-opacity group-hover:opacity-100 dark:from-indigo-500/10 dark:to-purple-500/10" />
							<div className="relative">
								<div className="mb-4 inline-flex rounded-lg bg-indigo-100 p-3 dark:bg-indigo-900/30">
									<feature.icon className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
								</div>
								<h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
									{feature.title}
								</h3>
								<p className="text-sm text-gray-600 dark:text-gray-400">
									{feature.description}
								</p>
							</div>
						</motion.div>
					))}
				</motion.div>
			</div>
		</div>
	);
}
