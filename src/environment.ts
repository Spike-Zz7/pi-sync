import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeGitRemote } from "./git-config.js";
import { runGit } from "./git-runner.js";
import { isDeniedPath, isPathInside, safeJoin } from "./paths.js";
import type { Snapshot, SnapshotFile } from "./types.js";

export const ENVIRONMENT_FILE = "sync-environment.json";
export const PACKAGE_ROOT = "sync-packages";
export interface EnvironmentPackage {
	id: string;
	source: string;
	entry?: string;
	resource?: "skills" | "extensions" | "prompts" | "themes";
}
export interface SyncEnvironment {
	version: 1;
	packages: EnvironmentPackage[];
}
export function environmentPath(value: string) {
	return value === ENVIRONMENT_FILE || value.startsWith(`${PACKAGE_ROOT}/`);
}
export function contentFile(
	filePath: string,
	content: Buffer,
	mode?: number,
): SnapshotFile {
	return {
		path: filePath,
		contentBase64: content.toString("base64"),
		sha256: digest(content),
		...(mode === undefined ? {} : { mode }),
	};
}
export function digest(value: Buffer | string) {
	return createHash("sha256").update(value).digest("hex");
}
function jsonFile(file: SnapshotFile) {
	const content = Buffer.from(file.contentBase64, "base64");
	if (
		content.toString("base64") !== file.contentBase64 ||
		digest(content) !== file.sha256
	)
		throw new Error("Invalid environment file checksum.");
	return JSON.parse(content.toString("utf8"));
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid environment object.");
	return value as Record<string, unknown>;
}
export function safeBundlePath(value: string) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject path controls from untrusted snapshots.
		!/[\\:\x00-\x1f\x7f]/u.test(value) &&
		!value.startsWith("/") &&
		value.split("/").every((p) => p && p !== "." && p !== "..") &&
		!isDeniedPath(value)
	);
}
const npmSource =
	/^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/u;
