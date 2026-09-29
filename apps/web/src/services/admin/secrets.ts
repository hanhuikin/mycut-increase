import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { webEnv } from "@/env/web";

/**
 * Secret storage for provider credentials.
 *
 * Keys are long-lived bearer tokens with billing authority, so they are
 * encrypted at rest with AES-256-GCM. The master key stays in the environment —
 * it cannot live in the database it protects.
 *
 * Stored form is `iv:tag:ciphertext`, each part base64.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function encryptionKey(): Buffer {
	const hex = webEnv.MODEL_CREDENTIALS_KEY;
	if (!hex) {
		throw new Error(
			"MODEL_CREDENTIALS_KEY is not set — cannot read or write provider credentials",
		);
	}
	return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return [iv, cipher.getAuthTag(), ciphertext]
		.map((part) => part.toString("base64"))
		.join(":");
}

export function decryptSecret(payload: string): string {
	const [ivRaw, tagRaw, dataRaw] = payload.split(":");
	if (!ivRaw || !tagRaw || !dataRaw) {
		throw new Error("Stored credential is malformed");
	}
	const decipher = createDecipheriv(
		ALGORITHM,
		encryptionKey(),
		Buffer.from(ivRaw, "base64"),
	);
	decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(dataRaw, "base64")),
		decipher.final(),
	]).toString("utf8");
}

/** Last 4 characters, for masked display. Never the key itself. */
export function secretSuffix(value: string): string {
	return value.trim().slice(-4);
}
