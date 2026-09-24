import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, normalize, relative, sep } from 'node:path';
import { isStackUnadoptable } from './container-labels';
import { isProtectedPath } from './fs-guard';

const REJECTION_MESSAGES = {
	adoption_disabled: 'A container has disabled stack adoption.',
	missing_config_files: 'Every container must advertise a nonempty Compose config-files label.',
	malformed_config_files: 'The Compose config-files label is malformed.',
	multiple_config_files: 'Only a single Compose file is supported.',
	stdin_config: 'Compose files supplied through standard input are not supported.',
	relative_config_path: 'The Compose file path must be absolute.',
	conflicting_config_paths: 'Containers advertise different Compose file paths.',
	working_directory_mismatch: 'Every advertised Compose working directory must be absolute and resolve to the Compose file base directory.',
	unsupported_extension: 'The Compose filename must end in .yaml or .yml.',
	protected_path: 'The Compose file is in a protected location.',
	outside_roots: 'The Compose file and its base directory must resolve within the same available allowed root directory.',
	file_unavailable: 'The Compose file could not be resolved or inspected.',
	not_regular_file: 'The Compose path must refer to a regular file.',
	file_unreadable: 'The Compose file could not be opened and closed for reading.'
} as const;

export type ComposePathLabelsResult =
	| { status: 'eligible'; composePath: string }
	| { status: 'rejected'; reason: keyof typeof REJECTION_MESSAGES; message: string };

function reject(reason: keyof typeof REJECTION_MESSAGES): ComposePathLabelsResult {
	return { status: 'rejected', reason, message: REJECTION_MESSAGES[reason] };
}

/**
 * Validate local, 1:1 Compose label paths without reading their contents.
 * Keep the normalized advertised path: resolving a filename symlink into another
 * directory would change Compose's relative bind, build and env-file paths.
 * Conservatively reject advertised project directories that differ from this base.
 * Validation happens only at adoption, not continuously. Files and symlinks can
 * change afterward; the filesystem remains trusted as with manual path assignment.
 */
export async function evaluateComposePathLabels({ containerLabels, roots }: {
	containerLabels: Record<string, string>[];
	roots: string[];
}): Promise<ComposePathLabelsResult> {
	if (isStackUnadoptable(containerLabels)) { return reject('adoption_disabled'); }
	if (!containerLabels.length) { return reject('missing_config_files'); }

	let composePath = '';
	for (const labels of containerLabels) {
		const value = labels['com.docker.compose.project.config_files']?.trim();
		if (!value) { return reject('missing_config_files'); }
		const files = value.split(',').map(file => file.trim());
		if (files.some(file => !file || /[\x00-\x1f\x7f]/.test(file))) {
			return reject('malformed_config_files');
		}
		if (files.length != 1) { return reject('multiple_config_files'); }
		const [file] = files;
		if (file == '-') { return reject('stdin_config'); }
		if (!isAbsolute(file)) { return reject('relative_config_path'); }
		const normalized = normalize(file);
		if (composePath && composePath != normalized) { return reject('conflicting_config_paths'); }
		composePath = normalized;
	}

	if (isProtectedPath(composePath)) { return reject('protected_path'); }
	if (!['.yaml', '.yml'].includes(extname(composePath).toLowerCase())) {
		return reject('unsupported_extension');
	}

	let canonicalPath: string;
	let canonicalDirectory: string;
	try {
		canonicalPath = await realpath(composePath);
		canonicalDirectory = await realpath(dirname(composePath));
	} catch {
		return reject('file_unavailable');
	}
	if (isProtectedPath(canonicalPath)) { return reject('protected_path'); }

	let contained = false;
	for (const root of roots) {
		if (!isAbsolute(root)) { continue; }
		try {
			const canonicalRoot = await realpath(root);
			if (!(await stat(canonicalRoot)).isDirectory()) { continue; }
			// Both the target and Compose's relative-path base must share this root.
			if ([canonicalPath, canonicalDirectory].every(path => {
				const fromRoot = relative(canonicalRoot, path);
				return fromRoot != '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
			})) {
				contained = true;
				break;
			}
		} catch {
			// Unavailable roots grant no access; another configured root may match.
		}
	}
	if (!contained) { return reject('outside_roots'); }

	for (const labels of containerLabels) {
		const workingDirectory = labels['com.docker.compose.project.working_dir'];
		if (workingDirectory === undefined) { continue; }
		if (!isAbsolute(workingDirectory)) { return reject('working_directory_mismatch'); }
		try {
			if (await realpath(workingDirectory) != canonicalDirectory) {
				return reject('working_directory_mismatch');
			}
		} catch {
			return reject('working_directory_mismatch');
		}
	}

	try {
		if (!(await stat(canonicalPath)).isFile()) { return reject('not_regular_file'); }
	} catch {
		return reject('file_unavailable');
	}
	try {
		// Nonblocking avoids hanging if a regular file is replaced by a FIFO.
		const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			if (!(await handle.stat()).isFile()) { return reject('not_regular_file'); }
		} finally {
			await handle.close();
		}
	} catch {
		return reject('file_unreadable');
	}
	return { status: 'eligible', composePath };
}