export function requireEnvironment(
	snapshot: Snapshot,
): SyncEnvironment | undefined {
	if (snapshot.version === 1) {
		if (snapshot.files.some((f) => environmentPath(f.path)))
			throw new Error("Reserved environment paths in legacy snapshot.");
		return undefined;
	}
	if (snapshot.version !== 2 || !snapshot.selection)
		throw new Error("Unsupported strict snapshot format.");
	const files = snapshot.files.filter((f) => f.path === ENVIRONMENT_FILE);
	if (files.length !== 1)
		throw new Error("Strict snapshot requires one environment manifest.");
	const raw = object(jsonFile(files[0]));
	if (
		raw.version !== 1 ||
		!Array.isArray(raw.packages) ||
		raw.packages.length > 256 ||
		Object.keys(raw).some((k) => k !== "version" && k !== "packages")
	)
		throw new Error("Invalid environment manifest.");
	const ids = new Set<string>();
	for (const value of raw.packages) {
		const p = object(value);
		if (
			typeof p.id !== "string" ||
			!/^[0-9a-f]{64}$/u.test(p.id) ||
			ids.has(p.id) ||
			typeof p.source !== "string" ||
			Object.keys(p).some(
				(k) => !["id", "source", "entry", "resource"].includes(k),
			)
		)
			throw new Error("Invalid environment package.");
		if (
			p.resource !== undefined &&
			!["skills", "extensions", "prompts", "themes"].includes(
				String(p.resource),
			)
		)
			throw new Error("Invalid external resource kind.");
		ids.add(p.id);
		if (p.source.startsWith("bundle:")) {
			if (
				p.source !== `bundle:${p.id}` ||
				(p.entry !== undefined &&
					(typeof p.entry !== "string" || !safeBundlePath(p.entry)))
			)
				throw new Error("Invalid local package bundle.");
		} else if (!npmSource.test(p.source)) {
			const match = /^git:(.+)@([0-9a-f]{40})$/u.exec(p.source);
			if (
				!match ||
				normalizeGitRemote(match[1]) !== match[1] ||
				p.entry !== undefined
			)
				throw new Error(
					"Package source must be an exact npm version or Git commit.",
				);
		}
	}
	const seen = new Set<string>();
	for (const file of snapshot.files) {
		if (seen.has(file.path.toLowerCase()))
			throw new Error("Duplicate strict snapshot path.");
		seen.add(file.path.toLowerCase());
		const bytes = Buffer.from(file.contentBase64, "base64");
		if (
			bytes.toString("base64") !== file.contentBase64 ||
			digest(bytes) !== file.sha256
		)
			throw new Error("Invalid strict snapshot checksum.");
		if (!safeBundlePath(file.path))
			throw new Error("Unsafe strict snapshot path.");
		if (file.mode !== undefined && file.mode !== 0o644 && file.mode !== 0o755)
			throw new Error("Invalid strict snapshot mode.");
		if (file.path.startsWith(`${PACKAGE_ROOT}/`)) {
			const id = file.path.split("/")[1];
			if (
				!ids.has(id) &&
				!["npm-package.json", "npm-lock.json"].includes(
					file.path.slice(PACKAGE_ROOT.length + 1),
				)
			)
				throw new Error("Unowned package payload.");
		}
	}
	if (
		raw.packages.length &&
		!snapshot.files.some((f) => f.path === "settings.json")
	)
		throw new Error(
			"Package environment requires settings.json in shared selection.",
		);
	const sorted = [...seen].sort();
	if (sorted.some((value, i) => i > 0 && value.startsWith(`${sorted[i - 1]}/`)))
		throw new Error("Conflicting strict snapshot paths.");
	const settingsFile = snapshot.files.find((f) => f.path === "settings.json");
	const settings = settingsFile ? object(jsonFile(settingsFile)) : {};
	const entries = settings.packages ?? [];
	const packageEntries = (raw.packages as EnvironmentPackage[]).filter(
		(p) => !p.resource,
	);
	if (
		!Array.isArray(entries) ||
		entries.length !== packageEntries.length ||
		entries.some((item, i) => packageSource(item) !== packageEntries[i].source)
	)
		throw new Error("Settings and environment package identities differ.");
	for (const kind of ["skills", "extensions", "prompts", "themes"]) {
		const resources = settings[kind] ?? [];
		const expected = (raw.packages as EnvironmentPackage[]).filter(
			(p) => p.resource === kind,
		);
		const bundled = Array.isArray(resources)
			? resources.filter(
					(item) => typeof item === "string" && item.startsWith("bundle:"),
				)
			: [];
		if (
			!Array.isArray(resources) ||
			bundled.length !== expected.length ||
			bundled.some((item, i) => item !== expected[i].source) ||
			resources.some(
				(item) =>
					typeof item !== "string" ||
					(!item.startsWith("bundle:") &&
						(!safeBundlePath(item) ||
							!snapshot.selection?.include.some(
								(root) => item === root || item.startsWith(`${root}/`),
							))),
			)
		)
			throw new Error("Settings and environment resources differ.");
	}
	return raw as unknown as SyncEnvironment;
}

/** Dereference selected skill roots, but never follow nested links outside that root or cycles. */
export async function collectPortableDirectory(
	source: string,
	destination: string,
): Promise<SnapshotFile[]> {
	const root = await fs.realpath(source);
	const results: SnapshotFile[] = [];
	const active = new Set<string>();
	async function walk(current: string, relative: string) {
		const real = await fs.realpath(current);
		if (!isPathInside(root, real))
			throw new Error(
				"Selected resource contains a symlink escaping its root.",
			);
		if (active.has(real))
			throw new Error("Selected resource contains a symlink cycle.");
		const stat = await fs.stat(real);
		if (stat.isDirectory()) {
			active.add(real);
			for (const item of (await fs.readdir(real)).sort()) {
				const next = relative ? `${relative}/${item}` : item;
				if (
					isDeniedPath(next) ||
					[".npmrc", ".DS_Store", ".cache"].includes(item)
				)
					continue;
				if (!safeBundlePath(next))
					throw new Error("Resource has a nonportable path.");
				await walk(path.join(real, item), next);
			}
			active.delete(real);
		} else if (stat.isFile()) {
			results.push(
				contentFile(
					`${destination}/${relative}`,
					await fs.readFile(real),
					stat.mode & 0o111 ? 0o755 : 0o644,
				),
			);
		} else throw new Error("Selected resource contains a non-regular file.");
	}
	await walk(root, "");
	return results;
}
function expandSource(root: string, source: string) {
	return path.resolve(
		root,
		source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source,
	);
}
function packageSource(value: unknown) {
	const record = typeof value === "string" ? undefined : object(value);
	const source = typeof value === "string" ? value : record?.source;
	if (typeof source !== "string" || !source)
		throw new Error("Invalid settings package source.");
	if (record)
		for (const kind of ["extensions", "skills", "prompts", "themes"]) {
			const filters = record[kind];
			if (
				filters !== undefined &&
				(!Array.isArray(filters) ||
					filters.some((filter) => {
						if (typeof filter !== "string") return true;
						const relative = filter.replace(/^[!+-]/u, "");
						return (
							path.isAbsolute(relative) ||
							relative.includes("\\") ||
							relative.split("/").includes("..")
						);
					}))
			)
				throw new Error(
					"Package resource filter escapes its root or is malformed.",
				);
		}
	return source;
}

function replaceSource(value: unknown, source: string) {
	return typeof value === "string" ? source : { ...object(value), source };
}
function gitSource(source: string) {
	let raw = source.replace(/^git:/u, "");
	const at = raw.lastIndexOf("@");
	if (at > raw.lastIndexOf("/")) raw = raw.slice(0, at);
	if (!raw.includes("://") && !raw.includes(":")) raw = `https://${raw}`;
	const remote = normalizeGitRemote(raw);
	if (!remote) throw new Error("Invalid package Git source.");
	const url = new URL(
		remote.includes("://") ? remote : `ssh://${remote.replace(":", "/")}`,
	);
	return {
		remote,
		cachePath: `${url.hostname}${url.pathname.replace(/\.git$/u, "")}`,
	};
}

export async function captureEnvironment(
	snapshot: Snapshot,
	root: string,
): Promise<Snapshot> {
	const files = snapshot.files.filter((f) => !environmentPath(f.path));
	const settingsIndex = files.findIndex((f) => f.path === "settings.json");
	const settings =
		settingsIndex < 0 ? {} : object(jsonFile(files[settingsIndex]));
	const packageValues = settings.packages ?? [];
	if (!Array.isArray(packageValues))
		throw new Error("settings.packages must be an array.");
	const configured: Array<{
		value: unknown;
		resource?: EnvironmentPackage["resource"];
	}> = packageValues.map((value) => ({ value }));
	for (const resource of [
		"skills",
		"extensions",
		"prompts",
		"themes",
	] as const) {
		const values = settings[resource] ?? [];
		if (
			!Array.isArray(values) ||
			values.some(
				(value) =>
					typeof value !== "string" ||
					/[!*?{}[\]]/u.test(value) ||
					value.startsWith("+") ||
					value.startsWith("-"),
			)
		)
			throw new Error(
				`Strict sync requires explicit settings.${resource} paths; resource globs/filters cannot yet be made portable.`,
			);
		configured.push(...values.map((value) => ({ value, resource })));
	}
	const packages: EnvironmentPackage[] = [];
	const canonical: unknown[] = [];
	const canonicalResources: Record<string, string[]> = {};
	const packageSkillRoots: string[] = [];
	let latestStoredPayload: SnapshotFile[] | undefined;
	for (const { value, resource } of configured) {
		let source = packageSource(value);
		let previous: EnvironmentPackage | undefined;
		let packageStoredPayload: SnapshotFile[] | undefined;
		const managed =
			/^\.\/pi-sync\/environments\/([0-9a-f]{64}(?:-[0-9a-f]{64})?)\/packages\/([0-9a-f]{64})(?:\/.*)?$/u.exec(
				source,
			);
		let localRoot = expandSource(root, source);
		if (resource && !managed && isPathInside(root, localRoot)) {
			const relative = path.relative(root, localRoot).split(path.sep).join("/");
			if (
				snapshot.selection?.include.some(
					(selected) =>
						relative === selected || relative.startsWith(`${selected}/`),
				)
			) {
				canonicalResources[resource] ??= [];
				canonicalResources[resource].push(relative);
				continue;
			}
		}
		if (managed) {
			const generation = path.join(root, "pi-sync", "environments", managed[1]);
			packageStoredPayload = JSON.parse(
				await fs.readFile(path.join(generation, "payload.json"), "utf8"),
			);
			latestStoredPayload = packageStoredPayload;
			const stored = object(
				JSON.parse(
					await fs.readFile(path.join(generation, "environment.json"), "utf8"),
				),
			);
			previous = (stored.packages as EnvironmentPackage[]).find(
				(p) => p.id === managed[2],
			);
			if (!previous)
				throw new Error(
					"Managed package source metadata is missing; refusing to publish generated paths.",
				);
			source = previous.source;
			localRoot = path.join(generation, "packages", previous.id);
		}
		let entry: EnvironmentPackage;
		if (previous) {
			entry = previous;
			files.push(
				...(packageStoredPayload ?? []).filter((f) =>
					f.path.startsWith(`${PACKAGE_ROOT}/${entry.id}/`),
				),
			);
		} else if (source.startsWith("npm:")) {
			const spec = source.slice(4);
			const at = spec.lastIndexOf("@");
			const name = at > 0 ? spec.slice(0, at) : spec;
			if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name))
				throw new Error("Unsupported npm package source.");
			const hostNpmRoot = path.join(root, "npm");
			const pkg = object(
				JSON.parse(
					await fs.readFile(
						path.join(hostNpmRoot, "node_modules", name, "package.json"),
						"utf8",
					),
				),
			);
			source = `npm:${name}@${pkg.version}`;
			if (!npmSource.test(source) || pkg.name !== name)
				throw new Error("Cannot resolve installed npm package version.");
			entry = { id: digest(source), source };
		} else if (
			source.startsWith("git:") ||
			/^(?:https|ssh):\/\//u.test(source)
		) {
			const git = gitSource(source);
			const directory = previous
				? localRoot
				: path.join(root, "git", git.cachePath);
			const revision = (
				await runGit(["rev-parse", "HEAD"], { cwd: directory })
			).stdout
				.toString("utf8")
				.trim();
			if (!/^[0-9a-f]{40}$/u.test(revision))
				throw new Error("Invalid installed Git revision.");
			if (
				(
					await runGit(["status", "--porcelain", "--untracked-files=no"], {
						cwd: directory,
					})
				).stdout.length
			)
				throw new Error(
					"Installed Git package is modified; commit changes or use a local package.",
				);
			source = `git:${git.remote}@${revision}`;
			entry = { id: digest(source), source };
		} else {
			const stat = await fs.stat(localRoot);
			let bundle: SnapshotFile[];
			if (stat.isFile()) {
				const name = path.basename(localRoot);
				if (!safeBundlePath(name))
					throw new Error("Nonportable local extension path.");
				bundle = [
					contentFile(`bundle/${name}`, await fs.readFile(localRoot), 0o644),
				];
				entry = { id: "", source: "", entry: name };
			} else {
				bundle = await collectPortableDirectory(localRoot, "bundle");
				entry = { id: "", source: "" };
			}
			entry.id = digest(JSON.stringify([resource ?? "package", bundle]));
			entry.source = `bundle:${entry.id}`;
			files.push(
				...bundle.map((f) => ({
					...f,
					path: f.path.replace(/^bundle\//u, `${PACKAGE_ROOT}/${entry.id}/`),
				})),
			);
		}
		if (
			!resource &&
			(typeof value === "string" || object(value).skills === undefined)
		) {
			const npm = npmSource.exec(entry.source);
			const packageRoot = npm
				? previous
					? localRoot
					: path.join(root, "npm", "node_modules", npm[1])
				: entry.source.startsWith("git:") && !previous
					? path.join(root, "git", gitSource(entry.source).cachePath)
					: localRoot;
			try {
				const pkg = object(
					JSON.parse(
						await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
					),
				);
				const skillPaths = pkg.pi ? object(pkg.pi).skills : ["skills"];
				if (Array.isArray(skillPaths))
					for (const skillPath of skillPaths) {
						if (
							typeof skillPath === "string" &&
							!/[!*?{}[\]]/u.test(skillPath) &&
							isPathInside(packageRoot, path.resolve(packageRoot, skillPath))
						) {
							try {
								packageSkillRoots.push(
									await fs.realpath(path.resolve(packageRoot, skillPath)),
								);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT")
									throw error;
							}
						}
					}
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" &&
					(error as NodeJS.ErrnoException).code !== "ENOTDIR"
				)
					throw error;
			}
		}
		if (resource) entry = { ...entry, resource };
		if (packages.some((p) => p.id === entry.id))
			throw new Error("Duplicate package identity in environment.");
		packages.push(entry);
		if (resource) {
			canonicalResources[resource] ??= [];
			canonicalResources[resource].push(entry.source);
		} else canonical.push(replaceSource(value, entry.source));
	}
	if (
		packageSkillRoots.length &&
		snapshot.selection?.include.includes("skills")
	) {
		try {
			for (const link of await fs.readdir(path.join(root, "skills"), {
				withFileTypes: true,
			})) {
				if (!link.isSymbolicLink()) continue;
				const source = await fs.realpath(path.join(root, "skills", link.name));
				if (
					packageSkillRoots.some((packageRoot) =>
						isPathInside(packageRoot, source),
					)
				) {
					for (let i = files.length - 1; i >= 0; i--)
						if (
							files[i].path === `skills/${link.name}` ||
							files[i].path.startsWith(`skills/${link.name}/`)
						)
							files.splice(i, 1);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (packages.some((p) => p.source.startsWith("npm:"))) {
		const hostNpmDir = path.join(root, "npm");
		const hasUnmanagedNpm = configured.some((c) => {
			if (c.resource) return false;
			const src = packageSource(c.value);
			return (
				src.startsWith("npm:") && !/^\.\/pi-sync\/environments\//u.test(src)
			);
		});
		for (const [name, virtual] of [
			["package.json", "npm-package.json"],
			["package-lock.json", "npm-lock.json"],
		]) {
			let file: SnapshotFile | undefined;
			if (!hasUnmanagedNpm && latestStoredPayload) {
				file = latestStoredPayload.find(
					(f) => f.path === `${PACKAGE_ROOT}/${virtual}`,
				);
			}
			if (!file) {
				const filePath = path.join(hostNpmDir, name);
				try {
					file = contentFile(
						`${PACKAGE_ROOT}/${virtual}`,
						await fs.readFile(filePath),
					);
				} catch (error) {
					file = latestStoredPayload?.find(
						(f) => f.path === `${PACKAGE_ROOT}/${virtual}`,
					);
					if (!file) throw error;
				}
			}
			files.push(file);
		}
	}
	if (settingsIndex >= 0 && configured.length) {
		if (packageValues.length || Object.hasOwn(settings, "packages"))
			settings.packages = canonical;
		for (const [kind, paths] of Object.entries(canonicalResources))
			settings[kind] = paths;
		files[files.findIndex((f) => f.path === "settings.json")] = contentFile(
			"settings.json",
			Buffer.from(`${JSON.stringify(settings, null, "\t")}\n`),
		);
	}
	files.push(
		contentFile(
			ENVIRONMENT_FILE,
			Buffer.from(JSON.stringify({ version: 1, packages })),
		),
	);
	const result = {
		...snapshot,
		version: 2,
		files: files.sort((a, b) => a.path.localeCompare(b.path)),
	};
	requireEnvironment(result);
	return result;
}

export interface EnvironmentInstaller {
	npm(directory: string, signal?: AbortSignal): Promise<void>;
	git(
		remote: string,
		commit: string,
		directory: string,
		signal?: AbortSignal,
	): Promise<void>;
}

/** Installs only into an unreferenced generation. Never mutates Pi settings or active packages. */
export async function prepareEnvironment(
	snapshot: Snapshot,
	root: string,
	installer: EnvironmentInstaller,
	signal?: AbortSignal,
): Promise<Snapshot> {
	const environment = requireEnvironment(snapshot);
	if (!environment) return snapshot;
	const payload = snapshot.files.filter((f) => environmentPath(f.path));
	const contentKey = digest(JSON.stringify(payload));
	let key = contentKey;
	const base = path.join(root, "pi-sync", "environments");
	for (const relative of ["pi-sync", "pi-sync/environments"]) {
		const target = path.join(root, relative);
		try {
			if (!(await fs.lstat(target)).isDirectory())
				throw new Error("Environment storage is not a real directory.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await fs.mkdir(base, { recursive: true });
	let directory = path.join(base, key);
	for (const candidate of (await fs.readdir(base))
		.filter((name) => name === contentKey || name.startsWith(`${contentKey}-`))
		.sort()) {
		try {
			await verifyEnvironment(environment, path.join(base, candidate), payload);
			key = candidate;
			directory = path.join(base, key);
			break;
		} catch {}
	}
	// Never mutate a published generation: even a failed apply may still reference it.
	try {
		await verifyEnvironment(environment, directory, payload);
	} catch {
		try {
			await fs.lstat(directory);
			key = `${contentKey}-${digest(randomUUID())}`;
			directory = path.join(base, key);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const staging = await fs.mkdtemp(path.join(base, ".staging-"));
		try {
			for (const file of payload) {
				if (!file.path.startsWith(`${PACKAGE_ROOT}/`)) continue;
				const relative = file.path.slice(PACKAGE_ROOT.length + 1);
				const target =
					relative === "npm-package.json"
						? "npm/package.json"
						: relative === "npm-lock.json"
							? "npm/package-lock.json"
							: `packages/${relative}`;
				const destination = safeJoin(staging, target);
				await fs.mkdir(path.dirname(destination), { recursive: true });
				const content = Buffer.from(file.contentBase64, "base64");
				if (digest(content) !== file.sha256)
					throw new Error("Package payload checksum mismatch.");
				await fs.writeFile(destination, content, { mode: file.mode ?? 0o644 });
			}
			if (environment.packages.some((p) => p.source.startsWith("npm:")))
				await installer.npm(path.join(staging, "npm"), signal);
			for (const p of environment.packages) {
				const destination = path.join(staging, "packages", p.id);
				const npm = npmSource.exec(p.source);
				if (npm) {
					await fs.mkdir(path.dirname(destination), { recursive: true });
					// Relative link remains valid when staging is renamed.
					await fs.symlink(`../npm/node_modules/${npm[1]}`, destination, "dir");
				} else if (p.source.startsWith("git:")) {
					const at = p.source.lastIndexOf("@");
					await installer.git(
						p.source.slice(4, at),
						p.source.slice(at + 1),
						destination,
						signal,
					);
					await installDependencies(destination, installer, signal);
				} else if (!p.entry)
					await installDependencies(destination, installer, signal);
			}
			await fs.writeFile(
				path.join(staging, "environment.json"),
				JSON.stringify(environment),
			);
			await fs.writeFile(
				path.join(staging, "payload.json"),
				JSON.stringify(payload),
			);
			await verifyEnvironment(environment, staging, payload);
			signal?.throwIfAborted();
			try {
				await fs.lstat(directory);
				throw new Error(
					"Environment generation appeared concurrently; retry sync.",
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await fs.rename(staging, directory);
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true });
			throw new Error(
				"Environment installation failed; no content or baseline committed. Run /sync again to retry.",
				{ cause: error },
			);
		}
	}
	const settings = snapshot.files.find((f) => f.path === "settings.json");
	if (!settings)
		return {
			...snapshot,
			files: snapshot.files.filter((f) => !environmentPath(f.path)),
		};
	const value = object(jsonFile(settings));
	if (environment.packages.length === 0)
		return {
			...snapshot,
			files: snapshot.files.filter((f) => !environmentPath(f.path)),
		};
	if (Array.isArray(value.packages))
		value.packages = value.packages.map((item) => {
			const p = environment.packages.find(
				(p) => p.source === packageSource(item),
			);
			if (!p)
				throw new Error(
					"Settings package is missing from environment manifest.",
				);
			return replaceSource(
				item,
				`./pi-sync/environments/${key}/packages/${p.id}${p.entry ? `/${p.entry}` : ""}`,
			);
		});
	for (const kind of ["skills", "extensions", "prompts", "themes"]) {
		if (Array.isArray(value[kind]))
			value[kind] = (value[kind] as string[]).map((source) => {
				const p = environment.packages.find(
					(p) => p.resource === kind && p.source === source,
				);
				if (
					!p &&
					safeBundlePath(source) &&
					snapshot.selection?.include.some(
						(root) => source === root || source.startsWith(`${root}/`),
					)
				)
					return source;
				if (!p) throw new Error("Missing portable external resource.");
				return `./pi-sync/environments/${key}/packages/${p.id}${p.entry ? `/${p.entry}` : ""}`;
			});
	}
	return {
		...snapshot,
		files: snapshot.files
			.filter((f) => !environmentPath(f.path))
			.map((f) =>
				f.path === "settings.json"
					? contentFile(
							f.path,
							Buffer.from(`${JSON.stringify(value, null, "\t")}\n`),
						)
					: f,
			),
	};
}
async function installDependencies(
	directory: string,
	installer: EnvironmentInstaller,
	signal?: AbortSignal,
) {
	let pkg: Record<string, unknown>;
	try {
		pkg = object(
			JSON.parse(
				await fs.readFile(path.join(directory, "package.json"), "utf8"),
			),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (
		Object.keys(object(pkg.dependencies ?? {})).length ||
		Object.keys(object(pkg.optionalDependencies ?? {})).length
	)
		await installer.npm(directory, signal);
}
async function verifyEnvironment(
	environment: SyncEnvironment,
	directory: string,
	payload: SnapshotFile[],
) {
	for (const file of payload) {
		if (
			!file.path.startsWith(`${PACKAGE_ROOT}/`) ||
			file.path === `${PACKAGE_ROOT}/npm-lock.json` ||
			file.path === `${PACKAGE_ROOT}/npm-package.json`
		)
			continue;
		const relative = file.path.slice(PACKAGE_ROOT.length + 1);
		const target = safeJoin(path.join(directory, "packages"), relative);
		if (
			!isPathInside(directory, await fs.realpath(target)) ||
			digest(await fs.readFile(target)) !== file.sha256
		)
			throw new Error("Managed package payload differs from snapshot.");
	}

	for (const npmRoot of [
		path.join(directory, "npm"),
		...environment.packages
			.filter((p) => !p.source.startsWith("npm:") && !p.entry)
			.map((p) => path.join(directory, "packages", p.id)),
	]) {
		let lock: {
			packages?: Record<
				string,
				{ dev?: boolean; optional?: boolean; version?: string }
			>;
		};
		try {
			lock = JSON.parse(
				await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const [relative, expected] of Object.entries(lock.packages ?? {})) {
			if (!relative || expected.dev === true) continue;
			if (
				relative.includes("..") ||
				path.isAbsolute(relative) ||
				relative.includes("\\")
			)
				throw new Error("Dependency lock path is unsafe.");
			try {
				const actual = JSON.parse(
					await fs.readFile(
						path.join(npmRoot, relative, "package.json"),
						"utf8",
					),
				);
				if (actual.version !== expected.version)
					throw new Error(
						"Installed dependency version differs from lockfile.",
					);
			} catch (error) {
				if (
					!expected.optional ||
					(error as NodeJS.ErrnoException).code !== "ENOENT"
				)
					throw error;
			}
		}
	}
	const stored = JSON.parse(
		await fs.readFile(path.join(directory, "environment.json"), "utf8"),
	);
	if (JSON.stringify(stored) !== JSON.stringify(environment))
		throw new Error("Environment metadata mismatch.");
	for (const p of environment.packages) {
		const root = path.join(directory, "packages", p.id);
		const npm = npmSource.exec(p.source);
		if (npm) {
			const pkg = JSON.parse(
				await fs.readFile(path.join(root, "package.json"), "utf8"),
			);
			if (pkg.name !== npm[1] || pkg.version !== npm[2])
				throw new Error("Installed npm version differs from snapshot.");
		} else if (p.source.startsWith("git:")) {
			const actual = (await runGit(["rev-parse", "HEAD"], { cwd: root })).stdout
				.toString("utf8")
				.trim();
			if (!p.source.endsWith(`@${actual}`))
				throw new Error("Installed Git commit differs from snapshot.");
		} else await fs.access(p.entry ? path.join(root, p.entry) : root);
		if (!isPathInside(directory, await fs.realpath(root)))
			throw new Error("Managed package escapes generation.");
		if (!p.entry) {
			let pkg: Record<string, unknown>;
			try {
				pkg = object(
					JSON.parse(
						await fs.readFile(path.join(root, "package.json"), "utf8"),
					),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const pi = object(pkg.pi ?? {});
			for (const type of ["extensions", "skills", "prompts", "themes"]) {
				const resources = pi[type];
				if (resources === undefined) continue;
				if (!Array.isArray(resources))
					throw new Error("Invalid Pi package resource manifest.");
				for (const resource of resources) {
					if (
						typeof resource !== "string" ||
						resource.includes("..") ||
						path.isAbsolute(resource)
					)
						throw new Error("Package resource escapes its root.");
					if (!/[!*?{}[\]]/u.test(resource))
						await fs.access(path.resolve(root, resource));
				}
			}
		}
	}
}
